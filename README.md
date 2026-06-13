<div align="center">
  <h1>@cyanheads/noaa-marine-mcp-server</h1>
  <p><b>Find NOAA tide stations and NDBC buoys, fetch tide predictions, water levels, tidal currents, and live buoy conditions via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/noaa-marine-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/noaa-marine-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/noaa-marine-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/noaa-marine-mcp-server/releases/latest/download/noaa-marine-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=noaa-marine-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbm9hYS1tYXJpbmUtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22noaa-marine-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fnoaa-marine-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://noaa-marine.caseyjhand.com/mcp](https://noaa-marine.caseyjhand.com/mcp)

</div>

---

## Tools

Five tools covering the full US marine operational workflow — station discovery, tide predictions, observed water levels, tidal current predictions, and live offshore buoy conditions:

| Tool | Description |
|:-----|:------------|
| `noaa_marine_find_stations` | Find CO-OPS tide/water-level/current stations and NDBC buoys near a location or by name/state. Required first step to resolve place names or coordinates to station IDs. |
| `noaa_marine_get_tide_predictions` | High/low tide predictions for a CO-OPS tide station over a date range. Supports 6-minute interval output and multiple datums (defaults to MLLW — US nautical chart standard). |
| `noaa_marine_get_water_level` | Observed water level (real-time or historical) for a CO-OPS station, paired with predictions to compute storm surge or anomalous drawdown. |
| `noaa_marine_get_currents` | Tidal current predictions for a CO-OPS current station: max flood/ebb speeds, slack times, and directions. Defaults to MAX_SLACK (practical passage-planning view). |
| `noaa_marine_get_conditions` | Live marine conditions from an NDBC buoy: wave height/period/direction, wind, sea-surface temp, air temp, and barometric pressure. |

### `noaa_marine_find_stations`

Unified station discovery across CO-OPS (3,450+ tide/water-level stations, 4,430+ current stations) and NDBC (1,354+ active buoys worldwide).

- Filter by proximity (latitude/longitude + radius), name substring, state/territory, source (CO-OPS vs NDBC), or type (tide, current, water_level, buoy, met)
- Returns unified station list with source, type, capabilities, coordinates, and distance
- Station lists are cached in-memory (6-hour TTL) — first call after startup may be slightly slower
- Required first step: CO-OPS and NDBC use non-overlapping ID systems; guessing a station ID reliably fails

---

### `noaa_marine_get_tide_predictions`

CO-OPS MLLW tide predictions for planning tidal windows.

- High/low events (default) or 6-minute continuous curve
- Eight datums: MLLW (default, US nautical chart), MHHW, MSL, MTL, MHW, MLW, CD, STND
- Time zone options: local standard/daylight (default), GMT, local standard only
- Units: English (feet, default) or metric (meters)
- Maximum date range: 1 year per request (typed error `date_range_exceeded` for longer ranges)

---

### `noaa_marine_get_water_level`

Observed water level vs. predicted — the storm surge view.

- 6-minute observed water level readings with quality flags
- Paired tide predictions fetched in parallel (failure degrades gracefully — observed levels still returned)
- Optional residual summary: max surge and max drawdown when both series are present
- Maximum date range: 31 days per request for 6-minute data

---

### `noaa_marine_get_currents`

CO-OPS tidal current predictions for passage planning.

- MAX_SLACK interval (default): max flood, max ebb, and slack events only — the actionable view for transiting inlets and channels
- 6-minute interval: full continuous current curve for charting or integration
- Current station IDs use alphanumeric format (e.g., `ACT4176`), distinct from numeric tide station IDs — use `find_stations` with `types: ["current"]` to discover them

---

### `noaa_marine_get_conditions`

Live NDBC buoy observations (most recent ~45 days, updated every 10 minutes).

- Wave height (m), dominant and average period (sec), mean wave direction
- Wind speed and gust (m/s), wind direction
- Sea-surface temperature, air temperature, dew point (°C)
- Barometric pressure (hPa)
- All sensor fields nullable (`null` when buoy sensor did not report — normal for offshore buoys)
- All values in SI units except `TIDE` (feet) and `VIS` (nautical miles), which are rarely populated at offshore buoys

## Resources and prompts

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `noaa-marine://station/{station_id}` | Metadata for a CO-OPS or NDBC station by ID: name, coordinates, source, capabilities, and state. |

All resource data is also reachable via tools. Use `noaa_marine_find_stations` to discover station IDs before accessing the resource.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats with typed error contracts
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports
- Pluggable auth: `none`, `jwt`, `oauth`

NOAA-specific:

- In-memory station cache (6-hour TTL) for CO-OPS and NDBC station lists — discovery is fast after first startup
- CO-OPS and NDBC integrated in a unified station model — `find_stations` fans out across both sources in parallel
- NDBC fixed-width text parser: `MM` (missing sensor data) normalized to `null`, not passed through as strings
- Paired water-level + prediction fetches for storm surge residual computation
- CO-OPS `application=` courtesy parameter sent on every request (configurable via `NOAA_APPLICATION_ID`)

Agent-friendly output:

- Datum echoed on every tide/water-level response — agents can state units and reference correctly without assumptions
- `total_found` on `find_stations` shows count before `limit` slice so agents know whether to re-query
- All NDBC sensor fields explicitly nullable with per-field unit documentation — agents don't fabricate missing readings
- Typed station source (`coops` | `ndbc`) and type fields on every station record — agents can branch on data, not string parsing

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

### Self-hosted / local

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

- [Bun v1.3.11](https://bun.sh/) or higher (or Node.js v24+).
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
| `src/mcp-server/tools/` | Five tool definitions (`*.tool.ts`). |
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
