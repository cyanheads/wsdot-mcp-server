# wsdot-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `wsdot_get_mountain_passes` | All WA mountain pass conditions: road status, restrictions, weather, traction laws, temp, elevation | (none — returns all 16 passes) | `readOnlyHint: true` |
| `wsdot_search_alerts` | Highway incidents, construction, and closures filtered by route, region, or milepost range | `stateRoute?`, `region?`, `startMilepost?`, `endMilepost?`, `offset?`, `limit?` | `readOnlyHint: true` |
| `wsdot_get_travel_times` | Named corridor travel times (current vs. average) for all tracked I-5/I-90/SR-520/etc. routes | `route?`, `offset?`, `limit?` | `readOnlyHint: true` |
| `wsdot_get_toll_rates` | Current dynamic toll rates on SR 99, SR 167, I-405, SR 509, SR 520, optionally filtered to one route | `stateRoute?`, `offset?`, `limit?` | `readOnlyHint: true` |
| `wsdot_get_border_waits` | Canada border crossing wait times for all WA crossings (I-5 Peace Arch, SR 543 Pacific Highway, SR 539 Lynden, SR 9 Sumas) | (none — returns all crossings) | `readOnlyHint: true` |
| `wsdot_search_cameras` | Highway camera locations and metadata URLs (no image bytes — WSDOT copyright) filtered by route, region, milepost range, or title words | `stateRoute?`, `region?`, `startMilepost?`, `endMilepost?`, `titleContains?`, `offset?`, `limit?` | `readOnlyHint: true` |
| `wsdot_get_ferry_routes` | All WSF ferry routes operating on a given date — route ID, abbreviation, description, and the directed terminal pairs each serves that day (the pairs `wsdot_get_ferry_schedule` accepts), for route discovery and ferry-alert cross-reference | `tripDate?` (defaults to today) | `readOnlyHint: true` |
| `wsdot_get_ferry_schedule` | Departure times for a specific ferry route on a given date, optionally filtered to remaining sailings only, with each sailing's vessel ID, loading rule, and annotations | `departingTerminalId`, `arrivingTerminalId`, `tripDate?`, `remainingOnly?` | `readOnlyHint: true` |
| `wsdot_get_vessel_locations` | Real-time AIS positions, speed, heading, ETA, and dock status for all active WSF vessels — use for "where is the ferry now?" or tracking a named vessel | (none — returns all vessels) | `readOnlyHint: true` |
| `wsdot_get_terminal_space` | Real-time drive-up and reservable vehicle space available at each terminal for upcoming sailings | `departingTerminalId?`, `offset?`, `limit?` | `readOnlyHint: true` |
| `wsdot_get_ferry_alerts` | Active service disruptions and bulletins across the WSF system | (none — returns all active alerts) | `readOnlyHint: true` |
| `wsdot_get_ferry_terminals` | Terminal list with IDs, names, abbreviations, and coordinates — call first to resolve human-readable names (e.g. "Bainbridge Island") to numeric terminal IDs required by schedule and space tools | (none — returns all terminals) | `readOnlyHint: true` |

### Resources

None. `createApp()` registers an empty `resources` array.

Three were sketched during design — `wsdot://passes`, `wsdot://alerts/{stateRoute}`, and `wsdot://ferry/terminals` — and none were built. Each would have mirrored a tool that already returns the same data on demand, and every one of the three underlying feeds is live rather than reference data, so the injectable-context framing that justifies a resource did not hold.

### Prompts

None — this is a pure data/action server. The data speaks for itself and prompts wouldn't add value over direct tool calls.

### Enrichment

Every tool declares an `enrichment` block. `totalCount` and an optional `notice` are universal; the five paged tools add `nextOffset` (nullable) and `hasMore`, and several add a filter echo. Enrichment is a surface distinct from `output` — it reaches `structuredContent` and a trailing `content[]` block, not the tool's return value. Per-tool fields are listed under [Tool Detail](#tool-detail).

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
- **Date format** — ferry API accepts `YYYY-MM-DD` in the `TripDate` URL path segment; the service sends the validated ISO date unchanged. WSF's own error messages echo the date back as `M/D/YYYY`
- **No upstream pagination** — no endpoint paginates; every list endpoint returns the complete dataset in a single response. `wsdot_search_alerts`, `wsdot_get_travel_times`, `wsdot_get_toll_rates`, `wsdot_search_cameras`, and `wsdot_get_terminal_space` page in the tool handler instead, slicing the full fetched set so `structuredContent` and `content[]` carry the identical page
- **Format parity** — every field and enrichment value in `structuredContent` gets an explicit representation in `content[]`, including `false`, empty arrays, and one populated half of an independently-optional pair. Clients read different surfaces; a conditional that renders only the populated case makes them see different data. A blank string never reaches `format()`: the services apply one rule to every optional upstream string (`value?.trim() || undefined`, `src/services/text-field.ts`), so an empty, whitespace-only, or markup-only value is absent from both surfaces and a populated one is kept with its ends trimmed. A missing ID or name is absent too, never `0` or `'Unknown'`

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `TrafficApiService` | WSDOT Traffic API (`wsdot.wa.gov/Traffic/api/`) | `wsdot_get_mountain_passes`, `wsdot_search_alerts`, `wsdot_get_travel_times`, `wsdot_get_toll_rates`, `wsdot_get_border_waits`, `wsdot_search_cameras` |
| `FerryApiService` | WSDOT Ferries API (`wsdot.wa.gov/Ferries/API/`) | `wsdot_get_ferry_routes`, `wsdot_get_ferry_schedule`, `wsdot_get_vessel_locations`, `wsdot_get_terminal_space`, `wsdot_get_ferry_alerts`, `wsdot_get_ferry_terminals` |

Both services are read-only HTTP clients. The one piece of state either holds is `FerryApiService`'s in-memory cache of route terminal pairs (see [decision 13](#design-decisions)). Init/accessor pattern: initialize once at startup, accessed via `getTrafficApiService()` / `getFerryApiService()`.

**API quirks each service must handle:**

- `TrafficApiService` — auth failure returns an HTML page (`Content-Type: text/html`, body `The supplied access code was missing or invalid.`) instead of a JSON error. The fetch layer must check `Content-Type` before attempting JSON parse; an HTML body should throw `ServiceUnavailable` with a message directing the user to verify `WSDOT_ACCESS_CODE`.
- `FerryApiService` — schedule endpoints report a rejected request as a JSON body `{"Message":"<human-readable error>"}`, served as HTTP 400 today and historically as HTTP 200. The response handler checks both the status and a top-level `Message` field. A message of the form `The TripDate … is not valid. The valid range begins with today's date (…) and extends to the end of the most recently posted schedule (…)` is classified in the service as `invalid_date` (non-retryable) whatever the status; the schedule tool maps every other rejection to `invalid_terminal_pair`, or to `invalid_date` when the date lists no routes.

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

Each step is independently testable. Steps 2–4 can ship and be field-tested before touching the ferry API. A ninth step for resources was planned and dropped — see [Resources](#resources).

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
| Terminal | list (with coordinates) | `GET Terminals/rest/terminallocations` |
| Route | list-by-date | `GET Schedule/rest/routes/{TripDate}` |
| TerminalPair | list-by-date-and-route | `GET Schedule/rest/terminalsandmatesbyroute/{TripDate}/{RouteID}` |
| CacheFlushDate | get | `GET Schedule/rest/cacheflushdate` |
| Schedule | by-terminal-pair | `GET Schedule/rest/schedule/{TripDate}/{DepartingTerminalID}/{ArrivingTerminalID}` |
| Schedule | today-remaining | `GET Schedule/rest/scheduletoday/{DepartingTerminalID}/{ArrivingTerminalID}/{OnlyRemainingTimes}` |
| Alert | list | `GET Schedule/rest/alerts` |
| VesselLocation | list-all | `GET Vessels/rest/vessellocations` |
| TerminalSailingSpace | list-all | `GET Terminals/rest/terminalsailingspace` |

Excluded: `/validdaterange` (a TripDate rejection already states WSF's window, and a pre-check would miss in-window dates with no sailings loaded), `/terminalsandmates/{TripDate}` (every served pair in one request, but without a `RouteID` to join a pair back to its route), `/allsailings` (full season dump — too large, not useful per-query), `/sailings/{SchedRouteID}` (requires SchedRouteID lookup chain — use schedule-by-terminal-pair instead), `/timeadj` (time adjustment metadata — internal schedule tooling), `/vesselhistory` (historical data, not traveler-relevant), `/vesselaccommodations` (vessel amenities — low query frequency), fares API (complex multi-param structure, low agent value vs. cost of implementation; noted as v2 candidate).

---

## Tool Detail

Input, output, and enrichment lists below track the Zod schemas in `src/mcp-server/tools/definitions/`. `?` marks an optional field; everything else is always present. Output and enrichment are separate surfaces — enrichment never appears in a handler's return value.

Every tool declares the same two error reasons unless noted: `api_unavailable` (`ServiceUnavailable`, retryable) and `invalid_access_code` (`ConfigurationError`, not retryable).

### `wsdot_get_mountain_passes`

- **Input:** none
- **Output:** `passes[]` — `mountainPassId?`, `mountainPassName?`, `elevation?`, `temperatureInFahrenheit?`, `weatherCondition?`, `roadCondition?`, `travelAdvisoryActive?`, `restrictionOne?` (`text?`, `travelDirection?`), `restrictionTwo?` (`text?`, `travelDirection?`), `dateUpdated?`, `latitude?`, `longitude?`
- **Enrichment:** `totalCount`, `notice?`
- **Notes:** Upstream `RestrictionOne`/`RestrictionTwo` are `TravelRestriction` objects carrying `TravelRestrictionComment` and `RestrictionType`; both are flattened to `text` and `travelDirection`, and either can be absent. `TemperatureInFahrenheit` is nullable upstream. All passes are returned (small fixed set, 16 rows); no filter parameter.

### `wsdot_search_alerts`

- **Input:** `stateRoute?` (natural forms `"I-90"`/`"90"`/`"090"`/`"SR 520"`/`"520"`, matched on the route number; a route-type prefix is compared only when both sides carry one), `region?` (`Northwest`, `Olympic`, `Southwest`, `South Central`, `North Central`, `Eastern`; trimmed and case-insensitive, checked in the handler rather than by a `z.enum` so `"northwest"` stays accepted), `startMilepost?`, `endMilepost?` (either alone; start must not exceed end), `offset?`, `limit?` (default 20, max 500; a page also ends at the 24,000-byte response budget). `stateRoute` and `region` accept at most 200 characters; a blank or whitespace-only string input is treated as omitted.
- **Errors:** the two shared reasons, plus `invalid_region` (a non-blank region outside the set; recovery lists the names) and `invalid_milepost_range` (`startMilepost > endMilepost`), both `ValidationError` and raised before the upstream fetch
- **Routing:** always `GetAlertsAsJson`; `stateRoute`, `region`, and the milepost bounds filter the fetched set client-side. `SearchAlertsAsJson` (with `SearchTimeStart`/`SearchTimeEnd`) is available upstream but not used.
- **Output:** `alerts[]` — `alertId?`, `headlineDescription?`, `extendedDescription?`, `eventCategory?`, `eventStatus?`, `priority?`, `region?`, `county?`, `startRoadwayLocation?` (`roadName?`, `direction?`, `milePost?`, `latitude?`, `longitude?`), `endRoadwayLocation?` (same shape), `startTime?`, `endTime?`, `lastUpdatedTime?`
- **Enrichment:** `totalCount`, `nextOffset` (nullable), `hasMore`, `appliedFilters` (`stateRoute?`, `region?`, `startMilepost?`, `endMilepost?`), `notice?` — `appliedFilters` also renders through an `enrichmentTrailer`
- **Notes:** Milepost filtering matches by extent overlap, so an alert spanning the boundary is returned; alerts reporting no milepost are always included. Descriptions arrive as rich text upstream and are normalized to plain text with links inlined as `link text (url)`. Rows are sorted by `alertId` before paging — the feed serves one alert set in more than one row order, so an offset is only reproducible once ordering is imposed.

### `wsdot_get_travel_times`

- **Input:** `route?` (route designation matched against corridor start/end road names, plus a case-insensitive substring match on the corridor name; at most 200 characters), `offset?`, `limit?` (default 50, max 500; a page also ends at the 24,000-byte response budget)
- **Output:** `corridors[]` — `travelTimeId?`, `name?`, `description?`, `currentTimeInMinutes?`, `averageTimeInMinutes?`, `delayInMinutes?`, `timeUpdated?`, `distanceInMiles?`, `startPoint?` (`roadName?`, `direction?`, `milePost?`), `endPoint?` (same shape)
- **Enrichment:** `totalCount`, `nextOffset` (nullable), `hasMore`, `routeFilter?`, `notice?`
- **Notes:** `delayInMinutes` is computed in the handler as current minus average, and is absent when either input is. A reversible express lane closed in the queried direction reports no measurement at all — those figures are omitted rather than reported as zero. Paging is applied after the route filter, so `totalCount` counts matches rather than the whole feed.

### `wsdot_get_toll_rates`

- **Input:** `stateRoute?` (natural forms `"SR 520"`/`"520"`/`"0520"`/`"I-405"`/`"405"`, matched with `routeMatches` against each row's posted designation; at most 200 characters), `offset?`, `limit?` (default 50, max 500; a page also ends at the 24,000-byte response budget)
- **Output:** `rates[]` — `tripName?`, `stateRoute?`, `travelDirection?`, `startMilepost?`, `endMilepost?`, `tollRateInDollars?`, `message?`, `startLocationName?`, `endLocationName?`, `startLatitude?`, `startLongitude?`, `endLatitude?`, `endLongitude?`, `timeUpdated?`
- **Enrichment:** `totalCount`, `nextOffset` (nullable), `hasMore`, `appliedFilters?` (`stateRoute?`; present only when a filter applied), `notice?` — `appliedFilters` also renders through an `enrichmentTrailer`
- **Notes:** The live feed carries SR 99, SR 167, I-405, SR 509, and SR 520; there are no I-90 rows. `stateRoute` is a bare zero-padded route number with no route type (`"099"`, `"405"`), so `format()` resolves the posted designation — Washington's Interstate numbers are a fixed set and everything else is a state route. The `stateRoute` filter matches that designation rather than the bare value, so `"SR 405"` does not return the I-405 Express Lanes; it runs in the handler before paging, and a route with no tolled facility returns an empty page whose notice names the routes the feed carries. `travelDirection` is one fixed code per facility on SR 99 (`S`), SR 509 (`S`), and SR 520 (`E`) although each carries trips both ways, so it is not filterable and the direction of travel is read from the segment ends. `tripName` is an opaque upstream key (`"099tp03268"`), so the rendered heading leads with `startLocationName → endLocationName` instead.

### `wsdot_get_border_waits`

- **Input:** none
- **Output:** `crossings[]` — `crossingName?`, `waitTimeInMinutes?`, `updateTime?`, `location?` (`description?`, `roadName?`, `direction?`, `milePost?`, `latitude?`, `longitude?`)
- **Enrichment:** `totalCount`, `notice?`
- **Notes:** Eleven crossings across four routes — I-5 (Peace Arch), SR 543 (Pacific Highway), SR 539 (Lynden), SR 9 (Sumas) — each with a general-purpose and a Nexus lane, SR 539 additionally with a truck lane, and SR 543 additionally with truck and FAST truck lanes. `crossingName` is a route code (`"I5"`, `"SR543Trucks"`); the readable name is `location.description`. A crossing reporting no current data is still returned: WSDOT emits a `-1` sentinel, which is dropped, so only `waitTimeInMinutes` goes absent. Some crossings carry no `location` object at all.

### `wsdot_search_cameras`

- **Input:** `stateRoute?` (natural route forms, normalized like alerts), `region?` (`NW`, `SW`, `OL`, `ER`, `SC`, `NC`, `OS` — the Oregon TripCheck cameras around Portland — and `WA` — the airport cameras plus 8 ferry-terminal cameras, while the other ~50 ferry-terminal cameras sit in `NW` and `OL`; trimmed and case-insensitive, checked in the handler), `startMilepost?`, `endMilepost?` (either alone; start must not exceed end), `titleContains?` (case-folded strict token match over the title: every whitespace-separated word must appear), `offset?`, `limit?` (default 50, max 500; a page also ends at the 24,000-byte response budget). `stateRoute`, `region`, and `titleContains` accept at most 200 characters; a blank or whitespace-only string input is treated as omitted.
- **Routing:** always `GetCamerasAsJson`; `stateRoute`, `region`, and the milepost bounds filter the fetched set in the service, `titleContains` in the handler, and the combined set is paged in the tool handler so `structuredContent` and `content[]` carry the identical page.
- **Output:** `cameras[]` — `cameraId?`, `title?`, `description?`, `imageUrl?`, `imageWidth?`, `imageHeight?`, `roadName?`, `direction?`, `milePost?`, `region?`, `latitude?`, `longitude?`
- **Enrichment:** `totalCount`, `nextOffset` (nullable), `hasMore`, `appliedFilters` (`stateRoute?`, `region?`, `startMilepost?`, `endMilepost?`, `titleContains?`), `notice?` — `appliedFilters` also renders through an `enrichmentTrailer`
- **Errors:** the two shared reasons, plus `invalid_region` (recovery lists the codes) and `invalid_milepost_range`, both `ValidationError`
- **Title match:** `titleContains` reads the title as WSDOT wrote it, not a landmark — `"Snoqualmie"` returns Snoqualmie Summit and East Snoqualmie Summit, not Hyak in the same milepost window — and a camera with no title never matches. It covers the title only: `description` is null on nearly every camera, so matching it would add almost nothing.
- **Notes:** Image URLs point to WSDOT-hosted JPEGs; the server surfaces URLs only and never proxies bytes, and the description states the WSDOT copyright. Rows are sorted by `cameraId` before paging, for the same reproducibility reason as alerts.

### `wsdot_get_ferry_terminals`

- **Input:** none
- **Output:** `terminals[]` — `terminalId?`, `terminalName?`, `terminalAbbrev?`, `latitude?`, `longitude?`
- **Enrichment:** `totalCount`, `notice?`
- **Notes:** The reference step before either schedule or space lookup — agents need `terminalId`. Small, stable set (20 terminals). Uses `GET Terminals/rest/terminallocations`, which returns the same IDs, names, and abbreviations as `terminalbasics` in the same order, plus coordinates on every record; the address, directions, and map-link fields it also carries are not mapped.

### `wsdot_get_ferry_routes`

- **Input:** `tripDate?` (ISO 8601 `YYYY-MM-DD`, defaults to today; sent to WSF as-is)
- **Output:** `routes[]` — `routeId?`, `routeAbbrev?`, `description?`, `terminalPairs?[]` (`departingTerminalId`, `departingTerminalName?`, `arrivingTerminalId`, `arrivingTerminalName?`)
- **Enrichment:** `tripDate`, `totalCount`, `notice?`
- **Errors:** the two shared reasons, plus `invalid_date` (`ValidationError`, non-retryable) — a malformed date, or one WSF rejects as outside its published window, with WSF's range in the message
- **Notes:** Uses `GET Schedule/rest/routes/{TripDate}`, then `GET Schedule/rest/terminalsandmatesbyroute/{TripDate}/{RouteID}` once per route (at most five in flight) for `terminalPairs` — the directed pairs the route serves that date, which are exactly the pairs `wsdot_get_ferry_schedule` accepts; their union across routes is WSF's `terminalsandmates/{TripDate}` set. A route serving none carries `[]`; `terminalPairs` is absent only on a route with no `routeId` to look up with, and a pair missing either terminal ID is dropped. Pair lookups are cached per trip date and dropped when `Schedule/rest/cacheflushdate` changes, so a repeat call costs the routes request plus the flush check. Any failed lookup fails the whole call through the shared reasons — a list with one route's pairs missing would read as that route serving none. An in-window date with no sailings loaded (a season WSF has registered but not yet populated) returns `[]` with a notice that does not suggest retrying. `routeId` matches `impactedRouteIds` from `wsdot_get_ferry_alerts`, so this tool resolves alert route IDs to readable names; some seasonal, interisland, or Sidney B.C. route IDs will not appear for a given date.

### `wsdot_get_ferry_schedule`

- **Input:** `departingTerminalId`, `arrivingTerminalId` (both positive integers — WSF IDs run 1–22 — so a zero, negative, or fractional ID is an argument rejection that never reaches the upstream), `tripDate?` (defaults to today), `remainingOnly?` (default false)
- **Routing:** `GET Schedule/rest/scheduletoday/{DepartingTerminalID}/{ArrivingTerminalID}/{OnlyRemainingTimes}` for today, `GET Schedule/rest/schedule/{TripDate}/{DepartingTerminalID}/{ArrivingTerminalID}` for a future date.
- **Output:** `departingTerminalName?`, `arrivingTerminalName?`, `annotations?[]`, `sailingNotes?`, `sailings[]` (`departureTime?`, `arrivalTime?`, `vesselName?`, `vesselId?`, `loadingRule?`, `vesselHandicapAccessible?`, `annotationIndexes?[]`)
- **Enrichment:** `tripDate`, `remainingOnly` (the effective value — `false` for any date other than today, whatever was requested), `totalSailings`, `notice?`
- **Errors:** the two shared reasons, plus `invalid_terminal_pair` and `invalid_date` (both `ValidationError`; `invalid_date` non-retryable)
- **Notes:** Sailing timestamps are ISO 8601 UTC while `tripDate` is the Pacific service day, so an evening sailing carries the following UTC calendar date and will not match `tripDate`. `arrivalTime` is populated on some routes and absent on others. No cancellation status: neither schedule endpoint returns `IsCancelled` — WSF drops a cancelled sailing from the schedule instead of flagging it — so the field is not carried; route-level disruptions come from `wsdot_get_ferry_alerts`.
- **Sailing detail:** mapped from the payload the schedule request already returns — no extra request. `vesselId` is the ID `wsdot_get_vessel_locations` reports. `loadingRule` is undocumented by WSF; the description states what was observed (3 on nearly every sailing, 1 only on sailings whose annotation restricts vehicles) rather than asserting a code mapping. `Annotations` (per pair) and `SailingNotes` (per pair, set on very few) arrive as HTML and are rendered to plain text with the alert-bulletin normalizer. A blank annotation is dropped and every sailing's `annotationIndexes` is remapped onto the entries kept, so each index resolves; `format()` prints each sailing's notes, resolved to text, under it. `VesselPositionNum` (undocumented) and `Routes` (always the one route containing the pair) are not mapped; `AnnotationsIVR` is a plain-text twin of `Annotations` that drops link destinations.
- **Error mapping:** the service classifies WSF's `TripDate … is not valid` rejection (a date before WSF's Pacific service day or past its posted schedule) as `invalid_date` whatever the status, and an unregistered access code as `invalid_access_code`; the tool's catch passes both through. Every other rejection — a 200 with a `{"Message"}` body or a real 4xx — means no schedule for the pair on that date: when `routes/{TripDate}` is `[]` (an in-window date whose season has no sailings loaded, where WSF rejects every pair in the same words) it is `invalid_date`, and otherwise `invalid_terminal_pair`, whose recovery hint points at `terminalPairs` on `wsdot_get_ferry_routes` for the same date. That routes check runs only on a call that is already failing.

### `wsdot_get_vessel_locations`

- **Input:** none
- **Output:** `vessels[]` — `vesselId?`, `vesselName?`, `inService?`, `atDock?`, `departingTerminalId?`, `departingTerminalName?`, `arrivingTerminalId?`, `arrivingTerminalName?`, `latitude?`, `longitude?`, `speed?`, `heading?`, `leftDock?`, `eta?`, `scheduledDeparture?`, `opRouteAbbrev` (array, always present and sometimes empty), `timestamp?`
- **Enrichment:** `totalCount`, `notice?`
- **Notes:** The richest real-time endpoint — AIS position data plus schedule linkage. `atDock: true` means the vessel is in port; `eta` is model-predicted. Many fields are null for a vessel not currently operating, and a vessel between assignments reports an empty `opRouteAbbrev`. `timestamp` is the AIS freshness indicator and is rendered so data age is visible — positions may lag 30–60 seconds. Coordinates are rendered at full upstream precision; rounding in `format()` would give `content[]` and `structuredContent` clients different positions.

### `wsdot_get_terminal_space`

- **Input:** `departingTerminalId?` (positive integer; an unknown positive ID returns an empty page with a notice), `offset?`, `limit?` (default 5, max 20)
- **Output:** `terminals[]` — `terminalId?`, `terminalName?`, `departingSpaces[]` (`departure?`, `isCancelled?`, `vesselName?`, `arrivingTerminalIds?`, `itineraryLabel?`, `displayDriveUpSpace?`, `displayReservableSpace?`, `driveUpSpaceCount?`, `reservableSpaceCount?`, `maxSpaceCount?`, `driveUpSpaceHexColor?`)
- **Enrichment:** `totalCount`, `nextOffset` (nullable), `hasMore`, `terminalFilter?`, `notice?`
- **Notes:** The "will I make the ferry?" tool. `driveUpSpaceCount` is the key field, floored at zero — an oversubscribed sailing reports a negative count upstream. Destinations come from the upstream `ArrivalTerminalIDs` (surfaced as `arrivingTerminalIds`), not from the sibling `TerminalName`/`TerminalID`, which on multi-stop San Juan itineraries are an itinerary string and the *departing* terminal. The paging unit is the terminal, not the sailing: `offset`/`limit` select whole terminals and `totalCount` counts terminals, so page size varies with how many departures each carries. A display flag and the count it describes are independently optional — nothing guarantees a cleared flag arrives with a null count — so `format()` renders each on its own terms.

### `wsdot_get_ferry_alerts`

- **Input:** none
- **Output:** `alerts[]` — `alertId?`, `alertTitle?`, `alertDescription?`, `bulletinText?`, `alertType?`, `affectsAllRoutes?`, `impactedRouteIds` (array, always present and sometimes empty), `publishDate?`
- **Enrichment:** `totalCount`, `notice?`
- **Notes:** Uses `GET Schedule/rest/alerts`. `alertDescription` is the one-line summary shown on the route pages and falls back to the title when upstream publishes no summary; `bulletinText` is the full body, normalized from HTML with links inlined as `link text (url)`, and carries detail — a replacement sailing, for one — that appears nowhere else. `impactedRouteIds` are integers matching `routeId` from `wsdot_get_ferry_routes`. An empty `impactedRouteIds` is ambiguous on its own, so `affectsAllRoutes` disambiguates: while it is true, empty means every route rather than none.

---

## Workflow Analysis

### "Is Snoqualmie Pass open right now?"
1. `wsdot_get_mountain_passes` — returns all passes; agent filters for Snoqualmie Pass by name

### "When's the next ferry from Bainbridge to Seattle?"
1. `wsdot_get_ferry_terminals` — resolve "Bainbridge Island" → terminalId (or cache; it's ID 3)
2. `wsdot_get_ferry_schedule` (departingTerminalId=3, arrivingTerminalId=7, remainingOnly=true) — today's remaining times

Or in a single step for known IDs:
1. `wsdot_get_ferry_schedule` directly if agent already has terminal IDs

### "Which crossings run from Anacortes on Saturday?"
1. `wsdot_get_ferry_routes` (tripDate=Saturday) — the Anacortes / San Juan route's `terminalPairs` list every departing → arriving pair with service that day
2. `wsdot_get_ferry_schedule` for the chosen pair — each sailing's annotations say whether it takes vehicles

### "Will I make the 3pm Bainbridge sailing?"
1. `wsdot_get_terminal_space` — check `driveUpSpaceCount` for the 3pm departure from terminal 3

### "Any incidents on I-5 near Seattle?"
1. `wsdot_search_alerts` (stateRoute="005", region="Northwest")

### "What's the toll on SR 520 right now?"
1. `wsdot_get_toll_rates` (stateRoute="SR 520") — the SR 520 rows on one page

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
Sixteen passes total. An agent asking "are any passes closed?" benefits from the full set; an agent asking about Snoqualmie specifically filters client-side. No filter parameter reduces surface area with no loss of functionality.

**3. Travel times: return all with optional client-side text filter.**
WSDOT's `GetTravelTimesAsJson` returns all corridors in one call. There's no server-side filter. A `route?` convenience parameter (e.g., `"I-5"`) lets the LLM narrow by corridor name without multiple round-trips. The feed carries ~163 corridors, so the tool also pages.

**4. `wsdot_get_ferry_terminals` as explicit reference step, not hidden lookup.**
Terminal IDs are opaque integers that agents won't know. Rather than silently resolving names to IDs inside other tools (which would require name-matching heuristics and double API calls), expose a cheap reference lookup. The terminal list is small (20) and mostly static. Agents that call schedule tools repeatedly can carry terminal IDs from a single prior `get_ferry_terminals` call.

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
Eleven WA/Canada border crossing lanes. No filter needed — return all and let the agent find the one the user asked about.

**11. Resources dropped from the surface.**
Each of the three sketched resources duplicated a tool over a live feed, where the injectable-context case for a resource doesn't hold. See [Resources](#resources).

**12. `format()` parity covers every value, not every field.**
Rendering a field only when its value is populated leaves `content[]` silent about `false`, `[]`, and the populated half of a one-sided pair, all of which `structuredContent` still carries. Clients read one surface or the other, so a value-conditional render makes them disagree. The linter checks that each field appears somewhere; it cannot check that each *value* does, which is why the rule is written down here. A blank string is a fourth case, settled at the service boundary instead of in `format()`: `""` carries nothing beyond absence (WSDOT says "no current information" in prose where it means it), so the services drop it — whitespace-only and markup-only values with it — rather than every `format()` growing a branch to render it. It is the same rule the tools apply to a blank optional filter input.

**13. Route terminal pairs cached in memory, keyed to WSF's flush stamp.**
`wsdot_get_ferry_routes` needs one `terminalsandmatesbyroute` request per route (about ten), so the pairs are cached per trip date and route in a `Map` on the service instance. WSF lists the operation as cacheable until `Schedule/rest/cacheflushdate` changes, so every call reads that stamp (one small request) and a new stamp empties the cache. A lookup is cached only if the stamp it was fetched under is still the current one when it lands, so a call that straddles a flush cannot store pre-flush pairs under the new stamp. The data is public and identical for every caller, which is why it lives in process memory rather than tenant-scoped `ctx.state`. `terminalsandmates/{TripDate}` would answer in one request but carries no `RouteID`, so its pairs could not be attached to a route.

**14. Trip dates are judged by WSF's rejection, not a `validdaterange` pre-check.**
WSF answers a date outside its window with a message stating the range it accepts, measured from its own Pacific service day, so the service classifies that message as `invalid_date` instead of fetching `validdaterange` before every call. A window check would also miss the other case: an in-window date whose season has no sailings loaded, which WSF answers on the schedule endpoint with the same words it uses for a pair that never runs. The schedule tool separates those two by asking `routes/{TripDate}`, only on a call that is already failing.

---

## Known Limitations

- **Access code required for most endpoints.** The ferry schedule endpoint (`scheduletoday`) validates terminal pair integrity even before auth — unknown terminal ID combos return a JSON error message (`{"Message":"..."}`) — HTTP 400 today, HTTP 200 historically — so the service layer parses the body rather than relying on the status alone.
- **Mountain pass field nullability.** `TemperatureInFahrenheit` is explicitly nullable (`int?`). `RestrictionOne`/`RestrictionTwo` may be null or empty. The Zod schema reflects this — every pass field is optional, the ID and name included, and a missing one is left absent rather than filled in. `WeatherCondition` arrives as `""` on most passes and is dropped as blank.
- **Toll rate route designation.** `StateRoute` is a bare, zero-padded route number carrying no route type, so the value alone cannot say whether a row is an Interstate or a state route. `format()` resolves it against Washington's fixed set of Interstate numbers.
- **Ferry time zones.** Ferry `DateTime` values arrive as ISO 8601 UTC. Because WSF publishes schedules in Pacific time, a sailing late in the service day carries the following UTC calendar date and will not match the `tripDate` of the same response. Schema descriptions say so on every affected field; nothing converts the values.
- **No rate-limit documentation.** WSDOT doesn't publish rate limits. If transient 429s appear, add configurable request throttling.
- **Ferry trip-date window.** WSF accepts a `TripDate` from its current Pacific service day through the end of the most recently posted schedule, and a registered season can sit inside that window with no sailings loaded. The first case is recognized from WSF's rejection message, which is undocumented; if its wording changes, such a date still fails, but as `api_unavailable` from the routes tool and `invalid_terminal_pair` from the schedule tool. The trip date goes into URL paths as `YYYY-MM-DD` unchanged.
- **Camera response size.** `GetCamerasAsJson` (all cameras) returns roughly 1,700 rows. `offset`/`limit` paging in the tool handler bounds this, and both response surfaces carry the same page — `format()` does not cap independently, which would put `content[]` and `structuredContent` out of step. A full walk takes about twenty calls, because the page budget below holds a camera page to under a hundred rows even at `limit: 500`.
- **Page byte budget.** The four paged traffic tools (alerts, cameras, travel times, toll rates) end a page at `limit` or at 24,000 bytes per surface — the serialized `structuredContent` and the joined `content[]` text, enrichment included — whichever comes first. A `limit` cannot hold that ceiling alone: an alert's size follows `extendedDescription`, a field with no documented length. Rows are admitted in order and each is charged at the larger of its JSON and its rendered block (one renderer serves `format()` and the charge, so the two cannot drift), against the budget less a fixed 1,000-byte reserve for the wrapper, counters, notice, and trailer, less the bytes of the caller's echoed filters. The first row is always kept, so a row larger than the whole budget comes back alone with `nextOffset` one past it. A budget-ended page says so in its notice; `wsdot_get_terminal_space` pages whole terminals and is not budgeted. The echoed filters are capped at 200 characters in the schema (the longest live value a filter matches against is a 73-character corridor name), so the caller's own input cannot push a response past the budget. The per-call echo charge stays: a capped filter can still escape to about 1,200 JSON bytes (a control character serializes as a six-byte `\u` escape), and a camera search echoes two, which a fixed reserve would take from every page.

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
- Error shape (invalid params): `{"Message":"..."}` JSON with descriptive message — served with HTTP 400 today, HTTP 200 historically
- No pagination; all list endpoints return complete datasets
- Date format in path segments: `YYYY-MM-DD`; error messages echo dates as `M/D/YYYY`

---

## Decisions Log

| # | Decision | Rationale |
|:--|:---------|:----------|
| 1 | Unified `wsdot_` prefix | Five-segment names add noise; noun disambiguates domain |
| 2 | Mountain passes: no filter param | 16 passes total; client-side filter is trivial |
| 3 | Travel times: optional text filter only | No server-side filter; text filter is a convenience wrapper |
| 4 | Ferry terminals as explicit tool | Opaque integer IDs; hidden name resolution requires heuristics and double calls |
| 5 | Unified ferry schedule tool | `scheduletoday` vs. `schedule` is an implementation detail; unified by `tripDate` + `remainingOnly` |
| 6 | Traffic flow sensor data excluded | Sensor-level data requires FlowDataID; travel times already answer congestion questions |
| 7 | Fares API excluded (v1) | Complex multi-param fare lookup; fares are stable enough that general knowledge suffices |
| 8 | Camera images: URLs only | WSDOT copyright; proxying adds latency and licensing risk |
| 9 | No geographic radius filter | Upstream API doesn't support lat/lng queries; milepost-range is the server's filter idiom |
| 10 | Border crossings: return all | 11 crossing lanes; no filter needed |
| 11 | Resources dropped | Each duplicated a tool over a live feed; nothing to inject as static context |
| 12 | `format()` parity covers values, not just fields | `false`, `[]`, and one-sided pairs are data too; the linter only checks fields appear. A blank string is dropped at the service boundary instead — it carries nothing beyond absence |
| 13 | Route terminal pairs cached in memory until `cacheflushdate` changes | One lookup per route; public data shared by every caller; `terminalsandmates` carries no `RouteID` |
| 14 | Trip dates judged by WSF's rejection, not a `validdaterange` pre-check | The rejection already states the window; a pre-check costs a request per call and misses in-window dates with no sailings loaded |
