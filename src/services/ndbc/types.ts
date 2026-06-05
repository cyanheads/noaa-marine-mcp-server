/**
 * @fileoverview Type definitions for the NDBC (National Data Buoy Center) service.
 * @module services/ndbc/types
 */

/** A station from the NDBC active stations XML. */
export interface NdbcStation {
  /** Whether station reports current observations */
  hasCurrents: boolean;
  /** Whether station reports meteorological observations */
  hasMet: boolean;
  id: string;
  lat: number;
  lon: number;
  name: string;
  /** Owner/operator */
  owner?: string;
  /** NDBC station type (buoy, fixed, etc.) */
  type?: string;
}

/**
 * Parsed NDBC realtime observation.
 * All sensor fields are null when the buoy did not report a value (MM in source).
 */
export interface NdbcObservation {
  /** Air temperature °C — null if not reported */
  airTempC: number | null;
  /** Average period seconds — null if not reported */
  averagePeriodSec: number | null;
  /** Dew point temperature °C — null if not reported */
  dewPointC: number | null;
  /** Dominant period seconds — null if not reported */
  dominantPeriodSec: number | null;
  /** Wind gust m/s — null if not reported */
  gustSpeedMs: number | null;
  /** Mean wave direction degrees true — null if not reported */
  meanWaveDirectionDeg: number | null;
  /** ISO timestamp of the observation */
  observedAt: string;
  /** Atmospheric pressure hPa — null if not reported */
  pressureHpa: number | null;
  /**
   * Tide in feet — null if not reported.
   * NOTE: NDBC TIDE is always in feet regardless of other unit preferences.
   */
  tideFt: number | null;
  /**
   * Visibility in nautical miles — null if not reported.
   * NOTE: NDBC VIS is always in nautical miles regardless of other unit preferences.
   */
  visibilityNmi: number | null;
  /** Sea surface temperature °C — null if not reported */
  waterTempC: number | null;
  /** Significant wave height m — null if not reported */
  waveHeightM: number | null;
  /** Wind direction degrees true — null if not reported */
  windDirectionDeg: number | null;
  /** Wind speed m/s — null if not reported */
  windSpeedMs: number | null;
}
