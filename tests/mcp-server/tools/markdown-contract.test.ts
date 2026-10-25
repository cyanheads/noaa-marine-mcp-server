/**
 * @fileoverview Regression coverage for literal upstream text in tool renderers.
 * @module tests/mcp-server/tools/markdown-contract.test
 */
import { describe, expect, it } from 'vitest';
import { noaaMarineFindStations } from '@/mcp-server/tools/definitions/noaa-marine-find-stations.tool.js';
import { noaaMarineGetConditions } from '@/mcp-server/tools/definitions/noaa-marine-get-conditions.tool.js';
import { noaaMarineGetCurrentProfile } from '@/mcp-server/tools/definitions/noaa-marine-get-current-profile.tool.js';
import { noaaMarineGetCurrents } from '@/mcp-server/tools/definitions/noaa-marine-get-currents.tool.js';
import { noaaMarineGetMonthlyMeans } from '@/mcp-server/tools/definitions/noaa-marine-get-monthly-means.tool.js';
import { noaaMarineGetOceanObservations } from '@/mcp-server/tools/definitions/noaa-marine-get-ocean-observations.tool.js';
import { noaaMarineGetTidePredictions } from '@/mcp-server/tools/definitions/noaa-marine-get-tide-predictions.tool.js';
import { noaaMarineGetWaterLevel } from '@/mcp-server/tools/definitions/noaa-marine-get-water-level.tool.js';

const name = 'Buoy *West* [dock] <b>';
const identity = { station_id: '44033', station_name: name, units: 'metric', datum: 'MLLW' };
const observations = {
  ...identity,
  latitude: 44,
  longitude: -68,
  observed_at: '2026-10-24T00:00:00Z',
  source: 'ndbc',
};

describe('literal station names in Markdown', () => {
  const cases = [
    [
      'stations',
      () =>
        noaaMarineFindStations.format!({
          total_found: 1,
          stations: [
            {
              station_id: '44033',
              name,
              source: 'ndbc',
              latitude: 44,
              longitude: -68,
              capabilities: [],
            },
          ],
        }),
    ],
    ['tides', () => noaaMarineGetTidePredictions.format!({ ...identity, predictions: [] })],
    [
      'water levels',
      () =>
        noaaMarineGetWaterLevel.format!({
          ...identity,
          interval: '6min',
          observations: [],
          predictions: [],
        }),
    ],
    [
      'monthly means',
      () =>
        noaaMarineGetMonthlyMeans.format!({
          ...identity,
          begin_date: '20260101',
          end_date: '20260131',
          months: [],
        }),
    ],
    [
      'currents',
      () => noaaMarineGetCurrents.format!({ ...identity, bin: null, depth: null, events: [] }),
    ],
    [
      'conditions',
      () =>
        noaaMarineGetConditions.format!({
          ...observations,
          wind_direction_deg: null,
          wind_speed_ms: null,
          gust_speed_ms: null,
          wave_height_m: null,
          dominant_period_sec: null,
          average_period_sec: null,
          mean_wave_direction_deg: null,
          waves_observed_at: null,
          pressure_hpa: null,
          air_temp_c: null,
          water_temp_c: null,
          dew_point_c: null,
          visibility_nmi: null,
          tide_ft: null,
        }),
    ],
    [
      'current profile',
      () => noaaMarineGetCurrentProfile.format!({ ...observations, bin_count: 0, bins: [] }),
    ],
    [
      'ocean observations',
      () =>
        noaaMarineGetOceanObservations.format!({ ...observations, reading_count: 0, readings: [] }),
    ],
  ] as const;
  it.each(cases)('%s escapes upstream Markdown syntax', (_, render) => {
    const text = render()
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('Buoy \\*West\\* \\[dock\\] \\<b>');
    expect(text).toContain('44033');
  });
});

describe('literal enrichment text in Markdown', () => {
  it('escapes caller queries in the applied-search trailer', () => {
    const query = '*west* [dock] <b>';
    const applied = { source: 'ndbc', catalogs_read: ['ndbc'], query };
    const rendered = noaaMarineFindStations.enrichmentTrailer!.applied_search!.render!(applied);
    expect(rendered).toContain('query="\\*west\\* \\[dock\\] \\<b>"');
    expect(applied.query).toBe('*west* [dock] <b>');
  });

  it.each([
    ['station search', noaaMarineFindStations.enrichmentTrailer!.notice!.render!],
    ['current statement', noaaMarineGetCurrents.enrichmentTrailer!.notice!.render!],
  ] as const)('%s preserves the notice blockquote and escapes data once', (_, render) => {
    expect(render('NOAA says *weak* [flow] <b>')).toBe('> NOAA says \\*weak\\* \\[flow\\] \\<b>');
  });
});
