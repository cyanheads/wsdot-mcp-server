# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-08-25

Adopts mcp-ts-core ^0.12.3 and MCP SDK v2 — tool inputs are strict, so an argument no tool declares is rejected by name instead of dropped; the HTTP endpoint serves protocol revision 2026-07-28, advertised schemas moved to JSON Schema 2020-12, and handler logs now reach the client.

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-07-30

`content[]` now renders every `false`, empty, and independently-sparse value `structuredContent` already carried (#23); border-wait, toll-rate, and ferry-schedule descriptions corrected to match the live feeds (#33); `tests/` is typechecked (#38) and its injection assertions can now fail (#37).

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-07-30

`offset`/`limit` paging added to `wsdot_search_alerts`, `wsdot_get_travel_times`, `wsdot_get_toll_rates`, and `wsdot_get_terminal_space` (#24); `wsdot_search_alerts` and `wsdot_search_cameras` now impose a deterministic row order before paging, which changes their default result order.

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-07-30

`wsdot_search_alerts` normalizes upstream HTML in `headlineDescription`/`extendedDescription` to plain text, preserving link destinations (#22); `wsdot_get_ferry_alerts` surfaces `alertTitle`, `bulletinText`, `alertType`, and `affectsAllRoutes` (#34).

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-30 · ⚠️ Breaking

`wsdot_get_terminal_space`: negative `DriveUpSpaceCount`/`ReservableSpaceCount` now floor to zero, and `arrivingTerminalName` is replaced by `arrivingTerminalIds` (destinations) and `itineraryLabel` (display string) (#25, #31); `wsdot_get_ferry_schedule` drops `isCancelled`, which no upstream endpoint ever populated (#32).

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-07-30

Route filters compare route-type prefix and lettered suffix, so `SR 26` no longer matches US 26 and `US 97` excludes US 97A (#30); travel-times route filtering matches corridor road names, not just names (#26); the CurrentTime=0 sentinel is dropped instead of a zero-minute trip (#29); milepost filtering tests an alert extent for overlap (#35).

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
