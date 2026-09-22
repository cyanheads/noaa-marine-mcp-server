/**
 * @fileoverview Great-circle distance, shared by the proximity search and the CO-OPS state resolver.
 * @module services/geo
 */

/** Mean Earth radius in km, the sphere every distance here is measured on. */
export const EARTH_RADIUS_KM = 6371;

/** Haversine distance in km between two lat/lon pairs. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(a));
}
