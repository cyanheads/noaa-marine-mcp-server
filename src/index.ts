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
  cacheHints: {
    'tools/list': { ttlMs: 86_400_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 86_400_000, cacheScope: 'public' },
    'resources/templates/list': { ttlMs: 86_400_000, cacheScope: 'public' },
  },
  instructions: `US marine conditions from NOAA CO-OPS and NDBC: CO-OPS is coastal-gauge tide and tidal-current predictions plus observed water levels, NDBC is live buoy observation, and every water height is referenced to MLLW, the US nautical chart datum, unless another datum is requested. Start with noaa_marine_find_stations to resolve a place name, a coordinate pair, or a bare station number to a station ID — its types filter names what each station can serve, and an ID from one source never works on a tool that reads the other. That source split is also what separates the two current tools: noaa_marine_get_currents returns CO-OPS tidal-current predictions, noaa_marine_get_current_profile an observed NDBC ADCP measurement.`,

  setup(core) {
    const serverConfig = getServerConfig();
    initCoopsService(core.config, core.storage, serverConfig);
    initNdbcService();
  },
});
