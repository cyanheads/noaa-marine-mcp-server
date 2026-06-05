/**
 * @fileoverview Type definitions for the CO-OPS Tides & Currents service.
 * @module services/coops/types
 */

/** A station from the CO-OPS metadata API station list. */
export interface CoopsStation {
  id: string;
  lat: number;
  lng: number;
  name: string;
  state?: string;
  /** Station type code — R=reference, T=subordinate, S=secondary, ACT-prefix for currents */
  type?: string;
}

/** A tide/water-level data observation returned from the CO-OPS data endpoint. */
export interface CoopsDataRow {
  /** Quality flag: p=preliminary, v=verified */
  q?: string;
  /** Standard deviation / sigma (water level only) */
  s?: string;
  /** ISO datetime string */
  t: string;
  /** Numeric value (water level in feet or metric equivalent) */
  v: string;
}

/** A tidal prediction row. */
export interface CoopsPredictionRow {
  t: string;
  /** Tide type: H=high, L=low (hilo interval only) */
  type?: string;
  v: string;
}

/** A current prediction row (MAX_SLACK interval). */
export interface CoopsCurrentRow {
  /** True bearing direction in degrees */
  meanEbbDir?: string;
  meanFloodDir?: string;
  /** Event datetime */
  Time: string;
  /** Event type: flood, ebb, slack */
  Type: string;
  /** Speed in knots or m/s */
  Velocity_Major?: string;
}

/** A current prediction row (6-min interval). */
export interface CoopsCurrent6MinRow {
  /** Direction */
  Direction?: string;
  Time: string;
  /** Speed */
  Velocity_Major?: string;
}

/** CO-OPS data API error envelope shape. */
export interface CoopsErrorResponse {
  error: { message: string };
}

/** CO-OPS mdapi station list response. */
export interface CoopsStationListResponse {
  count?: number;
  stations: CoopsStation[];
}

/** Supported CO-OPS station list types for the metadata endpoint. */
export type CoopsStationType = 'tidepredictions' | 'currentpredictions' | 'waterlevels';
