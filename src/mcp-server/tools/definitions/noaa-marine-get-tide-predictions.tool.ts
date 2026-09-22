/**
 * @fileoverview noaa_marine_get_tide_predictions tool — high/low tide predictions from CO-OPS.
 * @module mcp-server/tools/definitions/noaa-marine-get-tide-predictions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCoopsService, isCoopsBodyError } from '@/services/coops/coops-service.js';
import { COOPS_DATE_FORM, validateCoopsDateRange } from '@/services/coops/date-range.js';
import { isSubordinateTideStation } from '@/services/coops/prediction-class.js';
import { pageDisclosure, pageNotice, pageRows } from '@/services/coops/row-page.js';

export const noaaMarineGetTidePredictions = tool('noaa_marine_get_tide_predictions', {
  title: 'Get Tide Predictions',
  description: `High and low tide predictions for a CO-OPS tide station over a date range. The default hilo interval returns the time, height, and tide type (H for high, L for low) of each event, while the 6-minute interval returns the detailed tide curve. Most tide stations are subordinate — CO-OPS derives their high and low events as offsets from a reference station and publishes no 6-minute curve for them — so interval="6min" reaches only a reference station, and a subordinate station comes back as subordinate_no_6min naming the reference station to ask instead; the prediction_class on a noaa_marine_find_stations tide row says which kind a station is before the call. Datum defaults to MLLW, mean lower low water, the standard for US nautical charts, and the date range is limited to 1 year per request. A range whose predictions fit the response budget is returned whole; a longer one is returned as a page of leading rows, and rows_matched, rows_returned, and next_offset then report how much matched and which offset reaches the rest, so a year of events is read by walking offset rather than by splitting the range. Use noaa_marine_find_stations first to resolve a station name or location to a numeric station ID.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    station_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,20}$/)
      .describe(
        'CO-OPS tide station ID (numeric, e.g. "9447130" for Seattle). ' +
          'Obtain from noaa_marine_find_stations with types=["tide"].',
      ),
    begin_date: z
      .string()
      .regex(COOPS_DATE_FORM, 'Must be YYYYMMDD or YYYY-MM-DD, e.g. "20240601" or "2024-06-01".')
      .describe('Start date, YYYYMMDD or YYYY-MM-DD, e.g. "20240601" or "2024-06-01".'),
    end_date: z
      .string()
      .regex(COOPS_DATE_FORM, 'Must be YYYYMMDD or YYYY-MM-DD, e.g. "20240607" or "2024-06-07".')
      .describe('End date (inclusive), YYYYMMDD or YYYY-MM-DD, e.g. "20240607" or "2024-06-07".'),
    datum: z
      .enum(['MLLW', 'MHHW', 'MHW', 'MTL', 'MSL', 'MLW', 'DTL', 'NAVD', 'STND', 'CRD'])
      .default('MLLW')
      .describe(
        "Datum the predicted heights are referenced to. MLLW (default) is the US nautical chart datum, and MHHW (mean higher high water) is the flooding reference; MHW, MTL, MSL, MLW, and DTL (diurnal tide level) are the other tidal planes. NAVD is NAVD88 and reads only where the station has an NAVD88 tie. STND is the station's own datum and is the plane that works where no tidal datum exists. CRD applies at Columbia River stations only. A datum this station does not carry comes back as datum_unavailable naming the ones it does.",
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
      .describe('Unit system for heights: english = feet; metric = meters.'),
    interval: z
      .enum(['hilo', '6min'])
      .default('hilo')
      .describe(
        'Prediction interval: hilo (default) returns only high and low tide events; 6min returns a continuous prediction curve at 6-minute intervals, and is served only by a reference station — a subordinate station has no 6-minute curve.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Row offset into the matched prediction series, for reading a range whose rows do not fit one response. 0 (default) starts at the first row; pass the next_offset from a previous call to continue. An offset past the last row returns an empty page rather than an error.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Maximum prediction rows to return on this page, for a caller that wants fewer than the response budget allows. Omit for the largest page that fits; a value larger than the budget allows does not widen the page.',
      ),
  }),

  output: z.object({
    station_id: z.string().describe('Station ID echoed from the request — for chaining.'),
    station_name: z
      .string()
      .describe('Station name as returned by CO-OPS — confirms the correct station was queried.'),
    datum: z
      .string()
      .describe('Tidal datum used (e.g. MLLW) — echoed for correct interpretation of heights.'),
    units: z.string().describe('Height units: "english" (feet) or "metric" (meters).'),
    predictions: z
      .array(
        z
          .object({
            time: z
              .string()
              .describe(
                'Prediction datetime in the requested time zone (YYYY-MM-DD HH:MM format).',
              ),
            height: z
              .number()
              .describe(
                'Predicted water height in the requested units (feet or meters) relative to the datum.',
              ),
            type: z
              .string()
              .optional()
              .describe('Tide type: H = high tide, L = low tide (only present for hilo interval).'),
          })
          .describe('A single tide prediction event.'),
      )
      .describe(
        'Tide predictions for the requested date range — the whole series when it fits one response, otherwise the leading page starting at offset. rows_matched and next_offset report what a page left behind.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'What this page of the prediction series covers and how to reach the next one. Present only when the response is a page rather than the whole matched series.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when this page stops short of the last matched row, so further rows remain at next_offset. False on the final page and on a page past the end. Absent when the whole matched series was returned.',
      ),
    rows_matched: z
      .number()
      .int()
      .optional()
      .describe(
        'Prediction rows the requested date range matched, before the page was cut. Absent when the whole matched series was returned.',
      ),
    rows_returned: z
      .number()
      .int()
      .optional()
      .describe(
        'Prediction rows this page carries — the length of predictions. Absent when the whole matched series was returned.',
      ),
    page_offset: z
      .number()
      .int()
      .optional()
      .describe(
        'Row offset this page starts at, echoed from the request. Absent when the whole matched series was returned.',
      ),
    next_offset: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe(
        'Offset to pass as offset on the next call, or null when this page reaches the last matched row. Absent when the whole matched series was returned.',
      ),
  },

  errors: [
    {
      reason: 'station_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'CO-OPS returned an error for the station ID — likely wrong type or invalid ID.',
      recovery:
        'Use noaa_marine_find_stations with types=["tide"] to obtain a valid tide station ID.',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'begin_date/end_date is not a real calendar date or begin_date is after end_date',
      recovery:
        'Provide begin_date and end_date as real calendar dates, each as YYYYMMDD or YYYY-MM-DD, with begin_date on or before end_date.',
    },
    {
      reason: 'date_range_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Requested date range exceeds the 1-year CO-OPS limit.',
      recovery: 'Split the request into multiple calls each spanning at most 1 year.',
    },
    {
      reason: 'no_predictions',
      code: JsonRpcErrorCode.NotFound,
      when: 'Station exists but CO-OPS returned no prediction data for the date range.',
      recovery:
        'The station may be inactive or not a prediction station. Try a different station ID from noaa_marine_find_stations.',
    },
    {
      reason: 'subordinate_no_6min',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'interval="6min" was requested for a subordinate station, whose predictions are high and low events derived from a reference station.',
      recovery:
        'Call again with interval="hilo" for this station, or request interval="6min" from the reference station its predictions are derived from.',
    },
    {
      reason: 'datum_unavailable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The station does not carry the requested datum — NAVD reads only where the station has an NAVD88 tie, and CRD only on the Columbia River.',
      recovery:
        'Retry with a datum this station carries — MLLW is the plane every prediction station publishes, and the runtime hint names the alternatives.',
    },
    {
      reason: 'upstream_throttled',
      code: JsonRpcErrorCode.RateLimited,
      when: 'CO-OPS answered HTTP 403, which it returns for about two minutes while it throttles a burst of requests from one address.',
      recovery:
        'The block is temporary. Wait a couple of minutes before calling again, and space successive CO-OPS calls rather than sending them back to back.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    // Validate dates locally before calling CO-OPS — impossible calendar dates and
    // reversed ranges would otherwise return an HTTP 400 that reads as station_not_found.
    const range = validateCoopsDateRange(input.begin_date, input.end_date);
    if (!range.ok) {
      throw ctx.fail('invalid_date_range', range.error, {
        ...ctx.recoveryFor('invalid_date_range'),
      });
    }
    if (range.spanDays > 365) {
      throw ctx.fail(
        'date_range_exceeded',
        `Date range of ${Math.ceil(range.spanDays)} days exceeds the 1-year limit.`,
        { ...ctx.recoveryFor('date_range_exceeded') },
      );
    }

    const svc = getCoopsService();

    // The catalog row carries both the display name and the prediction class, and the class
    // decides whether CO-OPS can answer a 6-minute request at all — it rejects a subordinate
    // station's with the same message an unaccepted datum produces, so the failure text alone
    // cannot separate the two. Read it before spending the data call. Best-effort, as ever:
    // a catalog that could not be read falls through to CO-OPS rather than blocking.
    const [tideStations] = await Promise.allSettled([svc.getStations('tidepredictions', ctx)]);
    const stationMeta =
      tideStations.status === 'fulfilled'
        ? tideStations.value.find((s) => s.id === input.station_id)
        : undefined;

    if (input.interval === '6min' && isSubordinateTideStation(stationMeta?.type)) {
      const referenceId = stationMeta?.reference_id;
      throw ctx.fail(
        'subordinate_no_6min',
        `Station ${input.station_id} is a subordinate tide station — CO-OPS derives its high and low events from a reference station and publishes no 6-minute curve for it.`,
        {
          // The station and its reference station are runtime context, so the hint names them
          // rather than resolving the contract's generic wording.
          recovery: {
            hint: referenceId
              ? `Retry with interval="hilo" for ${input.station_id}, or request interval="6min" from its reference station ${referenceId}.`
              : `Retry with interval="hilo" for ${input.station_id} — no 6-minute curve exists for a subordinate station.`,
          },
        },
      );
    }

    const [predResult] = await Promise.allSettled([
      svc.fetchTidePredictions(
        {
          station: input.station_id,
          begin_date: range.beginDate,
          end_date: range.endDate,
          datum: input.datum,
          time_zone: input.time_zone,
          units: input.units,
          interval: input.interval,
        },
        ctx,
      ),
    ]);

    if (predResult.status === 'rejected') {
      const err = predResult.reason;
      // CO-OPS body-level errors carry a typed coopsReason — map to contract reasons.
      if (isCoopsBodyError(err)) {
        if (err.coopsReason === 'datum_unavailable') {
          throw ctx.fail(
            'datum_unavailable',
            `Station ${input.station_id} does not carry datum ${input.datum}.`,
            {
              // Which datums to try is station-specific, so the hint resolves the contract's
              // generic wording against the datum that was actually rejected.
              recovery: {
                hint:
                  input.datum === 'NAVD'
                    ? `Station ${input.station_id} has no NAVD88 tie. Retry with datum MLLW for chart-referenced heights, or STND for the station's own datum.`
                    : `Station ${input.station_id} does not carry datum ${input.datum}. Retry with datum MLLW, the US nautical chart datum, or STND, the station's own datum.`,
              },
            },
          );
        }
        if (err.coopsReason === 'great_lakes_no_predictions') {
          throw ctx.fail(
            'no_predictions',
            `CO-OPS publishes no tide predictions for station ${input.station_id}, a Great Lakes station.`,
            {
              // A real coverage fact about the whole class of station, not a bad ID and not a
              // datum to swap — the observed series is the only answer available there.
              recovery: {
                hint: `Great Lakes stations have no tide prediction series at any datum. Call noaa_marine_get_water_level for station ${input.station_id} instead, with datum STND, IGLD, or LWD.`,
              },
            },
          );
        }
        if (err.coopsReason === 'station_error') {
          throw ctx.fail(
            'station_not_found',
            `CO-OPS does not have data for station ${input.station_id} — use noaa_marine_find_stations with types=["tide"] to verify the ID.`,
            { ...ctx.recoveryFor('station_not_found') },
          );
        }
        // no_data, no_predictions, predictions_unavailable — the station is known and its
        // prediction series is not there, which is not a reason to re-verify the ID.
        throw ctx.fail(
          'no_predictions',
          `No tide prediction data for station ${input.station_id} — the station may be the wrong type or inactive.`,
          { ...ctx.recoveryFor('no_predictions') },
        );
      }
      // CO-OPS HTTP 400 — invalid/unknown station ID before response body is parsed.
      if (err instanceof McpError) {
        const status = (err.data as Record<string, unknown> | undefined)?.status;
        if (status === 400) {
          throw ctx.fail(
            'station_not_found',
            `CO-OPS rejected station ${input.station_id} — use noaa_marine_find_stations with types=["tide"] to verify the ID.`,
            { ...ctx.recoveryFor('station_not_found') },
          );
        }
      }
      throw err;
    }

    const result = predResult.value;

    if (!result.predictions || result.predictions.length === 0) {
      throw ctx.fail(
        'no_predictions',
        `No predictions returned for station ${input.station_id} in the requested date range.`,
        { ...ctx.recoveryFor('no_predictions') },
      );
    }

    const predictions = result.predictions.map((p) => {
      const entry: { time: string; height: number; type?: string } = {
        time: p.t,
        height: Number.parseFloat(p.v),
      };
      if (p.type) entry.type = p.type;
      return entry;
    });

    /*
     * hilo crosses the response budget near four months and the 6-minute curve inside a
     * single day, so the bound keys on serialized size rather than on the interval. A range
     * that fits comes back whole and says nothing; anything longer is a page that discloses
     * what it left behind.
     */
    const page = pageRows(predictions, {
      offset: input.offset,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    if (!page.whole) {
      ctx.enrich(pageDisclosure(page));
      ctx.enrich.notice(pageNotice(page, 'predictions'));
    }

    ctx.log.info('Tide predictions fetched', {
      station_id: input.station_id,
      count: page.rows.length,
      matched: page.matched,
      interval: input.interval,
    });

    return {
      station_id: input.station_id,
      station_name: stationMeta?.name ?? result.stationName,
      datum: input.datum,
      units: input.units,
      predictions: page.rows,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Tide Predictions — ${result.station_name} (${result.station_id})`,
      `**Datum:** ${result.datum} · **Units:** ${result.units}`,
      '',
    ];

    for (const p of result.predictions) {
      const typeStr = p.type
        ? ` [${p.type === 'H' ? 'HIGH' : p.type === 'L' ? 'LOW' : p.type}]`
        : '';
      lines.push(`${p.time}${typeStr}: ${p.height} ${result.units === 'metric' ? 'm' : 'ft'}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
