# wsdot-mcp-server - Directory Structure

Generated on: 2026-11-12 13:10:33

```text
wsdot-mcp-server/
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
│   ├── add-skill/
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
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   └── wsdot-guide/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── get-border-waits.tool.ts
│   │       │   ├── get-ferry-alerts.tool.ts
│   │       │   ├── get-ferry-fares.tool.ts
│   │       │   ├── get-ferry-routes.tool.ts
│   │       │   ├── get-ferry-schedule.tool.ts
│   │       │   ├── get-ferry-terminals.tool.ts
│   │       │   ├── get-mountain-passes.tool.ts
│   │       │   ├── get-terminal-space.tool.ts
│   │       │   ├── get-toll-rates.tool.ts
│   │       │   ├── get-travel-times.tool.ts
│   │       │   ├── get-vessel-locations.tool.ts
│   │       │   ├── index.ts
│   │       │   ├── search-alerts.tool.ts
│   │       │   └── search-cameras.tool.ts
│   │       ├── coordinate-pair.ts
│   │       ├── ferry-trip-rejection.ts
│   │       ├── local-time.ts
│   │       └── paging.ts
│   ├── services/
│   │   ├── ferry/
│   │   │   ├── ferry-service.ts
│   │   │   └── types.ts
│   │   ├── traffic/
│   │   │   ├── route-match.ts
│   │   │   ├── stable-order.ts
│   │   │   ├── traffic-service.ts
│   │   │   └── types.ts
│   │   ├── html-text.ts
│   │   ├── text-field.ts
│   │   ├── wcf-date.ts
│   │   └── wsdot-http.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   ├── wsf-fares/
│   │   │   ├── farelineitems-1-10-oneway.json
│   │   │   ├── farelineitems-1-10-roundtrip.json
│   │   │   ├── farelineitems-10-1-oneway.json
│   │   │   ├── farelineitems-3-7-oneway.json
│   │   │   ├── farelineitems-7-3-oneway.json
│   │   │   └── farelineitems-7-3-roundtrip.json
│   │   └── wsf-schedule/
│   │       ├── schedule-2026-11-11-7-3.json
│   │       ├── schedule-2026-11-13-22-20.json
│   │       ├── schedule-2026-11-14-22-20.json
│   │       ├── schedule-2026-11-14-7-3.json
│   │       ├── schedule-2026-11-15-7-3.json
│   │       └── scheduletoday-2026-11-12-7-3-true.json
│   ├── helpers/
│   │   ├── assertions.ts
│   │   ├── pagination.ts
│   │   ├── timing.ts
│   │   ├── wsf-fares.ts
│   │   └── wsf-schedule.ts
│   ├── prompts/
│   ├── resources/
│   ├── scripts/
│   │   └── mcpb-runtime.test.ts
│   ├── security/
│   │   └── security.test.ts
│   ├── services/
│   │   ├── ferry-service.test.ts
│   │   ├── html-text.test.ts
│   │   ├── route-match.test.ts
│   │   ├── stable-order.test.ts
│   │   ├── text-field.test.ts
│   │   ├── traffic-service.test.ts
│   │   └── wcf-date.test.ts
│   └── tools/
│       ├── blank-string-wire.test.ts
│       ├── coordinate-pair.test.ts
│       ├── ferry-fares.test.ts
│       ├── ferry-tools.test.ts
│       ├── ferry-trip-rejection.test.ts
│       ├── ferry-wire.test.ts
│       ├── input-strictness.test.ts
│       ├── local-time.test.ts
│       ├── markdown-parity.test.ts
│       ├── paging.test.ts
│       ├── traffic-filters-upstream.test.ts
│       ├── traffic-paging.test.ts
│       └── traffic-tools.test.ts
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
├── mcp.json
├── package.json
├── plugin.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
