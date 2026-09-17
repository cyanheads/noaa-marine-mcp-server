/**
 * @fileoverview Tests for noaa_marine_get_currents tool.
 * @module tests/mcp-server/tools/noaa-marine-get-currents.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineGetCurrents } from '@/mcp-server/tools/definitions/noaa-marine-get-currents.tool.js';
import { CoopsBodyError, initCoopsService } from '@/services/coops/coops-service.js';

/**
 * Live `MAX_SLACK` rows: CO-OPS sends `Velocity_Major` and the mean bearings as JSON
 * numbers, signs the velocity by flow sense, and carries `Bin`/`Depth` as strings.
 */
const MAX_SLACK_EVENTS = [
  {
    Time: '2025-01-15 06:30',
    Type: 'max flood',
    Velocity_Major: 1.8,
    meanFloodDir: 90,
    meanEbbDir: 270,
    Bin: '1',
    Depth: '16',
  },
  {
    Time: '2025-01-15 09:15',
    Type: 'slack water',
    Velocity_Major: 0,
    meanFloodDir: 90,
    meanEbbDir: 270,
    Bin: '1',
    Depth: '16',
  },
  {
    Time: '2025-01-15 12:45',
    Type: 'max ebb',
    Velocity_Major: -2.1,
    meanFloodDir: 90,
    meanEbbDir: 270,
    Bin: '1',
    Depth: '16',
  },
];

/**
 * Live 6-minute rows: no `Direction` key at all, a signed `Velocity_Major`, and the
 * station's mean flood/ebb bearings on every row.
 */
const SIX_MIN_PREDS = [
  {
    Time: '2025-01-15 06:00',
    Velocity_Major: 1.73,
    meanFloodDir: 37,
    meanEbbDir: 226,
    Bin: '1',
    Depth: '15',
  },
  {
    Time: '2025-01-15 06:06',
    Velocity_Major: -1.42,
    meanFloodDir: 37,
    meanEbbDir: 226,
    Bin: '1',
    Depth: '15',
  },
  {
    Time: '2025-01-15 06:12',
    Velocity_Major: 0,
    meanFloodDir: 37,
    meanEbbDir: 226,
    Bin: '1',
    Depth: '15',
  },
];

function setupCoops() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initCoopsService(null as any, null as any, { applicationId: 'test' });
}

/** Wires the currents service to a fixed station catalog and prediction result. */
async function mockCurrents(
  predictions: Record<string, unknown>,
  stations: readonly Record<string, unknown>[] = [
    { id: 'ACT4176', name: 'Admiralty Inlet', lat: 48.15, lng: -122.75 },
  ],
) {
  const { getCoopsService } = await import('@/services/coops/coops-service.js');
  const svc = getCoopsService();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(svc, 'getStations').mockResolvedValue(stations as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(svc, 'fetchCurrentPredictions').mockResolvedValue(predictions as any);
  return svc;
}

describe('noaaMarineGetCurrents', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupCoops();
  });

  it('returns MAX_SLACK events with flood, slack, and ebb types', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });
    await mockCurrents({ events: MAX_SLACK_EVENTS, stationName: 'Admiralty Inlet' });

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'ACT4176',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const result = await noaaMarineGetCurrents.handler(input, ctx);

    expect(result.station_id).toBe('ACT4176');
    expect(result.station_name).toBe('Admiralty Inlet');
    expect(result.events).toHaveLength(3);

    const flood = result.events!.find((e) => e.type === 'flood');
    expect(flood).toBeDefined();
    expect(flood!.speed).toBe(1.8);
    expect(flood!.direction).toBe(90);

    const slack = result.events!.find((e) => e.type === 'slack');
    expect(slack).toBeDefined();

    const ebb = result.events!.find((e) => e.type === 'ebb');
    expect(ebb).toBeDefined();
    expect(ebb!.speed).toBe(2.1); // absolute value applied
    expect(ebb!.direction).toBe(270);
  });

  it('keeps a mean bearing of exactly 0° rather than dropping it as absent', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });
    await mockCurrents({
      events: [{ ...MAX_SLACK_EVENTS[0]!, meanFloodDir: 0 }],
      stationName: 'Due North',
    });

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'ACT4176',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const result = await noaaMarineGetCurrents.handler(input, ctx);

    expect(result.events![0]!.direction).toBe(0);
  });

  // --- #19: the metric speed unit is cm/s on every surface ---

  it('names metric current speeds cm/s on both consumption surfaces', async () => {
    await mockCurrents({ events: MAX_SLACK_EVENTS, stationName: 'Admiralty Inlet' });

    const result = await runToolContract(noaaMarineGetCurrents, {
      station_id: 'ACT4176',
      begin_date: '20250115',
      end_date: '20250115',
      units: 'metric',
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Record<string, unknown>).units).toBe('metric');
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('cm/s');
    // The 100×-off label the metric path used to render.
    expect(text).not.toMatch(/\d m\/s/);
  });

  it('leaves english current speeds labelled in knots', async () => {
    await mockCurrents({ events: MAX_SLACK_EVENTS, stationName: 'Admiralty Inlet' });

    const result = await runToolContract(noaaMarineGetCurrents, {
      station_id: 'ACT4176',
      begin_date: '20250115',
      end_date: '20250115',
    });

    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('1.8 kt');
    expect(text).not.toContain('cm/s');
  });

  // --- #19: 6-minute rows carry the flood/ebb sense and a derived mean bearing ---

  it('derives the 6-minute bearing from the velocity sign and keeps the sense in type', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });
    await mockCurrents({ predictions: SIX_MIN_PREDS, stationName: 'Admiralty Inlet' });

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'ACT1616',
      begin_date: '20250115',
      end_date: '20250115',
      interval: '6min',
    });
    const result = await noaaMarineGetCurrents.handler(input, ctx);

    expect(result.predictions).toHaveLength(3);
    // Positive velocity → flood, and the station's mean flood direction.
    expect(result.predictions![0]).toMatchObject({
      time: '2025-01-15 06:00',
      type: 'flood',
      speed: 1.73,
      direction: 37,
    });
    // Negative velocity → ebb, mean ebb direction, and speed stays a non-negative magnitude.
    expect(result.predictions![1]).toMatchObject({
      time: '2025-01-15 06:06',
      type: 'ebb',
      speed: 1.42,
      direction: 226,
    });
    // Exactly zero → slack, and no bearing is invented for it.
    expect(result.predictions![2]).toMatchObject({
      time: '2025-01-15 06:12',
      type: 'slack',
      speed: 0,
      direction: null,
    });
  });

  it('renders the 6-minute flow sense and cm/s on the text surface', async () => {
    await mockCurrents({ predictions: SIX_MIN_PREDS, stationName: 'Admiralty Inlet' });

    const result = await runToolContract(noaaMarineGetCurrents, {
      station_id: 'ACT1616',
      begin_date: '20250115',
      end_date: '20250115',
      interval: '6min',
      units: 'metric',
    });

    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('flood');
    expect(text).toContain('ebb');
    expect(text).toContain('slack');
    expect(text).toContain('cm/s');
    expect(text).toContain('@37°');
    expect(text).toContain('@226°');
  });

  it('reports direction null when CO-OPS sends no mean bearing for the row', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });
    await mockCurrents({
      predictions: [
        { Time: '2025-01-15 06:00', Velocity_Major: 1.2, Bin: '1', Depth: null },
        { Time: '2025-01-15 06:06', Velocity_Major: -1.4, Bin: '1', Depth: null },
      ],
      stationName: 'Puget Sound Station',
    });

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'PUG1516',
      begin_date: '20250115',
      end_date: '20250115',
      interval: '6min',
    });
    const result = await noaaMarineGetCurrents.handler(input, ctx);

    // #4: a bearing CO-OPS does not report stays null rather than becoming a fabricated 0.
    expect(result.predictions?.[0]?.direction).toBeNull();
    expect(result.predictions?.[1]?.direction).toBeNull();
    // The flow sense still survives, because it comes from the velocity, not the bearing.
    expect(result.predictions?.[0]?.type).toBe('flood');
    expect(result.predictions?.[1]?.type).toBe('ebb');
  });

  // --- #27: bin selection and the bin/depth echo ---

  it('passes an explicit bin to CO-OPS and echoes the bin and depth it answered with', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });
    const svc = await mockCurrents({
      events: MAX_SLACK_EVENTS.map((e) => ({ ...e, Bin: '10', Depth: '49' })),
      stationName: 'West Point, West of',
    });

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'PUG1515',
      begin_date: '20250115',
      end_date: '20250115',
      bin: 10,
    });
    const result = await noaaMarineGetCurrents.handler(input, ctx);

    expect(svc.fetchCurrentPredictions).toHaveBeenCalledWith(
      expect.objectContaining({ bin: 10 }),
      ctx,
    );
    expect(result.bin).toBe(10);
    expect(result.depth).toBe(49);
  });

  it('echoes bin and depth for the default bin when no bin was requested', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });
    const svc = await mockCurrents({
      events: MAX_SLACK_EVENTS.map((e) => ({ ...e, Bin: '15', Depth: '16' })),
      stationName: 'West Point, West of',
    });

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'PUG1515',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const result = await noaaMarineGetCurrents.handler(input, ctx);

    expect(svc.fetchCurrentPredictions).toHaveBeenCalledWith(
      expect.not.objectContaining({ bin: expect.anything() }),
      ctx,
    );
    expect(result.bin).toBe(15);
    expect(result.depth).toBe(16);
  });

  it('reports a null depth when CO-OPS publishes none for the bin', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });
    await mockCurrents({
      events: MAX_SLACK_EVENTS.map((e) => ({ ...e, Depth: null })),
      stationName: 'Admiralty Inlet',
    });

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'ACT4176',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const result = await noaaMarineGetCurrents.handler(input, ctx);

    expect(result.bin).toBe(1);
    expect(result.depth).toBeNull();
  });

  it('renders the bin and its depth in the header, labelled in the requested units', async () => {
    await mockCurrents({
      events: MAX_SLACK_EVENTS.map((e) => ({ ...e, Bin: '15', Depth: '16' })),
      stationName: 'West Point, West of',
    });
    const english = await runToolContract(noaaMarineGetCurrents, {
      station_id: 'PUG1515',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const englishText = english.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(englishText).toContain('Bin:** 15');
    expect(englishText).toContain('16 ft');

    vi.restoreAllMocks();
    setupCoops();
    await mockCurrents({
      events: MAX_SLACK_EVENTS.map((e) => ({ ...e, Bin: '15', Depth: '4.9' })),
      stationName: 'West Point, West of',
    });
    const metric = await runToolContract(noaaMarineGetCurrents, {
      station_id: 'PUG1515',
      begin_date: '20250115',
      end_date: '20250115',
      units: 'metric',
    });
    const metricText = metric.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(metricText).toContain('4.9 m');
  });

  it("reports an unavailable bin with the station's real bins in the recovery", async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });
    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'getStations').mockResolvedValue([] as never);
    vi.spyOn(svc, 'fetchCurrentPredictions').mockRejectedValue(
      new CoopsBodyError(
        'bin_unavailable',
        'CO-OPS error: Available bin number of PUG1515: 15, 10, 1, ',
        { availableBins: [15, 10, 1] },
      ),
    );

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'PUG1515',
      begin_date: '20250115',
      end_date: '20250115',
      bin: 99,
    });
    const err = await Promise.resolve(noaaMarineGetCurrents.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'bin_unavailable' },
    });
    const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
    // The whole list in CO-OPS's own order — asserting the bins separately would let "15"
    // alone satisfy a check for bin 1.
    expect(hint).toContain('bins 15, 10, 1');
  });

  // --- #26: a weak-and-variable answer is a success carrying CO-OPS's own wording ---

  it('returns an empty MAX_SLACK list plus a disclosure when currents are weak and variable', async () => {
    await mockCurrents({
      events: [],
      statement: 'Currents are weak and variable',
      stationName: 'Bainbridge Island',
    });

    const result = await runToolContract(noaaMarineGetCurrents, {
      station_id: 'PUG1506',
      begin_date: '20250115',
      end_date: '20250115',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.events).toEqual([]);
    expect(structured.notice).toContain('Currents are weak and variable');
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('Currents are weak and variable');
  });

  it('returns an empty 6-minute list plus the same disclosure', async () => {
    await mockCurrents({
      predictions: [],
      statement: 'Currents are weak and variable',
      stationName: 'Bainbridge Island',
    });

    const result = await runToolContract(noaaMarineGetCurrents, {
      station_id: 'PUG1506',
      begin_date: '20250115',
      end_date: '20250115',
      interval: '6min',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.predictions).toEqual([]);
    expect(structured.notice).toContain('Currents are weak and variable');
  });

  it('reports a coverage statement as predictions_unavailable rather than an unknown station', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });
    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'getStations').mockResolvedValue([] as never);
    vi.spyOn(svc, 'fetchCurrentPredictions').mockRejectedValue(
      new CoopsBodyError(
        'predictions_unavailable',
        'CO-OPS error: Currents predictions are not available from the requested station.',
      ),
    );

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'PCT1676',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const err = await Promise.resolve(noaaMarineGetCurrents.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ data: { reason: 'predictions_unavailable' } });
    // The ID came from the discovery tool, so the recovery must not send the caller back to re-verify it.
    const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
    expect(hint).not.toMatch(/verify/i);
  });

  it('still serves a subordinate current station its normal MAX_SLACK series', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });
    await mockCurrents({ events: MAX_SLACK_EVENTS, stationName: 'Subordinate Passage' }, [
      { id: 'ACT8851', name: 'Subordinate Passage', lat: 40, lng: -73, type: 'S' },
    ]);

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'ACT8851',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const result = await noaaMarineGetCurrents.handler(input, ctx);

    // Unlike a subordinate tide station, a subordinate current station publishes the full series.
    expect(result.events).toHaveLength(3);
  });

  it('throws ctx.fail("date_range_exceeded") for range > 365 days', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });
    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'ACT4176',
      begin_date: '20230101',
      end_date: '20250101',
    });
    await expect(noaaMarineGetCurrents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_range_exceeded' },
    });
  });

  it('throws ctx.fail("invalid_date_range") for an impossible calendar date, without calling CO-OPS', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    const fetchSpy = vi
      .spyOn(svc, 'fetchCurrentPredictions')
      .mockResolvedValue({ events: [], stationName: 'x' });

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'ACT4176',
      begin_date: '20250231', // Feb 31 — does not exist
      end_date: '20250302',
    });
    await expect(noaaMarineGetCurrents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws ctx.fail("invalid_date_range") for a reversed range, without calling CO-OPS', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    const fetchSpy = vi
      .spyOn(svc, 'fetchCurrentPredictions')
      .mockResolvedValue({ events: [], stationName: 'x' });

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'ACT4176',
      begin_date: '20250110',
      end_date: '20250101', // before begin_date
    });
    await expect(noaaMarineGetCurrents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws ctx.fail("station_not_found") on an unclassifiable CO-OPS rejection', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(svc, 'getStations').mockResolvedValue([] as any);
    // CO-OPS returns HTTP 400 for invalid station IDs — simulate with McpError + status
    vi.spyOn(svc, 'fetchCurrentPredictions').mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'CO-OPS fetch failed', { status: 400 }),
    );

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'BADID',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetCurrents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'station_not_found' },
    });
  });

  it('throws ctx.fail("no_predictions") when events array is empty', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    vi.spyOn(getCoopsService(), 'fetchCurrentPredictions').mockResolvedValue({
      events: [],
      stationName: 'Quiet',
    });

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'ACT0000',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetCurrents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_predictions' },
    });
  });

  it('throws ctx.fail("no_predictions") on CoopsBodyError with no_predictions reason', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'getStations').mockResolvedValue([] as never);
    vi.spyOn(svc, 'fetchCurrentPredictions').mockRejectedValue(
      new CoopsBodyError('no_predictions', 'CO-OPS error: No Predictions data was found.'),
    );

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'ACT4176',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetCurrents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_predictions' },
    });
  });

  it('throws ctx.fail("station_not_found") on CoopsBodyError with station_error reason', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'getStations').mockResolvedValue([] as never);
    vi.spyOn(svc, 'fetchCurrentPredictions').mockRejectedValue(
      new CoopsBodyError('station_error', 'CO-OPS error: Wrong Station ID.'),
    );

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'BADID',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetCurrents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'station_not_found' },
    });
  });

  // --- #18: the 6-minute curve is paged by serialized payload size; MAX_SLACK stays whole ---

  describe('paging', () => {
    /** 6-minute current rows at their real width. */
    function sixMin(count: number): Record<string, unknown>[] {
      return Array.from({ length: count }, (_, i) => {
        const minutes = i * 6;
        const day = String(15 + Math.floor(minutes / 1440)).padStart(2, '0');
        const hour = String(Math.floor((minutes % 1440) / 60)).padStart(2, '0');
        const minute = String(minutes % 60).padStart(2, '0');
        return {
          Bin: '15',
          Depth: '16',
          meanEbbDir: 341,
          meanFloodDir: 234,
          Time: `2025-01-${day} ${hour}:${minute}`,
          Velocity_Major: Number((Math.sin((i + 1) / 20) * 2.317).toFixed(3)),
        };
      });
    }

    /** A full day of max/slack events — the regression pin for the unpaged event view. */
    const FULL_DAY_EVENTS = (
      [
        ['2025-01-15 02:47', 'slack water', 0],
        ['2025-01-15 06:30', 'max flood', 1.8],
        ['2025-01-15 09:15', 'slack water', 0],
        ['2025-01-15 12:45', 'max ebb', -2.1],
        ['2025-01-15 15:52', 'slack water', 0],
        ['2025-01-15 19:04', 'max flood', 2.2],
        ['2025-01-15 22:11', 'slack water', 0],
        ['2025-01-15 23:58', 'max ebb', -1.6],
      ] as [string, string, number][]
    ).map(([Time, Type, Velocity_Major]) => ({
      Bin: '15',
      Depth: '16',
      meanEbbDir: 341,
      meanFloodDir: 234,
      Time,
      Type,
      Velocity_Major,
    }));

    it('returns a MAX_SLACK day byte-identical to the unpaged output, with no disclosure', async () => {
      await mockCurrents({ events: FULL_DAY_EVENTS, stationName: 'Admiralty Inlet' });
      const result = await runToolContract(noaaMarineGetCurrents, {
        begin_date: '20250115',
        end_date: '20250115',
        station_id: 'ACT1616',
      });

      // Captured against the pre-paging tool for this exact fixture.
      expect(JSON.stringify(result.structuredContent)).toBe(
        '{"station_id":"ACT1616","station_name":"Admiralty Inlet","units":"english","bin":15,"depth":16,"events":[{"time":"2025-01-15 02:47","type":"slack"},{"time":"2025-01-15 06:30","type":"flood","speed":1.8,"direction":234},{"time":"2025-01-15 09:15","type":"slack"},{"time":"2025-01-15 12:45","type":"ebb","speed":2.1,"direction":341},{"time":"2025-01-15 15:52","type":"slack"},{"time":"2025-01-15 19:04","type":"flood","speed":2.2,"direction":234},{"time":"2025-01-15 22:11","type":"slack"},{"time":"2025-01-15 23:58","type":"ebb","speed":1.6,"direction":341}]}',
      );
      expect(result.content).toHaveLength(1);
      expect(result.content.map((b) => (b as { text?: string }).text ?? '').join('')).toBe(
        '## Tidal Currents — Admiralty Inlet (ACT1616)\n**Units:** english (speed in kt) · **Bin:** 15 · **Depth:** 16 ft\n\n**Events** (8 max/slack events):\n2025-01-15 02:47: slack\n2025-01-15 06:30: flood 1.8 kt @234°\n2025-01-15 09:15: slack\n2025-01-15 12:45: ebb 2.1 kt @341°\n2025-01-15 15:52: slack\n2025-01-15 19:04: flood 2.2 kt @234°\n2025-01-15 22:11: slack\n2025-01-15 23:58: ebb 1.6 kt @341°',
      );
    });

    /** The same eight-event daily pattern repeated across `days`, as a long-range event series. */
    function maxSlackDays(days: number): Record<string, unknown>[] {
      const rows: Record<string, unknown>[] = [];
      for (let d = 0; d < days; d += 1) {
        const date = new Date(Date.UTC(2025, 0, 1 + d)).toISOString().slice(0, 10);
        for (const event of FULL_DAY_EVENTS) {
          rows.push({ ...event, Time: `${date} ${event.Time.slice(11)}` });
        }
      }
      return rows;
    }

    it('bounds a long MAX_SLACK range and discloses the page accounting', async () => {
      const rows = maxSlackDays(365);
      await mockCurrents({ events: rows, stationName: 'Admiralty Inlet' });
      const result = await runToolContract(noaaMarineGetCurrents, {
        begin_date: '20250101',
        end_date: '20251231',
        station_id: 'ACT1616',
      });
      const structured = result.structuredContent as {
        events: { time: string }[];
        rows_matched?: number;
        rows_returned?: number;
        truncated?: boolean;
      };
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

      expect(structured.rows_matched).toBe(rows.length);
      expect(structured.truncated).toBe(true);
      expect(structured.rows_returned).toBe(structured.events.length);
      expect(structured.events.length).toBeLessThan(rows.length);
      expect(JSON.stringify(structured.events).length).toBeLessThanOrEqual(24_000);
      // Every event on the page reaches the text surface too — no head slice.
      for (const e of structured.events) expect(text).toContain(e.time);
      expect(text).toContain('offset');
    });

    it('walks a long MAX_SLACK range to the empty page and reassembles every event', async () => {
      const rows = maxSlackDays(365);
      await mockCurrents({ events: rows, stationName: 'Admiralty Inlet' });
      const times: string[] = [];
      let offset: number | null = 0;
      let pages = 0;

      while (offset !== null) {
        const result = await runToolContract(noaaMarineGetCurrents, {
          begin_date: '20250101',
          end_date: '20251231',
          offset,
          station_id: 'ACT1616',
        });
        const structured = result.structuredContent as {
          events: { time: string }[];
          next_offset?: number | null;
        };
        times.push(...structured.events.map((e) => e.time));
        pages += 1;
        offset = structured.next_offset ?? null;
        expect(pages).toBeLessThan(40);
      }

      expect(pages).toBeGreaterThanOrEqual(3);
      expect(times).toEqual(rows.map((r) => r.Time as string));

      const past = await runToolContract(noaaMarineGetCurrents, {
        begin_date: '20250101',
        end_date: '20251231',
        offset: rows.length,
        station_id: 'ACT1616',
      });
      const pastStructured = past.structuredContent as Record<string, unknown>;
      expect(past.isError).toBeFalsy();
      expect(pastStructured.events).toEqual([]);
      expect(pastStructured.next_offset).toBeNull();
      expect(pastStructured.truncated).toBe(false);
    });

    it('lets limit lower the MAX_SLACK page and keeps the bin echo on it', async () => {
      await mockCurrents({ events: maxSlackDays(365), stationName: 'Admiralty Inlet' });
      const result = await runToolContract(noaaMarineGetCurrents, {
        begin_date: '20250101',
        end_date: '20251231',
        limit: 4,
        station_id: 'ACT1616',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(structured.events).toHaveLength(4);
      expect(structured.next_offset).toBe(4);
      // The bin is a property of the response, not of the page.
      expect(structured.bin).toBe(15);
      expect(structured.depth).toBe(16);
    });

    it('returns a fitting 6-minute range whole, with no paging disclosure', async () => {
      await mockCurrents({ predictions: sixMin(120), stationName: 'Admiralty Inlet' });
      const result = await runToolContract(noaaMarineGetCurrents, {
        begin_date: '20250115',
        end_date: '20250115',
        interval: '6min',
        station_id: 'ACT1616',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(structured.predictions).toHaveLength(120);
      expect(structured).not.toHaveProperty('truncated');
      expect(structured).not.toHaveProperty('rows_matched');
      expect(structured).not.toHaveProperty('next_offset');
    });

    it('bounds a long 6-minute range and renders exactly the page, with no head slice', async () => {
      const rows = sixMin(720);
      await mockCurrents({ predictions: rows, stationName: 'Admiralty Inlet' });
      const result = await runToolContract(noaaMarineGetCurrents, {
        begin_date: '20250115',
        end_date: '20250117',
        interval: '6min',
        station_id: 'ACT1616',
      });
      const structured = result.structuredContent as {
        predictions: { time: string }[];
        rows_matched?: number;
        truncated?: boolean;
      };
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

      expect(structured.rows_matched).toBe(720);
      expect(structured.truncated).toBe(true);
      expect(structured.predictions.length).toBeLessThan(720);
      expect(JSON.stringify(structured.predictions).length).toBeLessThanOrEqual(24_000);
      for (const p of structured.predictions) expect(text).toContain(p.time);
      expect(text).not.toContain('more');
      expect(text).toContain('offset');
    });

    it('walks first page to empty page and reassembles the whole 6-minute curve', async () => {
      const rows = sixMin(720);
      await mockCurrents({ predictions: rows, stationName: 'Admiralty Inlet' });
      const times: string[] = [];
      let offset: number | null = 0;
      let pages = 0;

      while (offset !== null) {
        const result = await runToolContract(noaaMarineGetCurrents, {
          begin_date: '20250115',
          end_date: '20250117',
          interval: '6min',
          offset,
          station_id: 'ACT1616',
        });
        const structured = result.structuredContent as {
          next_offset?: number | null;
          predictions: { time: string }[];
        };
        times.push(...structured.predictions.map((p) => p.time));
        pages += 1;
        offset = structured.next_offset ?? null;
        expect(pages).toBeLessThan(40);
      }

      expect(pages).toBeGreaterThanOrEqual(3);
      expect(times).toEqual(rows.map((r) => r.Time as string));

      const past = await runToolContract(noaaMarineGetCurrents, {
        begin_date: '20250115',
        end_date: '20250117',
        interval: '6min',
        offset: 720,
        station_id: 'ACT1616',
      });
      const pastStructured = past.structuredContent as Record<string, unknown>;
      expect(past.isError).toBeFalsy();
      expect(pastStructured.predictions).toEqual([]);
      expect(pastStructured.next_offset).toBeNull();
      expect(pastStructured.truncated).toBe(false);
    });

    it('keeps the bin echo, flow sense, and bearing on a paged row', async () => {
      await mockCurrents({ predictions: sixMin(720), stationName: 'Admiralty Inlet' });
      const result = await runToolContract(noaaMarineGetCurrents, {
        begin_date: '20250115',
        end_date: '20250117',
        interval: '6min',
        station_id: 'ACT1616',
      });
      const structured = result.structuredContent as {
        bin: number | null;
        depth: number | null;
        predictions: { direction: number | null; speed: number; type: string }[];
      };

      expect(structured.bin).toBe(15);
      expect(structured.depth).toBe(16);
      expect(structured.predictions.find((p) => p.type === 'flood')?.direction).toBe(234);
      expect(structured.predictions.find((p) => p.type === 'ebb')?.direction).toBe(341);
    });

    it('lets limit lower the 6-minute page', async () => {
      await mockCurrents({ predictions: sixMin(720), stationName: 'Admiralty Inlet' });
      const result = await runToolContract(noaaMarineGetCurrents, {
        begin_date: '20250115',
        end_date: '20250117',
        interval: '6min',
        limit: 6,
        station_id: 'ACT1616',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(structured.predictions).toHaveLength(6);
      expect(structured.next_offset).toBe(6);
    });
  });

  it('format renders station name and event entries', () => {
    const output = {
      station_id: 'ACT4176',
      station_name: 'Admiralty Inlet',
      units: 'english',
      bin: 1,
      depth: 16,
      events: [
        { time: '2025-01-15 06:30', type: 'flood' as const, speed: 1.8, direction: 90 },
        { time: '2025-01-15 09:15', type: 'slack' as const },
      ],
    };
    const blocks = noaaMarineGetCurrents.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('ACT4176');
    expect(text).toContain('Admiralty Inlet');
    expect(text).toContain('flood');
    expect(text).toContain('1.8');
  });
});
