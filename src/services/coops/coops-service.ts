/**
 * @fileoverview CO-OPS Tides & Currents API service — station list cache and data fetching.
 * @module services/coops/coops-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type {
  CoopsCurrent6MinRow,
  CoopsCurrentRow,
  CoopsDataRow,
  CoopsErrorResponse,
  CoopsPredictionRow,
  CoopsStation,
  CoopsStationListResponse,
  CoopsStationType,
} from './types.js';

/**
 * The failure CO-OPS described, decoded from its message text.
 *
 *   'bin_unavailable'            — the station does not publish the requested depth bin
 *   'datum_unavailable'          — the station or product does not carry the requested datum
 *   'great_lakes_no_predictions' — a Great Lakes station, which has no prediction series at all
 *   'great_lakes_only'           — the product is served at Great Lakes stations only
 *   'no_data'                    — no observations for the date range / station type
 *   'no_predictions'             — no prediction data available for the request
 *   'predictions_unavailable'    — the station is known, but CO-OPS publishes no predictions for it
 *   'product_not_offered'        — the product is not published at this station for this window
 *   'station_error'              — the station ID was rejected as unknown or invalid
 */
export type CoopsReason =
  | 'bin_unavailable'
  | 'datum_unavailable'
  | 'great_lakes_no_predictions'
  | 'great_lakes_only'
  | 'no_data'
  | 'no_predictions'
  | 'predictions_unavailable'
  | 'product_not_offered'
  | 'station_error';

/**
 * Thrown when CO-OPS describes a failure in the response body.
 * Carries a `coopsReason` discriminator so tool handlers can map it to a
 * typed contract reason without string-parsing the raw CO-OPS message.
 */
export class CoopsBodyError extends McpError {
  /** Bin numbers CO-OPS named in an `Available bin number of …` rejection, in its order. */
  readonly availableBins?: number[];
  readonly coopsReason: CoopsReason;

  constructor(
    coopsReason: CoopsReason,
    message: string,
    options?: { availableBins?: number[]; cause?: unknown },
  ) {
    // retryable: false — deterministic domain errors should not be retried.
    super(
      JsonRpcErrorCode.ServiceUnavailable,
      message,
      {
        coopsReason,
        retryable: false,
        ...(options?.availableBins ? { availableBins: options.availableBins } : {}),
      },
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.coopsReason = coopsReason;
    if (options?.availableBins) this.availableBins = options.availableBins;
  }
}

/** Type guard for CoopsBodyError — avoids instanceof brittleness across module boundaries. */
export function isCoopsBodyError(
  err: unknown,
): err is CoopsBodyError & { coopsReason: CoopsReason } {
  return (
    err instanceof Error &&
    'coopsReason' in err &&
    typeof (err as CoopsBodyError).coopsReason === 'string'
  );
}

/** Pulls the bin list out of `Available bin number of PUG1515: 15, 10, 1, `. */
const BIN_LIST_PATTERN = /available bin number of\s+\S+?\s*:\s*([\d,\s]*)/i;

/**
 * Matches `There is no MLLW for the station: 9087044` and its `There is no CRD Offset for the
 * station: 9440083` variant. The captured token is checked for being all-uppercase before the
 * message is read as a datum rejection, so an unrelated sentence of the same shape — `There is
 * no data for the station` — cannot be mistaken for one.
 */
const DATUM_MISSING_PATTERN =
  /there is no\s+([A-Za-z]{2,6}\d{0,2})(?:\s+offset)?\s+for the station/i;

/**
 * Decodes a CO-OPS message into a typed reason. The single classification point for both
 * arms CO-OPS answers a rejected request on: an HTTP 200 carrying an `error` envelope, and
 * an HTTP 400 carrying the same envelope in the response body. Returns undefined for a
 * message this server has no specific reading of, leaving the caller's generic handling.
 *
 * `requestedDatum` is the datum the request carried, and is what separates the two causes
 * CO-OPS answers with one byte-identical sentence — see the ambiguity note below.
 */
function classifyCoopsMessage(
  message: string,
  requestedDatum?: string,
): { availableBins?: number[]; reason: CoopsReason } | undefined {
  const lower = message.toLowerCase();

  const binMatch = BIN_LIST_PATTERN.exec(message);
  if (binMatch?.[1] !== undefined) {
    const availableBins = binMatch[1]
      .split(',')
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((bin) => Number.isInteger(bin));
    return { reason: 'bin_unavailable', ...(availableBins.length > 0 ? { availableBins } : {}) };
  }

  // A blanket refusal for the whole class of station, at every datum — not a datum problem and
  // not an unknown ID. Checked before the datum and no-predictions branches, which both match it.
  if (lower.includes('great lakes') && lower.includes('predictions')) {
    return { reason: 'great_lakes_no_predictions' };
  }
  // The mirror refusal: `daily_mean` is published at Great Lakes stations only, so a coastal
  // station is rejected for the product rather than for its ID.
  if (lower.includes('great lakes') && lower.includes('daily mean')) {
    return { reason: 'great_lakes_only' };
  }

  // The datum wordings. CO-OPS names the datum on the water-level transport, and answers a
  // derived or out-of-set one with a fixed sentence instead.
  const datumMatch = DATUM_MISSING_PATTERN.exec(message);
  if (datumMatch?.[1] && datumMatch[1] === datumMatch[1].toUpperCase()) {
    return { reason: 'datum_unavailable' };
  }
  if (lower.includes('supported datum values') || lower.includes('wrong datum')) {
    return { reason: 'datum_unavailable' };
  }
  /*
   * The one ambiguous message. `No Predictions data was found. Please make sure the Datum input
   * is valid.` is byte-identical for a datum the station does not carry and for a subordinate
   * station's 6-minute request. The subordinate arm is refused from the catalog class before the
   * upstream call is spent, so a request that reaches this point and did not ask for MLLW — the
   * plane every prediction station carries — is the datum arm.
   */
  if (lower.includes('make sure the datum input is valid')) {
    return {
      reason: requestedDatum && requestedDatum !== 'MLLW' ? 'datum_unavailable' : 'no_predictions',
    };
  }

  // A coverage statement about a station CO-OPS recognizes — not an unrecognized ID.
  if (lower.includes('not available from the requested station')) {
    return { reason: 'predictions_unavailable' };
  }
  /*
   * The product-and-window refusal, which reads as a plain absence but is not one. CO-OPS
   * answers HTTP 200 with this sentence when the product is not published at the station at
   * all, and also when it is but the window has not been verified yet — it verifies the
   * coarser products monthly, for the prior month. Separated from the bare `no data was
   * found` below so a caller can name the lag instead of guessing at an outage.
   */
  if (lower.includes('may not be offered at this station at the requested time')) {
    return { reason: 'product_not_offered' };
  }
  if (lower.includes('no predictions') || lower.includes('no data was found')) {
    return { reason: 'no_predictions' };
  }
  if (
    lower.includes('wrong station id') ||
    lower.includes('station not available') ||
    lower.includes('no data found') ||
    lower.includes('invalid station')
  ) {
    return { reason: 'station_error' };
  }
  if (lower.includes('no data') || lower.includes('no observations')) {
    return { reason: 'no_data' };
  }
  return undefined;
}

/**
 * Reads the CO-OPS message out of a captured HTTP error body. CO-OPS answers a rejected
 * parameter with the same `{"error":{"message":…}}` envelope it uses on a 200, so the body
 * classifies through the same matcher; a body that is not that envelope is matched as-is,
 * since the capture is length-bounded and may be a fragment.
 */
function coopsMessageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? body;
  } catch {
    return body;
  }
}

const DATA_URL = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const MDAPI_URL = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface CacheEntry {
  fetchedAt: number;
  stations: CoopsStation[];
}

export class CoopsService {
  private readonly applicationId: string;
  private readonly stationCache = new Map<CoopsStationType, CacheEntry>();

  // AppConfig and StorageService accepted for init-pattern consistency; not used at runtime
  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.applicationId = serverConfig.applicationId;
  }

  /** Fetch (or return cached) station list for the given type. */
  async getStations(type: CoopsStationType, ctx: Context): Promise<CoopsStation[]> {
    const entry = this.stationCache.get(type);
    if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
      return entry.stations;
    }

    const stations = await withRetry(
      async () => {
        const url = `${MDAPI_URL}?type=${type}&application=${encodeURIComponent(this.applicationId)}`;
        const response = await fetchWithTimeout(url, 15_000, ctx, {
          signal: ctx.signal,
        });
        const text = await response.text();
        this.detectHtmlError(text);
        const parsed: CoopsStationListResponse = JSON.parse(text);
        return parsed.stations ?? [];
      },
      {
        operation: `CoopsService.getStations(${type})`,
        context: ctx,
        baseDelayMs: 2000,
        maxRetries: 2,
        signal: ctx.signal,
      },
    );

    this.stationCache.set(type, { stations, fetchedAt: Date.now() });
    ctx.log.debug('CO-OPS station list cached', { type, count: stations.length });
    return stations;
  }

  /**
   * Pre-warm the most-used station lists. Called during server setup.
   * Errors are caught and logged — pre-warm is best-effort.
   */
  async preWarm(ctx: Context): Promise<void> {
    await Promise.allSettled([
      this.getStations('tidepredictions', ctx),
      this.getStations('currentpredictions', ctx),
    ]);
  }

  /** Fetch tide predictions for a station over a date range. */
  async fetchTidePredictions(
    params: {
      station: string;
      begin_date: string;
      end_date: string;
      datum: string;
      time_zone: string;
      units: string;
      interval: string;
    },
    ctx: Context,
  ): Promise<{ predictions: CoopsPredictionRow[]; stationName: string }> {
    return await withRetry(
      async () => {
        // CO-OPS predictions API accepts "6" not "6min"; translate the user-facing enum.
        const apiInterval = params.interval === '6min' ? '6' : params.interval;
        const url = this.buildDataUrl({
          station: params.station,
          product: 'predictions',
          begin_date: params.begin_date,
          end_date: params.end_date,
          datum: params.datum,
          time_zone: params.time_zone,
          units: params.units,
          interval: apiInterval,
          format: 'json',
        });
        const response = await fetchWithTimeout(url, 20_000, ctx, {
          signal: ctx.signal,
        });
        const text = await response.text();
        this.detectHtmlError(text);
        const parsed = JSON.parse(text);
        this.checkCoopsError(parsed, params.datum);
        const predictions: CoopsPredictionRow[] = parsed.predictions ?? [];
        // Station name isn't in this response; caller handles it
        return { predictions, stationName: parsed.metadata?.name ?? params.station };
      },
      {
        operation: 'CoopsService.fetchTidePredictions',
        context: ctx,
        baseDelayMs: 1000,
        maxRetries: 3,
        signal: ctx.signal,
      },
    ).catch((err: unknown) => this.rethrowClassified(err, params.datum));
  }

  /**
   * Fetch observed water levels for a station from one of the four water-level products —
   * `water_level`, `hourly_height`, `high_low`, or `daily_mean`.
   */
  async fetchWaterLevel(
    params: {
      station: string;
      begin_date: string;
      end_date: string;
      datum: string;
      /** CO-OPS product name. Decides the row cadence and which keys the rows carry. */
      product: string;
      time_zone: string;
      units: string;
    },
    ctx: Context,
  ): Promise<{ data: CoopsDataRow[]; stationName: string }> {
    return await withRetry(
      async () => {
        /*
         * `daily_mean` is served in local standard time only. CO-OPS does not reject another
         * value — it shifts every row by the daylight offset, so a `lst_ldt` request comes
         * back stamped 18:00 the previous day and carrying the next day's mean. Forced here,
         * at the transport that knows the constraint, rather than trusted to each caller.
         */
        const timeZone = params.product === 'daily_mean' ? 'lst' : params.time_zone;
        const url = this.buildDataUrl({
          station: params.station,
          product: params.product,
          begin_date: params.begin_date,
          end_date: params.end_date,
          datum: params.datum,
          time_zone: timeZone,
          units: params.units,
          format: 'json',
        });
        const response = await fetchWithTimeout(url, 20_000, ctx, {
          signal: ctx.signal,
        });
        const text = await response.text();
        this.detectHtmlError(text);
        const parsed = JSON.parse(text);
        this.checkCoopsError(parsed, params.datum);
        return { data: parsed.data ?? [], stationName: parsed.metadata?.name ?? params.station };
      },
      {
        operation: 'CoopsService.fetchWaterLevel',
        context: ctx,
        baseDelayMs: 1000,
        maxRetries: 3,
        signal: ctx.signal,
      },
    ).catch((err: unknown) => this.rethrowClassified(err, params.datum));
  }

  /**
   * Fetch the prediction series paired with a water-level request (companion fetch). The
   * interval matches the observed product's cadence — `6` for `water_level`, `h` for
   * `hourly_height`, `hilo` for `high_low` — so the two series describe the same instants.
   */
  async fetchWaterLevelPredictions(
    params: {
      station: string;
      begin_date: string;
      end_date: string;
      datum: string;
      /** CO-OPS prediction interval, as the API spells it: `6`, `h`, or `hilo`. */
      interval: string;
      time_zone: string;
      units: string;
    },
    ctx: Context,
  ): Promise<CoopsPredictionRow[]> {
    return await withRetry(
      async () => {
        const url = this.buildDataUrl({
          station: params.station,
          product: 'predictions',
          begin_date: params.begin_date,
          end_date: params.end_date,
          datum: params.datum,
          time_zone: params.time_zone,
          units: params.units,
          interval: params.interval,
          format: 'json',
        });
        const response = await fetchWithTimeout(url, 20_000, ctx, {
          signal: ctx.signal,
        });
        const text = await response.text();
        this.detectHtmlError(text);
        const parsed = JSON.parse(text);
        // Predictions can fail for some stations — caller degrades gracefully
        if (parsed.error) return [];
        return (parsed.predictions ?? []) as CoopsPredictionRow[];
      },
      {
        operation: 'CoopsService.fetchWaterLevelPredictions',
        context: ctx,
        baseDelayMs: 1000,
        maxRetries: 2,
        signal: ctx.signal,
      },
    ).catch((err: unknown) => this.rethrowClassified(err, params.datum));
  }

  /** Fetch current predictions for a station, optionally for a specific depth bin. */
  async fetchCurrentPredictions(
    params: {
      station: string;
      begin_date: string;
      end_date: string;
      time_zone: string;
      units: string;
      interval: string;
      /** Depth bin to predict for. Omitted lets CO-OPS pick its default, the shallowest bin. */
      bin?: number;
    },
    ctx: Context,
  ): Promise<{
    events?: CoopsCurrentRow[];
    predictions?: CoopsCurrent6MinRow[];
    /**
     * CO-OPS's own sentence, returned where the event array belongs — it says
     * "Currents are weak and variable" for a station whose currents it will not
     * predict as flood/ebb/slack events. A real answer, not an absent one.
     */
    statement?: string;
    stationName: string;
  }> {
    return await withRetry(
      async () => {
        // CO-OPS currents_predictions API accepts "6" not "6min"; translate the user-facing enum.
        const apiInterval = params.interval === '6min' ? '6' : params.interval;
        const url = this.buildDataUrl({
          station: params.station,
          product: 'currents_predictions',
          begin_date: params.begin_date,
          end_date: params.end_date,
          time_zone: params.time_zone,
          units: params.units,
          interval: apiInterval,
          format: 'json',
          ...(params.bin !== undefined ? { bin: String(params.bin) } : {}),
        });
        const response = await fetchWithTimeout(url, 20_000, ctx, {
          signal: ctx.signal,
        });
        const text = await response.text();
        this.detectHtmlError(text);
        const parsed = JSON.parse(text);
        this.checkCoopsError(parsed);
        // CO-OPS puts a string where the array belongs when it will not predict discrete
        // events for the station. Carry the sentence through — it is the answer.
        const rawCp = parsed.current_predictions?.cp;
        const cp: CoopsCurrentRow[] | CoopsCurrent6MinRow[] = Array.isArray(rawCp) ? rawCp : [];
        const statement = typeof rawCp === 'string' ? rawCp : undefined;
        const stationName: string = parsed.metadata?.name ?? params.station;
        const shared = { ...(statement !== undefined ? { statement } : {}), stationName };
        if (params.interval === 'MAX_SLACK') {
          return { events: cp as CoopsCurrentRow[], ...shared };
        }
        return { predictions: cp as CoopsCurrent6MinRow[], ...shared };
      },
      {
        operation: 'CoopsService.fetchCurrentPredictions',
        context: ctx,
        baseDelayMs: 1000,
        maxRetries: 3,
        signal: ctx.signal,
      },
    ).catch((err: unknown) => this.rethrowClassified(err));
  }

  private buildDataUrl(params: Record<string, string>): string {
    const p = new URLSearchParams({
      ...params,
      application: this.applicationId,
    });
    return `${DATA_URL}?${p.toString()}`;
  }

  private detectHtmlError(text: string): void {
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'CO-OPS API returned HTML instead of JSON — likely rate-limited or temporarily unavailable.',
      );
    }
  }

  private checkCoopsError(parsed: unknown, requestedDatum?: string): void {
    const p = parsed as CoopsErrorResponse | Record<string, unknown>;
    if (!(p && typeof p === 'object' && 'error' in p && p.error)) return;
    const errObj = p.error as { message?: string };
    const message = errObj.message ?? 'Unknown CO-OPS error';

    // Deterministic domain errors — map to typed reasons; no retry warranted.
    const classified = classifyCoopsMessage(message, requestedDatum);
    if (classified) {
      throw new CoopsBodyError(classified.reason, `CO-OPS error: ${message}`, {
        ...(classified.availableBins ? { availableBins: classified.availableBins } : {}),
      });
    }

    // Unknown CO-OPS error — generic ServiceUnavailable.
    throw serviceUnavailable(`CO-OPS error: ${message}`);
  }

  /**
   * Re-throws an HTTP failure as a typed `CoopsBodyError` when its captured body carries a
   * message the classifier recognizes — CO-OPS rejects a bad bin with an HTTP 400 whose body
   * names the station's real bins, and a datum the station does not carry with a 400 whose body
   * names the datum, which is the recovery the caller needs in both cases. Anything else
   * bubbles unchanged so the tool's generic status handling still applies.
   */
  private rethrowClassified(err: unknown, requestedDatum?: string): never {
    const data =
      err instanceof McpError ? (err.data as Record<string, unknown> | undefined) : undefined;
    if (typeof data?.body === 'string') {
      const message = coopsMessageFromBody(data.body);
      const classified = classifyCoopsMessage(message, requestedDatum);
      if (classified) {
        throw new CoopsBodyError(classified.reason, `CO-OPS error: ${message}`, {
          cause: err,
          ...(classified.availableBins ? { availableBins: classified.availableBins } : {}),
        });
      }
    }
    throw err;
  }
}

// --- Init/accessor pattern ---

let _service: CoopsService | undefined;

export function initCoopsService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new CoopsService(config, storage, serverConfig);
}

export function getCoopsService(): CoopsService {
  if (!_service) {
    throw new Error('CoopsService not initialized — call initCoopsService() in setup()');
  }
  return _service;
}
