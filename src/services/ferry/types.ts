/**
 * @fileoverview Domain types for the WSF (Washington State Ferries) API.
 * @module services/ferry/types
 */

/**
 * Raw ferry terminal from `Terminals/rest/terminallocations`. The address, directions, and map-link
 * fields that endpoint also sends are not read.
 */
export interface RawFerryTerminal {
  Latitude?: number | null;
  Longitude?: number | null;
  TerminalAbbrev?: string | null;
  TerminalID?: number | null;
  TerminalName?: string | null;
}

/** Normalized ferry terminal. Identity is optional too — never fabricated when absent. */
export interface FerryTerminal {
  latitude?: number;
  longitude?: number;
  terminalAbbrev?: string;
  terminalId?: number;
  terminalName?: string;
}

/** Raw ferry route from upstream API. */
export interface RawFerryRoute {
  Description?: string | null;
  RouteAbbrev?: string | null;
  RouteID?: number | null;
}

/** Normalized ferry route. */
export interface FerryRoute {
  description?: string;
  routeAbbrev?: string;
  routeId?: number;
  /**
   * Directed terminal pairs the route serves on the trip date — `[]` when it serves none. Absent
   * only when upstream omitted the route's ID, which the lookup is keyed by.
   */
  terminalPairs?: TerminalPair[];
}

/** Raw pair from `Schedule/rest/terminalsandmatesbyroute/{TripDate}/{RouteID}`. */
export interface RawTerminalPair {
  ArrivingDescription?: string | null;
  ArrivingTerminalID?: number | null;
  DepartingDescription?: string | null;
  DepartingTerminalID?: number | null;
}

/**
 * A directed departing → arriving terminal pair with service on a trip date. Both IDs are required:
 * a pair is listed so it can be passed to the schedule tool, and one missing an ID cannot be.
 */
export interface TerminalPair {
  arrivingTerminalId: number;
  arrivingTerminalName?: string;
  departingTerminalId: number;
  departingTerminalName?: string;
}

/**
 * Raw sailing in a schedule response. Neither schedule endpoint carries a cancellation flag —
 * WSF drops a cancelled sailing from the schedule rather than marking it. Cancellations surface
 * only elsewhere: route-scoped in the alerts feed (`Schedule/rest/alerts`), and per sailing in the
 * terminal sailing-space feed's `IsCancelled`.
 */
export interface RawSailing {
  /** Positions in the combo's `Annotations` of the notes that apply to this sailing. */
  AnnotationIndexes?: number[] | null;
  /** Actual API field name (was ArrivalTime in older API). */
  ArrivingTime?: string | null;
  /** Actual API field name (was DepartureTime in older API). */
  DepartingTime?: string | null;
  /**
   * Undocumented loading-rule code. Observed: 3 on nearly every sailing, 1 only on sailings whose
   * annotation restricts vehicles. Carried as the number WSF sends — no meaning is asserted.
   */
  LoadingRule?: number | null;
  VesselHandicapAccessible?: boolean | null;
  VesselID?: number | null;
  VesselName?: string | null;
}

/** Terminal combo entry within a schedule response. */
export interface RawTerminalCombo {
  /** Notes sailings reference by position. Authored as HTML (`<a href>`, `<i>`). */
  Annotations?: string[] | null;
  ArrivingTerminalID?: number | null;
  ArrivingTerminalName?: string | null;
  DepartingTerminalID?: number | null;
  DepartingTerminalName?: string | null;
  /** A note covering the whole pair, authored as HTML; `""` on almost every pair. */
  SailingNotes?: string | null;
  Times?: RawSailing[] | null;
}

/** Raw ferry schedule response — times are nested under TerminalCombos[0].Times. */
export interface RawFerrySchedule {
  ScheduleID?: number | null;
  ScheduleName?: string | null;
  TerminalCombos?: RawTerminalCombo[] | null;
}

/** Normalized sailing. */
export interface Sailing {
  /** Positions in the schedule's `annotations`; each one resolves to an entry. */
  annotationIndexes?: number[];
  arrivalTime?: string;
  departureTime?: string;
  loadingRule?: number;
  vesselHandicapAccessible?: boolean;
  vesselId?: number;
  vesselName?: string;
}

/** Normalized ferry schedule. */
export interface FerrySchedule {
  /** The pair's notes as plain text, blank ones removed; sailings point at them by position. */
  annotations?: string[];
  arrivingTerminalName?: string;
  departingTerminalName?: string;
  /** Whether only today's remaining sailings were requested upstream — false for any other date. */
  remainingOnly: boolean;
  /** The pair-wide note as plain text. */
  sailingNotes?: string;
  sailings: Sailing[];
  tripDate: string;
}

/** Raw vessel location from upstream API. */
export interface RawVesselLocation {
  ArrivingTerminalID?: number | null;
  ArrivingTerminalName?: string | null;
  AtDock?: boolean | null;
  DepartingTerminalID?: number | null;
  DepartingTerminalName?: string | null;
  Eta?: string | null;
  Heading?: number | null;
  InService?: boolean | null;
  Latitude?: number | null;
  LeftDock?: string | null;
  Longitude?: number | null;
  OpRouteAbbrev?: string[] | null;
  ScheduledDeparture?: string | null;
  Speed?: number | null;
  TimeStamp?: string | null;
  VesselID?: number | null;
  VesselName?: string | null;
}

/** Normalized vessel location. */
export interface VesselLocation {
  arrivingTerminalId?: number;
  arrivingTerminalName?: string;
  atDock?: boolean;
  departingTerminalId?: number;
  departingTerminalName?: string;
  eta?: string;
  heading?: number;
  inService?: boolean;
  latitude?: number;
  leftDock?: string;
  longitude?: number;
  opRouteAbbrev: string[];
  scheduledDeparture?: string;
  speed?: number;
  timestamp?: string;
  vesselId?: number;
  vesselName?: string;
}

/** Space availability for one space allocation within a departure. */
export interface RawSpaceForArrivalTerminal {
  /** Terminals served by this allocation — the only reliable source of the destinations. */
  ArrivalTerminalIDs?: number[] | null;
  /** False when WSF does not publish a drive-up count for this sailing. */
  DisplayDriveUpSpace?: boolean | null;
  /** False when the sailing takes no vehicle reservations. */
  DisplayReservableSpace?: boolean | null;
  /** Goes negative when a sailing is oversubscribed; floored to zero during normalization. */
  DriveUpSpaceCount?: number | null;
  DriveUpSpaceHexColor?: string | null;
  MaxSpaceCount?: number | null;
  ReservableSpaceCount?: number | null;
  ReservableSpaceHexColor?: string | null;
  /**
   * The *departing* terminal on multi-stop San Juan itineraries and the arriving terminal on
   * simple two-terminal routes — its meaning varies by route shape, so it is not normalized.
   */
  TerminalID?: number | null;
  /**
   * Itinerary label ("Anacortes -> Friday Harbor"). On a simple two-terminal route it happens to
   * read as the arriving terminal's name, so it is a display string rather than a destination.
   */
  TerminalName?: string | null;
}

/** Raw departure space entry from upstream API. */
export interface RawDepartureSpace {
  Departure?: string | null;
  IsCancelled?: boolean | null;
  MaxSpaceCount?: number | null;
  /** Space counts are nested per arriving terminal. */
  SpaceForArrivalTerminals?: RawSpaceForArrivalTerminal[] | null;
  VesselID?: number | null;
  VesselName?: string | null;
}

/** Raw terminal sailing space from upstream API. */
export interface RawTerminalSailingSpace {
  DepartingSpaces?: RawDepartureSpace[] | null;
  TerminalID?: number | null;
  TerminalName?: string | null;
}

/** Normalized departure space. */
export interface DepartureSpace {
  /** Destination terminal IDs, from `ArrivalTerminalIDs`. Chainable into schedule lookups. */
  arrivingTerminalIds?: number[];
  departure?: string;
  displayDriveUpSpace?: boolean;
  displayReservableSpace?: boolean;
  /** Floored at zero — a negative upstream count means oversubscribed, not available space. */
  driveUpSpaceCount?: number;
  driveUpSpaceHexColor?: string;
  isCancelled?: boolean;
  /** Upstream itinerary string, e.g. "Anacortes -> Friday Harbor". A display label, not a destination. */
  itineraryLabel?: string;
  maxSpaceCount?: number;
  /** Floored at zero, as with `driveUpSpaceCount`. */
  reservableSpaceCount?: number;
  vesselName?: string;
}

/** Normalized terminal sailing space. */
export interface TerminalSailingSpace {
  departingSpaces: DepartureSpace[];
  terminalId?: number;
  terminalName?: string;
}

/** Raw ferry alert from upstream API. */
export interface RawFerryAlert {
  /** Route IDs affected by this alert (was ImpactedRouteIds in older API). */
  AffectedRouteIDs?: number[] | null;
  /** The bulletin's own title. Also the fallback description when RouteAlertText is absent. */
  AlertFullTitle?: string | null;
  AlertType?: string | null;
  /**
   * True when the alert applies fleet-wide, in which case AffectedRouteIDs need not enumerate
   * anything — an empty list then means "every route", not "no route".
   */
  AllRoutesFlag?: boolean | null;
  /** Unique alert ID (was AlertID in older API). */
  BulletinID?: number | null;
  /**
   * The bulletin body, and the only place the detail behind the marquee summary appears.
   * Authored in a rich-text editor, so it arrives as HTML — normalized to plain text.
   */
  BulletinText?: string | null;
  /** WCF date string — decoded to ISO 8601 during normalization. */
  PublishDate?: string | null;
  /** One-line marquee summary, already plain text. */
  RouteAlertText?: string | null;
}

/** Normalized ferry alert. */
export interface FerryAlert {
  /** True when the alert applies to every route, making an empty impactedRouteIds fleet-wide. */
  affectsAllRoutes?: boolean;
  alertDescription?: string;
  alertId?: number;
  alertTitle?: string;
  /** Alert kind as WSF categorizes it, e.g. "All Alerts". */
  alertType?: string;
  /** Full bulletin body, normalized from upstream HTML to plain text. */
  bulletinText?: string;
  impactedRouteIds: number[];
  publishDate?: string;
}
