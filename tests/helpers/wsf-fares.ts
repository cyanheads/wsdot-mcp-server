/**
 * @fileoverview Live WSF Fares API captures for trip date 2026-11-13, shared by the fares service and
 * tool suites. The line items under `tests/fixtures/wsf-fares/` are the `farelineitems` bodies WSF
 * served verbatim; the terminal combos and rejection messages below are WSF's text verbatim.
 * @module tests/helpers/wsf-fares
 */

import { readFileSync } from 'node:fs';
import type { RawFareLineItem, RawFareTerminalCombo } from '@/services/ferry/types.js';

/** The trip date every capture is for. */
export const FARES_TRIP_DATE = '2026-11-13';

/** A captured `farelineitems/{FARES_TRIP_DATE}/{from}/{to}/{roundTrip}` body. */
export type FareCapture =
  | '1-10-oneway'
  | '1-10-roundtrip'
  | '10-1-oneway'
  | '3-7-oneway'
  | '7-3-oneway'
  | '7-3-roundtrip';

/** The captured line items, parsed fresh on every call so a test cannot mutate another's copy. */
export function fareLineItems(capture: FareCapture): RawFareLineItem[] {
  const file = new URL(`../fixtures/wsf-fares/farelineitems-${capture}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8')) as RawFareLineItem[];
}

/** `terminalcombo/{FARES_TRIP_DATE}/{from}/{to}` for the captured pairs. */
export const TERMINAL_COMBOS = {
  '1-10': {
    DepartingDescription: 'Anacortes',
    ArrivingDescription: 'Friday Harbor',
    CollectionDescription:
      'Passenger and vehicle/driver fares are collected at Anacortes, while no fares are collected at Friday Harbor.',
  },
  '10-1': {
    DepartingDescription: 'Friday Harbor',
    ArrivingDescription: 'Anacortes',
    CollectionDescription:
      'No fares are collected at Friday Harbor, while passenger and vehicle/driver fares are collected at Anacortes.',
  },
  '7-3': {
    DepartingDescription: 'Seattle',
    ArrivingDescription: 'Bainbridge Island',
    CollectionDescription:
      'Passenger and vehicle/driver fares are collected at Seattle, while vehicle/driver only fares are collected at Bainbridge Island.',
  },
  '3-7': {
    DepartingDescription: 'Bainbridge Island',
    ArrivingDescription: 'Seattle',
    CollectionDescription:
      'Vehicle/driver only fares are collected at Bainbridge Island, while passenger and vehicle/driver fares are collected at Seattle.',
  },
} as const satisfies Record<string, RawFareTerminalCombo>;

/** WSF's HTTP 400 body for a trip date outside its fares window (here, before it opens). */
export const FARES_DATE_REJECTION = {
  Message:
    "The TripDate 11/10/2026 is not valid.   A valid TripDate ranges from today's date through whichever comes first, the end of the most recently posted sailing season or the end of the most recently posted tariff schedule.  Valid TripDate values currently currently span 11/11/2026 - 3/20/2027.",
};

/** WSF's HTTP 400 body for a pair with no service on the date (7 → 1). */
export const FARES_PAIR_REJECTION = {
  Message:
    'The Arriving TerminalID 1 is not valid for a TripDate of 11/13/2026 and a Departing TerminalID of 7.',
};

/** WSF's HTTP 400 body for a departing terminal with no sailings loaded on an in-window date. */
export const FARES_DEPARTING_REJECTION = {
  Message: 'The Departing TerminalID 7 is not valid for a TripDate of 1/15/2027.',
};

/** The Senior/Disability line's name as WSF sends it (an unquoted-href anchor) and as plain text. */
export const DISABILITY_LINE = {
  raw: 'Senior (age 65 & over) / <a href=https://wsdot.wa.gov/ferries/rider-information/ada#Reduced%20fare%20passenger%20tickets target="_blank" title="Disability">Disability</a>',
  text: 'Senior (age 65 & over) / Disability (https://wsdot.wa.gov/ferries/rider-information/ada#Reduced%20fare%20passenger%20tickets)',
};
