/**
 * @fileoverview Tests for noaa_marine_get_water_level tool.
 * @module tests/mcp-server/tools/noaa-marine-get-water-level.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineGetWaterLevel } from '@/mcp-server/tools/definitions/noaa-marine-get-water-level.tool.js';
import { initCoopsService } from '@/services/coops/coops-service.js';

const OBS_ROWS = [
  { t: '2025-01-15 12:00', v: '8.23', s: '0.01', f: '0,0,0,0', q: 'p' },
  { t: '2025-01-15 12:06', v: '8.31', s: '0.01', f: '0,0,0,0', q: 'p' },
];

const PRED_ROWS = [
  { t: '2025-01-15 12:00', v: '8.20' },
  { t: '2025-01-15 12:06', v: '8.28' },
];

function setupCoops() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initCoopsService(null as any, null as any, { applicationId: 'test' });
}

describe('noaaMarineGetWaterLevel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupCoops();
  });

  it('returns observations with paired predictions and residual_summary', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: OBS_ROWS, stationName: 'Seattle' });
    vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(PRED_ROWS);

    const input = noaaMarineGetWaterLevel.input.parse({
      station_id: '9447130',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const result = await noaaMarineGetWaterLevel.handler(input, ctx);

    expect(result.station_id).toBe('9447130');
    expect(result.station_name).toBe('Seattle');
    expect(result.datum).toBe('MLLW');
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]).toMatchObject({
      time: '2025-01-15 12:00',
      value: 8.23,
      quality: 'p',
    });
    expect(result.predictions).toHaveLength(2);
    expect(result.residual_summary).toBeDefined();
    // residual: 8.23 - 8.20 = 0.03 max surge (english units → feet)
    expect(result.residual_summary!.max_surge).toBeCloseTo(0.03, 1);
  });

  it('throws ctx.fail("date_range_exceeded") for range > 31 days', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
    const input = noaaMarineGetWaterLevel.input.parse({
      station_id: '9447130',
      begin_date: '20250101',
      end_date: '20250301',
    });
    await expect(noaaMarineGetWaterLevel.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'date_range_exceeded' },
    });
  });

  it('throws ctx.fail("station_not_found") on CO-OPS station error', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    // CO-OPS returns HTTP 400 for invalid station IDs — simulate with McpError + statusCode
    vi.spyOn(getCoopsService(), 'fetchWaterLevel').mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'CO-OPS fetch failed', { statusCode: 400 }),
    );

    const input = noaaMarineGetWaterLevel.input.parse({
      station_id: '0000000',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetWaterLevel.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'station_not_found' },
    });
  });

  it('throws ctx.fail("no_data") when observation array is empty', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: [], stationName: 'Empty' });
    vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue([]);

    const input = noaaMarineGetWaterLevel.input.parse({
      station_id: '9999999',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetWaterLevel.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data' },
    });
  });

  it('degrades gracefully when prediction fetch fails — still returns observations', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: OBS_ROWS, stationName: 'Seattle' });
    vi.spyOn(svc, 'fetchWaterLevelPredictions').mockRejectedValue(new Error('pred fetch failed'));

    const input = noaaMarineGetWaterLevel.input.parse({
      station_id: '9447130',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const result = await noaaMarineGetWaterLevel.handler(input, ctx);

    expect(result.observations).toHaveLength(2);
    expect(result.predictions).toHaveLength(0);
    // No residual without predictions
    expect(result.residual_summary).toBeUndefined();
  });

  it('format renders station name, datum, and observation values', () => {
    const output = {
      station_id: '9447130',
      station_name: 'Seattle',
      datum: 'MLLW',
      units: 'english',
      observations: [{ time: '2025-01-15 12:00', value: 8.23, sigma: 0.01, quality: 'p' }],
      predictions: [{ time: '2025-01-15 12:00', value: 8.2 }],
      residual_summary: { max_surge: 0.03, max_drawdown: 0 },
    };
    const blocks = noaaMarineGetWaterLevel.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Seattle');
    expect(text).toContain('MLLW');
    expect(text).toContain('8.23');
    expect(text).toContain('9447130');
  });
});
