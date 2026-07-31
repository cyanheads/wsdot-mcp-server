# wsdot-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `wsdot_get_mountain_passes` | All WA mountain pass conditions: road status, restrictions, weather, traction laws, temp, elevation | (none — returns all 16 passes) | `readOnlyHint: true` |
| `wsdot_search_alerts` | Highway incidents, construction, and closures filtered by route, region, or milepost range | `stateRoute?`, `region?`, `startMilepost?`, `endMilepost?`, `offset?`, `limit?` | `readOnlyHint: true` |
| `wsdot_get_travel_times` | Named corridor travel times (current vs. average) for all tracked I-5/I-90/SR-520/etc. routes | `route?`, `offset?`, `limit?` | `readOnlyHint: true` |
| `wsdot_get_toll_rates` | Current dynamic toll rates on SR 99, SR 167, I-405, SR 509, SR 520 | `offset?`, `limit?` | `readOnlyHint: true` |
| `wsdot_get_border_waits` | Canada border crossing wait times for all WA crossings (I-5 Peace Arch, SR 543 Pacific Highway, SR 539 Lynden, SR 9 Sumas) | (none — returns all crossings) | `readOnlyHint: true` |
| `wsdot_search_cameras` | Highway camera locations and metadata URLs (no image bytes — WSDOT copyright) filtered by route or region | `stateRoute?`, `region?`, `startMilepost?`, `endMilepost?`, `offset?`, `limit?` | `readOnlyHint: true` |
| `wsdot_get_ferry_routes` | All WSF ferry routes operating on a given date — route ID, abbreviation, and description for each, for route discovery and ferry-alert cross-reference (numeric terminal IDs come from `wsdot_get_ferry_terminals`) | `tripDate?` (defaults to today) | `readOnlyHint: true` |
| `wsdot_get_ferry_schedule` | Departure times for a specific ferry route on a given date, optionally filtered to remaining sailings only | `departingTerminalId`, `arrivingTerminalId`, `tripDate?`, `remainingOnly?` | `readOnlyHint: true` |
| `wsdot_get_vessel_locations` | Real-time AIS positions, speed, heading, ETA, and dock status for all active WSF vessels — use for "where is the ferry now?" or tracking a named vessel | (none — returns all vessels) | `readOnlyHint: true` |
| `wsdot_get_terminal_space` | Real-time drive-up and reservable vehicle space available at each terminal for upcoming sailings | `departingTerminalId?`, `offset?`, `limit?` | `readOnlyHint: true` |
| `wsdot_get_ferry_alerts` | Active service disruptions and bulletins across the WSF system | (none — returns all active alerts) | `readOnlyHint: true` |
| `wsdot_get_ferry_terminals` | Terminal list with IDs, names, and abbreviations — call first to resolve human-readable names (e.g. "Bainbridge Island") to numeric terminal IDs required by schedule and space tools | (none — returns all terminals) | `readOnlyHint: true` |

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
- **Date format** — ferry API uses `M/D/YYYY` format in URL path segments for `TripDate`
- **No upstream pagination** — no endpoint paginates; every list endpoint returns the complete dataset in a single response. `wsdot_search_alerts`, `wsdot_get_travel_times`, `wsdot_get_toll_rates`, `wsdot_search_cameras`, and `wsdot_get_terminal_space` page in the tool handler instead, slicing the full fetched set so `structuredContent` and `content[]` carry the identical page
- **Format parity** — every field and enrichment value in `structuredContent` gets an explicit representation in `content[]`, including `false`, empty arrays, and one populated half of an independently-optional pair. Clients read different surfaces; a conditional that renders only the populated case makes them see different data

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

Input, output, and enrichment lists below track the Zod schemas in `src/mcp-server/tools/definitions/`. `?` marks an optional field; everything else is always present. Output and enrichment are separate surfaces — enrichment never appears in a handler's return value.

Every tool declares the same two error reasons unless noted: `api_unavailable` (`ServiceUnavailable`, retryable) and `invalid_access_code` (`ConfigurationError`, not retryable).

### `wsdot_get_mountain_passes`

- **Input:** none
- **Output:** `passes[]` — `mountainPassId`, `mountainPassName`, `elevation?`, `temperatureInFahrenheit?`, `weatherCondition?`, `roadCondition?`, `travelAdvisoryActive?`, `restrictionOne?` (`text?`, `travelDirection?`), `restrictionTwo?` (`text?`, `travelDirection?`), `dateUpdated?`, `latitude?`, `longitude?`
- **Enrichment:** `totalCount`, `notice?`
- **Notes:** Upstream `RestrictionOne`/`RestrictionTwo` are `TravelRestriction` objects carrying `TravelRestrictionComment` and `RestrictionType`; both are flattened to `text` and `travelDirection`, and either can be absent. `TemperatureInFahrenheit` is nullable upstream. All passes are returned (small fixed set, 16 rows); no filter parameter.

### `wsdot_search_alerts`

- **Input:** `stateRoute?` (natural forms `"I-90"`/`"90"`/`"090"`/`"SR 520"`/`"520"`, matched on the route number; a route-type prefix is compared only when both sides carry one), `region?` (`Northwest`, `Olympic`, `Southwest`, `South Central`, `North Central`, `Eastern`; case-insensitive), `startMilepost?`, `endMilepost?`, `offset?`, `limit?` (default 50, max 500)
- **Routing:** `SearchAlertsAsJson` when `stateRoute` or `region` is given, `GetAlertsAsJson` otherwise. `SearchTimeStart`/`SearchTimeEnd` are available upstream but not exposed.
- **Output:** `alerts[]` — `alertId?`, `headlineDescription?`, `extendedDescription?`, `eventCategory?`, `eventStatus?`, `priority?`, `region?`, `county?`, `startRoadwayLocation?` (`roadName?`, `direction?`, `milePost?`, `latitude?`, `longitude?`), `endRoadwayLocation?` (same shape), `startTime?`, `endTime?`, `lastUpdatedTime?`
- **Enrichment:** `totalCount`, `nextOffset` (nullable), `hasMore`, `appliedFilters` (`stateRoute?`, `region?`, `startMilepost?`, `endMilepost?`), `notice?` — `appliedFilters` also renders through an `enrichmentTrailer`
- **Notes:** Milepost filtering matches by extent overlap, so an alert spanning the boundary is returned; alerts reporting no milepost are always included. Descriptions arrive as rich text upstream and are normalized to plain text with links inlined as `link text (url)`. Rows are sorted by `alertId` before paging — the feed serves one alert set in more than one row order, so an offset is only reproducible once ordering is imposed.

### `wsdot_get_travel_times`

- **Input:** `route?` (route designation matched against corridor start/end road names, plus a case-insensitive substring match on the corridor name), `offset?`, `limit?` (default 50, max 500)
- **Output:** `corridors[]` — `travelTimeId?`, `name?`, `description?`, `currentTimeInMinutes?`, `averageTimeInMinutes?`, `delayInMinutes?`, `timeUpdated?`, `distanceInMiles?`, `startPoint?` (`roadName?`, `direction?`, `milePost?`), `endPoint?` (same shape)
- **Enrichment:** `totalCount`, `nextOffset` (nullable), `hasMore`, `routeFilter?`, `notice?`
- **Notes:** `delayInMinutes` is computed in the handler as current minus average, and is absent when either input is. A reversible express lane closed in the queried direction reports no measurement at all — those figures are omitted rather than reported as zero. Paging is applied after the route filter, so `totalCount` counts matches rather than the whole feed.

### `wsdot_get_toll_rates`

- **Input:** `offset?`, `limit?` (default 50, max 500)
- **Output:** `rates[]` — `tripName?`, `stateRoute?`, `travelDirection?`, `startMilepost?`, `endMilepost?`, `tollRateInDollars?`, `message?`, `startLocationName?`, `endLocationName?`, `startLatitude?`, `startLongitude?`, `endLatitude?`, `endLongitude?`, `timeUpdated?`
- **Enrichment:** `totalCount`, `nextOffset` (nullable), `hasMore`, `notice?`
- **Notes:** The live feed carries SR 99, SR 167, I-405, SR 509, and SR 520; there are no I-90 rows. `stateRoute` is a bare zero-padded route number with no route type (`"099"`, `"405"`), so `format()` resolves the posted designation — Washington's Interstate numbers are a fixed set and everything else is a state route. `tripName` is an opaque upstream key (`"099tp03268"`), so the rendered heading leads with `startLocationName → endLocationName` instead.

### `wsdot_get_border_waits`

- **Input:** none
- **Output:** `crossings[]` — `crossingName?`, `waitTimeInMinutes?`, `updateTime?`, `location?` (`description?`, `roadName?`, `direction?`, `milePost?`, `latitude?`, `longitude?`)
- **Enrichment:** `totalCount`, `notice?`
- **Notes:** Eleven crossings across four routes — I-5 (Peace Arch), SR 543 (Pacific Highway), SR 539 (Lynden), SR 9 (Sumas) — each with a general-purpose and a Nexus lane, SR 539 additionally with a truck lane, and SR 543 additionally with truck and FAST truck lanes. `crossingName` is a route code (`"I5"`, `"SR543Trucks"`); the readable name is `location.description`. A crossing reporting no current data is still returned: WSDOT emits a `-1` sentinel, which is dropped, so only `waitTimeInMinutes` goes absent. Some crossings carry no `location` object at all.

### `wsdot_search_cameras`

- **Input:** `stateRoute?` (natural route forms, normalized like alerts), `region?` (`NW`, `SW`, `OL`, `ER`, `SC`, `OS`, `NC`, `WA`), `startMilepost?`, `endMilepost?`, `offset?`, `limit?` (default 50, max 500)
- **Routing:** `SearchCamerasAsJson` when any filter is given, `GetCamerasAsJson` otherwise. The full filtered set is paged in the tool handler so `structuredContent` and `content[]` carry the identical page.
- **Output:** `cameras[]` — `cameraId?`, `title?`, `description?`, `imageUrl?`, `imageWidth?`, `imageHeight?`, `roadName?`, `direction?`, `milePost?`, `region?`, `latitude?`, `longitude?`
- **Enrichment:** `totalCount`, `nextOffset` (nullable), `hasMore`, `appliedFilters` (`stateRoute?`, `region?`, `startMilepost?`, `endMilepost?`), `notice?` — `appliedFilters` also renders through an `enrichmentTrailer`
- **Notes:** Image URLs point to WSDOT-hosted JPEGs; the server surfaces URLs only and never proxies bytes, and the description states the WSDOT copyright. Rows are sorted by `cameraId` before paging, for the same reproducibility reason as alerts.

### `wsdot_get_ferry_terminals`

- **Input:** none
- **Output:** `terminals[]` — `terminalId`, `terminalName`, `terminalAbbrev?`, `latitude?`, `longitude?`
- **Enrichment:** `totalCount`, `notice?`
- **Notes:** The reference step before either schedule or space lookup — agents need `terminalId`. Small, stable set (20 terminals).

### `wsdot_get_ferry_routes`

- **Input:** `tripDate?` (ISO 8601 `YYYY-MM-DD`, defaults to today; converted internally to `M/D/YYYY`)
- **Output:** `routes[]` — `routeId?`, `routeAbbrev?`, `description?`
- **Enrichment:** `tripDate`, `totalCount`, `notice?`
- **Errors:** the two shared reasons, plus `invalid_date` (`ValidationError`)
- **Notes:** Uses `GET Schedule/rest/routes/{TripDate}`. Route identity only — no terminal IDs (those come from `wsdot_get_ferry_terminals`). `routeId` matches `impactedRouteIds` from `wsdot_get_ferry_alerts`, so this tool resolves alert route IDs to readable names; some seasonal, interisland, or Sidney B.C. route IDs will not appear for a given date.

### `wsdot_get_ferry_schedule`

- **Input:** `departingTerminalId`, `arrivingTerminalId`, `tripDate?` (defaults to today), `remainingOnly?` (default false)
- **Routing:** `GET Schedule/rest/scheduletoday/{DepartingTerminalID}/{ArrivingTerminalID}/{OnlyRemainingTimes}` for today, `GET Schedule/rest/schedule/{TripDate}/{DepartingTerminalID}/{ArrivingTerminalID}` for a future date.
- **Output:** `departingTerminalName?`, `arrivingTerminalName?`, `sailings[]` (`departureTime?`, `arrivalTime?`, `vesselName?`)
- **Enrichment:** `tripDate`, `remainingOnly`, `totalSailings`, `notice?`
- **Errors:** the two shared reasons, plus `invalid_terminal_pair` and `invalid_date` (both `ValidationError`)
- **Notes:** Sailing timestamps are ISO 8601 UTC while `tripDate` is the Pacific service day, so an evening sailing carries the following UTC calendar date and will not match `tripDate`. `arrivalTime` is populated on some routes and absent on others. No cancellation status: neither schedule endpoint returns `IsCancelled` — WSF drops a cancelled sailing from the schedule instead of flagging it — so the field is not carried; route-level disruptions come from `wsdot_get_ferry_alerts`. An invalid or non-through terminal pair comes back as either a 200 with a `{"Message"}` body or a real 4xx, and both map to `invalid_terminal_pair`; an unregistered access code also returns 4xx but keeps `invalid_access_code`.

### `wsdot_get_vessel_locations`

- **Input:** none
- **Output:** `vessels[]` — `vesselId?`, `vesselName?`, `inService?`, `atDock?`, `departingTerminalId?`, `departingTerminalName?`, `arrivingTerminalId?`, `arrivingTerminalName?`, `latitude?`, `longitude?`, `speed?`, `heading?`, `leftDock?`, `eta?`, `scheduledDeparture?`, `opRouteAbbrev` (array, always present and sometimes empty), `timestamp?`
- **Enrichment:** `totalCount`, `notice?`
- **Notes:** The richest real-time endpoint — AIS position data plus schedule linkage. `atDock: true` means the vessel is in port; `eta` is model-predicted. Many fields are null for a vessel not currently operating, and a vessel between assignments reports an empty `opRouteAbbrev`. `timestamp` is the AIS freshness indicator and is rendered so data age is visible — positions may lag 30–60 seconds. Coordinates are rendered at full upstream precision; rounding in `format()` would give `content[]` and `structuredContent` clients different positions.

### `wsdot_get_terminal_space`

- **Input:** `departingTerminalId?`, `offset?`, `limit?` (default 5, max 20)
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
Rendering a field only when its value is populated leaves `content[]` silent about `false`, `[]`, and the populated half of a one-sided pair, all of which `structuredContent` still carries. Clients read one surface or the other, so a value-conditional render makes them disagree. The linter checks that each field appears somewhere; it cannot check that each *value* does, which is why the rule is written down here.

---

## Known Limitations

- **Access code required for most endpoints.** The ferry schedule endpoint (`scheduletoday`) validates terminal pair integrity even before auth — unknown terminal ID combos return a 200 with a JSON error message (`{"Message":"..."}`), not a 4xx. The service layer must parse this pattern.
- **Mountain pass field nullability.** `TemperatureInFahrenheit` is explicitly nullable (`int?`). `RestrictionOne`/`RestrictionTwo` may be null or empty. The Zod schema reflects this — every pass field but the ID and name is optional.
- **Toll rate route designation.** `StateRoute` is a bare, zero-padded route number carrying no route type, so the value alone cannot say whether a row is an Interstate or a state route. `format()` resolves it against Washington's fixed set of Interstate numbers.
- **Ferry time zones.** Ferry `DateTime` values arrive as ISO 8601 UTC. Because WSF publishes schedules in Pacific time, a sailing late in the service day carries the following UTC calendar date and will not match the `tripDate` of the same response. Schema descriptions say so on every affected field; nothing converts the values.
- **No rate-limit documentation.** WSDOT doesn't publish rate limits. If transient 429s appear, add configurable request throttling.
- **`wsdot_get_ferry_routes` date format.** Ferry API uses `M/D/YYYY` in URL paths (e.g., `5/23/2026`). The service layer converts from ISO 8601 input.
- **Camera response size.** `GetCamerasAsJson` (all cameras) returns roughly 1,700 rows. `offset`/`limit` paging in the tool handler bounds this, and both response surfaces carry the same page — `format()` does not cap independently, which would put `content[]` and `structuredContent` out of step.

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
| 12 | `format()` parity covers values, not just fields | `false`, `[]`, and one-sided pairs are data too; the linter only checks fields appear |
