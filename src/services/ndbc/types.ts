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
 * A single depth bin from an NDBC ADCP (`.adcp`) current profile.
 * Direction and speed are null when NDBC reported the literal `MM` for that
 * component; a bin is only emitted when its depth is present to anchor it.
 */
export interface NdbcCurrentBin {
  /** Bin depth below the surface in meters. */
  depthM: number;
  /** Direction the current flows toward, degrees true (0–360) — null if MM. */
  directionDeg: number | null;
  /** Current speed in cm/s — null if MM. */
  speedCmS: number | null;
}

/**
 * Parsed NDBC ADCP current profile — the most recent observation row from an
 * `<ID>.adcp` realtime file, resolved into an ordered list of depth bins.
 */
export interface NdbcCurrentProfile {
  /** Depth-binned current measurements, shallowest first (NDBC source order). */
  bins: NdbcCurrentBin[];
  /** ISO 8601 UTC timestamp of the observation row. */
  observedAt: string;
}

/**
 * A single depth reading from an NDBC oceanographic (`.ocean`) file — the
 * sub-surface water-column sensors at one measurement depth. Every sensor value
 * is null when NDBC reported the literal `MM` for that column; only the depth is
 * guaranteed, since a reading is emitted only when its depth is present to anchor it.
 */
export interface NdbcOceanReading {
  /** Chlorophyll concentration µg/l (CLCON) — null if MM. */
  chlorophyllUgL: number | null;
  /** Conductivity mS/cm (COND) — null if MM. */
  conductivityMsCm: number | null;
  /** Measurement depth below the surface in meters (DEPTH). */
  depthM: number;
  /** Dissolved-oxygen saturation percent (O2%) — null if MM. */
  oxygenPercent: number | null;
  /** Dissolved-oxygen concentration ppm (O2PPM) — null if MM. */
  oxygenPpm: number | null;
  /** pH, dimensionless (PH) — null if MM. */
  ph: number | null;
  /** Oxidation-reduction (redox) potential mV (EH) — null if MM. */
  redoxMv: number | null;
  /** Salinity psu (SAL) — null if MM. */
  salinityPsu: number | null;
  /** Turbidity FTU (TURB) — null if MM. */
  turbidityFtu: number | null;
  /** Water temperature °C (OTMP) — null if MM. */
  waterTempC: number | null;
}

/**
 * Parsed NDBC oceanographic observation — the readings sharing the most recent
 * timestamp in an `<ID>.ocean` realtime file. A station usually reports one depth
 * (a single reading), but some report several depths at the same time, so the
 * latest observation is an ordered list of per-depth readings.
 */
export interface NdbcOceanObservation {
  /** ISO 8601 UTC timestamp of the observation. */
  observedAt: string;
  /** Per-depth readings at the latest observation time, in NDBC source order. */
  readings: NdbcOceanReading[];
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
