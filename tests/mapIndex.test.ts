import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assetsDir,
  buildMapIndex,
  loadMapIndex,
  normalizeAssetPath,
  parseTiles,
  safeJoin,
  scanTileAssets,
  toOverview,
} from '../src/main/core/mapIndex.ts';
import { ASSETS_NOTE, buildPrompt } from '../src/main/core/promptBuilder.ts';
import { GitRunner, setupRepo } from '../src/main/core/git.ts';
import { execFileSync } from 'node:child_process';

const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const put = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const CFG = `[name]
Test [map]

[friendlyname]
Test

[description]
Opis, w którym jest [map] w środku tekstu
[end]

[map]
0
0
Tiles\\tile_0_0.map

[map]
-1
2
Tiles\\tile_-1_2.map

[map]
Tiles\\brak.map
3
3
`;

test('parseTiles czyta współrzędne i pliki .map (także gdy nazwa pliku jest w innej linii)', () => {
  const tiles = parseTiles(CFG);
  assert.deepEqual(tiles, [
    { x: 0, y: 0, file: 'Tiles/tile_0_0.map' },
    { x: -1, y: 2, file: 'Tiles/tile_-1_2.map' },
    { x: 3, y: 3, file: 'Tiles/brak.map' },
  ]);
});

test('normalizeAssetPath i safeJoin odrzucają ścieżki wychodzące poza katalog', () => {
  assert.equal(normalizeAssetPath(' Splines\\Road\\a.sli '), 'Splines/Road/a.sli');
  assert.equal(normalizeAssetPath('..\\..\\Windows\\x.dll'), null);
  assert.equal(normalizeAssetPath('C:\\Windows\\x.dll'), null);
  assert.equal(normalizeAssetPath('   '), null);
  assert.equal(safeJoin('/a/b', 'c/d.sli'), path.resolve('/a/b/c/d.sli'));
  assert.equal(safeJoin('/a/b', '../x'), null);
});

const TILE_A = `[spline]
0
Splines\\Road\\a.sli
0
[spline_h]
1
Splines\\Road\\H.sli
[object]
5
Sceneryobjects\\Gen\\b.sco
[splineAttachement]
0
Splines\\Road\\att.sco
[attachObj]
1
Sceneryobjects\\Gen\\c.sco
[object]
6
sceneryobjects\\gen\\B.sco
[nieznany]
0
Splines\\Nie\\bierzmnie.sli
[spline]
7

[spline]
8
..\\..\\ucieczka.sli
`;

test('scanTileAssets: tylko właściwe znaczniki, ścieżka dwie linijki niżej, unikaty bez względu na wielkość liter', async () => {
  const dir = tmp('ve-scan-');
  put(path.join(dir, 'a.map'), TILE_A.replace(/\n/g, '\r\n'));
  const paths = await scanTileAssets(path.join(dir, 'a.map'));
  assert.deepEqual(paths, [
    'Splines/Road/a.sli',
    'Splines/Road/H.sli',
    'Sceneryobjects/Gen/b.sco',
    'Splines/Road/att.sco',
    'Sceneryobjects/Gen/c.sco',
  ]);
});

function fixture() {
  const omsi = tmp('ve-omsi-');
  for (const f of [
    'Splines/Road/a.sli',
    'Splines/Road/H.sli',
    'Splines/Road/att.sco',
    'Sceneryobjects/Gen/b.sco',
    'Sceneryobjects/Gen/c.sco',
    'Sceneryobjects/Gen/d.sco',
  ]) {
    put(path.join(omsi, f), `dane ${f}`);
  }
  const work = tmp('ve-work-');
  put(path.join(work, 'Warszawa', 'global.cfg'), CFG);
  put(path.join(work, 'Warszawa', 'Tiles', 'tile_0_0.map'), TILE_A);
  put(
    path.join(work, 'Warszawa', 'Tiles', 'tile_-1_2.map'),
    '[object]\n1\nSceneryobjects\\Gen\\d.sco\n[object]\n2\nSceneryobjects\\Gen\\b.sco\n[spline]\n3\nSplines\\Brak\\nie.sli\n',
  );
  return { omsi, work };
}

test('buildMapIndex: rejestr unikatów, kopie z zachowaniem ścieżek, brakujące, indeks na dysku', async () => {
  const { omsi, work } = fixture();
  const log: string[] = [];
  const idx = await buildMapIndex({ workDir: work, mapFolder: 'Warszawa', omsiDir: omsi, emit: (_s, t) => log.push(t) });

  assert.equal(idx.tiles.length, 3);
  assert.deepEqual(
    idx.tiles.map((t) => [t.x, t.y, t.exists]),
    [
      [0, 0, true],
      [3, 3, false],
      [-1, 2, true],
    ].sort((a, b) => (a[1] as number) - (b[1] as number) || (a[0] as number) - (b[0] as number)),
  );
  // 5 z kafla 0,0 + d.sco + Brak/nie.sli z kafla -1,2 (b.sco wspólny, już policzony)
  assert.equal(idx.assets.length, 7);
  assert.deepEqual(idx.missingAssets, ['Splines/Brak/nie.sli']);

  const dst = assetsDir(work);
  assert.equal(fs.readFileSync(path.join(dst, 'Splines/Road/a.sli'), 'utf-8'), 'dane Splines/Road/a.sli');
  assert.equal(fs.readFileSync(path.join(dst, 'Sceneryobjects/Gen/d.sco'), 'utf-8'), 'dane Sceneryobjects/Gen/d.sco');
  assert.ok(!fs.existsSync(path.join(dst, 'Splines/Brak')));
  // nie kopiujemy nic poza rejestrem
  const copied = fs.readdirSync(dst, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  assert.equal(copied.length, 6);
  assert.ok(log.some((l) => /skopiowano 6/.test(l)));

  const loaded = loadMapIndex(work)!;
  assert.equal(loaded.assets.length, 7);
  const view = toOverview(loaded);
  const t00 = view.tiles.find((t) => t.x === 0 && t.y === 0)!;
  assert.equal(t00.assetCount, 5);
  assert.equal(t00.missingCount, 0);
  const t = view.tiles.find((x) => x.x === -1 && x.y === 2)!;
  assert.equal(t.assetCount, 3);
  assert.equal(t.missingCount, 1);
  assert.equal(view.tiles.find((x) => x.x === 3)!.exists, false);
  assert.equal(view.missingCount, 1);

  // drugi przebieg: nic nie kopiuje ponownie
  const log2: string[] = [];
  await buildMapIndex({ workDir: work, mapFolder: 'Warszawa', omsiDir: omsi, emit: (_s, t2) => log2.push(t2) });
  assert.ok(log2.some((l) => /skopiowano 0, bez zmian 6/.test(l)));
});

test('prompt dostaje notkę o _vibe/assets tylko gdy assety istnieją', () => {
  const task = { id: '1', title: 'T', kind: 'text', data: {}, tileRange: null, pin: null, attachment: null, checked: true, status: 'active' as const, createdAt: 0, content: 'x' };
  const ctx = { mapName: 'M', mapFolder: 'F', repoUrl: 'https://github.com/u/r.git', branch: 'VibeEditor' };
  assert.ok(buildPrompt([task], { ...ctx, hasAssets: true }).includes(ASSETS_NOTE));
  assert.ok(!buildPrompt([task], ctx).includes(ASSETS_NOTE));
});

test('setupRepo wyłącza _vibe/assets z repo (lokalnie), ale _vibe/map-index.json zostaje', async () => {
  const remote = tmp('ve-remote-');
  execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: remote });
  const { omsi, work } = fixture();
  await buildMapIndex({ workDir: work, mapFolder: 'Warszawa', omsiDir: omsi, emit: () => {} });
  await setupRepo(new GitRunner(work, () => {}), { workDir: work, remoteUrl: remote, branch: 'VibeEditor' });
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'VibeEditor'], { cwd: remote, encoding: 'utf-8' });
  assert.ok(files.includes('_vibe/map-index.json'));
  assert.ok(files.includes('Warszawa/Tiles/tile_0_0.map'));
  assert.ok(!files.includes('_vibe/assets'));
  // idempotentne: reguła nie dubluje się
  await setupRepo(new GitRunner(work, () => {}), { workDir: work, remoteUrl: remote, branch: 'VibeEditor' });
  const ex = fs.readFileSync(path.join(work, '.git', 'info', 'exclude'), 'utf-8');
  assert.equal(ex.split('\n').filter((l) => l === '_vibe/assets/').length, 1);
});

// --- kodowania plików OMSI --------------------------------------------------

const enc = {
  le: (t: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]),
  be: (t: string): Buffer => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(t, 'utf16le').swap16()]),
  u8: (t: string): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t, 'utf-8')]),
};

test('scanTileAssets czyta kafle w UTF-16 LE, UTF-16 BE i UTF-8 z BOM tak samo jak ANSI', async () => {
  const dir = tmp('ve-enc-');
  const expected = [
    'Splines/Road/a.sli',
    'Splines/Road/H.sli',
    'Sceneryobjects/Gen/b.sco',
    'Splines/Road/att.sco',
    'Sceneryobjects/Gen/c.sco',
  ];
  const text = TILE_A.replace(/\n/g, '\r\n');
  for (const [name, buf] of Object.entries({ le: enc.le(text), be: enc.be(text), u8: enc.u8(text) })) {
    const f = path.join(dir, `${name}.map`);
    fs.writeFileSync(f, buf);
    assert.deepEqual(await scanTileAssets(f), expected, name);
  }
});

test('UTF-16 LE: ścieżki z polskimi znakami i duży plik (granice porcji strumienia)', async () => {
  const dir = tmp('ve-enc2-');
  let text = '';
  for (let i = 0; i < 6000; i++) text += `[object]\r\n${i}\r\nSceneryobjects\\Gen\\obj${i}.sco\r\n0\r\n`;
  text += '[spline]\r\n1\r\nSplines\\Łódź\\żółć.sli\r\n';
  fs.writeFileSync(path.join(dir, 'big.map'), enc.le(text));
  const paths = await scanTileAssets(path.join(dir, 'big.map'));
  assert.equal(paths.length, 6001);
  assert.equal(paths[6000], 'Splines/Łódź/żółć.sli');
});

test('global.cfg w UTF-16 LE: mapa jest rozpoznana, kafle odczytane, zapis zachowuje kodowanie', async () => {
  const { findMapFolders, writeMapInfo, decodeCfg } = await import('../src/main/core/globalCfg.ts');
  const omsi = tmp('ve-omsi16-');
  put(path.join(omsi, 'Splines/Road/a.sli'), 'x');
  const work = tmp('ve-work16-');
  const cfgPath = path.join(work, 'Mapa', 'global.cfg');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, enc.le(CFG.replace(/\n/g, '\r\n')));
  fs.mkdirSync(path.join(work, 'Mapa', 'Tiles'));
  fs.writeFileSync(path.join(work, 'Mapa', 'Tiles', 'tile_0_0.map'), enc.le('[spline]\r\n0\r\nSplines\\Road\\a.sli\r\n'));

  const maps = findMapFolders(work);
  assert.equal(maps.length, 1);
  assert.equal(maps[0].name, 'Test [map]');

  const idx = await buildMapIndex({ workDir: work, mapFolder: 'Mapa', omsiDir: omsi, emit: () => {} });
  assert.equal(idx.tiles.length, 3);
  assert.deepEqual(idx.assets, ['Splines/Road/a.sli']);
  assert.ok(fs.existsSync(path.join(assetsDir(work), 'Splines/Road/a.sli')));

  assert.equal(writeMapInfo(cfgPath, { name: 'Nowa', friendlyname: 'N', description: 'opis' }), true);
  const raw = fs.readFileSync(cfgPath);
  assert.deepEqual([raw[0], raw[1]], [0xff, 0xfe]);
  const back = decodeCfg(raw);
  assert.equal(back.encoding, 'utf-16le');
  assert.equal(findMapFolders(work)[0].name, 'Nowa');
  assert.equal(parseTiles(back.text).length, 3);
});

// --- rodzaje assetów i drzewo obiektów -------------------------------------

test('parseSco: [groups] to głębokość + nazwy „folderów”, [friendlyname] to nazwa (znaczniki gdziekolwiek)', async () => {
  const { parseSco } = await import('../src/main/core/mapIndex.ts');
  assert.deepEqual(parseSco('[groups]\n2\nAachen\nGruen\n\n[friendlyname]\nBusch\n'), {
    groups: ['Aachen', 'Gruen'],
    name: 'Busch',
  });
  // inna kolejność, znaczniki nie na początku, inne sekcje pomiędzy
  assert.deepEqual(parseSco('[mesh]\nx.o3d\n[friendlyname]\nBudka\n[matl]\n1\n[groups]\n1\nMiasto\n[end]\n'), {
    groups: ['Miasto'],
    name: 'Budka',
  });
  assert.deepEqual(parseSco('[groups]\n0\n[friendlyname]\nKorzeń\n'), { groups: [], name: 'Korzeń' });
  assert.deepEqual(parseSco('[mesh]\nx.o3d\n'), { groups: [], name: '' });
});

test('indeks v2: jezdnie i obiekty osobno, drzewo grup z .sco, liczba kafli, brakujące', async () => {
  const { toCatalog } = await import('../src/main/core/mapIndex.ts');
  const omsi = tmp('ve-cat-');
  put(path.join(omsi, 'Splines/Road/a.sli'), 'x');
  put(path.join(omsi, 'Splines/Road/b.sli'), 'x');
  put(path.join(omsi, 'Sceneryobjects/Aachen/busch.sco'), '[mesh]\nb.o3d\n[groups]\n2\nAachen\nGruen\n[friendlyname]\nBusch\n');
  put(path.join(omsi, 'Sceneryobjects/Gen/latarnia.sco'), '[friendlyname]\nLatarnia\n');
  const work = tmp('ve-catw-');
  put(path.join(work, 'M', 'global.cfg'), '[map]\n0\n0\nT/a.map\n[map]\n1\n0\nT/b.map\n[description]\nd\n[friendlyname]\nF\n[name]\nN\n');
  put(
    path.join(work, 'M', 'T', 'a.map'),
    '[spline]\n0\nSplines\\Road\\a.sli\n[object]\n1\nSceneryobjects\\Aachen\\busch.sco\n[splineAttachement]\n0\nSceneryobjects\\Gen\\latarnia.sco\n',
  );
  put(
    path.join(work, 'M', 'T', 'b.map'),
    '[spline_h]\n0\nSplines\\Road\\b.sli\n[spline]\n1\nSplines\\Road\\a.sli\n[attachObj]\n2\nSceneryobjects\\Brak\\nie.sco\n[object]\n3\nSceneryobjects\\Aachen\\busch.sco\n',
  );

  const idx = await buildMapIndex({ workDir: work, mapFolder: 'M', omsiDir: omsi, emit: () => {} });
  const cat = toCatalog(idx);

  assert.deepEqual(
    cat.roads.map((r) => [r.path, r.tileCount, r.missing]),
    [
      ['Splines/Road/a.sli', 2, false],
      ['Splines/Road/b.sli', 1, false],
    ],
  );
  const byPath = new Map(cat.objects.map((o) => [o.path, o]));
  assert.equal(cat.objects.length, 3);
  assert.deepEqual(byPath.get('Sceneryobjects/Aachen/busch.sco'), {
    path: 'Sceneryobjects/Aachen/busch.sco',
    name: 'Busch',
    groups: ['Aachen', 'Gruen'],
    tileCount: 2,
    missing: false,
    known: true,
  });
  assert.equal(byPath.get('Sceneryobjects/Gen/latarnia.sco')!.name, 'Latarnia');
  assert.deepEqual(byPath.get('Sceneryobjects/Gen/latarnia.sco')!.groups, []);
  const brak = byPath.get('Sceneryobjects/Brak/nie.sco')!;
  assert.equal(brak.missing, true);
  assert.equal(brak.known, false);
  assert.equal(brak.name, 'nie');
  // jezdnie nie mieszają się z obiektami
  assert.ok(!cat.roads.some((r) => r.path.endsWith('.sco')));
});
