/**
 * @fileoverview The date-ranged CO-OPS tools accept `begin_date`/`end_date` as `YYYYMMDD` or
 * `YYYY-MM-DD`, each field on its own, and send CO-OPS `YYYYMMDD` either way. Driven through
 * the tool contract against a fake CO-OPS upstream, so the schema, the calendar check, and the
 * request the real service builds are all in the path.
 * @module tests/mcp-server/tools/coops-date-forms.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noaaMarineGetCurrents } from '@/mcp-server/tools/definitions/noaa-marine-get-currents.tool.js';
import { noaaMarineGetTidePredictions } from '@/mcp-server/tools/definitions/noaa-marine-get-tide-predictions.tool.js';
import { noaaMarineGetWaterLevel } from '@/mcp-server/tools/definitions/noaa-marine-get-water-level.tool.js';
import { initCoopsService } from '@/services/coops/coops-service.js';
import { callsTo, healthyCoops, installCoopsFake } from '../../support/coops-http.js';

type DateInput = { begin_date: string; end_date: string };
type Result = Awaited<ReturnType<typeof runToolContract>>;

/** The three date-ranged tools, each run with the station ID its kind of station takes. */
const TOOLS: { name: string; run: (dates: DateInput) => Promise<Result> }[] = [
  {
    name: noaaMarineGetTidePredictions.name,
    run: (dates) =>
      runToolContract(noaaMarineGetTidePredictions, { station_id: '9447130', ...dates }),
  },
  {
    name: noaaMarineGetWaterLevel.name,
    run: (dates) => runToolContract(noaaMarineGetWaterLevel, { station_id: '9447130', ...dates }),
  },
  {
    name: noaaMarineGetCurrents.name,
    run: (dates) => runToolContract(noaaMarineGetCurrents, { station_id: 'PUG1515', ...dates }),
  },
];

function textOf(result: Result): string {
  return result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
}

function errorOf(result: Result): { code: number; data?: { reason?: string }; message: string } {
  return (result.structuredContent as { error: never }).error;
}

describe.each(TOOLS)('$name date forms', ({ run }) => {
  let http: ReturnType<typeof installCoopsFake>;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    http = installCoopsFake(healthyCoops);
  });

  afterEach(() => {
    http.restore();
  });

  /** Every data request carries the same compact dates. */
  function sentDates(): { begin: string | null; end: string | null }[] {
    return callsTo(http, 'data').map((url) => ({
      begin: url.searchParams.get('begin_date'),
      end: url.searchParams.get('end_date'),
    }));
  }

  it('accepts the existing YYYYMMDD pair unchanged', async () => {
    const result = await run({ begin_date: '20260915', end_date: '20260921' });

    expect(result.isError).toBeFalsy();
    expect(sentDates().length).toBeGreaterThan(0);
    for (const sent of sentDates()) expect(sent).toEqual({ begin: '20260915', end: '20260921' });
  });

  it('accepts a YYYY-MM-DD pair and sends CO-OPS the compact form', async () => {
    const result = await run({ begin_date: '2026-09-15', end_date: '2026-09-21' });

    expect(result.isError).toBeFalsy();
    expect(sentDates().length).toBeGreaterThan(0);
    for (const sent of sentDates()) expect(sent).toEqual({ begin: '20260915', end: '20260921' });
  });

  it('normalizes each field on its own when the pair mixes forms', async () => {
    const mixed = await run({ begin_date: '20260915', end_date: '2026-09-21' });
    const reversedMix = await run({ begin_date: '2026-09-15', end_date: '20260921' });

    expect(mixed.isError).toBeFalsy();
    expect(reversedMix.isError).toBeFalsy();
    for (const sent of sentDates()) expect(sent).toEqual({ begin: '20260915', end: '20260921' });
  });

  it.each([
    ['begin_date', { begin_date: '2026-13-01', end_date: '2026-12-01' }, '2026-13-01'],
    ['begin_date', { begin_date: '20261301', end_date: '20261201' }, '20261301'],
    ['end_date', { begin_date: '2025-02-01', end_date: '2025-02-31' }, '2025-02-31'],
  ])(
    'rejects an impossible %s as invalid_date_range naming it as given (%j)',
    async (field, dates, given) => {
      const result = await run(dates);
      const error = errorOf(result);

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('invalid_date_range');
      expect(error.message).toContain(`${field} "${given}"`);
      expect(textOf(result)).toContain(`"${given}"`);
      expect(textOf(result)).toContain('YYYY-MM-DD');
      expect(callsTo(http, 'data')).toHaveLength(0);
    },
  );

  it('names a reversed ISO range as given', async () => {
    const result = await run({ begin_date: '2026-09-21', end_date: '2026-09-15' });

    expect(errorOf(result).data?.reason).toBe('invalid_date_range');
    expect(errorOf(result).message).toContain('"2026-09-21" is after end_date "2026-09-15"');
    expect(callsTo(http, 'data')).toHaveLength(0);
  });

  it('measures the range the same way whichever form carries it', async () => {
    const result = await run({ begin_date: '2024-01-01', end_date: '2025-06-01' });

    expect(errorOf(result).data?.reason).toBe('date_range_exceeded');
    expect(callsTo(http, 'data')).toHaveLength(0);
  });

  it.each(['09/15/2026', '15-09-2026', 'tomorrow', '2026-9-15', '2026-09-15T00:00', '2026091'])(
    'rejects %s at the schema with text naming both accepted forms',
    async (value) => {
      const result = await run({ begin_date: value, end_date: '20260921' });
      const error = errorOf(result);
      const text = textOf(result);

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(text).toContain('YYYYMMDD or YYYY-MM-DD');
      expect(text).not.toContain('\\d');
      expect(http.calls).toHaveLength(0);
    },
  );
});
