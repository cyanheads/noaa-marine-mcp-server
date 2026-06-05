# noaa-marine-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `noaa_marine_find_stations` | Find CO-OPS tide/water-level/current stations and NDBC buoys near a location or by name/state. Returns unified station list with source, type, capabilities, and coordinates. Required first step to resolve place names or coordinates to station IDs before calling data tools. | `latitude`, `longitude`, `radius_km`, `query` (name search), `state` (`z.enum` of 2-letter state/territory codes), `source` (`z.enum(['coops', 'ndbc', 'all'])`), `types` (`z.array(z.enum(['tide', 'current', 'water_level', 'buoy', 'met']))`), `limit` | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_marine_get_tide_predictions` | High/low tide predictions for a CO-OPS tide station over a date range. Returns time, height, and tide type (H/L) for each event. Supports 6-minute interval output for detailed tide curves. Datum defaults to MLLW (mean lower low water — standard for US nautical charts). | `station_id`, `begin_date` (YYYYMMDD), `end_date` (YYYYMMDD), `datum` (`z.enum(['MLLW', 'MHHW', 'MSL', 'MTL', 'MHW', 'MLW', 'CD', 'STND'])`, default `'MLLW'`), `time_zone` (`z.enum(['lst_ldt', 'gmt', 'lst'])`, default `'lst_ldt'`), `units` (`z.enum(['english', 'metric'])`, default `'english'`), `interval` (`z.enum(['hilo', '6min'])`, default `'hilo'`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `noaa_marine_get_water_level` | Observed water level (real-time or historical) for a CO-OPS water-level station, with the predicted value for comparison. The difference (residual) indicates storm surge or anomalous drawdown. Returns 6-minute observations alongside predictions. Date range max 31 days per request. | `station_id`, `begin_date` (YYYYMMDD), `end_date` (YYYYMMDD), `datum` (`z.enum(['MLLW', 'MHHW', 'MSL', 'MTL', 'MHW', 'MLW', 'CD', 'STND'])`, default `'MLLW'`), `time_zone` (`z.enum(['lst_ldt', 'gmt', 'lst'])`, default `'lst_ldt'`), `units` (`z.enum(['english', 'metric'])`, default `'english'`) | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_marine_get_currents` | Tidal current predictions for a CO-OPS current station: max flood/ebb speeds, slack times, and directions. Defaults to MAX_SLACK intervals (the practical planning view — when to pass a tricky passage). Optionally returns 6-minute continuous predictions. Station IDs for current stations use alphanumeric format (e.g., `ACT4176`), distinct from numeric tide/water-level IDs. | `station_id`, `begin_date` (YYYYMMDD), `end_date` (YYYYMMDD), `time_zone` (`z.enum(['lst_ldt', 'gmt', 'lst'])`, default `'lst_ldt'`), `units` (`z.enum(['english', 'metric'])`, default `'english'`), `interval` (`z.enum(['MAX_SLACK', '6min'])`, default `'MAX_SLACK'`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `noaa_marine_get_conditions` | Live marine conditions from a NDBC buoy: wave height/period/direction, wind speed/gust/direction, sea-surface temp, air temp, barometric pressure, and dew point. Numeric fields are `null` when the buoy sensor did not report a value for that observation period (MM in the source data) — normal for offshore buoys. All values are SI (m/s, m, hPa, °C) except TIDE (ft) and VIS (nmi), which are rarely populated at offshore buoys. | `station_id` | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `noaa-marine://station/{station_id}` | Metadata for a CO-OPS or NDBC station by ID: name, coordinates, source, capabilities, datum reference, time zone, state. | No |

### Output Schemas

Key fields per tool — implementer must include these in the Zod `output` schema and `format()` text. Chaining IDs and metadata echoes are required for both surfaces.

**`noaa_marine_find_stations`**
- `stations[]`: `{ station_id: string, name: string, source: 'coops'|'ndbc', type: string, latitude: number, longitude: number, distance_km?: number, state?: string, capabilities: string[] }`
- `total_found: number` — count before `limit` slice (so agent knows if results were truncated)

**`noaa_marine_get_tide_predictions`**
- `station_id: string`, `station_name: string` — echo for chaining and display
- `datum: string` — must echo the datum used (MLLW etc.) so the agent can state it correctly
- `units: string` — echo units
- `predictions[]`: `{ time: string, height: number, type: 'H'|'L' }` (for hilo); or `{ time: string, height: number }` (for 6min)

**`noaa_marine_get_water_level`**
- `station_id: string`, `station_name: string`, `datum: string`, `units: string` — echoed
- `observations[]`: `{ time: string, value: number, sigma?: number, quality: string }`
- `predictions[]`: `{ time: string, value: number }` — paired predictions (may be empty if predictions fetch failed; degrade gracefully)
- `residual_summary?: { max_surge_ft: number, max_drawdown_ft: number }` — optional computed summary when both series are present

**`noaa_marine_get_currents`**
- `station_id: string`, `station_name: string`, `units: string` — echoed
- For MAX_SLACK: `events[]`: `{ time: string, type: 'flood'|'ebb'|'slack', speed?: number, direction?: number }`
- For 6min: `predictions[]`: `{ time: string, speed: number, direction: number }`

**`noaa_marine_get_conditions`**
- `station_id: string`, `station_name: string`, `latitude: number`, `longitude: number`
- `observed_at: string` — ISO timestamp of the observation row used
- All sensor fields optional/nullable (`number | null`): `wind_direction_deg`, `wind_speed_ms`, `gust_speed_ms`, `wave_height_m`, `dominant_period_sec`, `average_period_sec`, `mean_wave_direction_deg`, `pressure_hpa`, `air_temp_c`, `water_temp_c`, `dew_point_c`, `visibility_nmi`, `tide_ft`
- `source: 'ndbc'` — always ndbc for v0.1.0

### Error Contracts

Typed domain failures the implementer must enumerate in each tool's `errors: [...]` block. Baseline infrastructure errors (`ServiceUnavailable`, `Timeout`, `ValidationError`, `InternalError`) bubble freely and don't need declaring.

| Tool | reason | code | when |
|:-----|:-------|:-----|:-----|
| `noaa_marine_find_stations` | `no_results` | `NotFound` | No stations match the query/location/filters — agent should widen the search or try a different state/type |
| `noaa_marine_get_tide_predictions` | `station_not_found` | `InvalidParams` | CO-OPS returned an error for the station ID (likely wrong type — use a `find_stations` result) |
| `noaa_marine_get_tide_predictions` | `date_range_exceeded` | `InvalidParams` | Requested range exceeds 1-year CO-OPS limit — split into multiple calls |
| `noaa_marine_get_tide_predictions` | `no_predictions` | `NotFound` | Station exists but CO-OPS returned no prediction data for the date range (station inactive or type mismatch) |
| `noaa_marine_get_water_level` | `station_not_found` | `InvalidParams` | CO-OPS returned an error for the station ID |
| `noaa_marine_get_water_level` | `date_range_exceeded` | `InvalidParams` | Requested range exceeds 31-day CO-OPS limit for 6-minute data — split into multiple calls |
| `noaa_marine_get_water_level` | `no_data` | `NotFound` | Station exists but no observed water-level data for the date range (station may be offline) |
| `noaa_marine_get_currents` | `station_not_found` | `InvalidParams` | CO-OPS returned an error for the station ID (current stations require alphanumeric IDs like `ACT4176`) |
| `noaa_marine_get_currents` | `date_range_exceeded` | `InvalidParams` | Requested range exceeds 1-year CO-OPS limit — split into multiple calls |
| `noaa_marine_get_currents` | `no_predictions` | `NotFound` | Station exists but CO-OPS returned no current-prediction data for the date range |
| `noaa_marine_get_conditions` | `buoy_not_found` | `NotFound` | NDBC returned 404 for the station ID — verify ID with `find_stations` |
| `noaa_marine_get_conditions` | `no_sensor_data` | `NotFound` | Buoy file exists but all fields are MM (buoy offline or sensor failure) |

### Prompts

None — this server is data-oriented; no recurring interaction patterns warrant a prompt template.

---

## Overview

US marine conditions via two NOAA sources: **CO-OPS** (Center for Operational Oceanographic Products and Services) for tide predictions, observed water levels, tidal currents, and coastal met data at 3,450+ stations; **NDBC** (National Data Buoy Center) for live offshore buoy observations (waves, wind, sea-surface temp, pressure) at 1,354 active stations worldwide.

Target audience: boaters, sailors, surfers, anglers, kayakers, coastal planners, and agents answering questions like "when is high tide at Seattle this week?", "what's the swell offshore Monterey?", "how much storm surge did last night's storm produce?", or "are the currents safe to transit Admiralty Inlet right now?"

The server is scoped to the ocean operational workflow — tides, currents, and buoy conditions. Atmospheric forecast (NWS), historical climate (noaa-cdo), and solar conditions (noaa-spaceweather) are separate servers that compose with this one.

---

## Requirements

- **No authentication.** CO-OPS asks for an `application` query param as a courtesy identifier (not auth); NDBC is fully open.
- **US + territories coverage.** CO-OPS is strictly US coastal; NDBC includes international partner buoys but the primary set is US/offshore. Scope is stated in the server instructions.
- **Read-only.** All tools are `readOnlyHint: true` — no writes to any NOAA system.
- **Datum handling is mandatory.** Returning water levels without a stated datum is meaningless — all tools default to MLLW and expose the datum in the response so agents can reason correctly.
- **MM = missing.** NDBC fixed-width files use `MM` for missing sensor values. These must be normalized to `null` in the output, not passed through as strings.
- **Currents use different station IDs.** CO-OPS current stations have alphanumeric IDs (e.g., `ACT4176`) distinct from the numeric tide/water-level station IDs (e.g., `9447130`). Station discovery must surface both types clearly.
- **Station metadata size.** CO-OPS `tidepredictions` has 3,450 stations; `waterlevels` has 301; `currentpredictions` has 4,430. NDBC active has 1,354. The station lists are bounded — mirroring is warranted for `find_stations` (see Services).

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `CoopsService` | CO-OPS Tides & Currents API (data endpoint + mdapi metadata) | `noaa_marine_find_stations`, `noaa_marine_get_tide_predictions`, `noaa_marine_get_water_level`, `noaa_marine_get_currents` |
| `NdbcService` | NDBC realtime2 text files + activestations.xml | `noaa_marine_find_stations`, `noaa_marine_get_conditions` |

Both services are init/accessor pattern (`initCoopsService(config)` / `getCoopsService()`), initialized in `createApp({ setup })`.

### CoopsService

Wraps two CO-OPS base URLs:
- **Data:** `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` — parametric query for products (predictions, water_level, currents_predictions, water_temperature, wind, air_pressure)
- **Metadata:** `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json` — station lists by type + single-station detail

Station list fetching is the expensive operation (3,450–4,430 records per type). Use an in-memory cache with a 6-hour TTL so `find_stations` calls don't re-fetch on every request. Cache keyed by station type. On startup, pre-warm the two most-used types (tidepredictions, currentpredictions).

The `application` courtesy param is sent on every request: `application=noaa-marine-mcp-server`.

CO-OPS error shape: `{ "error": { "message": "..." } }` — detected by presence of the `error` key in the JSON response.

### NdbcService

Wraps two NDBC endpoints:
- **Active stations:** `https://www.ndbc.noaa.gov/activestations.xml` — XML, parsed once and cached (6-hour TTL). 1,354 stations with id, lat, lon, name, type, owner, met/currents/waterquality/dart flags.
- **Realtime observations:** `https://www.ndbc.noaa.gov/data/realtime2/{stationId}.txt` — fixed-width text, per-buoy, fetched on demand.

**NDBC fixed-width parsing** (verified against live data):
- Line 1: `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE`
- Line 2: units row (`#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft`)
- Lines 3+: space-separated data, most recent first. `MM` = missing sensor data.
- Parser: split header cols from line 1, split data rows, zip and coerce. Numeric coercion maps `MM` → `null`. Return the most recent complete-ish observation (first non-header row).
- Key fields: `WDIR` (wind direction °T), `WSPD` (wind speed m/s), `GST` (gust m/s), `WVHT` (wave height m), `DPD` (dominant period sec), `APD` (average period sec), `MWD` (mean wave direction °T), `PRES` (pressure hPa), `ATMP` (air temp °C), `WTMP` (water temp °C), `DEWP` (dew point °C).
- Most NDBC observations are SI (m/s, m, hPa, °C). **Exceptions:** `TIDE` is in feet and `VIS` is in nautical miles — document both in the output schema. NDBC doesn't support unit switching, so these exceptions are fixed.

**Resilience:** `withRetry` wraps both service methods. CO-OPS data fetches: 3 retries, 1s base delay. Station list fetches: 2 retries, 2s base. NDBC realtime: 2 retries, 1s base (missing buoy files return 404, not retried). Parse HTML error pages as transient (not `SerializationError`).

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `NOAA_APPLICATION_ID` | No | Courtesy identifier sent as `application=` on CO-OPS requests. Defaults to `noaa-marine-mcp-server` if not set. |

No API keys are required. Both sources are open/keyless.

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with `NOAA_APPLICATION_ID` (optional, default value set).
2. **CoopsService** — init/accessor, station list cache, data fetching, CO-OPS error detection.
3. **NdbcService** — init/accessor, XML parsing for active stations, fixed-width text parser for realtime files.
4. **`noaa_marine_find_stations`** — multi-source station discovery (searches both caches, computes distance, returns unified list).
5. **`noaa_marine_get_tide_predictions`** — CO-OPS predictions product, hilo default.
6. **`noaa_marine_get_water_level`** — CO-OPS water_level product with paired predictions fetch.
7. **`noaa_marine_get_currents`** — CO-OPS currents_predictions product.
8. **`noaa_marine_get_conditions`** — NDBC realtime text parse (primary), CO-OPS met (secondary, not yet wired — nice-to-have).
9. **Station resource** — `noaa-marine://station/{station_id}`, reads from cached station lists.
10. **Tests** — one test per tool + NDBC text parser unit test.

Each step is independently testable.

---

## Workflow Analysis

### `noaa_marine_find_stations` (multi-source fan-out)

| # | Operation | Source | Notes |
|:--|:----------|:-------|:------|
| 1 | Fetch/read CO-OPS station list cache | CoopsService | Pre-warmed on init; cache miss fetches mdapi |
| 2 | Fetch/read NDBC active station cache | NdbcService | Pre-warmed on init; cache miss fetches XML |
| 1+2 | Steps 1 and 2 run in parallel via `Promise.allSettled` | — | One source failing doesn't tank the call |
| 3 | Filter by query, state, type, source | In-process | Token match on name; state exact match |
| 4 | Compute haversine distance if lat/lon provided | In-process | Sort by distance; apply radius filter |
| 5 | Deduplicate (no overlap between CO-OPS and NDBC IDs) | In-process | — |
| 6 | Slice to `limit` (default 20) | In-process | — |

### `noaa_marine_get_water_level` (parallel companion fetch)

| # | Operation | Purpose |
|:--|:----------|:--------|
| 1 | Fetch `water_level` product (observed) | Primary data |
| 2 | Fetch `predictions` product (6-min interval, same date range) | Comparison baseline |
| 1+2 | Parallel via `Promise.allSettled` | prediction fetch failure degrades gracefully — observed levels still returned |

---

## Design Decisions

**`noaa_marine_find_stations` as required first step, not optional.** CO-OPS and NDBC use different, non-overlapping ID systems. If an agent guesses a station ID or confuses a tide station ID for a current station ID, the data call fails with a cryptic NOAA error. Surfacing discovery as the explicit first tool — and making it fast via caching — keeps the downstream tools simple (they accept an ID, not a lat/lon).

**MLLW as default datum, not MHHW or MSL.** MLLW (mean lower low water) is the US nautical chart datum, the basis for published chart depths, and the reference mariners expect. Returning water heights relative to MLLW means the chart reads correctly. MSL is common in atmospheric science but wrong for tide tables. MHHW is used for flooding/inundation work. All are valid options but MLLW is the default because it's right for the primary audience.

**CO-OPS station list in-memory cache (6-hour TTL).** The station lists are large (3,450–4,430 stations) and change rarely (NOAA adds/removes stations monthly at most). Fetching the full list on every `find_stations` call would make discovery slow and impose unnecessary load on NOAA. An in-memory cache with 6-hour TTL is a good fit: no SQLite dependency, no cross-session persistence needed, predictable memory (each list is roughly 2–4 MB JSON).

**Currents use `MAX_SLACK` interval by default.** The raw 6-minute current data is primarily useful for charting or integrating total flow. For passage planning — "is there a slack window to run the inlet?" — the MAX_SLACK interval (which returns only max flood, max ebb, and slack events) is far more actionable. Agents that need the full curve can pass `interval: "6min"`.

**NDBC observations are SI units with two exceptions.** NDBC realtime text files emit metric (m/s, m, hPa, °C) for most fields. Exceptions: `TIDE` is in feet, `VIS` is in nautical miles — both are rarely populated at offshore buoys and will typically be `null`. There is no unit switching at the NDBC layer. The output schema documents units per-field so agents know wave heights are in meters, wind is in m/s, etc., regardless of what `units` they'd set for CO-OPS tools.

**`get_conditions` is NDBC-only (v0.1.0).** CO-OPS met (wind, air pressure, water temperature) is available at about 150 stations but requires co-location detection to match CO-OPS station IDs against NDBC buoy IDs. For v0.1.0, the tool accepts a single `station_id` and routes to NDBC only — the `source` parameter is omitted to avoid exposing a half-implemented CO-OPS path. CO-OPS met enrichment can be added in a later iteration once co-location logic is implemented.

**`water_level` fetches paired predictions.** The raw water level number alone is only half the picture — it means little without the predicted value for the same time. The residual (observed − predicted) is the storm surge or drawdown. Fetching both in parallel and returning them together lets the agent give a complete answer without requiring a second tool call.

**No prompt.** The server is purely data-oriented. The use cases (tide table, water level, conditions) are straightforward enough that agents can compose an answer directly from the tool outputs without a reusable message template.

---

## Known Limitations

- **CO-OPS date range limits:** `get_tide_predictions` and `get_currents` max 1 year per request; `get_water_level` max 31 days (6-minute data). Enforced by input validation in each tool (`date_range_exceeded` typed error); agents must split longer ranges across multiple calls.
- **NDBC realtime lag:** observations are reported every 10 minutes; the most recent data point can be up to 10–20 minutes old when fetched. Not a real-time streaming feed.
- **CO-OPS currents predictions are not available everywhere.** The 4,430 current stations cover major US passages, channels, and harbors — not every waterway. Agents should use `find_stations` with `types: ["current"]` to verify coverage before calling `get_currents`.
- **Global wave forecast:** NDBC covers US coastal/offshore waters primarily. For global wave forecast at any coordinate, `open-meteo`'s marine tool is the right complement.
- **No historical NDBC data.** The `realtime2` files contain only the most recent ~45 days. For historical buoy data, NDBC's archive API (not implemented here) would be needed.

---

## API Reference

### CO-OPS Data Endpoint

`GET https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`

Required params: `station`, `product`, `begin_date` (YYYYMMDD), `end_date` (YYYYMMDD), `format=json`, `application`.

Products used:
- `predictions` — tide or 6-min predictions; also requires `datum`, `time_zone`, `units`, `interval` (hilo|6min)
- `water_level` — observed water level; also requires `datum`, `time_zone`, `units`
- `currents_predictions` — current speed/direction; also requires `time_zone`, `units`, `interval` (MAX_SLACK|6min)

Response envelope: `{ "predictions": [...] }` / `{ "data": [...] }` / `{ "current_predictions": { "cp": [...] } }`. Error: `{ "error": { "message": "..." } }`.

Water level data fields: `t` (ISO datetime), `v` (value ft), `s` (sigma/stdev), `f` (flags), `q` (quality: p=preliminary, v=verified).

### CO-OPS Metadata API

`GET https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type={type}`

Types: `tidepredictions`, `currentpredictions`, `waterlevels`. Station fields: `id`, `name`, `lat`, `lng`, `state`, `type` (R=reference/T=subordinate/S=secondary for tide; ACT-prefix for currents). Reference stations (`type: "R"`) have full harmonic analysis; subordinate/secondary stations derive from a reference via offsets.

### NDBC Fixed-Width Text Format

`GET https://www.ndbc.noaa.gov/data/realtime2/{stationId}.txt`

- Line 1: `#` + space-separated column names
- Line 2: `#` + units row
- Lines 3+: data rows, most recent first, 10-minute observations
- `MM` = missing/not-applicable sensor value
- Columns: `YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE`
- All numeric values in SI (m/s, m, hPa, °C) except TIDE (feet) and VIS (nautical miles)
