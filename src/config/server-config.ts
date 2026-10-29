/**
 * @fileoverview Server-specific environment variable configuration for noaa-marine-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';

const ServerConfigSchema = z.object({
  applicationId: z
    .string()
    .default('noaa-marine-mcp-server')
    .describe('Courtesy identifier sent as application= on CO-OPS requests.'),
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Clamp a count input above its cap to the cap, with a notice. False advertises and enforces each cap as a schema maximum instead.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Load `./.env` into `process.env`, never overriding a variable already set. `tool()` emits each
 * input schema when its definition module is imported, which resolves the `limit` field's lazy
 * bound — and so the first parse here — before `createApp()` loads `.env`. Bun loads `.env` at
 * process start; Node needs this. A missing file is the normal case.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw configurationError(
      'Failed to load .env from the working directory.',
      { cwd: process.cwd() },
      { cause: error },
    );
  }
}

/** The parsed server config, cached on first call; that first call loads `./.env`. */
export function getServerConfig(): ServerConfig {
  if (_config) return _config;
  loadDotEnv();
  _config = parseEnvConfig(ServerConfigSchema, {
    applicationId: 'NOAA_APPLICATION_ID',
    clampLimits: 'NOAA_CLAMP_LIMITS',
  });
  return _config;
}
