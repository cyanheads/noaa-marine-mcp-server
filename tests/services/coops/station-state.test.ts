/**
 * @fileoverview Tests for the CO-OPS station state resolver — the published code where a
 * station has one, else the state of the nearest state-bearing tide or water-level row within
 * 25 km.
 * @module tests/services/coops/station-state.test
 */

import { describe, expect, it } from 'vitest';
import { DERIVED_STATE_RADIUS_KM, resolveStationStates } from '@/services/coops/station-state.js';
import type { CoopsStation } from '@/services/coops/types.js';

/**
 * One degree of latitude is 111.19 km on the 6,371 km sphere the resolver measures on, so
 * stations stacked along one meridian sit at distances that read straight off their latitudes.
 */
const KM_PER_DEGREE_LAT = 111.19;

function station(id: string, lat: number, state?: string | null, extra?: Partial<CoopsStation>) {
  return { id, name: id, lat, lng: -122, ...(state !== undefined ? { state } : {}), ...extra };
}

const noCatalog: CoopsStation[] = [];

describe('resolveStationStates', () => {
  it('publishes the radius the derivation uses', () => {
    expect(DERIVED_STATE_RADIUS_KM).toBe(25);
  });

  it('keeps the catalog state code of a station that publishes one, unmarked', () => {
    const states = resolveStationStates({
      tide: [station('9447130', 47.6, 'WA')],
      current: noCatalog,
      waterLevel: noCatalog,
    });

    expect(states.get('9447130')).toEqual({ state: 'WA', derived: false });
  });

  it('derives the state of a stateless current station within 25 km of a state-bearing row', () => {
    // 0.2° of latitude apart: 22.2 km.
    const states = resolveStationStates({
      tide: [station('ANCHOR', 47.0, 'WA')],
      current: [station('CUR1', 47.2, null)],
      waterLevel: noCatalog,
    });

    expect(0.2 * KM_PER_DEGREE_LAT).toBeLessThan(DERIVED_STATE_RADIUS_KM);
    expect(states.get('CUR1')).toEqual({ state: 'WA', derived: true });
  });

  it('leaves a station with no state-bearing row within 25 km without a state', () => {
    // 0.3° of latitude apart: 33.4 km.
    const states = resolveStationStates({
      tide: [station('ANCHOR', 47.0, 'WA')],
      current: [station('CUR1', 47.3, null)],
      waterLevel: noCatalog,
    });

    expect(0.3 * KM_PER_DEGREE_LAT).toBeGreaterThan(DERIVED_STATE_RADIUS_KM);
    expect(states.has('CUR1')).toBe(false);
  });

  it('takes the nearest state-bearing row when several are within range', () => {
    // CUR1 sits 16.7 km from the OR row and 22.2 km from the WA row.
    const states = resolveStationStates({
      tide: [station('FARTHER', 47.0, 'WA'), station('NEARER', 47.35, 'OR')],
      current: [station('CUR1', 47.2, null)],
      waterLevel: noCatalog,
    });

    expect(states.get('CUR1')).toEqual({ state: 'OR', derived: true });
  });

  it('derives the state of a stateless tide row the same way (a blank state is no state)', () => {
    const states = resolveStationStates({
      tide: [station('TWC1165', 47.1, ''), station('9449880', 47.0, 'WA')],
      current: noCatalog,
      waterLevel: noCatalog,
    });

    expect(states.get('TWC1165')).toEqual({ state: 'WA', derived: true });
    expect(states.get('9449880')).toEqual({ state: 'WA', derived: false });
  });

  it('draws derived states from water-level rows as well as tide rows', () => {
    const states = resolveStationStates({
      tide: noCatalog,
      current: [station('CUR1', 47.1, null)],
      waterLevel: [station('WL1', 47.0, 'WA')],
    });

    expect(states.get('CUR1')).toEqual({ state: 'WA', derived: true });
  });

  it('never uses a non-code catalog value as a derived state, and skips past it to a code', () => {
    // The closest rows carry names, not codes; the WA row farther away is the nearest code.
    const states = resolveStationStates({
      tide: [station('ANCHOR', 47.0, 'WA')],
      current: [station('CUR1', 47.2, null)],
      waterLevel: [
        station('USA', 47.21, 'United States of America'),
        station('BDA', 47.19, 'Bermuda'),
        station('ASM', 47.2, 'American Samoa'),
      ],
    });

    expect(states.get('CUR1')).toEqual({ state: 'WA', derived: true });
  });

  it('keeps the non-code value a station publishes on its first row when no code is near', () => {
    const states = resolveStationStates({
      tide: [station('1840000', 7.45, 'FM')],
      current: noCatalog,
      waterLevel: [station('BDA', 32.37, 'Bermuda')],
    });

    // Shown as published, unmarked — it is the station's own value, not a derived one.
    expect(states.get('1840000')).toEqual({ state: 'FM', derived: false });
    expect(states.get('BDA')).toEqual({ state: 'Bermuda', derived: false });
  });

  it("prefers a derived code over the station's own non-code value", () => {
    // 11 km from a WA row: rule (b) outranks rule (c).
    const states = resolveStationStates({
      tide: [station('NAMED', 47.1, 'United States of America'), station('ANCHOR', 47.0, 'WA')],
      current: noCatalog,
      waterLevel: noCatalog,
    });

    expect(states.get('NAMED')).toEqual({ state: 'WA', derived: true });
  });

  it('gives no state to a station whose first row is blank, whatever a later row names', () => {
    // Pago Pago's shape: a blank tide row first, the territory name only on its water-level row.
    const states = resolveStationStates({
      tide: [station('1770000', -14.28, '')],
      current: noCatalog,
      waterLevel: [station('1770000', -14.28, 'American Samoa')],
    });

    expect(states.has('1770000')).toBe(false);
  });

  it('never derives from a current row, which carries no state', () => {
    const states = resolveStationStates({
      tide: noCatalog,
      current: [station('CUR1', 47.0, null), station('CUR2', 47.05, 'WA')],
      waterLevel: noCatalog,
    });

    // CUR2's own row is a code, so it is published; it is not a source for CUR1.
    expect(states.get('CUR2')).toEqual({ state: 'WA', derived: false });
    expect(states.has('CUR1')).toBe(false);
  });

  it('prefers the code a later catalog row publishes over a derived one for the same station', () => {
    // A blank tide row, but the station's water-level row carries OR — its own state wins over
    // the WA row 11 km away.
    const states = resolveStationStates({
      tide: [station('9440083', 47.1, ''), station('ANCHOR', 47.0, 'WA')],
      current: noCatalog,
      waterLevel: [station('9440083', 47.1, 'OR')],
    });

    expect(states.get('9440083')).toEqual({ state: 'OR', derived: false });
  });

  it('resolves a multi-bin current station once, from its first row', () => {
    const bins = [15, 10, 1].map((currbin) => station('PUG1515', 47.1, null, { currbin }));
    const states = resolveStationStates({
      tide: [station('ANCHOR', 47.0, 'WA')],
      current: bins,
      waterLevel: noCatalog,
    });

    expect(states.get('PUG1515')).toEqual({ state: 'WA', derived: true });
    expect([...states.keys()].sort()).toEqual(['ANCHOR', 'PUG1515']);
  });

  it('measures across longitude, not latitude alone', () => {
    // Same latitude, 0.5° of longitude apart at 47° N: 37.9 km — beyond the radius.
    const states = resolveStationStates({
      tide: [{ id: 'ANCHOR', name: 'ANCHOR', lat: 47, lng: -122, state: 'WA' }],
      current: [{ id: 'CUR1', name: 'CUR1', lat: 47, lng: -122.5, state: null }],
      waterLevel: noCatalog,
    });

    expect(states.has('CUR1')).toBe(false);
  });

  it('returns an empty map for empty catalogs', () => {
    expect(
      resolveStationStates({ tide: noCatalog, current: noCatalog, waterLevel: noCatalog }).size,
    ).toBe(0);
  });
});
