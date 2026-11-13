#!/usr/bin/env node
/**
 * @fileoverview noaa-marine-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { noaaMarineStationResource } from './mcp-server/resources/definitions/noaa-marine-station.resource.js';
import { noaaMarineFindStations } from './mcp-server/tools/definitions/noaa-marine-find-stations.tool.js';
import { noaaMarineGetConditions } from './mcp-server/tools/definitions/noaa-marine-get-conditions.tool.js';
import { noaaMarineGetCurrentProfile } from './mcp-server/tools/definitions/noaa-marine-get-current-profile.tool.js';
import { noaaMarineGetCurrents } from './mcp-server/tools/definitions/noaa-marine-get-currents.tool.js';
import { noaaMarineGetMonthlyMeans } from './mcp-server/tools/definitions/noaa-marine-get-monthly-means.tool.js';
import { noaaMarineGetOceanObservations } from './mcp-server/tools/definitions/noaa-marine-get-ocean-observations.tool.js';
import { noaaMarineGetTidePredictions } from './mcp-server/tools/definitions/noaa-marine-get-tide-predictions.tool.js';
import { noaaMarineGetWaterLevel } from './mcp-server/tools/definitions/noaa-marine-get-water-level.tool.js';
import { initCoopsService } from './services/coops/coops-service.js';
import { initNdbcService } from './services/ndbc/ndbc-service.js';

await createApp({
  name: 'noaa-marine-mcp-server',
  title: 'noaa-marine-mcp-server',
  sessionMode: 'stateless',
  tools: [
    noaaMarineFindStations,
    noaaMarineGetTidePredictions,
    noaaMarineGetWaterLevel,
    noaaMarineGetMonthlyMeans,
    noaaMarineGetCurrents,
    noaaMarineGetConditions,
    noaaMarineGetCurrentProfile,
    noaaMarineGetOceanObservations,
  ],
  resources: [noaaMarineStationResource],
  prompts: [],
  skills: 'skills',
  cacheHints: {
    'tools/list': { ttlMs: 86_400_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 86_400_000, cacheScope: 'public' },
    'resources/templates/list': { ttlMs: 86_400_000, cacheScope: 'public' },
  },
  instructions: `NOAA CO-OPS provides tide and tidal-current predictions and observed water levels. CO-OPS heights default to MLLW, the US nautical chart datum. NDBC provides the latest buoy observations. Read observed_at, observation_age_minutes, and any notice before using them as current conditions. Use noaa_marine_find_stations to resolve coordinates, station names, or station numbers to IDs. Geocode a town or marina before searching by coordinates. The types filter identifies candidate stations for each product. Use the station ID from the data tool's source. noaa_marine_get_conditions also accepts a 7-digit CO-OPS ID when an NDBC station relays that gauge's weather sensors. noaa_marine_get_currents returns CO-OPS tidal-current predictions. noaa_marine_get_current_profile returns the latest NDBC ADCP measurement.`,

  setup(core) {
    const serverConfig = getServerConfig();
    initCoopsService(core.config, core.storage, serverConfig);
    initNdbcService();
  },
});
