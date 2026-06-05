/**
 * @fileoverview Tests for noaa_marine_get_tide_predictions tool.
 * @module tests/mcp-server/tools/noaa-marine-get-tide-predictions.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineGetTidePredictions } from '@/mcp-server/tools/definitions/noaa-marine-get-tide-predictions.tool.js';
import { initCoopsService } from '@/services/coops/coops-service.js';

const TIDE_PREDICTIONS = [
  { t: '2025-01-15 06:23', v: '5.42', type: 'H' },
  { t: '2025-01-15 12:51', v: '-0.31', type: 'L' },
];

function setupCoops() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initCoopsService(null as any, null as any, { applicationId: 'test' });
}

describe('noaaMarineGetTidePredictions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupCoops();
  });

  it('returns tide predictions for a valid station and date range', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    vi.spyOn(getCoopsService(), 'fetchTidePredictions').mockResolvedValue({
      predictions: TIDE_PREDICTIONS,
      stationName: 'Seattle',
    });

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9447130',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const result = await noaaMarineGetTidePredictions.handler(input, ctx);

    expect(result.station_id).toBe('9447130');
    expect(result.station_name).toBe('Seattle');
    expect(result.datum).toBe('MLLW');
    expect(result.units).toBe('english');
    expect(result.predictions).toHaveLength(2);
    expect(result.predictions[0]).toMatchObject({
      time: '2025-01-15 06:23',
      height: 5.42,
      type: 'H',
    });
    expect(result.predictions[1]).toMatchObject({
      time: '2025-01-15 12:51',
      height: -0.31,
      type: 'L',
    });
  });

  it('throws ctx.fail("date_range_exceeded") for range > 365 days', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });
    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9447130',
      begin_date: '20230101',
      end_date: '20250101',
    });
    await expect(noaaMarineGetTidePredictions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'date_range_exceeded' },
    });
  });

  it('throws ctx.fail("station_not_found") on CO-OPS station error', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    vi.spyOn(getCoopsService(), 'fetchTidePredictions').mockRejectedValue(
      new Error('CO-OPS error: No data was found. This product may not exist at this station.'),
    );

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '0000000',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetTidePredictions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'station_not_found' },
    });
  });

  it('throws ctx.fail("no_predictions") when predictions array is empty', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    vi.spyOn(getCoopsService(), 'fetchTidePredictions').mockResolvedValue({
      predictions: [],
      stationName: 'Inactive',
    });

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9999999',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetTidePredictions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_predictions' },
    });
  });

  it('format renders station name, datum, and at least one prediction entry', () => {
    const output = {
      station_id: '9447130',
      station_name: 'Seattle',
      datum: 'MLLW',
      units: 'english',
      predictions: [
        { time: '2025-01-15 06:23', height: 5.42, type: 'H' },
        { time: '2025-01-15 12:51', height: -0.31, type: 'L' },
      ],
    };
    const blocks = noaaMarineGetTidePredictions.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Seattle');
    expect(text).toContain('9447130');
    expect(text).toContain('MLLW');
    expect(text).toContain('5.42');
    expect(text).toContain('HIGH');
  });
});
