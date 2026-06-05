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
import { noaaMarineGetCurrents } from './mcp-server/tools/definitions/noaa-marine-get-currents.tool.js';
import { noaaMarineGetTidePredictions } from './mcp-server/tools/definitions/noaa-marine-get-tide-predictions.tool.js';
import { noaaMarineGetWaterLevel } from './mcp-server/tools/definitions/noaa-marine-get-water-level.tool.js';
import { initCoopsService } from './services/coops/coops-service.js';
import { initNdbcService } from './services/ndbc/ndbc-service.js';

await createApp({
  tools: [
    noaaMarineFindStations,
    noaaMarineGetTidePredictions,
    noaaMarineGetWaterLevel,
    noaaMarineGetCurrents,
    noaaMarineGetConditions,
  ],
  resources: [noaaMarineStationResource],
  prompts: [],
  instructions:
    'US marine conditions via NOAA CO-OPS and NDBC. ' +
    'Start with noaa_marine_find_stations to resolve a location or name to station IDs, ' +
    'then call the appropriate data tool. ' +
    'CO-OPS provides tide predictions (noaa_marine_get_tide_predictions), ' +
    'observed water levels and storm surge (noaa_marine_get_water_level), ' +
    'and tidal current predictions (noaa_marine_get_currents). ' +
    'NDBC provides live buoy conditions — waves, wind, sea-surface temp (noaa_marine_get_conditions). ' +
    'All water height data is referenced to MLLW by default (US nautical chart datum).',

  setup(core) {
    const serverConfig = getServerConfig();
    initCoopsService(core.config, core.storage, serverConfig);
    initNdbcService();
  },
});
