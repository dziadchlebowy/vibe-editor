import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { arcEnd } from '../src/shared/arcs.ts';
import { moveSplines, newSpline, newSplineStartAt, splineEndPose, splineEndZ, type EditSpline } from '../src/shared/splineEdit.ts';
import { parseTileSplines, buildSplinesData, loadMapSplines, splinesPath } from '../src/main/core/mapSplines.ts';
import { applySplineEdit, createSpline, loadEditSplines, pickSplinePoints, refreshSplinesIndex, rewriteSplineRecord } from '../src/main/core/splineEdit.ts';

const NL = '\r\n';
const angDiff = (a: number, b: number): number => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
const base: EditSpline = { id: 'A', tile: 0, kind: 'spline_h', path: 'Splines\\a.sli', mirror: false, x: 100, y: 200, heading: 0, length: 100, radius: 0, z: 10, dz: 3, pitch0: 0, pitch1: 2, skew0: 0, skew1: 0, prev: '0', next: '0' };

test('moveSplines: oba końce = przesunięcie sztywne; jeden koniec = łuk przez nowy punkt z nieruszonym drugim końcem (pozycja i azymut)', () => {
  const both = moveSplines([base], [{ splineId: 'A', end: 'start' }, { splineId: 'A', end: 'end' }], 5, -7, 1.5).splines[0];
  assert.deepEqual([both.x, both.y, both.heading, both.length, both.z, both.dz], [105, 193, 0, 100, 11.5, 3]);
  // przesunięcie końca o (20, 0): początek i azymut początku zostają, koniec ląduje w nowym punkcie
  const end = moveSplines([base], [{ splineId: 'A', end: 'end' }], 20, 0, 0).splines[0];
  const e = splineEndPose(end, 'end');
  assert.ok(Math.hypot(e.x - 120, e.y - 300) < 0.01);
  assert.ok(end.x === 100 && end.y === 200 && end.heading === 0 && end.radius !== 0);
  // przesunięcie początku o (0, 30): koniec zostaje w (100, 300) z azymutem 0
  const st = moveSplines([base], [{ splineId: 'A', end: 'start' }], -15, 30, 0).splines[0];
  const e2 = splineEndPose(st, 'end');
  assert.ok(Math.hypot(e2.x - 100, e2.y - 300) < 0.01 && angDiff(e2.heading, 0) < 0.3);
  assert.ok(st.x === 85 && st.y === 230);
});

test('moveSplines: wysokość — jeden koniec zmienia z i dz, drugi koniec zostaje; zwykły [spline] staje się [spline_h]', () => {
  const s1 = moveSplines([base], [{ splineId: 'A', end: 'start' }], 0, 0, 2).splines[0];
  assert.ok(Math.abs(s1.z - 12) < 1e-12 && Math.abs(splineEndZ(s1, 'end') - 13) < 1e-12); // koniec bez zmian (13)
  const s2 = moveSplines([base], [{ splineId: 'A', end: 'end' }], 0, 0, -1).splines[0];
  assert.ok(s2.z === 10 && Math.abs(splineEndZ(s2, 'end') - 12) < 1e-12);
  const plain = { ...base, kind: 'spline' as const, dz: 0 };
  assert.equal(moveSplines([plain], [{ splineId: 'A', end: 'end' }], 0, 0, 1).splines[0].kind, 'spline_h');
  assert.equal(moveSplines([plain], [{ splineId: 'A', end: 'start' }, { splineId: 'A', end: 'end' }], 0, 0, 1).splines[0].kind, 'spline'); // oba końce — wciąż płaski
  assert.equal(moveSplines([base], [{ splineId: 'ZZ', end: 'end' }], 1, 1, 1).splines.length, 0); // brak zaznaczenia = brak zmian
});

test('newSpline: od końca splinu łuk styczny ze stałym nachyleniem, od dowolnego punktu prosta; początek splinu → „do tyłu”', () => {
  const start = newSplineStartAt(base, 'end'); // koniec A: (100, 300), azymut 0, nachylenie 2°, z = 13
  assert.deepEqual([start.heading, start.pitch, start.z], [0, 2, 13]);
  const g = newSpline(start, 130, 380);
  assert.ok(typeof g !== 'string');
  const e = arcEnd({ x: g.x, y: g.y, heading: g.heading, length: g.length, radius: g.radius });
  assert.ok(Math.hypot(e.x - 130, e.y - 380) < 0.05 && g.pitch0 === 2 && g.pitch1 === 2);
  assert.ok(Math.abs(g.dz - g.length * Math.tan((2 * Math.PI) / 180)) < 1e-9);
  const free = newSpline({ x: 0, y: 0, z: 5 }, 30, 40);
  assert.ok(typeof free !== 'string' && free.radius === 0 && Math.abs(free.length - 50) < 1e-9 && Math.abs(free.heading - 36.8699) < 1e-3 && free.dz === 0);
  const back = newSplineStartAt(base, 'start');
  assert.equal(back.heading, 180);
  assert.ok(Math.abs(back.pitch ?? 1) < 1e-12);
  assert.equal(typeof newSpline({ x: 0, y: 0, z: 0 }, 0, 0.01), 'string');
});

const rec = (kind: '[spline]' | '[spline_h]', id: number, prev: number, next: number, x: number, z: number, y: number, hd: number, len: number, rad: number, tail: (string | number)[]): string =>
  [kind, '0', 'Splines\\a.sli', id, prev, next, x, z, y, hd, len, rad, ...tail, ''].map(String).join(NL);

test('rewriteSplineRecord: zmienia tylko różniące się pola, a [spline] z dz staje się [spline_h] z zachowaniem mirror', () => {
  const text = [rec('[spline_h]', 7, 0, 0, 100, 10, 200, 0, 100, 0, [0, 2, 3, 0, 0, 0, 0, 0]), rec('[spline]', 8, 0, 0, 5, 1, 6, 90, 20, 0, [0, 0, 0, 0, 0.1495907, -0.0963, 25, 'mirror'])].join(NL);
  const lines = text.split(NL);
  const before = lines.join('\n');
  assert.equal(rewriteSplineRecord(lines, { ...base, id: '7' }, 100, 200), null);
  assert.equal(lines.join('\n'), before); // brak zmian = identyczny tekst
  assert.equal(rewriteSplineRecord(lines, { ...base, id: '7', z: 12, dz: 1 }, 101.5, 200), null);
  const [a] = parseTileSplines(lines.join(NL));
  assert.deepEqual([a.x, a.z, a.dz], [101.5, 12, 1]);
  const plain: EditSpline = { ...base, id: '8', kind: 'spline_h', x: 5, y: 6, z: 1, dz: 2, heading: 90, length: 20 };
  assert.equal(rewriteSplineRecord(lines, plain, 5, 6), null);
  const sp = parseTileSplines(lines.join(NL));
  assert.deepEqual([sp[1].kind, sp[1].dz, sp[1].z, sp[1].mirror], ['spline_h', 2, 1, true]);
  const raw = lines.join(NL);
  assert.ok(raw.includes('0.1495907') && raw.includes('-0.0963') && raw.includes('25')); // parametry profilu i przesunięcie tekstury zachowane
  assert.equal(typeof rewriteSplineRecord(lines, { ...base, id: '999' }, 0, 0), 'string');
});

function setup(): { dir: string; map: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-spl-'));
  const map = path.join(dir, 'map');
  fs.mkdirSync(map, { recursive: true });
  fs.mkdirSync(path.join(dir, '_vibe', 'assets', 'Splines'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_vibe', 'assets', 'Splines', 'a.sli'), ['[path]', '0', '0', '0.1', '3', '0'].join(NL));
  fs.writeFileSync(path.join(map, 'global.cfg'), ['[map]', '3', '4', 'a.map', ''].join(NL));
  // A: (150,0)→ na północ 100 m (z 10 → 13); B zaczyna się w końcu A; C stoi osobno
  const text = [
    '[version]', '1', '',
    rec('[spline_h]', 101, 0, 102, 150, 10, 0, 0, 100, 0, [0, 2, 3, 0, 0, 0, 0, 0]),
    rec('[spline]', 102, 101, 0, 150, 13, 100, 0, 50, 0, [0, 0, 0, 0, 0, 0, 0]),
    rec('[spline]', 103, 0, 0, 220, 4, 20, 90, 30, 0, [0, 0, 0, 0, 0, 0, 0]),
    '[object]', '0', 'Sceneryobjects\\x.sco', '777', '10', '10', '0', '0', '',
  ].join(NL);
  fs.writeFileSync(path.join(map, 'a.map'), text);
  const idx = buildSplinesData([{ x: 3, y: 4, splines: parseTileSplines(text) }], () => [-1.5, 1.5], () => [[0, 0, 0]]);
  fs.writeFileSync(splinesPath(dir), JSON.stringify(idx));
  return { dir, map };
}

test('pickSplinePoints: najbliższy koniec razem z pokrywającymi się końcami innych splinów (węzeł)', () => {
  const { dir, map } = setup();
  const p = pickSplinePoints(map, (750 + 150) / 300, (1050 + 100) / 300, 3);
  assert.deepEqual(p.map((x) => `${x.splineId}:${x.end}`).sort(), ['101:end', '102:start']);
  assert.ok(Math.abs(p.find((x) => x.splineId === '101')!.z - 13) < 1e-9 && p[0].pitch !== undefined);
  assert.deepEqual(pickSplinePoints(map, 3.0, 3.5 + 50 / 300, 0.5), []); // środek splinu — żadnego końca
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applySplineEdit: przesunięcie węzła (oba spliny) + wysokość zapisują kafel, drugi koniec zostaje; indeks odświeżony; poza kafel — odmowa', () => {
  const { dir, map } = setup();
  const refs = [{ splineId: '101', end: 'end' as const, tile: 0 }, { splineId: '102', end: 'start' as const, tile: 0 }];
  const r = applySplineEdit(map, refs, 10, 5, 1);
  assert.equal(r.ok, true, r.error ?? '');
  const [a, b, c] = parseTileSplines(fs.readFileSync(path.join(map, 'a.map'), 'utf8'));
  // A: początek (150, 0) bez zmian, koniec przesunięty o (10, 5) → (160, 105); wysokość końca 14
  const e = arcEnd({ x: a.x, y: a.y, heading: a.heading, length: a.length, radius: a.radius });
  assert.ok(a.x === 150 && a.y === 0 && Math.hypot(e.x - 160, e.y - 105) < 0.01);
  assert.ok(Math.abs(a.z + a.dz - 14) < 1e-6 && a.z === 10);
  // B: początek przesunięty do (160, 105), koniec (150, 150) z azymutem 0 zostaje; płaski → [spline_h] z dz = −1 (z 14 → 13)
  const e2 = arcEnd({ x: b.x, y: b.y, heading: b.heading, length: b.length, radius: b.radius });
  assert.ok(Math.abs(b.x - 160) < 1e-3 && Math.abs(b.y - 105) < 1e-3 && Math.hypot(e2.x - 150, e2.y - 150) < 0.01);
  assert.deepEqual([b.kind, Math.round(b.z * 1e6) / 1e6, Math.round(b.dz * 1e6) / 1e6], ['spline_h', 14, -1]);
  assert.deepEqual([c.x, c.y], [220, 20]); // nieruszony
  assert.ok(fs.existsSync(path.join(map, 'a.map.bak')));
  assert.ok(fs.readFileSync(path.join(map, 'a.map'), 'utf8').includes('[object]')); // reszta pliku zachowana
  // indeks splinów odświeżony przez refreshSplinesIndex (wywoływane w procesie głównym po zapisie)
  refreshSplinesIndex(dir, map, r.tiles ?? []);
  const idx = loadMapSplines(dir)!;
  assert.equal(idx.tiles[0].s.length, 3);
  assert.ok(Math.abs(idx.tiles[0].s[1][1] - 160) < 1e-3); // początek B w indeksie przesunięty
  // za duże przesunięcie wyprowadza początek poza kafel
  assert.equal(applySplineEdit(map, [{ splineId: '103', end: 'start', tile: 0 }], 200, 0, 0).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createSpline: od końca splinu przyłącza next/prev, od dowolnego punktu nie; nowy rekord kończy się w punkcie, indeks zyskuje drogę', () => {
  const { dir, map } = setup();
  const from = { splineId: '103', end: 'end' as const, tile: 0 }; // koniec 103: (250, 20), azymut 90
  const r = createSpline(map, { from, startX: 0, startY: 0, startZ: 0, endX: (750 + 290) / 300, endY: (1050 + 50) / 300, sli: 'Splines/b.sli' });
  assert.equal(r.ok, true, r.error ?? '');
  assert.equal(r.id, String(778)); // po największym ID (777 obiekt)
  const all = parseTileSplines(fs.readFileSync(path.join(map, 'a.map'), 'utf8'));
  assert.deepEqual(all.map((s) => s.id), ['101', '102', '103', '778']);
  assert.deepEqual([all[2].next, all[3].prev, all[3].next, all[3].path], ['778', '103', '0', 'Splines/b.sli']); // parser normalizuje ukośniki
  assert.ok(fs.readFileSync(path.join(map, 'a.map'), 'utf8').includes('Splines\\b.sli')); // w pliku zostaje odwrotny ukośnik jak w OMSI
  const e = arcEnd({ x: all[3].x, y: all[3].y, heading: all[3].heading, length: all[3].length, radius: all[3].radius });
  assert.ok(Math.hypot(e.x - 290, e.y - 50) < 0.01 && Math.abs(all[3].x - 250) < 1e-3 && all[3].z === 4);
  // z początku splinu (do tyłu) i z dowolnego punktu: bez przyłączenia
  const free = createSpline(map, { from: null, startX: (750 + 20) / 300, startY: (1050 + 200) / 300, startZ: 7, endX: (750 + 80) / 300, endY: (1050 + 200) / 300, sli: 'Splines\\a.sli' });
  assert.equal(free.ok, true);
  const out = parseTileSplines(fs.readFileSync(path.join(map, 'a.map'), 'utf8'));
  const f = out[out.length - 1];
  assert.deepEqual([f.prev, f.next, f.radius, f.z, f.dz], ['0', '0', 0, 7, 0]);
  assert.ok(Math.abs(f.heading - 90) < 1e-6 && Math.abs(f.length - 60) < 1e-6);
  assert.equal(createSpline(map, { from: null, startX: 99, startY: 99, startZ: 0, endX: 99.1, endY: 99, sli: 'x.sli' }).ok, false); // poza kaflami
  assert.equal(createSpline(map, { from: null, startX: 3, startY: 3.5, startZ: 0, endX: 3.1, endY: 3.5, sli: 'zly.txt' }).ok, false);
  refreshSplinesIndex(dir, map, [0]);
  const idx = loadMapSplines(dir)!;
  assert.equal(idx.tiles[0].s.length, 5);
  assert.ok(idx.roads.some((rd) => rd.p.toLowerCase().includes('b.sli')));
  assert.equal(loadEditSplines(map, [{ splineId: '778', end: 'end', tile: 0 }])[0].id, '778');
  fs.rmSync(dir, { recursive: true, force: true });
});
