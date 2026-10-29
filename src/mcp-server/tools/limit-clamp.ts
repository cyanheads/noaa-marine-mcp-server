/**
 * @fileoverview The default and cap of every count input, the `limit` field built from them,
 * the clamp that reduces an over-cap value to the cap with a notice, log line, and counter, and
 * the `offset` field the paged tools share.
 * @module mcp-server/tools/limit-clamp
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/**
 * Default and per-call cap of each tool's `limit`. A series cap of 1,000 rows keeps the widest
 * page (monthly means) near half a megabyte across both surfaces; the station cap keeps a
 * `find_stations` page near 120 KB.
 */
export const COUNT_LIMITS = {
  noaa_marine_find_stations: { default: 20, cap: 200 },
  noaa_marine_get_currents: { default: 50, cap: 1000 },
  noaa_marine_get_monthly_means: { default: 24, cap: 1000 },
  noaa_marine_get_tide_predictions: { default: 50, cap: 1000 },
  noaa_marine_get_water_level: { default: 50, cap: 1000 },
} as const satisfies Record<string, { cap: number; default: number }>;

/** A tool whose `limit` input this module owns. */
export type LimitedTool = keyof typeof COUNT_LIMITS;

let clamps: ReturnType<typeof createCounter> | undefined;

const count = (n: number) => n.toLocaleString('en-US');

/**
 * The tool's `limit` field: a positive whole number defaulting to the tool's default. While
 * clamping is on (`NOAA_CLAMP_LIMITS` unset or true) it advertises no maximum — `multipleOf(1)`,
 * since `.int()` advertises the safe-integer ceiling as `maximum` — and a larger value reaches
 * the handler for {@link clampLimit}. With `NOAA_CLAMP_LIMITS=false` it advertises and enforces
 * `maximum` at the cap.
 *
 * The description is `lead` followed by the default and what the cap means in the active mode.
 * Bounds and description both read the config lazily — the bounds when the schema is first
 * converted or parsed, the description (a getter) each time it is read. `tool()` converts the
 * schema when the definition module is imported, so the first `getServerConfig()` call runs
 * then, before `createApp()`; it loads `.env` itself for that reason.
 */
export function limitSchema(tool: LimitedTool, lead: string) {
  const { cap, default: fallback } = COUNT_LIMITS[tool];
  return z
    .lazy(() =>
      getServerConfig().clampLimits
        ? z.number().multipleOf(1, 'Send limit as a whole number, not a fractional one.').min(1)
        : z.number().int().min(1).max(cap),
    )
    .default(fallback)
    .meta({
      get description() {
        const rule = getServerConfig().clampLimits
          ? `a larger value returns at most ${count(cap)} and says so`
          : `at most ${count(cap)}`;
        return `${lead} Default ${count(fallback)}; ${rule}.`;
      },
    });
}

/**
 * A paged tool's `offset` field: a whole number from 0, defaulting to 0, with no maximum in
 * either `NOAA_CLAMP_LIMITS` mode — an offset past the end is an empty page, not an error.
 * `multipleOf(1)` rather than `.int()`, which advertises the safe-integer ceiling as `maximum`.
 */
export function offsetSchema(description: string) {
  return z
    .number()
    .multipleOf(1, 'Send offset as a whole number, not a fractional one.')
    .min(0)
    .default(0)
    .describe(description);
}

/**
 * Reduce a requested count above the tool's cap to the cap. A clamp writes an info log line,
 * adds one to `noaa_marine.limit.clamps` (labelled by tool), and returns a notice naming the
 * requested and applied values; a value at or under the cap passes through with no notice.
 */
export function clampLimit(
  tool: LimitedTool,
  requested: number,
  ctx: Context,
): { applied: number; notice?: string } {
  const { cap } = COUNT_LIMITS[tool];
  if (requested <= cap) return { applied: requested };
  ctx.log.info('Clamped limit', { tool, requested, applied: cap });
  // Created on first clamp: `createCounter` reads the core config and binds the global meter,
  // so a module-level call would parse config before `.env` loads and bind a no-op meter
  // before the OTel SDK starts.
  clamps ??= createCounter(
    'noaa_marine.limit.clamps',
    'Count inputs clamped to their per-call cap',
    '{clamp}',
  );
  clamps.add(1, { [ATTR_MCP_TOOL_NAME]: tool });
  return {
    applied: cap,
    notice: `Requested limit ${requested}; applied limit ${cap}, the per-call cap.`,
  };
}
