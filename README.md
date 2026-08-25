<div align="center">
  <h1>@cyanheads/wsdot-mcp-server</h1>
  <p><b>Query WA highway conditions, ferry schedules, vessel locations, toll rates, border waits, and alerts via MCP. STDIO or Streamable HTTP.</b>
  <div>12 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/wsdot-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/wsdot-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/wsdot-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0+-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/wsdot-mcp-server/releases/latest/download/wsdot-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=wsdot-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvd3Nkb3QtbWNwLXNlcnZlciJdLCJlbnYiOnsiV1NET1RfQUNDRVNTX0NPREUiOiJ5b3VyLWFjY2Vzcy1jb2RlIn19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22wsdot-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fwsdot-mcp-server%22%5D%2C%22env%22%3A%7B%22WSDOT_ACCESS_CODE%22%3A%22your-access-code%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

**Public Hosted Server:** [https://wsdot.caseyjhand.com/mcp](https://wsdot.caseyjhand.com/mcp)

</div>

---

## Tools

12 tools split across two domains — traffic (WSDOT Traveler API) and ferries (WSF Ferry API):

| Tool | Description |
|:---|:---|
| `wsdot_get_mountain_passes` | Current conditions for all WA mountain passes: status, road condition, traction laws, temperature, elevation. |
| `wsdot_search_alerts` | Active highway alerts — incidents, construction, closures — filterable by state route, WSDOT region, and milepost range. |
| `wsdot_get_travel_times` | Current vs. average travel times for named WA highway corridors (I-5, I-90, SR 520, etc.) with congestion delay. |
| `wsdot_get_toll_rates` | Dynamic toll rates for WA express lanes and tolled facilities: SR 99, SR 167 HOT, I-405 Express, SR 509, SR 520. |
| `wsdot_get_border_waits` | Current vehicle wait times at all WA/Canada land border crossings. |
| `wsdot_search_cameras` | Highway camera metadata and image URLs, filterable by state route, region, and milepost range. |
| `wsdot_get_ferry_terminals` | All WSF ferry terminals with numeric IDs needed for schedule and space lookups. |
| `wsdot_get_ferry_routes` | WSF routes operating on a given date — route ID, abbreviation, and description for each, for route discovery and ferry-alert cross-reference. |
| `wsdot_get_ferry_schedule` | Departure times for a specific WSF route — today-remaining or full-day future mode. |
| `wsdot_get_vessel_locations` | Real-time AIS positions, speed, heading, ETA, and dock status for all active WSF vessels. |
| `wsdot_get_terminal_space` | Drive-up and reservable vehicle space available at WSF terminals for upcoming sailings. |
| `wsdot_get_ferry_alerts` | Active WSF service disruptions and bulletins with impacted route IDs. |

### `wsdot_get_mountain_passes`

Current road conditions for all WA mountain passes.

- Covers all 16 passes: Snoqualmie, Stevens, White, Blewett, Cayuse, and others
- Fields include status (Open/Closed/Caution), road surface, active traction law, temperature, and elevation
- Use for "is the pass open?", traction law checks, or winter driving planning

---

### `wsdot_search_alerts`

Active WA highway alerts — incidents, construction, closures, restrictions.

- Filter by state route — natural forms all work: `"I-90"`, `"90"`, `"090"`, or `"SR 520"` / `"520"`
- Filter by WSDOT region: Northwest, Olympic, Southwest, South Central, North Central, Eastern
- Filter by milepost range to scope to a corridor — an alert matches when its extent overlaps the range, so a closure that spans the boundary is returned
- Omit all filters to return all current statewide alerts
- Descriptions are plain text — upstream authors them with markup, and a link is rendered inline as `link text (url)` so the destination survives
- Results are ordered by `alertId` and paged (default 50, max 500) — pass `offset`/`limit` to page through the full statewide set; the notice reports the next offset. Upstream returns the same alert set in more than one row order, so the ordering is imposed here to keep a given offset reproducible

---

### `wsdot_get_travel_times`

Current vs. average travel times for named WA highway corridors.

- Covers I-5, I-90, SR 520, SR 99, I-405, SR 167, and others
- Filter by route (`"I-5"`, `"5"`, `"SR 520"`) to get every corridor measured on it, or by any text to match corridor names (`"Everett"`)
- When current time exceeds average, the corridor is congested; the delta is the delay
- Reversible express-lane corridors report no travel time while closed in the queried direction — those figures are omitted rather than reported as zero minutes
- Results are paged (default 50, max 500) — pass `offset`/`limit` to page through the full statewide set; the notice reports the next offset

---

### `wsdot_get_toll_rates`

Current dynamic toll rates for WA tolled facilities.

- SR 99 (WSDOT Tunnel), SR 167 HOT Lanes, I-405 Express Lanes, the SR 509 tolled segment, and the SR 520 Bridge
- Rates are time-banded and change dynamically based on traffic conditions
- `stateRoute` is a bare, zero-padded route number (`"099"`, `"405"`) with no route type; the rendered text resolves the posted designation, so I-405 reads as `I-405` rather than `SR 405`
- Each entry leads with its readable `startLocationName → endLocationName` segment; the opaque upstream trip key stays available as `tripName`
- Results are paged (default 50, max 500) — pass `offset`/`limit` to page through the full statewide set; the notice reports the next offset

---

### `wsdot_get_border_waits`

Current vehicle wait times at WA/Canada land border crossings.

- Covers I-5 (Peace Arch, Blaine), SR 543 (Pacific Highway, Blaine), SR 539 (Lynden), and SR 9 (Sumas)
- Each crossing reports a general-purpose lane and a Nexus lane; SR 539 adds a truck lane and SR 543 adds truck and FAST truck lanes — eleven entries in `crossings[]`, one per lane
- `crossingName` is a route code (e.g. `I5`, `SR543Trucks`); `location.description` holds the readable name
- Wait times in minutes; `updateTime` is ISO 8601. A crossing reporting no current data is still returned — only `waitTimeInMinutes` is omitted, and the rendered text reads `Not available`

---

### `wsdot_search_cameras`

WSDOT highway camera metadata and image URLs.

- Filter by state route (`"I-90"`, `"90"`, `"SR 520"`, or `"520"` all work), WSDOT region, or milepost range
- Camera road names carry a route-type prefix, so `"SR 26"` excludes US 26 and `"US 97"` excludes US 97A; a bare `"26"` returns both
- Returns metadata and image URLs — camera images are copyright WSDOT, not fetched as bytes
- Results are ordered by `cameraId` and paged (default 50, max 500) — pass `offset`/`limit` to page through the full statewide set; the notice reports the next offset. Upstream returns the same camera set in more than one row order, so the ordering is imposed here to keep a given offset reproducible

---

### `wsdot_get_ferry_terminals`

All WSF ferry terminals with numeric IDs.

- 20 terminals; the list rarely changes
- Call this first to resolve human-readable names (e.g. "Bainbridge Island", "Seattle", "Kingston") to the numeric IDs required by `wsdot_get_ferry_schedule` and `wsdot_get_terminal_space`

---

### `wsdot_get_ferry_routes`

WSF ferry routes operating on a given date.

- Returns each route's ID, abbreviation, and description
- Route IDs correspond to `impactedRouteIds` in `wsdot_get_ferry_alerts` — use this tool to resolve alert route IDs to route names
- Use to discover which routes are running; for the numeric terminal IDs that schedule and space lookups need, call `wsdot_get_ferry_terminals`

---

### `wsdot_get_ferry_schedule`

Departure times for a specific WSF ferry route.

- Requires numeric terminal IDs — use `wsdot_get_ferry_terminals` first
- `remainingOnly: true` returns only future departures for today (useful for "next ferry" queries)
- For future dates, all sailings for that day are returned
- `departureTime` and `arrivalTime` are ISO 8601 **UTC**, while `tripDate` is the Pacific service day — an evening sailing therefore carries the following UTC calendar date and will not match `tripDate`. Convert to `America/Los_Angeles` before quoting a clock time
- `arrivalTime` is populated on some routes and absent on others
- No cancellation status — WSF drops a cancelled sailing from the schedule rather than flagging it, so a listed sailing is not confirmation it will run; check `wsdot_get_ferry_alerts`, which reports disruptions at route level

---

### `wsdot_get_vessel_locations`

Real-time AIS positions for all active WSF vessels.

- Fields include position, speed, heading, ETA, and dock status
- Use for "where is the ferry now?" or checking if a specific vessel is in service
- Position data may lag 30–60 seconds; many fields are null for vessels not currently operating
- Coordinates render at full upstream AIS precision — no rounding, so both response surfaces report the same position
- A vessel between assignments reports an empty `opRouteAbbrev`, rendered as `none reported` rather than omitted

---

### `wsdot_get_terminal_space`

Real-time vehicle space availability at WSF terminals for upcoming sailings.

- `driveUpSpaceCount` is the key field — zero means the drive-up lane is full. Oversubscribed sailings report a negative count upstream; it is floored to zero so the value never reads as available space
- `arrivingTerminalIds` lists the terminals a sailing serves and chains straight into `wsdot_get_ferry_schedule`; `itineraryLabel` is a display string that may name several stops, not a single destination
- Filter to a specific terminal by ID (from `wsdot_get_ferry_terminals`)
- Use for "will I make the ferry?" or "how full is the next sailing?" queries
- Results are paged by terminal (default 5, max 20) — `offset`/`limit` select whole terminals and `totalCount` counts matching terminals, not sailings; every sailing of a returned terminal is included, so page size varies with how many departures each terminal carries

---

### `wsdot_get_ferry_alerts`

Active WSF ferry service disruptions, delays, and bulletins.

- Each alert carries the bulletin's `alertTitle`, its one-line `alertDescription`, and the full `bulletinText` — detail such as a replacement sailing appears only in the body
- `bulletinText` is plain text: upstream authors it as HTML, and a link is rendered inline as `link text (url)`
- Each alert includes `impactedRouteIds` — cross-reference with `wsdot_get_ferry_routes` to map route IDs to names
- `affectsAllRoutes: true` marks a fleet-wide alert, which need not enumerate routes — an empty `impactedRouteIds` then means every route rather than none

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

WSDOT-specific:

- Dual API integration — WSDOT Traffic API and WSF Ferry API from a single access code
- Retry, timeout, and HTML-detection guards on all upstream requests
- Normalized response shapes across both APIs — sparse upstream fields surfaced as optional rather than omitted

Agent-friendly output:

- Cross-tool linking built into descriptions — ferry tools document which tool to call first for terminal and route ID resolution
- `driveUpSpaceCount: 0` and congestion delta fields give agents actionable signal without string parsing
- Partial data preserved — sparse upstream payloads surface `null`/`undefined` rather than synthetic defaults
- `content[]` and `structuredContent` carry the same values, not just the same fields — a `false` flag, an empty list, and one populated half of a coordinate pair all render rather than dropping out of the markdown surface that some clients read

## Getting started

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
