# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-07-30 · 🛡️ Security

WSDOT access code no longer leaks into error payloads (#27); a bad access code now surfaces as its own non-retryable `invalid_access_code` reason instead of a generic `api_unavailable` or bare HTTP 400 (#28); mcp-ts-core ^0.11.0 maintenance.

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-07-11

Ferry default trip date tracks Washington/Pacific local time, not UTC (#16); vessel-location `content[]` coordinates render at full precision to match `structuredContent` (#21); `wsdot_get_ferry_routes` docs corrected to its real route ID/abbreviation/description output (#19).

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-07-11

Camera and alert route normalization, camera pagination, and zero-result content fixes (#17, #18, #20); mcp-ts-core ^0.10.14 maintenance with Socket supply-chain scanning.

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-06-20

mcp-ts-core ^0.10.9 maintenance — floating-specifier devcheck guard, re-synced scripts and skills

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-06-12

mcp-ts-core ^0.10.6 adoption, hyphenated display identity, MCPB bundle cleaner, Dockerfile healthcheck

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-06-08

Traffic WCF date decoding, mountain pass elevation/restrictions, ferry 4xx handling, and schema description fixes

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-06-08

Traffic data fixes — toll rates now return actual amounts, alerts and cameras filter the active feed client-side

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-06-04

Ferry error handling — invalid date and terminal pair errors now surface structured reasons via ctx.fail; remainingOnly ignored for future dates

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-02

mcp-ts-core 0.9.21 — per-request log context fix, secret scrubbing in fetchWithTimeout, withRetry fail-fast on non-retryable errors

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-30

Enrichment adoption — all twelve tools surface result counts, applied filters, and empty-result guidance via typed enrichment block

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-28

@cyanheads/mcp-ts-core ^0.9.7 → ^0.9.13; dep refresh; error code corrections; landing requireAuth

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-23

Add hosted server endpoint metadata — remotes block in server.json, public URL in README

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-23

Fix all 6 traffic tools returning empty arrays, fix ferry routes field mapping, package.json standardization

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-23

WSDOT Traveler Information — 12 tools for WA traffic, ferries, mountain passes, toll rates, and border crossings

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-23

Initial release — 12 WSDOT tools for WA traffic and WSF ferry data
