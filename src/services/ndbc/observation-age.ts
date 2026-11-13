/**
 * @fileoverview Freshness of the newest row in an NDBC observation response.
 * @module services/ndbc/observation-age
 */

/** Calculate age from a valid NDBC timestamp, with a notice for observations over three hours old. */
export function getObservationAge(
  observedAt: string,
  capability: 'met' | 'current_profile' | 'water_quality',
  now: () => number = Date.now,
): { minutes: number; notice?: string } {
  const elapsedMinutes = (now() - Date.parse(observedAt)) / 60_000;
  // Floor keeps even a sub-minute future observation visibly negative.
  const minutes = Math.floor(elapsedMinutes);
  if (elapsedMinutes <= 180) return { minutes };

  return {
    minutes,
    notice: `The latest observation is ${minutes} minutes old. The station may have stopped reporting. Use noaa_marine_find_stations with source="ndbc" and types=["${capability}"] to find other candidate stations.`,
  };
}
