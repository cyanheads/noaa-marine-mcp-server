/**
 * @fileoverview Type definitions for the CO-OPS Tides & Currents service.
 * @module services/coops/types
 */

/** A station from the CO-OPS metadata API station list. */
export interface CoopsStation {
  /** Current-prediction depth bin number. Present on `currentpredictions` rows only, one row per bin. */
  currbin?: number;
  /**
   * Bin depth in FEET for `currentpredictions` rows — the catalog publishes one figure with
   * no unit switch, unlike the depth the data endpoint echoes. Null when CO-OPS publishes
   * none, which is usual where `depthType` is `U`.
   */
  depth?: number | null;
  /** CO-OPS depth-reference code as published: `B`, `S`, or `U`. `currentpredictions` rows only. */
  depthType?: string;
  /**
   * True on a Great Lakes station. `waterlevels` rows only, where CO-OPS marks 52 of 302. These
   * stations carry no tidal datum at all — `STND`, `IGLD`, and `LWD` are the planes that read
   * them — so the flag is what makes a datum rejection there recoverable without a second call.
   */
  greatlakes?: boolean;
  id: string;
  lat: number;
  lng: number;
  name: string;
  /**
   * The reference station a subordinate tide station derives its offsets from.
   * `tidepredictions` rows only, and an empty string on a reference station.
   */
  reference_id?: string;
  /**
   * The state as the catalog publishes it, which is not always a state code: `currentpredictions`
   * rows omit it, some `tidepredictions` rows carry a blank, and a few `waterlevels` rows a name
   * (`United States of America`, `Bermuda`). Read a station's state through
   * `CoopsService.stationStates()`, which resolves it once per catalog refresh.
   */
  state?: string;
  /**
   * Prediction-class code, decoded by `prediction-class.ts`. `tidepredictions` publishes
   * R and S; `currentpredictions` publishes H, S, and W. `waterlevels` has no `type` field.
   */
  type?: string;
}

/**
 * A tide/water-level data observation returned from the CO-OPS data endpoint. The four
 * water-level products answer with different subsets of these keys: `water_level` sends
 * `{t,v,s,f,q}`, `hourly_height` `{t,v,s,f}`, `high_low` `{t,v,ty,f}`, and `daily_mean`
 * `{t,v,f}` — so only `t` and `v` are always present.
 */
export interface CoopsDataRow {
  /** Quality flag: p=preliminary, v=verified. Sent by the `water_level` product only. */
  q?: string;
  /** Standard deviation / sigma. Sent by the `water_level` and `hourly_height` products. */
  s?: string;
  /** ISO datetime string */
  t: string;
  /**
   * Observed-extreme classification on the `high_low` product: `HH` higher high, `H `
   * high, `L ` low, `LL` lower low. CO-OPS pads the single-letter values to two
   * characters with a trailing space.
   */
  ty?: string;
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

/**
 * Fields CO-OPS puts on every `currents_predictions` row, on both intervals.
 * `Bin` and `Depth` arrive as strings; the bearings and velocity arrive as JSON numbers.
 */
interface CoopsCurrentRowCommon {
  /** Depth bin number the row belongs to, as a string. */
  Bin?: string;
  /**
   * Bin depth in the units the request asked for — feet under `english`, meters under
   * `metric`. Null when CO-OPS publishes no depth for the bin.
   */
  Depth?: string | null;
  /** Station mean ebb direction, true bearing in degrees. Constant for the station, not an instantaneous heading. */
  meanEbbDir?: number;
  /** Station mean flood direction, true bearing in degrees. Constant for the station. */
  meanFloodDir?: number;
  /** Row datetime in the requested time zone. */
  Time: string;
  /**
   * Speed along the major axis, in knots under `english` and cm/s under `metric`.
   * Signed by flow sense: positive floods, negative ebbs, zero is slack water.
   */
  Velocity_Major?: number;
}

/** A current prediction row (MAX_SLACK interval). */
export interface CoopsCurrentRow extends CoopsCurrentRowCommon {
  /** Event type: flood, ebb, slack */
  Type: string;
}

/**
 * A current prediction row (6-min interval). CO-OPS sends no `Direction` key on this
 * interval — the flow sense is the sign of `Velocity_Major`, and the bearing it implies
 * is the station's `meanFloodDir` or `meanEbbDir`.
 */
export type CoopsCurrent6MinRow = CoopsCurrentRowCommon;

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
