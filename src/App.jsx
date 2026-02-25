import { useMemo, useState } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MapContainer, Rectangle, TileLayer, ZoomControl, useMapEvents } from "react-leaflet";
import { legendDefaults } from "./legendDefaults.js";

const sanitizeEnv = (value) => {
  if (!value) return "";
  const trimmed = value.trim();
  const quotedMatch = trimmed.match(/^['"](.+)['"]$/);
  return quotedMatch ? quotedMatch[1] : trimmed;
};

const joinUrl = (base, endpoint) => {
  if (!base) return endpoint;
  if (!endpoint) return base;
  return `${base.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
};

const API_BASE = "https://api-dev.climateengine.org";
const API_TOKEN = sanitizeEnv(import.meta.env.VITE_CE_TOKEN);
const AUTH_HEADER = sanitizeEnv(import.meta.env.VITE_CE_AUTH_HEADER) || "Authorization";
const AUTH_SCHEME = sanitizeEnv(import.meta.env.VITE_CE_AUTH_SCHEME);

const buildAuthValue = (token) => {
  if (!token) return "";
  const trimmed = token.trim();
  if (/\s/.test(trimmed)) {
    return trimmed;
  }
  if (!AUTH_SCHEME || AUTH_SCHEME.toLowerCase() === "none") {
    return trimmed;
  }
  return `${AUTH_SCHEME} ${trimmed}`;
};

const TIMESERIES_ENDPOINT = "/timeseries/native/coordinates";

const endpointConfigs = {
  values: {
    label: "Values",
    path: "/raster/mapid/values",
    usesTargetDates: true,
    usesClimatologyYears: false,
    temporalStatistic: null
  },
  anomalies: {
    label: "Anomalies",
    path: "/raster/mapid/anomalies",
    usesTargetDates: true,
    usesClimatologyYears: true,
    temporalStatistic: "mean"
  },
  mann_kendall: {
    label: "Mann-Kendall",
    path: "/raster/mapid/mann_kendall",
    usesTargetDates: false,
    usesClimatologyYears: false,
    temporalStatistic: "mean",
    calculation: "mk_sen",
    startSeason: "01-01",
    endSeason: "12-31"
  },
  percentiles: {
    label: "Percentiles",
    path: "/raster/mapid/percentiles",
    usesTargetDates: true,
    usesClimatologyYears: true,
    temporalStatistic: "mean",
    calculation: "percentile",
    percentileStep: 1
  }
};

const parseCsvLine = (line) => {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result.map((value) => value.trim());
};

const isIgnoredSeries = (name) => {
  if (!name) return false;
  const normalized = name.trim().toLowerCase();
  return normalized === "request";
};

const parseCsvTimeseries = (csvText) => {
  const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { series: [], headers: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);

  let dateIndex = headers.findIndex((header) => /date|time|year/i.test(header));
  if (dateIndex === -1) {
    dateIndex = 0;
  }
  const variableIndex = headers.findIndex((header) => /variable|band/i.test(header));
  const valueIndex = headers.findIndex((header) => /value|mean|avg|median|total/i.test(header));

  const parseRow = (row) => {
    const dateRaw = row[dateIndex];
    if (!dateRaw) return null;
    let timestamp = Date.parse(dateRaw);
    if (Number.isNaN(timestamp)) {
      const yearMatch = dateRaw.match(/^(\\d{4})$/);
      if (yearMatch) {
        timestamp = Date.UTC(Number(yearMatch[1]), 0, 1);
      }
    }
    if (!Number.isFinite(timestamp)) return null;
    return timestamp;
  };

  if (variableIndex !== -1 && valueIndex !== -1 && variableIndex !== valueIndex) {
    const seriesMap = new Map();
    rows.forEach((row) => {
      const timestamp = parseRow(row);
      if (!timestamp) return;
      const name = row[variableIndex] || "value";
      if (isIgnoredSeries(name)) return;
      const value = Number(row[valueIndex]);
      if (Number.isNaN(value)) return;
      if (!seriesMap.has(name)) {
        seriesMap.set(name, []);
      }
      seriesMap.get(name).push([timestamp, value]);
    });
    const series = Array.from(seriesMap, ([name, data]) => ({
      name,
      data: data.sort((a, b) => a[0] - b[0])
    }));
    return { series, headers };
  }

  const valueIndices = headers
    .map((_, index) => index)
    .filter((index) => index !== dateIndex)
    .filter((index) => !isIgnoredSeries(headers[index]));
  const series = valueIndices.map((index) => ({
    name: headers[index] || `series_${index}`,
    data: []
  }));
  rows.forEach((row) => {
    const timestamp = parseRow(row);
    if (!timestamp) return;
    valueIndices.forEach((valueIdx, seriesIndex) => {
      const value = Number(row[valueIdx]);
      if (Number.isNaN(value)) return;
      series[seriesIndex].data.push([timestamp, value]);
    });
  });
  series.forEach((item) => item.data.sort((a, b) => a[0] - b[0]));
  return { series, headers };
};

const datasetOptions = [
  { value: "RAP_PRODUCTION", label: "RAP Production" },
  { value: "RAP_COVER", label: "RAP Cover" },
  { value: "RCMAP", label: "RCMAP" }
];

const datasetVariables = {
  RAP_PRODUCTION: [
    { value: "herbaceousAGB", label: "Herbaceous AGB" },
    { value: "afgAGB", label: "AFG AGB" },
    { value: "pfgAGB", label: "PFG AGB" }
  ],
  RAP_COVER: [
    { value: "AFG", label: "Annual Forb and Grass Cover" },
    { value: "PFG", label: "Perennial Forb and Grass Cover" },
    { value: "SHR", label: "Shrub Cover" },
    { value: "TRE", label: "Tree Cover" },
    { value: "BGR", label: "Bare Ground Cover" },
    { value: "LTR", label: "Litter Cover" }
  ],
  RCMAP: [
    { value: "rangeland_annual_herbaceous", label: "Annual Herbaceous Cover" },
    { value: "rangeland_bare_ground", label: "Bare Ground Cover" },
    { value: "rangeland_non_sagebrush_shrub", label: "Non-sagebrush Shrub Cover" },
    { value: "rangeland_herbaceous", label: "Herbaceous Cover" },
    { value: "rangeland_litter", label: "Litter Cover" },
    { value: "rangeland_sagebrush", label: "Sagebrush Cover" },
    { value: "rangeland_shrub", label: "Shrub Cover" },
    // { value: "rangeland_shrub_height", label: "Shrub Height" },
    // { value: "rangeland_perennial_herbacous", label: "Perennial Herbaceous Cover" },
    { value: "rangeland_tree", label: "Tree Cover" }
  ]
};

const statisticOptions = [
  { value: "mean", label: "Mean" }
];

const pValueOptions = ["1.0", "0.2", "0.1", "0.05", "0.01"];
const anomaliesCalculationOptions = [
  { value: "anom", label: "anom" },
  { value: "anompercentof", label: "anompercentof" },
  { value: "anompercentchange", label: "anompercentchange" }
];
const getDefaultAnomaliesCalculation = (dataset) =>
  dataset === "RAP_PRODUCTION" ? "anompercentof" : "anom";

const minYear = 1986;
const maxYear = 2025;
const mkDefaultStartYear = 1996;
const mkDefaultEndYear = 2025;
const valuesDefaultStartYear = Math.max(maxYear - 1, minYear);
const yearOptions = Array.from(
  { length: maxYear - minYear + 1 },
  (_, index) => minYear + index
);

const placeholderBounds = [
  [24.5, -125.0],
  [49.5, -66.5]
];

const variableColors = {
  herbaceousAGB: "#2fa166",
  afgAGB: "#1b7aa6",
  pfgAGB: "#c58b2a",
  AFG: "#2fa166",
  PFG: "#1b7aa6",
  SHR: "#9b6b3f",
  TRE: "#2a7f4f",
  BGR: "#c58b2a",
  LTR: "#7a5e3a",
  rangeland_annual_herbaceous: "#2fa166",
  rangeland_bare_ground: "#c58b2a",
  rangeland_non_sagebrush_shrub: "#9b6b3f",
  rangeland_herbaceous: "#1b7aa6",
  rangeland_litter: "#7a5e3a",
  rangeland_sagebrush: "#7f6b3e",
  rangeland_shrub: "#8b5a3c",
  // rangeland_shrub_height: "#5b7fa6",
  // rangeland_perennial_herbacous: "#2c8f6f",
  rangeland_tree: "#2a7f4f"
};

const endpointLegendKey = {
  values: "value",
  anomalies: "anompercentof",
  mann_kendall: "mk_sen",
  percentiles: "percentiles"
};

const getVariableLabel = (dataset, variable) => {
  const options = datasetVariables[dataset] ?? [];
  return options.find((option) => option.value === variable)?.label ?? variable;
};

const getDatasetLabel = (dataset) => {
  return datasetOptions.find((option) => option.value === dataset)?.label ?? dataset;
};

const formatLegendValue = (value) => {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toString() : value.toFixed(2);
  }
  return value ?? "";
};

const resolveLegendEntry = (dataset, variable, endpointKey, calculationOverride) => {
  const datasetLegend = legendDefaults[dataset];
  if (!datasetLegend) return null;
  const variableLegend = datasetLegend[variable];
  if (!variableLegend) return null;
  let calculationKey =
    (calculationOverride === "percentile" ? "percentiles" : calculationOverride) ||
    endpointLegendKey[endpointKey] ||
    "value";
  let entry = variableLegend[calculationKey];
  if (!entry && calculationKey === "anompercentof") {
    calculationKey = "anom";
    entry = variableLegend[calculationKey];
  }
  if (!entry && calculationKey === "percentiles") {
    calculationKey = "value";
    entry = variableLegend[calculationKey];
  }
  if (!entry) return null;
  return { entry, calculationKey };
};

const formatJson = (text) => {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (error) {
    return text;
  }
};

function Panel({ title, className, actions, children }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-title">
        <div className="panel-title-row">
          <span>{title}</span>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </div>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function CodeBlock({ language, value, maxHeight = 110, compact = false }) {
  const padding = compact ? "8px" : "10px";
  const fontSize = compact ? "0.74rem" : "0.78rem";
  const maxHeightValue = maxHeight ?? 110;
  return (
    <div className="code-block-wrap">
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        wrapLongLines
        customStyle={{
          margin: 0,
          padding,
          borderRadius: "12px",
          background: "#0f1f24",
          fontSize,
          lineHeight: 1.35,
          maxHeight: maxHeightValue,
          overflowX: "hidden",
          overflowY: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          boxSizing: "border-box",
          width: "100%",
          maxWidth: "100%"
        }}
        codeTagProps={{
          style: {
            fontFamily:
              "\"SFMono-Regular\", \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowWrap: "anywhere"
          }
        }}
      >
        {value || "—"}
      </SyntaxHighlighter>
    </div>
  );
}

function CodeModal({ title, language, value, onClose }) {
  if (!value) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
          <button type="button" className="modal-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-body">
          <CodeBlock language={language} value={value} maxHeight="70vh" />
        </div>
      </div>
    </div>
  );
}

function MapClickHandler({ onClick }) {
  useMapEvents({
    click(event) {
      onClick?.(event.latlng);
    }
  });
  return null;
}

export default function App() {
  const logoUrl = `${import.meta.env.BASE_URL}climate-engine-logo.png`;
  const [endpointKey, setEndpointKey] = useState("values");
  const [submittedEndpointKey, setSubmittedEndpointKey] = useState("values");
  const [form, setForm] = useState({
    dataset: "RAP_PRODUCTION",
    variable: "herbaceousAGB",
    temporal_statistic: "mean",
    anomaliesCalculation: getDefaultAnomaliesCalculation("RAP_PRODUCTION"),
    startYear: valuesDefaultStartYear,
    endYear: maxYear,
    climatologyStartYear: 1996,
    climatologyEndYear: 2025,
    pValue: "1.0"
  });
  const [submittedParams, setSubmittedParams] = useState(null);
  const [showCode, setShowCode] = useState(false);
  const [tileUrl, setTileUrl] = useState("");
  const [layerVisible, setLayerVisible] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [mapResponse, setMapResponse] = useState({ status: null, body: "" });
  const [timeseriesState, setTimeseriesState] = useState({
    loading: false,
    error: "",
    series: [],
    csv: "",
    responseText: "",
    status: null,
    meta: null,
    request: null,
    headers: []
  });
  const [clickedPoint, setClickedPoint] = useState(null);
  const [timeseriesVisible, setTimeseriesVisible] = useState(false);
  const [timeseriesChartMode, setTimeseriesChartMode] = useState("line");
  const [codeModal, setCodeModal] = useState(null);
  const endpointConfig = endpointConfigs[endpointKey];
  const variableOptions = datasetVariables[form.dataset] ?? datasetVariables.RAP_PRODUCTION;
  const temporalStatisticValue =
    endpointConfig.temporalStatistic ?? form.temporal_statistic;
  const showClimatologyYears = endpointConfig.usesClimatologyYears;
  const showTargetYears = endpointConfig.usesTargetDates || endpointKey === "mann_kendall";

  const params = useMemo(
    () => {
      const temporalStatistic =
        endpointConfig.temporalStatistic ?? form.temporal_statistic;
      const nextParams = {
        dataset: form.dataset,
        variable: form.variable,
        temporal_statistic: temporalStatistic
      };

      if (endpointConfig.usesTargetDates) {
        const startDate = `${form.startYear}-01-01`;
        const endDate =
          endpointKey === "values" ? `${form.endYear}-01-01` : `${form.endYear}-12-31`;
        nextParams.start_date = startDate;
        nextParams.end_date = endDate;
      }

      if (endpointKey === "anomalies") {
        nextParams.calculation = form.anomaliesCalculation;
        nextParams.start_year = form.climatologyStartYear;
        nextParams.end_year = form.climatologyEndYear;
      }

      if (endpointKey === "mann_kendall") {
        nextParams.calculation = endpointConfig.calculation;
        nextParams.start_season = endpointConfig.startSeason;
        nextParams.end_season = endpointConfig.endSeason;
        nextParams.start_year = form.startYear;
        nextParams.end_year = form.endYear;
        nextParams.p_value = form.pValue || "0.5";
      }

      if (endpointKey === "percentiles") {
        nextParams.calculation = endpointConfig.calculation;
        nextParams.percentile_step = endpointConfig.percentileStep;
        nextParams.start_year = form.climatologyStartYear;
        nextParams.end_year = form.climatologyEndYear;
        nextParams.precision = "1e-07";
        nextParams.p_value = "0.5";
      }

      return nextParams;
    },
    [endpointConfig, endpointKey, form]
  );

  const curlCommand = useMemo(() => {
    const baseUrl =
      API_BASE ? joinUrl(API_BASE, endpointConfig.path) : "<API_BASE><ENDPOINT>";
    const query = new URLSearchParams(params).toString();
    const url = `${baseUrl}?${query}`;
    const tokenLabel = API_TOKEN || "<YOUR_TOKEN>";
    const authValueLabel = buildAuthValue(tokenLabel);
    return [
      `curl -G \"${url}\"`,
      `  -H \"${AUTH_HEADER}: ${authValueLabel}\"`,
      "  -H \"accept: application/json\""
    ].join(" \\\n");
  }, [params, endpointConfig.path]);

  const requestSnippet = useMemo(() => {
    const tokenLabel = API_TOKEN || "<YOUR_TOKEN>";
    const authValueLabel = buildAuthValue(tokenLabel);
    return [
      "const params = " + JSON.stringify(params, null, 2) + ";",
      "",
      "const query = new URLSearchParams(params).toString();",
      "const response = await fetch(\"" +
        (API_BASE ? joinUrl(API_BASE, endpointConfig.path) : "<API_BASE><ENDPOINT>") +
        "?\" + query, {",
      "  method: \"GET\",",
      "  headers: {",
      `    "${AUTH_HEADER}": "${authValueLabel}"`,
      "    \"accept\": \"application/json\"",
      "  }",
      "});"
    ].join("\n");
  }, [params, endpointConfig.path]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => {
      if (name === "dataset") {
        const nextDataset = value;
        const nextVariables = datasetVariables[nextDataset] ?? [];
        const fallbackVariable = nextVariables.length ? nextVariables[0].value : prev.variable;
        return {
          ...prev,
          dataset: nextDataset,
          variable: fallbackVariable,
          anomaliesCalculation: getDefaultAnomaliesCalculation(nextDataset)
        };
      }
      return {
        ...prev,
        [name]: name.includes("Year") ? Number(value) : value
      };
    });
  };

  const handleEndpointChange = (key) => {
    setEndpointKey(key);
    if (key === "mann_kendall") {
      setForm((prev) => ({
        ...prev,
        startYear: mkDefaultStartYear,
        endYear: mkDefaultEndYear
      }));
      return;
    }
    if (key === "anomalies" || key === "percentiles") {
      setForm((prev) => ({
        ...prev,
        startYear: maxYear,
        endYear: maxYear
      }));
      return;
    }
    if (key === "values") {
      setForm((prev) => {
        if (prev.startYear === maxYear && prev.endYear === maxYear) {
          return {
            ...prev,
            startYear: valuesDefaultStartYear,
            endYear: maxYear
          };
        }
        return prev;
      });
    }
  };

  const handleMapClick = async (latlng) => {
    if (!submittedParams) {
      setStatusMessage("Submit a map layer request before requesting a timeseries.");
      return;
    }

    if (!API_BASE) {
      setTimeseriesState((prev) => ({
        ...prev,
        error: "API base URL is not configured."
      }));
      return;
    }

    if (!API_TOKEN) {
      setTimeseriesState((prev) => ({
        ...prev,
        error: "Set VITE_CE_TOKEN in .env to authenticate with the Climate Engine API."
      }));
      return;
    }

    setClickedPoint(latlng);
    setTimeseriesVisible(true);
    setTimeseriesChartMode("line");
    setTimeseriesState({
      loading: true,
      error: "",
      series: [],
      csv: "",
      responseText: "",
      status: null,
      meta: null,
      request: null,
      headers: []
    });

    try {
      const paramsForRequest = {
        dataset: activeDataset,
        variable: activeVariable,
        coordinates: JSON.stringify([[latlng.lng, latlng.lat]]),
        start_date: "1986-01-01",
        end_date: "2025-01-01",
        area_reducer: "mean",
        export_format: "csv"
      };
      const query = new URLSearchParams(paramsForRequest).toString();
      const apiUrl = joinUrl(API_BASE, TIMESERIES_ENDPOINT);
      const authHeaderValue = buildAuthValue(API_TOKEN);
      const response = await fetch(`${apiUrl}?${query}`, {
        method: "GET",
        headers: {
          [AUTH_HEADER]: authHeaderValue,
          accept: "text/csv"
        }
      });

      const responseText = await response.text();
      if (!response.ok) {
        setTimeseriesState((prev) => ({
          ...prev,
          loading: false,
          status: response.status,
          responseText
        }));
        throw new Error(`Timeseries request failed (${response.status}): ${responseText}`);
      }

      const parsed = parseCsvTimeseries(responseText);
      const meta = {
        dataset: paramsForRequest.dataset,
        variable: paramsForRequest.variable,
        coordinates: [latlng.lng.toFixed(4), latlng.lat.toFixed(4)],
        start_date: paramsForRequest.start_date,
        end_date: paramsForRequest.end_date,
        area_reducer: paramsForRequest.area_reducer,
        export_format: paramsForRequest.export_format
      };

      const hasData = parsed.series.some((series) => series.data.length);
      setTimeseriesState({
        loading: false,
        error: hasData ? "" : "No data returned for this location.",
        series: parsed.series,
        csv: responseText,
        responseText,
        status: response.status,
        meta,
        request: paramsForRequest,
        headers: parsed.headers
      });
    } catch (error) {
      setTimeseriesState((prev) => ({
        ...prev,
        loading: false,
        error: error.message || "Failed to load timeseries data."
      }));
    }
  };

  const openCodeModal = ({ title, value, language = "text" }) => {
    if (!value) return;
    setCodeModal({ title, value, language });
  };

  const closeCodeModal = () => {
    setCodeModal(null);
  };

  const handleTimeseriesAllVariables = async () => {
    if (!submittedParams) {
      setTimeseriesState((prev) => ({
        ...prev,
        error: "Submit a map layer request before requesting a timeseries."
      }));
      return;
    }

    if (!clickedPoint) {
      setTimeseriesState((prev) => ({
        ...prev,
        error: "Click on the map to set a location first."
      }));
      return;
    }

    if (!API_BASE) {
      setTimeseriesState((prev) => ({
        ...prev,
        error: "API base URL is not configured."
      }));
      return;
    }

    if (!API_TOKEN) {
      setTimeseriesState((prev) => ({
        ...prev,
        error: "Set VITE_CE_TOKEN in .env to authenticate with the Climate Engine API."
      }));
      return;
    }

    setTimeseriesVisible(true);
    setTimeseriesChartMode("line");
    setTimeseriesState({
      loading: true,
      error: "",
      series: [],
      csv: "",
      responseText: "",
      status: null,
      meta: null,
      request: null,
      headers: []
    });

    try {
      const paramsForRequest = {
        dataset: activeDataset,
        variable: (datasetVariables[activeDataset] || []).map((item) => item.value).join(","),
        coordinates: JSON.stringify([[clickedPoint.lng, clickedPoint.lat]]),
        start_date: "1986-01-01",
        end_date: "2025-01-01",
        area_reducer: "mean",
        export_format: "csv"
      };
      const query = new URLSearchParams(paramsForRequest).toString();
      const apiUrl = joinUrl(API_BASE, TIMESERIES_ENDPOINT);
      const authHeaderValue = buildAuthValue(API_TOKEN);
      const response = await fetch(`${apiUrl}?${query}`, {
        method: "GET",
        headers: {
          [AUTH_HEADER]: authHeaderValue,
          accept: "text/csv"
        }
      });

      const responseText = await response.text();
      if (!response.ok) {
        setTimeseriesState((prev) => ({
          ...prev,
          loading: false,
          status: response.status,
          responseText
        }));
        throw new Error(`Timeseries request failed (${response.status}): ${responseText}`);
      }

      const parsed = parseCsvTimeseries(responseText);
      const meta = {
        dataset: paramsForRequest.dataset,
        variable: paramsForRequest.variable,
        coordinates: [clickedPoint.lng.toFixed(4), clickedPoint.lat.toFixed(4)],
        start_date: paramsForRequest.start_date,
        end_date: paramsForRequest.end_date,
        area_reducer: paramsForRequest.area_reducer,
        export_format: paramsForRequest.export_format
      };

      const hasData = parsed.series.some((series) => series.data.length);
      setTimeseriesState({
        loading: false,
        error: hasData ? "" : "No data returned for this location.",
        series: parsed.series,
        csv: responseText,
        responseText,
        status: response.status,
        meta,
        request: paramsForRequest,
        headers: parsed.headers
      });
    } catch (error) {
      setTimeseriesState((prev) => ({
        ...prev,
        loading: false,
        error: error.message || "Failed to load timeseries data."
      }));
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setShowCode(true);
    setSubmittedParams(params);
    setSubmittedEndpointKey(endpointKey);
    setLayerVisible(true);
    setStatusMessage("");
    setTileUrl("");
    setMapResponse({ status: null, body: "" });

    const needsStrictRange = endpointKey === "values";
    if (needsStrictRange && form.endYear <= form.startYear) {
      setStatusMessage("End year must be greater than start year.");
      return;
    }

    if (!needsStrictRange && form.endYear < form.startYear) {
      setStatusMessage("End year must be greater than or equal to start year.");
      return;
    }

    if (endpointConfig.usesClimatologyYears) {
      if (form.climatologyEndYear < form.climatologyStartYear) {
        setStatusMessage("Climatology end year must be greater than or equal to start year.");
        return;
      }
    }

    if (!API_BASE) {
      setStatusMessage("API base URL is not configured.");
      return;
    }

    if (!API_TOKEN) {
      setStatusMessage("Set VITE_CE_TOKEN in .env to authenticate with the Climate Engine API.");
      return;
    }

    setIsLoading(true);

    try {
      const query = new URLSearchParams(params).toString();
      const apiUrl = joinUrl(API_BASE, endpointConfig.path);
      const authHeaderValue = buildAuthValue(API_TOKEN);
      const response = await fetch(`${apiUrl}?${query}`, {
        method: "GET",
        headers: {
          [AUTH_HEADER]: authHeaderValue,
          accept: "application/json"
        }
      });

      const responseText = await response.text();
      setMapResponse({ status: response.status, body: responseText });

      if (!response.ok) {
        throw new Error(`Request failed (${response.status}): ${responseText}`);
      }

      let data = null;
      try {
        data = JSON.parse(responseText);
      } catch (error) {
        throw new Error("Request succeeded, but the response was not valid JSON.");
      }
      let nextTileUrl =
        data?.Data?.tile_fetcher ||
        data?.data?.tile_fetcher ||
        data?.tile_fetcher ||
        data?.tile_url ||
        data?.tileUrl ||
        data?.tiles ||
        data?.url ||
        data?.data?.tile_url ||
        data?.data?.tiles ||
        "";

      if (nextTileUrl && !nextTileUrl.startsWith("http")) {
        if (nextTileUrl.startsWith("/") && API_BASE) {
          nextTileUrl = `${API_BASE}${nextTileUrl}`;
        }
      }

      if (!nextTileUrl) {
        setStatusMessage("Request succeeded, but no tile URL was returned.");
      }

      setTileUrl(nextTileUrl);
    } catch (error) {
      setStatusMessage(error.message || "Something went wrong with the request.");
    } finally {
      setIsLoading(false);
    }
  };

  const formatVariableDisplay = (dataset, variable) => {
    if (!variable) return "None";
    if (variable.includes(",")) {
      const count = variable.split(",").filter(Boolean).length;
      return `All variables (${count})`;
    }
    return getVariableLabel(dataset, variable);
  };

  const activeLayerLabel = submittedParams ? submittedParams.variable : "None";
  const activeYearsLabel = submittedParams
    ? submittedParams.start_date
      ? `${submittedParams.start_date.slice(0, 4)} - ${submittedParams.end_date.slice(0, 4)}`
      : `${submittedParams.start_year} - ${submittedParams.end_year}`
    : "Not set";
  const legendEndpointKeyValue = submittedParams ? submittedEndpointKey : endpointKey;
  const legendDataset = submittedParams?.dataset;
  const legendVariable = submittedParams?.variable;
  const legendCalculationOverride =
    legendEndpointKeyValue === "anomalies" ? submittedParams?.calculation : null;
  const legendResult = submittedParams
    ? resolveLegendEntry(
        legendDataset,
        legendVariable,
        legendEndpointKeyValue,
        legendCalculationOverride
      )
    : null;
  const legendEntry = legendResult?.entry;
  const legendPalette = legendEntry?.palette ?? [];
  const legendGradient = legendPalette.length
    ? `linear-gradient(90deg, ${legendPalette.join(",")})`
    : "";
  const legendCalculationLabel = submittedParams?.calculation ?? legendResult?.calculationKey;
  const hasLayer = Boolean(submittedParams);
  const layerChecked = hasLayer && layerVisible;

  const activeDataset = submittedParams?.dataset ?? form.dataset;
  const activeVariable = submittedParams?.variable ?? form.variable;
  const timeseriesParams = useMemo(
    () => ({
      dataset: activeDataset,
      variable: activeVariable,
      coordinates: JSON.stringify(
        clickedPoint ? [[clickedPoint.lng, clickedPoint.lat]] : [[-119.96, 39.57]]
      ),
      start_date: "1986-01-01",
      end_date: "2025-01-01",
      area_reducer: "mean",
      export_format: "csv"
    }),
    [activeDataset, activeVariable, clickedPoint]
  );
  const timeseriesRequest = timeseriesState.request ?? timeseriesParams;
  const timeseriesDatasetForLabels = timeseriesState.meta?.dataset ?? activeDataset;
  const timeseriesSeries = timeseriesState.series.map((series) => ({
    ...series,
    name: getVariableLabel(timeseriesDatasetForLabels, series.name)
  }));
  const requestVariables = timeseriesState.request?.variable
    ? timeseriesState.request.variable.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  const datasetVariableList =
    (datasetVariables[timeseriesDatasetForLabels] || []).map((item) => item.value) || [];
  const isAllVariablesRequest =
    requestVariables.length > 1 &&
    datasetVariableList.length === requestVariables.length &&
    datasetVariableList.every((value) => requestVariables.includes(value));
  const canToggleChart = isAllVariablesRequest;
  const chartType = timeseriesChartMode === "stacked" ? "column" : "line";
  const mapResponseObject = formatJson(mapResponse.body);
  const mapResponseDisplay = mapResponseObject || "—";
  const timeseriesResponseObject = timeseriesState.responseText || "";
  const timeseriesResponseDisplay = timeseriesResponseObject || "—";

  const timeseriesCurl = useMemo(() => {
    const baseUrl = API_BASE ? joinUrl(API_BASE, TIMESERIES_ENDPOINT) : "<API_BASE><ENDPOINT>";
    const query = new URLSearchParams(timeseriesRequest).toString();
    const url = `${baseUrl}?${query}`;
    const tokenLabel = API_TOKEN || "<YOUR_TOKEN>";
    const authValueLabel = buildAuthValue(tokenLabel);
    return [
      `curl -G \"${url}\"`,
      `  -H \"${AUTH_HEADER}: ${authValueLabel}\"`,
      "  -H \"accept: text/csv\""
    ].join(" \\\n");
  }, [timeseriesRequest]);

  const timeseriesSnippet = useMemo(() => {
    const tokenLabel = API_TOKEN || "<YOUR_TOKEN>";
    const authValueLabel = buildAuthValue(tokenLabel);
    return [
      "const params = " + JSON.stringify(timeseriesRequest, null, 2) + ";",
      "",
      "const query = new URLSearchParams(params).toString();",
      "const response = await fetch(\"" +
        (API_BASE ? joinUrl(API_BASE, TIMESERIES_ENDPOINT) : "<API_BASE><ENDPOINT>") +
        "?\" + query, {",
      "  method: \"GET\",",
      "  headers: {",
      `    \"${AUTH_HEADER}\": \"${authValueLabel}\",`,
      "    \"accept\": \"text/csv\"",
      "  }",
      "});",
      "const csv = await response.text();"
    ].join("\n");
  }, [timeseriesRequest]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <img src={logoUrl} alt="Climate Engine" />
          <div>
            <p className="brand-label">Climate Engine FVC API Demo</p>
            <span className="brand-subtitle">Map and Timeseries Explorer using RAP and RCMAP</span>
          </div>
        </div>
        <div className="header-meta">
          <span>Annual Fractional Vegetation Cover</span>
        </div>
      </header>

      <main className="map-shell">
        <MapContainer
          className="map"
          center={[39.5, -98.35]}
          zoom={4}
          minZoom={2}
          scrollWheelZoom
          zoomControl={false}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
            attribution="&copy; OpenStreetMap contributors &copy; CARTO"
          />
          {tileUrl && layerChecked ? (
            <TileLayer url={tileUrl} opacity={0.7} />
          ) : submittedParams && layerChecked ? (
            <Rectangle
              bounds={placeholderBounds}
              pathOptions={{
                color: variableColors[submittedParams.variable],
                weight: 2,
                fillOpacity: 0.1
              }}
            />
          ) : null}
          <MapClickHandler onClick={handleMapClick} />
          <ZoomControl position="bottomleft" />
        </MapContainer>

        <Panel title="Map Visualization" className="viz-panel">
          <form className="form" onSubmit={handleSubmit}>
            <div className="endpoint-toggle">
              {Object.entries(endpointConfigs).map(([key, config]) => (
                <button
                  key={key}
                  type="button"
                  className={`endpoint-button ${endpointKey === key ? "active" : ""}`}
                  onClick={() => handleEndpointChange(key)}
                >
                  {config.label}
                </button>
              ))}
            </div>

            <label className="form-field">
              <span>Dataset</span>
              <select name="dataset" value={form.dataset} onChange={handleChange}>
                {datasetOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field">
              <span>Variable</span>
              <select name="variable" value={form.variable} onChange={handleChange}>
                {variableOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field">
              <span>Temporal Statistic</span>
              <select
                name="temporal_statistic"
                value={temporalStatisticValue}
                onChange={handleChange}
                disabled={Boolean(endpointConfig.temporalStatistic)}
              >
                {statisticOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {endpointKey === "anomalies" ? (
              <label className="form-field">
                <span>Calculation</span>
                <select
                  name="anomaliesCalculation"
                  value={form.anomaliesCalculation}
                  onChange={handleChange}
                >
                  {anomaliesCalculationOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : endpointConfig.calculation ? (
              <label className="form-field">
                <span>Calculation</span>
                <input type="text" value={endpointConfig.calculation} readOnly />
              </label>
            ) : null}

            {endpointKey === "percentiles" ? (
              <label className="form-field">
                <span>Percentile Step</span>
                <input type="text" value={endpointConfig.percentileStep} readOnly />
              </label>
            ) : null}

            {endpointKey === "mann_kendall" ? (
              <div className="form-row">
                <label className="form-field">
                  <span>Start Season</span>
                  <input type="text" value={endpointConfig.startSeason} readOnly />
                </label>
                <label className="form-field">
                  <span>End Season</span>
                  <input type="text" value={endpointConfig.endSeason} readOnly />
                </label>
              </div>
            ) : null}

            {endpointKey === "mann_kendall" ? (
              <label className="form-field">
                <span>P-Value</span>
                <select name="pValue" value={form.pValue} onChange={handleChange}>
                  {pValueOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {showTargetYears ? (
              <div className="form-row">
                <label className="form-field">
                  <span>{showClimatologyYears ? "Target Start Year" : "Start Year"}</span>
                  <select name="startYear" value={form.startYear} onChange={handleChange}>
                    {yearOptions.map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="form-field">
                  <span>{showClimatologyYears ? "Target End Year" : "End Year"}</span>
                  <select name="endYear" value={form.endYear} onChange={handleChange}>
                    {yearOptions.map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}

            {showClimatologyYears ? (
              <div className="form-row">
                <label className="form-field">
                  <span>Climatology Start Year</span>
                  <select
                    name="climatologyStartYear"
                    value={form.climatologyStartYear}
                    onChange={handleChange}
                  >
                    {yearOptions.map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="form-field">
                  <span>Climatology End Year</span>
                  <select
                    name="climatologyEndYear"
                    value={form.climatologyEndYear}
                    onChange={handleChange}
                  >
                    {yearOptions.map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}

            <button className="submit" type="submit">
              {isLoading ? "Submitting..." : "Submit request"}
            </button>

            {statusMessage ? <p className="status">{statusMessage}</p> : null}
          </form>
        </Panel>

        <Panel title="Map Code" className="code-panel">
          {showCode ? (
            <div className="code-blocks">
              <div>
                <p className="code-label">Request snippet</p>
                <CodeBlock language="javascript" value={requestSnippet} maxHeight={90} />
              </div>
              <div>
                <p className="code-label">cURL</p>
                <CodeBlock language="bash" value={curlCommand} maxHeight={90} />
                <p className="code-label">Returned status</p>
                <CodeBlock
                  language="text"
                  value={mapResponse.status ? String(mapResponse.status) : "—"}
                  maxHeight={40}
                  compact
                />
                <div className="code-label-row">
                  <p className="code-label">Returned object</p>
                  <button
                    type="button"
                    className="code-expand"
                    onClick={() =>
                      openCodeModal({
                        title: "Returned object",
                        language: "json",
                        value: mapResponseObject
                      })
                    }
                    disabled={!mapResponseObject}
                  >
                    Expand
                  </button>
                </div>
                <CodeBlock
                  language="json"
                  value={mapResponseDisplay}
                  maxHeight={90}
                />
              </div>
            </div>
          ) : (
            <p className="code-placeholder">Submit a request to generate code.</p>
          )}
        </Panel>

        <Panel title="Legend" className="legend-panel">
          {hasLayer ? (
            <div className="legend-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={layerChecked}
                  onChange={(event) => setLayerVisible(event.target.checked)}
                />
                <span>Show layer</span>
              </label>
            </div>
          ) : null}
          {legendEntry ? (
            <div className="legend-content">
              <div className="legend-details">
                <div className="legend-row">
                  <span>Dataset</span>
                  <strong>{getDatasetLabel(legendDataset)}</strong>
                </div>
                <div className="legend-row">
                  <span>Variable</span>
                  <strong>{getVariableLabel(legendDataset, legendVariable)}</strong>
                </div>
                <div className="legend-row">
                  <span>Years</span>
                  <strong>{activeYearsLabel}</strong>
                </div>
              </div>
              <div className="legend-ramp">
                <div className="legend-bar" style={{ background: legendGradient }} />
                <div className="legend-labels">
                  <span>{formatLegendValue(legendEntry.min)}</span>
                  <span>{formatLegendValue(legendEntry.max)}</span>
                </div>
              </div>
            </div>
          ) : (
            <p className="legend-empty">Submit a request to see the legend.</p>
          )}
        </Panel>

        {submittedParams ? (
          <div className="timeseries-hint">Click to get timeseries</div>
        ) : null}

        {timeseriesVisible ? (
          <Panel
            title="Timeseries"
            className="ts-panel"
            actions={
              <>
                <button type="button" className="ts-button" onClick={handleTimeseriesAllVariables}>
                  Return All Variables
                </button>
                <button
                  type="button"
                  className="ts-button ghost"
                  onClick={() => setTimeseriesVisible(false)}
                >
                  Close
                </button>
              </>
            }
          >
            {timeseriesState.loading ? (
              <div className="ts-loading">
                <div className="spinner" />
                <p>Loading timeseries...</p>
              </div>
            ) : timeseriesState.error ? (
              <p className="status">{timeseriesState.error}</p>
            ) : timeseriesState.series.length ? (
              <div className="ts-content">
                <div className="ts-meta">
                  <div>
                    <span>Dataset</span>
                    <strong>{getDatasetLabel(timeseriesState.meta.dataset)}</strong>
                  </div>
                  <div>
                    <span>Variable</span>
                    <strong>
                      {formatVariableDisplay(
                        timeseriesState.meta.dataset,
                        timeseriesState.meta.variable
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>Coordinates</span>
                    <strong>
                      {timeseriesState.meta.coordinates[1]}, {timeseriesState.meta.coordinates[0]}
                    </strong>
                  </div>
                  <div>
                    <span>Date Range</span>
                    <strong>
                      {timeseriesState.meta.start_date} → {timeseriesState.meta.end_date}
                    </strong>
                  </div>
                  <div>
                    <span>Reducer</span>
                    <strong>{timeseriesState.meta.area_reducer}</strong>
                  </div>
                  <div>
                    <span>Format</span>
                    <strong>{timeseriesState.meta.export_format}</strong>
                  </div>
                </div>

                {canToggleChart ? (
                  <div className="ts-chart-toggle">
                    <button
                      type="button"
                      className={`ts-button ${timeseriesChartMode === "line" ? "active" : ""}`}
                      onClick={() => setTimeseriesChartMode("line")}
                    >
                      Timeseries
                    </button>
                    <button
                      type="button"
                      className={`ts-button ${timeseriesChartMode === "stacked" ? "active" : ""}`}
                      onClick={() => setTimeseriesChartMode("stacked")}
                    >
                      Stacked
                    </button>
                  </div>
                ) : null}

                <HighchartsReact
                  highcharts={Highcharts}
                  options={{
                    chart: { type: chartType, height: 260, backgroundColor: "transparent" },
                    title: { text: null },
                    xAxis: { type: "datetime" },
                    yAxis: { title: { text: null } },
                    legend: { enabled: timeseriesSeries.length > 1 },
                    credits: { enabled: false },
                    plotOptions:
                      chartType === "column"
                        ? {
                            column: {
                              stacking: "normal",
                              borderWidth: 0,
                              pointPadding: 0.05,
                              groupPadding: 0.05
                            }
                          }
                        : {
                            series: {
                              marker: { enabled: false }
                            }
                          },
                    series: timeseriesSeries.length
                      ? timeseriesSeries.map((series, index) => ({
                        ...series,
                        color: series.color || (index === 0 ? "#2fa166" : undefined)
                      }))
                      : []
                  }}
                />

                <div className="ts-code">
                  <div>
                    <p className="code-label">Request snippet</p>
                    <CodeBlock language="javascript" value={timeseriesSnippet} maxHeight={90} />
                  </div>
                  <div>
                    <p className="code-label">cURL</p>
                    <CodeBlock language="bash" value={timeseriesCurl} maxHeight={90} />
                    <p className="code-label">Returned status</p>
                    <CodeBlock
                      language="text"
                      value={timeseriesState.status ? String(timeseriesState.status) : "—"}
                      maxHeight={40}
                      compact
                    />
                    <div className="code-label-row">
                      <p className="code-label">Returned object</p>
                      <button
                        type="button"
                        className="code-expand"
                        onClick={() =>
                          openCodeModal({
                            title: "Returned object",
                            language: "text",
                            value: timeseriesResponseObject
                          })
                        }
                        disabled={!timeseriesResponseObject}
                      >
                        Expand
                      </button>
                    </div>
                    <CodeBlock
                      language="text"
                      value={timeseriesResponseDisplay}
                      maxHeight={90}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <p className="legend-empty">Click on the map to load a timeseries.</p>
            )}
          </Panel>
        ) : null}
      </main>
      <CodeModal
        title={codeModal?.title}
        language={codeModal?.language}
        value={codeModal?.value}
        onClose={closeCodeModal}
      />
    </div>
  );
}
