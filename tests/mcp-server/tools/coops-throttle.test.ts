/**
 * @fileoverview CO-OPS answers a burst of requests from one address with HTTP 403 for a couple
 * of minutes. Every CO-OPS tool reports that as the throttle it is, through the real service,
 * classifier, and output validation — the upstream is faked at the HTTP seam, never at a service
 * method — and the neighbouring 400 and 5xx handling stays as it was.
 * @module tests/mcp-server/tools/coops-throttle.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineFindStations } from '@/mcp-server/tools/definitions/noaa-marine-find-stations.tool.js';
import { noaaMarineGetCurrents } from '@/mcp-server/tools/definitions/noaa-marine-get-currents.tool.js';
import { noaaMarineGetMonthlyMeans } from '@/mcp-server/tools/definitions/noaa-marine-get-monthly-means.tool.js';
import { noaaMarineGetTidePredictions } from '@/mcp-server/tools/definitions/noaa-marine-get-tide-predictions.tool.js';
import { noaaMarineGetWaterLevel } from '@/mcp-server/tools/definitions/noaa-marine-get-water-level.tool.js';
import { initCoopsService } from '@/services/coops/coops-service.js';
import { getNdbcService, initNdbcService } from '@/services/ndbc/ndbc-service.js';
import {
  type CoopsResponder,
  callsTo,
  healthyCoops,
  installCoopsFake,
} from '../../support/coops-http.js';

type Result = Awaited<ReturnType<typeof runToolContract>>;
type ErrorEnvelope = { code: number; data?: Record<string, unknown>; message: string };

const THROTTLED: CoopsResponder = () =>
  new Response('{"message":"Forbidden"}', { status: 403, statusText: 'Forbidden' });

function errorOf(result: Result): ErrorEnvelope {
  return (result.structuredContent as { error: ErrorEnvelope }).error;
}

function textOf(result: Result): string {
  return result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
}

/** The recovery hint the error envelope carries. */
function hintOf(result: Result): string {
  const recovery = errorOf(result).data?.recovery as { hint?: string } | undefined;
  if (typeof recovery?.hint !== 'string') throw new Error('The error carries no recovery hint.');
  return recovery.hint;
}

/** The recovery a definition declares for the throttle — what the wire must carry. */
function declaredRecovery(definition: {
  errors?: readonly { reason: string; recovery: string }[];
}): string {
  const entry = definition.errors?.find((e) => e.reason === 'upstream_throttled');
  if (!entry) throw new Error('The definition declares no upstream_throttled contract entry.');
  return entry.recovery;
}

/** The throttle envelope, identical on every data tool. */
function expectThrottled(result: Result, recovery: string): void {
  const error = errorOf(result);
  expect(result.isError).toBe(true);
  expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
  expect(error.data).toMatchObject({
    reason: 'upstream_throttled',
    retryable: true,
    status: 403,
    recovery: { hint: recovery },
  });
  expect(error.data).not.toHaveProperty('body');
  expect(error.data).not.toHaveProperty('responseBody');

  const text = textOf(result);
  expect(text).toContain(`Recovery: ${recovery}`);
  expect(text.trimEnd().endsWith('(reason upstream_throttled · retryable)')).toBe(true);
}

let http: ReturnType<typeof installCoopsFake> | undefined;

function fake(respond: CoopsResponder): NonNullable<typeof http> {
  http = installCoopsFake(respond);
  return http;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initCoopsService(null as any, null as any, { applicationId: 'test' });
  initNdbcService();
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe('noaa_marine_get_water_level under a CO-OPS throttle', () => {
  const INPUT = { station_id: '9447130', begin_date: '20260916', end_date: '20260916' };

  it('reports upstream_throttled, costing one request per series', async () => {
    const upstream = fake(THROTTLED);
    const result = await runToolContract(noaaMarineGetWaterLevel, INPUT);

    expectThrottled(result, declaredRecovery(noaaMarineGetWaterLevel));
    const products = callsTo(upstream, 'data').map((u) => u.searchParams.get('product'));
    expect(products.sort()).toEqual(['predictions', 'water_level']);
    expect(callsTo(upstream, 'catalog')).toHaveLength(0);
  });

  it('is the throttle even when the 403 body carries a CO-OPS datum phrase', async () => {
    fake(
      () =>
        new Response('{"error": {"message":" There is no MLLW for the station: 9447130"}}', {
          status: 403,
        }),
    );
    const result = await runToolContract(noaaMarineGetWaterLevel, INPUT);

    expect(errorOf(result).data?.reason).toBe('upstream_throttled');
  });

  it('still returns the observed series when only the paired prediction fetch is throttled', async () => {
    const upstream = fake((endpoint, url) =>
      url.searchParams.get('product') === 'predictions'
        ? THROTTLED(endpoint, url)
        : healthyCoops(endpoint, url),
    );
    const result = await runToolContract(noaaMarineGetWaterLevel, INPUT);
    const structured = result.structuredContent as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    expect(structured.observations).toHaveLength(2);
    expect(structured.predictions).toEqual([]);
    expect(structured.predictions_status).toBe('unavailable');
    expect(structured).not.toHaveProperty('residual_summary');
    expect(callsTo(upstream, 'data')).toHaveLength(2);
  });

  it('says the block is temporary, on both surfaces, when the prediction fetch was throttled', async () => {
    fake((endpoint, url) =>
      url.searchParams.get('product') === 'predictions'
        ? THROTTLED(endpoint, url)
        : healthyCoops(endpoint, url),
    );
    const result = await runToolContract(noaaMarineGetWaterLevel, INPUT);
    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    const text = textOf(result);

    for (const surface of [notice, text]) {
      expect(surface).toContain('temporarily refusing requests');
      expect(surface).toContain('couple of minutes');
      expect(surface).not.toContain('Retry to obtain the comparison series');
    }
  });

  it('keeps the plain retry wording when the prediction fetch failed for another reason', async () => {
    fake((endpoint, url) =>
      url.searchParams.get('product') === 'predictions'
        ? new Response('gone', { status: 404 })
        : healthyCoops(endpoint, url),
    );
    const result = await runToolContract(noaaMarineGetWaterLevel, INPUT);
    const structured = result.structuredContent as { notice?: string; predictions_status?: string };

    expect(structured.predictions_status).toBe('unavailable');
    expect(structured.notice).toContain('Retry to obtain the comparison series');
    expect(textOf(result)).toContain('Retry to obtain the comparison series');
  });
});

describe('noaa_marine_get_tide_predictions under a CO-OPS throttle', () => {
  it('reports upstream_throttled after one catalog and one data request', async () => {
    const upstream = fake(THROTTLED);
    const result = await runToolContract(noaaMarineGetTidePredictions, {
      station_id: '9447130',
      begin_date: '20260916',
      end_date: '20260916',
    });

    expectThrottled(result, declaredRecovery(noaaMarineGetTidePredictions));
    expect(callsTo(upstream, 'catalog')).toHaveLength(1);
    expect(callsTo(upstream, 'data')).toHaveLength(1);
  });
});

describe('noaa_marine_get_monthly_means under a CO-OPS throttle', () => {
  it('reports upstream_throttled after one data request and no catalog read', async () => {
    const upstream = fake(THROTTLED);
    const result = await runToolContract(noaaMarineGetMonthlyMeans, {
      station_id: '9447130',
      begin_date: '20250101',
      end_date: '20251231',
    });

    expectThrottled(result, declaredRecovery(noaaMarineGetMonthlyMeans));
    expect(callsTo(upstream, 'data')).toHaveLength(1);
    expect(callsTo(upstream, 'catalog')).toHaveLength(0);
  });

  it('is the throttle even when the 403 body carries a CO-OPS datum phrase', async () => {
    fake(
      () =>
        new Response('{"error": {"message":" There is no IGLD for the station: 9447130"}}', {
          status: 403,
        }),
    );
    const result = await runToolContract(noaaMarineGetMonthlyMeans, {
      station_id: '9447130',
      begin_date: '20250101',
      end_date: '20251231',
      datum: 'IGLD',
    });

    expect(errorOf(result).data?.reason).toBe('upstream_throttled');
  });
});

describe('noaa_marine_get_currents under a CO-OPS throttle', () => {
  it('reports upstream_throttled after one catalog and one data request', async () => {
    const upstream = fake(THROTTLED);
    const result = await runToolContract(noaaMarineGetCurrents, {
      station_id: 'PUG1515',
      begin_date: '20260916',
      end_date: '20260916',
    });

    expectThrottled(result, declaredRecovery(noaaMarineGetCurrents));
    expect(callsTo(upstream, 'catalog')).toHaveLength(1);
    expect(callsTo(upstream, 'data')).toHaveLength(1);
  });
});

describe('noaa_marine_find_stations under a CO-OPS throttle', () => {
  it('names the wait in the sources_unavailable recovery when every catalog failed', async () => {
    const upstream = fake(THROTTLED);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockRejectedValue(new Error('NDBC down'));

    const result = await runToolContract(noaaMarineFindStations, { query: 'seattle' });
    const error = errorOf(result);
    const hint = hintOf(result);

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('sources_unavailable');
    expect(error.data?.failed_sources).toEqual(['coops', 'ndbc']);
    expect(hint).toContain('couple of minutes');
    expect(hint).not.toContain('a few moments');
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
    // One request per catalog: tide predictions, current predictions, water levels.
    expect(callsTo(upstream, 'catalog')).toHaveLength(3);
  });

  it('names the wait when a CO-OPS-only search is throttled', async () => {
    fake(THROTTLED);
    const result = await runToolContract(noaaMarineFindStations, { state: 'WA' });
    const hint = hintOf(result);

    expect(errorOf(result).data?.reason).toBe('sources_unavailable');
    expect(hint).toContain('couple of minutes');
  });

  it('keeps the partial-failure disclosure when NDBC answered', async () => {
    fake(THROTTLED);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([
      {
        id: '46041',
        name: 'Cape Elizabeth',
        lat: 47.35,
        lon: -124.73,
        hasMet: true,
        hasCurrents: false,
        hasWaterQuality: false,
      },
    ]);

    const result = await runToolContract(noaaMarineFindStations, { query: 'cape' });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    expect(structured.sources).toEqual({
      attempted: ['coops', 'ndbc'],
      answered: ['ndbc'],
      failed: ['coops'],
    });
    expect(structured.total_found).toBe(1);
  });

  it('keeps the original recovery for a catalog failure that is not the throttle', async () => {
    fake(() => new Response('gone', { status: 404 }));
    vi.spyOn(getNdbcService(), 'getActiveStations').mockRejectedValue(new Error('NDBC down'));

    const result = await runToolContract(noaaMarineFindStations, { query: 'seattle' });
    const hint = hintOf(result);

    expect(errorOf(result).data?.reason).toBe('sources_unavailable');
    expect(hint).toBe(
      'Retry the search in a few moments — a catalog is cached for six hours once a fetch succeeds.',
    );
  });
});

describe('CO-OPS 400 handling is unchanged by the throttle mapping', () => {
  const DATES = { begin_date: '20260916', end_date: '20260916' };

  it('keeps datum_unavailable for a water_level 400 naming the datum', async () => {
    fake((endpoint, url) =>
      endpoint === 'data' && url.searchParams.get('product') === 'water_level'
        ? new Response('{"error": {"message":" There is no MLLW for the station: 9447130"}}', {
            status: 400,
          })
        : healthyCoops(endpoint, url),
    );
    const result = await runToolContract(noaaMarineGetWaterLevel, {
      station_id: '9447130',
      ...DATES,
    });

    expect(errorOf(result).data?.reason).toBe('datum_unavailable');
  });

  it('keeps bin_unavailable for a currents 400 naming the bins', async () => {
    fake((endpoint, url) =>
      endpoint === 'data'
        ? new Response('{"error": {"message":"Available bin number of PUG1515: 15, 10, 1, "}}', {
            status: 400,
          })
        : healthyCoops(endpoint, url),
    );
    const result = await runToolContract(noaaMarineGetCurrents, {
      station_id: 'PUG1515',
      bin: 99,
      ...DATES,
    });

    expect(errorOf(result).data?.reason).toBe('bin_unavailable');
    expect(errorOf(result).data?.available_bins).toEqual([15, 10, 1]);
  });

  it('keeps station_not_found for a tide 400 naming an unknown station', async () => {
    fake((endpoint, url) =>
      endpoint === 'data'
        ? new Response(
            '{"error": {"message":" Wrong Station ID: Please submit a valid station ID "}}',
            { status: 400 },
          )
        : healthyCoops(endpoint, url),
    );
    const result = await runToolContract(noaaMarineGetTidePredictions, {
      station_id: '0000000',
      ...DATES,
    });

    expect(errorOf(result).data?.reason).toBe('station_not_found');
  });

  it.each([
    [
      'tide predictions',
      () => runToolContract(noaaMarineGetTidePredictions, { station_id: '9447130', ...DATES }),
    ],
    [
      'water level',
      () => runToolContract(noaaMarineGetWaterLevel, { station_id: '9447130', ...DATES }),
    ],
    ['currents', () => runToolContract(noaaMarineGetCurrents, { station_id: 'PUG1515', ...DATES })],
    [
      'monthly means',
      () => runToolContract(noaaMarineGetMonthlyMeans, { station_id: '9447130', ...DATES }),
    ],
  ])('keeps station_not_found for an unclassifiable 400 on %s', async (_name, run) => {
    fake((endpoint, url) =>
      endpoint === 'data'
        ? new Response('<<not json>>', { status: 400 })
        : healthyCoops(endpoint, url),
    );
    const result = await run();

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.NotFound);
    expect(errorOf(result).data?.reason).toBe('station_not_found');
  });
});
