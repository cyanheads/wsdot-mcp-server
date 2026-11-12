---
name: wsdot-guide
description: Plan Washington ferry trips with wsdot_* tools when a next-sailing, vehicle-eligibility, fare, or capacity question needs schedule, fares, service alerts, terminal space, and vessel evidence combined.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use WSDOT's ferry tools for published sailings and current operating conditions. They quote WSF's published fares but do not buy tickets or make vehicle reservations. Highway conditions, tolls, cameras, and border waits use the other `wsdot_*` tools; they do not establish ferry service.

## Gates

- Establish the requested travel date and direction before selecting a sailing. Use the terminal lookup and date-specific route pairs described by the tools; do not assume the reverse direction has the same departures.
- Read each candidate sailing's resolved annotations and the pair-wide sailing notes before recommending it for a car. Do not infer vehicle eligibility from a loading-rule number alone.
- Check ferry alerts before claiming a scheduled sailing will run. Read the full bulletin body for replacements and restrictions, include fleet-wide alerts, and retain unresolved route IDs as unresolved coverage. A date's route list does not cover every seasonal or interisland alert ID.
- Match live space to the departure and intended destination IDs. An itinerary label can name multiple stops or the departure terminal; it does not identify the destination by itself.
- Keep cancellation state and space-reporting flags with the counts. A missing or unreported count does not mean zero, and a positive count is a current observation rather than a boarding guarantee.
- WSF reports space for select terminals only, and at times for none. A departure terminal with no space rows has unconfirmed space, not a full lane and not a wrong ID; say so and fall back to the schedule and alerts.
- Read the fare result's collection statement before quoting any line that reads 0. WSF collects most fares at one terminal only, so 0 usually means this leg's departing terminal does not collect that fare, not that travel is free; query the reverse direction to find where it is charged. A round-trip total starts at the departing terminal and follows the same rule.
- Quote a sailing's clock time from its Pacific-time sibling, not the UTC value: a late-evening sailing's UTC time carries the next calendar date.
- If WSF rejects a date or reports no routes loaded for it, report that schedule coverage limit. Do not conclude that the crossing never operates.

## Workflows

### Choose a sailing for a vehicle trip

Find the date's directed terminal pair with `wsdot_get_ferry_routes`, then read `wsdot_get_ferry_schedule`. Resolve the candidate sailings' annotation indexes against the returned annotations, including the pair-wide notes. Combine that eligibility evidence with `wsdot_get_ferry_alerts`; the schedule has no per-sailing cancellation flag and alerts apply to routes rather than identifying every affected departure.

### Price a trip

Resolve the directed terminal pair as for a schedule, then read `wsdot_get_ferry_fares` for the trip date. Match the vehicle line to the vehicle's length, and report the collection statement with the amounts. Fares are for one direction of the pair; for a fare the departing terminal does not collect, read the reverse direction.

### Assess the next departure

Use the schedule's remaining-departures mode for today. Between midnight and 03:00 Pacific it lists the previous service day's sailings still to depart first, each with that day's service date, so a 01:35 departure belongs to the day before its calendar date; a notice says when that day could not be checked, in which case late sailings may be missing. Check `wsdot_get_terminal_space` for the departure terminal and match the destination and departure to the candidate sailing. Do not substitute the next space entry for the user's route merely because its departure is close. Space pages contain whole terminals and all the upcoming sailings they report; follow pagination when browsing several terminals.

When the question also depends on where the assigned vessel is, match the schedule's vessel ID to `wsdot_get_vessel_locations`. Read its position timestamp before presenting the location as current. Vessel progress, published schedule, alerts, and available vehicle space answer different parts of the trip decision; state gaps when one source cannot confirm the others.
