# wsdot-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `wsdot_get_mountain_passes` | All WA mountain pass conditions: road status, restrictions, weather, traction laws, temp, elevation | (none — returns all ~12 passes) | `readOnlyHint: true` |
| `wsdot_search_alerts` | Highway incidents, construction, and closures filtered by route, region, or milepost range | `stateRoute?`, `region?`, `startMilepost?`, `endMilepost?`, `searchTimeStart?`, `searchTimeEnd?` | `readOnlyHint: true` |
| `wsdot_get_travel_times` | Named corridor travel times (current vs. average) for all tracked I-5/I-90/SR-520/etc. routes | (none — returns all corridors) | `readOnlyHint: true` |
| `wsdot_get_toll_rates` | Current dynamic toll rates on SR 99, SR 520, I-405, I-90, SR 167 | (none — returns all active toll rates) | `readOnlyHint: true` |
| `wsdot_get_border_waits` | Canada border crossing wait times for all WA crossings (Peace Arch, Pacific Highway, Sumas, etc.) | (none — returns all crossings) | `readOnlyHint: true` |
| `wsdot_search_cameras` | Highway camera locations and metadata URLs (no image bytes — WSDOT copyright) filtered by route or region | `stateRoute?`, `region?`, `startMilepost?`, `endMilepost?` | `readOnlyHint: true` |
| `wsdot_get_ferry_routes` | All WSF ferry routes operating on a given date with terminal pairs — use to discover which routes run and their terminal IDs when the user doesn't know the terminal names | `tripDate?` (defaults to today) | `readOnlyHint: true` |
| `wsdot_get_ferry_schedule` | Departure times for a specific ferry route on a given date, optionally filtered to remaining sailings only | `departingTerminalId`, `arrivingTerminalId`, `tripDate?`, `onlyRemainingTimes?` | `readOnlyHint: true` |
| `wsdot_get_vessel_locations` | Real-time AIS positions, speed, heading, ETA, and dock status for all active WSF vessels — use for "where is the ferry now?" or tracking a named vessel | (none — returns all vessels) | `readOnlyHint: true` |
| `wsdot_get_terminal_space` | Real-time drive-up and reservable vehicle space available at each terminal for upcoming sailings | (none — returns all terminals) | `readOnlyHint: true` |
| `wsdot_get_ferry_alerts` | Active service disruptions and bulletins across the WSF system | (none — returns all active alerts) | `readOnlyHint: true` |
| `wsdot_get_ferry_terminals` | Terminal list with IDs, names, and abbreviations — call first to resolve human-readable names (e.g. "Bainbridge Island") to numeric terminal IDs required by schedule and space tools | (none — returns all terminals) | `readOnlyHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `wsdot://passes` | All mountain pass conditions — injectable context for pass-planning tasks | No (small fixed set) |
| `wsdot://alerts/{stateRoute}` | Active alerts on a specific state route | No |
| `wsdot://ferry/terminals` | WSF terminal list with IDs and abbreviations — reference data | No |

### Prompts

None — this is a pure data/action server. The data speaks for itself and prompts wouldn't add value over direct tool calls.

---

## Overview

wsdot-mcp-server wraps the Washington State Department of Transportation (WSDOT) Traveler Information API and Washington State Ferries (WSF) API, exposing WA traffic conditions, mountain pass status, ferry schedules, real-time vessel tracking, toll rates, and border crossing wait times via MCP.

The server is entirely read-only. Target users are WA commuters, travelers, logistics agents, and trip-planning workflows that need current or scheduled state transportation data.

Both upstream APIs share a single access code (email registration, free).

---

## Requirements

- **Read-only** — no write operations, no state mutations
- **Access code required** — WSDOT API access code passed via env var, appended to every request as `?AccessCode={CODE}` (traffic) or `?apiaccesscode={CODE}` (ferries)
- **No documented rate limits** — no throttling required, but retry on transient failures
- **JSON only** — all endpoints support `AsJson` or JSON-native paths; no XML parsing
- **Camera images** — surface metadata and image URLs only; do not proxy JPEG bytes (WSDOT copyright)
- **Ferry terminal IDs** — WSF API uses numeric terminal IDs, not names; `wsdot_get_ferry_terminals` provides the lookup
- **Date format** — ferry API uses `M/D/YYYY` format in URL path segments for `TripDate`
- **No pagination** — no endpoint has pagination; all list endpoints return the complete dataset in a single response

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `TrafficApiService` | WSDOT Traffic API (`wsdot.wa.gov/Traffic/api/`) | `wsdot_get_mountain_passes`, `wsdot_search_alerts`, `wsdot_get_travel_times`, `wsdot_get_toll_rates`, `wsdot_get_border_waits`, `wsdot_search_cameras` |
| `FerryApiService` | WSDOT Ferries API (`wsdot.wa.gov/Ferries/API/`) | `wsdot_get_ferry_routes`, `wsdot_get_ferry_schedule`, `wsdot_get_vessel_locations`, `wsdot_get_terminal_space`, `wsdot_get_ferry_alerts`, `wsdot_get_ferry_terminals` |

Both services are read-only HTTP clients — no shared state beyond the access code and base URL. Init/accessor pattern: initialize once at startup, accessed via `getTrafficApiService()` / `getFerryApiService()`.

**API quirks each service must handle:**

- `TrafficApiService` — auth failure returns an HTML page (`Content-Type: text/html`, body `The supplied access code was missing or invalid.`) instead of a JSON error. The fetch layer must check `Content-Type` before attempting JSON parse; an HTML body should throw `ServiceUnavailable` with a message directing the user to verify `WSDOT_ACCESS_CODE`.
- `FerryApiService` — invalid terminal ID pairs return HTTP 200 with a JSON body `{"Message":"<human-readable error>"}` instead of a 4xx. Response handler must check for the presence of a top-level `Message` field and throw `InvalidParams` with the message text. This pattern applies to schedule endpoints; other endpoints may also use it.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `WSDOT_ACCESS_CODE` | Yes | WSDOT Traveler API access code. Register at wsdot.wa.gov/Traffic/api/. Used for both traffic and ferry endpoints. |

---

## Implementation Order

1. Config (`WSDOT_ACCESS_CODE`) and `server-config.ts`
2. `TrafficApiService` — fetch + parse helpers, shared `fetchWithTimeout` + retry wrapper
3. Traffic tools: `wsdot_get_mountain_passes`, `wsdot_get_travel_times`, `wsdot_get_border_waits`, `wsdot_get_toll_rates`
4. Traffic tools with filters: `wsdot_search_alerts`, `wsdot_search_cameras`
5. `FerryApiService` — second HTTP client, same retry pattern
6. Ferry reference tools: `wsdot_get_ferry_terminals`, `wsdot_get_ferry_routes`
7. Ferry schedule tools: `wsdot_get_ferry_schedule`, `wsdot_get_ferry_alerts`
8. Ferry real-time tools: `wsdot_get_vessel_locations`, `wsdot_get_terminal_space`
9. Resources

Each step is independently testable. Steps 2–4 can ship and be field-tested before touching the ferry API.

---

## Domain Mapping

### Traffic API — endpoints used

| Noun | Operation | Endpoint | Filter params |
|:-----|:----------|:---------|:--------------|
| MountainPass | get-all | `GET MountainPassConditionsREST.svc/GetMountainPassConditionsAsJson` | — |
| Alert | search | `GET HighwayAlertsREST.svc/SearchAlertsAsJson` | StateRoute, Region, StartingMilepost, EndingMilepost, SearchTimeStart, SearchTimeEnd |
| Alert | get-all | `GET HighwayAlertsREST.svc/GetAlertsAsJson` | — (all current alerts) |
| TravelTime | get-all | `GET TravelTimesREST.svc/GetTravelTimesAsJson` | — |
| TollRate | get-all | `GET TollRatesREST.svc/GetTollRatesAsJson` | — |
| BorderCrossing | get-all | `GET BorderCrossingsREST.svc/GetBorderCrossingsAsJson` | — |
| Camera | search | `GET HighwayCamerasREST.svc/SearchCamerasAsJson` | StateRoute, Region, StartingMilepost, EndingMilepost |
| Camera | get-all | `GET HighwayCamerasREST.svc/GetCamerasAsJson` | — |

Excluded endpoints: TrafficFlow (sensor-level speed/volume data — too granular, ~thousands of sensors; agents won't ask for FlowDataID), WeatherInformation/WeatherStations (covered by NWS for weather; road-specific weather is available but pass conditions already include temperature and road condition), BridgeClearances (CV/logistics niche, low agent value), CVRestrictions (commercial vehicles only).

### Ferry API — endpoints used

| Noun | Operation | Endpoint |
|:-----|:----------|:---------|
| Terminal | list | `GET Terminals/rest/terminalbasics` |
| Route | list-by-date | `GET Schedule/rest/routes/{TripDate}` |
| Schedule | by-terminal-pair | `GET Schedule/rest/schedule/{TripDate}/{DepartingTerminalID}/{ArrivingTerminalID}` |
| Schedule | today-remaining | `GET Schedule/rest/scheduletoday/{DepartingTerminalID}/{ArrivingTerminalID}/{OnlyRemainingTimes}` |
| Alert | list | `GET Schedule/rest/alerts` |
| VesselLocation | list-all | `GET Vessels/rest/vessellocations` |
| TerminalSailingSpace | list-all | `GET Terminals/rest/terminalsailingspace` |

Excluded: `/allsailings` (full season dump — too large, not useful per-query), `/sailings/{SchedRouteID}` (requires SchedRouteID lookup chain — use schedule-by-terminal-pair instead), `/timeadj` (time adjustment metadata — internal schedule tooling), `/vesselhistory` (historical data, not traveler-relevant), `/vesselaccommodations` (vessel amenities — low query frequency), fares API (complex multi-param structure, low agent value vs. cost of implementation; noted as v2 candidate).

---

## Tool Detail

### `wsdot_get_mountain_passes`

- **Input:** none
- **Output:** array of pass objects — `mountainPassId`, `mountainPassName`, `elevation`, `temperatureInFahrenheit?`, `weatherCondition`, `roadCondition`, `travelAdvisoryActive`, `restrictionOne?`, `restrictionTwo?`, `dateUpdated`, `latitude`, `longitude`
- **Errors:** `{ reason: 'api_unavailable', code: ServiceUnavailable, when: 'WSDOT Traffic API is unreachable or returns a non-2xx response', recovery: 'Retry in 30 seconds. If persistent, check wsdot.wa.gov.' }`
- **Notes:** `RestrictionOne`/`RestrictionTwo` are `TravelRestriction` objects with `TravelRestrictionComment` (description) and `RestrictionType` (e.g., traction law, chain requirement). Both can be null. `TemperatureInFahrenheit` is nullable (`int?`). Always return all passes (small fixed set, ~12); no point in filtering.

### `wsdot_search_alerts`

- **Input:** `stateRoute?` (string — natural forms `"I-90"`/`"90"`/`"090"`/`"SR 520"`/`"520"` normalized to the canonical route number, matched exactly so `"90"` never substring-hits `"SR 290"`), `region?` (string enum of WSDOT regions: `Northwest`, `Olympic`, `Southwest`, `South Central`, `North Central`, `Eastern`), `startMilepost?` (number), `endMilepost?` (number)
- **Routing decision:** When `stateRoute` or `region` is provided, use `SearchAlertsAsJson` (filtered). When neither is provided, use `GetAlertsAsJson` (all current alerts). The search endpoint also accepts `SearchTimeStart` / `SearchTimeEnd` but this adds complexity for marginal benefit — omit for v1.
- **Output:** array of alert objects — `alertId`, `headlineDescription`, `extendedDescription?`, `eventCategory`, `eventStatus`, `priority`, `region`, `county?`, `startRoadwayLocation` (roadName, direction, milepost, lat/lng), `endRoadwayLocation?`, `startTime?`, `endTime?`, `lastUpdatedTime?`
- **Errors:** `api_unavailable`

### `wsdot_get_travel_times`

- **Input:** `route?` (string, convenience text filter applied client-side on the Name field — e.g., `"I-5"`, `"SR 520"`)
- **Output:** array of corridor objects — `travelTimeId`, `name`, `description`, `currentTime` (minutes), `averageTime` (minutes), `timeUpdated`, `distance` (miles), `startPoint` (roadName, direction, milepost), `endPoint` (roadName, direction, milepost)
- **Notes:** `currentTime > averageTime` indicates congestion. Include delay minutes (`currentTime - averageTime`) in `format()` for readability.

### `wsdot_get_toll_rates`

- **Input:** none
- **Output:** array of toll rate objects. The upstream `GetTollRatesAsJson` returns current dynamic rates; field names are confirmed from WSDL (`TollRates.svc?wsdl`) — likely `TripName`, `StateRoute`, `TollTable` (with rate tiers by vehicle class and time of day). Include `startTime`/`endTime` or equivalent rate-effective-period fields when present — dynamic tolls are time-banded and an agent needs to know which band is currently active. Mark nullable fields as optional in Zod schema after field-testing.
- **Notes:** Field schema uncertain without live access. Build output schema defensively — prefer optional fields. **Critical:** confirm the presence of an `updateTime` or rate-effective-period field during field-test; without it the LLM cannot communicate when the quoted rate applies or expires. See field-test blockers.

### `wsdot_get_border_waits`

- **Input:** none
- **Output:** array — `crossingName`, `waitTime` (minutes), `updateTime`, `borderCrossingLocation` (roadName, direction, milepost, lat/lng)
- **Notes:** `WaitTime` is `int` (minutes). All WA/Canada land crossings included.

### `wsdot_search_cameras`

- **Input:** `stateRoute?` (natural route forms, normalized like alerts), `region?`, `startMilepost?`, `endMilepost?`, `offset?`/`limit?` (pagination — default limit 50, max 500)
- **Routing:** Use `SearchCamerasAsJson` when any filter provided; use `GetCamerasAsJson` otherwise. The full filtered set is paged in the tool handler (`offset`/`limit`) so `structuredContent` and `content[]` carry the identical page; `totalCount`/`nextOffset`/`hasMore` disclose the full match count and continuation.
- **Output:** array of camera objects — `cameraId`, `title`, `description?`, `imageUrl`, `imageWidth?`, `imageHeight?`, `roadName?`, `direction?`, `milepost?`, `region?`, `latitude?`, `longitude?`
- **Notes:** Image URLs point to WSDOT-hosted JPEGs. Surface URLs only; do not proxy bytes. Add a note in the description that images are copyrighted by WSDOT.

### `wsdot_get_ferry_terminals`

- **Input:** none
- **Output:** array — `terminalId`, `terminalName`, `terminalAbbrev`, `latitude?`, `longitude?`
- **Notes:** Required reference step before calling schedule tools — agents need terminalIds. Small stable set (~22 terminals). Consider caching in `ctx.state` with a 24h TTL since this rarely changes.

### `wsdot_get_ferry_routes`

- **Input:** `tripDate?` (ISO 8601 string, defaults to today if omitted — converted internally to `M/D/YYYY`)
- **Output:** array of route objects — `routeId`, `routeName`, `crossingTime?`, `departingTerminalId`, `departingTerminalName`, `arrivingTerminalId`, `arrivingTerminalName`
- **Notes:** Use `GET Schedule/rest/routes/{TripDate}`. The primary value here is `departingTerminalId` / `arrivingTerminalId` — these are the inputs needed for `wsdot_get_ferry_schedule` and `wsdot_get_terminal_space`. `routeId` is included for completeness but no current tool takes it as input; it may be useful for cross-referencing `wsdot_get_ferry_alerts`' `impactedRouteIds`. Verify during field-test whether `routeId` values match alert `impactedRouteIds`.
- **Ferry alerts cross-reference:** `wsdot_get_ferry_alerts` returns `impactedRouteIds[]` as integers; agents can correlate these against `routeId` values from this tool to get human-readable route names.

### `wsdot_get_ferry_schedule`

- **Input:** `departingTerminalId` (number), `arrivingTerminalId` (number), `tripDate?` (ISO 8601 string, defaults to today), `remainingOnly?` (boolean, default false — when true uses `scheduletoday` endpoint filtering to future sailings only)
- **Routing:** When `tripDate` is today and `remainingOnly` is true, use `GET Schedule/rest/scheduletoday/{DepartingTerminalID}/{ArrivingTerminalID}/true`. When `tripDate` is today and `remainingOnly` is false, use `scheduletoday/.../false`. When `tripDate` is a future date, use `GET Schedule/rest/schedule/{TripDate}/{DepartingTerminalID}/{ArrivingTerminalID}`.
- **Output:** `routeName`, `departingTerminalName`, `arrivingTerminalName`, `tripDate`, `sailings` array (each: `departureTime`, `arrivalTime?`, `isCancelled?`, `vesselName?`)
- **Notes:** The `scheduletoday` endpoint directly returns remaining times — use it for today's queries. The standard `schedule` endpoint for date lookups. `arrivingTerminalId` 0 is sometimes valid for routes with single arrivals.

### `wsdot_get_vessel_locations`

- **Input:** none
- **Output:** array of vessel objects — `vesselId`, `vesselName`, `inService`, `atDock`, `departingTerminalId?`, `departingTerminalName?`, `arrivingTerminalId?`, `arrivingTerminalName?`, `latitude?`, `longitude?`, `speed?`, `heading?`, `leftDock?`, `eta?`, `scheduledDeparture?`, `opRouteAbbrev[]`, `timestamp`
- **Notes:** This is the richest real-time endpoint — AIS-quality position data + schedule linkage. `AtDock: true` means the vessel is in port. `Eta` is the model-predicted arrival time. Many fields null for vessels not currently operating. `timestamp` is the AIS data freshness indicator — include it in `format()` so the LLM can communicate data age (positions may lag by 30–60 seconds). Apply same timezone handling as other ferry DateTime fields (see Known Limitations).

### `wsdot_get_terminal_space`

- **Input:** `departingTerminalId?` (filter to a specific terminal)
- **Output:** per-terminal array, each with `terminalId`, `terminalName`, `departingSpaces` (array of upcoming sailings with `departure` (DateTime string — apply same timezone handling as other ferry DateTime fields), `isCancelled?`, `vesselName`, `arrivingTerminal`, `driveUpSpaceCount?`, `reservableSpaceCount?`, `maxSpaceCount`)
- **Notes:** This is the "will I make the ferry?" tool. `DriveUpSpaceCount` is the key field. Color fields (`DriveUpSpaceHexColor`) are for rendering; include them but they're optional in `format()`. During field-test, verify `departure` DateTime format and whether it includes a timezone offset (see ferry timezone Known Limitation).

### `wsdot_get_ferry_alerts`

- **Input:** none
- **Output:** array of alert objects — `alertId?`, `alertDescription`, `impactedRouteIds[]`, `publishDate?`, `expireDate?`
- **Notes:** Uses `GET Schedule/rest/alerts`. Alert structure is less documented than traffic alerts; treat most fields as optional. `impactedRouteIds` are integers matching the `routeId` values from `wsdot_get_ferry_routes` — cross-reference to get human-readable route names. In `format()`, include route IDs alongside the description so the LLM can offer follow-up lookups.

---

## Workflow Analysis

### "Is Snoqualmie Pass open right now?"
1. `wsdot_get_mountain_passes` — returns all passes; agent filters for Snoqualmie Pass by name

### "When's the next ferry from Bainbridge to Seattle?"
1. `wsdot_get_ferry_terminals` — resolve "Bainbridge Island" → terminalId (or cache; it's ID 3)
2. `wsdot_get_ferry_schedule` (departingTerminalId=3, arrivingTerminalId=7, remainingOnly=true) — today's remaining times

Or in a single step for known IDs:
1. `wsdot_get_ferry_schedule` directly if agent already has terminal IDs

### "Will I make the 3pm Bainbridge sailing?"
1. `wsdot_get_terminal_space` — check `driveUpSpaceCount` for the 3pm departure from terminal 3

### "Any incidents on I-5 near Seattle?"
1. `wsdot_search_alerts` (stateRoute="005", region="Northwest")

### "What's the toll on SR 520 right now?"
1. `wsdot_get_toll_rates` — filter result to SR 520

### "How long is the I-5 commute from Northgate to downtown?"
1. `wsdot_get_travel_times` (route="I-5") — filter for corridor matching Northgate → downtown

### "Border wait time at Peace Arch?"
1. `wsdot_get_border_waits` — filter result to Peace Arch crossing

### "Where is the Yakima now?" (vessel tracking)
1. `wsdot_get_vessel_locations` — filter by vesselName

---

## Design Decisions

**1. Unified `wsdot_` prefix, not split `wsdot_traffic_` / `wsdot_ferry_`.**
A five-segment name (`wsdot_traffic_get_toll_rates`) adds noise without disambiguation value — the noun already makes the domain clear. Agents scan the full list; a unified prefix groups the server's tools naturally. The two API surfaces are an implementation detail.

**2. Mountain passes: return all, no filtering.**
~12 passes total. An agent asking "are any passes closed?" benefits from the full set; an agent asking about Snoqualmie specifically filters client-side. No filter parameter reduces surface area with no loss of functionality.

**3. Travel times: return all with optional client-side text filter.**
WSDOT's `GetTravelTimesAsJson` returns all corridors in one call. There's no server-side filter. A `route?` convenience parameter (e.g., `"I-5"`) lets the LLM narrow by corridor name without multiple round-trips. All corridors is ~40 rows — not a large payload.

**4. `wsdot_get_ferry_terminals` as explicit reference step, not hidden lookup.**
Terminal IDs are opaque integers that agents won't know. Rather than silently resolving names to IDs inside other tools (which would require name-matching heuristics and double API calls), expose a cheap reference lookup. The terminal list is small (~22) and mostly static. Agents that call schedule tools repeatedly can carry terminal IDs from a single prior `get_ferry_terminals` call.

**5. `wsdot_get_ferry_schedule` unified under one tool, not split by today/future.**
The `scheduletoday` and `schedule` endpoints return the same logical data for different date-access patterns. Exposing both as one tool with `tripDate` and `remainingOnly` parameters avoids asking the agent to know which endpoint to use. The routing logic lives in the handler.

**6. Traffic flow sensor data excluded.**
The `GetTrafficFlowsAsJson` endpoint returns per-sensor readings (speed, volume, occupancy) across thousands of detectors identified by numeric `FlowDataID`. No WA traveler asks "what's the speed at detector 1234?" — they ask about corridors. The travel times endpoint already answers "how congested is I-5?" from the agent's perspective. Traffic flow data is sensor infrastructure, not traveler information.

**7. Fares API excluded from v1.**
The WSF Fares API is usable (auth same access code) but the query structure is complex: every fare lookup requires `TripDate`, `DepartingTerminalID`, `ArrivingTerminalID`, and `RoundTrip` path params, then parses `FareLineItems` with `FareLineItemID` references. The practical answer to "how much does it cost?" for foot passengers is a stable flat rate readily available publicly; vehicle fares vary by length and season. The tool would add significant implementation cost for a question where the answer changes infrequently and agents can give a good answer from general knowledge. Mark as v2.

**8. Camera images: URLs only.**
WSDOT's camera images are JPEG feeds with WSDOT copyright. Proxying them would raise licensing questions and add latency. The image URL is the right surface — the agent or human can follow the link.

**9. No geographic radius queries for cameras or alerts.**
The upstream API doesn't support lat/lng queries. Cameras and alerts are filtered by state route + milepost range or by WSDOT region. Geographic radius queries would require fetching all data and filtering client-side — feasible but adds complexity for a use case better served by "show me cameras on SR 90 between milepost 20 and 40".

**10. `wsdot_get_border_waits` returns all crossings.**
Only ~10 WA/Canada border crossings. No filter needed — return all and let the agent find the one the user asked about.

---

## Known Limitations

- **Access code required for most endpoints.** The ferry schedule endpoint (`scheduletoday`) validates terminal pair integrity even before auth — unknown terminal ID combos return a 200 with a JSON error message (`{"Message":"..."}`), not a 4xx. The service layer must parse this pattern.
- **Mountain pass field nullability.** `TemperatureInFahrenheit` is explicitly nullable (`int?`). `RestrictionOne`/`RestrictionTwo` may be null or empty. Zod schema must reflect this.
- **Toll rate field schema unconfirmed.** The `GetTollRatesAsJson` response shape isn't exposed in the public Doxygen docs (only referenced as a WSDL endpoint). Field names need verification at field-test time before finalizing the Zod output schema.
- **Ferry time zones.** The API returns `DateTime` values; Pacific time is implied but not guaranteed explicit. `format()` should present times without timezone assertion unless confirmed. During field-test, check if returned datetimes include a timezone offset.
- **No rate-limit documentation.** WSDOT doesn't publish rate limits. If transient 429s appear during field-test, add configurable request throttling.
- **`wsdot_get_ferry_routes` date format.** Ferry API uses `M/D/YYYY` in URL paths (e.g., `5/23/2026`). The service layer must convert from ISO 8601 input.
- **Camera response size.** `GetCamerasAsJson` (all cameras) may return hundreds of results. `format()` should cap inline display at ~20 with a count note. The full array is still in `structuredContent`.

---

## API Reference

### Traffic API

- Base: `https://www.wsdot.wa.gov/Traffic/api/`
- Auth: `?AccessCode={CODE}` query param on every request
- Format: JSON via `...AsJson` operation suffixes
- Error shape (auth failure): HTML page with `<title>Unathenticated</title>` and body text `The supplied access code was missing or invalid.` — detect by checking `Content-Type` header or parsing for this string
- No pagination; all list endpoints return complete datasets

### Ferry API

- Base: `https://www.wsdot.wa.gov/Ferries/API/`
- Auth: `?apiaccesscode={CODE}` query param (note: different param name from traffic)
- Format: JSON natively (no suffix needed on REST endpoints)
- Error shape (invalid params): `{"Message":"..."}` JSON with descriptive message — no 4xx status code
- No pagination; all list endpoints return complete datasets
- Date format in path segments: `M/D/YYYY` (no leading zeros)

---

## Decisions Log

| # | Decision | Rationale |
|:--|:---------|:----------|
| 1 | Unified `wsdot_` prefix | Five-segment names add noise; noun disambiguates domain |
| 2 | Mountain passes: no filter param | ~12 passes total; client-side filter is trivial |
| 3 | Travel times: optional text filter only | No server-side filter; text filter is a convenience wrapper |
| 4 | Ferry terminals as explicit tool | Opaque integer IDs; hidden name resolution requires heuristics and double calls |
| 5 | Unified ferry schedule tool | `scheduletoday` vs. `schedule` is an implementation detail; unified by `tripDate` + `remainingOnly` |
| 6 | Traffic flow sensor data excluded | Sensor-level data requires FlowDataID; travel times already answer congestion questions |
| 7 | Fares API excluded (v1) | Complex multi-param fare lookup; fares are stable enough that general knowledge suffices |
| 8 | Camera images: URLs only | WSDOT copyright; proxying adds latency and licensing risk |
| 9 | No geographic radius filter | Upstream API doesn't support lat/lng queries; milepost-range is the server's filter idiom |
| 10 | Border crossings: return all | ~10 crossings; no filter needed |
