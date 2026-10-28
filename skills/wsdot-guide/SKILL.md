---
name: wsdot-guide
description: Plan Washington ferry trips with wsdot_* tools when a next-sailing, vehicle-eligibility, or capacity question needs schedule, service alerts, terminal space, and vessel evidence combined.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use WSDOT's ferry tools for published sailings and current operating conditions. They do not quote fares, buy tickets, or make vehicle reservations. Highway conditions, tolls, cameras, and border waits use the other `wsdot_*` tools; they do not establish ferry service.

## Gates

- Establish the requested travel date and direction before selecting a sailing. Use the terminal lookup and date-specific route pairs described by the tools; do not assume the reverse direction has the same departures.
- Read each candidate sailing's resolved annotations and the pair-wide sailing notes before recommending it for a car. Do not infer vehicle eligibility from a loading-rule number alone.
- Check ferry alerts before claiming a scheduled sailing will run. Read the full bulletin body for replacements and restrictions, include fleet-wide alerts, and retain unresolved route IDs as unresolved coverage. A date's route list does not cover every seasonal or interisland alert ID.
- Match live space to the departure and intended destination IDs. An itinerary label can name multiple stops or the departure terminal; it does not identify the destination by itself.
- Keep cancellation state and space-reporting flags with the counts. A missing or unreported count does not mean zero, and a positive count is a current observation rather than a boarding guarantee.
- If WSF rejects a date or reports no routes loaded for it, report that schedule coverage limit. Do not conclude that the crossing never operates.

## Workflows

### Choose a sailing for a vehicle trip

Find the date's directed terminal pair with `wsdot_get_ferry_routes`, then read `wsdot_get_ferry_schedule`. Resolve the candidate sailings' annotation indexes against the returned annotations, including the pair-wide notes. Combine that eligibility evidence with `wsdot_get_ferry_alerts`; the schedule has no per-sailing cancellation flag and alerts apply to routes rather than identifying every affected departure.

### Assess the next departure

Use the schedule's remaining-departures mode for today. Check `wsdot_get_terminal_space` for the departure terminal and match the destination and departure to the candidate sailing. Do not substitute the next space entry for the user's route merely because its departure is close. Space pages contain whole terminals and all the upcoming sailings they report; follow pagination when browsing several terminals.

When the question also depends on where the assigned vessel is, match the schedule's vessel ID to `wsdot_get_vessel_locations`. Read its position timestamp before presenting the location as current. Vessel progress, published schedule, alerts, and available vehicle space answer different parts of the trip decision; state gaps when one source cannot confirm the others.
