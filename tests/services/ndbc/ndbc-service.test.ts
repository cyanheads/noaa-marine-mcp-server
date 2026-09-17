/**
 * @fileoverview Tests for NdbcService — active station XML parsing and realtime text parsing.
 * @module tests/services/ndbc/ndbc-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { beforeEach, describe, expect, it } from 'vitest';
import { NdbcService } from '@/services/ndbc/ndbc-service.js';
import type { NdbcStation } from '@/services/ndbc/types.js';

const makeService = () => new NdbcService();

/** Minimal valid realtime2 header. */
const HEADER =
  '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE\n';
const UNITS =
  '#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft\n';

function makeDataRow(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    YY: '25',
    MM: '01',
    DD: '15',
    hh: '12',
    mm: '00',
    WDIR: '270',
    WSPD: '5.0',
    GST: '7.0',
    WVHT: '2.1',
    DPD: '14',
    APD: '9.0',
    MWD: '275',
    PRES: '1013.5',
    ATMP: '12.3',
    WTMP: '11.0',
    DEWP: '8.5',
    VIS: 'MM',
    PTDY: 'MM',
    TIDE: 'MM',
  };
  const merged = { ...defaults, ...overrides };
  const cols = [
    'YY',
    'MM',
    'DD',
    'hh',
    'mm',
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
    'VIS',
    'PTDY',
    'TIDE',
  ];
  return cols.map((c) => merged[c] ?? 'MM').join(' ');
}

/** A realtime2 data row whose five time columns come from a `YY MM DD hh mm` string. */
function makeRow(time: string, overrides: Record<string, string> = {}): string {
  const [YY, MM, DD, hh, mm] = time.split(/\s+/);
  return makeDataRow({
    YY: YY ?? 'MM',
    MM: MM ?? 'MM',
    DD: DD ?? 'MM',
    hh: hh ?? 'MM',
    mm: mm ?? 'MM',
    ...overrides,
  });
}

describe('NdbcService.parseRealtimeText', () => {
  let svc: NdbcService;

  beforeEach(() => {
    svc = makeService();
  });

  it('parses a well-formed realtime file into a NdbcObservation', () => {
    const text = `${HEADER}${UNITS}\n${makeDataRow()}\n`;
    const obs = svc.parseRealtimeText(text, '46041');

    expect(obs.observedAt).toBe('2025-01-15T12:00:00Z');
    expect(obs.windDirectionDeg).toBe(270);
    expect(obs.windSpeedMs).toBe(5.0);
    expect(obs.gustSpeedMs).toBe(7.0);
    expect(obs.waveHeightM).toBe(2.1);
    expect(obs.dominantPeriodSec).toBe(14);
    expect(obs.pressureHpa).toBe(1013.5);
    expect(obs.airTempC).toBe(12.3);
    expect(obs.waterTempC).toBe(11.0);
    expect(obs.dewPointC).toBe(8.5);
    // VIS and TIDE are MM in this row
    expect(obs.visibilityNmi).toBeNull();
    expect(obs.tideFt).toBeNull();
  });

  it('maps MM sensor values to null', () => {
    // At least one non-date sensor field must be non-MM to avoid the all-missing throw.
    const partialRow = makeDataRow({
      WTMP: '10.5',
      WDIR: 'MM',
      WSPD: 'MM',
      GST: 'MM',
      WVHT: 'MM',
      DPD: 'MM',
      APD: 'MM',
      MWD: 'MM',
      PRES: 'MM',
      ATMP: 'MM',
      DEWP: 'MM',
    });
    const text = `${HEADER}${UNITS}\n${partialRow}\n`;
    const obs = svc.parseRealtimeText(text, 'BUOY1');

    expect(obs.windDirectionDeg).toBeNull();
    expect(obs.windSpeedMs).toBeNull();
    expect(obs.waveHeightM).toBeNull();
    expect(obs.waterTempC).toBe(10.5); // the one non-null sensor
  });

  it('returns tide_ft when TIDE is a number (feet, not converted)', () => {
    const text = `${HEADER}${UNITS}\n${makeDataRow({ TIDE: '3.2' })}\n`;
    const obs = svc.parseRealtimeText(text, 'TIDEST');
    expect(obs.tideFt).toBe(3.2);
  });

  it('throws NotFound when all sensor fields are MM', () => {
    const allMmRow = makeDataRow({
      WDIR: 'MM',
      WSPD: 'MM',
      GST: 'MM',
      WVHT: 'MM',
      DPD: 'MM',
      APD: 'MM',
      MWD: 'MM',
      PRES: 'MM',
      ATMP: 'MM',
      WTMP: 'MM',
      DEWP: 'MM',
    });
    const text = `${HEADER}${UNITS}\n${allMmRow}\n`;
    expect(() => svc.parseRealtimeText(text, 'OFFLINE')).toThrow(/no_sensor_data|missing|offline/i);
  });

  it('throws ServiceUnavailable when there is no header row', () => {
    expect(() => svc.parseRealtimeText('no header here\n1 2 3\n', 'BAD')).toThrow(/no header row/i);
  });

  it('throws NotFound when there are no data rows', () => {
    const text = `${HEADER}${UNITS}\n`;
    expect(() => svc.parseRealtimeText(text, 'EMPTY')).toThrow(/no data rows/i);
  });
});

// --- #24: column blocks NDBC writes on their own cycle resolve inside a look-back window ---

describe('NdbcService.parseRealtimeText windowed group resolution', () => {
  let svc: NdbcService;

  beforeEach(() => {
    svc = makeService();
  });

  /** 2026-09-17T15:10:00Z — the newest row in the live 46041 draw this case is modelled on. */
  const BASE_MS = Date.UTC(2026, 8, 17, 15, 10);
  const at = (minutesBefore: number): Date => new Date(BASE_MS - minutesBefore * 60_000);
  /** The five `YY MM DD hh mm` columns for a row N minutes before the newest one. */
  const timeAt = (minutesBefore: number): string => {
    const d = at(minutesBefore);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()} ${p(d.getUTCMonth() + 1)} ${p(d.getUTCDate())} ${p(d.getUTCHours())} ${p(d.getUTCMinutes())}`;
  };
  const isoAt = (minutesBefore: number): string =>
    at(minutesBefore).toISOString().replace('.000Z', 'Z');

  const NO_WAVES = { WVHT: 'MM', DPD: 'MM', APD: 'MM', MWD: 'MM' };
  const WAVES = { WVHT: '1.6', DPD: '9', APD: '6.4', MWD: '302' };

  const file = (rows: string[]): string => `${HEADER}${UNITS}${rows.join('\n')}\n`;

  it('recovers a wave sample from an earlier row and dates it to that row', () => {
    // Live 46041 shape: met rows every 10 minutes, waves on a slower pass.
    const text = file([
      makeRow(timeAt(0), NO_WAVES),
      makeRow(timeAt(10), WAVES),
      makeRow(timeAt(20), NO_WAVES),
    ]);
    const obs = svc.parseRealtimeText(text, '46041');

    expect(obs.observedAt).toBe(isoAt(0));
    expect(obs.waveHeightM).toBe(1.6);
    expect(obs.dominantPeriodSec).toBe(9);
    expect(obs.averagePeriodSec).toBe(6.4);
    expect(obs.meanWaveDirectionDeg).toBe(302);
    expect(obs.wavesObservedAt).toBe(isoAt(10));
    // The wave block is older than the observation; observed_at is not redefined to it.
    expect(obs.wavesObservedAt).not.toBe(obs.observedAt);
  });

  it('recovers a wave sample at the far edge of the 90-minute window', () => {
    const text = file([makeRow(timeAt(0), NO_WAVES), makeRow(timeAt(89), WAVES)]);
    const obs = svc.parseRealtimeText(text, 'EDGE1');
    expect(obs.waveHeightM).toBe(1.6);
    expect(obs.wavesObservedAt).toBe(isoAt(89));
  });

  it('reports null waves when the only sample is older than the window', () => {
    const text = file([makeRow(timeAt(0), NO_WAVES), makeRow(timeAt(120), WAVES)]);
    const obs = svc.parseRealtimeText(text, 'STALE1');

    expect(obs.waveHeightM).toBeNull();
    expect(obs.dominantPeriodSec).toBeNull();
    expect(obs.averagePeriodSec).toBeNull();
    expect(obs.meanWaveDirectionDeg).toBeNull();
    expect(obs.wavesObservedAt).toBeNull();
  });

  it('reports null waves with no error when the file carries no wave sample at all', () => {
    const text = file([
      makeRow(timeAt(0), NO_WAVES),
      makeRow(timeAt(10), NO_WAVES),
      makeRow(timeAt(20), NO_WAVES),
    ]);
    const obs = svc.parseRealtimeText(text, 'NOWAVE');

    expect(obs.waveHeightM).toBeNull();
    expect(obs.wavesObservedAt).toBeNull();
    expect(obs.windSpeedMs).toBe(5.0);
  });

  it('does not fill a wave field in from a different row than the block resolved on', () => {
    // 46041 carries rows like `1.6 MM 6.4 302` — a derivation gap on the wave row itself.
    const text = file([
      makeRow(timeAt(0), NO_WAVES),
      makeRow(timeAt(10), { ...WAVES, APD: 'MM' }),
      makeRow(timeAt(20), WAVES),
    ]);
    const obs = svc.parseRealtimeText(text, 'GAP1');

    expect(obs.waveHeightM).toBe(1.6);
    expect(obs.averagePeriodSec).toBeNull();
    expect(obs.wavesObservedAt).toBe(isoAt(10));
  });

  it('dates the wave block to observed_at when the newest row is itself a wave row', () => {
    const text = file([makeRow(timeAt(0), WAVES), makeRow(timeAt(10), NO_WAVES)]);
    const obs = svc.parseRealtimeText(text, '45175');

    expect(obs.waveHeightM).toBe(1.6);
    expect(obs.wavesObservedAt).toBe(obs.observedAt);
    expect(obs.observedAt).toBe(isoAt(0));
  });

  it('keeps observed_at on the newest row even when every block resolves older', () => {
    const bare = {
      WDIR: 'MM',
      WSPD: 'MM',
      GST: 'MM',
      PRES: 'MM',
      ATMP: 'MM',
      WTMP: 'MM',
      DEWP: 'MM',
      ...NO_WAVES,
    };
    const text = file([makeRow(timeAt(0), bare), makeRow(timeAt(10), WAVES)]);
    const obs = svc.parseRealtimeText(text, 'STAGGER');

    expect(obs.observedAt).toBe(isoAt(0));
    expect(obs.windSpeedMs).toBe(5.0);
    expect(obs.waveHeightM).toBe(1.6);
  });

  it('does not raise no_sensor_data when an all-MM newest row is backed by a row in the window', () => {
    const allMm = {
      WDIR: 'MM',
      WSPD: 'MM',
      GST: 'MM',
      PRES: 'MM',
      ATMP: 'MM',
      WTMP: 'MM',
      DEWP: 'MM',
      ...NO_WAVES,
    };
    const text = file([makeRow(timeAt(0), allMm), makeRow(timeAt(10))]);
    const obs = svc.parseRealtimeText(text, 'RECOVER');

    expect(obs.observedAt).toBe(isoAt(0));
    expect(obs.windSpeedMs).toBe(5.0);
    expect(obs.waterTempC).toBe(11.0);
  });

  it('still raises no_sensor_data when no row inside the window carries a reading', () => {
    const allMm = {
      WDIR: 'MM',
      WSPD: 'MM',
      GST: 'MM',
      PRES: 'MM',
      ATMP: 'MM',
      WTMP: 'MM',
      DEWP: 'MM',
      ...NO_WAVES,
    };
    // A full row sits in the file, but 2 hours back — outside the window.
    const text = file([
      makeRow(timeAt(0), allMm),
      makeRow(timeAt(10), allMm),
      makeRow(timeAt(120)),
    ]);

    let thrown: unknown;
    try {
      svc.parseRealtimeText(text, 'OFFLINE2');
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { data?: { reason?: string } }).data?.reason).toBe('no_sensor_data');
  });

  it('reports every block resolved from an older row, dated to that row', () => {
    // Live 46119 shape: the newest row carries no wind, the row 10 minutes back does.
    const text = file([
      makeRow(timeAt(0), { WDIR: 'MM', WSPD: 'MM', GST: 'MM', ...NO_WAVES }),
      makeRow(timeAt(10), WAVES),
    ]);
    const obs = svc.parseRealtimeText(text, '46119');

    expect(obs.windSpeedMs).toBe(5.0);
    expect(obs.observedAt).toBe(isoAt(0));
    // Pressure and water temp were on the newest row, so they are not listed.
    expect(obs.staleGroups).toEqual([
      { group: 'wave', observedAt: isoAt(10) },
      { group: 'wind', observedAt: isoAt(10) },
    ]);
  });

  it('reports no stale block when every block came from the newest row', () => {
    const text = file([makeRow(timeAt(0), WAVES), makeRow(timeAt(10), NO_WAVES)]);
    const obs = svc.parseRealtimeText(text, '45175');

    expect(obs.staleGroups).toEqual([]);
    expect(obs.wavesObservedAt).toBe(obs.observedAt);
  });

  it('stops the scan at the window boundary instead of walking the whole file', () => {
    // Rows past the boundary are unreachable by a scan that stops correctly. The trap row
    // below the boundary row carries a timestamp back inside the window, so a scan that
    // kept walking would accept its wave sample.
    const rows = [makeRow(timeAt(0), NO_WAVES)];
    for (let m = 10; m <= 80; m += 10) rows.push(makeRow(timeAt(m), NO_WAVES));
    rows.push(makeRow(timeAt(95), NO_WAVES)); // first row past the 90-minute boundary
    rows.push(makeRow(timeAt(30), WAVES)); // trap: inside the window, but below the stop

    const obs = svc.parseRealtimeText(file(rows), 'BOUNDARY');
    expect(obs.waveHeightM).toBeNull();
    expect(obs.wavesObservedAt).toBeNull();
  });

  it('resolves waves from a multi-thousand-row file without reading past the window', () => {
    const rows = [makeRow(timeAt(0), NO_WAVES), makeRow(timeAt(20), WAVES)];
    // 46041's live file carries ~6,470 data rows; the scan must not depend on file length.
    for (let m = 30; rows.length < 6_500; m += 10) rows.push(makeRow(timeAt(m), WAVES));

    const obs = svc.parseRealtimeText(file(rows), '46041');
    expect(obs.waveHeightM).toBe(1.6);
    expect(obs.wavesObservedAt).toBe(isoAt(20));
  });

  it('parses a trimmed slice of the live 46041 realtime feed', () => {
    // Captured from https://www.ndbc.noaa.gov/data/realtime2/46041.txt — the newest row
    // has MM waves and the wave sample sits 20 minutes back.
    const text =
      '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE\n' +
      '#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft\n' +
      '2026 09 17 15 10 350  3.0  4.0    MM    MM    MM  MM 1018.1  15.3  16.5  15.3   MM   MM    MM\n' +
      '2026 09 17 15 00 350  4.0  4.0    MM    MM    MM  MM 1018.0  15.3  16.5  15.3   MM +0.3    MM\n' +
      '2026 09 17 14 50 350  4.0  4.0   1.5     9   6.4 306 1018.0  15.3  16.5  15.3   MM   MM    MM\n' +
      '2026 09 17 14 40 340  4.0  5.0    MM    MM    MM  MM 1018.0  15.2  16.5  15.2   MM   MM    MM\n';
    const obs = svc.parseRealtimeText(text, '46041');

    expect(obs.observedAt).toBe('2026-09-17T15:10:00Z');
    expect(obs.windDirectionDeg).toBe(350);
    expect(obs.pressureHpa).toBe(1018.1);
    expect(obs.waveHeightM).toBe(1.5);
    expect(obs.dominantPeriodSec).toBe(9);
    expect(obs.averagePeriodSec).toBe(6.4);
    expect(obs.meanWaveDirectionDeg).toBe(306);
    expect(obs.wavesObservedAt).toBe('2026-09-17T14:50:00Z');
  });
});

describe('NdbcService.parseActiveStationsXml', () => {
  let svc: NdbcService;

  beforeEach(() => {
    svc = makeService();
  });

  /** Parse via getActiveStations is async + HTTP; test the private XML parser via a public method.
   *  We access it here by invoking the internal parse method — since it's `private` in TS,
   *  we cast through unknown to access it for unit tests. */
  function parseXml(xml: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (svc as any).parseActiveStationsXml(xml) as NdbcStation[];
  }

  it('parses a minimal Station element', () => {
    const xml = `<ActiveStations><Station ID="46041" lat="50.10" lon="-145.82" name="Cape Elizabeth" met="y" currents="n"/></ActiveStations>`;
    const stations = parseXml(xml);
    expect(stations).toHaveLength(1);
    expect(stations[0]).toMatchObject({
      id: '46041',
      lat: 50.1,
      lon: -145.82,
      name: 'Cape Elizabeth',
      hasMet: true,
      hasCurrents: false,
    });
  });

  it('skips Station elements missing required fields (ID or lat/lon)', () => {
    const xml = `<ActiveStations>
      <Station ID="OK1" lat="40.0" lon="-70.0" name="Valid" met="y" currents="n"/>
      <Station lat="40.0" lon="-70.0" name="NoId"/>
      <Station ID="NoLatLon" name="Missing coords"/>
    </ActiveStations>`;
    const stations = parseXml(xml);
    expect(stations).toHaveLength(1);
    expect(stations[0]!.id).toBe('OK1');
  });

  it('treats owner and type as optional (absent → not present on the object)', () => {
    const xml = `<ActiveStations><Station ID="NOOWNER" lat="30.0" lon="-80.0" name="No Owner" met="n" currents="n"/></ActiveStations>`;
    const stations = parseXml(xml);
    expect(stations[0]).not.toHaveProperty('owner');
    expect(stations[0]).not.toHaveProperty('type');
  });

  it('captures owner and type when present', () => {
    const xml = `<ActiveStations><Station ID="WITHALL" lat="30.0" lon="-80.0" name="Full" met="y" currents="y" type="buoy" owner="NOAA"/></ActiveStations>`;
    const stations = parseXml(xml);
    expect(stations[0]).toMatchObject({ type: 'buoy', owner: 'NOAA' });
  });

  it('normalizes an empty name to an NDBC <ID> label', () => {
    const xml = `<ActiveStations><Station ID="14041" lat="-8.0" lon="55.0" name="" met="y" currents="n"/></ActiveStations>`;
    const stations = parseXml(xml);
    expect(stations[0]!.name).toBe('NDBC 14041');
  });

  it('normalizes a whitespace-only name to an NDBC <ID> label (uppercased ID)', () => {
    const xml = `<ActiveStations><Station ID="ab12" lat="10.0" lon="-20.0" name="   " met="n" currents="n"/></ActiveStations>`;
    const stations = parseXml(xml);
    // ID is uppercased on the record, and the fallback label matches it.
    expect(stations[0]!.id).toBe('AB12');
    expect(stations[0]!.name).toBe('NDBC AB12');
  });

  it('leaves a populated name untouched', () => {
    const xml = `<ActiveStations><Station ID="46041" lat="50.1" lon="-145.82" name="Cape Elizabeth" met="y" currents="n"/></ActiveStations>`;
    const stations = parseXml(xml);
    expect(stations[0]!.name).toBe('Cape Elizabeth');
  });

  // --- #28: the catalog's waterquality flag reaches NdbcStation ---

  it('sets hasWaterQuality true for waterquality="y"', () => {
    const xml = `<ActiveStations><Station ID="44033" lat="44.06" lon="-68.99" name="Dry Salvages" met="y" currents="n" waterquality="y"/></ActiveStations>`;
    expect(parseXml(xml)[0]!.hasWaterQuality).toBe(true);
  });

  it('sets hasWaterQuality false for waterquality="n"', () => {
    const xml = `<ActiveStations><Station ID="46041" lat="47.35" lon="-124.73" name="Cape Elizabeth" met="y" currents="n" waterquality="n"/></ActiveStations>`;
    expect(parseXml(xml)[0]!.hasWaterQuality).toBe(false);
  });

  it('sets hasWaterQuality false when the attribute is absent (TAO-program rows)', () => {
    // The 48 TAO rows carry no met/currents/waterquality/dart attribute at all.
    const xml = `<ActiveStations><Station ID="32302" lat="-19.0" lon="-85.0" name="TAO mooring"/></ActiveStations>`;
    const station = parseXml(xml)[0]!;
    expect(station.hasWaterQuality).toBe(false);
    expect(station.hasMet).toBe(false);
    expect(station.hasCurrents).toBe(false);
  });

  it('reads a water-quality-only station whose met and currents are both "n"', () => {
    // 45 of the 140 flagged stations report neither met nor currents.
    const xml = `<ActiveStations><Station ID="TIBC1" lat="37.89" lon="-122.45" name="Tiburon Pier" type="fixed" met="n" currents="n" waterquality="y"/></ActiveStations>`;
    const station = parseXml(xml)[0]!;
    expect(station).toMatchObject({ hasMet: false, hasCurrents: false, hasWaterQuality: true });
  });

  // --- #20: XML character references must be decoded in every lifted attribute value ---

  it('decodes named, decimal, and hex character references in one pass', () => {
    // The live feed uses only &quot; and &amp;, but a single-pass decoder covers the
    // numeric forms at no extra cost, so all four are pinned here.
    const xml =
      `<ActiveStations><Station ID="62114" lat="58.3" lon="0" ` +
      `name="Tartan &quot;A&quot; AWS" owner="Texas A&amp;M &#38; CBI &#x26; partners" ` +
      `type="oilrig" met="y" currents="n"/></ActiveStations>`;
    const stations = parseXml(xml);

    expect(stations[0]!.name).toBe('Tartan "A" AWS');
    expect(stations[0]!.owner).toBe('Texas A&M & CBI & partners');
  });

  it('decodes the owner of a live catalog row (42092)', () => {
    const xml =
      `<ActiveStations><Station ID="42092" lat="27.639" lon="-97.012" ` +
      `name="Aransas Pass Channel Entrance S, TX (252)" ` +
      `owner="Conrad Blucher Institute (CBI) for Surveying and Science, Texas A&amp;M University-Corpus Christi" ` +
      `type="buoy" met="y" currents="n"/></ActiveStations>`;
    const stations = parseXml(xml);

    expect(stations[0]!.owner).toContain('Texas A&M University-Corpus Christi');
    expect(stations[0]!.owner).not.toContain('&amp;');
  });

  it('decodes a double-encoded sequence exactly once (ordering guard)', () => {
    // A chained decoder that expands &amp; before the named entities would turn this
    // into a bare double quote. One pass cannot get the order wrong.
    const xml = `<ActiveStations><Station ID="DBL1" lat="1.0" lon="2.0" name="literal &amp;quot; here" met="n" currents="n"/></ActiveStations>`;
    const stations = parseXml(xml);
    expect(stations[0]!.name).toBe('literal &quot; here');
  });

  it('returns a value with no character references byte-identical', () => {
    const xml = `<ActiveStations><Station ID="PLAIN" lat="1.0" lon="2.0" name="Plain Name 1/2 (no refs)" owner="NOAA NDBC" met="n" currents="n"/></ActiveStations>`;
    const stations = parseXml(xml);
    expect(stations[0]!.name).toBe('Plain Name 1/2 (no refs)');
    expect(stations[0]!.owner).toBe('NOAA NDBC');
  });

  it('leaves an unknown entity name untouched rather than dropping it', () => {
    const xml = `<ActiveStations><Station ID="UNK1" lat="1.0" lon="2.0" name="a &nosuchentity; b" met="n" currents="n"/></ActiveStations>`;
    const stations = parseXml(xml);
    expect(stations[0]!.name).toBe('a &nosuchentity; b');
  });

  it('still falls back to the NDBC <ID> label when a name decodes to whitespace (#8)', () => {
    // &#32; is a space: the decode runs before the #8 trim/fallback, so the blank guard
    // still sees a blank name.
    const xml = `<ActiveStations><Station ID="blank1" lat="1.0" lon="2.0" name="&#32;&#32;" met="n" currents="n"/></ActiveStations>`;
    const stations = parseXml(xml);
    expect(stations[0]!.name).toBe('NDBC BLANK1');
  });
});

describe('NdbcService.parseAdcpText', () => {
  let svc: NdbcService;

  beforeEach(() => {
    svc = makeService();
  });

  // Two-line ADCP header (column names + units). The parser keys off the leading `#`, then
  // reads data rows positionally, so a 3-bin header is enough to exercise real rows.
  const ADCP_HEADER =
    '#YY  MM DD hh mm DEP01 DIR01 SPD01 DEP02 DIR02 SPD02 DEP03 DIR03 SPD03\n' +
    '#yr  mo dy hr mn     m  degT  cm/s     m  degT  cm/s     m  degT  cm/s\n';

  it('parses the latest row into depth bins, nulling MM components but keeping the depth', () => {
    const text =
      ADCP_HEADER +
      '2026 07 16 00 00     2   210    19     4   300     8     6    MM    MM\n' +
      '2026 07 15 23 00     2   200    22     4   310    10     6   330    12\n';
    const profile = svc.parseAdcpText(text, '44033');

    // Reverse-chronological: the first data row is the most recent observation.
    expect(profile.observedAt).toBe('2026-07-16T00:00:00Z');
    expect(profile.bins).toHaveLength(3);
    expect(profile.bins[0]).toEqual({ depthM: 2, directionDeg: 210, speedCmS: 19 });
    expect(profile.bins[1]).toEqual({ depthM: 4, directionDeg: 300, speedCmS: 8 });
    // Depth present, direction+speed MM → the bin is kept with null components.
    expect(profile.bins[2]).toEqual({ depthM: 6, directionDeg: null, speedCmS: null });
  });

  it('handles a variable-width row where trailing bins are omitted (not MM-padded)', () => {
    const text = `${ADCP_HEADER}2026 07 15 14 00     2   340    27\n`;
    const profile = svc.parseAdcpText(text, '44033');

    expect(profile.bins).toHaveLength(1);
    expect(profile.bins[0]).toEqual({ depthM: 2, directionDeg: 340, speedCmS: 27 });
  });

  it('throws no_current_data when the ADCP file has a header but no data rows', () => {
    let caught: unknown;
    try {
      svc.parseAdcpText(ADCP_HEADER, 'EMPTY');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/no current-profile data rows/i);
    expect((caught as { data?: { reason?: string } }).data?.reason).toBe('no_current_data');
  });

  it('throws no_current_data when every bin in the latest row is MM (no anchoring depth)', () => {
    const text = `${ADCP_HEADER}2026 07 16 00 00    MM    MM    MM\n`;
    let caught: unknown;
    try {
      svc.parseAdcpText(text, 'ALLMM');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/no usable current bins/i);
    expect((caught as { data?: { reason?: string } }).data?.reason).toBe('no_current_data');
  });

  it('throws ServiceUnavailable when there is no header row', () => {
    expect(() => svc.parseAdcpText('2026 07 16 00 00 2 210 19\n', 'NOHDR')).toThrow(
      /no header row/i,
    );
  });
});

describe('NdbcService.parseOceanText', () => {
  let svc: NdbcService;

  beforeEach(() => {
    svc = makeService();
  });

  // Real two-line `.ocean` header (column names + units). The parser keys off the leading `#`,
  // then reads data rows positionally: five time columns, depth (m), then nine sensor columns.
  const OCEAN_HEADER =
    '#YY  MM DD hh mm   DEPTH  OTMP   COND   SAL   O2% O2PPM  CLCON  TURB    PH    EH\n' +
    '#yr  mo dy hr mn       m  degC  mS/cm   psu     %   ppm   ug/l   FTU     -    mv\n';

  it('parses the latest single-depth row, nulling MM sensors (44033 shape)', () => {
    // 44033 populates only water temp (OTMP) and salinity (SAL); every other sensor is MM.
    const text =
      OCEAN_HEADER +
      '2026 07 15 19 00     1.0 12.34    MM 31.21    MM    MM     MM    MM    MM    MM\n' +
      '2026 07 15 18 00     1.0 11.85    MM 31.22    MM    MM     MM    MM    MM    MM\n';
    const obs = svc.parseOceanText(text, '44033');

    // Reverse-chronological: the first data row is the most recent observation.
    expect(obs.observedAt).toBe('2026-07-15T19:00:00Z');
    expect(obs.readings).toHaveLength(1);
    expect(obs.readings[0]).toEqual({
      depthM: 1.0,
      waterTempC: 12.34,
      conductivityMsCm: null,
      salinityPsu: 31.21,
      oxygenPercent: null,
      oxygenPpm: null,
      chlorophyllUgL: null,
      turbidityFtu: null,
      ph: null,
      redoxMv: null,
    });
  });

  it('parses a fully-populated row across every sensor column (TIBC1 shape)', () => {
    // TIBC1 reports temp, salinity, dissolved oxygen (both), chlorophyll, turbidity, and pH;
    // conductivity (COND) and redox (EH) are MM — proving each column maps to the right field.
    const text = `${OCEAN_HEADER}2026 07 16 09 30     0.0 15.68    MM 31.24  65.8  5.41   2.30   112  7.99    MM\n`;
    const obs = svc.parseOceanText(text, 'TIBC1');

    expect(obs.readings).toHaveLength(1);
    expect(obs.readings[0]).toEqual({
      depthM: 0.0,
      waterTempC: 15.68,
      conductivityMsCm: null,
      salinityPsu: 31.24,
      oxygenPercent: 65.8,
      oxygenPpm: 5.41,
      chlorophyllUgL: 2.3,
      turbidityFtu: 112,
      ph: 7.99,
      redoxMv: null,
    });
  });

  it('groups every depth sharing the latest timestamp and excludes older rows (42022 shape)', () => {
    // 42022 reports two depths (1.0 m and 0.0 m) at each observation time; the latest
    // observation is both rows at 08:35, and the earlier 08:05 rows must not leak in.
    const text =
      OCEAN_HEADER +
      '2026 07 16 08 35     1.0 30.81    MM 36.73    MM    MM     MM    MM    MM    MM\n' +
      '2026 07 16 08 35     0.0 30.80    MM 36.70    MM    MM     MM    MM    MM    MM\n' +
      '2026 07 16 08 05     1.0 30.83    MM 36.78    MM    MM     MM    MM    MM    MM\n' +
      '2026 07 16 08 05     0.0 30.83    MM 36.78    MM    MM     MM    MM    MM    MM\n';
    const obs = svc.parseOceanText(text, '42022');

    expect(obs.observedAt).toBe('2026-07-16T08:35:00Z');
    expect(obs.readings).toHaveLength(2);
    expect(obs.readings.map((r) => r.depthM)).toEqual([1.0, 0.0]);
    expect(obs.readings[0]!.waterTempC).toBe(30.81);
    expect(obs.readings[1]!.waterTempC).toBe(30.8);
    expect(obs.readings[1]!.salinityPsu).toBe(36.7);
  });

  it('throws no_ocean_data when the file has a header but no data rows', () => {
    let caught: unknown;
    try {
      svc.parseOceanText(OCEAN_HEADER, 'EMPTY');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/no oceanographic data rows/i);
    expect((caught as { data?: { reason?: string } }).data?.reason).toBe('no_ocean_data');
  });

  it('throws no_ocean_data when the latest row has no anchoring depth (MM depth)', () => {
    const text = `${OCEAN_HEADER}2026 07 16 09 00      MM 12.34    MM 31.21    MM    MM     MM    MM    MM    MM\n`;
    let caught: unknown;
    try {
      svc.parseOceanText(text, 'NODEPTH');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/no usable oceanographic readings/i);
    expect((caught as { data?: { reason?: string } }).data?.reason).toBe('no_ocean_data');
  });

  it('throws ServiceUnavailable when there is no header row', () => {
    expect(() =>
      svc.parseOceanText('2026 07 16 09 00 1.0 12.34 MM 31.21 MM MM MM MM MM MM\n', 'NOHDR'),
    ).toThrow(/no header row/i);
  });
});

// --- #20: one shared per-row timestamp helper across all three realtime parsers ---

describe('NDBC row timestamps', () => {
  let svc: NdbcService;

  beforeEach(() => {
    svc = makeService();
  });

  const ADCP_HEADER =
    '#YY  MM DD hh mm DEP01 DIR01 SPD01\n' + '#yr  mo dy hr mn     m  degT  cm/s\n';
  const OCEAN_HEADER =
    '#YY  MM DD hh mm   DEPTH  OTMP   COND   SAL   O2% O2PPM  CLCON  TURB    PH    EH\n' +
    '#yr  mo dy hr mn       m  degC  mS/cm   psu     %   ppm   ug/l   FTU     -    mv\n';

  /** Every realtime parser exposed through its own text feed, keyed for table-driven cases. */
  const parsers = [
    {
      name: 'parseRealtimeText',
      observedAt: (text: string, id: string) => svc.parseRealtimeText(text, id).observedAt,
      row: (time: string) => makeRow(time),
      header: `${HEADER}${UNITS}`,
    },
    {
      name: 'parseAdcpText',
      observedAt: (text: string, id: string) => svc.parseAdcpText(text, id).observedAt,
      row: (time: string) => `${time}     2   210    19`,
      header: ADCP_HEADER,
    },
    {
      name: 'parseOceanText',
      observedAt: (text: string, id: string) => svc.parseOceanText(text, id).observedAt,
      row: (time: string) =>
        `${time}     1.0 12.34    MM 31.21    MM    MM     MM    MM    MM    MM`,
      header: OCEAN_HEADER,
    },
  ] as const;

  function caught(fn: () => unknown): {
    code?: number;
    data?: { reason?: string };
    message: string;
  } {
    try {
      fn();
    } catch (err) {
      return err as { code?: number; data?: { reason?: string }; message: string };
    }
    throw new Error('Expected the parser to throw.');
  }

  for (const parser of parsers) {
    describe(parser.name, () => {
      it('emits an instant Date.parse accepts for a well-formed row', () => {
        const text = `${parser.header}${parser.row('2026 08 14 10 30')}\n`;
        const observedAt = parser.observedAt(text, 'GOOD1');
        expect(observedAt).toBe('2026-08-14T10:30:00Z');
        expect(Number.isNaN(Date.parse(observedAt))).toBe(false);
      });

      it('never emits an unparseable string for an MM time column', () => {
        // The pre-fix .adcp/.ocean defect emitted the literal "2026-08-MMT10:30:00Z".
        const text = `${parser.header}${parser.row('2026 08 MM 10 30')}\n`;
        const failure = caught(() => parser.observedAt(text, 'MMDAY'));
        expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(failure.message).toContain('MMDAY');
        // Distinct from the offline-buoy and missing-station conditions (#6).
        expect(failure.data?.reason).toBeUndefined();
      });

      it('never substitutes the current wall clock for a short row', () => {
        const text = `${parser.header}2026 08\n`;
        const failure = caught(() => parser.observedAt(text, 'SHORT1'));
        expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      });

      it('rejects an impossible but fully numeric date rather than rolling it over', () => {
        const text = `${parser.header}${parser.row('2026 13 32 10 30')}\n`;
        const failure = caught(() => parser.observedAt(text, 'BADDATE'));
        expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      });

      it('rejects a day that does not exist in the month (31 February)', () => {
        const text = `${parser.header}${parser.row('2026 02 31 10 30')}\n`;
        const failure = caught(() => parser.observedAt(text, 'FEB31'));
        expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      });

      it('skips a malformed row and uses the adjacent well-formed one', () => {
        const text = `${parser.header}${parser.row('2026 08 MM 10 30')}\n${parser.row('2026 08 14 10 20')}\n`;
        expect(parser.observedAt(text, 'SKIP1')).toBe('2026-08-14T10:20:00Z');
      });

      it('keeps the NDBC two-digit-year expansion', () => {
        const text = `${parser.header}${parser.row('25 01 15 12 00')}\n`;
        expect(parser.observedAt(text, 'YY2')).toBe('2025-01-15T12:00:00Z');
      });
    });
  }

  it('rejects an out-of-range hour and minute', () => {
    for (const time of ['2026 08 14 24 00', '2026 08 14 10 60']) {
      const text = `${HEADER}${UNITS}${makeRow(time)}\n`;
      expect(caught(() => svc.parseRealtimeText(text, 'RANGE1')).code).toBe(
        JsonRpcErrorCode.ServiceUnavailable,
      );
    }
  });

  it('fails distinctly from no_sensor_data when every .txt row is malformed', () => {
    const text = `${HEADER}${UNITS}${makeRow('2026 08 MM 10 30')}\n${makeRow('MM 08 14 10 20')}\n`;
    const failure = caught(() => svc.parseRealtimeText(text, '46041'));
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.message).toContain('46041');
    expect(failure.data?.reason).toBeUndefined();
  });

  it('still raises no_sensor_data (NotFound) when timestamps are fine but every sensor is MM', () => {
    const allMm = makeDataRow({
      WDIR: 'MM',
      WSPD: 'MM',
      GST: 'MM',
      WVHT: 'MM',
      DPD: 'MM',
      APD: 'MM',
      MWD: 'MM',
      PRES: 'MM',
      ATMP: 'MM',
      WTMP: 'MM',
      DEWP: 'MM',
    });
    const failure = caught(() => svc.parseRealtimeText(`${HEADER}${UNITS}${allMm}\n`, 'OFFLINE'));
    expect(failure.code).toBe(JsonRpcErrorCode.NotFound);
    expect(failure.data?.reason).toBe('no_sensor_data');
  });
});
