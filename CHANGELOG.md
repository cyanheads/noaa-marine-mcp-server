# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-16 · ⚠️ Breaking

Adds noaa_marine_get_current_profile (NDBC observed currents) and a current_profile filter; type is now purely the data-capability axis with platform as a separate field, and the fabricated buoy capability is removed — breaking output changes

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-07-15 · 🛡️ Security

Four bug fixes: noaa_marine_find_stations rejects incomplete lat/lon pairs, fixes its NDBC met filter and type field; noaa_marine_get_conditions guidance now points at conditions-capable stations; mcp-ts-core ^0.10.14, supply-chain hardening

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-30

Four bug fixes: CO-OPS invalid/reversed date ranges validate locally as invalid_date_range instead of station_not_found, sensorless buoys keep no_sensor_data, a state filter excludes state-less NDBC buoys, and blank NDBC names become NDBC <id> labels; dev-dependency refresh

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-20

mcp-ts-core ^0.10.9 maintenance — check-dependency-specifiers devcheck step, plugin-manifest packaging checks, fresh-scaffold devcheck guards, ctx.content collector available; dev-dependency refresh

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-12

mcp-ts-core ^0.10.6 adoption, sharper CO-OPS error codes, find_stations truncation flag, and MCPB bundle agent-doc stripping

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-06

CO-OPS error typing, interval fix, and null direction for 6-min current predictions

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-06

Public hosted endpoint at noaa-marine.caseyjhand.com/mcp

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-05 · 🛡️ Security

Initial public release — 5 tools, 1 resource over NOAA CO-OPS tides/currents and NDBC buoy APIs, with station ID regex hardening
