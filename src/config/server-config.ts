/**
 * @fileoverview Server-specific environment variable configuration for noaa-marine-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  applicationId: z
    .string()
    .default('noaa-marine-mcp-server')
    .describe('Courtesy identifier sent as application= on CO-OPS requests.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    applicationId: 'NOAA_APPLICATION_ID',
  });
  return _config;
}
