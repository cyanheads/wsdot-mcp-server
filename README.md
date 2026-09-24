<div align="center">
  <h1>@cyanheads/wsdot-mcp-server</h1>
  <p><b>Query WA highway conditions, ferry schedules, vessel locations, toll rates, border waits, and alerts via MCP. STDIO or Streamable HTTP.</b>
  <div>12 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/wsdot-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/wsdot-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/wsdot-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/wsdot-mcp-server/releases/latest/download/wsdot-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=wsdot-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvd3Nkb3QtbWNwLXNlcnZlciJdLCJlbnYiOnsiV1NET1RfQUNDRVNTX0NPREUiOiJ5b3VyLWFjY2Vzcy1jb2RlIn19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22wsdot-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fwsdot-mcp-server%22%5D%2C%22env%22%3A%7B%22WSDOT_ACCESS_CODE%22%3A%22your-access-code%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

**Public Hosted Server:** [https://wsdot.caseyjhand.com/mcp](https://wsdot.caseyjhand.com/mcp)

</div>

---

## Overview

Washington State transportation data from the WSDOT Traveler API and the WSF Ferry API. Query mountain pass and highway conditions, search alerts and cameras, and track ferry schedules, vessel locations, and terminal space from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `wsdot_get_mountain_passes` | Current conditions for all WA mountain passes: status, road condition, traction laws, temperature, elevation. |
| `wsdot_search_alerts` | Active highway alerts — incidents, construction, closures — filterable by state route, WSDOT region, and milepost range. |
| `wsdot_get_travel_times` | Current vs. average travel times for named WA highway corridors (I-5, I-90, SR 520, etc.) with congestion delay. |
| `wsdot_get_toll_rates` | Dynamic toll rates for WA express lanes and tolled facilities — SR 99, SR 167 HOT, I-405 Express, SR 509, SR 520 — filterable by route. |
| `wsdot_get_border_waits` | Current vehicle wait times at all WA/Canada land border crossings. |
| `wsdot_search_cameras` | Highway camera metadata and image URLs, filterable by state route, region, milepost range, and title words. |
| `wsdot_get_ferry_terminals` | All WSF ferry terminals with numeric IDs needed for schedule and space lookups, plus coordinates. |
| `wsdot_get_ferry_routes` | WSF routes operating on a given date — route ID, abbreviation, description, and the terminal pairs each serves, for route discovery, schedule lookups, and ferry-alert cross-reference. |
| `wsdot_get_ferry_schedule` | Departure times for a specific WSF route — today-remaining or full-day future mode — with each sailing's vessel, loading rule, and notes. |
| `wsdot_get_vessel_locations` | Real-time AIS positions, speed, heading, ETA, and dock status for all active WSF vessels. |
| `wsdot_get_terminal_space` | Drive-up and reservable vehicle space available at WSF terminals for upcoming sailings. |
| `wsdot_get_ferry_alerts` | Active WSF service disruptions and bulletins with impacted route IDs. |

## Capability reference

### `wsdot_get_mountain_passes` <sub>tool</sub>

- No input parameters — returns current conditions for all 16 WA mountain passes (Snoqualmie, Stevens, White, Blewett, Cayuse, and others) in one call
- Fields include road condition, weather, temperature, elevation, and up to two directional traction/travel restrictions
- Use for "is the pass open?", traction-law checks, or winter driving planning

---

### `wsdot_search_alerts` <sub>tool</sub>

- Filter by state route — natural forms all work: `"I-90"`, `"90"`, `"090"`, or `"SR 520"` / `"520"`
- Filter by WSDOT region name: Northwest, Olympic, Southwest, South Central, North Central, Eastern (case-insensitive; any other value is rejected with `invalid_region`)
- Filter by milepost range to scope to a corridor — an alert matches when its extent overlaps the range, so a closure that spans the boundary is returned. Either bound may be given alone; a start above the end is rejected with `invalid_milepost_range`
- Omit all filters to return all current statewide alerts; `stateRoute` and `region` accept at most 200 characters
- Descriptions are normalized to plain text; a link renders inline as `link text (url)`
- Results ordered by `alertId` and paged (default 20, max 500) — pass `offset`/`limit`; a page also ends early at a 24,000-byte response budget, and the notice reports the next offset

---

### `wsdot_get_travel_times` <sub>tool</sub>

- Covers I-5, I-90, SR 520, SR 99, I-405, SR 167, and others
- Filter by route (`"I-5"`, `"5"`, `"SR 520"`) to get every corridor measured on it, or by any text to match corridor names (`"Everett"`); `route` accepts at most 200 characters
- When current time exceeds average, the corridor is congested; the delta is the delay
- Reversible express-lane corridors report no travel time while closed in the queried direction — those figures are omitted rather than reported as zero minutes
- Results are paged (default 50, max 500) — pass `offset`/`limit`; a page also ends early at a 24,000-byte response budget, and the notice reports the next offset

---

### `wsdot_get_toll_rates` <sub>tool</sub>

- Covers SR 99 (WSDOT Tunnel), SR 167 HOT Lanes, I-405 Express Lanes, the SR 509 tolled segment, and the SR 520 Bridge
- Rates are time-banded and change dynamically based on traffic conditions
- Filter to one facility with `stateRoute` — `"SR 520"`, `"520"`, `"0520"`, `"I-405"`, and `"405"` all work, matched against the posted designation, so `"SR 405"` matches nothing. A route with no tolled facility returns an empty page whose notice names the tolled routes; the filter (at most 200 characters) is applied before paging and echoed in `appliedFilters`
- Each row's `stateRoute` is the bare, zero-padded route number the feed carries (`"099"`, `"405"`) with no route type; the rendered text resolves the posted designation, so I-405 reads as `I-405` rather than `SR 405`
- `travelDirection` is the feed's code, not the direction of travel: SR 99, SR 509, and SR 520 carry one fixed code per facility although trips run both ways — read direction from the segment's start and end
- Each entry leads with its readable `startLocationName → endLocationName` segment; the opaque upstream trip key stays available as `tripName`
- Results are paged (default 50, max 500) — pass `offset`/`limit`; a page also ends early at a 24,000-byte response budget, and the notice reports the next offset

---

### `wsdot_get_border_waits` <sub>tool</sub>

- No input parameters — covers I-5 (Peace Arch, Blaine), SR 543 (Pacific Highway, Blaine), SR 539 (Lynden), and SR 9 (Sumas)
- Each crossing reports a general-purpose lane and a Nexus lane; SR 539 adds a truck lane and SR 543 adds truck and FAST truck lanes — eleven entries in `crossings[]`, one per lane
- `crossingName` is a route code (e.g. `I5`, `SR543Trucks`); `location.description` holds the readable name
- Wait times in minutes; `updateTime` is ISO 8601. A crossing reporting no current data is still returned — only `waitTimeInMinutes` is omitted, and the rendered text reads `Not available`

---

### `wsdot_search_cameras` <sub>tool</sub>

- Filter by state route (`"I-90"`, `"90"`, `"SR 520"`, or `"520"` all work), WSDOT region code, milepost range, or words in the camera title; `stateRoute`, `region`, and `titleContains` accept at most 200 characters
- Camera road names carry a route-type prefix, so `"SR 26"` excludes US 26 and `"US 97"` excludes US 97A; a bare `"26"` returns both
- Region codes: `NW`, `SW`, `OL`, `ER`, `SC`, `NC`, `OS` (Oregon — the TripCheck cameras around Portland), and `WA` (airport cameras plus a few ferry-terminal cameras — most ferry-terminal cameras sit in `NW` and `OL`). Case-insensitive; any other value is rejected with `invalid_region`
- `titleContains` matches the title as WSDOT wrote it — case-insensitive, every word must appear in any order — so `"Snoqualmie"` returns Snoqualmie Summit and East Snoqualmie Summit but not Hyak. Titles lead with route and milepost, so filter a route with `stateRoute`
- Either milepost bound may be given alone; a start above the end is rejected with `invalid_milepost_range`
- Returns metadata and image URLs — camera images are copyright WSDOT, not fetched as bytes
- Results are ordered by `cameraId` and paged (default 50, max 500) — pass `offset`/`limit`; a page also ends early at a 24,000-byte response budget, and the notice reports the next offset

---

### `wsdot_get_ferry_terminals` <sub>tool</sub>

- No input parameters — returns all 20 WSF ferry terminals; the list rarely changes
- Call this first to resolve human-readable names (e.g. "Bainbridge Island", "Seattle", "Kingston") to the numeric IDs required by `wsdot_get_ferry_schedule` and `wsdot_get_terminal_space`
- Each terminal also carries its abbreviation and latitude/longitude

---

### `wsdot_get_ferry_routes` <sub>tool</sub>

- Optional `tripDate` (ISO 8601 `YYYY-MM-DD`); defaults to today
- Returns each route's ID, abbreviation, and description, plus `terminalPairs`: the directed departing → arriving terminal pairs (IDs and names) the route serves that day. These are exactly the pairs `wsdot_get_ferry_schedule` accepts for that date; a route serving none carries an empty list
- Route IDs correspond to `impactedRouteIds` in `wsdot_get_ferry_alerts` — use this tool to resolve alert route IDs to route names
- A date outside the range WSF has published (before today, or past the posted schedule) returns a typed `invalid_date` error stating WSF's range. A date inside that range with no sailings loaded yet returns an empty list and a notice
- The pairs cost one lookup per route, cached per date until WSF signals a schedule change; if any lookup fails, the whole call fails

---

### `wsdot_get_ferry_schedule` <sub>tool</sub>

- Requires `departingTerminalId` and `arrivingTerminalId`, both positive integers — use `wsdot_get_ferry_terminals` first, or pick a pair from `terminalPairs` on `wsdot_get_ferry_routes`
- Optional `tripDate` (defaults to today) and `remainingOnly: true` (only future departures for today; ignored for any other date, and the response then reports `remainingOnly: false`)
- Each sailing carries `vesselId` (the ID `wsdot_get_vessel_locations` reports), `loadingRule`, `vesselHandicapAccessible`, and `annotationIndexes` into the pair's `annotations`, notes such as "No interisland vehicles. Foot passenger and bikes okay." The rendered text lists each sailing's notes under it. WSF does not document `loadingRule`: 3 appears on nearly every sailing and 1 only on vehicle-restricted ones, so read the notes for the restriction itself
- `annotations` and the pair-wide `sailingNotes` arrive from WSF as HTML and are returned as plain text, with links kept as `link text (url)`
- `departureTime` and `arrivalTime` are ISO 8601 **UTC**, while `tripDate` is the Pacific service day — an evening sailing therefore carries the following UTC calendar date and will not match `tripDate`. Convert to `America/Los_Angeles` before quoting a clock time
- `arrivalTime` is populated on some routes and absent on others
- No cancellation status — WSF drops a cancelled sailing from the schedule rather than flagging it, so a listed sailing is not confirmation it will run; check `wsdot_get_ferry_alerts`, which reports disruptions at route level
- An invalid or non-through terminal pair returns a typed `invalid_terminal_pair` error rather than an empty schedule; its recovery hint points at `terminalPairs` on `wsdot_get_ferry_routes` for the same date
- A date WSF has no schedule for returns `invalid_date` instead — whether it falls outside WSF's published range or inside it with no routes loaded

---

### `wsdot_get_vessel_locations` <sub>tool</sub>

- No input parameters — fields include position, speed, heading, ETA, and dock status for every active WSF vessel
- Use for "where is the ferry now?" or checking if a specific vessel is in service
- Position data may lag 30–60 seconds; many fields are null for vessels not currently operating
- Coordinates render at full upstream AIS precision — no rounding, so both response surfaces report the same position
- A vessel between assignments reports an empty `opRouteAbbrev`, rendered as `none reported` rather than omitted

---

### `wsdot_get_terminal_space` <sub>tool</sub>

- Filter to a specific terminal by ID (from `wsdot_get_ferry_terminals`); omit for all terminals
- `driveUpSpaceCount` is the key field — zero means the drive-up lane is full. Oversubscribed sailings report a negative count upstream; it is floored to zero so the value never reads as available space
- `arrivingTerminalIds` lists the terminals a sailing serves and chains straight into `wsdot_get_ferry_schedule`; `itineraryLabel` is a display string that may name several stops, not a single destination
- Results are paged by terminal (default 5, max 20) — `offset`/`limit` select whole terminals and `totalCount` counts matching terminals, not sailings; every sailing of a returned terminal is included, so page size varies with how many departures each terminal carries

---

### `wsdot_get_ferry_alerts` <sub>tool</sub>

- No input parameters — active WSF ferry service disruptions, delays, and bulletins
- Each alert carries the bulletin's `alertTitle`, its one-line `alertDescription`, and the full `bulletinText` — detail such as a replacement sailing appears only in the body
- `bulletinText` is plain text: upstream authors it as HTML, and a link is rendered inline as `link text (url)`
- Each alert includes `impactedRouteIds` — cross-reference with `wsdot_get_ferry_routes` to map route IDs to names
- `affectsAllRoutes: true` marks a fleet-wide alert, which need not enumerate routes — an empty `impactedRouteIds` then means every route rather than none

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

WSDOT-specific:

- Dual API integration — WSDOT Traffic API and WSF Ferry API share a single `WSDOT_ACCESS_CODE`
- Cross-tool linking built into tool descriptions — ferry tools point to `wsdot_get_ferry_terminals` / `wsdot_get_ferry_routes` for ID resolution before a lookup
- Normalized response shapes across both APIs — sparse upstream fields surface as optional rather than omitted or defaulted
- Stable pagination — the alert and camera feeds return the same set in more than one row order upstream, so results are sorted by ID to keep a given offset reproducible

Agent-friendly output:

- Typed failure — `invalid_access_code` and `api_unavailable` errors carry an explicit recovery hint distinguishing configuration faults from transient upstream ones
- `driveUpSpaceCount: 0` and congestion delta fields (`delayInMinutes`) give agents actionable signal without string parsing
- Partial data preserved — sparse upstream payloads surface `null`/`undefined` rather than synthetic defaults (e.g. an omitted `waitTimeInMinutes`, an absent `arrivalTime`)
- `content[]` and `structuredContent` carry the same values, not just the same fields — a `false` flag, an empty list, and one populated half of a coordinate pair all render rather than dropping out of the markdown surface that some clients read; a blank or whitespace-only upstream string is absent from both, and a populated one arrives trimmed

## Getting started

### Public Hosted Instance

A public instance is available at `https://wsdot.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "wsdot-mcp-server": {
      "type": "streamable-http",
      "url": "https://wsdot.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. You'll need a WSDOT Traveler API access code — register at [wsdot.wa.gov/Traffic/api/](https://wsdot.wa.gov/Traffic/api/).

```json
{
  "mcpServers": {
    "wsdot-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/wsdot-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "WSDOT_ACCESS_CODE": "your-access-code"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "wsdot-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/wsdot-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "WSDOT_ACCESS_CODE": "your-access-code"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "wsdot-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "WSDOT_ACCESS_CODE=your-access-code",
        "ghcr.io/cyanheads/wsdot-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 WSDOT_ACCESS_CODE=your-access-code bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A WSDOT Traveler API access code. Register at [wsdot.wa.gov/Traffic/api/](https://wsdot.wa.gov/Traffic/api/) — registration is free.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/wsdot-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd wsdot-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set WSDOT_ACCESS_CODE
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `WSDOT_ACCESS_CODE` | **Required.** WSDOT Traveler API access code. Register at [wsdot.wa.gov/Traffic/api/](https://wsdot.wa.gov/Traffic/api/). | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_HOST` | HTTP server hostname. | `127.0.0.1` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin for TLS-terminating reverse-proxy deployments. | — |
| `MCP_SESSION_MODE` | Session handling: `auto`, `stateful`, or `stateless`. The schema default `auto` resolves to stateful; this server sets `stateless` explicitly. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t wsdot-mcp-server .
docker run --rm -e WSDOT_ACCESS_CODE=your-access-code -p 3010:3010 wsdot-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/wsdot-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers all 12 tools and initializes services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — 6 traffic tools, 6 ferry tools. |
| `src/services/traffic` | WSDOT Traffic API service (mountain passes, alerts, travel times, toll rates, border waits, cameras). |
| `src/services/ferry` | WSF Ferry API service (terminals, routes, schedule, vessel locations, space, alerts). |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
