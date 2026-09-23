# noaa-marine-mcp-server - Directory Structure

Generated on: 2026-09-23 00:16:46

```text
noaa-marine-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   ├── 0.6.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       └── noaa-marine-station.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── noaa-marine-find-stations.tool.ts
│   │           ├── noaa-marine-get-conditions.tool.ts
│   │           ├── noaa-marine-get-current-profile.tool.ts
│   │           ├── noaa-marine-get-currents.tool.ts
│   │           ├── noaa-marine-get-monthly-means.tool.ts
│   │           ├── noaa-marine-get-ocean-observations.tool.ts
│   │           ├── noaa-marine-get-tide-predictions.tool.ts
│   │           └── noaa-marine-get-water-level.tool.ts
│   ├── services/
│   │   ├── coops/
│   │   │   ├── coops-service.ts
│   │   │   ├── date-range.ts
│   │   │   ├── prediction-class.ts
│   │   │   ├── row-page.ts
│   │   │   ├── station-state.ts
│   │   │   └── types.ts
│   │   ├── ndbc/
│   │   │   ├── ndbc-service.ts
│   │   │   └── types.ts
│   │   └── geo.ts
│   └── index.ts
├── tests/
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── noaa-marine-station.resource.test.ts
│   │   └── tools/
│   │       ├── coops-date-forms.test.ts
│   │       ├── coops-throttle.test.ts
│   │       ├── noaa-marine-find-stations.tool.test.ts
│   │       ├── noaa-marine-get-conditions.tool.test.ts
│   │       ├── noaa-marine-get-current-profile.tool.test.ts
│   │       ├── noaa-marine-get-currents.tool.test.ts
│   │       ├── noaa-marine-get-monthly-means.tool.test.ts
│   │       ├── noaa-marine-get-ocean-observations.tool.test.ts
│   │       ├── noaa-marine-get-tide-predictions.tool.test.ts
│   │       └── noaa-marine-get-water-level.tool.test.ts
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   ├── coops/
│   │   │   ├── coops-service.test.ts
│   │   │   ├── date-range.test.ts
│   │   │   ├── row-page.test.ts
│   │   │   └── station-state.test.ts
│   │   └── ndbc/
│   │       └── ndbc-service.test.ts
│   ├── support/
│   │   └── coops-http.ts
│   └── tools/
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
