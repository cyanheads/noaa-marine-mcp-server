/**
 * @fileoverview CO-OPS Tides & Currents API service — station list cache and data fetching.
 * @module services/coops/coops-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
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
 * Thrown when CO-OPS returns a body-level error response.
 * Carries a `coopsReason` discriminator so tool handlers can map it to a
 * typed contract reason without string-parsing the raw CO-OPS message.
 *
 *   'no_data'        — no observations for the date range / station type
 *   'no_predictions' — no prediction data available
 *   'station_error'  — station rejected / not available
 */
export class CoopsBodyError extends McpError {
  readonly coopsReason: 'no_data' | 'no_predictions' | 'station_error';

  constructor(coopsReason: 'no_data' | 'no_predictions' | 'station_error', message: string) {
    // retryable: false — deterministic domain errors should not be retried.
    super(JsonRpcErrorCode.ServiceUnavailable, message, { coopsReason, retryable: false });
    this.coopsReason = coopsReason;
  }
}

/** Type guard for CoopsBodyError — avoids instanceof brittleness across module boundaries. */
export function isCoopsBodyError(
  err: unknown,
): err is CoopsBodyError & { coopsReason: 'no_data' | 'no_predictions' | 'station_error' } {
  return (
    err instanceof Error &&
    'coopsReason' in err &&
    typeof (err as CoopsBodyError).coopsReason === 'string'
  );
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
        const response = await fetchWithTimeout(url, 15_000, ctx as unknown as RequestContext, {
          signal: ctx.signal,
        });
        const text = await response.text();
        this.detectHtmlError(text);
        const parsed: CoopsStationListResponse = JSON.parse(text);
        return parsed.stations ?? [];
      },
      {
        operation: `CoopsService.getStations(${type})`,
        context: ctx as unknown as RequestContext,
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
        const response = await fetchWithTimeout(url, 20_000, ctx as unknown as RequestContext, {
          signal: ctx.signal,
        });
        const text = await response.text();
        this.detectHtmlError(text);
        const parsed = JSON.parse(text);
        this.checkCoopsError(parsed);
        const predictions: CoopsPredictionRow[] = parsed.predictions ?? [];
        // Station name isn't in this response; caller handles it
        return { predictions, stationName: parsed.metadata?.name ?? params.station };
      },
      {
        operation: 'CoopsService.fetchTidePredictions',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        maxRetries: 3,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch observed water levels for a station. */
  async fetchWaterLevel(
    params: {
      station: string;
      begin_date: string;
      end_date: string;
      datum: string;
      time_zone: string;
      units: string;
    },
    ctx: Context,
  ): Promise<{ data: CoopsDataRow[]; stationName: string }> {
    return await withRetry(
      async () => {
        const url = this.buildDataUrl({
          station: params.station,
          product: 'water_level',
          begin_date: params.begin_date,
          end_date: params.end_date,
          datum: params.datum,
          time_zone: params.time_zone,
          units: params.units,
          format: 'json',
        });
        const response = await fetchWithTimeout(url, 20_000, ctx as unknown as RequestContext, {
          signal: ctx.signal,
        });
        const text = await response.text();
        this.detectHtmlError(text);
        const parsed = JSON.parse(text);
        this.checkCoopsError(parsed);
        return { data: parsed.data ?? [], stationName: parsed.metadata?.name ?? params.station };
      },
      {
        operation: 'CoopsService.fetchWaterLevel',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        maxRetries: 3,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch water level predictions for the same date range as a water_level request (companion fetch). */
  async fetchWaterLevelPredictions(
    params: {
      station: string;
      begin_date: string;
      end_date: string;
      datum: string;
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
          interval: '6',
          format: 'json',
        });
        const response = await fetchWithTimeout(url, 20_000, ctx as unknown as RequestContext, {
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
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        maxRetries: 2,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch current predictions for a station. */
  async fetchCurrentPredictions(
    params: {
      station: string;
      begin_date: string;
      end_date: string;
      time_zone: string;
      units: string;
      interval: string;
    },
    ctx: Context,
  ): Promise<{
    events?: CoopsCurrentRow[];
    predictions?: CoopsCurrent6MinRow[];
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
        });
        const response = await fetchWithTimeout(url, 20_000, ctx as unknown as RequestContext, {
          signal: ctx.signal,
        });
        const text = await response.text();
        this.detectHtmlError(text);
        const parsed = JSON.parse(text);
        this.checkCoopsError(parsed);
        // CO-OPS MAX_SLACK returns cp as a string (e.g. "Currents are weak and variable")
        // instead of an array when there are no significant flood/ebb/slack events.
        const rawCp = parsed.current_predictions?.cp;
        const cp: CoopsCurrentRow[] | CoopsCurrent6MinRow[] = Array.isArray(rawCp) ? rawCp : [];
        const stationName: string = parsed.metadata?.name ?? params.station;
        if (params.interval === 'MAX_SLACK') {
          return { events: cp as CoopsCurrentRow[], stationName };
        }
        return { predictions: cp as CoopsCurrent6MinRow[], stationName };
      },
      {
        operation: 'CoopsService.fetchCurrentPredictions',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        maxRetries: 3,
        signal: ctx.signal,
      },
    );
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

  private checkCoopsError(parsed: unknown): void {
    const p = parsed as CoopsErrorResponse | Record<string, unknown>;
    if (!(p && typeof p === 'object' && 'error' in p && p.error)) return;
    const errObj = p.error as { message?: string };
    const message = errObj.message ?? 'Unknown CO-OPS error';
    const lower = message.toLowerCase();

    // Deterministic domain errors — map to typed reasons; no retry warranted.
    if (lower.includes('no predictions') || lower.includes('no data was found')) {
      throw new CoopsBodyError('no_predictions', `CO-OPS error: ${message}`);
    }
    if (
      lower.includes('not available from the requested station') ||
      lower.includes('station not available') ||
      lower.includes('no data found') ||
      lower.includes('invalid station')
    ) {
      throw new CoopsBodyError('station_error', `CO-OPS error: ${message}`);
    }
    if (lower.includes('no data') || lower.includes('no observations')) {
      throw new CoopsBodyError('no_data', `CO-OPS error: ${message}`);
    }

    // Unknown CO-OPS error — generic ServiceUnavailable.
    throw serviceUnavailable(`CO-OPS error: ${message}`);
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
