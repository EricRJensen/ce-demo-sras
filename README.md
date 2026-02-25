# Climate Engine API Demo

This repository contains a React + Leaflet demo app for exploring the Climate Engine API. The UI focuses on a full-screen web map with a request builder, code export panel, legend, and map-click timeseries analysis.

## Goals

- Provide a clean, fast UI for testing Climate Engine endpoints.
- Keep the request surface area minimal and explicit (only required parameters).
- Make the map, code, and legend easy to read at a glance.
- Allow users to validate API behavior via generated JS + cURL.
- Support point-based timeseries exploration on any displayed layer.

## Features

- Full-screen map with overlay panels for Visualization, Map Code, Legend, and Timeseries.
- Endpoint toggles for:
  - `/raster/mapid/values`
  - `/raster/mapid/anomalies`
  - `/raster/mapid/mann_kendall`
  - `/raster/mapid/percentiles`
- Dataset support:
  - `RAP_PRODUCTION`
  - `RAP_COVER`
  - `RCMAP`
- Dynamic variable lists per dataset.
- Map legend populated from provided color ramp defaults.
- Map-click to request a timeseries (CSV export) at a point.
- Optional request for all variables in a dataset, with a chart toggle for stacked bar view.
- Generated request snippet + cURL for both map and timeseries requests.

## Local Deployment

### Prerequisites

- Node.js 18+
- npm 9+

### Install

```bash
npm install
```

### Environment

Create or update `.env`:

```
VITE_CE_TOKEN=YOUR_TOKEN
VITE_CE_AUTH_HEADER=Authorization
VITE_CE_AUTH_SCHEME=none
```

Notes:
- `VITE_CE_AUTH_SCHEME=none` sends the raw token (no `Bearer` prefix). If your token requires `Bearer`, set it to `Bearer`.
- The API base URL is hardcoded in `src/App.jsx`. Update it there if you need to target a different API host.

### Run

```bash
npm run dev
```

Then open `http://localhost:5173`.

## Design Decisions

- **Minimal required parameters**: Optional fields are excluded by default to keep requests clear and reproducible.
- **Endpoint-aware UI**: Each endpoint has a constrained form so invalid combinations are avoided.
- **CSV export for timeseries**: CSV is easier to parse and plot quickly in the UI.
- **Map-first layout**: Panels are layered on a full-screen map to maximize spatial context.
- **Legend from defaults**: Legends are populated using provided colormap defaults for consistent interpretation.
- **Request visibility**: Both JS and cURL are shown for easy debugging.

## Timeseries Behavior

- Timeseries requests are only enabled **after** a map layer has been submitted.
- Clicking the map triggers a timeseries request for the currently displayed dataset/variable.
- All-variable requests are supported, and the chart can toggle between line and stacked column views.

## Project Structure

- `src/App.jsx` — Main application logic
- `src/styles.css` — Global styles
- `src/legendDefaults.js` — Colormap defaults
- `public/` — Static assets (logo)

## Notes

- The app expects the map endpoints to return a tile URL in `Data.tile_fetcher`.
- Some API endpoints validate `p_value` as a string; this is handled in the Mann-Kendall and Percentiles requests.

## License

Internal demo application. No public license specified.
