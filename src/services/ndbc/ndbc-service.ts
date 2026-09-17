/**
 * @fileoverview NDBC (National Data Buoy Center) service — active stations XML cache and realtime text parser.
 * @module services/ndbc/ndbc-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  NdbcColumnGroup,
  NdbcCurrentBin,
  NdbcCurrentProfile,
  NdbcObservation,
  NdbcOceanObservation,
  NdbcOceanReading,
  NdbcStaleGroup,
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

/**
 * One `name="value"` pair of a station element's attribute list. Matching the whole list in a
 * single pass keeps the parse to one regex per station rather than one per attribute read, and
 * matches each name in full, so a short name can never match the tail of a longer one.
 */
const ATTRIBUTE_REGEX = /([\w:.-]+)="([^"]*)"/g;

/** The named XML character references that can appear in the active-stations feed. */
const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

/**
 * Decode XML character references — named, decimal, and hex — in a single pass.
 * One replacer is what makes the decode order-independent: a chained decoder that
 * expanded `&amp;` before the named entities would turn a literal `&amp;quot;` into a
 * bare quote. A value carrying no references is returned unchanged.
 */
function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) => {
    if (ref.startsWith('#')) {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      const code = Number.parseInt(hex ? ref.slice(2) : ref.slice(1), hex ? 16 : 10);
      return Number.isNaN(code) || code < 0 || code > 0x10ffff ? match : String.fromCodePoint(code);
    }
    return XML_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/** An NDBC row's observation time: the ISO instant plus its epoch milliseconds. */
interface NdbcRowTime {
  epochMs: number;
  iso: string;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** A time column is usable only as a bare non-negative integer — `MM` and junk are not. */
const timeComponent = (token: string | null | undefined): number | null =>
  token !== null && token !== undefined && /^\d{1,4}$/.test(token)
    ? Number.parseInt(token, 10)
    : null;

/**
 * Build a validated instant from a realtime row's five leading time columns (YY MM DD hh mm).
 * Returns null when any column is absent, is NDBC's `MM` missing marker, is non-numeric, or
 * forms a date that does not exist (month 13, day 32, 31 February) — callers skip such a row
 * instead of emitting a fabricated current time or a string `Date.parse` rejects. NDBC writes
 * 4-digit years in the YY column, so a value ≥ 1000 is already a full year.
 */
function parseRowTime(
  yy: string | null | undefined,
  mo: string | null | undefined,
  dd: string | null | undefined,
  hh: string | null | undefined,
  mn: string | null | undefined,
): NdbcRowTime | null {
  const rawYear = timeComponent(yy);
  const month = timeComponent(mo);
  const day = timeComponent(dd);
  const hour = timeComponent(hh);
  const minute = timeComponent(mn);
  if (
    rawYear === null ||
    month === null ||
    day === null ||
    hour === null ||
    minute === null ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }

  const year = rawYear >= 1000 ? rawYear : rawYear < 50 ? 2000 + rawYear : 1900 + rawYear;
  const epochMs = Date.UTC(year, month - 1, day, hour, minute);
  const asDate = new Date(epochMs);
  // Date.UTC rolls an impossible day forward (31 February → 3 March); reject it instead.
  if (asDate.getUTCMonth() !== month - 1 || asDate.getUTCDate() !== day) return null;

  return {
    epochMs,
    iso: `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00Z`,
  };
}

/**
 * Walk reverse-chronological `.adcp`/`.ocean` data rows — whose five time columns are always
 * the first five tokens — and return the newest one that carries a valid timestamp, skipping
 * any row whose time columns are malformed. Null when no row in the file is usable.
 */
function findLatestTimestampedRow(
  dataLines: string[],
): { index: number; time: NdbcRowTime; values: string[] } | null {
  for (const [index, line] of dataLines.entries()) {
    const values = line.split(/\s+/);
    const time = parseRowTime(values[0], values[1], values[2], values[3], values[4]);
    if (time) return { index, time, values };
  }
  return null;
}

/**
 * Look-back window for resolving a column block from an earlier row, measured back from the
 * newest row's timestamp. The slowest wave cadence observed across the live feeds is 60
 * minutes, so 90 clears every station with margin while keeping a stale reading — one station
 * carries a 38-day-old pressure value — out of a result presented as current.
 */
const GROUP_LOOKBACK_MS = 90 * 60 * 1000;

/**
 * Column blocks the realtime2 feed writes on independent processing cycles. A buoy emits a
 * met row every 5–60 minutes while its wave-processing pass runs on its own slower cycle,
 * leaving that block's columns `MM` on the rows in between. Each block resolves from the most
 * recent row inside GROUP_LOOKBACK_MS that carries any of its columns, and every field of the
 * block is read from that one row — a block is never assembled out of several rows.
 */
const COLUMN_GROUPS = {
  atmosphere: ['PRES', 'ATMP', 'DEWP'],
  tide: ['TIDE'],
  visibility: ['VIS'],
  water: ['WTMP'],
  wave: ['WVHT', 'DPD', 'APD', 'MWD'],
  wind: ['WDIR', 'WSPD', 'GST'],
} as const satisfies Record<NdbcColumnGroup, readonly string[]>;

export class NdbcService {
  private stationCache: StationCache | null = null;

  /** Fetch (or return cached) NDBC active stations. */
  async getActiveStations(ctx: Context): Promise<NdbcStation[]> {
    if (this.stationCache && Date.now() - this.stationCache.fetchedAt < CACHE_TTL_MS) {
      return this.stationCache.stations;
    }

    const stations = await withRetry(
      async () => {
        const response = await fetchWithTimeout(ACTIVE_STATIONS_URL, 20_000, ctx, {
          signal: ctx.signal,
        });
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('NDBC active stations returned HTML — service may be down.');
        }
        return this.parseActiveStationsXml(text);
      },
      {
        operation: 'NdbcService.getActiveStations',
        context: ctx,
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
        const response = await fetchWithTimeout(url, 10_000, ctx, {
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
        context: ctx,
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
        const response = await fetchWithTimeout(url, 10_000, ctx, {
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
        context: ctx,
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
        const response = await fetchWithTimeout(url, 10_000, ctx, {
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
        context: ctx,
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

    const dataLines = lines.filter((l) => !l.startsWith('#'));
    if (dataLines.length === 0) {
      throw notFound(
        `NDBC station ${stationId} has no current-profile data rows — station may be offline.`,
        {
          stationId,
          reason: 'no_current_data',
        },
      );
    }

    // Rows are reverse-chronological, so the latest observation is the newest row whose five
    // time columns form a real date. A row that fails that is skipped rather than fatal —
    // one malformed row upstream must not cost the caller the whole profile.
    const latest = findLatestTimestampedRow(dataLines);
    if (!latest) {
      throw serviceUnavailable(
        `NDBC ADCP file for ${stationId} carries no row with a valid observation timestamp — every row's time columns are malformed upstream.`,
        { stationId },
      );
    }

    const tokens = latest.values;
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

    return { observedAt: latest.time.iso, bins };
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
    if (dataLines.length === 0) {
      throw notFound(
        `NDBC station ${stationId} has no oceanographic data rows — station may be offline.`,
        { stationId, reason: 'no_ocean_data' },
      );
    }

    // The latest observation is keyed by the newest row whose five time columns form a real
    // date; a row that fails that is skipped rather than fatal (mirrors parseAdcpText).
    const latest = findLatestTimestampedRow(dataLines);
    if (!latest) {
      throw serviceUnavailable(
        `NDBC ocean file for ${stationId} carries no row with a valid observation timestamp — every row's time columns are malformed upstream.`,
        { stationId },
      );
    }

    // A token that is absent or the literal `MM` (NDBC's missing marker) becomes null.
    const parseValue = (tok: string | undefined): number | null => {
      if (tok === undefined || tok === 'MM') return null;
      const n = Number.parseFloat(tok);
      return Number.isNaN(n) ? null : n;
    };

    // The latest row's five time columns key the observation; collect every row sharing them,
    // since a station reporting multiple depths emits one row per depth at the same timestamp.
    // Older observations sort after, so stopping at the first differing timestamp captures
    // exactly the latest observation.
    const timeKey = latest.values.slice(0, 5).join(' ');

    const readings: NdbcOceanReading[] = [];
    for (const line of dataLines.slice(latest.index)) {
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

    return { observedAt: latest.time.iso, readings };
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
      // Lift every attribute in one pass, decoding each value as it is read, so a value the
      // parser starts reading later is covered by construction rather than by an enumerated
      // field list. Keys are lowercased because the feed's casing is not guaranteed.
      const attrs = new Map<string, string>();
      for (const [, name, value] of (matchResult[1] ?? '').matchAll(ATTRIBUTE_REGEX)) {
        if (name !== undefined && value !== undefined) {
          attrs.set(name.toLowerCase(), decodeXmlEntities(value));
        }
      }
      const get = (name: string): string | undefined => attrs.get(name);
      /** NDBC writes its capability flags as `y`/`n`, with `1` seen in older rows. */
      const flag = (name: string): boolean => get(name) === 'y' || get(name) === '1';

      const id = get('id');
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
        hasMet: flag('met'),
        hasCurrents: flag('currents'),
        hasWaterQuality: flag('waterquality'),
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
   *
   * `observedAt` is the newest data row's timestamp. Sensor values are resolved per column
   * block (COLUMN_GROUPS) from the most recent row inside GROUP_LOOKBACK_MS that carries
   * that block, because NDBC writes each block on its own processing cycle — reading the
   * newest row alone drops a wave sample the file is already carrying a few rows down. The
   * wave block reports the row it came from as `wavesObservedAt`, which can be older than
   * `observedAt`, and every block that resolved from an older row is listed in `staleGroups`.
   * The scan is reverse-chronological and stops at the first row past the window, so a
   * multi-thousand-row file is never walked end to end.
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

    const dataLines = lines.filter((l) => !l.startsWith('#'));
    if (dataLines.length === 0) {
      throw notFound(`NDBC buoy ${stationId} has no data rows — buoy may be offline.`, {
        stationId,
        reason: 'no_sensor_data',
      });
    }

    // NDBC's header writes lowercase `mm` for minutes; after uppercasing, 'MM' names both
    // the month column and the minute column, so minutes resolve through lastIndexOf.
    const minuteIdx = columns.lastIndexOf('MM');
    const cell = (values: string[], idx: number): string | null => {
      if (idx < 0 || idx >= values.length) return null;
      const v = values[idx];
      return v === 'MM' || v === undefined ? null : v;
    };
    const column = (values: string[], col: string): string | null =>
      cell(values, columns.indexOf(col));
    const rowTimeOf = (values: string[]): NdbcRowTime | null =>
      parseRowTime(
        column(values, 'YY'),
        column(values, 'MM'),
        column(values, 'DD'),
        column(values, 'HH'),
        cell(values, minuteIdx),
      );

    // Rows are reverse-chronological. The newest row whose time columns form a real date
    // anchors the observation; rows above it are malformed upstream and are skipped rather
    // than timestamped with the current time.
    let newest: { index: number; time: NdbcRowTime; values: string[] } | undefined;
    for (const [index, line] of dataLines.entries()) {
      const values = line.split(/\s+/);
      const time = rowTimeOf(values);
      if (time) {
        newest = { index, time, values };
        break;
      }
    }
    if (!newest) {
      throw serviceUnavailable(
        `NDBC realtime file for ${stationId} carries no row with a valid observation timestamp — every row's time columns are malformed upstream.`,
        { stationId },
      );
    }

    const windowStart = newest.time.epochMs - GROUP_LOOKBACK_MS;
    const resolved = new Map<NdbcColumnGroup, { time: NdbcRowTime; values: string[] }>();
    const pending = new Set(Object.keys(COLUMN_GROUPS) as NdbcColumnGroup[]);

    for (const [index, line] of dataLines.entries()) {
      if (index < newest.index) continue;
      if (pending.size === 0) break;
      const values = index === newest.index ? newest.values : line.split(/\s+/);
      const time = index === newest.index ? newest.time : rowTimeOf(values);
      // A malformed row is skipped, never fatal and never a stop — ending the scan on one
      // would hide every older row behind it.
      if (!time) continue;
      if (time.epochMs < windowStart) break;
      for (const group of [...pending]) {
        if (COLUMN_GROUPS[group].some((col) => column(values, col) !== null)) {
          resolved.set(group, { time, values });
          pending.delete(group);
        }
      }
    }

    // Every block that came from an older row, so a caller is never left reading a value as
    // though it were measured at observedAt. Sorted by block name to keep the list stable.
    const staleGroups: NdbcStaleGroup[] = [...resolved]
      .filter(([, row]) => row.time.epochMs < newest.time.epochMs)
      .map(([group, row]) => ({ group, observedAt: row.time.iso }))
      .sort((a, b) => a.group.localeCompare(b.group));

    const toNum = (group: NdbcColumnGroup, col: string): number | null => {
      const row = resolved.get(group);
      if (!row) return null;
      const raw = column(row.values, col);
      if (raw === null) return null;
      const n = Number.parseFloat(raw);
      return Number.isNaN(n) ? null : n;
    };

    const observation: NdbcObservation = {
      observedAt: newest.time.iso,
      staleGroups,
      wavesObservedAt: resolved.get('wave')?.time.iso ?? null,
      windDirectionDeg: toNum('wind', 'WDIR'),
      windSpeedMs: toNum('wind', 'WSPD'),
      gustSpeedMs: toNum('wind', 'GST'),
      waveHeightM: toNum('wave', 'WVHT'),
      dominantPeriodSec: toNum('wave', 'DPD'),
      averagePeriodSec: toNum('wave', 'APD'),
      meanWaveDirectionDeg: toNum('wave', 'MWD'),
      pressureHpa: toNum('atmosphere', 'PRES'),
      airTempC: toNum('atmosphere', 'ATMP'),
      waterTempC: toNum('water', 'WTMP'),
      dewPointC: toNum('atmosphere', 'DEWP'),
      visibilityNmi: toNum('visibility', 'VIS'),
      tideFt: toNum('tide', 'TIDE'),
    };

    // The all-missing check spans the same window the values were resolved over, so a buoy
    // that reported ten minutes ago is not reported offline because its newest row is bare.
    const allMissing = [
      observation.windDirectionDeg,
      observation.windSpeedMs,
      observation.gustSpeedMs,
      observation.waveHeightM,
      observation.dominantPeriodSec,
      observation.averagePeriodSec,
      observation.meanWaveDirectionDeg,
      observation.pressureHpa,
      observation.airTempC,
      observation.waterTempC,
      observation.dewPointC,
    ].every((v) => v === null);
    if (allMissing) {
      throw notFound(
        `NDBC buoy ${stationId} has all sensor fields missing — buoy offline or sensor failure.`,
        { stationId, reason: 'no_sensor_data' },
      );
    }

    return observation;
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
