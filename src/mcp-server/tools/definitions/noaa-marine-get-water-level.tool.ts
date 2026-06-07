/**
 * @fileoverview noaa_marine_get_water_level tool — observed water levels with paired predictions.
 * @module mcp-server/tools/definitions/noaa-marine-get-water-level.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCoopsService, isCoopsBodyError } from '@/services/coops/coops-service.js';

function parseDateStr(s: string): Date {
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
}

export const noaaMarineGetWaterLevel = tool('noaa_marine_get_water_level', {
  title: 'Get Water Level',
  description:
    'Observed water level (real-time or historical) for a CO-OPS water-level station, with paired predictions for comparison. ' +
    'The difference (residual = observed − predicted) indicates storm surge (positive) or anomalous drawdown (negative). ' +
    'Returns 6-minute observations alongside 6-minute predictions. ' +
    'Date range is limited to 31 days per request; split longer ranges into multiple calls. ' +
    'Use noaa_marine_find_stations first to resolve a station name or location to a valid station ID.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    station_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,20}$/)
      .describe(
        'CO-OPS water-level station ID (numeric, e.g. "9447130" for Seattle). ' +
          'Obtain from noaa_marine_find_stations with types=["water_level"].',
      ),
    begin_date: z
      .string()
      .regex(/^\d{8}$/)
      .describe('Start date in YYYYMMDD format, e.g. "20240601".'),
    end_date: z
      .string()
      .regex(/^\d{8}$/)
      .describe('End date in YYYYMMDD format (inclusive), e.g. "20240601".'),
    datum: z
      .enum(['MLLW', 'MHHW', 'MSL', 'MTL', 'MHW', 'MLW', 'CD', 'STND'])
      .default('MLLW')
      .describe(
        'Tidal datum reference plane. MLLW (default) is the US nautical chart datum. ' +
          'MSL = mean sea level; MHHW = mean higher high water (flooding reference).',
      ),
    time_zone: z
      .enum(['lst_ldt', 'gmt', 'lst'])
      .default('lst_ldt')
      .describe(
        'Time zone for returned timestamps. lst_ldt = local standard/daylight time (default); ' +
          'gmt = UTC; lst = local standard time year-round.',
      ),
    units: z
      .enum(['english', 'metric'])
      .default('english')
      .describe('Unit system: english = feet; metric = meters.'),
  }),

  output: z.object({
    station_id: z.string().describe('Station ID echoed from the request — for chaining.'),
    station_name: z.string().describe('Station name as returned by CO-OPS.'),
    datum: z
      .string()
      .describe('Tidal datum used — echoed for correct interpretation of water heights.'),
    units: z.string().describe('Height units: "english" (feet) or "metric" (meters).'),
    observations: z
      .array(
        z
          .object({
            time: z.string().describe('Observation datetime in the requested time zone.'),
            value: z
              .number()
              .describe('Observed water height in the requested units relative to the datum.'),
            sigma: z
              .number()
              .optional()
              .describe('Standard deviation of the water level sensor reading.'),
            quality: z.string().describe('Quality flag: p = preliminary, v = verified.'),
          })
          .describe('A single 6-minute observed water level reading.'),
      )
      .describe('6-minute observed water level readings.'),
    predictions: z
      .array(
        z
          .object({
            time: z.string().describe('Prediction datetime matching the observation time step.'),
            value: z
              .number()
              .describe('Predicted water height in the requested units relative to the datum.'),
          })
          .describe('A single 6-minute tide prediction.'),
      )
      .describe(
        'Paired 6-minute tide predictions for the same period. May be empty if CO-OPS predictions are unavailable for this station.',
      ),
    residual_summary: z
      .object({
        max_surge: z
          .number()
          .describe(
            'Maximum positive residual (observed − predicted) in the requested units (feet for english, meters for metric) — storm surge indicator.',
          ),
        max_drawdown: z
          .number()
          .describe(
            'Maximum negative residual magnitude in the requested units (feet for english, meters for metric) — anomalous drawdown indicator.',
          ),
      })
      .optional()
      .describe(
        'Summary of observed-minus-predicted residuals in the requested units. Only present when both observations and predictions are available.',
      ),
  }),

  errors: [
    {
      reason: 'station_not_found',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'CO-OPS returned an error for the station ID.',
      recovery:
        'Use noaa_marine_find_stations with types=["water_level"] to obtain a valid station ID.',
    },
    {
      reason: 'date_range_exceeded',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Requested date range exceeds the 31-day CO-OPS limit for 6-minute water level data.',
      recovery: 'Split the request into multiple calls each spanning at most 31 days.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Station exists but no observed water-level data for the date range.',
      recovery:
        'The station may be offline or the date range may be in the future. Try a different date range or station.',
    },
  ],

  async handler(input, ctx) {
    // Validate date range ≤ 31 days
    const begin = parseDateStr(input.begin_date);
    const end = parseDateStr(input.end_date);
    const diffDays = (end.getTime() - begin.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 31) {
      throw ctx.fail(
        'date_range_exceeded',
        `Date range of ${Math.ceil(diffDays)} days exceeds the 31-day limit for 6-minute water level data.`,
        { ...ctx.recoveryFor('date_range_exceeded') },
      );
    }

    const svc = getCoopsService();
    const params = {
      station: input.station_id,
      begin_date: input.begin_date,
      end_date: input.end_date,
      datum: input.datum,
      time_zone: input.time_zone,
      units: input.units,
    };

    // Fetch observed water level and predictions in parallel
    const [obsResult, predResult] = await Promise.allSettled([
      svc.fetchWaterLevel(params, ctx),
      svc.fetchWaterLevelPredictions(params, ctx),
    ]);

    if (obsResult.status === 'rejected') {
      const err = obsResult.reason;
      // CO-OPS body-level errors carry a typed coopsReason — map to contract reasons.
      if (isCoopsBodyError(err)) {
        if (err.coopsReason === 'no_data' || err.coopsReason === 'no_predictions') {
          throw ctx.fail(
            'no_data',
            `No water level data for station ${input.station_id} in the requested date range.`,
            { ...ctx.recoveryFor('no_data') },
          );
        }
        // station_error → station_not_found
        throw ctx.fail(
          'station_not_found',
          `CO-OPS does not have data for station ${input.station_id} — use noaa_marine_find_stations with types=["water_level"] to verify the ID.`,
          { ...ctx.recoveryFor('station_not_found') },
        );
      }
      // CO-OPS HTTP 400 — invalid station ID before response body is parsed.
      if (err instanceof McpError) {
        const statusCode = (err.data as Record<string, unknown> | undefined)?.statusCode;
        if (statusCode === 400) {
          throw ctx.fail(
            'station_not_found',
            `CO-OPS rejected station ${input.station_id} — use noaa_marine_find_stations with types=["water_level"] to verify the ID.`,
            { ...ctx.recoveryFor('station_not_found') },
          );
        }
      }
      throw err;
    }

    const { data: rawObs, stationName } = obsResult.value;

    if (!rawObs || rawObs.length === 0) {
      throw ctx.fail(
        'no_data',
        `No water level data for station ${input.station_id} in the requested date range.`,
        { ...ctx.recoveryFor('no_data') },
      );
    }

    const observations = rawObs.map((row) => {
      const entry: { time: string; value: number; sigma?: number; quality: string } = {
        time: row.t,
        value: Number.parseFloat(row.v),
        quality: row.q ?? 'p',
      };
      if (row.s) {
        const sigma = Number.parseFloat(row.s);
        if (!Number.isNaN(sigma)) entry.sigma = sigma;
      }
      return entry;
    });

    const rawPred = predResult.status === 'fulfilled' ? predResult.value : [];
    const predictions = rawPred.map((p) => ({
      time: p.t,
      value: Number.parseFloat(p.v),
    }));

    // Compute residual summary when both series are present
    let residualSummary: { max_surge: number; max_drawdown: number } | undefined;
    if (observations.length > 0 && predictions.length > 0) {
      const predMap = new Map(predictions.map((p) => [p.time, p.value]));
      const residuals: number[] = [];
      for (const obs of observations) {
        const pred = predMap.get(obs.time);
        if (pred !== undefined) residuals.push(obs.value - pred);
      }
      if (residuals.length > 0) {
        const maxSurge = Math.max(...residuals);
        const maxDrawdown = Math.abs(Math.min(...residuals));
        residualSummary = {
          max_surge: Math.round(maxSurge * 100) / 100,
          max_drawdown: Math.round(maxDrawdown * 100) / 100,
        };
      }
    }

    ctx.log.info('Water level data fetched', {
      station_id: input.station_id,
      obs_count: observations.length,
      pred_count: predictions.length,
    });

    return {
      station_id: input.station_id,
      station_name: stationName,
      datum: input.datum,
      units: input.units,
      observations,
      predictions,
      ...(residualSummary ? { residual_summary: residualSummary } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Water Level — ${result.station_name} (${result.station_id})`,
      `**Datum:** ${result.datum} · **Units:** ${result.units}`,
    ];

    if (result.residual_summary) {
      const unitLabel = result.units === 'metric' ? 'm' : 'ft';
      lines.push(
        `**Max surge:** ${result.residual_summary.max_surge} ${unitLabel} · **Max drawdown:** ${result.residual_summary.max_drawdown} ${unitLabel}`,
      );
    }

    lines.push('', `**Observations** (${result.observations.length} records):`);
    const obsToShow = result.observations.slice(0, 10);
    for (const o of obsToShow) {
      const sig = o.sigma !== undefined ? ` ±${o.sigma}` : '';
      lines.push(
        `${o.time}: ${o.value} ${result.units === 'metric' ? 'm' : 'ft'}${sig} [${o.quality}]`,
      );
    }
    if (result.observations.length > 10) {
      lines.push(`... and ${result.observations.length - 10} more observations`);
    }

    if (result.predictions.length > 0) {
      lines.push('', `**Predictions** (${result.predictions.length} records):`);
      const predToShow = result.predictions.slice(0, 5);
      for (const p of predToShow) {
        lines.push(`${p.time}: ${p.value} ${result.units === 'metric' ? 'm' : 'ft'} (predicted)`);
      }
      if (result.predictions.length > 5) {
        lines.push(`... and ${result.predictions.length - 5} more predictions`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
