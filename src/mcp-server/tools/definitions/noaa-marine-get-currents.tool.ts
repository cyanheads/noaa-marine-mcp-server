/**
 * @fileoverview noaa_marine_get_currents tool — tidal current predictions from CO-OPS.
 * @module mcp-server/tools/definitions/noaa-marine-get-currents.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCoopsService, isCoopsBodyError } from '@/services/coops/coops-service.js';
import { COOPS_DATE_FORM, validateCoopsDateRange } from '@/services/coops/date-range.js';
import { pageDisclosure, pageNotice, pageRows } from '@/services/coops/row-page.js';
import type { CoopsCurrent6MinRow, CoopsCurrentRow } from '@/services/coops/types.js';

/** Flow sense of a predicted current, shared by the event and 6-minute surfaces. */
type FlowSense = 'flood' | 'ebb' | 'slack';

/**
 * The bin and depth CO-OPS stamped on the rows it answered with. Every row of one response
 * carries the same pair, so the first row is the whole echo; a response with no rows, or a
 * bin CO-OPS publishes no depth for, echoes null rather than a substituted zero.
 */
function binEcho(rows: readonly { Bin?: string; Depth?: string | null }[]): {
  bin: number | null;
  depth: number | null;
} {
  const first = rows[0];
  const bin = first?.Bin !== undefined ? Number.parseInt(first.Bin, 10) : Number.NaN;
  const depth = first?.Depth != null ? Number.parseFloat(first.Depth) : Number.NaN;
  return {
    bin: Number.isFinite(bin) ? bin : null,
    depth: Number.isFinite(depth) ? depth : null,
  };
}

/**
 * Flow sense from the signed speed CO-OPS predicts along the major axis: positive floods,
 * negative ebbs, exactly zero is slack water.
 */
function flowSense(velocity: number): FlowSense {
  if (velocity > 0) return 'flood';
  if (velocity < 0) return 'ebb';
  return 'slack';
}

/**
 * The station mean bearing the flow sense implies. CO-OPS reports a mean flood and a mean
 * ebb direction on every row and no instantaneous heading, so a flood row reads the former
 * and an ebb row the latter; slack has neither, and a row missing the value keeps none
 * rather than inventing a 0° bearing.
 */
function meanBearing(row: CoopsCurrent6MinRow | CoopsCurrentRow, sense: FlowSense): number | null {
  const bearing = sense === 'flood' ? row.meanFloodDir : sense === 'ebb' ? row.meanEbbDir : null;
  return bearing ?? null;
}

export const noaaMarineGetCurrents = tool('noaa_marine_get_currents', {
  title: 'Get Tidal Currents',
  description: `Tidal current predictions for a CO-OPS current station: max flood and ebb speeds, slack times, and the station's mean flood and ebb bearings. These are forecast predictions from CO-OPS, distinct from noaa_marine_get_current_profile, which returns NDBC observed ocean-current measurements binned by depth. The default MAX_SLACK interval is the practical planning view, showing when currents peak and when slack water occurs, and a 6-minute interval returns the continuous curve for detailed analysis, each row carrying its own flood/ebb/slack sense. A station can publish predictions for several depth bins at different depths: bin selects one, omitting it takes the CO-OPS default of the shallowest bin, and the bin and its depth are echoed on every response — read bins[] on a noaa_marine_find_stations current row for the bins a station actually has. A station whose currents CO-OPS will not predict as discrete events answers with an empty list and its own wording in the notice rather than an error. Both intervals are bounded by response size: a range whose rows fit is returned whole, a longer one returns the leading rows with rows_matched, rows_returned, and next_offset reporting how much matched and which offset reaches the rest, and offset and limit walk whichever series the interval selects. Current station IDs are alphanumeric (e.g. ACT4176), distinct from the numeric tide and water-level IDs, and the date range is limited to 1 year per request — use noaa_marine_find_stations with types=["current"] to obtain a valid current station ID.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    station_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,20}$/)
      .describe(
        'CO-OPS current station ID (alphanumeric, e.g. "ACT4176"). ' +
          'Obtain from noaa_marine_find_stations with types=["current"].',
      ),
    begin_date: z
      .string()
      .regex(COOPS_DATE_FORM, 'Must be YYYYMMDD or YYYY-MM-DD, e.g. "20240601" or "2024-06-01".')
      .describe('Start date, YYYYMMDD or YYYY-MM-DD, e.g. "20240601" or "2024-06-01".'),
    end_date: z
      .string()
      .regex(COOPS_DATE_FORM, 'Must be YYYYMMDD or YYYY-MM-DD, e.g. "20240607" or "2024-06-07".')
      .describe('End date (inclusive), YYYYMMDD or YYYY-MM-DD, e.g. "20240607" or "2024-06-07".'),
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
      .describe(
        'Unit system: english = knots for speed and feet for the echoed depth; metric = cm/s for speed (not m/s) and meters for the echoed depth.',
      ),
    interval: z
      .enum(['MAX_SLACK', '6min'])
      .default('MAX_SLACK')
      .describe(
        'Prediction interval: MAX_SLACK (default) returns max flood, max ebb, and slack water events — ' +
          'ideal for passage planning. 6min returns a continuous current curve.',
      ),
    bin: z
      .number()
      .int()
      .optional()
      .describe(
        'Depth bin to predict for, taken from the bins[] array on a noaa_marine_find_stations current row (e.g. 15, 10 or 1 at PUG1515). Omit to take the CO-OPS default, which is the shallowest bin. A bin the station does not publish comes back as bin_unavailable naming the bins it does.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Row offset into the matched prediction series — the max/slack events on the MAX_SLACK interval, the 6-minute curve on 6min — for reading a range whose rows do not fit one response. 0 (default) starts at the first row; pass the next_offset from a previous call to continue. An offset past the last row returns an empty page rather than an error.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Maximum prediction rows to return on this page — max/slack events or 6-minute rows, whichever the interval selects — for a caller that wants fewer than the response budget allows. Omit for the largest page that fits; a value larger than the budget allows does not widen the page.',
      ),
  }),

  output: z.object({
    station_id: z.string().describe('Station ID echoed from the request — for chaining.'),
    station_name: z.string().describe('Station name as returned by CO-OPS.'),
    units: z
      .string()
      .describe(
        'Unit system these values are in: "english" (speed in knots, depth in feet) or "metric" (speed in cm/s, depth in meters).',
      ),
    bin: z
      .number()
      .nullable()
      .describe(
        'Depth bin CO-OPS answered with — the requested bin, or its default shallowest bin when none was requested. Null when the response carried no prediction rows.',
      ),
    depth: z
      .number()
      .nullable()
      .describe(
        'Depth of the returned bin, in the requested units: feet under english, meters under metric. Distinct from the bins[].depth on a noaa_marine_find_stations row, which the catalog always publishes in feet. Null when CO-OPS publishes no depth for the bin, or when the response carried no prediction rows.',
      ),
    events: z
      .array(
        z
          .object({
            time: z.string().describe('Event datetime in the requested time zone.'),
            type: z
              .enum(['flood', 'ebb', 'slack'])
              .describe(
                'Current event type: flood (onshore/inbound flow), ebb (offshore/outbound flow), or slack (near-zero current).',
              ),
            speed: z
              .number()
              .optional()
              .describe(
                'Peak speed as a non-negative magnitude, in the requested units. Absent when CO-OPS reports no speed for the event, which is the usual case at slack water — though a slack event can carry a small residual speed under metric units.',
              ),
            direction: z
              .number()
              .optional()
              .describe(
                "The station's mean flood direction on a flood event and its mean ebb direction on an ebb event, as a true bearing in degrees (0–360). A station constant, not an instantaneous heading. Absent for slack events and wherever CO-OPS reports no mean direction.",
              ),
          })
          .describe('A single max flood, max ebb, or slack current event.'),
      )
      .optional()
      .describe(
        'Max flood, max ebb, and slack events — the whole matched series when it fits one response, otherwise the leading page starting at offset. Present for MAX_SLACK interval, and empty when CO-OPS answered with a statement instead of events — read notice for its wording.',
      ),
    predictions: z
      .array(
        z
          .object({
            time: z.string().describe('Prediction datetime in the requested time zone.'),
            type: z
              .enum(['flood', 'ebb', 'slack'])
              .describe(
                'Flow sense at this row, from the sign of the speed CO-OPS predicts: flood (inbound), ebb (outbound), or slack (zero). speed is a non-negative magnitude, so this is what carries which way the water is moving.',
              ),
            speed: z
              .number()
              .describe('Current speed as a non-negative magnitude, in the requested units.'),
            direction: z
              .number()
              .nullable()
              .describe(
                "The station's mean flood direction on a flood row and its mean ebb direction on an ebb row, as a true bearing in degrees (0–360). A station constant, not an instantaneous heading. Null on a slack row and wherever CO-OPS reports no mean direction.",
              ),
          })
          .describe('A single 6-minute current prediction.'),
      )
      .optional()
      .describe(
        '6-minute continuous current predictions — the whole curve when it fits one response, otherwise the leading page starting at offset. Present for 6min interval, and empty when CO-OPS answered with a statement instead of a curve — read notice for its wording.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        "CO-OPS's own statement about the station when it returned that instead of prediction events — the answer to report, not a failure — or what this page of the prediction series covers and how to reach the next one.",
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
        'Prediction rows this page carries — the length of events on the MAX_SLACK interval, of predictions on 6min. Absent when the whole matched series was returned.',
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
      when: 'CO-OPS rejected the station ID as unknown or invalid — current stations require alphanumeric IDs.',
      recovery:
        'Use noaa_marine_find_stations with types=["current"] to obtain a valid current station ID like ACT4176.',
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
      when: 'Station exists but CO-OPS returned no current-prediction data for the requested date range.',
      recovery:
        'Request a different date range, or try another station from noaa_marine_find_stations with types=["current"].',
    },
    {
      reason: 'predictions_unavailable',
      code: JsonRpcErrorCode.NotFound,
      when: 'The station is in the current-predictions catalog, but CO-OPS publishes no current predictions for it at any date.',
      recovery:
        'Try the next nearest current station from noaa_marine_find_stations, preferring one whose bins[] report a harmonic prediction_class.',
    },
    {
      reason: 'bin_unavailable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'CO-OPS rejected the requested bin because the station publishes no predictions at that bin.',
      recovery:
        'Read the bins[] array on the station row from noaa_marine_find_stations and retry with one of those bin numbers, or omit bin to take the shallowest.',
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

    // Fetch station list (for name resolution) and predictions in parallel.
    // CO-OPS currents_predictions API does not return station metadata — station list is best-effort.
    const [currentStations, predResult] = await Promise.allSettled([
      svc.getStations('currentpredictions', ctx),
      svc.fetchCurrentPredictions(
        {
          station: input.station_id,
          begin_date: range.beginDate,
          end_date: range.endDate,
          time_zone: input.time_zone,
          units: input.units,
          interval: input.interval,
          ...(input.bin !== undefined ? { bin: input.bin } : {}),
        },
        ctx,
      ),
    ]);

    const stationMeta =
      currentStations.status === 'fulfilled'
        ? currentStations.value.find((s) => s.id === input.station_id)
        : undefined;

    if (predResult.status === 'rejected') {
      const err = predResult.reason;
      // CO-OPS body-level errors carry a typed coopsReason — map to contract reasons.
      if (isCoopsBodyError(err)) {
        if (err.coopsReason === 'bin_unavailable') {
          const bins = err.availableBins;
          throw ctx.fail(
            'bin_unavailable',
            `Station ${input.station_id} publishes no current predictions at bin ${input.bin}.`,
            {
              ...ctx.recoveryFor('bin_unavailable'),
              ...(bins && bins.length > 0
                ? {
                    available_bins: bins,
                    recovery: {
                      hint: `Station ${input.station_id} publishes bins ${bins.join(', ')} — retry with one of those, or omit bin to take the shallowest.`,
                    },
                  }
                : {}),
            },
          );
        }
        if (err.coopsReason === 'predictions_unavailable') {
          // A coverage statement about a station CO-OPS knows — the ID came from the
          // discovery tool, so the recovery must not send the caller back to re-check it.
          throw ctx.fail(
            'predictions_unavailable',
            `CO-OPS publishes no current predictions for station ${input.station_id}, though it is in the current-predictions catalog.`,
            { ...ctx.recoveryFor('predictions_unavailable') },
          );
        }
        if (err.coopsReason === 'no_predictions') {
          throw ctx.fail(
            'no_predictions',
            `No current prediction data for station ${input.station_id} in the requested date range.`,
            { ...ctx.recoveryFor('no_predictions') },
          );
        }
        // station_error or no_data → station_not_found
        throw ctx.fail(
          'station_not_found',
          `CO-OPS does not have current data for station ${input.station_id} — use noaa_marine_find_stations with types=["current"] to find a valid station.`,
          { ...ctx.recoveryFor('station_not_found') },
        );
      }
      // CO-OPS HTTP 400 whose body named no condition this server reads — treat the station
      // ID as the likely cause, which is what CO-OPS rejects a malformed request on.
      if (err instanceof McpError) {
        const status = (err.data as Record<string, unknown> | undefined)?.status;
        if (status === 400) {
          throw ctx.fail(
            'station_not_found',
            `CO-OPS rejected station ${input.station_id} — current stations need alphanumeric IDs. Use noaa_marine_find_stations with types=["current"].`,
            { ...ctx.recoveryFor('station_not_found') },
          );
        }
      }
      throw err;
    }

    const result = predResult.value;
    const identity = {
      station_id: input.station_id,
      station_name: stationMeta?.name ?? result.stationName,
      units: input.units,
    };

    // CO-OPS put a sentence where the event array belongs: the station's currents are real,
    // it just will not predict them as discrete events. Report that answer on both surfaces
    // rather than discarding it as an empty result.
    if (result.statement) {
      ctx.enrich.notice(
        `CO-OPS returned a statement instead of current predictions for station ${input.station_id}: "${result.statement}".`,
      );
      ctx.log.info('Current predictions returned a CO-OPS statement', {
        station_id: input.station_id,
        interval: input.interval,
      });
      const empty = { ...identity, bin: null, depth: null };
      return input.interval === 'MAX_SLACK'
        ? { ...empty, events: [] }
        : { ...empty, predictions: [] };
    }

    if (input.interval === 'MAX_SLACK') {
      const raw = result.events ?? [];
      if (raw.length === 0) {
        throw ctx.fail(
          'no_predictions',
          `No current predictions for station ${input.station_id} in the date range.`,
          { ...ctx.recoveryFor('no_predictions') },
        );
      }

      const events = raw.map((e) => {
        const typeRaw = (e.Type ?? '').toLowerCase();
        const type: FlowSense = typeRaw.includes('flood')
          ? 'flood'
          : typeRaw.includes('ebb')
            ? 'ebb'
            : 'slack';

        const entry: {
          time: string;
          type: FlowSense;
          speed?: number;
          direction?: number;
        } = {
          time: e.Time,
          type,
        };
        // Slack water is the one event CO-OPS gives a zero speed, and a zero peak speed
        // carries nothing — so the falsy check is what keeps `speed` absent there.
        if (e.Velocity_Major) entry.speed = Math.abs(e.Velocity_Major);
        const bearing = meanBearing(e, type);
        if (bearing !== null) entry.direction = bearing;
        return entry;
      });

      // A day of max/slack events is well inside the budget, but the tool accepts a year of
      // them, so the event view is bounded by the same rule as the 6-minute curve. A range
      // that fits comes back whole and discloses nothing.
      const page = pageRows(events, {
        offset: input.offset,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      if (!page.whole) {
        ctx.enrich(pageDisclosure(page));
        ctx.enrich.notice(pageNotice(page, 'events'));
      }

      ctx.log.info('Current predictions (MAX_SLACK) fetched', {
        station_id: input.station_id,
        event_count: page.rows.length,
        matched: page.matched,
      });

      return { ...identity, ...binEcho(raw), events: page.rows };
    }

    // 6-min interval
    const raw6 = result.predictions ?? [];
    if (raw6.length === 0) {
      throw ctx.fail(
        'no_predictions',
        `No 6-min current predictions for station ${input.station_id} in the date range.`,
        { ...ctx.recoveryFor('no_predictions') },
      );
    }

    const predictions = raw6.map((p) => {
      const velocity = p.Velocity_Major ?? 0;
      const type = flowSense(velocity);
      return {
        time: p.Time,
        type,
        speed: Math.abs(velocity),
        direction: meanBearing(p, type),
      };
    });

    // The 6-minute curve runs 240 rows a day and crosses the response budget inside a
    // three-day range, so it is bounded by serialized size. A range that fits comes back
    // whole and says nothing; anything longer is a page that discloses what it left behind.
    const page = pageRows(predictions, {
      offset: input.offset,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    if (!page.whole) {
      ctx.enrich(pageDisclosure(page));
      ctx.enrich.notice(pageNotice(page, 'predictions'));
    }

    ctx.log.info('Current predictions (6min) fetched', {
      station_id: input.station_id,
      count: page.rows.length,
      matched: page.matched,
    });

    return { ...identity, ...binEcho(raw6), predictions: page.rows };
  },

  format: (result) => {
    const speedUnit = result.units === 'metric' ? 'cm/s' : 'kt';
    const depthUnit = result.units === 'metric' ? 'm' : 'ft';

    const meta = [`**Units:** ${result.units} (speed in ${speedUnit})`];
    if (result.bin !== null) meta.push(`**Bin:** ${result.bin}`);
    if (result.depth !== null) meta.push(`**Depth:** ${result.depth} ${depthUnit}`);

    const lines: string[] = [
      `## Tidal Currents — ${result.station_name} (${result.station_id})`,
      meta.join(' · '),
      '',
    ];

    if (result.events?.length) {
      lines.push(`**Events** (${result.events.length} max/slack events):`);
      for (const e of result.events) {
        const speed = e.speed !== undefined ? ` ${e.speed} ${speedUnit}` : '';
        const dir = e.direction !== undefined ? ` @${e.direction}°` : '';
        lines.push(`${e.time}: ${e.type}${speed}${dir}`);
      }
    } else if (result.events) {
      lines.push('**Events:** none returned.');
    }

    if (result.predictions?.length) {
      lines.push(`**6-min predictions** (${result.predictions.length} records):`);
      // Every row of the page, never a head slice: the page is already bounded, and a slice
      // here would leave a content[]-only client unable to reach the rows it omits.
      for (const p of result.predictions) {
        const dirStr = p.direction !== null ? ` @${p.direction}°` : '';
        lines.push(`${p.time}: ${p.type} ${p.speed} ${speedUnit}${dirStr}`);
      }
    } else if (result.predictions) {
      lines.push('**6-min predictions:** none returned.');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
