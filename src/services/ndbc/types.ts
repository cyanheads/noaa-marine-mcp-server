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
  /** Whether the station reports sub-surface water-quality observations */
  hasWaterQuality: boolean;
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
  /**
   * ISO 8601 UTC timestamp of the observation row. Always a valid instant: a row whose
   * five upstream time columns are malformed is skipped, and the parse fails outright
   * rather than emitting a fabricated current time or an unparseable string.
   */
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
  /**
   * ISO 8601 UTC timestamp of the observation. Always a valid instant: a row whose five
   * upstream time columns are malformed is skipped, and the parse fails outright rather
   * than emitting a fabricated current time or an unparseable string.
   */
  observedAt: string;
  /** Per-depth readings at the latest observation time, in NDBC source order. */
  readings: NdbcOceanReading[];
}

/** A column block of the realtime2 feed that NDBC writes on its own processing cycle. */
export type NdbcColumnGroup = 'atmosphere' | 'tide' | 'visibility' | 'water' | 'wave' | 'wind';

/** A column block whose values were read from a row older than the observation's `observedAt`. */
export interface NdbcStaleGroup {
  /** The column block the values came from. */
  group: NdbcColumnGroup;
  /** ISO 8601 UTC timestamp of the row this block's values were read from. */
  observedAt: string;
}

/**
 * Parsed NDBC realtime observation.
 * Sensor fields are null when no row inside the look-back window reported a value — either
 * the buoy wrote `MM` on the row its column block was resolved from, or the sensor is absent
 * from the file entirely. Each column block NDBC writes on its own processing cycle resolves
 * from the most recent row inside that window carrying it, so a value can be older than
 * `observedAt`; the wave block reports its own age as `wavesObservedAt`, and every block that
 * resolved from an older row — wave included — is listed in `staleGroups`.
 */
export interface NdbcObservation {
  /** Air temperature °C — null if no value inside the look-back window */
  airTempC: number | null;
  /** Average period seconds — null if no value on the resolved wave row */
  averagePeriodSec: number | null;
  /** Dew point temperature °C — null if no value inside the look-back window */
  dewPointC: number | null;
  /** Dominant period seconds — null if no value on the resolved wave row */
  dominantPeriodSec: number | null;
  /** Wind gust m/s — null if no value inside the look-back window */
  gustSpeedMs: number | null;
  /** Mean wave direction degrees true — null if no value on the resolved wave row */
  meanWaveDirectionDeg: number | null;
  /**
   * ISO 8601 UTC timestamp of the newest data row. Always a valid instant: a row whose five
   * upstream time columns are malformed is skipped, and the parse fails outright rather than
   * emitting a fabricated current time or an unparseable string.
   */
  observedAt: string;
  /** Atmospheric pressure hPa — null if no value inside the look-back window */
  pressureHpa: number | null;
  /**
   * Every column block whose values were read from a row older than `observedAt`, with that
   * row's timestamp. Empty when every block resolved from the newest row. The wave block
   * appears here as well as in `wavesObservedAt`, so the list stays complete by mechanism.
   */
  staleGroups: NdbcStaleGroup[];
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
  /** Sea surface temperature °C — null if no value inside the look-back window */
  waterTempC: number | null;
  /** Significant wave height m — null if no wave sample inside the look-back window */
  waveHeightM: number | null;
  /**
   * ISO 8601 UTC timestamp of the row the wave block was resolved from — can be older than
   * `observedAt`, since NDBC writes waves on a slower cycle than met rows. Null when no wave
   * sample exists inside the look-back window.
   */
  wavesObservedAt: string | null;
  /** Wind direction degrees true — null if no value inside the look-back window */
  windDirectionDeg: number | null;
  /** Wind speed m/s — null if no value inside the look-back window */
  windSpeedMs: number | null;
}
