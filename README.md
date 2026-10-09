<div align="center">
  <h1>@cyanheads/noaa-marine-mcp-server</h1>
  <p><b>Find NOAA tide stations and NDBC buoys, fetch tide predictions, water levels, tidal currents, and live buoy conditions via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.6.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/noaa-marine-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/noaa-marine-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/noaa-marine-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/noaa-marine-mcp-server/releases/latest/download/noaa-marine-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=noaa-marine-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbm9hYS1tYXJpbmUtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22noaa-marine-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fnoaa-marine-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://noaa-marine.caseyjhand.com/mcp](https://noaa-marine.caseyjhand.com/mcp)

</div>

---

## Overview

US tides, currents, water levels, and buoy observations from NOAA CO-OPS and NDBC. Find coastal stations and buoys, then fetch tide and tidal-current predictions, observed and monthly-mean water levels, and live buoy conditions, current profiles, and water-column readings. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `noaa_marine_find_stations` | Find CO-OPS tide, water-level, and current stations and NDBC buoys by location, name, ID, state, or capability |
| `noaa_marine_get_tide_predictions` | High/low tide predictions or a 6-minute curve for a CO-OPS tide station |
| `noaa_marine_get_water_level` | Observed water level at four cadences, paired with predictions and a storm-surge residual |
| `noaa_marine_get_monthly_means` | Verified monthly tidal datums and extremes for a CO-OPS water-level station |
| `noaa_marine_get_currents` | CO-OPS tidal-current predictions: max flood, max ebb, and slack events, or a 6-minute curve |
| `noaa_marine_get_conditions` | Live NDBC buoy conditions: waves, wind, sea-surface and air temperature, pressure |
| `noaa_marine_get_current_profile` | Observed ocean-current depth profile from an NDBC ADCP buoy |
| `noaa_marine_get_ocean_observations` | Sub-surface water-column readings (temperature, salinity, oxygen, and more) from an NDBC station |

### Resources

| Resource | Description |
|:---|:---|
| `noaa-marine://station/{station_id}` | Metadata for a CO-OPS or NDBC station: name, coordinates, source, capabilities, prediction class, platform |

Everything in the resource except NDBC `owner` is also on `noaa_marine_find_stations` rows, for clients that only call tools.

## Capability reference

### `noaa_marine_find_stations` <sub>tool</sub>

- Filters combine: `latitude` + `longitude` with `radius_km` (default 100, max 1000), `query` (name or ID substring on both sources; an exact ID leads unless sorting by distance), `state` (CO-OPS only), `source` (`coops` / `ndbc` / `all`), and `types` (`tide`, `current`, `water_level`, `met`, `current_profile`, `water_quality`, or the platform class `buoy`); `limit` defaults to 20, max 200
- Each station carries `source`, `capabilities`, `type`, and for NDBC a `platform`; CO-OPS rows add `state` (`state_derived: true` when borrowed from the nearest state-bearing station within 25 km), a tide `prediction_class` (`reference`, or `subordinate` with `reference_id`), and current `bins[]` giving each bin's number, depth in feet, and class
- `total_found` and `truncated` report the count before `limit`; zero matches is a success with `applied_search`, a partial catalog read is flagged in `sources`, and total catalog failure is `sources_unavailable`; only one of `latitude`/`longitude` is `incomplete_coordinates`

---

### `noaa_marine_get_tide_predictions` <sub>tool</sub>

- `interval` `hilo` (default) or `6min`, up to 365 days; ten datums (MLLW, MHHW, MHW, MTL, MSL, MLW, DTL, NAVD, STND, CRD), `time_zone` (`lst_ldt`, `gmt`, `lst`), and `units` (`english` feet, `metric` meters)
- `6min` works at reference stations only: a subordinate station fails as `subordinate_no_6min` naming its reference station, and a Great Lakes station is `no_predictions`, pointing to `noaa_marine_get_water_level`
- Other failures: `invalid_date_range`, `date_range_exceeded`, `station_not_found`, `datum_unavailable` (naming the planes the station carries), and `upstream_throttled`, a retryable CO-OPS HTTP 403 that clears in a couple of minutes

---

### `noaa_marine_get_water_level` <sub>tool</sub>

- `interval` `6min` (default, 31 days), `hourly` or `high_low` (365 days), or `daily_mean` (3,655 days, Great Lakes only, always in LST; a coastal station is `great_lakes_only`); thirteen datums (MLLW, MHHW, MHW, MTL, MSL, MLW, NAVD, STND, IGLD, LWD, CRD, LWI, HWI)
- Observations carry `quality` (`p` / `v`, `6min` only), `sigma` (`6min` and `hourly`), and `type` (`H` / `HH` / `L` / `LL`, `high_low` only); slots with no reading are dropped and counted in `gaps_dropped`
- Paired predictions at the matching cadence (none on `daily_mean`), with `predictions_status` (`empty` / `unavailable`) explaining an empty series; `residual_summary` (`max_surge`, `max_drawdown`) covers the whole matched range, on `6min` and `hourly` only. Failures: `invalid_date_range`, `date_range_exceeded`, `station_not_found`, `datum_unavailable`, `no_data`, `verified_data_lag` (a coarser-cadence window ending on or after the first day of the prior month, which CO-OPS may not have verified yet), and `upstream_throttled`

---

### `noaa_marine_get_monthly_means` <sub>tool</sub>

- Up to 73,000 days per request; eleven datums (MLLW, MHHW, MHW, MTL, MSL, MLW, NAVD, STND, IGLD, LWD, CRD) in `english` feet or `metric` meters; the first and last months returned are those `begin_date` and `end_date` fall in
- One row per month: `highest`, `lowest`, the tidal datums (`mhhw`, `mhw`, `msl`, `mtl`, `mlw`, `mllw`, `dtl`), ranges (`gt`, `mn`, `dhq`, `dlq`), lunitidal intervals in hours (`hwi`, `lwi`), and the `inferred` code verbatim; values CO-OPS leaves blank are omitted, so a Great Lakes station carries only `highest`, `msl`, and `lowest`
- Failures: `invalid_date_range`, `date_range_exceeded`, `station_not_found`, `datum_unavailable`, `upstream_throttled`, and for an empty window `verified_data_lag` when it ends on or after the first day of the prior month, `no_data` otherwise

---

### `noaa_marine_get_currents` <sub>tool</sub>

- `interval` `MAX_SLACK` (default: max flood, max ebb, and slack events) or `6min`, up to 365 days; `bin` picks a depth bin from `bins[]` (default the shallowest); `units` `english` (knots, feet) or `metric` (cm/s, meters)
- Every response echoes `bin` and `depth`; rows carry a `flood` / `ebb` / `slack` `type`, a non-negative `speed`, and as `direction` the station's mean bearing for that flow
- A bin the station lacks is `bin_unavailable` listing the ones it has; a station CO-OPS won't predict as events returns an empty list with its statement in `notice`, and one with no published predictions is `predictions_unavailable`; also `invalid_date_range`, `date_range_exceeded`, `station_not_found`, `no_predictions`, and `upstream_throttled`

---

### `noaa_marine_get_conditions` <sub>tool</sub>

- One NDBC `station_id`; returns wind, waves, sea-surface and air temperature, dew point, and pressure in SI units, except `tide_ft` and `visibility_nmi`
- Every sensor field is nullable; each column block comes from the newest row within 90 minutes that carried it, waves reporting their own `waves_observed_at` and any other older block named in `notice`. Failures: `buoy_not_found`, `no_sensor_data`

---

### `noaa_marine_get_current_profile` <sub>tool</sub>

- One NDBC `station_id`, found with `types: ["current_profile"]`; `bins[]` runs shallowest first with `depth_m`, `direction_deg` (true, flow-toward), and `speed_cm_s`, the last two null when unreported
- Observed ADCP measurements, not the CO-OPS predictions `noaa_marine_get_currents` returns; failures are `profile_not_found` (no ADCP file) and `no_current_data`

---

### `noaa_marine_get_ocean_observations` <sub>tool</sub>

- One NDBC `station_id`, found with `types: ["water_quality"]`, a catalog flag rather than a guarantee; `readings[]` holds one row per depth with temperature, conductivity, salinity, dissolved oxygen (% and ppm), chlorophyll, turbidity, pH, and redox potential
- Most stations report only temperature and salinity, and unreported values are `null`; failures are `observations_not_found` (no `.ocean` file) and `no_ocean_data`

---

### `noaa-marine://station/{station_id}` <sub>resource</sub>

- `station_id` from `noaa_marine_find_stations`; returns that tool's station record as `application/json`, plus `owner` for NDBC stations, with a 6-hour `cacheHint`
- `station_not_found` only when both catalogs were read; `source_unavailable` when one could not be

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

CO-OPS / NDBC-specific:

- CO-OPS data and metadata APIs plus the NDBC active-stations catalog and `realtime2` feeds (`.txt`, `.adcp`, `.ocean`), with station catalogs cached in memory for 6 hours; CO-OPS requests carry `application=` from `NOAA_APPLICATION_ID`
- Station IDs never cross sources: CO-OPS tide and water-level IDs are numeric (`9447130`), CO-OPS current IDs alphanumeric (`ACT4176`), NDBC IDs 5-character codes (`46041`)
- CO-OPS tools take `begin_date` / `end_date` as `YYYYMMDD` or `YYYY-MM-DD` and check the calendar and each tool's range ceiling before calling (`invalid_date_range`, `date_range_exceeded`); heights default to MLLW, and a datum the station lacks is `datum_unavailable` naming ones it carries
- CO-OPS verifies `hourly`, `high_low`, `daily_mean`, and monthly means once a month, for the prior month: an empty window ending on or after the first of the prior month is `verified_data_lag`, an earlier one `no_data`
- CO-OPS answers a burst of requests with HTTP 403 for about two minutes; the CO-OPS data tools report it as a retryable `upstream_throttled` whose recovery names the wait

Agent-friendly output:

- Byte-bounded paging on the four CO-OPS series tools: a range that fits returns whole, and a longer one returns a leading page with `rows_matched`, `rows_returned`, `page_offset`, and `next_offset`, walked with `offset` (`limit` shrinks a page)
- Missing means `null` or omitted, never fabricated: NDBC `MM` markers become `null`, blank CO-OPS values are dropped, and `quality` is left out rather than defaulted
- Discriminated fields: station `source` (`coops` | `ndbc`), capability `type`, NDBC `platform`, and `prediction_class`, with datum and units echoed on every CO-OPS height response, so callers branch on data, not string parsing

## Getting started

### Public Hosted Instance

A public instance is available at `https://noaa-marine.caseyjhand.com/mcp`, with no installation or API key. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "noaa-marine-mcp-server": {
      "type": "streamable-http",
      "url": "https://noaa-marine.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "noaa-marine-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/noaa-marine-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "noaa-marine-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/noaa-marine-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "noaa-marine-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/noaa-marine-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key: NOAA CO-OPS and NDBC are open data sources.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/noaa-marine-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd noaa-marine-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env if needed (all vars optional)
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `NOAA_APPLICATION_ID` | Courtesy identifier sent as `application=` on CO-OPS requests. | `noaa-marine-mcp-server` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_HOST` | HTTP bind address. | `127.0.0.1` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result (redacted by key name only), capped by `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES`. | `false` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL; traces and metrics export to `/v1/traces` and `/v1/metrics` under it. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in OTLP log export endpoint; the base URL never enables it. | — |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  bun run rebuild

  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t noaa-marine-mcp-server .
docker run --rm -p 3010:3010 noaa-marine-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/noaa-marine-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Path | Purpose |
|:-----|:--------|
| `src/index.ts` | `createApp()` entry point: registers the tools and resource, initializes services. |
| `src/config/` | `NOAA_APPLICATION_ID` env var parsing with Zod. |
| `src/services/coops/` | CO-OPS client: station catalog cache, data fetch, error classification, date-range validation, row paging, state resolution. |
| `src/services/ndbc/` | NDBC service: active-stations XML and `realtime2` feed parsers. |
| `src/services/geo.ts` | Haversine distance for proximity search and state resolution. |
| `src/mcp-server/tools/definitions/` | Eight tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/definitions/` | Station metadata resource (`noaa-marine-station.resource.ts`). |
| `tests/` | Vitest tests mirroring `src/`. |
| `docs/` | Design doc and directory tree. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- Register tools and resources in `src/index.ts` directly (no barrels for this server)
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields
- NDBC `MM` values must normalize to `null`, not be passed through as strings

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
