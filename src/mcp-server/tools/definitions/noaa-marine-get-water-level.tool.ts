/**
 * @fileoverview noaa_marine_get_water_level tool — observed water levels with paired predictions.
 * @module mcp-server/tools/definitions/noaa-marine-get-water-level.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCoopsService, isCoopsBodyError } from '@/services/coops/coops-service.js';
import { validateCoopsDateRange } from '@/services/coops/date-range.js';
import { pageDisclosure, pageNotice, pagePairedRows } from '@/services/coops/row-page.js';
import type { CoopsPredictionRow } from '@/services/coops/types.js';

/** The observed water-level cadences this tool serves, one CO-OPS product each. */
type WaterLevelInterval = '6min' | 'hourly' | 'high_low' | 'daily_mean';

/**
 * How CO-OPS classifies an observed extreme on the `high_low` product. It pads the
 * single-letter values to two characters, so the raw `ty` is matched against these after a
 * trim and an unrecognized code is dropped rather than widening the output's enum.
 */
const HIGH_LOW_CLASSES = ['H', 'HH', 'L', 'LL'] as const;

function highLowClass(ty: string | undefined): (typeof HIGH_LOW_CLASSES)[number] | undefined {
  const trimmed = ty?.trim();
  return HIGH_LOW_CLASSES.find((value) => value === trimmed);
}

interface WaterLevelIntervalSpec {
  /** Largest span CO-OPS accepts for the product, in days, enforced before the call. */
  maxDays: number;
  /** Interval for the paired prediction series, as the API spells it. Null where none exists. */
  predictionInterval: string | null;
  product: string;
  /** Whether an exact-time observed/predicted join is meaningful for this cadence. */
  residual: boolean;
  /** Why no residual is reported, for the cadences that report none. */
  residualNotice?: string;
}

/**
 * What each `interval` value resolves to upstream.
 *
 * The products are not interchangeable views of one series: only `water_level` carries a
 * quality flag, only `high_low` carries a classification, `daily_mean` has no paired
 * prediction series at all, and each has its own CO-OPS range ceiling. Coarser is not
 * automatically smaller either — a year of hourly rows outweighs a month of 6-minute ones —
 * so the range ceiling bounds the request and the response budget bounds the page.
 */
const WATER_LEVEL_INTERVALS: Record<WaterLevelInterval, WaterLevelIntervalSpec> = {
  '6min': { maxDays: 31, predictionInterval: '6', product: 'water_level', residual: true },
  hourly: { maxDays: 365, predictionInterval: 'h', product: 'hourly_height', residual: true },
  high_low: {
    maxDays: 365,
    predictionInterval: 'hilo',
    product: 'high_low',
    residual: false,
    residualNotice:
      'Observed high and low waters do not occur at the predicted extreme times, so an exact-time join matches only a small fraction of the events and no residual is reported for the high_low interval. Compare the two series by time to judge a surge.',
  },
  daily_mean: {
    maxDays: 3655,
    predictionInterval: null,
    product: 'daily_mean',
    residual: false,
    residualNotice:
      'CO-OPS publishes no prediction series paired with the daily_mean product, so this interval carries no comparison series and no residual.',
  },
};

/**
 * Whether the `waterlevels` catalog marks the station Great Lakes. Undefined when the
 * catalog could not be read or does not carry the station — a request is then spent
 * upstream rather than refused on a catalog that could not confirm it.
 */
async function isGreatLakesStation(stationId: string, ctx: Context): Promise<boolean | undefined> {
  const [catalog] = await Promise.allSettled([getCoopsService().getStations('waterlevels', ctx)]);
  if (catalog.status !== 'fulfilled') return undefined;
  const station = catalog.value.find((s) => s.id === stationId);
  return station === undefined ? undefined : Boolean(station.greatlakes);
}

/**
 * Builds the recovery for a datum the station does not carry, naming the planes that do read it.
 *
 * The station's class is the whole answer and the `waterlevels` catalog already holds it, so the
 * catalog is read here — on the failure path only, and from a 6-hour cache after the first time.
 * Two sources that look authoritative are deliberately not used: the `supported Datum values`
 * list inside the CO-OPS rejection is station-specific and provably incomplete (it omits STND and
 * CRD at stations where both return data), and the per-station `datums.json` endpoint names its
 * datums differently from the data API and lists ones the data API rejects.
 */
async function datumRecoveryHint(stationId: string, datum: string, ctx: Context): Promise<string> {
  const [catalog] = await Promise.allSettled([getCoopsService().getStations('waterlevels', ctx)]);
  const station =
    catalog.status === 'fulfilled' ? catalog.value.find((s) => s.id === stationId) : undefined;

  if (station?.greatlakes) {
    return `Station ${stationId} is a Great Lakes station and carries no tidal datum. Retry with datum STND or IGLD for its elevation, or LWD for height above Low Water Datum.`;
  }
  if (datum === 'NAVD') {
    return `Station ${stationId} has no NAVD88 tie. Retry with datum MLLW for chart-referenced heights, or STND for the station's own datum.`;
  }
  return `Station ${stationId} does not carry datum ${datum}. Retry with datum MLLW, the US nautical chart datum, or STND, the station's own datum, which reads any station.`;
}

export const noaaMarineGetWaterLevel = tool('noaa_marine_get_water_level', {
  title: 'Get Water Level',
  description: `Observed water level, real-time or historical, for a CO-OPS water-level station, paired with tide predictions for the same period so the residual (observed − predicted) shows storm surge when positive and anomalous drawdown when negative. The interval selects the cadence: 6min (default) is the full curve, hourly and high_low cover months to a year of the same series at far fewer rows, and daily_mean serves Great Lakes stations only. Each interval carries its own CO-OPS range ceiling — 31 days for 6min, 365 for hourly and high_low, 3655 for daily_mean — rejected locally before the call, and only 6min and hourly report a residual. Observations and predictions are fetched independently, so when the prediction series is empty, predictions_status says whether CO-OPS has none for this station and range or the prediction fetch failed — the observed series returns either way, and residual_summary is present only when both series are and the cadence supports the join. A sensor outage leaves slots with no reading; those slots are dropped and counted in gaps_dropped, so the observed series is continuous across the range only when that count is absent. A range whose rows fit the response budget is returned whole; a longer one returns the leading rows, with rows_matched, rows_returned, and next_offset reporting how much matched and which offset reaches the rest. Use noaa_marine_find_stations first to resolve a station name or location to a valid station ID.`,
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
      .enum([
        'MLLW',
        'MHHW',
        'MHW',
        'MTL',
        'MSL',
        'MLW',
        'NAVD',
        'STND',
        'IGLD',
        'LWD',
        'CRD',
        'LWI',
        'HWI',
      ])
      .default('MLLW')
      .describe(
        "Datum the observed heights are referenced to. MLLW (default) is the US nautical chart datum, and MHHW (mean higher high water) is the flooding reference; MHW, MTL, MSL, and MLW are the other tidal planes. NAVD is NAVD88 and reads only where the station has an NAVD88 tie. STND is the station's own datum and is the plane that works where no tidal datum exists. IGLD and LWD apply at Great Lakes stations only, CRD at Columbia River stations only, and LWI and HWI are lunitidal intervals rather than heights. A datum this station does not carry comes back as datum_unavailable naming the ones it does.",
      ),
    time_zone: z
      .enum(['lst_ldt', 'gmt', 'lst'])
      .default('lst_ldt')
      .describe(
        'Time zone for returned timestamps. lst_ldt = local standard/daylight time (default); gmt = UTC; lst = local standard time year-round. Overridden to lst on interval="daily_mean", which CO-OPS serves in local standard time only and otherwise stamps every row a day off.',
      ),
    units: z
      .enum(['english', 'metric'])
      .default('english')
      .describe('Unit system: english = feet; metric = meters.'),
    interval: z
      .enum(['6min', 'hourly', 'high_low', 'daily_mean'])
      .default('6min')
      .describe(
        'Observed cadence. 6min (default) is the full curve, 31 days per request, the only one carrying a quality flag. hourly is hourly heights, 365 days per request, and reports a residual against the hourly prediction series. high_low is the observed high and low waters with their H/HH/L/LL classification, 365 days per request, and reports no residual because observed extremes do not fall on predicted extreme times. daily_mean is the daily mean water level, 3655 days per request, published at Great Lakes stations only and with no paired prediction series; a coastal station comes back as great_lakes_only.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Row offset into the matched observation series, for reading a range whose rows do not fit one response. 0 (default) starts at the first row; pass the next_offset from a previous call to continue. An offset past the last row returns an empty page rather than an error.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Maximum observation rows to return on this page, for a caller that wants fewer than the response budget allows. Omit for the largest page that fits; a value larger than the budget allows does not widen the page.',
      ),
  }),

  output: z.object({
    station_id: z.string().describe('Station ID echoed from the request — for chaining.'),
    station_name: z.string().describe('Station name as returned by CO-OPS.'),
    datum: z
      .string()
      .describe('Tidal datum used — echoed for correct interpretation of water heights.'),
    units: z.string().describe('Height units: "english" (feet) or "metric" (meters).'),
    interval: z
      .enum(['6min', 'hourly', 'high_low', 'daily_mean'])
      .describe(
        'Observed cadence echoed from the request — the CO-OPS product these rows came from, and what decides whether quality, type, and residual_summary are populated.',
      ),
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
              .describe(
                'Standard deviation of the water level sensor reading. Present on the 6min and hourly intervals; CO-OPS sends none for high_low or daily_mean.',
              ),
            quality: z
              .string()
              .optional()
              .describe(
                'Quality flag: p = preliminary, v = verified. Present on the 6min interval only — CO-OPS sends no flag with the hourly, high_low, or daily_mean products, which are verified data, so the field is absent rather than defaulted to preliminary.',
              ),
            type: z
              .enum(HIGH_LOW_CLASSES)
              .optional()
              .describe(
                'Observed extreme classification on the high_low interval: H = high water, HH = higher high water, L = low water, LL = lower low water. Absent on every other interval.',
              ),
          })
          .describe('A single observed water level reading at the requested cadence.'),
      )
      .describe(
        'Observed water level readings at the requested cadence — the whole matched series when it fits one response, otherwise the leading page starting at offset. rows_matched and next_offset report what a page left behind.',
      ),
    predictions: z
      .array(
        z
          .object({
            time: z.string().describe('Prediction datetime in the requested time zone.'),
            value: z
              .number()
              .describe('Predicted water height in the requested units relative to the datum.'),
          })
          .describe('A single tide prediction.'),
      )
      .describe(
        'Paired tide predictions covering the same period as the returned observations, at the interval matching the observed cadence. Always empty on the daily_mean interval, which has no paired series. Otherwise empty when CO-OPS returned no predictions for this station and range, or when the prediction fetch failed — predictions_status says which.',
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
        'Summary of observed-minus-predicted residuals in the requested units, computed across the whole matched series rather than the returned page — so a paged response still reports the largest surge in the range. Present only on the 6min and hourly intervals, and only when both series are available; the notice says why it is absent on high_low and daily_mean.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Why the paired prediction series is missing or carries no residual, how many sample slots were dropped, and what this page of the observed series covers — whichever of those apply, composed into one string.',
      ),
    predictions_status: z
      .enum(['empty', 'unavailable'])
      .optional()
      .describe(
        'Present only when predictions is empty on an interval that has a paired series. "empty" means CO-OPS returned no prediction rows for this station and date range; "unavailable" means the prediction fetch failed, so no comparison series could be retrieved and the absence says nothing about the station. Absent when predictions were returned, and on the daily_mean interval, which has no paired series to report on.',
      ),
    gaps_dropped: z
      .number()
      .int()
      .optional()
      .describe(
        'Number of sample slots CO-OPS sent with no reading, dropped from observations. Present only when there was at least one. The observed series is therefore not continuous across the requested range: it has this many missing slots, and rows_matched counts only the slots that carry a value.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when this page stops short of the last matched observation, so further rows remain at next_offset. False on the final page and on a page past the end. Absent when the whole matched series was returned.',
      ),
    rows_matched: z
      .number()
      .int()
      .optional()
      .describe(
        'Observation rows the requested date range matched, before the page was cut. Absent when the whole matched series was returned.',
      ),
    rows_returned: z
      .number()
      .int()
      .optional()
      .describe(
        'Observation rows this page carries — the length of observations. Absent when the whole matched series was returned.',
      ),
    page_offset: z
      .number()
      .int()
      .optional()
      .describe(
        'Observation row offset this page starts at, echoed from the request. Absent when the whole matched series was returned.',
      ),
    next_offset: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe(
        'Offset to pass as offset on the next call, or null when this page reaches the last matched observation. Absent when the whole matched series was returned.',
      ),
  },

  errors: [
    {
      reason: 'station_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'CO-OPS returned an error for the station ID.',
      recovery:
        'Use noaa_marine_find_stations with types=["water_level"] to obtain a valid station ID.',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'begin_date/end_date is not a real calendar date or begin_date is after end_date',
      recovery:
        'Provide begin_date and end_date as real YYYYMMDD calendar dates with begin_date on or before end_date.',
    },
    {
      reason: 'date_range_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: "Requested date range exceeds the selected interval's CO-OPS limit — 31 days for 6min, 365 for hourly and high_low, 3655 for daily_mean.",
      recovery:
        'Split the request into calls each within the limit named in the message, or select a coarser interval, which covers a longer span in one call.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Station exists but no observed water-level data for the date range.',
      recovery:
        'The station may be offline or the date range may be in the future. Try a different date range or station.',
    },
    {
      reason: 'great_lakes_only',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'interval="daily_mean" was requested for a coastal station — CO-OPS publishes water-level daily means at Great Lakes stations only.',
      recovery:
        'Retry with interval "6min", "hourly", or "high_low" at this station, or request daily_mean at a Great Lakes station.',
    },
    {
      reason: 'verified_data_lag',
      code: JsonRpcErrorCode.NotFound,
      when: 'The hourly, high_low, or daily_mean product returned no rows for the window, which CO-OPS has not published yet.',
      recovery:
        'CO-OPS verifies these products monthly, for the prior month, so request a window ending before the first day of the current month — or use interval "6min", whose preliminary data reaches the present.',
    },
    {
      reason: 'datum_unavailable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The station does not carry the requested datum — a Great Lakes station has no tidal datum, and NAVD reads only where the station has an NAVD88 tie.',
      recovery:
        'Retry with a datum this station carries — STND reads any station, and the runtime hint names the specific planes available here.',
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
    const spec = WATER_LEVEL_INTERVALS[input.interval];
    if (range.spanDays > spec.maxDays) {
      throw ctx.fail(
        'date_range_exceeded',
        `Date range of ${Math.ceil(range.spanDays)} days exceeds the ${spec.maxDays}-day CO-OPS limit for the ${input.interval} interval.`,
        { ...ctx.recoveryFor('date_range_exceeded') },
      );
    }

    const svc = getCoopsService();

    /*
     * CO-OPS answers daily_mean at a coastal station with an HTTP 400 naming the Great Lakes
     * restriction, which the catalog already knows — refuse it here so the call is not spent,
     * and only when the catalog positively says the station is coastal. A catalog that could
     * not be read falls through to CO-OPS, whose rejection classifies to the same reason.
     */
    if (spec.product === 'daily_mean') {
      const greatLakes = await isGreatLakesStation(input.station_id, ctx);
      if (greatLakes === false) {
        throw ctx.fail(
          'great_lakes_only',
          `Station ${input.station_id} is a coastal station, and CO-OPS publishes the daily_mean water-level product at Great Lakes stations only.`,
          {
            recovery: {
              hint: `Station ${input.station_id} is not a Great Lakes station. Retry with interval "6min", "hourly", or "high_low" for this station, or request daily_mean at a Great Lakes station.`,
            },
          },
        );
      }
    }

    const params = {
      station: input.station_id,
      begin_date: input.begin_date,
      end_date: input.end_date,
      datum: input.datum,
      time_zone: input.time_zone,
      units: input.units,
    };

    // Fetch observed water level and its paired predictions in parallel. daily_mean has no
    // paired series, so nothing is requested for it rather than a request being spent and
    // its emptiness reported as a fact about the station.
    const [obsResult, predResult] = await Promise.allSettled([
      svc.fetchWaterLevel({ ...params, product: spec.product }, ctx),
      spec.predictionInterval === null
        ? Promise.resolve<CoopsPredictionRow[]>([])
        : svc.fetchWaterLevelPredictions({ ...params, interval: spec.predictionInterval }, ctx),
    ]);

    if (obsResult.status === 'rejected') {
      const err = obsResult.reason;
      // CO-OPS body-level errors carry a typed coopsReason — map to contract reasons.
      if (isCoopsBodyError(err)) {
        if (err.coopsReason === 'datum_unavailable') {
          throw ctx.fail(
            'datum_unavailable',
            `Station ${input.station_id} does not carry datum ${input.datum}.`,
            { recovery: { hint: await datumRecoveryHint(input.station_id, input.datum, ctx) } },
          );
        }
        if (err.coopsReason === 'station_error') {
          throw ctx.fail(
            'station_not_found',
            `CO-OPS does not have data for station ${input.station_id} — use noaa_marine_find_stations with types=["water_level"] to verify the ID.`,
            { ...ctx.recoveryFor('station_not_found') },
          );
        }
        if (err.coopsReason === 'great_lakes_only') {
          throw ctx.fail(
            'great_lakes_only',
            `CO-OPS publishes the daily_mean water-level product at Great Lakes stations only, and rejected station ${input.station_id} as coastal.`,
            { ...ctx.recoveryFor('great_lakes_only') },
          );
        }
        /*
         * CO-OPS says a product "may not be offered at this station at the requested time" for
         * two conditions. On a coarser product the usual one is the verification lag — it
         * verifies those monthly, for the prior month — so the recovery names the lag rather
         * than sending the caller after an outage or a future date that is not the cause.
         */
        if (err.coopsReason === 'product_not_offered' && input.interval !== '6min') {
          throw ctx.fail(
            'verified_data_lag',
            `CO-OPS has published no ${input.interval} data for station ${input.station_id} in the requested window.`,
            { ...ctx.recoveryFor('verified_data_lag') },
          );
        }
        // Every other reason is an absence of observations, not a rejected request.
        throw ctx.fail(
          'no_data',
          `No water level data for station ${input.station_id} in the requested date range.`,
          { ...ctx.recoveryFor('no_data') },
        );
      }
      // CO-OPS HTTP 400 — invalid station ID before response body is parsed.
      if (err instanceof McpError) {
        const status = (err.data as Record<string, unknown> | undefined)?.status;
        if (status === 400) {
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

    /*
     * CO-OPS emits a row for every slot in the range, including the ones its sensor did not
     * report: `v` and `s` both arrive as empty strings. Those slots carry no height, so they
     * are dropped rather than parsed into NaN, and the count is disclosed below — a caller
     * must not be able to read the returned rows as continuous coverage of the range.
     *
     * Only the `water_level` product carries `q`, and only `high_low` carries `ty`. An absent
     * `q` stays absent rather than defaulting to preliminary, which would stamp CO-OPS's
     * verified products as unverified.
     */
    type Observation = {
      quality?: string;
      sigma?: number;
      time: string;
      type?: (typeof HIGH_LOW_CLASSES)[number];
      value: number;
    };
    const observations: Observation[] = [];
    let gapsDropped = 0;
    for (const row of rawObs) {
      const value = Number.parseFloat(row.v);
      if (!Number.isFinite(value)) {
        gapsDropped += 1;
        continue;
      }
      const entry: Observation = { time: row.t, value };
      if (row.q) entry.quality = row.q;
      if (row.s) {
        const sigma = Number.parseFloat(row.s);
        if (Number.isFinite(sigma)) entry.sigma = sigma;
      }
      const classification = highLowClass(row.ty);
      if (classification) entry.type = classification;
      observations.push(entry);
    }

    if (observations.length === 0) {
      throw ctx.fail(
        'no_data',
        gapsDropped > 0
          ? `Station ${input.station_id} reported no value in any of the ${gapsDropped} sample slots CO-OPS returned for the requested date range.`
          : `No water level data for station ${input.station_id} in the requested date range.`,
        { ...ctx.recoveryFor('no_data') },
      );
    }

    const rawPred = predResult.status === 'fulfilled' ? predResult.value : [];
    const predictions = rawPred.map((p) => ({
      time: p.t,
      value: Number.parseFloat(p.v),
    }));

    // Both disclosures can fire on one response, and notice is last-wins — compose once.
    const notices: string[] = [];

    // Why this cadence reports no residual, on the two that report none. Said up front, so an
    // absent residual_summary is never read as a quiet failure to compute one.
    if (spec.residualNotice) notices.push(spec.residualNotice);

    // An empty prediction array is three different facts — CO-OPS has none for this station and
    // range, CO-OPS said it publishes none at all, or the fetch rejected and the comparison
    // series was never read. Say which, rather than letting a degraded upstream render as a
    // statement about the data, or a settled "none exist" render as something worth retrying.
    // Skipped where the product has no paired series at all: there is no status to report on a
    // fetch that was never made, and the interval's own notice already says so.
    if (spec.predictionInterval !== null && predictions.length === 0) {
      const predErr = predResult.status === 'rejected' ? predResult.reason : undefined;
      if (predErr && isCoopsBodyError(predErr)) {
        ctx.enrich({ predictions_status: 'empty' });
        notices.push(
          `CO-OPS publishes no tide predictions for station ${input.station_id}, so there is no comparison series and no residual. The observed series is unaffected.`,
        );
      } else if (predErr) {
        ctx.enrich({ predictions_status: 'unavailable' });
        notices.push(
          `The tide-prediction fetch for station ${input.station_id} failed, so no prediction series is available to compare against and no residual could be computed. The observed series is complete. Retry to obtain the comparison series.`,
        );
      } else {
        ctx.enrich({ predictions_status: 'empty' });
      }
    }

    if (gapsDropped > 0) {
      ctx.enrich({ gaps_dropped: gapsDropped });
      notices.push(
        `${gapsDropped} of the ${gapsDropped + observations.length} sample slots CO-OPS returned carried no reading and were dropped, so the ${observations.length} rows that matched the range are not continuous across it. Sensor gaps appear in preliminary data and CO-OPS fills them when the range is promoted to verified.`,
      );
    }

    /*
     * The residual is computed across the whole matched series, before paging, so the largest
     * surge in the requested range is reported whichever page the caller is on — a summary
     * derived from one page would answer a different question than the one that was asked.
     *
     * The join is by exact time key, which holds on the 6-minute and hourly cadences and not
     * on high_low: observed extremes fall minutes off the predicted ones, so the join would
     * land on a small fraction of the events and report a surge figure drawn from that
     * fraction. Those cadences report no residual and say so in the notice instead.
     */
    let residualSummary: { max_surge: number; max_drawdown: number } | undefined;
    if (spec.residual && predictions.length > 0) {
      const predMap = new Map(predictions.map((p) => [p.time, p.value]));
      const residuals: number[] = [];
      for (const obs of observations) {
        const pred = predMap.get(obs.time);
        if (pred !== undefined && Number.isFinite(pred)) residuals.push(obs.value - pred);
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

    /*
     * One day of the 6-minute series already outruns the response budget, and so does a year
     * of hourly rows, so the page is bounded by the serialized size of the two row arrays
     * together. The observed series carries the offset and the predictions follow it by time
     * window rather than by index: gap-dropped rows leave the two different lengths, so equal
     * index slices would pair rows from different instants.
     */
    const paged = pagePairedRows(observations, predictions, {
      offset: input.offset,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    if (!paged.page.whole) {
      ctx.enrich(pageDisclosure(paged.page));
      notices.push(pageNotice(paged.page, 'observations'));
    }

    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('Water level data fetched', {
      station_id: input.station_id,
      interval: input.interval,
      obs_count: paged.page.rows.length,
      obs_matched: paged.page.matched,
      pred_count: paged.companion.length,
      gaps_dropped: gapsDropped,
    });

    return {
      station_id: input.station_id,
      station_name: stationName,
      datum: input.datum,
      units: input.units,
      interval: input.interval,
      observations: paged.page.rows,
      predictions: paged.companion,
      ...(residualSummary ? { residual_summary: residualSummary } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Water Level — ${result.station_name} (${result.station_id})`,
      `**Datum:** ${result.datum} · **Units:** ${result.units} · **Interval:** ${result.interval}`,
    ];

    if (result.residual_summary) {
      const unitLabel = result.units === 'metric' ? 'm' : 'ft';
      lines.push(
        `**Max surge:** ${result.residual_summary.max_surge} ${unitLabel} · **Max drawdown:** ${result.residual_summary.max_drawdown} ${unitLabel}`,
      );
    }

    const unit = result.units === 'metric' ? 'm' : 'ft';

    // Every row of the page, never a head slice: the page is already bounded, and a slice here
    // would leave a content[]-only client unable to reach the rows it omits.
    lines.push('', `**Observations** (${result.observations.length} records):`);
    for (const o of result.observations) {
      const sig = o.sigma !== undefined ? ` ±${o.sigma}` : '';
      const kind = o.type !== undefined ? ` (${o.type})` : '';
      const flag = o.quality !== undefined ? ` [${o.quality}]` : '';
      lines.push(`${o.time}: ${o.value} ${unit}${sig}${kind}${flag}`);
    }

    if (result.predictions.length > 0) {
      lines.push('', `**Predictions** (${result.predictions.length} records):`);
      for (const p of result.predictions) {
        lines.push(`${p.time}: ${p.value} ${unit} (predicted)`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
