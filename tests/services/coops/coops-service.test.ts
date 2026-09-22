/**
 * @fileoverview Tests for the CO-OPS service's upstream boundary — the message
 * classifier that turns CO-OPS wording into a typed reason, and the current-prediction
 * fetch's handling of the shapes CO-OPS actually returns.
 * @module tests/services/coops/coops-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCoopsService, initCoopsService } from '@/services/coops/coops-service.js';
import { type CoopsEndpoint, callsTo, installCoopsFake } from '../../support/coops-http.js';

/** A live `MAX_SLACK` envelope: `Velocity_Major` and the mean bearings are JSON numbers, `Bin` and `Depth` strings. */
const MAX_SLACK_BODY = {
  current_predictions: {
    units: 'feet, knots',
    cp: [
      {
        Type: 'slack',
        meanFloodDir: 234,
        Bin: '15',
        meanEbbDir: 341,
        Time: '2026-09-18 02:47',
        Depth: '16',
        Velocity_Major: 0,
      },
      {
        Type: 'flood',
        meanFloodDir: 234,
        Bin: '15',
        meanEbbDir: 341,
        Time: '2026-09-18 07:12',
        Depth: '16',
        Velocity_Major: 0.89,
      },
    ],
  },
};

/** CO-OPS answers a weak-and-variable station with a string where the event array belongs. */
const WEAK_AND_VARIABLE_BODY = {
  current_predictions: { units: 'feet, knots', cp: 'Currents are weak and variable' },
};

function setup(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initCoopsService(null as any, null as any, { applicationId: 'test' });
}

/** Installs one datagetter response and returns the harness so the request can be inspected. */
function mockDatagetter(respond: Response | (() => Response)) {
  return createFetchMock([
    {
      match: (request) => request.url.includes('/api/prod/datagetter'),
      respond: typeof respond === 'function' ? () => respond() : respond,
    },
  ]);
}

const CURRENT_PARAMS = {
  station: 'PUG1515',
  begin_date: '20260918',
  end_date: '20260918',
  time_zone: 'lst_ldt',
  units: 'english',
  interval: 'MAX_SLACK',
};

describe('CoopsService.fetchCurrentPredictions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setup();
  });

  it('returns MAX_SLACK rows with the JSON types CO-OPS sends', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(Response.json(MAX_SLACK_BODY));
    http.install();
    try {
      const result = await getCoopsService().fetchCurrentPredictions(CURRENT_PARAMS, ctx);
      expect(result.events).toHaveLength(2);
      expect(result.events?.[1]).toMatchObject({
        Type: 'flood',
        Velocity_Major: 0.89,
        meanFloodDir: 234,
        meanEbbDir: 341,
        Bin: '15',
        Depth: '16',
      });
      expect(result.statement).toBeUndefined();
    } finally {
      http.restore();
    }
  });

  it('forwards an explicit bin as the CO-OPS bin parameter, and omits it otherwise', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(() => Response.json(MAX_SLACK_BODY));
    http.install();
    try {
      await getCoopsService().fetchCurrentPredictions({ ...CURRENT_PARAMS, bin: 10 }, ctx);
      await getCoopsService().fetchCurrentPredictions(CURRENT_PARAMS, ctx);

      const [withBin, withoutBin] = http.calls;
      expect(new URL(withBin!.request.url).searchParams.get('bin')).toBe('10');
      expect(new URL(withoutBin!.request.url).searchParams.has('bin')).toBe(false);
    } finally {
      http.restore();
    }
  });

  it('surfaces a string cp as a CO-OPS statement instead of coercing it to an empty array', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(Response.json(WEAK_AND_VARIABLE_BODY));
    http.install();
    try {
      const result = await getCoopsService().fetchCurrentPredictions(CURRENT_PARAMS, ctx);
      expect(result.statement).toBe('Currents are weak and variable');
      expect(result.events).toEqual([]);
    } finally {
      http.restore();
    }
  });

  it('surfaces the same statement on the 6-minute interval', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(Response.json(WEAK_AND_VARIABLE_BODY));
    http.install();
    try {
      const result = await getCoopsService().fetchCurrentPredictions(
        { ...CURRENT_PARAMS, interval: '6min' },
        ctx,
      );
      expect(result.statement).toBe('Currents are weak and variable');
      expect(result.predictions).toEqual([]);
    } finally {
      http.restore();
    }
  });

  it('classifies a coverage statement in a 200 body as predictions_unavailable, not a station error', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(
      Response.json({
        error: { message: 'Currents predictions are not available from the requested station.' },
      }),
    );
    http.install();
    try {
      const err = await getCoopsService()
        .fetchCurrentPredictions({ ...CURRENT_PARAMS, station: 'PCT1676' }, ctx)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ coopsReason: 'predictions_unavailable' });
    } finally {
      http.restore();
    }
  });

  it('classifies an HTTP 400 bin rejection as bin_unavailable and carries the bins CO-OPS named', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(
      new Response('{"error": {"message":"Available bin number of PUG1515: 15, 10, 1, "}}', {
        status: 400,
      }),
    );
    http.install();
    try {
      const err = await getCoopsService()
        .fetchCurrentPredictions({ ...CURRENT_PARAMS, bin: 99 }, ctx)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ coopsReason: 'bin_unavailable', availableBins: [15, 10, 1] });
    } finally {
      http.restore();
    }
  });

  it('classifies an HTTP 400 unknown-station rejection as a station error', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(
      new Response(
        '{"error": {"message":" Wrong Station ID: Please submit a valid station ID "}}',
        {
          status: 400,
        },
      ),
    );
    http.install();
    try {
      const err = await getCoopsService()
        .fetchCurrentPredictions({ ...CURRENT_PARAMS, station: 'BADID999' }, ctx)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ coopsReason: 'station_error' });
    } finally {
      http.restore();
    }
  });

  it('leaves an unclassifiable HTTP 400 as the upstream error, with its status intact', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(new Response('<<not json>>', { status: 400 }));
    http.install();
    try {
      const err = await getCoopsService()
        .fetchCurrentPredictions(CURRENT_PARAMS, ctx)
        .catch((e: unknown) => e);
      expect(err).not.toHaveProperty('coopsReason');
      expect((err as { data?: { status?: number } }).data?.status).toBe(400);
    } finally {
      http.restore();
    }
  });
});

/**
 * Datum rejections. CO-OPS answers them on two different transports — `water_level` with an
 * HTTP 400 whose body names the datum, `predictions` with an HTTP 200 carrying a body-level
 * error — and the bodies below are the verbatim wordings CO-OPS returned for each.
 */
describe('CoopsService datum classification', () => {
  const WL_PARAMS = {
    station: '9087044',
    begin_date: '20260916',
    end_date: '20260916',
    datum: 'MLLW',
    product: 'water_level',
    time_zone: 'lst_ldt',
    units: 'english',
  };

  const PRED_PARAMS = { ...WL_PARAMS, station: '9447130', interval: 'hilo' };

  const WL_ROWS = [
    { t: '2026-09-16 00:00', v: '8.23', s: '0.01', f: '0,0,0,0', q: 'p' },
    { t: '2026-09-16 00:06', v: '8.31', s: '0.01', f: '0,0,0,0', q: 'p' },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    setup();
  });

  /** Runs a `water_level` fetch against one canned datagetter response and returns the rejection. */
  async function waterLevelError(
    respond: Response,
    params: Partial<typeof WL_PARAMS> = {},
  ): Promise<unknown> {
    const ctx = createMockContext();
    const http = mockDatagetter(respond);
    http.install();
    try {
      return await getCoopsService()
        .fetchWaterLevel({ ...WL_PARAMS, ...params }, ctx)
        .catch((e: unknown) => e);
    } finally {
      http.restore();
    }
  }

  /** Same for `predictions`, whose rejections arrive as HTTP 200 body errors. */
  async function predictionsError(
    respond: Response,
    params: Partial<typeof PRED_PARAMS> = {},
  ): Promise<unknown> {
    const ctx = createMockContext();
    const http = mockDatagetter(respond);
    http.install();
    try {
      return await getCoopsService()
        .fetchTidePredictions({ ...PRED_PARAMS, ...params }, ctx)
        .catch((e: unknown) => e);
    } finally {
      http.restore();
    }
  }

  it('classifies a water_level HTTP 400 "There is no <DATUM> for the station" as datum_unavailable', async () => {
    const err = await waterLevelError(
      new Response('{"error": {"message":" There is no MLLW for the station: 9087044"}}', {
        status: 400,
      }),
    );
    expect(err).toMatchObject({ coopsReason: 'datum_unavailable' });
  });

  it('classifies the "<DATUM> Offset" variant as datum_unavailable', async () => {
    const err = await waterLevelError(
      new Response('{"error": {"message":" There is no CRD Offset for the station: 9440083"}}', {
        status: 400,
      }),
      { station: '9440083', datum: 'CRD' },
    );
    expect(err).toMatchObject({ coopsReason: 'datum_unavailable' });
  });

  it('classifies the "supported Datum values" rejection as datum_unavailable', async () => {
    const err = await waterLevelError(
      new Response(
        '{"error": {"message":" The supported Datum values are: MHHW, MHW, MTL, MSL, MLW, MLLW, NAVD, LWI, HWI"}}',
        { status: 400 },
      ),
      { station: '9447130', datum: 'CRD' },
    );
    expect(err).toMatchObject({ coopsReason: 'datum_unavailable' });
  });

  it('classifies the derived-datum rejection as datum_unavailable', async () => {
    const err = await waterLevelError(
      new Response('{"error": {"message":" Wrong Datum: The datum supplied is a derived datum"}}', {
        status: 400,
      }),
      { station: '9447130', datum: 'MTL' },
    );
    expect(err).toMatchObject({ coopsReason: 'datum_unavailable' });
  });

  it('reads the ambiguous predictions sentence as datum_unavailable when the datum is not MLLW', async () => {
    const err = await predictionsError(
      Response.json({
        error: {
          message: 'No Predictions data was found. Please make sure the Datum input is valid.',
        },
      }),
      { station: '9439040', datum: 'NAVD' },
    );
    expect(err).toMatchObject({ coopsReason: 'datum_unavailable' });
  });

  it('reads the same sentence as no_predictions when MLLW was requested', async () => {
    const err = await predictionsError(
      Response.json({
        error: {
          message: 'No Predictions data was found. Please make sure the Datum input is valid.',
        },
      }),
      { datum: 'MLLW' },
    );
    expect(err).toMatchObject({ coopsReason: 'no_predictions' });
  });

  it('classifies the Great Lakes predictions refusal as its own reason, not a station error', async () => {
    const err = await predictionsError(
      new Response('{"error": {"message":"Great Lakes stations don\'t have Predictions data."}}', {
        status: 400,
      }),
      { station: '9087044', datum: 'MLLW' },
    );
    expect(err).toMatchObject({ coopsReason: 'great_lakes_no_predictions' });
  });

  it('still classifies an unknown station ID as a station error on the water_level transport', async () => {
    const err = await waterLevelError(
      new Response(
        '{"error": {"message":" Wrong Station ID: Please submit a valid station ID "}}',
        { status: 400 },
      ),
      { station: '0000000' },
    );
    expect(err).toMatchObject({ coopsReason: 'station_error' });
  });

  it('does not read a non-datum "there is no …" sentence as a datum rejection', async () => {
    const err = await waterLevelError(
      new Response('{"error": {"message":" There is no data for the station: 9087044"}}', {
        status: 400,
      }),
    );
    expect(err).not.toMatchObject({ coopsReason: 'datum_unavailable' });
  });

  it('leaves an accepted datum at a coastal station alone', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(Response.json({ metadata: { name: 'Seattle' }, data: WL_ROWS }));
    http.install();
    try {
      const result = await getCoopsService().fetchWaterLevel(
        { ...WL_PARAMS, station: '9447130' },
        ctx,
      );
      expect(result.stationName).toBe('Seattle');
      expect(result.data).toHaveLength(2);
    } finally {
      http.restore();
    }
  });
});

// --- #30: the coarser water-level products and the messages they answer with ---

describe('CoopsService coarse water-level products', () => {
  const BASE = {
    begin_date: '20250101',
    datum: 'MLLW',
    end_date: '20250105',
    station: '9447130',
    time_zone: 'lst_ldt',
    units: 'english',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    setup();
  });

  /** Runs one water-level fetch and hands back the request the service built. */
  async function requestFor(params: Record<string, string>): Promise<URL> {
    const ctx = createMockContext();
    const http = mockDatagetter(() => Response.json({ metadata: { name: 'X' }, data: [] }));
    http.install();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await getCoopsService().fetchWaterLevel({ ...BASE, ...params } as any, ctx);
      return new URL(http.calls[0]!.request.url);
    } finally {
      http.restore();
    }
  }

  it('sends the product it was given', async () => {
    for (const product of ['water_level', 'hourly_height', 'high_low', 'daily_mean']) {
      const url = await requestFor({ product });
      expect(url.searchParams.get('product')).toBe(product);
    }
  });

  it('forces time_zone lst on daily_mean, which CO-OPS serves in LST only', async () => {
    const url = await requestFor({ product: 'daily_mean', time_zone: 'lst_ldt' });
    expect(url.searchParams.get('time_zone')).toBe('lst');
  });

  it('leaves the requested time zone alone on every other product', async () => {
    for (const product of ['water_level', 'hourly_height', 'high_low']) {
      const url = await requestFor({ product, time_zone: 'lst_ldt' });
      expect(url.searchParams.get('time_zone')).toBe('lst_ldt');
    }
  });

  it('sends the paired prediction interval it was given', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(() => Response.json({ predictions: [] }));
    http.install();
    try {
      for (const interval of ['6', 'h', 'hilo']) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await getCoopsService().fetchWaterLevelPredictions({ ...BASE, interval } as any, ctx);
      }
      const sent = http.calls.map((c) => new URL(c.request.url).searchParams.get('interval'));
      expect(sent).toEqual(['6', 'h', 'hilo']);
    } finally {
      http.restore();
    }
  });

  it('returns the ty classification CO-OPS puts on a high_low row', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(
      Response.json({
        data: [{ f: '0,0', t: '2025-01-01 00:06', ty: 'H ', v: '10.956' }],
        metadata: { name: 'Seattle' },
      }),
    );
    http.install();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getCoopsService().fetchWaterLevel(
        { ...BASE, product: 'high_low' } as any,
        ctx,
      );
      expect(result.data[0]?.ty).toBe('H ');
      expect(result.data[0]?.q).toBeUndefined();
    } finally {
      http.restore();
    }
  });

  it('classifies the Great Lakes daily-mean refusal as its own reason, not a station error', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(
      new Response(
        '{"error": {"message":"Water Level Daily Mean Data is only available for Great Lakes stations, and not for coastal stations."}}',
        { status: 400 },
      ),
    );
    http.install();
    try {
      const err = await getCoopsService()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .fetchWaterLevel({ ...BASE, product: 'daily_mean' } as any, ctx)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ coopsReason: 'great_lakes_only' });
    } finally {
      http.restore();
    }
  });

  it('classifies the verified-data-lag body as product_not_offered, not a bare no_predictions', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(
      Response.json({
        error: {
          message:
            'No data was found. This product may not be offered at this station at the requested time.',
        },
      }),
    );
    http.install();
    try {
      const err = await getCoopsService()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .fetchWaterLevel({ ...BASE, product: 'hourly_height' } as any, ctx)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ coopsReason: 'product_not_offered' });
    } finally {
      http.restore();
    }
  });

  it('still classifies a plain no-data body as no_predictions', async () => {
    const ctx = createMockContext();
    const http = mockDatagetter(Response.json({ error: { message: 'No data was found.' } }));
    http.install();
    try {
      const err = await getCoopsService()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .fetchWaterLevel({ ...BASE, product: 'water_level' } as any, ctx)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ coopsReason: 'no_predictions' });
    } finally {
      http.restore();
    }
  });
});

// --- #37: an HTTP 403 is CO-OPS throttling this address, not a bad request ---

/**
 * Every CO-OPS request site, driven through the real `withRetry` against a fake upstream, so
 * the request count below is what the retry loop actually sent.
 */
const REQUEST_SITES: {
  name: string;
  endpoint: CoopsEndpoint;
  /** Requests a transient failure costs: the first plus the site's `maxRetries`. */
  attempts: number;
  call: (ctx: ReturnType<typeof createMockContext>) => Promise<unknown>;
}[] = [
  {
    name: 'getStations',
    endpoint: 'catalog',
    attempts: 3,
    call: (ctx) => getCoopsService().getStations('tidepredictions', ctx),
  },
  {
    name: 'fetchTidePredictions',
    endpoint: 'data',
    attempts: 4,
    call: (ctx) =>
      getCoopsService().fetchTidePredictions(
        {
          station: '9447130',
          begin_date: '20260916',
          end_date: '20260916',
          datum: 'MLLW',
          time_zone: 'lst_ldt',
          units: 'english',
          interval: 'hilo',
        },
        ctx,
      ),
  },
  {
    name: 'fetchWaterLevel',
    endpoint: 'data',
    attempts: 4,
    call: (ctx) =>
      getCoopsService().fetchWaterLevel(
        {
          station: '9447130',
          begin_date: '20260916',
          end_date: '20260916',
          datum: 'MLLW',
          product: 'water_level',
          time_zone: 'lst_ldt',
          units: 'english',
        },
        ctx,
      ),
  },
  {
    name: 'fetchWaterLevelPredictions',
    endpoint: 'data',
    attempts: 3,
    call: (ctx) =>
      getCoopsService().fetchWaterLevelPredictions(
        {
          station: '9447130',
          begin_date: '20260916',
          end_date: '20260916',
          datum: 'MLLW',
          interval: '6',
          time_zone: 'lst_ldt',
          units: 'english',
        },
        ctx,
      ),
  },
  {
    name: 'fetchCurrentPredictions',
    endpoint: 'data',
    attempts: 4,
    call: (ctx) => getCoopsService().fetchCurrentPredictions(CURRENT_PARAMS, ctx),
  },
];

/** Settles a call that must reject and hands back what it rejected with. */
async function rejectionOf(call: Promise<unknown>): Promise<McpError> {
  try {
    await call;
  } catch (error) {
    return error as McpError;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

/** A contract carrying the throttle reason, so the service's recovery resolves from it. */
const THROTTLE_CONTRACT = [
  {
    reason: 'upstream_throttled',
    code: JsonRpcErrorCode.RateLimited,
    when: 'CO-OPS answered HTTP 403.',
    recovery: 'Wait a couple of minutes, then retry more slowly.',
    retryable: true,
  },
] as const;

describe.each(REQUEST_SITES)(
  'CoopsService.$name upstream failures',
  ({ attempts, call, endpoint }) => {
    beforeEach(() => {
      vi.restoreAllMocks();
      setup();
    });

    it('maps an HTTP 403 to upstream_throttled after one request, with no upstream body', async () => {
      const ctx = createMockContext({ errors: THROTTLE_CONTRACT });
      const http = installCoopsFake(() => new Response('{"message":"Forbidden"}', { status: 403 }));
      try {
        const err = await rejectionOf(call(ctx));

        expect(err).toBeInstanceOf(McpError);
        expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(err.data).toMatchObject({
          reason: 'upstream_throttled',
          retryable: true,
          status: 403,
          recovery: { hint: 'Wait a couple of minutes, then retry more slowly.' },
        });
        expect(err.data).not.toHaveProperty('body');
        expect(err.data).not.toHaveProperty('responseBody');
        // RateLimited is transient to withRetry, so a mapping inside the retry closure would
        // re-send into the block. One request means the mapping sits after it.
        expect(callsTo(http, endpoint)).toHaveLength(1);
      } finally {
        http.restore();
      }
    });

    it('reads the status before the body, so a 403 carrying a CO-OPS phrase is still the throttle', async () => {
      const ctx = createMockContext();
      const http = installCoopsFake(
        () =>
          new Response(
            '{"error": {"message":" Wrong Station ID: Please submit a valid station ID "}}',
            { status: 403 },
          ),
      );
      try {
        const err = await rejectionOf(call(ctx));

        expect(err.data).toMatchObject({ reason: 'upstream_throttled' });
        expect(err).not.toHaveProperty('coopsReason');
      } finally {
        http.restore();
      }
    });

    it('still retries a 5xx under its withRetry settings and surfaces ServiceUnavailable', async () => {
      vi.useFakeTimers();
      const ctx = createMockContext();
      const http = installCoopsFake(() => new Response('upstream down', { status: 503 }));
      try {
        const assertion = expect(call(ctx)).rejects.toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
        });
        await vi.runAllTimersAsync();
        await assertion;
        expect(callsTo(http, endpoint)).toHaveLength(attempts);
      } finally {
        http.restore();
        vi.useRealTimers();
      }
    });
  },
);
