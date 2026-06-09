/**
 * @fileoverview Domain types for the WSDOT Traffic API.
 * @module services/traffic/types
 */

/** Raw travel restriction from upstream API (WSDOT `TravelRestriction`). */
export interface RawTravelRestriction {
  RestrictionText?: string | null;
  TravelDirection?: string | null;
}

/** Raw mountain pass condition from upstream API. */
export interface RawMountainPass {
  /** WCF `/Date(ms±offset)/` string — decoded to ISO 8601 during normalization. */
  DateUpdated?: string | null;
  ElevationInFeet?: number | null;
  Latitude?: number | null;
  Longitude?: number | null;
  MountainPassId?: number | null;
  MountainPassName?: string | null;
  RestrictionOne?: RawTravelRestriction | null;
  RestrictionTwo?: RawTravelRestriction | null;
  RoadCondition?: string | null;
  TemperatureInFahrenheit?: number | null;
  TravelAdvisoryActive?: boolean | null;
  WeatherCondition?: string | null;
}

/** Normalized travel restriction (traction/chain requirement). */
export interface TravelRestriction {
  text?: string;
  travelDirection?: string;
}

/** Normalized mountain pass condition. */
export interface MountainPass {
  dateUpdated?: string;
  elevation?: number;
  latitude?: number;
  longitude?: number;
  mountainPassId: number;
  mountainPassName: string;
  restrictionOne?: TravelRestriction;
  restrictionTwo?: TravelRestriction;
  roadCondition?: string;
  temperatureInFahrenheit?: number;
  travelAdvisoryActive?: boolean;
  weatherCondition?: string;
}

/** Raw roadway location from upstream API. */
export interface RawRoadwayLocation {
  Direction?: string | null;
  Latitude?: number | null;
  Longitude?: number | null;
  MilePost?: number | null;
  RoadName?: string | null;
}

/** Raw highway alert from upstream API. */
export interface RawHighwayAlert {
  AlertID?: number | null;
  County?: string | null;
  EndRoadwayLocation?: RawRoadwayLocation | null;
  EndTime?: string | null;
  EventCategory?: string | null;
  EventStatus?: string | null;
  ExtendedDescription?: string | null;
  HeadlineDescription?: string | null;
  LastUpdatedTime?: string | null;
  Priority?: string | null;
  Region?: string | null;
  StartRoadwayLocation?: RawRoadwayLocation | null;
  StartTime?: string | null;
}

/** Normalized roadway location. */
export interface RoadwayLocation {
  direction?: string;
  latitude?: number;
  longitude?: number;
  milePost?: number;
  roadName?: string;
}

/** Normalized highway alert. */
export interface HighwayAlert {
  alertId?: number;
  county?: string;
  endRoadwayLocation?: RoadwayLocation;
  endTime?: string;
  eventCategory?: string;
  eventStatus?: string;
  extendedDescription?: string;
  headlineDescription?: string;
  lastUpdatedTime?: string;
  priority?: string;
  region?: string;
  startRoadwayLocation?: RoadwayLocation;
  startTime?: string;
}

/** Raw road time point from upstream API. */
export interface RawRoadTimePoint {
  Direction?: string | null;
  MilePost?: number | null;
  RoadName?: string | null;
}

/** Raw travel time entry from upstream API. */
export interface RawTravelTime {
  AverageTime?: number | null;
  CurrentTime?: number | null;
  Description?: string | null;
  Distance?: number | null;
  EndPoint?: RawRoadTimePoint | null;
  Name?: string | null;
  StartPoint?: RawRoadTimePoint | null;
  TimeUpdated?: string | null;
  TravelTimeID?: number | null;
}

/** Normalized road time point. */
export interface RoadTimePoint {
  direction?: string;
  milePost?: number;
  roadName?: string;
}

/** Normalized travel time corridor. */
export interface TravelTime {
  averageTimeInMinutes?: number;
  currentTimeInMinutes?: number;
  description?: string;
  distanceInMiles?: number;
  endPoint?: RoadTimePoint;
  name?: string;
  startPoint?: RoadTimePoint;
  timeUpdated?: string;
  travelTimeId?: number;
}

/** Raw toll rate from upstream API. */
export interface RawTollRate {
  CurrentMessage?: string | null;
  CurrentToll?: number | null;
  EndLatitude?: number | null;
  EndLocationName?: string | null;
  EndLongitude?: number | null;
  EndMilepost?: number | null;
  StartLatitude?: number | null;
  StartLocationName?: string | null;
  StartLongitude?: number | null;
  StartMilepost?: number | null;
  StateRoute?: string | null;
  TimeUpdated?: string | null;
  TravelDirection?: string | null;
  TripName?: string | null;
}

/** Normalized toll rate. */
export interface TollRate {
  endLatitude?: number;
  endLocationName?: string;
  endLongitude?: number;
  endMilepost?: number;
  message?: string;
  startLatitude?: number;
  startLocationName?: string;
  startLongitude?: number;
  startMilepost?: number;
  stateRoute?: string;
  timeUpdated?: string;
  tollRateInDollars?: number;
  travelDirection?: string;
  tripName?: string;
}

/** Raw border crossing location from upstream API. */
export interface RawBorderCrossingLocation {
  /** Readable crossing/lane name, e.g. "I-5 General Purpose", "I-5 Nexus Lane". */
  Description?: string | null;
  Direction?: string | null;
  Latitude?: number | null;
  Longitude?: number | null;
  MilePost?: number | null;
  RoadName?: string | null;
}

/** Raw border crossing from upstream API. */
export interface RawBorderCrossing {
  BorderCrossingLocation?: RawBorderCrossingLocation | null;
  CrossingName?: string | null;
  /** WCF `/Date(ms±offset)/` string — decoded to ISO 8601 during normalization. */
  Time?: string | null;
  /** Wait in minutes; WSDOT emits -1 when the crossing reports no data (dropped during normalization). */
  WaitTime?: number | null;
}

/** Normalized border crossing. */
export interface BorderCrossing {
  crossingName?: string;
  location?: {
    description?: string;
    roadName?: string;
    direction?: string;
    milePost?: number;
    latitude?: number;
    longitude?: number;
  };
  updateTime?: string;
  waitTimeInMinutes?: number;
}

/** Raw camera location nested object from upstream API. */
export interface RawCameraLocation {
  Direction?: string | null;
  Latitude?: number | null;
  Longitude?: number | null;
  MilePost?: number | null;
  RoadName?: string | null;
}

/** Raw camera from upstream API. */
export interface RawCamera {
  CameraID?: number | null;
  CameraLocation?: RawCameraLocation | null;
  Description?: string | null;
  ImageHeight?: number | null;
  ImageURL?: string | null;
  ImageWidth?: number | null;
  IsActive?: boolean | null;
  Region?: string | null;
  Title?: string | null;
}

/** Normalized camera. */
export interface Camera {
  cameraId?: number;
  description?: string;
  direction?: string;
  imageHeight?: number;
  imageUrl?: string;
  imageWidth?: number;
  latitude?: number;
  longitude?: number;
  milePost?: number;
  region?: string;
  roadName?: string;
  title?: string;
}
