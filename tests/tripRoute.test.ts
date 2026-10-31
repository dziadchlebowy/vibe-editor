import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findTrackFile } from '../src/main/core/timetable.ts';
import { arcPoints, buildTripRoute, loadTripRoute, objectPathPoints, parseTtr, pickTrackPath, saveTripRoute, scoPathAt, serializeTtr, sliPathOffset } from '../src/main/core/tripRoute.ts';
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
    { id: '1565349', pathIndex: 0, tile: 138, index: 32, length: 35, flag: 0 },
    { id: '1564947', pathIndex: 5, tile: 137, index: 99, length: 1, flag: 0 },
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
      { id: '1565349', pathIndex: 0, tile: 0, index: 0, length: 50, flag: 0 },
      { id: '7001', pathIndex: 0, tile: 5 /* błędny kafel → szukamy w innych */, index: 0, length: 10, flag: 0 },
      { id: '999', pathIndex: 0, tile: 0, index: 0, length: 1, flag: 0 },
    ],
    {
      tiles: [{ x: 3, y: 4, file: 'a.map' }],
      readTile: (f) => (f === 'a.map' ? TILE_A : null),
      readAsset: (f) => (f === 'Splines/a.sli' ? ['[path]', '0', '2', '0', '2.5', '0'].join(NL) : null),
      stops: { version: 1, tiles: [{ x: 3, y: 4, file: 'a.map', s: [{ id: '7001', x: 150, y: 150, rot: 0, p: ['Rynek'] }] }] },
    },
  );
  assert.equal(route.segments.length, 3);
  assert.equal(route.unresolved, 2); // 999 nie istnieje; obiekt bez pliku .sco nie ma ścieżki
  assert.equal(route.indexMismatch, 0);
  const lines = route.segments.map((g) => g.line).filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  // spline z (150,0), azymut 0 (na północ), długość 100, przesunięcie +2: kafel (3,4) → środek (3,4)
  assert.ok(Math.abs(lines[0][0] - (3 - 0.5 + 152 / 300)) < 1e-9);
  assert.ok(Math.abs(lines[0][3] - (4 - 0.5 + 100 / 300)) < 1e-9);
  assert.deepEqual(route.stops.map((s) => [s.n, s.name]), [[1, 'Rynek']]);
  assert.ok(Math.abs(route.stops[0].x - 3) < 1e-9 && Math.abs(route.stops[0].y - 4) < 1e-9);
});

test('loadTripRoute i trackFile: .ttr o nazwie kursu, także w innym folderze', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-route-'));
  const map = path.join(dir, 'map');
  fs.mkdirSync(path.join(map, 'TTData'), { recursive: true });
  fs.writeFileSync(path.join(map, 'global.cfg'), ['[map]', '3', '4', 'a.map', ''].join(NL));
  fs.writeFileSync(path.join(map, 'a.map'), TILE_A);
  fs.writeFileSync(path.join(map, 'TTData', 'T.ttp'), ['[trip]', 'T', 'Cel', '1', ''].join(NL));
  assert.equal(loadTimetable(map).trips[0].trackFile, undefined);
  const none = loadTripRoute(dir, map, 'TTData/T.ttp');
  assert.equal(none.noFile, true);
  assert.equal(none.segments.length, 0);
  // .ttr w innym folderze i z inną wielkością liter nazwy
  fs.mkdirSync(path.join(map, 'Tracks'), { recursive: true });
  fs.writeFileSync(path.join(map, 'Tracks', 't.TTR'), TTR);
  assert.equal(loadTimetable(map).trips[0].trackFile, 'Tracks/t.TTR');
  const r = loadTripRoute(dir, map, 'TTData/T.ttp');
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments.filter((g) => g.line.length > 0).length, 1); // 1565349 jest na kaflu, 1564947 nie
  assert.equal(r.unresolved, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findTrackFile: pierwszeństwo tego samego folderu, potem nazwa wewnętrzna z [trip] (- i _ bez znaczenia)', () => {
  const files = ['A/144_TP-SZL.ttr', 'B/144_TP-SZL.ttr', 'C/144-tp-fso.ttr'];
  assert.equal(findTrackFile(files, 'B/144_TP-SZL.ttp'), 'B/144_TP-SZL.ttr');
  assert.equal(findTrackFile(files, 'Z/144_TP-SZL.ttp'), 'A/144_TP-SZL.ttr');
  assert.equal(findTrackFile(files, 'Z/jakas.ttp', '144_TP-FSO'), 'C/144-tp-fso.ttr');
  assert.equal(findTrackFile(files, 'Z/brak.ttp'), undefined);
});

test('serializeTtr: zachowuje nagłówek, numeruje wpisy jak OMSI, parse(serialize(x)) = x', () => {
  const segs = parseTtr(TTR);
  const out = serializeTtr(TTR, segs, '\r\n', '01.01.2026');
  assert.ok(out.startsWith('-----------------------\r\nTime Table Track File'));
  assert.match(out, /   0:\r\n\[track_entry\]\r\n1565349\r\n0\r\n138\r\n32\r\n35\.0000000000\r\n0\r\n\r\n   1:\r\n\[track_entry\]\r\n1564947/);
  assert.deepEqual(parseTtr(out), segs);
  // bez oryginału: domyślny nagłówek z datą
  assert.match(serializeTtr(null, segs, '\n', '02.03.2026'), /Date: 02\.03\.2026\n/);
});

test('edytor: pickTrackPath wybiera ścieżkę pod kursorem, saveTripRoute zapisuje .ttr z kopią .bak', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-pick-'));
  const map = path.join(dir, 'map');
  fs.mkdirSync(path.join(map, 'TTData'), { recursive: true });
  fs.mkdirSync(path.join(dir, '_vibe', 'assets', 'Splines'), { recursive: true });
  fs.writeFileSync(path.join(map, 'global.cfg'), ['[map]', '3', '4', 'a.map', ''].join(NL));
  fs.writeFileSync(path.join(map, 'a.map'), TILE_A);
  // dwie ścieżki: pojazdy (typ 0) w x = -2 i +2 m od osi, piesi (typ 1) przy x = 0
  fs.writeFileSync(path.join(dir, '_vibe', 'assets', 'Splines', 'a.sli'),
    ['[path]', '0', '-2', '0', '2.5', '0', '[path]', '0', '2', '0', '2.5', '1', '[path]', '1', '0', '0', '1', '0'].join(NL));
  fs.writeFileSync(path.join(map, 'TTData', 'T.ttp'), ['[trip]', 'T', 'Cel', '1', ''].join(NL));
  // spline: start (150, 0) m na kaflu (3,4), na północ, 100 m → x świata = (3 - 0.5) * 300 + 150 = 900 m
  const wx = (x: number): number => x / 300;
  // klik 1,9 m na wschód od osi → ścieżka 1 (przesunięcie +2), nie 0 ani pieszych
  const seg = pickTrackPath(dir, map, wx(900 + 1.9), wx((4 - 0.5) * 300 + 40), 5);
  assert.ok(seg);
  assert.deepEqual([seg.id, seg.pathIndex, seg.tile, seg.index], ['1565349', 1, 0, 0]);
  assert.ok(Math.abs(seg.length - 100) < 1e-9 && seg.line.length >= 4);
  // za daleko od jakiejkolwiek ścieżki
  assert.equal(pickTrackPath(dir, map, wx(900 + 40), wx(1200 + 40), 5), null);
  // zapis: nowy plik .ttr obok .ttp, potem nadpisanie z kopią .bak
  assert.equal(saveTripRoute(map, 'TTData/T.ttp', [seg]).ok, true);
  const ttr = path.join(map, 'TTData', 'T.ttr');
  assert.deepEqual(parseTtr(fs.readFileSync(ttr, 'utf8')).map((e) => e.id), ['1565349']);
  assert.equal(saveTripRoute(map, 'TTData/T.ttp', []).ok, true);
  assert.equal(parseTtr(fs.readFileSync(ttr, 'utf8')).length, 0);
  assert.equal(parseTtr(fs.readFileSync(`${ttr}.bak`, 'utf8')).length, 1);
  assert.equal(saveTripRoute(map, 'TTData/T.ttp', [{ ...seg, id: 'x1' }]).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

import { editStations, parseTrip as parseTripFile } from '../src/main/core/timetable.ts';
import { hoverTrack, splinePath } from '../src/main/core/tripRoute.ts';

const TTP2 = [
  '-----------------------', 'Time Table Trip File', '-----------------------', '', '[trip]', 'T', 'Cel', '1', '',
  '[station]', '1575273', '0', 'Pierwszy', '0', '6.369', '34.503', '34.503', '5.000', '',
  '[station]', '1546328', '3', 'Trzeci', '0', '0.762', '802.058', '27.892', '3.000', '', '',
  '[profile]', 'standard', '27.000', '',
  '[profile_man_arr_time]', '0', '0.000', '[profile_man_dep_time]', '1', '2.000', '[profile_otherstopping]', '1', '3', '',
].join('\r\n');

test('editStations: nowy przystanek w kolejności (wpis, pos), numery w profilach przesunięte, remap nadpisuje wpis/cum/len', () => {
  const out = editStations(TTP2, new Map([[1, { entry: 4, cum: 900, len: 30 }]]), [
    { id: '777', entry: 1, name: 'Drugi', tile: 0, pos: 2, cum: 100.5, len: 20, wait: 5 },
  ]).join('\r\n');
  const t = parseTripFile(out, 'T.ttp');
  assert.deepEqual(t.stations.map((s) => [s.name, s.entry]), [['Pierwszy', 0], ['Drugi', 1], ['Trzeci', 4]]);
  assert.deepEqual([t.stations[1].pos, t.stations[1].cum, t.stations[1].len, t.stations[1].wait], [2, 100.5, 20, 5]);
  assert.deepEqual([t.stations[2].cum, t.stations[2].len], [900, 30]);
  // przystanek 1 (dawniej „Trzeci”) jest teraz drugim indeksem 2; zerowy bez zmian
  assert.deepEqual(t.profiles[0].dep, { 2: 2 });
  assert.deepEqual(t.profiles[0].arr, { 0: 0 });
  assert.deepEqual(t.profiles[0].stop, { 2: 3 });
  // dopisanie na końcu i do pustego kursu
  const last = parseTripFile(editStations(TTP2, new Map(), [{ id: '9', entry: 9, name: 'Ostatni', tile: 0, pos: 1, cum: 1, len: 1, wait: 3 }]).join('\r\n'), 'T.ttp');
  assert.deepEqual(last.stations.map((s) => s.name), ['Pierwszy', 'Trzeci', 'Ostatni']);
  const empty = parseTripFile(editStations(['[trip]', 'T', 'Cel', '1', ''].join('\r\n'), new Map(), [{ id: '9', entry: 0, name: 'X', tile: 0, pos: 1, cum: 1, len: 1, wait: 3 }]).join('\r\n'), 'T.ttp');
  assert.equal(empty.stations.length, 1);
});

const sp = (id: number, y: number): string => rec('spline', 'Splines\\a.sli', [id, 0, 0, 150, 0, y, 0, 100, 0]);
const TILE_CHAIN = [sp(101, 0), sp(102, 100), sp(103, 200), sp(104, 300), sp(105, 500) /* luka 100 m — niepołączony */].join(NL);

test('splinePath: ścieżka z kierunkiem 1 biegnie od końca splinu do początku', () => {
  const s = { path: 'a.sli', id: '1', x: 10, y: 20, z: 0, heading: 0, length: 50, radius: 0, mirror: false };
  const sli = ['[path]', '0', '0', '0', '2.5', '0', '[path]', '0', '0', '0', '2.5', '1'].join(NL);
  assert.deepEqual(splinePath(s, sli, 0).pts.map((p) => p[1]), [20, 70]);
  assert.deepEqual(splinePath(s, sli, 1).pts.map((p) => p[1]), [70, 20]);
});

test('hoverTrack: łańcuch połączonych ścieżek od zaznaczonego odcinka do ścieżki pod kursorem', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-hover-'));
  const map = path.join(dir, 'map');
  fs.mkdirSync(map, { recursive: true });
  fs.mkdirSync(path.join(dir, '_vibe', 'assets', 'Splines'), { recursive: true });
  fs.writeFileSync(path.join(map, 'global.cfg'), ['[map]', '3', '4', 'a.map', ''].join(NL));
  fs.writeFileSync(path.join(map, 'a.map'), TILE_CHAIN);
  fs.writeFileSync(path.join(dir, '_vibe', 'assets', 'Splines', 'a.sli'), ['[path]', '0', '0', '0', '2.5', '0'].join(NL));
  const u = (m: number): number => m / 300;
  const fromLine = [u(900), u(1050), u(900), u(1150)]; // odcinek 101: od (900, 1050) do (900, 1150) m
  // kursor nad 103 (y = 1050 + 250 m): łańcuch 102 → 103
  const r = hoverTrack(dir, map, u(900), u(1050 + 250), 5, fromLine);
  assert.equal(r.target?.id, '103');
  assert.deepEqual(r.chain.map((g) => g.id), ['102', '103']);
  // kursor nad 102: sam następnik
  assert.deepEqual(hoverTrack(dir, map, u(900), u(1050 + 150), 5, fromLine).chain.map((g) => g.id), ['102']);
  // kursor nad 104 (zaczyna się w końcu 103): łańcuch 102 → 103 → 104
  assert.deepEqual(hoverTrack(dir, map, u(900), u(1050 + 350), 5, fromLine).chain.map((g) => g.id), ['102', '103', '104']);
  // 105 leży za luką 100 m: jest targetem, ale bez łańcucha
  const gap = hoverTrack(dir, map, u(900), u(1050 + 550), 5, fromLine);
  assert.equal(gap.target?.id, '105');
  assert.equal(gap.chain.length, 0);
  // bez odcinka wyjściowego: tylko target, bez łańcucha
  const alone = hoverTrack(dir, map, u(900), u(1050 + 250), 5, null);
  assert.equal(alone.target?.id, '103');
  assert.equal(alone.chain.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('zapis trasy z przystankami: .ttp dostaje nowy przystanek z cum/len z odcinków i kopię .ttp.bak', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-stops-'));
  const map = path.join(dir, 'map');
  fs.mkdirSync(path.join(map, 'TTData'), { recursive: true });
  fs.writeFileSync(path.join(map, 'global.cfg'), ['[map]', '3', '4', 'a.map', ''].join(NL));
  fs.writeFileSync(path.join(map, 'TTData', 'T.ttp'), TTP2);
  const seg = (id: string, length: number) => ({ id, pathIndex: 0, tile: 0, index: 0, length, flag: 0, line: [] as number[] });
  const segs = [seg('1', 10), seg('2', 20), seg('3', 30)];
  const res = saveTripRoute(map, 'TTData/T.ttp', segs, { remap: [], add: [{ stopId: '777', tileFile: 'a.map', name: 'Nowy', entry: 1, pos: 4 }] });
  assert.equal(res.ok, true);
  const t = parseTripFile(fs.readFileSync(path.join(map, 'TTData', 'T.ttp'), 'utf8'), 'T.ttp');
  const n = t.stations.find((s) => s.name === 'Nowy')!;
  assert.deepEqual([n.id, n.entry, n.pos, n.cum, n.len, n.tile], ['777', 1, 4, 30, 20, 0]);
  assert.equal(t.stations.length, 3);
  assert.equal(fs.readFileSync(path.join(map, 'TTData', 'T.ttp.bak'), 'utf8'), TTP2);
  // przystanek przypisany do nieistniejącego odcinka — odmowa, bez zapisu
  assert.equal(saveTripRoute(map, 'TTData/T.ttp', segs, { remap: [], add: [{ stopId: '1', tileFile: 'a.map', name: 'Zły', entry: 9, pos: 0 }] }).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
