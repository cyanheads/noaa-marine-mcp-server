/**
 * @fileoverview Fake CO-OPS HTTP upstream for tests that drive the real `CoopsService` through a
 * tool. Answers the station catalog (mdapi) and the data endpoint (datagetter) by path and
 * product, and records every request so a test can read what was sent and how often.
 * @module tests/support/coops-http
 */

import { createFetchMock, type FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';

const COOPS_ORIGIN = 'https://api.tidesandcurrents.noaa.gov';

/** Which CO-OPS endpoint a request reached. */
export type CoopsEndpoint = 'catalog' | 'data';

/** Classifies a request by origin and path; undefined for anything that is not CO-OPS. */
export function coopsEndpoint(url: string): CoopsEndpoint | undefined {
  const parsed = new URL(url);
  if (parsed.origin !== COOPS_ORIGIN) return undefined;
  if (parsed.pathname === '/mdapi/prod/webapi/stations.json') return 'catalog';
  if (parsed.pathname === '/api/prod/datagetter') return 'data';
  return undefined;
}

/** A responder keyed by the endpoint and, for the data endpoint, the `product` parameter. */
export type CoopsResponder = (endpoint: CoopsEndpoint, url: URL) => Response;

/** Installs a fake CO-OPS upstream. Call `restore()` on the returned harness when done. */
export function installCoopsFake(respond: CoopsResponder): FetchMockHarness {
  const http = createFetchMock([
    {
      match: (request) => coopsEndpoint(request.url) !== undefined,
      respond: (request) => {
        const url = new URL(request.url);
        return respond(coopsEndpoint(request.url) as CoopsEndpoint, url);
      },
    },
  ]);
  http.install();
  return http;
}

/** Requests the harness saw at one endpoint, as parsed URLs, in call order. */
export function callsTo(http: FetchMockHarness, endpoint: CoopsEndpoint): URL[] {
  return http.calls
    .filter((call) => coopsEndpoint(call.request.url) === endpoint)
    .map((call) => new URL(call.request.url));
}

/** PUG1515's three depth bins — a current-only station, so its catalog rows carry no state. */
const PUG1515_BINS = [
  { currbin: 15, depth: 16 },
  { currbin: 10, depth: 49 },
  { currbin: 1, depth: 108 },
].map((bin) => ({
  id: 'PUG1515',
  name: 'West Point, West of',
  lat: 47.6621,
  lng: -122.4417,
  state: null,
  depthType: 'B',
  type: 'H',
  ...bin,
}));

/**
 * The station catalogs as CO-OPS publishes their state field, for tests of how a station's
 * state is resolved:
 *
 * - `9447130` publishes WA on its tide and water-level rows.
 * - `PUG1515` is current-only, 10 km from `9447130`, so its state is derived.
 * - `TWC1165` is a tide row with a blank state, 17 km from `9449880` (WA).
 * - `PCT0016` is current-only in Mexican waters, with no state-bearing row within 25 km.
 * - `1619910` (Midway) has a blank tide row first and a country name, not a code, on its
 *   water-level row — so it showed no state before derivation existed, and shows none now.
 * - `1840000` (Chuuk) publishes `FM`, a code outside the state filter's set, with no
 *   state-bearing row within 25 km — its own value is shown as published.
 */
export const STATE_CATALOGS = {
  tidepredictions: [
    {
      id: '1840000',
      name: 'CHUUK, Moen Island',
      lat: 7.4467,
      lng: 151.8467,
      state: 'FM',
      type: 'R',
      reference_id: '',
    },
    {
      id: '1619910',
      name: 'SAND ISLAND, MIDWAY ISLANDS',
      lat: 28.2117,
      lng: -177.36,
      state: '',
      type: 'R',
      reference_id: '',
    },
    {
      id: '9447130',
      name: 'SEATTLE (Madison St.), Elliott Bay',
      lat: 47.6026,
      lng: -122.3393,
      state: 'WA',
      type: 'R',
      reference_id: '',
    },
    {
      id: 'TWC1165',
      name: 'Peavine Pass',
      lat: 48.6,
      lng: -122.8,
      state: '',
      type: 'S',
      reference_id: '9444900',
    },
    {
      id: '9449880',
      name: 'Friday Harbor',
      lat: 48.5453,
      lng: -123.0125,
      state: 'WA',
      type: 'R',
      reference_id: '',
    },
  ],
  currentpredictions: [
    ...PUG1515_BINS,
    {
      id: 'PCT0016',
      name: 'Magdalena Bay entrance',
      lat: 24.5333,
      lng: -112.0333,
      state: null,
      currbin: 1,
      type: 'S',
    },
  ],
  waterlevels: [
    { id: '9447130', name: 'Seattle', lat: 47.6026, lng: -122.3393, state: 'WA' },
    {
      id: '1619910',
      name: 'Sand Island, Midway Islands',
      lat: 28.2117,
      lng: -177.36,
      state: 'United States of America',
    },
  ],
} as const;

/** Answers the station catalog from {@link STATE_CATALOGS}. The data endpoint is never reached. */
export function stateCatalogCoops(endpoint: CoopsEndpoint, url: URL): Response {
  if (endpoint !== 'catalog') throw new Error(`Unexpected CO-OPS ${endpoint} request: ${url}`);
  const type = url.searchParams.get('type') as keyof typeof STATE_CATALOGS;
  return Response.json({ stations: STATE_CATALOGS[type] });
}

/** Healthy answers for the three data tools, one station of each kind. */
export function healthyCoops(endpoint: CoopsEndpoint, url: URL): Response {
  if (endpoint === 'catalog') {
    const type = url.searchParams.get('type');
    if (type === 'currentpredictions') {
      return Response.json({
        stations: [
          {
            id: 'PUG1515',
            name: 'Tacoma Narrows',
            lat: 47.27,
            lng: -122.55,
            currbin: 15,
            type: 'H',
          },
        ],
      });
    }
    return Response.json({
      stations: [
        { id: '9447130', name: 'Seattle', lat: 47.6, lng: -122.33, state: 'WA', type: 'R' },
      ],
    });
  }

  const product = url.searchParams.get('product');
  if (product === 'currents_predictions') {
    return Response.json({
      current_predictions: {
        cp: [
          {
            Type: 'flood',
            Time: '2026-09-15 07:12',
            Velocity_Major: 0.89,
            meanFloodDir: 234,
            meanEbbDir: 341,
            Bin: '15',
            Depth: '16',
          },
        ],
      },
    });
  }
  if (product === 'predictions') {
    return Response.json({
      predictions: [
        { t: '2026-09-15 00:00', v: '8.200', type: 'H' },
        { t: '2026-09-15 00:06', v: '8.280', type: 'L' },
      ],
    });
  }
  return Response.json({
    metadata: { name: 'Seattle' },
    data: [
      { t: '2026-09-15 00:00', v: '8.230', s: '0.010', f: '0,0,0,0', q: 'p' },
      { t: '2026-09-15 00:06', v: '8.310', s: '0.010', f: '0,0,0,0', q: 'p' },
    ],
  });
}
