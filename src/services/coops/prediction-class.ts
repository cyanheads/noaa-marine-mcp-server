/**
 * @fileoverview CO-OPS prediction-class decoding shared by the discovery surfaces and
 *   the tide-prediction pre-flight.
 * @module services/coops/prediction-class
 *
 * Both prediction catalogs give every row a one-letter `type` naming how CO-OPS derives
 * its predictions, and the two catalogs use different letters for it. `tidepredictions`
 * uses R (reference) and S (subordinate); `currentpredictions` uses H (harmonic),
 * S (subordinate) and W (weak and variable). The letter decides what a station can
 * answer — a subordinate tide station publishes high and low events only, with no
 * 6-minute curve — so it is decoded once here and read identically everywhere.
 *
 * `subordinate` occurs in both catalogs and does not mean the same thing in each: a
 * subordinate tide station has no 6-minute curve, while a subordinate current station
 * serves the normal MAX_SLACK series.
 */

/** The prediction classes CO-OPS publishes, as words rather than catalog letters. */
export type CoopsPredictionClass = 'reference' | 'subordinate' | 'harmonic' | 'weak_and_variable';

const TIDE_CLASSES: Record<string, CoopsPredictionClass> = {
  R: 'reference',
  S: 'subordinate',
};

const CURRENT_CLASSES: Record<string, CoopsPredictionClass> = {
  H: 'harmonic',
  S: 'subordinate',
  W: 'weak_and_variable',
};

/**
 * Decode a `tidepredictions` row's `type`. A code the catalog has not published before
 * is returned verbatim rather than dropped, so a new CO-OPS class reaches the caller as
 * an unfamiliar value instead of vanishing.
 */
export function tidePredictionClass(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return TIDE_CLASSES[code] ?? code;
}

/** Decode a `currentpredictions` row's `type`, with the same verbatim fallback. */
export function currentPredictionClass(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return CURRENT_CLASSES[code] ?? code;
}

/** True when a `tidepredictions` row is subordinate, and so publishes no 6-minute curve. */
export function isSubordinateTideStation(code: string | undefined): boolean {
  return tidePredictionClass(code) === 'subordinate';
}
