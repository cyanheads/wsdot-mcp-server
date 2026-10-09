<div align="center">
  <h1>@cyanheads/wsdot-mcp-server</h1>
  <p><b>Query WA highway conditions, ferry schedules, vessel locations, toll rates, border waits, and alerts via MCP. STDIO or Streamable HTTP.</b>
  <div>12 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/wsdot-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/wsdot-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/wsdot-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

- No input — current conditions for all 16 WA mountain passes (Snoqualmie, Stevens, White, Blewett, Cayuse, and others) in one call
- Each pass carries road condition, weather, temperature, elevation, and up to two directional traction/travel restrictions

---

### `wsdot_search_alerts` <sub>tool</sub>

- Optional `stateRoute`, `region` (Northwest, Olympic, Southwest, South Central, North Central, Eastern), and `startMilepost` / `endMilepost` — an alert matches when its extent overlaps the range; omit all for every statewide alert. Ordered by `alertId`, paged (default 20, max 500)
- An unknown region fails as `invalid_region` and a start above the end as `invalid_milepost_range`, each with a recovery hint

---

### `wsdot_get_travel_times` <sub>tool</sub>

- Optional `route` — a route (`"I-5"`, `"SR 520"`) returns every corridor measured on it, any other text matches corridor names (`"Everett"`); paged (default 50, max 500)
- Each corridor reports current and average minutes — current above average means congestion, and the delta is the delay. A reversible express-lane corridor closed in the queried direction omits its figures rather than reporting zero

---

### `wsdot_get_toll_rates` <sub>tool</sub>

- Covers SR 99 (WSDOT Tunnel), SR 167 HOT Lanes, I-405 Express Lanes, the SR 509 tolled segment, and the SR 520 Bridge. Optional `stateRoute` matches the posted designation (`"I-405"`, `"SR 520"`); a route with no tolled facility returns an empty page whose notice names the tolled routes. Paged (default 50, max 500)
- Each row leads with its `startLocationName → endLocationName` segment. `stateRoute` is the feed's bare zero-padded number (`"099"`) and `travelDirection` the feed's code, which SR 99, SR 509, and SR 520 fix per facility — read direction from the segment's ends

---

### `wsdot_get_border_waits` <sub>tool</sub>

- No input — eleven lane entries in `crossings[]` across I-5 (Peace Arch), SR 543 (Pacific Highway), SR 539 (Lynden), and SR 9 (Sumas): a general-purpose and a Nexus lane at each, plus truck lanes at SR 539 and SR 543
- `crossingName` is a route code (`I5`, `SR543Trucks`) and `location.description` the readable name; a lane with no current data omits `waitTimeInMinutes`

---

### `wsdot_search_cameras` <sub>tool</sub>

- Optional `stateRoute`, `region` code (`NW`, `SW`, `OL`, `ER`, `SC`, `NC`, `OS` for the Oregon TripCheck cameras, `WA` for airport cameras), `startMilepost` / `endMilepost`, and `titleContains` (every word, any order). Ordered by `cameraId`, paged (default 50, max 500)
- Returns metadata and image URLs, not image bytes (camera images are copyright WSDOT). An unknown region fails as `invalid_region` and a reversed range as `invalid_milepost_range`

---

### `wsdot_get_ferry_terminals` <sub>tool</sub>

- No input — all 20 WSF terminals, each with its numeric ID, abbreviation, and latitude/longitude
- Resolves names ("Bainbridge Island", "Seattle") to the IDs `wsdot_get_ferry_schedule` and `wsdot_get_terminal_space` take

---

### `wsdot_get_ferry_routes` <sub>tool</sub>

- Optional `tripDate` (`YYYY-MM-DD`, default today); a date outside the range WSF has published fails as `invalid_date` stating that range
- Each route carries its ID (the `impactedRouteIds` of `wsdot_get_ferry_alerts`), abbreviation, description, and `terminalPairs` — the departing → arriving pairs `wsdot_get_ferry_schedule` accepts that day

---

### `wsdot_get_ferry_schedule` <sub>tool</sub>

- Requires `departingTerminalId` and `arrivingTerminalId` (a pair from `terminalPairs` on `wsdot_get_ferry_routes`); optional `tripDate` (default today) and `remainingOnly` (future departures only, today only)
- Each sailing carries `departureTime` / `arrivalTime` in ISO 8601 **UTC** (`tripDate` is the Pacific service day), `vesselId`, `loadingRule`, and indexes into the pair's `annotations`. There is no cancellation flag — WSF drops a cancelled sailing, so check `wsdot_get_ferry_alerts`
- A pair with no schedule that day fails as `invalid_terminal_pair` and a date with none as `invalid_date`, never as an empty schedule

---

### `wsdot_get_vessel_locations` <sub>tool</sub>

- No input — position, speed, heading, ETA, and dock status for every active WSF vessel
- Positions may lag 30–60 seconds; many fields are absent for a vessel not in service, and one between assignments reports `opRouteAbbrev` as `none reported`

---

### `wsdot_get_terminal_space` <sub>tool</sub>

- Optional `departingTerminalId` (from `wsdot_get_ferry_terminals`), else every terminal; paged by terminal (default 5, max 20), with every sailing of a returned terminal included
- `driveUpSpaceCount` is the key field — zero means the drive-up lane is full, and an oversubscribed sailing's negative upstream count floors to zero. `arrivingTerminalIds` chains into `wsdot_get_ferry_schedule`

---

### `wsdot_get_ferry_alerts` <sub>tool</sub>

- No input — active WSF disruptions, delays, and bulletins, each with `alertTitle`, a one-line `alertDescription`, and the full `bulletinText` (detail such as a replacement sailing appears only in the body)
- `impactedRouteIds` map to `wsdot_get_ferry_routes`; `affectsAllRoutes: true` marks a fleet-wide alert, whose empty route list then means every route

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

WSDOT-specific:

- Dual API integration — WSDOT Traffic API and WSF Ferry API share a single `WSDOT_ACCESS_CODE`
- Cross-tool linking built into tool descriptions — ferry tools point to `wsdot_get_ferry_terminals` / `wsdot_get_ferry_routes` for ID resolution before a lookup
- Normalized response shapes across both APIs — sparse upstream fields surface as optional rather than omitted or defaulted
- Stable pagination — the alert and camera feeds return the same set in more than one row order upstream, so results are sorted by ID to keep a given offset reproducible
- Paged list tools take `offset` / `limit`, and a page also ends early at a 24,000-byte response budget, with the notice naming the next offset
- Route filters take the forms people write — `"I-90"`, `"90"`, `"090"`, `"SR 520"` — and every text filter accepts at most 200 characters

Agent-friendly output:

- Typed failure — `invalid_access_code` and `api_unavailable` errors carry an explicit recovery hint distinguishing configuration faults from transient upstream ones
- `driveUpSpaceCount: 0` and congestion delta fields (`delayInMinutes`) give agents actionable signal without string parsing
- Plain text from HTML — alert descriptions, sailing notes, and bulletins arrive from upstream as HTML and are returned as text, with links inline as `link text (url)`
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
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result (key-name redaction only). | `false` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation (spans, metrics, completion logs). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL; traces go to `/v1/traces`, metrics to `/v1/metrics`. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in OTLP log export; the base endpoint never enables it. | — |

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
