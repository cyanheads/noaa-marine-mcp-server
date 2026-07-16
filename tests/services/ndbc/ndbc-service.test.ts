/**
 * @fileoverview Tests for NdbcService — active station XML parsing and realtime text parsing.
 * @module tests/services/ndbc/ndbc-service.test
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NdbcService } from '@/services/ndbc/ndbc-service.js';

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
    return (svc as any).parseActiveStationsXml(xml) as ReturnType<
      (typeof svc)['parseRealtimeText']
    >[];
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
