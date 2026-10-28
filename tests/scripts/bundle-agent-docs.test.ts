/**
 * @fileoverview Tests for the bundle agent-doc matcher shared by
 * `scripts/clean-mcpb.ts` (the strip step) and `scripts/lint-packaging.ts` (the
 * post-bundle check): runtime `skills/` modules deep inside a package survive,
 * agent-doc trees at a package root are stripped, and the two copies agree.
 * The scripts load through a run-time URL import so `tsc` does not follow them
 * into `lint-packaging.ts`'s repository-only fallback import.
 * @module tests/scripts/bundle-agent-docs.test
 */

import { beforeAll, describe, expect, it } from 'vitest';

interface CleanMcpbModule {
  AGENT_DOC_ENTRY: RegExp;
  filterAgentDocEntries(entries: string[]): string[];
}

interface LintPackagingModule {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
}

/** Runtime modules the MCP SDK's skills extension imports at startup. */
const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.d.mts',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.cjs',
  'node_modules/some-pkg/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/lib/.claude/loader.js',
  'node_modules/@scope/skills/index.js',
  'node_modules/skills-lib/dist/index.js',
];

/** Agent docs at a package root, scoped, unscoped, and nested. */
const AGENT_DOC_ENTRIES = [
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/dotenv/skills/dotenvx/references/usage.md',
  'node_modules/thread-stream/.claude/settings.json',
  'node_modules/some-pkg/.agents/skills/guide/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/references/example.md',
  'node_modules/@scope/pkg/skills/guide.md',
  'node_modules/outer/node_modules/inner/skills/guide/SKILL.md',
  'node_modules/outer/node_modules/@scope/inner/.claude/commands/run.md',
  'node_modules/@outer/pkg/node_modules/inner/framework-skills/setup/SKILL.md',
  'node_modules/some-pkg/docs/SKILL.md',
];

let clean: CleanMcpbModule;
let lint: LintPackagingModule;

beforeAll(async () => {
  clean = await import(new URL('../../scripts/clean-mcpb.ts', import.meta.url).href);
  lint = await import(new URL('../../scripts/lint-packaging.ts', import.meta.url).href);
});

describe('bundle agent-doc matcher', () => {
  it('keeps runtime skills modules nested inside a package', () => {
    expect(clean.filterAgentDocEntries(RUNTIME_ENTRIES)).toEqual([]);
    expect(RUNTIME_ENTRIES.filter((entry) => lint.AGENT_DOC_ENTRY.test(entry))).toEqual([]);
  });

  it('strips agent-doc trees at a package root, scoped, unscoped, and nested', () => {
    expect(clean.filterAgentDocEntries(AGENT_DOC_ENTRIES)).toEqual(AGENT_DOC_ENTRIES);
    expect(AGENT_DOC_ENTRIES.filter((entry) => lint.AGENT_DOC_ENTRY.test(entry))).toEqual(
      AGENT_DOC_ENTRIES,
    );
  });

  it('selects only the agent docs from a mixed listing', () => {
    expect(clean.filterAgentDocEntries([...RUNTIME_ENTRIES, ...AGENT_DOC_ENTRIES])).toEqual(
      AGENT_DOC_ENTRIES,
    );
  });

  it('keeps the cleaner and the packaging check on the same pattern', () => {
    expect(lint.AGENT_DOC_ENTRY.source).toBe(clean.AGENT_DOC_ENTRY.source);
    expect(lint.AGENT_DOC_ENTRY.flags).toBe(clean.AGENT_DOC_ENTRY.flags);
  });

  it('passes a cleaned bundle that still holds the SDK runtime skills modules', () => {
    expect(lint.checkBundleEntries([...RUNTIME_ENTRIES, 'dist/index.js'], 'bundle')).toEqual([]);
  });

  it('flags a bundle that still holds package-root agent docs', () => {
    const errors = lint.checkBundleEntries(AGENT_DOC_ENTRIES, 'bundle');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${AGENT_DOC_ENTRIES.length} node_modules agent-doc entries`);
  });
});
