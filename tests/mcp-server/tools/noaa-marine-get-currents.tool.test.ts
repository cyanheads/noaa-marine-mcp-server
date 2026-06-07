/**
 * @fileoverview Tests for noaa_marine_get_currents tool.
 * @module tests/mcp-server/tools/noaa-marine-get-currents.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineGetCurrents } from '@/mcp-server/tools/definitions/noaa-marine-get-currents.tool.js';
import { CoopsBodyError, initCoopsService } from '@/services/coops/coops-service.js';

const MAX_SLACK_EVENTS = [
  { Time: '2025-01-15 06:30', Type: 'max flood', Velocity_Major: '1.8', meanFloodDir: '90' },
  { Time: '2025-01-15 09:15', Type: 'slack water', Velocity_Major: '0.0' },
  { Time: '2025-01-15 12:45', Type: 'max ebb', Velocity_Major: '-2.1', meanEbbDir: '270' },
];

const SIX_MIN_PREDS = [
  { Time: '2025-01-15 06:00', Velocity_Major: '1.2', Direction: '90' },
  { Time: '2025-01-15 06:06', Velocity_Major: '1.4', Direction: '91' },
];

function setupCoops() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initCoopsService(null as any, null as any, { applicationId: 'test' });
}

describe('noaaMarineGetCurrents', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupCoops();
  });

  it('returns MAX_SLACK events with flood, slack, and ebb types', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    // Station list lookup for name resolution
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(svc, 'getStations').mockResolvedValue([
      { id: 'ACT4176', name: 'Admiralty Inlet', lat: 48.15, lng: -122.75 },
    ] as any);
    vi.spyOn(svc, 'fetchCurrentPredictions').mockResolvedValue({
      events: MAX_SLACK_EVENTS,
      stationName: 'Admiralty Inlet',
    });

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
  });

  it('returns 6-min predictions when interval=6min', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    vi.spyOn(getCoopsService(), 'fetchCurrentPredictions').mockResolvedValue({
      predictions: SIX_MIN_PREDS,
      stationName: 'Admiralty Inlet',
    });

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'ACT4176',
      begin_date: '20250115',
      end_date: '20250115',
      interval: '6min',
    });
    const result = await noaaMarineGetCurrents.handler(input, ctx);

    expect(result.predictions).toHaveLength(2);
    expect(result.predictions![0]).toMatchObject({
      time: '2025-01-15 06:00',
      speed: 1.2,
      direction: 90,
    });
  });

  it('returns direction: null when CO-OPS does not provide Direction field in 6-min predictions', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });

    const predsNoDir = [
      { Time: '2025-01-15 06:00', Velocity_Major: '1.2' }, // Direction absent
      { Time: '2025-01-15 06:06', Velocity_Major: '1.4' }, // Direction absent
    ];

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    vi.spyOn(getCoopsService(), 'fetchCurrentPredictions').mockResolvedValue({
      predictions: predsNoDir,
      stationName: 'Puget Sound Station',
    });

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'PUG1516',
      begin_date: '20250115',
      end_date: '20250115',
      interval: '6min',
    });
    const result = await noaaMarineGetCurrents.handler(input, ctx);

    expect(result.predictions).toHaveLength(2);
    expect(result.predictions![0].direction).toBeNull();
    expect(result.predictions![1].direction).toBeNull();
  });

  it('throws ctx.fail("date_range_exceeded") for range > 365 days', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });
    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'ACT4176',
      begin_date: '20230101',
      end_date: '20250101',
    });
    await expect(noaaMarineGetCurrents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'date_range_exceeded' },
    });
  });

  it('throws ctx.fail("station_not_found") on CO-OPS station error', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrents.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(svc, 'getStations').mockResolvedValue([] as any);
    // CO-OPS returns HTTP 400 for invalid station IDs — simulate with McpError + statusCode
    vi.spyOn(svc, 'fetchCurrentPredictions').mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'CO-OPS fetch failed', { statusCode: 400 }),
    );

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'BADID',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetCurrents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
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
      new CoopsBodyError(
        'no_predictions',
        'CO-OPS error: Currents predictions are not available from the requested station.',
      ),
    );

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'PCT1676',
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
      new CoopsBodyError('station_error', 'CO-OPS error: Invalid station ID.'),
    );

    const input = noaaMarineGetCurrents.input.parse({
      station_id: 'BADID',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetCurrents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'station_not_found' },
    });
  });

  it('format renders station name and event entries', () => {
    const output = {
      station_id: 'ACT4176',
      station_name: 'Admiralty Inlet',
      units: 'english',
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
