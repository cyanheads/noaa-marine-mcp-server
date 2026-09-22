# noaa-marine-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `noaa_marine_find_stations` | Find CO-OPS tide/water-level/current stations and NDBC buoys near a location or by name/ID/state. Returns unified station list with source, type, capabilities, platform class, coordinates, and — for CO-OPS prediction stations — the catalog prediction class (on the row for tide stations, per depth bin in `bins[]` for current stations). Required first step to resolve place names, coordinates, or a bare station number to station IDs before calling data tools. A station whose catalog rows carry no state code — every current station — reports and filters on the state of the nearest state-bearing tide or water-level station within 25 km, marked `state_derived: true`. A zero-match search is a success carrying an applied-filter echo, not an error. | `latitude`, `longitude`, `radius_km`, `query` (name or station-ID substring, both sources), `state` (`z.enum` of 2-letter state/territory codes, matched against the resolved state), `source` (`z.enum(['coops', 'ndbc', 'all'])`), `types` (`z.array(z.enum(['tide', 'current', 'water_level', 'met', 'current_profile', 'water_quality', 'buoy']))`), `limit` | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_marine_get_tide_predictions` | High/low tide predictions for a CO-OPS tide station over a date range. Returns time, height, and tide type (H/L) for each event. Supports 6-minute interval output for detailed tide curves, which only reference stations publish — a subordinate station's `6min` request is refused before the upstream call. Datum defaults to MLLW (mean lower low water — standard for US nautical charts) and the enum is scoped to what the `predictions` product accepts, which is not the same set the `water_level` product accepts. A range whose rows fit the response budget returns whole; a longer one returns a byte-bounded page walked by `offset`. | `station_id`, `begin_date` (`YYYYMMDD` or `YYYY-MM-DD`), `end_date` (`YYYYMMDD` or `YYYY-MM-DD`), `datum` (`z.enum(['MLLW', 'MHHW', 'MHW', 'MTL', 'MSL', 'MLW', 'DTL', 'NAVD', 'STND', 'CRD'])`, default `'MLLW'`), `time_zone` (`z.enum(['lst_ldt', 'gmt', 'lst'])`, default `'lst_ldt'`), `units` (`z.enum(['english', 'metric'])`, default `'english'`), `interval` (`z.enum(['hilo', '6min'])`, default `'hilo'`), `offset` (`z.number().int().min(0)`, default `0`), `limit` (`z.number().int().min(1).optional()`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `noaa_marine_get_water_level` | Observed water level (real-time or historical) for a CO-OPS water-level station, with the predicted value for comparison. The difference (residual) indicates storm surge or anomalous drawdown. `interval` selects the CO-OPS product and its cadence: `6min` → `water_level` (31 days), `hourly` → `hourly_height` (365 days), `high_low` → `high_low` (365 days), `daily_mean` → `daily_mean` (3,655 days, Great Lakes stations only). Each is paired with the prediction interval matching its cadence except `daily_mean`, which has none; only `6min` and `hourly` report a residual, since observed extremes do not fall on predicted extreme times. Slots a sensor outage left empty are dropped and counted, and the returned rows are a byte-bounded page walked by `offset`. The datum enum is scoped to what the `water_level` product accepts, which includes the lunitidal intervals and the Great Lakes planes the `predictions` product rejects. | `station_id`, `begin_date` (`YYYYMMDD` or `YYYY-MM-DD`), `end_date` (`YYYYMMDD` or `YYYY-MM-DD`), `datum` (`z.enum(['MLLW', 'MHHW', 'MHW', 'MTL', 'MSL', 'MLW', 'NAVD', 'STND', 'IGLD', 'LWD', 'CRD', 'LWI', 'HWI'])`, default `'MLLW'`), `time_zone` (`z.enum(['lst_ldt', 'gmt', 'lst'])`, default `'lst_ldt'`; forced to `lst` on `daily_mean`), `units` (`z.enum(['english', 'metric'])`, default `'english'`), `interval` (`z.enum(['6min', 'hourly', 'high_low', 'daily_mean'])`, default `'6min'`), `offset` (`z.number().int().min(0)`, default `0`), `limit` (`z.number().int().min(1).optional()`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `noaa_marine_get_currents` | Tidal current predictions for a CO-OPS current station: max flood/ebb speeds, slack times, and directions. Defaults to MAX_SLACK intervals (the practical planning view — when to pass a tricky passage). Optionally returns 6-minute continuous predictions. Both intervals return a byte-bounded page walked by `offset`, so a range that fits comes back whole and a longer one discloses what it left behind. Station IDs for current stations use alphanumeric format (e.g., `ACT4176`), distinct from numeric tide/water-level IDs. | `station_id`, `begin_date` (`YYYYMMDD` or `YYYY-MM-DD`), `end_date` (`YYYYMMDD` or `YYYY-MM-DD`), `time_zone` (`z.enum(['lst_ldt', 'gmt', 'lst'])`, default `'lst_ldt'`), `units` (`z.enum(['english', 'metric'])`, default `'english'`), `interval` (`z.enum(['MAX_SLACK', '6min'])`, default `'MAX_SLACK'`), `bin` (`z.number().int().optional()`, depth bin — omitted takes the CO-OPS default of the shallowest), `offset` (`z.number().int().min(0)`, default `0`), `limit` (`z.number().int().min(1).optional()`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `noaa_marine_get_conditions` | Live marine conditions from a NDBC buoy: wave height/period/direction, wind speed/gust/direction, sea-surface temp, air temp, barometric pressure, and dew point. Numeric fields are `null` when the buoy sensor did not report a value for that observation period (MM in the source data) — normal for offshore buoys. All values are SI (m/s, m, hPa, °C) except TIDE (ft) and VIS (nmi), which are rarely populated at offshore buoys. | `station_id` | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_marine_get_current_profile` | Observed ocean-current depth profile from an NDBC ADCP buoy — the most recent measurement of speed (cm/s) and direction (degrees true, flow-toward) at each depth bin (m). An observed acoustic-Doppler measurement, distinct from `noaa_marine_get_currents`' CO-OPS tidal-current predictions. A bin is reported whenever NDBC gives it a depth; its direction or speed is `null` when the sensor did not report that component. Most NDBC stations serve no ADCP profile, so discovery goes through `find_stations` with `source="ndbc"` and `types=["current_profile"]`. | `station_id` | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_marine_get_ocean_observations` | Live sub-surface observations from an NDBC station's water-quality sensors: at each reported depth, water temperature, conductivity, salinity, dissolved oxygen (% saturation and ppm), chlorophyll, turbidity, pH, and redox potential — the water-column counterpart to `get_conditions`. Returns the most recent observation, one reading per reported depth; unreported values and the coordinates of a station absent from the active-stations list are `null`. Discovery goes through `find_stations` with `source="ndbc"` and `types=["water_quality"]`, NDBC's own catalog flag, which can drift from actual `.ocean` availability. | `station_id` | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `noaa-marine://station/{station_id}` | Metadata for a CO-OPS or NDBC station by ID: name, coordinates, source, capabilities, datum reference, time zone, state (resolved exactly as on `noaa_marine_find_stations`, with `state_derived: true` on a derived one). | No |

### Output Schemas

Key fields per tool — implementer must include these in the Zod `output` schema and `format()` text. Chaining IDs and metadata echoes are required for both surfaces.

**`noaa_marine_find_stations`**
- `stations[]`: `{ station_id: string, name: string, source: 'coops'|'ndbc', type: string, latitude: number, longitude: number, distance_km?: number, state?: string, state_derived?: boolean, capabilities: string[], prediction_class?: string, reference_id?: string, bins?: { bin: number, depth: number | null, depth_type?: string, prediction_class?: string }[] }`
- `state` is a CO-OPS station's own catalog code where any of its rows carries one; otherwise the code of the nearest `tidepredictions` or `waterlevels` row within 25 km, with `state_derived: true`; otherwise the non-code value on the station's first catalog row (e.g. `FM`), as published and unmarked; otherwise absent. A derived state can be wrong on waters shared across a state or national border. The `state` filter takes codes only, so it never returns a station showing a non-code value
- `prediction_class` is the CO-OPS catalog class, a third axis beside `type`/`capabilities` (data products) and `platform` (NDBC physical class). It sits on the row for a tide station (`reference` | `subordinate`, with `reference_id` on a subordinate one) and per bin for a current station (`harmonic` | `subordinate` | `weak_and_variable`), because 46 current stations mix classes across their bins. `bins[].depth` is catalog feet with no unit switch; an unrecognized catalog code passes through verbatim
- `total_found: number` — count before `limit` slice (so agent knows if results were truncated)

**`noaa_marine_get_tide_predictions`**
- `station_id: string`, `station_name: string` — echo for chaining and display
- `datum: string` — must echo the datum used (MLLW etc.) so the agent can state it correctly
- `units: string` — echo units
- `predictions[]`: `{ time: string, height: number, type: 'H'|'L' }` (for hilo); or `{ time: string, height: number }` (for 6min) — the whole matched series when it fits one response, otherwise the leading page from `offset`
- `enrichment.truncated` / `rows_matched` / `rows_returned` / `page_offset` / `next_offset` — the page accounting, present only when the response is a page rather than the whole matched series, so a range that fits returns exactly what it did before paging existed. The page is bounded by the serialized size of the row array against the framework's 24,000-byte inlining budget (`DEFAULT_OUTLINE_BUDGET_BYTES`), never a fixed row count: row width varies by product, so a count that bounds one cadence does not bound the next. `limit` lowers the page and can never raise it past that bound; an `offset` past the last row is an empty page rather than an error

**`noaa_marine_get_water_level`**
- `station_id: string`, `station_name: string`, `datum: string`, `units: string` — echoed
- `interval: '6min'|'hourly'|'high_low'|'daily_mean'` — echoed, and what decides whether `quality`, `type`, and `residual_summary` are populated
- `observations[]`: `{ time: string, value: number, sigma?: number, quality?: string, type?: 'H'|'HH'|'L'|'LL' }` — one entry per slot that carried a reading, as the page from `offset`. CO-OPS emits a row for every slot in the range including the ones its sensor did not report (`v` and `s` both empty strings); those parse to NaN against `value: z.number()`, so they are dropped rather than sinking the whole response. `quality` is present on the `6min` interval only — the coarser products send no `q`, and stamping their verified rows `p` would fabricate a fact from a missing field — and `type` on `high_low` only, with the trailing space CO-OPS pads the single-letter values with trimmed off
- `predictions[]`: `{ time: string, value: number }` — paired predictions at the interval matching the observed cadence, windowed to the span the returned observations cover. Always empty on `daily_mean`, which has no paired series; otherwise may be empty if the predictions fetch failed (degrade gracefully). Windowed by time rather than sliced by index, because gap-dropped observations leave the two series different lengths and equal index slices would pair rows from different instants
- `residual_summary?: { max_surge: number, max_drawdown: number }` — in the requested units, feet under `english` and meters under `metric`; optional computed summary when both series are present, joined only on the finite observed/predicted pairs, and computed across the whole matched series rather than the returned page so a paged response still reports the largest surge in the range. Present on `6min` and `hourly` only: over a year at a typical station an exact-time `high_low` join matches under 6% of the events, so a residual there would be drawn from that fraction, and the notice says so instead. Both fields clamp at zero — `max_surge = max(0, max(residuals))`, `max_drawdown = max(0, −min(residuals))` — so a window that sat above prediction throughout reports `max_drawdown: 0` and one that sat below reports `max_surge: 0`, never the signed residual nearest the side that did not occur
- `enrichment.gaps_dropped: number | undefined` — how many slots were dropped, present only when at least one was. `rows_matched` therefore always describes the rows that carried a value, so a caller cannot read a dropped gap as continuous coverage. Gaps appear in preliminary (`q: "p"`) data; CO-OPS fills them when the range is promoted to verified, so a reproduction pinned to a historical window decays
- `enrichment.truncated` / `rows_matched` / `rows_returned` / `page_offset` / `next_offset` — the page accounting, present only when the response is a page rather than the whole matched series, so a range that fits returns exactly what it did before paging existed. The page is bounded by the serialized size of the row array against the framework's 24,000-byte inlining budget (`DEFAULT_OUTLINE_BUDGET_BYTES`), never a fixed row count: row width varies by product, so a count that bounds one cadence does not bound the next. `limit` lowers the page and can never raise it past that bound; an `offset` past the last row is an empty page rather than an error

**`noaa_marine_get_currents`**
- `station_id: string`, `station_name: string`, `units: string` — echoed. `units` governs speed AND the echoed depth: `english` is knots + feet, `metric` is cm/s + meters (CO-OPS publishes metric current speed in cm/s, not m/s)
- `bin: number | null`, `depth: number | null` — the bin CO-OPS answered with and its depth in the requested units, null when the response carried no prediction rows. Distinct from `find_stations`' `bins[].depth`, which is always catalog feet
- For MAX_SLACK: `events[]`: `{ time: string, type: 'flood'|'ebb'|'slack', speed?: number, direction?: number }` — the whole matched series when it fits one response, otherwise the leading page from `offset`
- For 6min: `predictions[]`: `{ time: string, type: 'flood'|'ebb'|'slack', speed: number, direction: number | null }`. `speed` is a non-negative magnitude, so `type` — derived from the sign of CO-OPS's `Velocity_Major` — is what carries the flow sense; `direction` is the station mean flood or ebb bearing that sense implies, null at slack and wherever CO-OPS reports no mean direction
- `enrichment.notice: string | undefined` — CO-OPS's own statement when it returned that in place of an event array (a weak-and-variable station). The event list is then empty and the call is a success, not an error. Also carries the page accounting sentence on a paged 6-minute curve
- `enrichment.truncated` / `rows_matched` / `rows_returned` / `page_offset` / `next_offset` — the page accounting, present only when the response is a page rather than the whole matched series, so a range that fits returns exactly what it did before paging existed. It covers both intervals: `offset` and `limit` walk the max/slack events on `MAX_SLACK` and the 6-minute curve on `6min`. The page is bounded by the serialized size of the row array against the framework's 24,000-byte inlining budget (`DEFAULT_OUTLINE_BUDGET_BYTES`), never a fixed row count: row width varies by product, so a count that bounds one cadence does not bound the next. `limit` lowers the page and can never raise it past that bound; an `offset` past the last row is an empty page rather than an error

**`noaa_marine_get_conditions`**
- `station_id: string`, `station_name: string`, `latitude: number | null`, `longitude: number | null` — coordinates are `null` when the station has no active-stations entry, matching `get_current_profile` and `get_ocean_observations`
- `observed_at: string` — ISO timestamp of the newest data row; always a valid instant, since a row with malformed time columns is rejected rather than timestamped with the current time
- `waves_observed_at: string | null` — ISO timestamp of the row the four wave fields resolved from, which can be older than `observed_at`; `null` when no wave sample falls inside the 90-minute look-back window
- `enrichment.notice: string | undefined` — present when a block other than waves resolved from a row older than `observed_at`, naming the output fields it fills and the time they were measured. Waves are excluded because `waves_observed_at` already dates them, so the rule is "disclose an age no output field states" rather than a fixed list
- All sensor fields optional/nullable (`number | null`): `wind_direction_deg`, `wind_speed_ms`, `gust_speed_ms`, `wave_height_m`, `dominant_period_sec`, `average_period_sec`, `mean_wave_direction_deg`, `pressure_hpa`, `air_temp_c`, `water_temp_c`, `dew_point_c`, `visibility_nmi`, `tide_ft`
- `source: 'ndbc'` — always ndbc for v0.1.0

### Error Contracts

Typed domain failures each definition enumerates in its `errors: [...]` block. Baseline infrastructure errors (`ServiceUnavailable`, `Timeout`, `ValidationError`, `InternalError`) bubble freely and don't need declaring; a tool declares one anyway when it is a failure the caller can plan around (`sources_unavailable`, `invalid_date_range`, `date_range_exceeded`). An entry marked service-thrown is raised by `CoopsService` rather than the handler, and carries the calling tool's declared recovery through `ctx.recoveryFor`.

| Tool | reason | code | when |
|:-----|:-------|:-----|:-----|
| `noaa_marine_find_stations` | `incomplete_coordinates` | `InvalidParams` | Only one of latitude/longitude was supplied — proximity search needs the pair |
| `noaa_marine_find_stations` | `sources_unavailable` | `ServiceUnavailable` | Every station catalog the search needed failed to load — zero rows from a dead upstream is not an empty search (a zero-match search is a success, not an error). When the failed CO-OPS leg was the HTTP 403 throttle, the recovery names the couple-of-minutes wait instead of retrying in a few moments |
| `noaa-marine://station/{station_id}` | `station_not_found` | `NotFound` | Both catalogs were read and neither carries the ID |
| `noaa-marine://station/{station_id}` | `source_unavailable` | `ServiceUnavailable` | A catalog could not be read, and no catalog that was read carries the ID. When the unread CO-OPS catalog was the HTTP 403 throttle, the recovery names the couple-of-minutes wait instead of retrying in a few moments |
| `noaa_marine_get_tide_predictions` | `station_not_found` | `NotFound` | CO-OPS rejected the station ID, either with a body naming an unknown station or with an HTTP 400 whose body names no condition this server reads (likely wrong type — use a `find_stations` result) |
| `noaa_marine_get_tide_predictions` | `invalid_date_range` | `ValidationError` | `begin_date` or `end_date` is not a real calendar date, or `begin_date` is after `end_date` — checked locally before any upstream call, and the message names the date as it was given |
| `noaa_marine_get_tide_predictions` | `date_range_exceeded` | `ValidationError` | Requested range exceeds the 1-year CO-OPS limit — split into multiple calls |
| `noaa_marine_get_tide_predictions` | `no_predictions` | `NotFound` | Station exists but CO-OPS returned no prediction data for the date range (station inactive or type mismatch); a Great Lakes station, which has no prediction series at any datum, lands here with a recovery pointing at `noaa_marine_get_water_level` |
| `noaa_marine_get_tide_predictions` | `subordinate_no_6min` | `InvalidParams` | `interval="6min"` on a subordinate station, which publishes high and low events only — refused from the catalog class before the upstream call, with the reference station named |
| `noaa_marine_get_tide_predictions` | `datum_unavailable` | `InvalidParams` | An in-enum datum the station does not carry. CO-OPS answers this on the `predictions` transport as an HTTP 200 body-level error, and its sentence for an unaccepted datum is byte-identical to the one for a subordinate `6min` request — the datum sent is the disambiguator, so the message is read as `datum_unavailable` only when a non-MLLW datum was requested |
| `noaa_marine_get_tide_predictions` | `upstream_throttled` | `RateLimited` (retryable, service-thrown) | CO-OPS answered HTTP 403, which it returns for about two minutes while it throttles a burst of requests from one address |
| `noaa_marine_get_water_level` | `station_not_found` | `NotFound` | CO-OPS rejected the station ID, either with a body naming an unknown station or with an HTTP 400 whose body names no condition this server reads |
| `noaa_marine_get_water_level` | `invalid_date_range` | `ValidationError` | `begin_date` or `end_date` is not a real calendar date, or `begin_date` is after `end_date` — checked locally before any upstream call, and the message names the date as it was given |
| `noaa_marine_get_water_level` | `date_range_exceeded` | `ValidationError` | Requested range exceeds the selected `interval`'s CO-OPS limit — 31 days for `6min`, 365 for `hourly` and `high_low`, 3,655 for `daily_mean`. The message names the interval and its limit; a coarser interval covers a longer span in one call |
| `noaa_marine_get_water_level` | `no_data` | `NotFound` | Station exists but no observed water-level data for the date range (station may be offline), including a response whose every slot was a sensor gap |
| `noaa_marine_get_water_level` | `great_lakes_only` | `InvalidParams` | `interval="daily_mean"` at a coastal station. CO-OPS publishes water-level daily means at Great Lakes stations only, so the request is refused from the `waterlevels` catalog's `greatlakes` flag before the call is spent — and the same reason is reached from the CO-OPS HTTP 400 when the catalog could not be read, so a coastal station never reads as a bad ID |
| `noaa_marine_get_water_level` | `verified_data_lag` | `NotFound` | A `hourly`, `high_low`, or `daily_mean` window CO-OPS has not published yet. It answers HTTP 200 with `No data was found. This product may not be offered at this station at the requested time.`, verifying those products monthly for the prior month — so the recovery names the lag rather than an outage or a future date, neither of which is the cause |
| `noaa_marine_get_water_level` | `datum_unavailable` | `InvalidParams` | An in-enum datum the station does not carry. CO-OPS answers this on the `water_level` transport as an HTTP 400 whose body names the datum; the recovery names the planes that do read the station, from the `waterlevels` catalog's `greatlakes` flag. Never the enum bound — an out-of-enum value is the framework's `invalid_arguments` and never reaches the handler |
| `noaa_marine_get_water_level` | `upstream_throttled` | `RateLimited` (retryable, service-thrown) | CO-OPS answered the observed-series request with HTTP 403, which it returns for about two minutes while it throttles a burst of requests from one address. A 403 on the paired prediction fetch alone is not this error: the observed series returns with `predictions_status: "unavailable"` and a notice naming the wait |
| `noaa_marine_get_currents` | `station_not_found` | `NotFound` | CO-OPS rejected the station ID as unknown or invalid (current stations require alphanumeric IDs like `ACT4176`), including an HTTP 400 whose body names no condition this server reads |
| `noaa_marine_get_currents` | `invalid_date_range` | `ValidationError` | `begin_date` or `end_date` is not a real calendar date, or `begin_date` is after `end_date` — checked locally before any upstream call, and the message names the date as it was given |
| `noaa_marine_get_currents` | `date_range_exceeded` | `ValidationError` | Requested range exceeds the 1-year CO-OPS limit — split into multiple calls |
| `noaa_marine_get_currents` | `no_predictions` | `NotFound` | Station exists but CO-OPS returned no current-prediction data for the date range |
| `noaa_marine_get_currents` | `predictions_unavailable` | `NotFound` | The station is in the current-predictions catalog but CO-OPS publishes no predictions for it at any date — a coverage statement, so the recovery must not send the caller back to re-verify an ID `find_stations` returned |
| `noaa_marine_get_currents` | `bin_unavailable` | `InvalidParams` | CO-OPS rejected the requested `bin`; its HTTP 400 body names the station's real bins, which the recovery repeats. Never a Zod bound — a shape-valid bin the station lacks must reach the handler |
| `noaa_marine_get_currents` | `upstream_throttled` | `RateLimited` (retryable, service-thrown) | CO-OPS answered HTTP 403, which it returns for about two minutes while it throttles a burst of requests from one address |
| `noaa_marine_get_conditions` | `buoy_not_found` | `NotFound` | NDBC returned 404 for the station ID — find a conditions-capable station with `find_stations` using `source: "ndbc"` and `types: ["met"]` |
| `noaa_marine_get_conditions` | `no_sensor_data` | `NotFound` | Buoy file exists but no row inside the 90-minute look-back window carries a sensor value (buoy offline or sensor failure) |
| `noaa_marine_get_current_profile` | `profile_not_found` | `NotFound` | NDBC returned 404 for the station — no ADCP current-profile file exists for it |
| `noaa_marine_get_current_profile` | `no_current_data` | `NotFound` | The ADCP file exists but has no usable data rows — profiler offline or every bin missing |
| `noaa_marine_get_ocean_observations` | `observations_not_found` | `NotFound` | NDBC returned 404 for the station — no `.ocean` oceanographic file exists for it |
| `noaa_marine_get_ocean_observations` | `no_ocean_data` | `NotFound` | The `.ocean` file exists but has no usable data rows — station offline or every depth row missing |

### Prompts

None — this server is data-oriented; no recurring interaction patterns warrant a prompt template.

---

## Overview

US marine conditions via two NOAA sources: **CO-OPS** (Center for Operational Oceanographic Products and Services) for tide predictions, observed water levels, tidal currents, and coastal met data at its coastal gauges; **NDBC** (National Data Buoy Center) for live offshore buoy observations (waves, wind, sea-surface temp, pressure) at its active stations worldwide.

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
- **Station metadata size.** Each CO-OPS list runs to a few thousand stations (`currentpredictions` is the largest, `waterlevels` the smallest by an order of magnitude), and the NDBC active list to roughly a thousand. The station lists are bounded — mirroring is warranted for `find_stations` (see Services). Exact counts move as NOAA adds and retires stations; read them from the live catalogs, never from this document.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `CoopsService` | CO-OPS Tides & Currents API (data endpoint + mdapi metadata) | `noaa_marine_find_stations`, `noaa_marine_get_tide_predictions`, `noaa_marine_get_water_level`, `noaa_marine_get_currents`, `noaa-marine://station/{station_id}` |
| `NdbcService` | NDBC realtime2 files (`.txt`, `.adcp`, `.ocean`) + activestations.xml | `noaa_marine_find_stations`, `noaa_marine_get_conditions`, `noaa_marine_get_current_profile`, `noaa_marine_get_ocean_observations`, `noaa-marine://station/{station_id}` |

Both services are init/accessor pattern (`initCoopsService(config)` / `getCoopsService()`), initialized in `createApp({ setup })`.

### CoopsService

Wraps two CO-OPS base URLs:
- **Data:** `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` — parametric query for products (predictions, water_level, currents_predictions, water_temperature, wind, air_pressure)
- **Metadata:** `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json` — station lists by type + single-station detail

Station list fetching is the expensive operation (a few thousand records per type). Use an in-memory cache with a 6-hour TTL so `find_stations` calls don't re-fetch on every request. Cache keyed by station type. On startup, pre-warm the two most-used types (tidepredictions, currentpredictions).

The `application` courtesy param is sent on every request: `application=noaa-marine-mcp-server`.

CO-OPS error shape: `{ "error": { "message": "..." } }` — detected by presence of the `error` key in the JSON response.

### NdbcService

Wraps four NDBC endpoints:
- **Active stations:** `https://www.ndbc.noaa.gov/activestations.xml` — XML, parsed once and cached (6-hour TTL). Each station carries id, lat, lon, name, type, owner, and met/currents/waterquality/dart flags.
- **Realtime observations:** `https://www.ndbc.noaa.gov/data/realtime2/{stationId}.txt` — fixed-width text, per-buoy, fetched on demand (`get_conditions`).
- **ADCP current profile:** `https://www.ndbc.noaa.gov/data/realtime2/{stationId}.adcp` — per-station depth-binned current direction and speed, fetched on demand (`get_current_profile`).
- **Ocean observations:** `https://www.ndbc.noaa.gov/data/realtime2/{stationId}.ocean` — per-station sub-surface water-quality readings by depth, fetched on demand (`get_ocean_observations`).

**NDBC fixed-width parsing** (verified against live data):
- Line 1: `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE`
- Line 2: units row (`#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft`)
- Lines 3+: space-separated data, most recent first. `MM` = missing sensor data.
- Parser: split header cols from line 1, split data rows, zip and coerce. Numeric coercion maps `MM` → `null`. Return the most recent complete-ish observation (first non-header row).
- Key fields: `WDIR` (wind direction °T), `WSPD` (wind speed m/s), `GST` (gust m/s), `WVHT` (wave height m), `DPD` (dominant period sec), `APD` (average period sec), `MWD` (mean wave direction °T), `PRES` (pressure hPa), `ATMP` (air temp °C), `WTMP` (water temp °C), `DEWP` (dew point °C).
- Most NDBC observations are SI (m/s, m, hPa, °C). **Exceptions:** `TIDE` is in feet and `VIS` is in nautical miles — document both in the output schema. NDBC doesn't support unit switching, so these exceptions are fixed.

**Resilience:** `withRetry` wraps both service methods. CO-OPS data fetches: 3 retries, 1s base delay (the prediction series paired with a water-level request: 2 retries). Station list fetches: 2 retries, 2s base. NDBC realtime: 2 retries, 1s base (missing buoy files return 404, not retried). Parse HTML error pages as transient (not `SerializationError`). A CO-OPS HTTP 403 — the status CO-OPS answers a burst of requests from one address with, for about two minutes — becomes `RateLimited` with `data.reason: "upstream_throttled"` and `data.retryable: true` on every CO-OPS request site, catalog included. The status is read before any body classification, and the mapping sits on the rejection path after `withRetry`: a 403 is `Forbidden` inside the loop and is not retried, while `RateLimited` is transient to it, so mapping inside the closure would re-send the request into the block. The captured upstream body is not carried onto the error.

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
| 3 | Filter by query, state, type, source | In-process | Token match on name; state exact match against the resolved state, which `CoopsService.stationStates()` computes once per catalog refresh |
| 4 | Compute haversine distance if lat/lon provided | In-process | Sort by distance; apply radius filter |
| 5 | Deduplicate (no overlap between CO-OPS and NDBC IDs) | In-process | — |
| 6 | Slice to `limit` (default 20) | In-process | — |

### `noaa_marine_get_water_level` (parallel companion fetch)

| # | Operation | Purpose |
|:--|:----------|:--------|
| 1 | Fetch the product `interval` selects (observed) | Primary data |
| 2 | Fetch `predictions` at the matching interval, same date range | Comparison baseline |
| 1+2 | Parallel via `Promise.allSettled` | prediction fetch failure degrades gracefully — observed levels still returned |
| 2 | Skipped on `interval="daily_mean"` | the product has no paired series, so no call is spent and its emptiness is not reported as a fact about the station |

---

## Design Decisions

**The row page is bounded by serialized size, not a row count.** Row width varies several-fold across the CO-OPS products this server wraps, so any fixed count either truncates a narrow series that would have fit or overruns a wide one: 124 high/low events are 6.6 KB while 240 six-minute observations are 27 KB. Measuring the serialized row array against the framework's `DEFAULT_OUTLINE_BUDGET_BYTES` (24,000) gives one rule that holds for every product, and reusing the framework constant keeps the server and the framework agreeing on what is too large to inline. A range that fits returns whole with no disclosure at all, so adding the bound changed nothing about the calls that were already safe.

**Paging is `offset`-based, not a cursor.** The series is a contiguous, stably ordered slice of a date range the caller already named, so a row offset is the whole state a next page needs and the caller can read it, skip with it, and resume with it. An opaque cursor would hide that for no gain, and a date-window cursor would make the caller re-derive window arithmetic the range already expresses.

**Both current intervals are paged, on one bound.** A day of max/slack events is 568 bytes, two orders of magnitude inside the budget, but the tool accepts a year of them — 2,821 events at `ACT1616`, about 166 KB, roughly 7× the budget — so the event view is bounded by the same rule as the 6-minute curve rather than exempted as the compact planning view. A fitting range is byte-identical to the unpaged response, which is what makes one bound cheaper than an exemption: the exemption would need a size argument of its own the moment the range grew.

**Water level pages two series on one offset, with the companion windowed by time.** Observations and predictions describe the same instants, so one offset is what keeps a page's two arrays talking about one span. They are not the same length, though — dropped gap rows shorten the observed series while CO-OPS still predicts those slots — so the predictions are windowed to the page's time span rather than sliced at the same indices, which would pair rows from different instants. Both arrays are charged to one budget so a pair cannot each spend it in full.

**`residual_summary` is computed before paging, across the whole matched series.** It answers "was there a surge in this range", which is a question about the range and not about the page the caller happens to be reading. Computing it per page would silently change the question with the offset.

**`residual_summary` clamps each side at zero.** `max_surge` is the largest positive residual and `max_drawdown` the largest negative one's magnitude, so a window that never rose above prediction had no surge. Reporting the signed extreme instead printed a negative surge or a phantom drawdown on every one-sided window; the field names and types stay as they were.

**Both date forms are normalized in the shared validator, not in each handler.** `validateCoopsDateRange` accepts `YYYYMMDD` or `YYYY-MM-DD` per field, runs the calendar check on the compact form, and hands back the strings CO-OPS takes. Normalizing there keeps one point that strips the hyphens and lets every rejection name the date exactly as the caller sent it — a strip in the handler would have the validator report `20261301` for a caller who sent `2026-13-01`. The schema's `.regex()` carries its own message naming both forms, because a pattern rejection happens before the handler and that message is the only text the caller sees.

**A CO-OPS 403 is mapped once, in the service, after the retry loop.** Every CO-OPS request site shares the one mapping, so a tool cannot forget it, and the calling tool's declared recovery reaches it through `ctx.recoveryFor`. It sits after `withRetry` because `RateLimited` is transient there: the retry loop would otherwise answer a throttle by sending more requests into it.

**The coarser water-level products are `interval` values, not separate tools.** `hourly_height`, `high_low`, and `daily_mean` are the same observed quantity at a different cadence, sharing the station, datum, units, error contract, and `{time, value}` row shape — so they are one tool's cadence selector. `monthly_mean` is not: its rows carry no `t` and no `v` but a set of tidal datums, it has no paired prediction series, and its range limit is 200 years. It is a different record type served by the same endpoint, and belongs in its own tool rather than as a fifth value of this enum.

**An absent upstream quality flag stays absent.** Only `water_level` sends `q`. Defaulting the others to `p` would stamp CO-OPS's verified products as preliminary — a fabricated fact from a missing field — so `quality` is optional in the output and omitted where upstream sends nothing.

**`daily_mean`'s LST-only constraint is applied in the service, not the tool.** CO-OPS does not reject `time_zone=lst_ldt` for that product; it shifts every row by the daylight offset, so a row stamped the 1st carries the 2nd's mean. That is a property of the transport for that product, so the service rewrites the parameter and the tool passes the caller's value through untouched — one forcing point rather than a rule each caller has to remember.

**`noaa_marine_find_stations` as required first step, not optional.** CO-OPS and NDBC use different, non-overlapping ID systems. If an agent guesses a station ID or confuses a tide station ID for a current station ID, the data call fails with a cryptic NOAA error. Surfacing discovery as the explicit first tool — and making it fast via caching — keeps the downstream tools simple (they accept an ID, not a lat/lon).

**A station with no state code takes the nearest state-bearing station's state, within 25 km.** No `currentpredictions` row carries a state, and per-station metadata carries none for current stations either, so a state filter matched against the catalog alone returns nothing for `{ state: "WA", types: ["current"] }`. The fallback is the code of the nearest `tidepredictions` or `waterlevels` row within 25 km, marked `state_derived: true` so a caller can tell it from a published one. The bound is what keeps foreign waters out of US states: an unbounded match puts Magdalena Bay entrance (Mexico) in California at 1,024 km. Name values such as `Bermuda` are never a source. A station with neither keeps showing the non-code value on its first catalog row (`FM` at Chuuk and Palau), exactly as before the fallback existed; the filter's code-only enum never matches it. Every stateless station is compared with every state-bearing row, so the pass runs once per catalog refresh (about 50 ms), keyed on the identity of the cached lists, rather than per request.

**MLLW as default datum, not MHHW or MSL.** MLLW (mean lower low water) is the US nautical chart datum, the basis for published chart depths, and the reference mariners expect. Returning water heights relative to MLLW means the chart reads correctly. MSL is common in atmospheric science but wrong for tide tables. MHHW is used for flooding/inundation work. All are valid options but MLLW is the default because it's right for the primary audience.

**CO-OPS station list in-memory cache (6-hour TTL).** The station lists are large (a few thousand stations each) and change rarely (NOAA adds/removes stations monthly at most). Fetching the full list on every `find_stations` call would make discovery slow and impose unnecessary load on NOAA. An in-memory cache with 6-hour TTL is a good fit: no SQLite dependency, no cross-session persistence needed, predictable memory (each list is roughly 2–4 MB JSON).

**Currents use `MAX_SLACK` interval by default.** The raw 6-minute current data is primarily useful for charting or integrating total flow. For passage planning — "is there a slack window to run the inlet?" — the MAX_SLACK interval (which returns only max flood, max ebb, and slack events) is far more actionable. Agents that need the full curve can pass `interval: "6min"`.

**NDBC observations are SI units with two exceptions.** NDBC realtime text files emit metric (m/s, m, hPa, °C) for most fields. Exceptions: `TIDE` is in feet, `VIS` is in nautical miles — both are rarely populated at offshore buoys and will typically be `null`. There is no unit switching at the NDBC layer. The output schema documents units per-field so agents know wave heights are in meters, wind is in m/s, etc., regardless of what `units` they'd set for CO-OPS tools.

**`get_conditions` is NDBC-only (v0.1.0).** CO-OPS met (wind, air pressure, water temperature) is available at a minority of its stations but requires co-location detection to match CO-OPS station IDs against NDBC buoy IDs. For v0.1.0, the tool accepts a single `station_id` and routes to NDBC only — the `source` parameter is omitted to avoid exposing a half-implemented CO-OPS path. CO-OPS met enrichment can be added in a later iteration once co-location logic is implemented.

**`water_level` fetches paired predictions.** The raw water level number alone is only half the picture — it means little without the predicted value for the same time. The residual (observed − predicted) is the storm surge or drawdown. Fetching both in parallel and returning them together lets the agent give a complete answer without requiring a second tool call.

**No prompt.** The server is purely data-oriented. The use cases (tide table, water level, conditions) are straightforward enough that agents can compose an answer directly from the tool outputs without a reusable message template.

---

## Known Limitations

- **CO-OPS date range limits:** `get_tide_predictions` and `get_currents` max 1 year per request; `get_water_level` max 31 days on `interval="6min"`, 365 on `hourly` and `high_low`, 3,655 on `daily_mean`. Enforced by input validation in each tool (`date_range_exceeded` typed error) before any upstream call. A range inside the limit is not necessarily a response a client can hold — a year of `hourly` rows is roughly 40× the framework's inlining budget — so the row series is paged by serialized size and walked with `offset` rather than split into more calls.
- **Verified-data lag on the coarser water-level products:** CO-OPS verifies `hourly_height`, `high_low`, and `daily_mean` monthly, for the prior month, so a window reaching into the current month returns no rows and surfaces as `verified_data_lag`. `interval="6min"` serves preliminary data up to the present.
- **NDBC realtime lag:** row cadence varies by station — 5, 6, 10, 15, 20, 30, and 60 minutes all occur — so the most recent data point can be that old when fetched. NDBC also writes each block of columns on its own pass, so `get_conditions` resolves a block from the most recent row within 90 minutes that carried it: waves report that row's time as `waves_observed_at`, and any other block read from an earlier row is named with its measurement time in the response notice. Not a real-time streaming feed.
- **CO-OPS currents predictions are not available everywhere.** CO-OPS current stations cover major US passages, channels, and harbors — not every waterway — and presence in the `currentpredictions` catalog is not itself a guarantee of predictions: a weak-and-variable bin may answer with a coverage statement and no events, or report none published at all. Agents should use `find_stations` with `types: ["current"]` and prefer a bin whose `prediction_class` is `harmonic`.
- **CO-OPS throttles bursts.** A burst of requests from one address is answered HTTP 403 for about two minutes. The data tools report it as `upstream_throttled` (`RateLimited`, retryable), `find_stations` as `sources_unavailable` and the station resource as `source_unavailable`, each with a recovery naming the wait, a throttled water-level prediction fetch as `predictions_status: "unavailable"` with a notice naming the wait, and nothing retries into the block — spacing calls is the only remedy.
- **Global wave forecast:** NDBC covers US coastal/offshore waters primarily. For global wave forecast at any coordinate, `open-meteo`'s marine tool is the right complement.
- **No historical NDBC data.** The `realtime2` files contain only the most recent ~45 days. For historical buoy data, NDBC's archive API (not implemented here) would be needed.

---

## API Reference

### CO-OPS Data Endpoint

`GET https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`

Required params: `station`, `product`, `begin_date` (YYYYMMDD), `end_date` (YYYYMMDD), `format=json`, `application`.

Products used:
- `predictions` — tide or 6-min predictions; also requires `datum`, `time_zone`, `units`, `interval` (hilo|6min). Accepts `MLLW MHHW MHW MTL MSL MLW DTL NAVD STND CRD`, and rejects a datum with an HTTP 200 carrying a body-level `error`. A Great Lakes station is refused outright with HTTP 400 `Great Lakes stations don't have Predictions data.` at every datum
- `water_level` — observed water level; also requires `datum`, `time_zone`, `units`. Accepts `MLLW MHHW MHW MTL MSL MLW NAVD STND IGLD LWD CRD LWI HWI` — a different set from `predictions`, and neither accepts `CD` anywhere — and rejects a datum with an HTTP 400 whose body names it (`There is no MLLW for the station: 9087044`, `There is no CRD Offset for the station: 9440083`, `The supported Datum values are: …`, `Wrong Datum: The datum supplied is a derived datum`). Two of those look authoritative and are not: the `supported Datum values` list is station-specific and omits planes the station does serve, and `mdapi/…/stations/{id}/datums.json` uses different names (`NAVD88`, `CRD_OFFSET`, `GL_LWD`) and lists datums this product rejects
- `currents_predictions` — current speed/direction; also requires `time_zone`, `units`, `interval` (MAX_SLACK|6min), and accepts an optional `bin`. An unavailable `bin` comes back as HTTP 400 whose body names the station's real bins; a station with no predictions answers HTTP 200 with an `error` envelope, and a weak-and-variable one answers HTTP 200 with `cp` as a string instead of an array

Response envelope: `{ "predictions": [...] }` / `{ "data": [...] }` / `{ "current_predictions": { "cp": [...] } }`. Error: `{ "error": { "message": "..." } }`.

Water level data fields: `t` (ISO datetime), `v` (value ft), `s` (sigma/stdev), `f` (flags), `q` (quality: p=preliminary, v=verified). A slot the sensor did not report is still present as a row, with `v` and `s` both empty strings, `f` all-ones, and `q` preliminary — a sparse series, not a malformed response.

### CO-OPS Metadata API

`GET https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type={type}`

Types: `tidepredictions`, `currentpredictions`, `waterlevels`. Station fields: `id`, `name`, `lat`, `lng`, plus per-catalog fields. `tidepredictions` rows carry `state` (blank on 431 of 3,499, and `FM` — outside the state-filter codes — on 2), `reference_id`, and `type` R (reference) or S (subordinate); `currentpredictions` rows carry `state: null` and instead carry one row per depth bin with `currbin`, `depth` (feet, nullable), `depthType` (B/S/U) and `type` H (harmonic), S (subordinate) or W (weak and variable); `waterlevels` rows carry `state` — a code on most, a name on a few (`United States of America`, `American Samoa`, `Bermuda`) — and no `type` at all. A non-code value is shown as the station's `state` only when it sits on the station's first row and no code is published or derivable; the `state` filter never matches one and derivation never draws on one. `waterlevels` rows also carry `greatlakes`, true on 52 of 302, which is what makes a datum rejection at one of them recoverable without a second discovery call. A reference tide station has full harmonic analysis and publishes both `hilo` and the 6-minute curve; a subordinate one derives high and low events from its `reference_id` station via offsets and publishes no 6-minute curve. `T` is not a code either catalog publishes.

### NDBC Fixed-Width Text Format

`GET https://www.ndbc.noaa.gov/data/realtime2/{stationId}.txt`

- Line 1: `#` + space-separated column names
- Line 2: `#` + units row
- Lines 3+: data rows, most recent first, 10-minute observations
- `MM` = missing/not-applicable sensor value
- Columns: `YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE`
- All numeric values in SI (m/s, m, hPa, °C) except TIDE (feet) and VIS (nautical miles)
