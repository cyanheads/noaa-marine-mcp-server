---
name: noaa-marine-guide
description: Gates and conventions for the noaa_marine_* tools (NOAA CO-OPS tides, tidal currents, water levels; NDBC buoys). Covers which station serves which tool, why a place-name search misses, time-zone and direction conventions across the two sources, and what the server cannot answer (forecasts, warnings, past buoy readings). Use when an answer about tides, currents, storm surge, sea level, or sea state takes more than one noaa_marine_* call.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Keyless. CO-OPS covers US coasts, territories, and the Great Lakes: tide and tidal-current predictions, observed water levels, and verified monthly means. NDBC serves the newest observation from a buoy or fixed station: surface weather and waves, an ADCP current profile, or water-column sensors.

Reach elsewhere for:

- Forecasts of any kind (wind, waves, swell, weather) and marine warnings or advisories. Use a National Weather Service server for marine zone forecasts and alerts, and a marine wave-forecast server for swell at a coordinate.
- Past buoy readings. The NDBC tools return only the newest observation, so they can't show yesterday's swell or a trend over the last few hours.
- Geocoding. Station search matches station names and IDs, not places.

## Identifiers

| ID shape | Source | Read by |
|:--|:--|:--|
| Numeric, e.g. `9447130` | CO-OPS tide or water-level station | `capabilities` decides: `tide` → tide predictions; `water_level` → water level and monthly means |
| Alphanumeric, e.g. `PUG1515`, plus a bin number | CO-OPS current station | `noaa_marine_get_currents`, with `bin` taken from that station's `bins[]` |
| 5 characters, e.g. `46041`, `FRDW1` | NDBC station | `capabilities` decides: `met` → conditions; `current_profile` → current profile; `water_quality` → ocean observations |

- NDBC relays many CO-OPS gauges under its own ID, and the NDBC station's name starts with the CO-OPS number: `FRDW1` is named `9449880 - Friday Harbor, WA`. A `query` for a CO-OPS number therefore returns the CO-OPS row first, followed by any NDBC relay. When the gauge also reports wind and air data, the relay's ID is the one `noaa_marine_get_conditions` reads.
- A tide station is not necessarily a gauge. Most tide-prediction stations are prediction-only, and only those whose `capabilities` include `water_level` have observations.

## Gates

1. **`query` is not a geocoder.** It matches a substring of station names and IDs. A marina, beach, or town that no station is named after comes back `total_found: 0`, which doesn't mean there's no station nearby. Resolve the place to coordinates with a geocoding tool, then search by `latitude`/`longitude`.
2. **Observations need a gauge.** Before calling `noaa_marine_get_water_level` or `noaa_marine_get_monthly_means`, confirm the station's `capabilities` include `water_level`. At a prediction-only station, the water-level call fails as `datum_unavailable` even for MLLW, and a retry with STND fails too. Don't work through the datum list; switch to the nearest `water_level` station.
3. **Predictions carry no weather.** Storm surge and wind-driven drawdown show up only in observations, as the residual against prediction. To answer what the water is doing now, or what it did during a storm, read observations, not predictions.
4. **Never call a passage safe.** The server has no forecast or warning product. For a go/no-go question, give the predicted timing and the latest buoy observation with its `observed_at`, label which is which, and send the user to NWS marine forecasts and warnings for the decision.
5. **Put both sources on one clock.** CO-OPS tools default to `lst_ldt`, the station's local time. NDBC times are UTC. Before you compare a buoy reading with a tide or current event, or merge them into one timeline, pass `time_zone: "gmt"` to the CO-OPS call or convert the NDBC time.
6. **Space out CO-OPS calls.** When one address sends CO-OPS a burst of requests, CO-OPS blocks it with HTTP 403 for about two minutes. Every CO-OPS request from this server comes from the server's own address. Run a multi-station survey one call at a time, not in parallel. After `upstream_throttled`, wait out the block before calling again.

## Conventions

- **Direction.** NDBC `wind_direction_deg` and `mean_wave_direction_deg` give the direction the wind or waves come **from**. `noaa_marine_get_current_profile` gives the direction the current flows **toward**. A 270° wind blows from the west, while a 270° current runs to the west.
- **Wave height.** `wave_height_m` is the significant wave height: the mean of the highest third of waves in a 20-minute sample. Individual waves run higher. `dominant_period_sec` is the period carrying the most wave energy.
- **Units.** NDBC units are fixed and named in each field (m, m/s, hPa, °C; cm/s on the ADCP). CO-OPS follows `units`. For currents, `metric` means cm/s, not m/s. Convert everything to one system before presenting: 1 kn = 51.44 cm/s, 1 m/s = 1.944 kn, 1 m = 3.281 ft.
- **Datums.** MLLW is the datum chart depths are measured from, so the water depth at a spot is its charted depth plus the predicted height. A negative height (a minus tide) means less water than the chart shows. For a flooding question, request MHHW. Height 0 is then the average higher high tide, and a positive value is water above it.

## Workflows

**Trip plan at a named harbor.** Resolve the harbor to coordinates (Gate 1), then run one proximity search per need, each narrowed by `types`:

1. `tide` → `noaa_marine_get_tide_predictions` (hilo).
2. `current` → `noaa_marine_get_currents` (MAX_SLACK).
3. `source: "ndbc"` with `met` → `noaa_marine_get_conditions`.

Present all results on one clock (Gate 5) and in one unit system.

**Slack water or a bar crossing.** A MAX_SLACK slack event marks the predicted instant of slack. Its speed is absent or a small residual (a few hundredths of a knot, more visible in metric). One flow can show several maximum events in a row between two slacks. To find how long the current stays weak around a slack, read the `6min` curve for that stretch. Pair the timing with the nearest offshore buoy's wave height and period, then apply Gate 4.

**Storm surge.** Pick a `water_level` station (Gate 2) and call `noaa_marine_get_water_level` at `6min` or `hourly`. Those are the two intervals that report `residual_summary`. CO-OPS publishes `hourly` only after monthly verification, so a window ending this month or last returns `verified_data_lag`; for a storm in progress or a recent one, use `6min`. `max_surge` is the largest amount the observed level rose above prediction. Request MHHW to read the observed heights as water above typical high tide.

**Long-term sea level.** Call `noaa_marine_get_monthly_means` over decades and walk `next_offset` until it is null. Keep the datum and units the same on every page. The trend is read from `msl`. The server publishes no fitted trend, so fit it yourself and state the span you used.

**Currents at depth.** For predicted flood, ebb, and slack timing at a depth, call `noaa_marine_get_currents` with a `bin`. In `bins[]` on the station search, depth is in feet. For what the water column is measured doing now, call `noaa_marine_get_current_profile` (depth in m, speed in cm/s, direction toward). The two come from different stations and different IDs, so convert units before comparing.
