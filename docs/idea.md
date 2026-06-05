---
name: noaa-marine-mcp-server
description: "Tides, currents, water levels, and marine buoy conditions via NOAA CO-OPS and NDBC — coastal and offshore observations for US waters."
version: 0.0.0
status: idea
category: external-data
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/noaa-marine-mcp-server"
created: 2026-05-30
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
pattern: multi-source aggregation
complexity: medium
api-deps: NOAA CO-OPS Tides & Currents API + NDBC (National Data Buoy Center)
api-cost: free (no key; CO-OPS asks for an application identifier; NDBC is open)
hostable: true
composes-with: nws-weather-mcp-server, open-meteo-mcp-server, earthquake-mcp-server, wsdot-mcp-server
---

# noaa-marine-mcp-server

Marine conditions for US waters — tide predictions, real-time water levels, tidal currents, and offshore buoy observations — by aggregating NOAA **CO-OPS** (Center for Operational Oceanographic Products and Services / Tides & Currents) and **NDBC** (National Data Buoy Center). Both keyless.

Part of the **NOAA cluster** (see Design Notes) and deliberately separate from `nws-weather` (atmospheric forecast), `noaa-climate` (historical land/atmosphere), and `noaa-spaceweather` (solar). This is the *ocean operational* workflow — a mariner wants today's tides and the sea state at the nearest buoy, not a GHCND climate normal or a city forecast.

**Audience:** Boaters, sailors, surfers, anglers, kayakers, coastal-zone planners, tsunami/storm-surge watchers, agents answering "when is high tide?", "what's the surf/sea state?", or "how high is the water right now?"

## User Goals

- Find the tide/current station or buoy nearest a place
- Get tide predictions (high/low times and heights) for a date range
- Check real-time observed water level vs. prediction (storm surge)
- Get tidal current predictions/observations for a passage
- Read live marine conditions — wave height/period, wind, sea-surface temp — from a buoy

## API Surface

Two keyless sources, unified by workflow. CO-OPS keys on 7-digit station IDs (e.g. `9447130` Seattle); NDBC on alphanumeric buoy IDs (e.g. `46087`). CO-OPS asks callers to pass an `application` identifier.

| Source | Endpoint | Purpose |
|:-------|:---------|:--------|
| CO-OPS metadata | `mdapi/prod/webapi/stations.json?type=...` | Station discovery (3,450+ stations) by capability: tidepredictions, currentpredictions, waterlevels |
| CO-OPS data | `api/prod/datagetter?product=...` | `predictions` (hilo/6-min), `water_level`, `currents`, `water_temperature`, `wind`, `air_pressure` — with `datum`, `time_zone`, `units` |
| NDBC | `activestations.xml` + `data/realtime2/{id}.txt` | 1,355 active buoys; latest waves, wind, SST, pressure |

CO-OPS responses need datum/timezone/unit handling (`MLLW`, `lst_ldt`, `english`/`metric`); NDBC realtime is fixed-width text that must be parsed into records.

## Tool Surface (sketch)

Prefix `noaa_marine_*` (NOAA cluster namespace — see Design Notes).

```
noaa_marine_find_stations — find CO-OPS stations and NDBC buoys near coordinates or by
    name/state. Returns id, name, source (coops|ndbc), type (tide | current |
    water-level | met | buoy), coordinates, distance, capabilities. Required first step —
    unifies the two ID systems so the agent thinks in places, not station IDs.

noaa_marine_get_tide_predictions — high/low (or 6-minute) tide predictions for a CO-OPS
    station over a date range. Datum (default MLLW), timezone, units. Returns
    {time, height, type: H|L}. The headline tool — "when is high tide this week?"

noaa_marine_get_water_level — observed water level (real-time or historical date range)
    for a CO-OPS station alongside the prediction, so the agent sees the residual (storm
    surge / drawdown). Supports begin_date/end_date for post-event analysis ("how high
    did the water get during last Tuesday's storm?") as well as the live default.

noaa_marine_get_currents — tidal current predictions or observations for a current
    station: speed, direction, slack/max times. For passage and dive planning.

noaa_marine_get_conditions — live marine conditions from the nearest/specified NDBC buoy
    (and CO-OPS met where available): wave height/period/direction, wind speed/gust/
    direction, sea-surface + air temp, pressure. "What's the sea state offshore now?"
```

## Design Notes

- **NOAA cluster, not a mega-server.** Workflow-scoped split: `nws-weather` (forecast), `noaa-climate` (historical, the rename of `noaa-cdo`), this `noaa-marine` (tides/currents/buoys), `noaa-spaceweather` (solar). Tools namespace under `noaa_` with a domain segment — prefix `noaa_marine_*` — so the cluster groups without colliding.
- **Multi-source aggregation** (the threat-intel pattern): the agent calls `noaa_marine_*`, the handler routes to CO-OPS or NDBC by capability. Output carries source provenance (`coops`/`ndbc`) so the agent knows where a number came from.
- Medium complexity, driven by: station-ID unification across two systems, CO-OPS datum/timezone/unit parameters (wrong datum = wrong tide height), the predictions-vs-observations distinction, and parsing NDBC fixed-width text.
- **Default the fiddly params** — `datum=MLLW`, `time_zone=lst_ldt`, `units=english` (the mariner defaults), all overridable. Surfacing raw water levels without a datum is meaningless.
- Coverage is **US + territories** (CO-OPS/NDBC are NOAA) — state that; don't imply global tides. For global marine *forecast* (waves/swell anywhere), point at `open-meteo`'s marine tool; this server is US observations + predictions.
- Composes with `nws-weather` (coastal/marine forecast + small-craft advisories on top of observed conditions), `open-meteo` (global marine forecast where NOAA has no station), `earthquake` (tsunami context — a quake + abnormal water level is a strong signal), `wsdot` (Washington ferries + tides/currents is a natural local pairing).
- Moonshot: a "is it a good day to be on the water at X?" workflow merging tides, currents, buoy sea-state, and the NWS marine forecast into one go/no-go.
- README one-liner: "US tides, currents, water levels, and marine buoy conditions from NOAA CO-OPS and NDBC."
