<div align="center">
  <h1>@cyanheads/noaa-marine-mcp-server</h1>
  <p><b>Find NOAA tide stations and NDBC buoys, fetch tide predictions, water levels, tidal currents, and live buoy conditions via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.6.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/noaa-marine-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/noaa-marine-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/noaa-marine-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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
| `noaa_marine_get_water_level` | Observed water level at a 6-minute, hourly, high/low, or daily-mean cadence, paired with predictions and a storm-surge residual summary. |
| `noaa_marine_get_monthly_means` | Verified monthly tidal datums and extremes for a CO-OPS water-level station — the record for sea-level and tidal-range trends. |
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

- Filter by proximity (`latitude`/`longitude` + `radius_km`, default 100 km, max 1000 km), name/ID substring (matched against both sources; an exact ID match sorts first), US state/territory (CO-OPS only), source (`coops`/`ndbc`/`all`), or `types`: data capabilities (`tide`, `current`, `water_level`, `met`, `current_profile`, `water_quality`) or NDBC platform class (`buoy`)
- A CO-OPS station whose catalog rows carry no state code — every current station, and some tide and water-level stations — reports and filters on the state of the nearest state-bearing tide or water-level station within 25 km, marked `state_derived: true`; that state can be wrong on waters shared across a state or national border. A station with no such neighbor shows its own non-code catalog value (e.g. `FM`) if it publishes one, which no state filter matches
- Returns up to `limit` (default 20, max 200) unified stations with source, coordinates, distance, data capabilities, and — for NDBC — physical platform class (buoy, fixed, oilrig, dart, tao, usv, other)
- CO-OPS prediction stations also carry `prediction_class`, a third axis beside capability and platform: a tide station is `reference` (serving `hilo` and the 6-minute curve) or `subordinate` (`hilo` only, with `reference_id` naming where its offsets come from), while a current station reports its class per depth bin in `bins[]` alongside each bin's number and catalog depth in feet — the bin numbers `noaa_marine_get_currents` takes as `bin`
- `total_found` and `truncated` report the full match count before the limit is applied
- Zero matches is a success with `total_found: 0`, carrying a notice derived from the filters that were applied and an echo of the applied search
- A catalog that fails to load is reported as an unread source alongside the results; when every needed catalog fails, that is a typed `sources_unavailable` error rather than an empty search, whose recovery names the couple-of-minutes wait when the CO-OPS catalog was throttled
- Station lists are cached in-memory with a 6-hour TTL — first call after startup may be slightly slower
- Typed `incomplete_coordinates` error when only one of latitude/longitude is supplied

---

### `noaa_marine_get_tide_predictions` <sub>tool</sub>

- `hilo` (default, high/low events) or `6min` continuous curve; up to 1 year per request, with `begin_date`/`end_date` as `YYYYMMDD` or `YYYY-MM-DD`
- A range whose rows fit the response budget returns whole; a longer one returns the leading rows as a page, with `rows_matched`, `rows_returned`, `page_offset`, and `next_offset` on both consumption surfaces. Walk it with `offset`; `limit` lowers a page and never raises it past the byte bound, and an `offset` past the last row is an empty page rather than an error
- `6min` is served by reference stations only — a subordinate station's high and low events are offsets from a reference station and it has no 6-minute curve, so the request is refused before the upstream call as a typed `subordinate_no_6min` naming `hilo` and that reference station
- Ten datums, matching what the CO-OPS predictions product accepts: MLLW (default, US nautical chart), MHHW, MHW, MTL, MSL, MLW, DTL, NAVD (NAVD88, where the station has a tie), STND (the station's own datum), CRD (Columbia River only)
- A datum the station does not carry is a typed `datum_unavailable` naming the planes it does, not a report that the station ID was wrong; a Great Lakes station, which publishes no prediction series at any datum, is `no_predictions` pointing at `noaa_marine_get_water_level`
- Time zone (`lst_ldt` default, `gmt`, `lst`) and units (`english` default feet, `metric` meters)
- Typed `date_range_exceeded`, `invalid_date_range`, `station_not_found`, `no_predictions`, `datum_unavailable`, `subordinate_no_6min`, and `upstream_throttled` errors — the last a retryable `RateLimited` for the HTTP 403 CO-OPS answers a burst of requests with, whose recovery says to wait a couple of minutes

---

### `noaa_marine_get_water_level` <sub>tool</sub>

- `interval` selects the cadence: `6min` (default) the full curve, `hourly` hourly heights, `high_low` the observed high and low waters with their `H`/`HH`/`L`/`LL` classification, `daily_mean` the daily mean at Great Lakes stations only. The `interval` is echoed in the output
- `begin_date`/`end_date` as `YYYYMMDD` or `YYYY-MM-DD`. Per-interval CO-OPS range ceilings, rejected locally before the call: 31 days for `6min`, 365 for `hourly` and `high_low`, 3,655 for `daily_mean`. A coarser cadence is not automatically a smaller response — a year of `hourly` rows outweighs a month of 6-minute ones — so the ceiling bounds the request and the response budget bounds the page
- Quality flags (`p` preliminary, `v` verified) on `6min` only: CO-OPS sends no flag with the coarser products, and `quality` is omitted rather than defaulted to preliminary, which would label verified data unverified. Sensor `sigma` on `6min` and `hourly`
- Thirteen datums, matching what the CO-OPS water-level product accepts: MLLW (default, US nautical chart), MHHW, MHW, MTL, MSL, MLW, NAVD (NAVD88, where the station has a tie), STND (the station's own datum), IGLD and LWD (Great Lakes only), CRD (Columbia River only), LWI and HWI (lunitidal intervals)
- A datum the station does not carry is a typed `datum_unavailable` whose recovery names the planes that do read it — `STND`, `IGLD`, `LWD` at a Great Lakes station, `MLLW`/`STND` where an NAVD88 tie is missing — rather than sending the caller back to re-verify an ID `noaa_marine_find_stations` just returned
- A sensor outage leaves slots with no reading; they are dropped and counted in `gaps_dropped`, so `rows_matched` always counts only the slots that carried a value and continuous coverage across the range is only implied when that count is absent
- Paired tide predictions at the interval matching the observed cadence, fetched in parallel — the observed series returns either way, and `predictions_status` says whether an empty prediction series means CO-OPS has none or the fetch failed. Not fetched at all on `daily_mean`, which has no paired series
- `residual_summary` (max surge, max drawdown) only when both series are present, computed from the finite observed/predicted pairs across the whole matched series rather than the returned page. Each side clamps at zero, so a window that stayed above prediction reports `max_drawdown: 0` and one that stayed below reports `max_surge: 0`. Reported on `6min` and `hourly` only — observed high and low waters do not occur at the predicted extreme times, so a `high_low` join would rest on a small fraction of the events, and `daily_mean` has no paired series at all; the notice says which applies
- A range whose rows fit the response budget returns whole; a longer one returns the leading rows as a page, with `rows_matched`, `rows_returned`, `page_offset`, and `next_offset` on both consumption surfaces. Observations carry the `offset` and the paired predictions follow by time window, so a page's two series always describe one span even after gap rows shorten the observed one
- `daily_mean` is requested in local standard time whatever `time_zone` was passed — CO-OPS serves that product in LST only and silently shifts any other zone by a day
- Typed `date_range_exceeded`, `invalid_date_range`, `station_not_found`, `no_data`, `datum_unavailable`, `great_lakes_only` (`daily_mean` at a coastal station), `verified_data_lag`, and `upstream_throttled` errors — `verified_data_lag` for an `hourly`, `high_low`, or `daily_mean` window ending on or after the first day of the prior month, which CO-OPS may not have verified yet since it verifies the coarser products monthly for the prior month (an earlier window it answers the same way is `no_data`, since waiting cannot help it), and `upstream_throttled` for the HTTP 403 CO-OPS answers a burst of requests with (a 403 on the paired prediction fetch alone leaves `predictions_status: "unavailable"` instead, with a notice naming the wait)

---

### `noaa_marine_get_monthly_means` <sub>tool</sub>

- One row per station-month of the CO-OPS `monthly_mean` product: the month's `highest` and `lowest` water, its tidal datums (`mhhw`, `mhw`, `msl`, `mtl`, `mlw`, `mllw`, `dtl`), ranges (`gt`, `mn`, `dhq`, `dlq`), lunitidal intervals in hours (`hwi`, `lwi`), and CO-OPS's `inferred` code passed through verbatim — a code (`0`, `1`, `11` observed), not a boolean
- Heights are relative to the requested datum — eleven reference planes: MLLW (default), MHHW, MHW, MTL, MSL, MLW, NAVD, STND, IGLD and LWD (Great Lakes only), CRD (Columbia River only) — in `english` feet or `metric` meters. The ranges (`gt`, `mn`, `dhq`, `dlq`) are differences between two planes, so they read the same under every datum. A value CO-OPS publishes as an empty string is omitted, never zeroed — a Great Lakes station at `IGLD` carries only `highest`, `msl`, and `lowest`
- `begin_date`/`end_date` as `YYYYMMDD` or `YYYY-MM-DD`, spanning up to 73,000 days (the ceiling CO-OPS names), rejected locally before the call. The months the two dates fall in are the first and last returned; CO-OPS answers one month past `end_date`, and that month is dropped
- A range whose months fit the response budget returns whole; a longer one — decades of months — returns the leading months as a page with `rows_matched`, `rows_returned`, `page_offset`, and `next_offset`. Walk it with `offset`; an `offset` past the last month is an empty page rather than an error
- Typed `invalid_date_range`, `date_range_exceeded`, `station_not_found`, `datum_unavailable`, `verified_data_lag`, `no_data`, and `upstream_throttled` errors. CO-OPS answers an unpublished window with one sentence whatever the cause, so a window ending on or after the first day of the prior month is `verified_data_lag` and any earlier one is `no_data`
- Returns the monthly record, not a trend — fitting one is left to the caller

---

### `noaa_marine_get_currents` <sub>tool</sub>

- `MAX_SLACK` (default): max flood, max ebb, and slack events only — the actionable view for passage planning
- `6min`: continuous current curve, each row carrying its own `flood`/`ebb`/`slack` sense plus the station mean flood or ebb bearing that sense implies (a station constant, not an instantaneous heading)
- Both intervals are bounded by response size: a range whose rows fit the response budget returns whole; a longer one returns the leading rows as a page, with `rows_matched`, `rows_returned`, `page_offset`, and `next_offset` on both surfaces. `offset` and `limit` walk whichever series the interval selects — the max/slack events or the 6-minute curve
- Units `english` (knots for speed, feet for the echoed depth, default) or `metric` (cm/s for speed, meters for depth) — CO-OPS publishes metric current speed in cm/s, the unit `noaa_marine_get_current_profile` also reports
- `bin` selects one of a station's depth bins; omit it for the CO-OPS default, the shallowest. The bin CO-OPS answered with and its depth are echoed on every response, and a bin the station does not publish is a typed `bin_unavailable` naming the bins it does
- A station whose currents CO-OPS will not predict as discrete events returns an empty list plus CO-OPS's own wording in the notice, not an error
- Current station IDs are alphanumeric (e.g. `ACT4176`), distinct from numeric tide/water-level IDs
- Up to 1 year per request, with `begin_date`/`end_date` as `YYYYMMDD` or `YYYY-MM-DD`; typed `date_range_exceeded`, `invalid_date_range`, `station_not_found`, `no_predictions`, `predictions_unavailable`, `bin_unavailable`, and `upstream_throttled` (the HTTP 403 CO-OPS answers a burst of requests with) errors

---

### `noaa_marine_get_conditions` <sub>tool</sub>

- Wave height/period/direction, wind speed/gust/direction, sea-surface and air temperature, dew point, barometric pressure
- All values SI except `tide_ft` (feet) and `visibility_nmi` (nautical miles), both rarely populated at offshore buoys
- Every sensor field is nullable — `null` when the buoy did not report, never a fabricated value. `latitude`/`longitude` are `null` for a station absent from the NDBC catalog, and `observed_at` is always a valid instant
- NDBC writes each block of columns on its own cycle, so a block resolves from the most recent row within 90 minutes that carried it: waves report their own `waves_observed_at`, and any other block read from an earlier row is named with its measurement time in the response notice. Row cadence runs 5–60 minutes depending on the station
- Typed `buoy_not_found` and `no_sensor_data` errors

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
- Find candidates with `find_stations` using `source="ndbc"` and `types: ["water_quality"]`, NDBC's own water-quality catalog flag — a strong hint, not a guarantee, so expect `observations_not_found` on a flagged station serving no `.ocean` file

---

### `noaa-marine://station/{station_id}` <sub>resource</sub>

- Station record as `application/json` — name, coordinates, source, capabilities, state (with `state_derived`, resolved as on `noaa_marine_find_stations`), the CO-OPS `prediction_class` (with `reference_id` or per-bin `bins[]`, exactly as on `noaa_marine_find_stations`), and (NDBC) platform class
- `station_id` comes from `noaa_marine_find_stations`
- Typed `station_not_found` when both catalogs were read and neither carries the ID, and `source_unavailable` when a catalog could not be read — a station only the unread catalog carries is never reported as nonexistent. When the unread CO-OPS catalog was throttled (HTTP 403), the recovery names the couple-of-minutes wait
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
| `src/mcp-server/tools/` | Eight tool definitions (`*.tool.ts`). |
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
