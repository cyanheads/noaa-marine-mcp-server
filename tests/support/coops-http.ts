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
