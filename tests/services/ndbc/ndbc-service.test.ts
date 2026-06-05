/**
 * @fileoverview Tests for NdbcService — active station XML parsing and realtime text parsing.
 * @module tests/services/ndbc/ndbc-service.test
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NdbcService } from '@/services/ndbc/ndbc-service.js';

// NdbcService constructor accepts _config and _storage but doesn't use them at runtime.
// Cast with `as any` to avoid needing real AppConfig / StorageService instances.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeService = () => new NdbcService(null as any, null as any);

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
});
