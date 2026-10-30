import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { arcPoints, buildTripRoute, loadTripRoute, objectPathPoints, parseTtr, scoPathAt, sliPathOffset } from '../src/main/core/tripRoute.ts';
import { loadTimetable, parseTrip } from '../src/main/core/timetable.ts';

const NL = '\r\n';
const entry = (i: number, v: (string | number)[]): string => [`   ${i}:`, '[track_entry]', ...v, ''].join(NL);
const TTR = [
  '-----------------------', 'Time Table Track File', '-----------------------', '', 'Created with Omsi Version 2.3.004', 'Date: 01.08.2026', '',
  entry(0, [1565349, 0, 138, 32, '35.0000000000', 0]),
  entry(1, [1564947, 5, 137, 99, '1.0000000000', 0]),
].join(NL);

test('.ttr: wpisy [track_entry] (ID, ścieżka, kafel, długość)', () => {
  const e = parseTtr(TTR);
  assert.deepEqual(e, [
    { id: '1565349', pathIndex: 0, tile: 138, length: 35 },
    { id: '1564947', pathIndex: 5, tile: 137, length: 1 },
  ]);
});

test('geometria: prosta na północ i łuk, przesunięcie boczne, obrót obiektu', () => {
  const s = arcPoints(10, 20, 0, 0, 30, 0);
  assert.deepEqual(s.map((p) => p.map((v) => Math.round(v * 1000) / 1000)), [[10, 20], [10, 50]]);
  // przesunięcie c = +3 przy azymucie 0 (na północ) → w prawo, czyli +X
  assert.ok(Math.abs(arcPoints(0, 0, 0, 0, 10, 3)[0][0] - 3) < 1e-9);
  // obiekt obrócony o 90° zgodnie z zegarem: ścieżka „na północ” w układzie obiektu idzie na wschód
  const o = objectPathPoints({ x: 0, y: 0, hdg: 0, radius: 0, len: 10 }, 100, 100, 90);
  assert.ok(Math.abs(o[1][0] - 110) < 1e-9 && Math.abs(o[1][1] - 100) < 1e-9);
});

test('ścieżki z .sli i .sco liczone po wszystkich znacznikach [path]', () => {
  const sli = ['[path]', '0', '1.5', '0', '2.5', '0', '[path]', '0', '-2.275', '0', '2.5', '1'].join(NL);
  assert.equal(sliPathOffset(sli, 0), 1.5);
  assert.equal(sliPathOffset(sli, 1), -2.275);
  assert.equal(sliPathOffset(sli, 2), null);
  const sco = ['[path]', '1', '2', '0', '90', '0', '12', '2.5'].join(NL);
  assert.deepEqual(scoPathAt(sco, 0), { x: 1, y: 2, hdg: 90, radius: 0, len: 12 });
});

const rec = (kind: string, p: string, v: (string | number)[]): string => [`[${kind}]`, '0', p, ...v, ''].join(NL);
const TILE_A = [
  rec('spline', 'Splines\\a.sli', [1565349, 0, 0, 150, 0, 0, 0, 100, 0]),
  rec('object', 'Objects\\x.sco', [7001, 150, 150, 0, 0, 0, 0, 0, 0]),
].join(NL);

test('trasa kursu: spline i obiekt po ID, przystanek po ID obiektu', () => {
  const trip = parseTrip(['[trip]', 'T', 'Cel', '1', '', '[station]', '7001', '0', 'Rynek', '0', '1', '2', '3', '4', ''].join(NL), 'T.ttp');
  assert.equal(trip.stations[0].tile, 0);
  const route = buildTripRoute(
    trip,
    [
      { id: '1565349', pathIndex: 0, tile: 0, length: 50 },
      { id: '7001', pathIndex: 0, tile: 5 /* błędny kafel → szukamy w innych */, length: 10 },
      { id: '999', pathIndex: 0, tile: 0, length: 1 },
    ],
    {
      tiles: [{ x: 3, y: 4, file: 'a.map' }],
      readTile: (f) => (f === 'a.map' ? TILE_A : null),
      readAsset: (f) => (f === 'Splines/a.sli' ? ['[path]', '0', '2', '0', '2.5', '0'].join(NL) : null),
      stops: { version: 1, tiles: [{ x: 3, y: 4, file: 'a.map', s: [{ id: '7001', x: 150, y: 150, rot: 0, p: ['Rynek'] }] }] },
    },
  );
  assert.equal(route.entries, 3);
  assert.equal(route.unresolved, 2); // 999 nie istnieje; obiekt bez pliku .sco nie ma ścieżki
  assert.equal(route.lines.length, 1);
  // spline z (150,0), azymut 0 (na północ), długość 100, przesunięcie +2: kafel (3,4) → środek (3,4)
  assert.ok(Math.abs(route.lines[0][0] - (3 - 0.5 + 152 / 300)) < 1e-9);
  assert.ok(Math.abs(route.lines[0][3] - (4 - 0.5 + 100 / 300)) < 1e-9);
  assert.deepEqual(route.stops.map((s) => [s.n, s.name]), [[1, 'Rynek']]);
  assert.ok(Math.abs(route.stops[0].x - 3) < 1e-9 && Math.abs(route.stops[0].y - 4) < 1e-9);
});

test('loadTripRoute i hasTrack: .ttr obok .ttp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-route-'));
  const map = path.join(dir, 'map');
  fs.mkdirSync(path.join(map, 'TTData'), { recursive: true });
  fs.writeFileSync(path.join(map, 'global.cfg'), ['[map]', '3', '4', 'a.map', ''].join(NL));
  fs.writeFileSync(path.join(map, 'a.map'), TILE_A);
  fs.writeFileSync(path.join(map, 'TTData', 'T.ttp'), ['[trip]', 'T', 'Cel', '1', ''].join(NL));
  assert.equal(loadTimetable(map).trips[0].hasTrack, false);
  assert.match(loadTripRoute(dir, map, 'TTData/T.ttp').error ?? '', /\.ttr/);
  fs.writeFileSync(path.join(map, 'TTData', 'T.ttr'), TTR);
  assert.equal(loadTimetable(map).trips[0].hasTrack, true);
  const r = loadTripRoute(dir, map, 'TTData/T.ttp');
  assert.equal(r.entries, 2);
  assert.equal(r.lines.length, 1); // 1565349 jest na kaflu, 1564947 nie
  assert.equal(r.unresolved, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
