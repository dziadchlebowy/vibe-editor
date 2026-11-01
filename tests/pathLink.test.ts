import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { arcEnd, biarc, buildNode, createLink, getLinkNode, hermite, pickLinkNode, planConnector, planLink, type Pose } from '../src/main/core/pathLink.ts';
import { parseTileSplines } from '../src/main/core/mapSplines.ts';
import { splinePath } from '../src/main/core/tripRoute.ts';

const NL = '\r\n';
const angDiff = (a: number, b: number): number => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

test('biarc: kończy dokładnie w pozycji i azymucie węzła dla wielu par pozycji', () => {
  const cases: [Pose, Pose][] = [
    [{ x: 0, y: 0, heading: 0 }, { x: 0, y: 100, heading: 0 }], // prosta
    [{ x: 0, y: 0, heading: 0 }, { x: 30, y: 40, heading: 73.7398 }], // jeden łuk (zgodny kąt cięciwy)
    [{ x: 0, y: 0, heading: 0 }, { x: 20, y: 60, heading: 0 }], // esownica (równoległe, przesunięte)
    [{ x: 0, y: 0, heading: 30 }, { x: 80, y: 20, heading: 140 }],
    [{ x: 10, y: -5, heading: 200 }, { x: -60, y: -90, heading: 270 }],
    [{ x: 0, y: 0, heading: 90 }, { x: 50, y: -50, heading: 180 }],
  ];
  for (const [p1, p2] of cases) {
    const arcs = biarc(p1, p2);
    assert.ok(Array.isArray(arcs), `${JSON.stringify([p1, p2])}: ${String(arcs)}`);
    const e = arcEnd(arcs[arcs.length - 1]);
    assert.ok(Math.hypot(e.x - p2.x, e.y - p2.y) < 0.05, `pozycja ${JSON.stringify([p1, p2])}`);
    assert.ok(angDiff(e.heading, p2.heading) < 0.3, `azymut ${JSON.stringify([p1, p2])}`);
    // ciągłość: początek drugiego łuku = koniec pierwszego (położenie i azymut)
    if (arcs.length === 2) {
      const j = arcEnd(arcs[0]);
      assert.ok(Math.hypot(j.x - arcs[1].x, j.y - arcs[1].y) < 0.01);
      assert.ok(angDiff(j.heading, arcs[1].heading) < 0.05);
    }
  }
  assert.equal(biarc({ x: 0, y: 0, heading: 0 }, { x: 0, y: 100, heading: 0 })!.length, 1);
  assert.equal((biarc({ x: 0, y: 0, heading: 0 }, { x: 20, y: 60, heading: 0 }) as unknown[]).length, 2);
  assert.equal(typeof biarc({ x: 0, y: 0, heading: 0 }, { x: 0.01, y: 0, heading: 0 }), 'string'); // ten sam punkt
  assert.equal(typeof biarc({ x: 0, y: 0, heading: 0 }, { x: 0, y: -100, heading: 0 }), 'string'); // węzeł za plecami
});

test('hermite: wysokość i nachylenia na końcach zgodne z zadanymi', () => {
  const f = hermite(80, 1.5, -0.5, 2.4);
  assert.ok(Math.abs(f(0).h) < 1e-12 && Math.abs(f(80).h - 2.4) < 1e-9);
  assert.ok(Math.abs(Math.atan(f(0).slope) * (180 / Math.PI) - 1.5) < 1e-9);
  assert.ok(Math.abs(Math.atan(f(80).slope) * (180 / Math.PI) + 0.5) < 1e-9);
});

test('planConnector: ciągła wysokość i nachylenie na styku łuków, skew liniowy', () => {
  const from = { x: 0, y: 0, heading: 0, z: 10.1, pitch: 2, skew: 1 };
  const to = { x: 20, y: 60, heading: 0, z: 13.1, pitch: 0.5, skew: 3 };
  const s = planConnector(from, to, 0.1);
  assert.ok(Array.isArray(s) && s.length === 2);
  assert.ok(Math.abs(s[0].z - 10) < 1e-9); // oś o wysokość ścieżki niżej niż punkt ścieżki
  assert.equal(s[0].pitch0, 2);
  assert.equal(s[1].pitch1, 0.5);
  assert.ok(Math.abs(s[0].pitch1 - s[1].pitch0) < 1e-9);
  assert.ok(Math.abs(s[0].z + s[0].dz - s[1].z) < 1e-9);
  assert.ok(Math.abs(s[0].dz + s[1].dz - 3) < 1e-9);
  assert.equal(s[0].skew0, 1);
  assert.equal(s[1].skew1, 3);
  assert.ok(Math.abs(s[0].skew1 - s[1].skew0) < 1e-9 && s[0].skew1 > 1 && s[0].skew1 < 3);
});

const fields = (v: (string | number)[]): string[] => v.map(String);
const splineH = (id: number, prev: number, next: number, x: number, z: number, y: number, hd: number, len: number, rad: number, tail: number[], mirror = false): string =>
  ['[spline_h]', '0', 'Splines\\a.sli', ...fields([id, prev, next, x, z, y, hd, len, rad, ...tail]), ...(mirror ? ['mirror'] : []), ''].join(NL);

test('parseTileSplines: prev/next, kind, nachylenia, dz i skew z prawdziwych wpisów (wiadukt Warszawa 2008)', () => {
  const tile = [
    '[spline_h]', '0', 'Splines\\Warszawa_2008\\2008_wiadukt_plyty_0prawy.sli', '1567288', '0', '1575183', '1.5', '0.0002538251', '2.5', '10', '75.92335', '-34.917',
    '0.08449928', '3.530061', '3.731116', '0', '0', '0', '0', '0.5839958', 'mirror', '',
    '[spline_h]', '0', 'Splines\\Warszawa_2008\\2008_szersza_jezdnia.sli', '1575183', '1567288', '1567348', '5', '3.73137', '6', '20', '14.26734', '-34.91699',
    '3.530061', '0.01601577', '0.2686207', '0', '0', '0', '0', '76.50734', 'mirror', '',
    '[spline]', '0', 'Splines\\a.sli', '77', '0', '0', '1', '4', '2', '3', '10', '0', '0', '0', '0', '0', '0', '0', '5', '',
  ].join(NL);
  const [a, b, c] = parseTileSplines(tile);
  assert.deepEqual([a.kind, a.prev, a.next, a.pitch0, a.pitch1, a.dz, a.mirror], ['spline_h', '0', '1575183', 0.08449928, 3.530061, 3.731116, true]);
  assert.equal(b.pitch0, a.pitch1); // nachylenie ciągłe między sąsiednimi splinami
  assert.ok(Math.abs(a.z + a.dz - b.z) < 0.001); // wysokość końca = wysokość początku następnego
  assert.deepEqual([c.kind, c.pitch0, c.dz, c.skew0], ['spline', 0, 0, 0]);
});

test('kierunek ścieżki: odbity spline (mirror) odwraca kierunek ruchu, tak samo jak kierunek 1 w .sli; oba naraz się znoszą', () => {
  const base = { prev: '0', next: '0', kind: 'spline' as const, pitch0: 0, pitch1: 0, dz: 0, skew0: 0, skew1: 0, path: 'a.sli', id: '1', x: 10, y: 20, z: 0, heading: 0, length: 50, radius: 0 };
  const fwd = ['[path]', '0', '0', '0', '2.5', '0'].join(NL);
  const rev = ['[path]', '0', '0', '0', '2.5', '1'].join(NL);
  const ys = (mirror: boolean, sli: string): number[] => splinePath({ ...base, mirror }, sli, 0).pts.map((p) => p[1]);
  assert.deepEqual(ys(false, fwd), [20, 70]);
  assert.deepEqual(ys(true, fwd), [70, 20]);
  assert.deepEqual(ys(false, rev), [70, 20]);
  assert.deepEqual(ys(true, rev), [20, 70]);
  const t = { x: 0, y: 0, file: 'a.map' };
  const exits = (mirror: boolean, sli: string, end: 'start' | 'end'): boolean => buildNode({ ...base, mirror }, t, 0, 'a.sli', 0, [0, 0, 0.1, 2.5, sli === rev ? 1 : 0], end).exits;
  assert.equal(exits(false, fwd, 'end'), true);
  assert.equal(exits(false, fwd, 'start'), false);
  assert.equal(exits(true, fwd, 'end'), false);
  assert.equal(exits(true, rev, 'end'), true);
});

test('łączenie: dopisuje spline’y za ostatnim, przyłącza wolne końce, kończy w węźle docelowym; kafel zachowuje kodowanie', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-link-'));
  const map = path.join(dir, 'map');
  fs.mkdirSync(map, { recursive: true });
  fs.mkdirSync(path.join(dir, '_vibe', 'assets', 'Splines'), { recursive: true });
  const assets = path.join(dir, '_vibe', 'assets', 'Splines');
  fs.writeFileSync(path.join(assets, 'a.sli'), ['[path]', '0', '0', '0.1', '3', '0'].join(NL));
  fs.writeFileSync(path.join(assets, 'invis_street.sli'), ['Invisible Street', '', '[path]', '0', '0', '0.100', '3', '0', ''].join(NL));
  fs.writeFileSync(path.join(map, 'global.cfg'), ['[map]', '3', '4', 'a.map', ''].join(NL));
  const header = ['[version]', '1', ''].join(NL);
  const A = splineH(101, 0, 0, 150, 10, 0, 0, 100, 0, [0, 2, 3, 0, 0, 0, 0, 0]);
  const B = splineH(102, 0, 0, 200, 14, 160, 30, 50, 0, [1.5, 1.5, 0, 0, 0, 0, 0, 0]);
  const tail = ['[rule]', '0', 'no_cars', '0', '', '[object]', '0', 'Sceneryobjects\\x.sco', '777', '10', '10', '0', '0', '0', '0', '0', ''].join(NL);
  const text = [header, A, B, tail].join(NL);
  fs.writeFileSync(path.join(map, 'a.map'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])); // UTF-16LE z BOM jak w OMSI

  const nA = pickLinkNode(dir, map, (750 + 150) / 300, (1050 + 100) / 300, 3);
  assert.ok(nA);
  assert.deepEqual([nA.splineId, nA.end, nA.pathIndex, nA.exits, nA.linked], ['101', 'end', 0, true, '0']);
  assert.ok(Math.abs(nA.height - 13.1) < 1e-9 && nA.pitch === 2); // wysokość końca = z + dz + wysokość ścieżki
  const refB = { splineId: '102', pathIndex: 0, end: 'start' as const, tile: 0 };
  const nB = getLinkNode(dir, map, refB);
  assert.ok(nB && Math.abs(nB.height - 14.1) < 1e-9 && nB.pitch === 1.5);

  // plan: kolejność wskazania dowolna
  const plan = planLink(dir, map, refB, nA);
  assert.equal(plan.error, undefined);
  assert.equal(plan.from?.splineId, '101');
  assert.equal(plan.to?.splineId, '102');
  assert.equal(plan.suggestReverse, false);
  assert.ok(plan.length > Math.hypot(50, 60));
  assert.equal(planLink(dir, map, nA, nA).error?.includes('końcach') ?? false, true);

  const res = createLink(dir, map, nA, refB, true);
  assert.equal(res.ok, true, res.error ?? '');
  assert.deepEqual(res.ids, ['778', '779']); // po największym ID (777 obiekt)
  assert.ok(fs.existsSync(path.join(map, 'a.map.bak')));
  const raw = fs.readFileSync(path.join(map, 'a.map'));
  assert.deepEqual([raw[0], raw[1]], [0xff, 0xfe]); // kodowanie zachowane
  const out = raw.subarray(2).toString('utf16le');
  const all = parseTileSplines(out);
  assert.deepEqual(all.map((s) => s.id), ['101', '102', '778', '779']); // dopisane na końcu listy splinów
  const [a, b, c1, c2] = all;
  assert.equal(a.next, '778');
  assert.equal(b.prev, '779');
  assert.deepEqual([c1.prev, c1.next, c2.prev, c2.next], ['101', '779', '778', '102']);
  assert.ok(out.indexOf('[object]') > out.indexOf('778')); // przed obiektami, a bloki [rule] zostają przy swoich splinach
  assert.ok(c1.mirror && c2.mirror && c1.path.toLowerCase().endsWith('invis_street.sli'));
  // początek łączenia = koniec A (150, 100, z = 13.1 − 0.1, nachylenie 2°), koniec = początek B (200, 160, z = 14, nachylenie 1,5°)
  assert.ok(Math.abs(c1.x - 150) < 1e-3 && Math.abs(c1.y - 100) < 1e-3 && angDiff(c1.heading, 0) < 0.01);
  assert.ok(Math.abs(c1.z - 13) < 1e-4 && c1.pitch0 === 2);
  assert.ok(Math.abs(c1.pitch1 - c2.pitch0) < 1e-4 && Math.abs(c1.z + c1.dz - c2.z) < 1e-4);
  assert.ok(c2.pitch1 === 1.5 && Math.abs(c2.z + c2.dz - 14) < 1e-4);
  const e = arcEnd({ x: c2.x, y: c2.y, heading: c2.heading, length: c2.length, radius: c2.radius });
  assert.ok(Math.hypot(e.x - 200, e.y - 160) < 0.01 && angDiff(e.heading, 30) < 0.05);
  // ten sam węzeł jest teraz zajęty: kolejne łączenie nie przyłącza, a ostrzega
  const again = planLink(dir, map, nA, refB);
  assert.equal(again.warnings.filter((w) => w.includes('już przyłączony')).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
