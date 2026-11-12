/**
 * @fileoverview Live WSF schedule captures around the service-day rollover, shared by the schedule
 * service and wire suites. Each file under `tests/fixtures/wsf-schedule/` is a body WSF served
 * verbatim on 2026-11-12 between 02:53 and 03:03 PST, while `scheduletoday` already served 11/12
 * and the dated window still began at 11/11. The rejection messages below are in WSF's words.
 * @module tests/helpers/wsf-schedule
 */

import { readFileSync } from 'node:fs';
import type { RawFerrySchedule } from '@/services/ferry/types.js';

/**
 * A captured schedule body:
 * - `schedule-2026-11-11-7-3`: Seattle → Bainbridge, Wednesday 11/11; its last sailing departs
 *   2026-11-12 01:35 PST (09:35Z).
 * - `scheduletoday-2026-11-12-7-3-true`: `scheduletoday/7/3/true` at 02:53 PST on 11/12 — the
 *   whole 11/12 service day (first sailing 05:30 PST), nothing from 11/11.
 * - `schedule-2026-11-14-7-3`: Saturday 11/14, whose weekend service runs to 2026-11-15 02:10 PST
 *   (10:10Z), the latest past-midnight departure in either loaded season.
 * - `schedule-2026-11-15-7-3`: Sunday 11/15, the body `scheduletoday` serves before that day's
 *   first sailing (06:10 PST).
 * - `schedule-2026-11-13-22-20` / `schedule-2026-11-14-22-20`: Vashon → Southworth, Friday and
 *   Saturday. Friday's combo carries one annotation ("Via Fauntleroy, …"), Saturday's none.
 */
export type ScheduleCapture =
  | 'schedule-2026-11-11-7-3'
  | 'schedule-2026-11-13-22-20'
  | 'schedule-2026-11-14-22-20'
  | 'schedule-2026-11-14-7-3'
  | 'schedule-2026-11-15-7-3'
  | 'scheduletoday-2026-11-12-7-3-true';

/** A capture, parsed fresh on every call so a test cannot mutate another's copy. */
export function scheduleCapture(capture: ScheduleCapture): RawFerrySchedule {
  const file = new URL(`../fixtures/wsf-schedule/${capture}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8')) as RawFerrySchedule;
}

/** WSF's HTTP 400 body for 11/11 once its dated window rolled to 11/12 at 03:00 PST, verbatim. */
export const DATE_ROLLED_REJECTION = {
  Message:
    "The TripDate 11/11/2026 is not valid. The valid range begins with today's date (11/12/2026) and extends to the end of the most recently posted schedule (3/20/2027).",
};

/**
 * WSF's HTTP 400 body for a pair with no service on the date (a seasonal pair's off day), in the
 * template WSF answers `schedule/{TripDate}/{from}/{to}` with.
 */
export const PAIR_REJECTION_1111 = {
  Message:
    'The terminal combination DepartingTerminalID 7 and ArrivingTerminalID 3 is not valid for a TripDate of 11/11/2026.',
};
