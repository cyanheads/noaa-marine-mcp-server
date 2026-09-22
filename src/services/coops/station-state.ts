/**
 * @fileoverview Resolves the US state or territory of every CO-OPS station — the code its own
 * catalog rows publish, or, where they publish none, the state of the nearest state-bearing
 * tide or water-level row within 25 km, falling back to the station's own non-code value.
 * @module services/coops/station-state
 */

import { EARTH_RADIUS_KM, haversineKm } from '@/services/geo.js';
import type { CoopsStation } from './types.js';

/** The US state and territory codes a CO-OPS station's state can take. */
export const STATE_CODES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'DC',
  'PR',
  'VI',
  'GU',
  'AS',
  'MP',
] as const;

/**
 * How far a state-bearing row may sit from a station and still lend it its state. An unbounded
 * nearest match puts foreign waters in US states — Magdalena Bay entrance (Mexico) is 1,024 km
 * from the nearest California row, Grenville Channel (B.C.) 151 km from the nearest Alaska row.
 */
export const DERIVED_STATE_RADIUS_KM = 25;

/** Latitude span of the radius; a row farther apart in latitude alone cannot be within it. */
const RADIUS_LAT_DEGREES = (DERIVED_STATE_RADIUS_KM / EARTH_RADIUS_KM) * (180 / Math.PI);

/** A station's resolved state, and whether it was derived rather than published. */
export interface StationState {
  /** True when the station's own rows carry no state code and the state came from a neighbor. False for a published code or a published non-code value. */
  derived: boolean;
  state: string;
}

/** The three CO-OPS station catalogs, as fetched. */
export interface CoopsCatalogs {
  current: readonly CoopsStation[];
  tide: readonly CoopsStation[];
  waterLevel: readonly CoopsStation[];
}

const STATE_CODE_SET: ReadonlySet<string> = new Set(STATE_CODES);

/**
 * True for a state value that is one of {@link STATE_CODES}. The catalogs also carry blanks,
 * nulls, and names — `United States of America`, `Bermuda`, `American Samoa` — which are not.
 */
function isStateCode(value: string | null | undefined): value is string {
  return value != null && STATE_CODE_SET.has(value);
}

/**
 * Station ID → resolved state, for every CO-OPS station that has one, in this order:
 *
 * 1. A code on any of the station's own rows — its published state.
 * 2. The code of the nearest `tidepredictions` or `waterlevels` row within
 *    {@link DERIVED_STATE_RADIUS_KM}, measured from the station's first row — `derived: true`.
 * 3. The non-code value on the station's first row (`FM`, a country name), as published and
 *    unmarked. No state filter reaches it, since the filter takes codes only.
 *
 * A station none of these covers is absent from the map. Non-code values and
 * `currentpredictions` rows, which carry no state, are never a derivation source.
 *
 * Every stateless station is compared with every state-bearing row, so this runs once per
 * catalog refresh, not per request.
 */
export function resolveStationStates(catalogs: CoopsCatalogs): Map<string, StationState> {
  const firstRow = new Map<string, CoopsStation>();
  const published = new Map<string, string>();
  for (const row of [...catalogs.tide, ...catalogs.current, ...catalogs.waterLevel]) {
    if (!firstRow.has(row.id)) firstRow.set(row.id, row);
    if (!published.has(row.id) && isStateCode(row.state)) published.set(row.id, row.state);
  }

  const sources = [...catalogs.tide, ...catalogs.waterLevel].filter(
    (row): row is CoopsStation & { state: string } => isStateCode(row.state),
  );

  const states = new Map<string, StationState>();
  for (const [id, station] of firstRow) {
    const own = published.get(id);
    if (own) {
      states.set(id, { state: own, derived: false });
      continue;
    }

    let nearest: { km: number; state: string } | undefined;
    for (const source of sources) {
      if (Math.abs(source.lat - station.lat) > RADIUS_LAT_DEGREES) continue;
      const km = haversineKm(station.lat, station.lng, source.lat, source.lng);
      if (km <= DERIVED_STATE_RADIUS_KM && (!nearest || km < nearest.km)) {
        nearest = { km, state: source.state };
      }
    }
    if (nearest) states.set(id, { state: nearest.state, derived: true });
    else if (station.state) states.set(id, { state: station.state, derived: false });
  }
  return states;
}
