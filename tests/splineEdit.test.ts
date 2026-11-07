import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { arcEnd, arcPoints } from '../src/shared/arcs.ts';
import { fixJointSkews, jointSkew, moveSplines, newSpline, newSplineStartAt, splineEndPose, splineEndZ, type EditSpline } from '../src/shared/splineEdit.ts';
import { parseTileSplines, buildSplinesData, loadMapSplines, splinesPath } from '../src/main/core/mapSplines.ts';
import { applySplineEdit, createSpline, deleteSplines, loadEditSplines, pickSplinePoints, refreshSplinesIndex, rewriteSplineRecord } from '../src/main/core/splineEdit.ts';

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
  assert.equal(rewriteSplineRecord(lines, { ...plain, skew0: 0.1495907, skew1: -0.0963 }, 5, 6), null);
  const sp = parseTileSplines(lines.join(NL));
  assert.deepEqual([sp[1].kind, sp[1].dz, sp[1].z, sp[1].mirror], ['spline_h', 2, 1, true]);
  const raw = lines.join(NL);
  assert.ok(raw.includes('0.1495907') && raw.includes('-0.0963') && raw.includes('25')); // skew i przesunięcie tekstury zachowane po zamianie na [spline_h]
  assert.deepEqual([sp[1].skew0, sp[1].skew1, sp[1].texOff], [0.1495907, -0.0963, 25]);
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

test('łuk wyłączony: przesuwany koniec obraca spline (prosta, zmienia się długość), zamiast go zaginać; oba końce — sztywno bez zmian', () => {
  const curved: EditSpline = { ...base, radius: 80 };
  // koniec przesunięty o (20, 0): prosta od nieruszonego początku do nowego końca
  const end = moveSplines([curved], [{ splineId: 'A', end: 'end' }], 20, 0, 0, false).splines[0];
  const e = splineEndPose(end, 'end');
  const endOld = splineEndPose(curved, 'end');
  assert.ok(end.radius === 0 && end.x === 100 && end.y === 200);
  assert.ok(Math.hypot(e.x - (endOld.x + 20), e.y - endOld.y) < 1e-6);
  assert.ok(Math.abs(end.length - Math.hypot(endOld.x + 20 - 100, endOld.y - 200)) < 1e-6);
  // początek przesunięty: prosta od nowego początku do nieruszonego końca
  const st = moveSplines([base], [{ splineId: 'A', end: 'start' }], -15, 30, 0, false).splines[0];
  const e2 = splineEndPose(st, 'end');
  assert.ok(st.radius === 0 && Math.hypot(e2.x - 100, e2.y - 300) < 1e-6 && st.x === 85 && st.y === 230);
  // oba końce: wciąż przesunięcie sztywne, łuk zostaje łukiem
  const both = moveSplines([curved], [{ splineId: 'A', end: 'start' }, { splineId: 'A', end: 'end' }], 5, 5, 0, false).splines[0];
  assert.ok(both.radius === 80 && both.length === 100);
  // koniec w miejscu początku — błąd
  assert.equal(typeof moveSplines([base], [{ splineId: 'A', end: 'end' }], 0, -100, 0, false).error, 'string');
  // nowy spline od zaznaczonego końca przy wyłączonym łuku: prosta wprost do punktu, nachylenie zachowane
  const g = newSpline(newSplineStartAt(base, 'end'), 160, 380, false);
  assert.ok(typeof g !== 'string' && g.radius === 0 && g.pitch0 === 2 && Math.abs(g.length - Math.hypot(60, 80)) < 1e-9);
  assert.ok(Math.abs(g.heading - Math.atan2(60, 80) * (180 / Math.PI)) < 1e-9);
});

test('applySplineEdit z wyłączonym łukiem zapisuje prostą (promień 0); createSpline z arc:false też', () => {
  const { dir, map } = setup();
  const r = applySplineEdit(map, [{ splineId: '101', end: 'end', tile: 0 }], 10, 0, 0, false);
  assert.equal(r.ok, true, r.error ?? '');
  const a = parseTileSplines(fs.readFileSync(path.join(map, 'a.map'), 'utf8'))[0];
  assert.equal(a.radius, 0);
  assert.ok(Math.abs(a.length - Math.hypot(10, 100)) < 1e-4);
  const c = createSpline(map, { from: { splineId: '103', end: 'end', tile: 0 }, startX: 0, startY: 0, startZ: 0, endX: (750 + 280) / 300, endY: (1050 + 60) / 300, sli: 'Splines/a.sli', arc: false });
  assert.equal(c.ok, true, c.error ?? '');
  const n = parseTileSplines(fs.readFileSync(path.join(map, 'a.map'), 'utf8')).pop()!;
  assert.equal(n.radius, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deleteSplines: usuwa rekord z blokami [rule], zeruje odnośniki innych splinów (także z innego kafla), robi .bak', () => {
  const { dir, map } = setup();
  // dopisz [rule] za splinem 102 i drugi kafel ze splinem odsyłającym do 102
  const file = path.join(map, 'a.map');
  const text = fs.readFileSync(file, 'utf8').replace(rec('[spline]', 102, 101, 0, 150, 13, 100, 0, 50, 0, [0, 0, 0, 0, 0, 0, 0]), rec('[spline]', 102, 101, 0, 150, 13, 100, 0, 50, 0, [0, 0, 0, 0, 0, 0, 0]) + NL + ['[rule]', '0', 'no_cars', '0', ''].join(NL));
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(map, 'global.cfg'), ['[map]', '3', '4', 'a.map', '[map]', '4', '4', 'b.map', ''].join(NL));
  fs.writeFileSync(path.join(map, 'b.map'), ['[version]', '1', '', rec('[spline]', 300, 102, 0, 5, 13, 5, 0, 20, 0, [0, 0, 0, 0, 0, 0, 0])].join(NL));
  const r = deleteSplines(map, [{ splineId: '102', end: 'start', tile: 0 }, { splineId: '102', end: 'end', tile: 0 }]);
  assert.equal(r.ok, true, r.error ?? '');
  assert.deepEqual(r.ids, ['102']);
  const a = fs.readFileSync(file, 'utf8');
  const sp = parseTileSplines(a);
  assert.deepEqual(sp.map((x) => x.id), ['101', '103']);
  assert.equal(sp[0].next, '0'); // 101 wskazywał na 102
  assert.ok(!a.includes('no_cars') && a.includes('[object]')); // blok [rule] usunięty razem ze splinem, obiekty zostają
  const b = parseTileSplines(fs.readFileSync(path.join(map, 'b.map'), 'utf8'));
  assert.equal(b[0].prev, '0'); // odnośnik z innego kafla wyzerowany
  assert.ok(fs.existsSync(`${file}.bak`) && fs.existsSync(path.join(map, 'b.map.bak')));
  assert.equal(deleteSplines(map, [{ splineId: '102', end: 'end', tile: 0 }]).ok, false); // już nie istnieje
  assert.equal(deleteSplines(map, []).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

import { redoLast, undoLast, undoState, clearUndo } from '../src/main/core/undo.ts';
import { alignSplines, checkSplines, pickSplinePointsInBox } from '../src/main/core/splineEdit.ts';

test('cofanie i ponawianie: przywraca dokładnie bajty kafli, odmawia po zmianie z zewnątrz, nowa operacja czyści ponawianie', () => {
  clearUndo();
  const { dir, map } = setup();
  const file = path.join(map, 'a.map');
  const original = fs.readFileSync(file);
  const refs = [{ splineId: '101', end: 'end' as const, tile: 0 }];
  assert.equal(applySplineEdit(map, refs, 4, 0, 0).ok, true);
  const edited = fs.readFileSync(file);
  assert.ok(!edited.equals(original));
  assert.deepEqual(undoState(), { undo: 'Przesunięcie punktów splinów', redo: null });
  const u = undoLast();
  assert.equal(u.ok, true);
  assert.deepEqual(u.tiles, [0]);
  assert.ok(fs.readFileSync(file).equals(original)); // bajt w bajt jak przed edycją
  assert.equal(undoState().redo, 'Przesunięcie punktów splinów');
  assert.equal(redoLast().ok, true);
  assert.ok(fs.readFileSync(file).equals(edited));
  // nowa operacja po cofnięciu czyści ponawianie
  undoLast();
  assert.equal(createSpline(map, { from: null, startX: (750 + 20) / 300, startY: (1050 + 200) / 300, startZ: 0, endX: (750 + 80) / 300, endY: (1050 + 200) / 300, sli: 'Splines/a.sli' }).ok, true);
  assert.equal(undoState().redo, null);
  assert.equal(undoState().undo, 'Nowy spline');
  // zmiana pliku poza aplikacją blokuje cofnięcie (nie nadpisujemy cudzych zmian)
  fs.appendFileSync(file, '\r\n');
  const bad = undoLast();
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /zmieniony/);
  assert.equal(undoLast().ok, false);
  clearUndo();
  assert.equal(undoLast().error, 'Nie ma nic do cofnięcia.');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('zaznaczanie prostokątem: końce splinów wewnątrz prostokąta (także z sąsiedniego kafla), poza — nie', () => {
  const { dir, map } = setup();
  const u = (m: number): number => m / 300;
  // A: (150,0)→(150,100); B: (150,100)→(150,150); C: (220,20)→(220,20+30·) — wszystkie na kaflu (3,4): lokalne + (750, 1050)
  const all = pickSplinePointsInBox(map, u(750 + 140), u(1050 - 10), u(750 + 160), u(1050 + 160));
  assert.deepEqual(all.map((p) => `${p.splineId}:${p.end}`).sort(), ['101:end', '101:start', '102:end', '102:start']);
  const mid = pickSplinePointsInBox(map, u(750 + 140), u(1050 + 90), u(750 + 160), u(1050 + 110)); // tylko węzeł 101/102
  assert.deepEqual(mid.map((p) => `${p.splineId}:${p.end}`).sort(), ['101:end', '102:start']);
  assert.equal(pickSplinePointsInBox(map, u(750 + 260), u(1050 + 260), u(750 + 290), u(1050 + 290)).length, 0);
  assert.equal(pickSplinePointsInBox(map, u(750 + 160), u(1050 + 110), u(750 + 140), u(1050 + 90)).length, 2); // rogi w odwrotnej kolejności
  fs.rmSync(dir, { recursive: true, force: true });
});

test('kontrola spójności: wykrywa załamek nachylenia, skok wysokości i przerwę; wyrównanie usuwa wysokość/nachylenie/skew', () => {
  clearUndo();
  const { dir, map } = setup();
  // setup(): A kończy się z nachyleniem 2°, a B (płaski) zaczyna się z 0° — to prawdziwy załamek nachylenia
  let issues = checkSplines(map);
  assert.deepEqual(issues.map((i) => i.kind), ['pitch']);
  assert.equal(issues[0].fixable, true);
  assert.deepEqual([issues[0].a.splineId, issues[0].a.end, issues[0].b?.splineId, issues[0].b?.end], ['101', 'end', '102', 'start']);
  assert.ok(Math.abs(issues[0].x - (750 + 150) / 300) < 1e-9 && Math.abs(issues[0].y - (1050 + 100) / 300) < 1e-9);
  // podnieś koniec A o 1 m (skok wysokości) i odsuń go w bok (przerwa)
  assert.equal(applySplineEdit(map, [{ splineId: '101', end: 'end', tile: 0 }], 0.5, 0, 1).ok, true);
  issues = checkSplines(map);
  assert.deepEqual(issues.map((i) => i.kind).sort(), ['gap', 'heading', 'height', 'pitch']);
  // wyrównanie: wysokość, nachylenie (i skew) — przerwa i azymut zostają (nie są naprawiane automatycznie)
  const r = alignSplines(map, { splineId: '101', end: 'end', tile: 0 }, { splineId: '102', end: 'start', tile: 0 });
  assert.equal(r.ok, true, r.error ?? '');
  issues = checkSplines(map);
  assert.deepEqual(issues.map((i) => i.kind).sort(), ['gap', 'heading']);
  const [a, b] = parseTileSplines(fs.readFileSync(path.join(map, 'a.map'), 'utf8'));
  assert.ok(Math.abs(a.z + a.dz - b.z) < 1e-6 && Math.abs(a.pitch1 - b.pitch0) < 1e-6 && b.kind === 'spline_h'); // płaski B zamienił się w [spline_h]
  assert.ok(Math.abs(a.pitch1 - 1) < 1e-6); // średnia z 2° i 0°
  assert.equal(undoState().undo, 'Wyrównanie połączenia splinów');
  // odnośnik do nieistniejącego splinu i asymetria
  const file = path.join(map, 'a.map');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(rec('[spline]', 103, 0, 0, 220, 4, 20, 90, 30, 0, [0, 0, 0, 0, 0, 0, 0]), rec('[spline]', 103, 555, 0, 220, 4, 20, 90, 30, 0, [0, 0, 0, 0, 0, 0, 0])));
  assert.ok(checkSplines(map).some((i) => i.kind === 'missing' && i.a.splineId === '103' && i.a.end === 'start' && i.b === null));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('indeks splinów po usunięciu wszystkich splinów kafla nie zostaje nieaktualny; po cofnięciu wraca', () => {
  clearUndo();
  const { dir, map } = setup();
  const refs = ['101', '102', '103'].map((id) => ({ splineId: id, end: 'start' as const, tile: 0 }));
  const d = deleteSplines(map, refs);
  assert.equal(d.ok, true, d.error ?? '');
  refreshSplinesIndex(dir, map, d.tiles ?? []);
  assert.equal(loadMapSplines(dir)!.tiles.length, 0);
  const u = undoLast();
  assert.equal(u.ok, true);
  refreshSplinesIndex(dir, map, u.tiles ?? []);
  assert.equal(loadMapSplines(dir)!.tiles[0].s.length, 3);
  clearUndo();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skew z prawdziwych danych: A.skew końca = −tan(Δ/2), B.skew początku = +tan(Δ/2) (róg chodnika o ok. 95,5°)', () => {
  const text = [
    rec('[spline]', 1, 0, 2, 0, 0, 0, 0, 10, 0, [0, 0, 0, 0, 0.4420748, -1.100772, 25]),
    rec('[spline]', 2, 1, 0, 0, 0, 10, 95.4908, 10, 0, [0, 0, 0, 0, 1.100772, 0, 35]),
  ].join(NL);
  const [a, b] = parseTileSplines(text);
  assert.deepEqual([a.skew0, a.skew1, a.texOff, b.skew0, b.skew1, b.texOff], [0.4420748, -1.100772, 25, 1.100772, 0, 35]);
  assert.ok(Math.abs(jointSkew(95.4908) - 1.100772) < 2e-4);
  // spline_h: skew w polach 5 i 6 ogona, przesunięcie tekstury w 7
  const h = parseTileSplines(rec('[spline_h]', 3, 0, 0, 0, 0, 0, 0, 10, 0, [1, 2, 3, 0, 0, 0.5, -0.5, 7]))[0];
  assert.deepEqual([h.pitch0, h.pitch1, h.dz, h.skew0, h.skew1, h.texOff], [1, 2, 3, 0.5, -0.5, 7]);
  // fixJointSkews odtwarza te wartości z geometrii (wzajemne odnośniki prev/next)
  const mk = (id: string, prev: string, next: string, y: number, hd: number): EditSpline => ({ ...base, id, prev, next, x: 0, y, heading: hd, length: 10, radius: 0, kind: 'spline', dz: 0, pitch0: 0, pitch1: 0 });
  const A = mk('1', '0', '2', 0, 0);
  const B = mk('2', '1', '0', 10, 95.4908);
  const r = fixJointSkews([A], (id) => (id === '2' ? B : undefined));
  const [ra, rb] = [r.find((s) => s.id === '1')!, r.find((s) => s.id === '2')!];
  assert.ok(Math.abs(ra.skew1 + 1.100772) < 2e-4 && Math.abs(rb.skew0 - 1.100772) < 2e-4);
  // brak wzajemności odnośników = brak styku do dopasowania
  assert.deepEqual(fixJointSkews([A], () => ({ ...B, prev: '0' })).map((s) => s.id), ['1']);
  assert.equal(jointSkew(0), 0);
});

test('G zmienia azymut końca: skew splinu i jego następnika/poprzednika ustawia się z załamka; usunięcie następnika zeruje skew sąsiada', () => {
  clearUndo();
  const { dir, map } = setup();
  const file = path.join(map, 'a.map');
  // 101 → 102 (wzajemne odnośniki); przesuń koniec 101 o (12, 0): azymut końca 101 się zmienia, 102 ma azymut 0 → załamek
  assert.equal(applySplineEdit(map, [{ splineId: '101', end: 'end', tile: 0 }], 12, 0, 0).ok, true);
  let [a, b] = parseTileSplines(fs.readFileSync(file, 'utf8'));
  const endHeading = arcEnd({ x: a.x, y: a.y, heading: a.heading, length: a.length, radius: a.radius }).heading;
  const d = ((b.heading - endHeading + 540) % 360) - 180;
  assert.ok(Math.abs(d) > 1);
  assert.ok(Math.abs(a.skew1 + Math.tan((d * Math.PI) / 360)) < 1e-5, `a.skew1=${a.skew1} d=${d}`);
  assert.ok(Math.abs(b.skew0 - Math.tan((d * Math.PI) / 360)) < 1e-5);
  // obrót prostą (Alt): też aktualizuje skew po obu stronach
  clearUndo();
  assert.equal(applySplineEdit(map, [{ splineId: '102', end: 'end', tile: 0 }], 15, 0, 0, false).ok, true);
  [a, b] = parseTileSplines(fs.readFileSync(file, 'utf8'));
  const e2 = arcEnd({ x: a.x, y: a.y, heading: a.heading, length: a.length, radius: a.radius }).heading;
  const d2 = ((b.heading - e2 + 540) % 360) - 180;
  assert.ok(Math.abs(a.skew1 + Math.tan((d2 * Math.PI) / 360)) < 1e-5 && Math.abs(b.skew0 - Math.tan((d2 * Math.PI) / 360)) < 1e-5);
  // usunięcie splinu 102: skew końca 101 wraca do 0 (koniec już nie ma sąsiada)
  assert.equal(deleteSplines(map, [{ splineId: '102', end: 'start', tile: 0 }]).ok, true);
  a = parseTileSplines(fs.readFileSync(file, 'utf8'))[0];
  assert.equal(a.next, '0');
  assert.equal(a.skew1, 0);
  clearUndo();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ścięcie końców wg skew: krawędzie sąsiednich splinów schodzą się w tych samych punktach (miter), po stronie wewnętrznej krótsze', () => {
  // A: na północ 10 m od (0,0); B: od (0,10) skręt o Δ w prawo (azymut Δ), prosta 10 m; szerokość pasa u ∈ [−1, 1] (w prawo +)
  for (const delta of [30, 95.4908, -60, 150]) {
    const A = { x: 0, y: 0, heading: 0, radius: 0, length: 10 };
    const B = { x: 0, y: 10, heading: delta, radius: 0, length: 10 };
    const k = jointSkew(delta);
    const sk1 = -k; // skew końca A
    const sk0 = k; // skew początku B
    for (const u of [-1, 1, 0.4]) {
      // koniec krawędzi A: oś przesunięta o skew·u do przodu; początek krawędzi B: też o skew·u do przodu
      const ea = arcPoints(A.x, A.y, A.heading, A.radius, A.length + sk1 * u, u).pop()!;
      const sb = arcPoints(B.x, B.y, B.heading, B.radius, sk0 * u, u).pop() ?? [B.x, B.y];
      const sbPoint = sk0 * u === 0 ? [B.x + Math.cos((B.heading * Math.PI) / 180) * u, B.y - Math.sin((B.heading * Math.PI) / 180) * u] : sb;
      assert.ok(Math.hypot(ea[0] - sbPoint[0], ea[1] - sbPoint[1]) < 1e-9, `Δ=${delta}, u=${u}`);
    }
    // przy skręcie w prawo (Δ > 0) prawa krawędź A (u = 1) kończy się wcześniej niż lewa (u = −1)
    const right = A.length + sk1 * 1;
    const left = A.length + sk1 * -1;
    assert.equal(delta > 0 ? right < left : right > left, true);
  }
});

test('kontrola spójności: skew niezgodny z załamkiem azymutu jest zgłaszany jako naprawialny, a wyrównanie ustawia go z geometrii', () => {
  clearUndo();
  const { dir, map } = setup();
  const file = path.join(map, 'a.map');
  // 103 → nowy spline 104 pod kątem ~90° z wzajemnymi odnośnikami, ale ze skew 0 (tak, jakby ktoś ustawił je ręcznie)
  const text = fs.readFileSync(file, 'utf8').replace(rec('[spline]', 103, 0, 0, 220, 4, 20, 90, 30, 0, [0, 0, 0, 0, 0, 0, 0]), rec('[spline]', 103, 0, 104, 220, 4, 20, 90, 30, 0, [0, 0, 0, 0, 0, 0, 0]) + NL + rec('[spline]', 104, 103, 0, 250, 4, 20, 180, 20, 0, [0, 0, 0, 0, 0, 0, 0]));
  fs.writeFileSync(file, text);
  let issues = checkSplines(map).filter((i) => i.a.splineId === '103');
  assert.deepEqual(issues.map((i) => i.kind), ['heading', 'skew']);
  assert.ok(issues.find((i) => i.kind === 'skew')!.fixable);
  assert.equal(alignSplines(map, { splineId: '103', end: 'end', tile: 0 }, { splineId: '104', end: 'start', tile: 0 }).ok, true);
  const all = parseTileSplines(fs.readFileSync(file, 'utf8'));
  const [s103, s104] = [all.find((s) => s.id === '103')!, all.find((s) => s.id === '104')!];
  assert.ok(Math.abs(s103.skew1 + 1) < 1e-6 && Math.abs(s104.skew0 - 1) < 1e-6); // zakręt o 90° → tan(45°) = 1
  issues = checkSplines(map).filter((i) => i.a.splineId === '103');
  assert.deepEqual(issues.map((i) => i.kind), ['heading']); // załamek azymutu zostaje (to geometria), skew jest już zgodny
  clearUndo();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('indeks splinów zawiera różnicę wysokości (do kolejności warstw) i skew, przesunięcie tekstury', () => {
  const { dir } = setup();
  const s = loadMapSplines(dir)!.tiles[0].s;
  // [droga, x, y, azymut, długość, promień, odbicie, z, skew początku, skew końca, przesunięcie tekstury, dz]
  assert.equal(s[0].length, 12);
  assert.deepEqual([s[0][7], s[0][11]], [10, 3]);
  assert.deepEqual([s[1][7], s[1][11]], [13, 0]); // zwykły [spline] jest płaski
  fs.rmSync(dir, { recursive: true, force: true });
});
