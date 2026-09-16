<div align="center">
  <h1>@cyanheads/noaa-marine-mcp-server</h1>
  <p><b>Find NOAA tide stations and NDBC buoys, fetch tide predictions, water levels, tidal currents, and live buoy conditions via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/noaa-marine-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/noaa-marine-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/noaa-marine-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

US tide, current, and buoy data from NOAA CO-OPS and NDBC. Find tide, water-level, and current stations plus NDBC buoys, then fetch tide predictions, observed water levels, tidal currents, and live buoy conditions from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `noaa_marine_find_stations` | Find CO-OPS tide/water-level/current stations and NDBC buoys by location, name, state, or data capability. |
| `noaa_marine_get_tide_predictions` | High/low tide predictions or a 6-minute curve for a CO-OPS tide station. |
| `noaa_marine_get_water_level` | Observed water level paired with predictions for a CO-OPS station, with a storm-surge residual summary. |
| `noaa_marine_get_currents` | CO-OPS tidal current predictions — max flood/ebb/slack events or a 6-minute curve. |
| `noaa_marine_get_conditions` | Live NDBC buoy conditions: waves, wind, sea-surface and air temperature, pressure. |
| `noaa_marine_get_current_profile` | Observed ocean-current depth profile from an NDBC ADCP buoy. |
| `noaa_marine_get_ocean_observations` | Sub-surface water-column observations (temperature, salinity, oxygen, and more) from an NDBC station. |

### Resources

| Resource | Description |
|:---|:---|
| `noaa-marine://station/{station_id}` | Metadata for a CO-OPS or NDBC station by ID: name, coordinates, source, data capabilities, and — for NDBC — physical platform class. |

All resource data is also reachable via tools — use `noaa_marine_find_stations` to discover station IDs before accessing the resource.

## Capability reference

### `noaa_marine_find_stations` <sub>tool</sub>

- Filter by proximity (`latitude`/`longitude` + `radius_km`, default 100 km, max 1000 km), name/ID substring, US state/territory (CO-OPS only), source (`coops`/`ndbc`/`all`), or `types`: data capabilities (`tide`, `current`, `water_level`, `met`, `current_profile`) or NDBC platform class (`buoy`)
- Returns up to `limit` (default 20, max 200) unified stations with source, coordinates, distance, data capabilities, and — for NDBC — physical platform class (buoy, fixed, oilrig, dart, tao, usv, other)
- `total_found` and `truncated` report the full match count before the limit is applied
- Station lists are cached in-memory with a 6-hour TTL — first call after startup may be slightly slower
- Typed `incomplete_coordinates` error when only one of latitude/longitude is supplied; `no_results` when nothing matches

---

### `noaa_marine_get_tide_predictions` <sub>tool</sub>

- `hilo` (default, high/low events) or `6min` continuous curve; up to 1 year per request
- Eight datums: MLLW (default, US nautical chart), MHHW, MSL, MTL, MHW, MLW, CD, STND
- Time zone (`lst_ldt` default, `gmt`, `lst`) and units (`english` default feet, `metric` meters)
- Typed `date_range_exceeded`, `invalid_date_range`, `station_not_found`, and `no_predictions` errors

---

### `noaa_marine_get_water_level` <sub>tool</sub>

- 6-minute observed water level with quality flags (`p` preliminary, `v` verified) and optional sensor `sigma`
- Paired 6-minute tide predictions fetched in parallel — failure degrades gracefully, observed levels still return
- `residual_summary` (max surge, max drawdown) only when both series are present
- Up to 31 days per request; typed `date_range_exceeded`, `station_not_found`, and `no_data` errors

---

### `noaa_marine_get_currents` <sub>tool</sub>

- `MAX_SLACK` (default): max flood, max ebb, and slack events only — the actionable view for passage planning
- `6min`: continuous current curve; units `english` (knots, default) or `metric` (m/s)
- Current station IDs are alphanumeric (e.g. `ACT4176`), distinct from numeric tide/water-level IDs
- Up to 1 year per request; typed `date_range_exceeded`, `invalid_date_range`, `station_not_found`, and `no_predictions` errors

---

### `noaa_marine_get_conditions` <sub>tool</sub>

- Wave height/period/direction, wind speed/gust/direction, sea-surface and air temperature, dew point, barometric pressure
- All values SI except `tide_ft` (feet) and `visibility_nmi` (nautical miles), both rarely populated at offshore buoys
- Every sensor field is nullable — `null` when the buoy did not report, never a fabricated value
- Updated roughly every 10 minutes; typed `buoy_not_found` and `no_sensor_data` errors

---

### `noaa_marine_get_current_profile` <sub>tool</sub>

- Depth (m), direction (degrees true, flow-toward), and speed (cm/s) per bin, shallowest first
- Observed NDBC ADCP measurement — distinct from `noaa_marine_get_currents`, a CO-OPS tidal-current *prediction*
- Most NDBC stations serve no ADCP profile; use `find_stations` with `types: ["current_profile"]` to discover ones that do
- Direction or speed is `null` per bin when the sensor did not report that component; typed `profile_not_found` and `no_current_data` errors

---

### `noaa_marine_get_ocean_observations` <sub>tool</sub>

- Water temperature, conductivity, salinity, dissolved oxygen (% and ppm), chlorophyll, turbidity, pH, and redox potential per depth
- Water-column counterpart to `noaa_marine_get_conditions` (surface weather and sea state)
- Sensor coverage is sparse — most stations report only temperature and salinity; unreported values are `null`, never a fabricated zero
- No capability filter identifies ocean-sensor coverage — call on candidate `source="ndbc"` IDs and expect `observations_not_found` on stations with no `.ocean` file

---

### `noaa-marine://station/{station_id}` <sub>resource</sub>

- Station record as `application/json` — name, coordinates, source, capabilities, state, and (NDBC) platform class
- `station_id` comes from `noaa_marine_find_stations`
- Cached with a 6-hour TTL (`cacheHint`)

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

CO-OPS / NDBC-specific:

- In-memory station cache (6-hour TTL) for CO-OPS and NDBC station lists — discovery is fast after first startup
- CO-OPS and NDBC integrated in a unified station model — `find_stations` fans out across both sources in parallel
- NDBC fixed-width text parser normalizes `MM` (missing sensor data) to `null`, never passes it through as a string
- Paired water-level and prediction fetches for storm-surge residual computation
- CO-OPS `application=` courtesy parameter sent on every request (configurable via `NOAA_APPLICATION_ID`)

Agent-friendly output:

- Datum echoed on every tide/water-level response so agents state units and reference correctly without assumptions
- `total_found` on `find_stations` shows the count before the `limit` slice, so agents know whether to re-query
- All NDBC sensor fields explicitly nullable — agents don't fabricate missing readings
- Typed station `source` (`coops` | `ndbc`) plus a data-capability `type` and (NDBC only) a `platform` class — agents branch on data, not string parsing

## Getting started

No API key required. Both NOAA CO-OPS and NDBC are open, keyless data sources.

### Public Hosted Instance

Connect directly via Streamable HTTP — no install, no API key:

```json
{
  "mcpServers": {
    "noaa-marine": {
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
    "noaa-marine": {
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
    "noaa-marine": {
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
    "noaa-marine": {
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
- No external API keys needed — NOAA CO-OPS and NDBC are fully open.

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
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. The server declares `stateless` in `src/index.ts`; set this to override. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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
| `src/index.ts` | `createApp()` entry point — registers tools, resource, and initializes services. |
| `src/config/` | `NOAA_APPLICATION_ID` env var parsing with Zod. |
| `src/services/coops/` | CO-OPS Tides & Currents API client: station list cache, data fetch, error detection. |
| `src/services/ndbc/` | NDBC buoy service: active stations XML parser, realtime text parser. |
| `src/mcp-server/tools/` | Seven tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/` | Station metadata resource (`noaa-marine-station.resource.ts`). |
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
