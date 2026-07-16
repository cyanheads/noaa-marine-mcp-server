/**
 * @fileoverview NDBC (National Data Buoy Center) service — active stations XML cache and realtime text parser.
 * @module services/ndbc/ndbc-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  NdbcCurrentBin,
  NdbcCurrentProfile,
  NdbcObservation,
  NdbcOceanObservation,
  NdbcOceanReading,
  NdbcStation,
} from './types.js';

const ACTIVE_STATIONS_URL = 'https://www.ndbc.noaa.gov/activestations.xml';
const REALTIME_URL = (id: string) =>
  `https://www.ndbc.noaa.gov/data/realtime2/${id.toUpperCase()}.txt`;
const ADCP_URL = (id: string) =>
  `https://www.ndbc.noaa.gov/data/realtime2/${id.toUpperCase()}.adcp`;
const OCEAN_URL = (id: string) =>
  `https://www.ndbc.noaa.gov/data/realtime2/${id.toUpperCase()}.ocean`;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface StationCache {
  fetchedAt: number;
  stations: NdbcStation[];
}

export class NdbcService {
  private stationCache: StationCache | null = null;

  /** Fetch (or return cached) NDBC active stations. */
  async getActiveStations(ctx: Context): Promise<NdbcStation[]> {
    if (this.stationCache && Date.now() - this.stationCache.fetchedAt < CACHE_TTL_MS) {
      return this.stationCache.stations;
    }

    const stations = await withRetry(
      async () => {
        const response = await fetchWithTimeout(
          ACTIVE_STATIONS_URL,
          20_000,
          ctx as unknown as RequestContext,
          { signal: ctx.signal },
        );
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('NDBC active stations returned HTML — service may be down.');
        }
        return this.parseActiveStationsXml(text);
      },
      {
        operation: 'NdbcService.getActiveStations',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 2000,
        maxRetries: 2,
        signal: ctx.signal,
      },
    );

    this.stationCache = { stations, fetchedAt: Date.now() };
    ctx.log.debug('NDBC active stations cached', { count: stations.length });
    return stations;
  }

  /** Pre-warm the active station cache. Called during server setup. */
  async preWarm(ctx: Context): Promise<void> {
    await this.getActiveStations(ctx);
  }

  /** Fetch the most recent observation for a buoy from the realtime2 text feed. */
  async fetchObservation(stationId: string, ctx: Context): Promise<NdbcObservation> {
    return await withRetry(
      async () => {
        const url = REALTIME_URL(stationId);
        const response = await fetchWithTimeout(url, 10_000, ctx as unknown as RequestContext, {
          signal: ctx.signal,
        });

        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('NDBC realtime endpoint returned HTML — likely rate-limited.');
        }

        return this.parseRealtimeText(text, stationId);
      },
      {
        operation: `NdbcService.fetchObservation(${stationId})`,
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        maxRetries: 2,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch and parse the latest ADCP current profile for a station from the realtime2 `.adcp` feed. */
  async fetchCurrentProfile(stationId: string, ctx: Context): Promise<NdbcCurrentProfile> {
    return await withRetry(
      async () => {
        const url = ADCP_URL(stationId);
        const response = await fetchWithTimeout(url, 10_000, ctx as unknown as RequestContext, {
          signal: ctx.signal,
        });

        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('NDBC ADCP endpoint returned HTML — likely rate-limited.');
        }

        return this.parseAdcpText(text, stationId);
      },
      {
        operation: `NdbcService.fetchCurrentProfile(${stationId})`,
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        maxRetries: 2,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch and parse the latest oceanographic observation for a station from the realtime2 `.ocean` feed. */
  async fetchOceanObservations(stationId: string, ctx: Context): Promise<NdbcOceanObservation> {
    return await withRetry(
      async () => {
        const url = OCEAN_URL(stationId);
        const response = await fetchWithTimeout(url, 10_000, ctx as unknown as RequestContext, {
          signal: ctx.signal,
        });

        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('NDBC ocean endpoint returned HTML — likely rate-limited.');
        }

        return this.parseOceanText(text, stationId);
      },
      {
        operation: `NdbcService.fetchOceanObservations(${stationId})`,
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        maxRetries: 2,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Parse an NDBC ADCP (`.adcp`) realtime file into the most recent current profile.
   * Layout: two `#`-prefixed header lines (`#YY MM DD hh mm DEP01 DIR01 SPD01 …`,
   * then a units line), followed by data rows most-recent-first. Each data row is
   * `YY MM DD hh mm` then up to 20 depth-bin triples (depth m, direction degT, speed cm/s).
   * Rows are variable-width — trailing bins are omitted rather than padded — and any
   * component may be the literal `MM` (missing). A bin is emitted only when its depth
   * is present; direction and speed become null when their token is `MM`.
   */
  parseAdcpText(text: string, stationId: string): NdbcCurrentProfile {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (!lines.some((l) => l.startsWith('#'))) {
      throw serviceUnavailable(`NDBC ADCP file for ${stationId} has no header row.`);
    }

    // Rows are reverse-chronological, so the first non-header line is the latest observation.
    const dataLine = lines.find((l) => !l.startsWith('#'));
    if (!dataLine) {
      throw notFound(
        `NDBC station ${stationId} has no current-profile data rows — station may be offline.`,
        {
          stationId,
          reason: 'no_current_data',
        },
      );
    }

    const tokens = dataLine.split(/\s+/);
    const bins: NdbcCurrentBin[] = [];
    // Direction/speed are null when NDBC wrote the literal `MM` for that component.
    const parseComponent = (tok: string | undefined): number | null => {
      if (tok === undefined || tok === 'MM') return null;
      const n = Number.parseFloat(tok);
      return Number.isNaN(n) ? null : n;
    };
    // Skip the 5 leading time columns (YY MM DD hh mm); the rest are depth/dir/speed triples.
    for (let i = 5; i + 3 <= tokens.length; i += 3) {
      const depthTok = tokens[i];
      if (depthTok === undefined || depthTok === 'MM') continue;
      const depthM = Number.parseFloat(depthTok);
      if (Number.isNaN(depthM)) continue;

      bins.push({
        depthM,
        directionDeg: parseComponent(tokens[i + 1]),
        speedCmS: parseComponent(tokens[i + 2]),
      });
    }

    if (bins.length === 0) {
      throw notFound(
        `NDBC station ${stationId} reported no usable current bins — profiler offline or all bins missing.`,
        { stationId, reason: 'no_current_data' },
      );
    }

    // Build the ISO timestamp from the YY MM DD hh mm columns. NDBC emits 4-digit years in
    // the YY column, so treat values ≥ 1000 as already-full years (mirrors parseRealtimeText).
    const [yy, mo, dd, hh, mn] = tokens;
    const observedAt =
      yy && mo && dd && hh && mn
        ? (() => {
            const n = Number.parseInt(yy, 10);
            const year = n >= 1000 ? n : n < 50 ? 2000 + n : 1900 + n;
            return `${year}-${mo.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${mn.padStart(2, '0')}:00Z`;
          })()
        : new Date().toISOString();

    return { observedAt, bins };
  }

  /**
   * Parse an NDBC oceanographic (`.ocean`) realtime file into the most recent observation.
   * Layout: two `#`-prefixed header lines
   * (`#YY MM DD hh mm DEPTH OTMP COND SAL O2% O2PPM CLCON TURB PH EH`, then a units line),
   * followed by data rows most-recent-first. Columns are fixed-position: five time columns,
   * then depth (m) and the nine water-column sensors. A station reports one row per depth, so
   * a single timestamp can carry several rows — the latest observation is every row that shares
   * the first (most recent) row's timestamp. Any sensor token may be the literal `MM`
   * (missing → null); a reading is emitted only when its depth is present to anchor it.
   */
  parseOceanText(text: string, stationId: string): NdbcOceanObservation {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (!lines.some((l) => l.startsWith('#'))) {
      throw serviceUnavailable(`NDBC ocean file for ${stationId} has no header row.`);
    }

    const dataLines = lines.filter((l) => !l.startsWith('#'));
    const firstDataLine = dataLines[0];
    if (firstDataLine === undefined) {
      throw notFound(
        `NDBC station ${stationId} has no oceanographic data rows — station may be offline.`,
        { stationId, reason: 'no_ocean_data' },
      );
    }

    // A token that is absent or the literal `MM` (NDBC's missing marker) becomes null.
    const parseValue = (tok: string | undefined): number | null => {
      if (tok === undefined || tok === 'MM') return null;
      const n = Number.parseFloat(tok);
      return Number.isNaN(n) ? null : n;
    };

    // Rows are reverse-chronological, so the first data row is the latest observation. Its five
    // time columns key that observation; collect every row sharing them, since a station reporting
    // multiple depths emits one row per depth at the same timestamp. Older observations sort after,
    // so stopping at the first differing timestamp captures exactly the latest observation.
    const firstTokens = firstDataLine.split(/\s+/);
    const timeKey = firstTokens.slice(0, 5).join(' ');

    const readings: NdbcOceanReading[] = [];
    for (const line of dataLines) {
      const tokens = line.split(/\s+/);
      if (tokens.slice(0, 5).join(' ') !== timeKey) break;

      // Column index 5 is depth; a reading needs a real depth to anchor it (mirrors parseAdcpText).
      const depthTok = tokens[5];
      if (depthTok === undefined || depthTok === 'MM') continue;
      const depthM = Number.parseFloat(depthTok);
      if (Number.isNaN(depthM)) continue;

      readings.push({
        depthM,
        waterTempC: parseValue(tokens[6]),
        conductivityMsCm: parseValue(tokens[7]),
        salinityPsu: parseValue(tokens[8]),
        oxygenPercent: parseValue(tokens[9]),
        oxygenPpm: parseValue(tokens[10]),
        chlorophyllUgL: parseValue(tokens[11]),
        turbidityFtu: parseValue(tokens[12]),
        ph: parseValue(tokens[13]),
        redoxMv: parseValue(tokens[14]),
      });
    }

    if (readings.length === 0) {
      throw notFound(
        `NDBC station ${stationId} reported no usable oceanographic readings — every depth row in the latest observation is missing (station offline or sensor failure).`,
        { stationId, reason: 'no_ocean_data' },
      );
    }

    // Build the ISO timestamp from the YY MM DD hh mm columns. NDBC emits 4-digit years in
    // the YY column, so treat values ≥ 1000 as already-full years (mirrors parseAdcpText).
    const [yy, mo, dd, hh, mn] = firstTokens;
    const observedAt =
      yy && mo && dd && hh && mn
        ? (() => {
            const n = Number.parseInt(yy, 10);
            const year = n >= 1000 ? n : n < 50 ? 2000 + n : 1900 + n;
            return `${year}-${mo.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${mn.padStart(2, '0')}:00Z`;
          })()
        : new Date().toISOString();

    return { observedAt, readings };
  }

  /** Parse NDBC active stations XML into NdbcStation array. */
  private parseActiveStationsXml(xml: string): NdbcStation[] {
    const stations: NdbcStation[] = [];
    // Match each <Station ...> element
    const stationRegex = /<Station\s([^>]*?)(?:\/?>)/gi;

    for (
      let matchResult = stationRegex.exec(xml);
      matchResult !== null;
      matchResult = stationRegex.exec(xml)
    ) {
      const attrs = matchResult[1] ?? '';
      const get = (name: string): string | undefined => {
        const m = new RegExp(`${name}="([^"]*)"`, 'i').exec(attrs);
        return m ? m[1] : undefined;
      };

      const id = get('ID') ?? get('id');
      const lat = get('lat');
      const lon = get('lon');
      const name = get('name');

      if (!id || lat === undefined || lon === undefined) continue;

      const latNum = Number.parseFloat(lat);
      const lonNum = Number.parseFloat(lon);
      if (Number.isNaN(latNum) || Number.isNaN(lonNum)) continue;

      const stationType = get('type');
      const stationOwner = get('owner');
      stations.push({
        id: id.toUpperCase(),
        // NDBC ships some rows with name="" (or whitespace-only); normalize to an
        // `NDBC <ID>` label so blank names don't sort first or render empty downstream.
        name: name?.trim() || `NDBC ${id.toUpperCase()}`,
        lat: latNum,
        lon: lonNum,
        ...(stationType !== undefined && { type: stationType }),
        ...(stationOwner !== undefined && { owner: stationOwner }),
        hasMet: get('met') === 'y' || get('met') === '1',
        hasCurrents: get('currents') === 'y' || get('currents') === '1',
      });
    }

    return stations;
  }

  /**
   * Parse NDBC fixed-width realtime2 text file into a NdbcObservation.
   * Line 1: header (# + column names)
   * Line 2: units row (ignored)
   * Lines 3+: data rows most recent first
   * MM = missing sensor value → null
   */
  parseRealtimeText(text: string, stationId: string): NdbcObservation {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // Find the header line
    const headerLine = lines.find((l) => l.startsWith('#'));
    if (!headerLine) {
      throw serviceUnavailable(`NDBC file for ${stationId} has no header row.`);
    }

    const columns = headerLine
      .replace(/^#+\s*/, '')
      .split(/\s+/)
      .map((c) => c.toUpperCase());

    // Find first data row (not starting with #)
    const dataLine = lines.find((l) => !l.startsWith('#'));
    if (!dataLine) {
      throw notFound(`NDBC buoy ${stationId} has no data rows — buoy may be offline.`, {
        stationId,
        reason: 'no_sensor_data',
      });
    }

    const values = dataLine.split(/\s+/);

    const get = (col: string): string | null => {
      const idx = columns.indexOf(col);
      if (idx < 0 || idx >= values.length) return null;
      const v = values[idx];
      return v === 'MM' || v === undefined ? null : v;
    };

    const toNum = (col: string): number | null => {
      const v = get(col);
      if (v === null) return null;
      const n = Number.parseFloat(v);
      return Number.isNaN(n) ? null : n;
    };

    // Build ISO timestamp from YY MM DD hh mm columns.
    // NOTE: NDBC header uses lowercase 'mm' for minutes; after uppercasing, the
    // columns array has 'MM' at index 1 (month) AND at index 4 (minute).
    // indexOf returns the first match (month), so we use lastIndexOf for minutes.
    const getMinute = (): string | null => {
      const idx = columns.lastIndexOf('MM');
      if (idx < 0 || idx >= values.length) return null;
      const v = values[idx];
      return v === 'MM' || v === undefined ? null : v;
    };

    const yy = get('YY') ?? get('#YY');
    const mo = get('MM');
    const dd = get('DD');
    const hh = get('HH');
    const mn = getMinute();

    // NDBC emits 4-digit years in the YY column despite the column name suggesting otherwise.
    // Treat values ≥ 1000 as already-full years; add 2000 only for genuine 2-digit values.
    const year = yy
      ? (() => {
          const n = Number.parseInt(yy, 10);
          return n >= 1000 ? n : n < 50 ? 2000 + n : 1900 + n;
        })()
      : new Date().getFullYear();
    const observedAt =
      yy && mo && dd && hh && mn
        ? `${year}-${mo.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${mn.padStart(2, '0')}:00Z`
        : new Date().toISOString();

    // Check if all sensor fields are MM
    const sensorCols = [
      'WDIR',
      'WSPD',
      'GST',
      'WVHT',
      'DPD',
      'APD',
      'MWD',
      'PRES',
      'ATMP',
      'WTMP',
      'DEWP',
    ];
    const allMissing = sensorCols.every((col) => get(col) === null);
    if (allMissing) {
      throw notFound(
        `NDBC buoy ${stationId} has all sensor fields missing — buoy offline or sensor failure.`,
        { stationId, reason: 'no_sensor_data' },
      );
    }

    return {
      observedAt,
      windDirectionDeg: toNum('WDIR'),
      windSpeedMs: toNum('WSPD'),
      gustSpeedMs: toNum('GST'),
      waveHeightM: toNum('WVHT'),
      dominantPeriodSec: toNum('DPD'),
      averagePeriodSec: toNum('APD'),
      meanWaveDirectionDeg: toNum('MWD'),
      pressureHpa: toNum('PRES'),
      airTempC: toNum('ATMP'),
      waterTempC: toNum('WTMP'),
      dewPointC: toNum('DEWP'),
      visibilityNmi: toNum('VIS'),
      tideFt: toNum('TIDE'),
    };
  }
}

// --- Init/accessor pattern ---

let _service: NdbcService | undefined;

export function initNdbcService(): void {
  _service = new NdbcService();
}

export function getNdbcService(): NdbcService {
  if (!_service) {
    throw new Error('NdbcService not initialized — call initNdbcService() in setup()');
  }
  return _service;
}
