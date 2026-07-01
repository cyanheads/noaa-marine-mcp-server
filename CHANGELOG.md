# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
