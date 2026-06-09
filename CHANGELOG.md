# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
