/**
 * @fileoverview The shared count-input cap: the default/cap table, schema bounds and description
 * per NOAA_CLAMP_LIMITS mode, and the clamp's value table, notice, log line, and counter.
 * Per-tool tests prove only the wiring.
 * @module tests/mcp-server/tools/limit-clamp.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { ATTR_MCP_TOOL_NAME } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const counter = vi.hoisted(() => ({ add: vi.fn() }));
const counterNames = vi.hoisted(() => [] as string[]);
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string) => {
    counterNames.push(name);
    return counter;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NOAA_CLAMP_LIMITS', undefined);
  counter.add.mockReset();
  counterNames.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

const load = () => import('@/mcp-server/tools/limit-clamp.js');
const emit = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' });

describe('COUNT_LIMITS', () => {
  it('pins the default and cap of every count input', async () => {
    const { COUNT_LIMITS } = await load();
    expect(COUNT_LIMITS).toEqual({
      noaa_marine_find_stations: { default: 20, cap: 200 },
      noaa_marine_get_currents: { default: 50, cap: 1000 },
      noaa_marine_get_monthly_means: { default: 24, cap: 1000 },
      noaa_marine_get_tide_predictions: { default: 50, cap: 1000 },
      noaa_marine_get_water_level: { default: 50, cap: 1000 },
    });
  });
});

describe('clampLimit', () => {
  it.each([
    ['noaa_marine_get_tide_predictions', 1],
    ['noaa_marine_get_tide_predictions', 50],
    ['noaa_marine_get_tide_predictions', 1000],
    ['noaa_marine_find_stations', 200],
  ] as const)('passes %s limit %i through without a notice, log, or count', async (tool, n) => {
    const { clampLimit } = await load();
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    const result = clampLimit(tool, n, ctx);
    expect(result).toEqual({ applied: n });
    expect(result).not.toHaveProperty('notice');
    expect(info).not.toHaveBeenCalled();
    expect(counter.add).not.toHaveBeenCalled();
    expect(counterNames).toEqual([]);
  });

  it.each([
    ['noaa_marine_get_water_level', 1001, 1000],
    ['noaa_marine_get_monthly_means', 1e20, 1000],
    ['noaa_marine_find_stations', 201, 200],
  ] as const)(
    'clamps %s limit %d to %i, naming requested and applied values',
    async (tool, n, cap) => {
      const { clampLimit } = await load();
      const ctx = createMockContext();
      const info = vi.spyOn(ctx.log, 'info');
      expect(clampLimit(tool, n, ctx)).toEqual({
        applied: cap,
        notice: `Requested limit ${n}; applied limit ${cap}, the per-call cap.`,
      });
      expect(info).toHaveBeenCalledExactlyOnceWith('Clamped limit', {
        tool,
        requested: n,
        applied: cap,
      });
      expect(counter.add).toHaveBeenCalledExactlyOnceWith(1, { [ATTR_MCP_TOOL_NAME]: tool });
      expect(counterNames).toEqual(['noaa_marine.limit.clamps']);
    },
  );

  it('creates the counter once across clamps', async () => {
    const { clampLimit } = await load();
    const ctx = createMockContext();
    clampLimit('noaa_marine_find_stations', 500, ctx);
    clampLimit('noaa_marine_get_currents', 5000, ctx);
    expect(counterNames).toEqual(['noaa_marine.limit.clamps']);
    expect(counter.add).toHaveBeenCalledTimes(2);
  });
});

describe('limitSchema, clamping on (default)', () => {
  it.each(['', 'true'])('accepts values above the cap with NOAA_CLAMP_LIMITS=%j', async (v) => {
    vi.stubEnv('NOAA_CLAMP_LIMITS', v);
    const { limitSchema } = await load();
    const schema = limitSchema('noaa_marine_find_stations', 'Stations per page.');
    expect(schema.parse(201)).toBe(201);
    expect(schema.parse(1e20)).toBe(1e20);
    // `.int()` would advertise the safe-integer ceiling as a maximum.
    expect(emit(schema)).toMatchObject({ type: 'number', minimum: 1, multipleOf: 1, default: 20 });
    expect(emit(schema)).not.toHaveProperty('maximum');
  });

  it('fills the default when the field is omitted', async () => {
    const { limitSchema } = await load();
    const shape = z.object({
      limit: limitSchema('noaa_marine_get_monthly_means', 'Months per page.'),
    });
    expect(shape.parse({})).toEqual({ limit: 24 });
  });

  it.each([0, -1, 1.5])('still rejects %d', async (n) => {
    const { limitSchema } = await load();
    expect(limitSchema('noaa_marine_get_currents', 'Rows.').safeParse(n).success).toBe(false);
  });

  it('describes the default and an over-cap value as clamped and disclosed', async () => {
    const { limitSchema } = await load();
    const schema = limitSchema('noaa_marine_get_tide_predictions', 'Rows per page.');
    expect(schema.description).toBe(
      'Rows per page. Default 50; a larger value returns at most 1,000 and says so.',
    );
    expect(emit(schema).description).toBe(schema.description);
  });
});

describe('limitSchema, NOAA_CLAMP_LIMITS=false', () => {
  it('advertises and enforces a maximum at the cap', async () => {
    vi.stubEnv('NOAA_CLAMP_LIMITS', 'false');
    const { limitSchema } = await load();
    const schema = limitSchema('noaa_marine_find_stations', 'Stations per page.');
    expect(schema.parse(200)).toBe(200);
    expect(schema.safeParse(201).success).toBe(false);
    expect(emit(schema)).toMatchObject({ type: 'integer', minimum: 1, maximum: 200, default: 20 });
  });

  it('describes the cap without promising a clamp', async () => {
    vi.stubEnv('NOAA_CLAMP_LIMITS', 'false');
    const { limitSchema } = await load();
    const schema = limitSchema('noaa_marine_get_water_level', 'Observations per page.');
    expect(schema.description).toBe('Observations per page. Default 50; at most 1,000.');
    expect(emit(schema).description).toBe(schema.description);
  });
});

describe('limitSchema config timing', () => {
  it('reads the mode when the description is read, not when the field is built', async () => {
    const { limitSchema } = await load();
    const schema = limitSchema('noaa_marine_find_stations', 'Stations per page.');
    // Building the field must not parse the config: `createApp()` loads `.env` after the
    // definition modules are imported, and the parsed config is cached.
    vi.stubEnv('NOAA_CLAMP_LIMITS', 'false');
    expect(schema.description).toBe('Stations per page. Default 20; at most 200.');
    expect(schema.safeParse(201).success).toBe(false);
  });

  it('rejects an unparseable NOAA_CLAMP_LIMITS rather than reading it as true', async () => {
    vi.stubEnv('NOAA_CLAMP_LIMITS', 'maybe');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(() => getServerConfig()).toThrow(/NOAA_CLAMP_LIMITS/);
  });
});

/**
 * `tool()` converts each schema when its definition module is imported, which resolves the
 * `limit` bound before `createApp()` loads `.env`, so the first config read loads it.
 */
describe('getServerConfig .env load', () => {
  afterEach(() => vi.restoreAllMocks());

  const errnoError = (code: string) => Object.assign(new Error(code), { code });

  it('applies a value set only in .env to the limit bound', async () => {
    const loadEnvFile = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      process.env.NOAA_CLAMP_LIMITS = 'false';
    });
    const { limitSchema } = await load();
    const schema = limitSchema('noaa_marine_find_stations', 'Stations per page.');
    expect(emit(schema)).toMatchObject({ type: 'integer', maximum: 200 });
    expect(loadEnvFile).toHaveBeenCalledOnce();
  });

  it('loads .env once across reads', async () => {
    const loadEnvFile = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    const { getServerConfig } = await import('@/config/server-config.js');
    getServerConfig();
    getServerConfig();
    expect(loadEnvFile).toHaveBeenCalledOnce();
  });

  it('reads the defaults when there is no .env', async () => {
    vi.stubEnv('NOAA_APPLICATION_ID', undefined);
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw errnoError('ENOENT');
    });
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig()).toEqual({
      applicationId: 'noaa-marine-mcp-server',
      clampLimits: true,
    });
  });

  it('fails as a configuration error when .env exists but cannot be read', async () => {
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw errnoError('EACCES');
    });
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(() => getServerConfig()).toThrow('Failed to load .env from the working directory.');
  });
});

describe('offsetSchema', () => {
  it.each([
    [0, 0],
    [50, 50],
    [1e20, 1e20],
  ])('accepts offset %d', async (n, expected) => {
    const { offsetSchema } = await load();
    expect(offsetSchema('Row offset.').parse(n)).toBe(expected);
  });

  it('fills 0 when the field is omitted', async () => {
    const { offsetSchema } = await load();
    expect(z.object({ offset: offsetSchema('Row offset.') }).parse({})).toEqual({ offset: 0 });
  });

  it.each([-1, 1.5])('rejects %d', async (n) => {
    const { offsetSchema } = await load();
    expect(offsetSchema('Row offset.').safeParse(n).success).toBe(false);
  });

  it('names the whole-number rule when it rejects a fraction', async () => {
    const { offsetSchema } = await load();
    const result = offsetSchema('Row offset.').safeParse(2.5);
    expect(result.error?.issues[0]?.message).toBe(
      'Send offset as a whole number, not a fractional one.',
    );
  });

  it.each([undefined, 'false'])(
    'advertises minimum 0, default 0, and no maximum with NOAA_CLAMP_LIMITS=%j',
    async (v) => {
      vi.stubEnv('NOAA_CLAMP_LIMITS', v);
      const { offsetSchema } = await load();
      const { $schema: _, ...json } = emit(offsetSchema('Row offset.'));
      // `.int()` would advertise the safe-integer ceiling as a maximum.
      expect(json).toEqual({
        type: 'number',
        minimum: 0,
        multipleOf: 1,
        default: 0,
        description: 'Row offset.',
      });
    },
  );
});
