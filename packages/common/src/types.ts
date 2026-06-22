/**
 * Common types used across Airways microservices.
 *
 * Note: Database types are imported from @airways/database package.
 * This file contains service-layer types that don't belong in the database package.
 */

/** Log levels for service logging */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Service health status */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/** Scraper operational modes */
export type ScraperMode = 'live' | 'backfill' | 'link-only' | 'dedup' | 'fix-actual-times';

/** Scheduler event types */
export type SchedulerEventType = 'sleep' | 'wake' | 'prefetch';

/** Generic result type for operations that can fail */
export interface Result<T, E = Error> {
  success: boolean;
  data?: T;
  error?: E;
}

/** Success result */
export interface SuccessResult<T> {
  success: true;
  data: T;
}

/** Failure result */
export interface FailureResult<E = Error> {
  success: false;
  error: E;
}

/** Flight time estimate types */
export type TimeEstimateType = 'EstimatedBlockOff' | 'EstimatedBlockOn';

/** Position tracking direction */
export type PositionDirection = 'inbound' | 'outbound';

/** Aircraft status for position tracking */
export type AircraftStatus = 'Ground' | 'Taxiing' | 'Airborne' | 'Landed' | 'Unknown';

/** Timer state for scheduler implementations */
export interface TimerState {
  scrapeTimeout: ReturnType<typeof setTimeout> | null;
  wakeTimeout: ReturnType<typeof setTimeout> | null;
  prefetchSlotTimeout?: ReturnType<typeof setTimeout> | null;
  tzCheckTimeout?: ReturnType<typeof setTimeout> | null;
}

/** Scraper log entry structure */
export interface ScraperLogEntry {
  service: string;
  status: 'success' | 'failure' | 'retry';
  recordsScraped: number;
  errorMessage?: string;
  startedAt: Date;
  completedAt: Date;
}

/** Flight identification for internal tracking */
export interface FlightIdentifier {
  flightNumber: string;
  flightDate: string;
  departureAirport: string;
  arrivalAirport: string;
}

/** Estimated times for a flight */
export interface FlightTimeEstimates {
  estDep?: Date;
  estArr?: Date;
}

/** Active flight info for scheduling decisions */
export interface ActiveFlightInfo {
  id: number;
  flightNumber: string;
  scheduledDeparture: Date | null;
  scheduledArrival: Date | null;
  actualDeparture: Date | null;
  actualArrival: Date | null;
  status: string | null;
}

/** Interval calculation result */
export interface IntervalCalculation {
  ms: number;
  jitterMs: number;
  reason: string;
}

/** Sleep/wake decision result */
export interface SleepDecision {
  sleep: boolean;
  reason: string;
}

/** Wake time calculation result */
export interface WakeTimeCalculation {
  wakeAt: Date;
  reason: string;
}

/** ADS-B aircraft tracking entry */
export interface AirborneEntry {
  flightId: number;
  arrivalAirport: string;
  missedPolls: number;
}

/** ADS-B lookup result */
export interface ADSBAircraftInfo {
  icao24: string;
  callsign?: string;
  registration?: string;
  aircraftType?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  groundSpeed?: number;
  onGround?: boolean;
  originIata?: string;
  destinationIata?: string;
}

/** Notification types */
export type NotificationType = 'status_change' | 'gate_change' | 'delay' | 'reminder';

/** Push notification payload */
export interface PushNotification {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  requireInteraction?: boolean;
  data?: Record<string, unknown>;
}

/** Weather data structure */
export interface WeatherData {
  airportCode: string;
  metar?: string;
  taf?: string;
  temperature?: number;
  windSpeed?: number;
  windDirection?: number;
  visibility?: number;
  cloudBase?: number;
  recordedAt: Date;
}

/** Error with code for typed error handling */
export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** Validation error */
export class ValidationError extends ServiceError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

/** Configuration error */
export class ConfigError extends ServiceError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFIG_ERROR', details);
    this.name = 'ConfigError';
  }
}
