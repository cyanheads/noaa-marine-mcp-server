/**
 * @fileoverview noaa_marine_get_monthly_means tool — verified monthly tidal datums and extremes.
 * @module mcp-server/tools/definitions/noaa-marine-get-monthly-means.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCoopsService, isCoopsBodyError } from '@/services/coops/coops-service.js';
import {
  awaitsVerification,
  COOPS_DATE_FORM,
  validateCoopsDateRange,
} from '@/services/coops/date-range.js';
import { pageDisclosure, pageNotice, pageRows } from '@/services/coops/row-page.js';
import type { CoopsMonthlyMeanRow } from '@/services/coops/types.js';

/** The span CO-OPS names as its `monthly_mean` ceiling, enforced before the call. */
const MAX_SPAN_DAYS = 73_000;

/**
 * The value columns, output key → CO-OPS key. Every one is optional in the output: CO-OPS sends
 * an empty string for a value the station does not carry, and that is omitted, never read as 0.
 */
const MONTH_VALUES = [
  ['highest', 'highest'],
  ['mhhw', 'MHHW'],
  ['mhw', 'MHW'],
  ['msl', 'MSL'],
  ['mtl', 'MTL'],
  ['mlw', 'MLW'],
  ['mllw', 'MLLW'],
  ['dtl', 'DTL'],
  ['gt', 'GT'],
  ['mn', 'MN'],
  ['dhq', 'DHQ'],
  ['dlq', 'DLQ'],
  ['hwi', 'HWI'],
  ['lwi', 'LWI'],
  ['lowest', 'lowest'],
] as const satisfies readonly (readonly [string, keyof CoopsMonthlyMeanRow])[];

type MonthValueKey = (typeof MONTH_VALUES)[number][0];

/** The lunitidal intervals, which are hours rather than heights. */
const INTERVAL_KEYS: ReadonlySet<MonthValueKey> = new Set(['hwi', 'lwi']);

/** Months since year 0 — one comparable number per calendar month. */
function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

const height = (what: string) =>
  z
    .number()
    .optional()
    .describe(
      `${what}, in the requested units relative to the requested datum. Omitted when CO-OPS publishes no value for the month.`,
    );

const planeDifference = (what: string) =>
  z
    .number()
    .optional()
    .describe(
      `${what}, in the requested units. A difference between two tidal planes, so it is the same under every datum. Omitted when CO-OPS publishes no value for the month.`,
    );

const lunitidal = (what: string) =>
  z
    .number()
    .optional()
    .describe(`${what}, in hours. Omitted when CO-OPS publishes no value for the month.`);

export const noaaMarineGetMonthlyMeans = tool('noaa_marine_get_monthly_means', {
  title: 'Get Monthly Means',
  description: `Verified monthly means for a CO-OPS water-level station, one row per station-month: the month's highest and lowest water, its tidal datums (MHHW, MHW, MSL, MTL, MLW, MLLW, DTL), tidal ranges (GT, MN, DHQ, DLQ), and lunitidal intervals (HWI, LWI) — the record a sea-level or tidal-range trend over years to decades is read from. Heights are relative to the requested datum in the requested units. A value CO-OPS publishes no figure for is omitted rather than reported as zero; a Great Lakes station carries only highest, msl, and lowest. A range may span up to 73,000 days, checked before the call, and CO-OPS verifies this product monthly, for the prior month, so a window ending on or after the first day of the prior month can fail with verified_data_lag. A range whose months fit the response budget is returned whole; a longer one returns the leading months, with rows_matched, rows_returned, and next_offset reporting how many matched and which offset reaches the rest. Use noaa_marine_find_stations with types=["water_level"] first to resolve a station name or location to a station ID.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    station_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,20}$/)
      .describe(
        'CO-OPS water-level station ID (numeric, e.g. "9447130" for Seattle). Obtain from noaa_marine_find_stations with types=["water_level"].',
      ),
    begin_date: z
      .string()
      .regex(COOPS_DATE_FORM, 'Must be YYYYMMDD or YYYY-MM-DD, e.g. "19750101" or "1975-01-01".')
      .describe(
        'Start date, YYYYMMDD or YYYY-MM-DD, e.g. "19750101" or "1975-01-01". The month it falls in is the first month returned.',
      ),
    end_date: z
      .string()
      .regex(COOPS_DATE_FORM, 'Must be YYYYMMDD or YYYY-MM-DD, e.g. "20251231" or "2025-12-31".')
      .describe(
        'End date (inclusive), YYYYMMDD or YYYY-MM-DD, e.g. "20251231" or "2025-12-31". The month it falls in is the last month returned.',
      ),
    datum: z
      .enum(['MLLW', 'MHHW', 'MHW', 'MTL', 'MSL', 'MLW', 'NAVD', 'STND', 'IGLD', 'LWD', 'CRD'])
      .default('MLLW')
      .describe(
        "Datum the monthly heights are referenced to. MLLW (default) is the US nautical chart datum; MHHW, MHW, MTL, MSL, and MLW are the other tidal planes. NAVD is NAVD88 and reads only where the station has an NAVD88 tie. STND is the station's own datum and reads any station. IGLD and LWD apply at Great Lakes stations only, which carry no tidal datum, and CRD at Columbia River stations only. A datum this station does not carry comes back as datum_unavailable.",
      ),
    units: z
      .enum(['english', 'metric'])
      .default('english')
      .describe(
        'Unit system for the heights: english = feet; metric = meters. The lunitidal intervals are hours either way.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Month offset into the matched series, for reading a range whose months do not fit one response. 0 (default) starts at the first month; pass the next_offset from a previous call to continue. An offset past the last month returns an empty page rather than an error.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Maximum months to return on this page, for a caller that wants fewer than the response budget allows. Omit for the largest page that fits; a value larger than the budget allows does not widen the page.',
      ),
  }),

  output: z.object({
    station_id: z.string().describe('Station ID echoed from the request — for chaining.'),
    station_name: z.string().describe('Station name as returned by CO-OPS.'),
    datum: z
      .string()
      .describe('Datum the heights are referenced to — echoed for correct interpretation.'),
    units: z.string().describe('Height units: "english" (feet) or "metric" (meters).'),
    begin_date: z.string().describe('Start of the requested range as sent to CO-OPS, YYYYMMDD.'),
    end_date: z.string().describe('End of the requested range as sent to CO-OPS, YYYYMMDD.'),
    months: z
      .array(
        z
          .object({
            year: z.number().int().describe('Calendar year of the month.'),
            month: z.number().int().describe('Month number, 1–12.'),
            highest: height("The month's highest observed water level"),
            mhhw: height("The month's mean higher high water (MHHW)"),
            mhw: height("The month's mean high water (MHW)"),
            msl: height("The month's mean sea level (MSL)"),
            mtl: height("The month's mean tide level (MTL)"),
            mlw: height("The month's mean low water (MLW)"),
            mllw: height("The month's mean lower low water (MLLW)"),
            dtl: height("The month's mean diurnal tide level (DTL)"),
            gt: planeDifference('Great diurnal range, MHHW − MLLW (GT)'),
            mn: planeDifference('Mean range of tide, MHW − MLW (MN)'),
            dhq: planeDifference('Mean diurnal high water inequality, MHHW − MHW (DHQ)'),
            dlq: planeDifference('Mean diurnal low water inequality, MLW − MLLW (DLQ)'),
            hwi: lunitidal('Greenwich high water interval (HWI)'),
            lwi: lunitidal('Greenwich low water interval (LWI)'),
            lowest: height("The month's lowest observed water level"),
            inferred: z
              .string()
              .describe(
                'CO-OPS inferred-data code for the month, exactly as CO-OPS sends it. Observed values include "0", "1", and "11" — a code, not a boolean.',
              ),
          })
          .describe('One station-month of tidal datums and extremes.'),
      )
      .describe(
        'One row per station-month in the requested range, oldest first — the whole matched series when it fits one response, otherwise the leading page starting at offset. rows_matched and next_offset report what a page left behind.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('What this page of the monthly series covers and how to reach the next page.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when this page stops short of the last matched month, so further months remain at next_offset. False on the final page and on a page past the end. Absent when the whole matched series was returned.',
      ),
    rows_matched: z
      .number()
      .int()
      .optional()
      .describe(
        'Months the requested range matched, before the page was cut. Absent when the whole matched series was returned.',
      ),
    rows_returned: z
      .number()
      .int()
      .optional()
      .describe(
        'Months this page carries — the length of months. Absent when the whole matched series was returned.',
      ),
    page_offset: z
      .number()
      .int()
      .optional()
      .describe(
        'Month offset this page starts at, echoed from the request. Absent when the whole matched series was returned.',
      ),
    next_offset: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe(
        'Offset to pass as offset on the next call, or null when this page reaches the last matched month. Absent when the whole matched series was returned.',
      ),
  },

  errors: [
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
      when: 'The requested range spans more than 73,000 days, the CO-OPS limit for monthly means.',
      recovery: 'Split the request into calls each spanning at most 73,000 days, about 200 years.',
    },
    {
      reason: 'station_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'CO-OPS rejected the station ID as not a valid station.',
      recovery:
        'Use noaa_marine_find_stations with types=["water_level"] to obtain a valid station ID.',
    },
    {
      reason: 'datum_unavailable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The station does not carry the requested datum — a Great Lakes station has no tidal datum, and IGLD and LWD apply at Great Lakes stations only.',
      recovery:
        'Retry with a datum this station carries — MLLW or STND at a coastal station, IGLD, LWD, or STND at a Great Lakes station.',
    },
    {
      reason: 'verified_data_lag',
      code: JsonRpcErrorCode.NotFound,
      when: 'CO-OPS returned no months for a window ending on or after the first day of the prior month, which it may not have verified yet.',
      recovery:
        'CO-OPS verifies monthly means monthly, for the prior month, so request a window ending before the first day of the prior month.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'CO-OPS returned no months for a window ending before the prior month — the station has no monthly means for it.',
      recovery:
        "The station's record may begin after the window, or the station may publish no monthly means. Request a later window, or another station from noaa_marine_find_stations.",
    },
    {
      reason: 'upstream_throttled',
      code: JsonRpcErrorCode.RateLimited,
      when: 'CO-OPS answered the monthly-mean request with HTTP 403, which it returns for about two minutes while it throttles a burst of requests from one address.',
      recovery:
        'The block is temporary. Wait a couple of minutes before calling again, and space successive CO-OPS calls rather than sending them back to back.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    // Validated locally — an impossible date or reversed range would otherwise come back as an
    // HTTP 400 that reads as an unknown station.
    const range = validateCoopsDateRange(input.begin_date, input.end_date);
    if (!range.ok) {
      throw ctx.fail('invalid_date_range', range.error, {
        ...ctx.recoveryFor('invalid_date_range'),
      });
    }
    if (range.spanDays > MAX_SPAN_DAYS) {
      throw ctx.fail(
        'date_range_exceeded',
        `Date range of ${Math.ceil(range.spanDays)} days exceeds the 73,000-day CO-OPS limit for monthly means.`,
        { ...ctx.recoveryFor('date_range_exceeded') },
      );
    }

    /*
     * CO-OPS answers a window with no monthly means with one sentence whatever the cause. A
     * window ending on or after the first day of the prior month may still be waiting on the
     * monthly verification; an earlier one never will be, so the recovery must not say to wait.
     */
    const noMonths = (): McpError =>
      awaitsVerification(range.end)
        ? ctx.fail(
            'verified_data_lag',
            `CO-OPS has published no monthly means for station ${input.station_id} in a window ending ${input.end_date}.`,
            { ...ctx.recoveryFor('verified_data_lag') },
          )
        : ctx.fail(
            'no_data',
            `CO-OPS has no monthly means for station ${input.station_id} in a window ending ${input.end_date}. The window ends before the prior month, so it is not waiting on CO-OPS's monthly verification.`,
            { ...ctx.recoveryFor('no_data') },
          );

    const fetched = await getCoopsService()
      .fetchMonthlyMeans(
        {
          station: input.station_id,
          begin_date: range.beginDate,
          end_date: range.endDate,
          datum: input.datum,
          units: input.units,
        },
        ctx,
      )
      .catch((err: unknown): never => {
        if (isCoopsBodyError(err)) {
          if (err.coopsReason === 'datum_unavailable') {
            throw ctx.fail(
              'datum_unavailable',
              `Station ${input.station_id} does not carry datum ${input.datum}.`,
              { ...ctx.recoveryFor('datum_unavailable') },
            );
          }
          if (err.coopsReason === 'station_error') {
            throw ctx.fail(
              'station_not_found',
              `CO-OPS does not recognize station ${input.station_id}.`,
              { ...ctx.recoveryFor('station_not_found') },
            );
          }
          if (err.coopsReason === 'product_not_offered') throw noMonths();
          throw ctx.fail(
            'no_data',
            `No monthly means for station ${input.station_id} in the requested range.`,
            { ...ctx.recoveryFor('no_data') },
          );
        }
        // An HTTP 400 whose body names no condition the classifier reads — CO-OPS's
        // `The station is not a valid station` rejection among them.
        if (err instanceof McpError && err.data?.status === 400) {
          throw ctx.fail(
            'station_not_found',
            `CO-OPS rejected station ${input.station_id} as not a valid station.`,
            { ...ctx.recoveryFor('station_not_found') },
          );
        }
        throw err;
      });

    /*
     * With time_zone=lst CO-OPS answers one month past end_date, and the rows carry no date but
     * their year and month — so the range is applied here, month by month, and the overrun month
     * is dropped. A value sent as an empty string is omitted rather than parsed to NaN or 0.
     */
    const first = monthIndex(range.begin.getUTCFullYear(), range.begin.getUTCMonth() + 1);
    const last = monthIndex(range.end.getUTCFullYear(), range.end.getUTCMonth() + 1);
    type Month = { inferred: string; month: number; year: number } & Partial<
      Record<MonthValueKey, number>
    >;
    const months: Month[] = [];
    for (const row of fetched.data) {
      const year = Number.parseInt(row.year, 10);
      const month = Number.parseInt(row.month, 10);
      const index = monthIndex(year, month);
      if (!(index >= first && index <= last)) continue;
      const entry: Month = { year, month, inferred: row.inferred };
      for (const [key, raw] of MONTH_VALUES) {
        const value = Number.parseFloat(row[raw] ?? '');
        if (Number.isFinite(value)) entry[key] = value;
      }
      months.push(entry);
    }

    if (months.length === 0) throw noMonths();

    const page = pageRows(months, {
      offset: input.offset,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    if (!page.whole) {
      ctx.enrich(pageDisclosure(page));
      ctx.enrich.notice(pageNotice(page, 'months'));
    }

    ctx.log.info('Monthly means fetched', {
      station_id: input.station_id,
      months_matched: page.matched,
      months_returned: page.rows.length,
    });

    return {
      station_id: input.station_id,
      station_name: fetched.stationName,
      datum: input.datum,
      units: input.units,
      begin_date: range.beginDate,
      end_date: range.endDate,
      months: page.rows,
    };
  },

  format: (result) => {
    const unit = result.units === 'metric' ? 'm' : 'ft';
    const lines: string[] = [
      `## Monthly Means — ${result.station_name} (${result.station_id})`,
      `**Datum:** ${result.datum} · **Units:** ${result.units} · **Range:** ${result.begin_date}–${result.end_date}`,
      '',
      `**Months** (${result.months.length} records):`,
    ];

    // Every month of the page, never a head slice — the page is already bounded.
    for (const m of result.months) {
      const values: string[] = [];
      for (const [key] of MONTH_VALUES) {
        const value = m[key];
        if (value === undefined) continue;
        const label = key === 'highest' || key === 'lowest' ? key : key.toUpperCase();
        values.push(`${label} ${value} ${INTERVAL_KEYS.has(key) ? 'h' : unit}`);
      }
      const month = String(m.month).padStart(2, '0');
      const body = values.length > 0 ? values.join(' · ') : 'no values published';
      lines.push(`${m.year}-${month}: ${body} · inferred ${m.inferred}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
