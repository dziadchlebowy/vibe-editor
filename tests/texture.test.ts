import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseSliProfile, texturePatternMatrix } from '../src/shared/sli.ts';
import { averageColor, decodeBmp, decodeDds, decodeImage, decodeTga, downscale, resolveTexture } from '../src/main/core/texture.ts';

const px = (img: { w: number; data: Uint8Array }, x: number, y: number): number[] => [...img.data.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4)];

function bmp24(w: number, h: number, rowsTopDown: number[][][]): Buffer {
  // rowsTopDown[y][x] = [r, g, b]; plik zapisuje wiersze od dołu, BGR, wiersz dopełniony do 4 bajtów
  const stride = Math.ceil((w * 3) / 4) * 4;
  const body = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (h - 1 - y) * stride + x * 3;
    const [r, g, b] = rowsTopDown[y][x];
    body[o] = b;
    body[o + 1] = g;
    body[o + 2] = r;
  }
  const head = Buffer.alloc(54);
  head.write('BM', 0, 'latin1');
  head.writeUInt32LE(54 + body.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(w, 18);
  head.writeInt32LE(h, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  return Buffer.concat([head, body]);
}

test('BMP 24 bpp: kolejność wierszy (od dołu), BGR→RGBA, dopełnienie wierszy', () => {
  const img = decodeBmp(bmp24(3, 2, [[[255, 0, 0], [0, 255, 0], [0, 0, 255]], [[10, 20, 30], [40, 50, 60], [255, 255, 255]]]))!;
  assert.deepEqual([img.w, img.h], [3, 2]);
  assert.deepEqual(px(img, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(img, 2, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(img, 1, 1), [40, 50, 60, 255]);
  assert.equal(decodeBmp(Buffer.from('nie bmp')), null);
});

test('TGA: nieskompresowany od góry, RLE od dołu (odwrócone wiersze), 32 bpp z alfa', () => {
  const head = (type: number, w: number, h: number, bpp: number, desc: number): Buffer => {
    const b = Buffer.alloc(18);
    b[2] = type;
    b.writeUInt16LE(w, 12);
    b.writeUInt16LE(h, 14);
    b[16] = bpp;
    b[17] = desc;
    return b;
  };
  const raw = Buffer.concat([head(2, 2, 1, 24, 0x20), Buffer.from([0, 0, 255, 0, 255, 0])]); // BGR: czerwony, zielony
  const a = decodeTga(raw)!;
  assert.deepEqual([px(a, 0, 0), px(a, 1, 0)], [[255, 0, 0, 255], [0, 255, 0, 255]]);
  // RLE: 2×2, pierwszy wiersz w pliku (dolny): powtórzony niebieski ×2; drugi (górny): dwa osobne piksele
  const rle = Buffer.concat([head(10, 2, 2, 24, 0), Buffer.from([0x81, 255, 0, 0]), Buffer.from([0x01, 0, 0, 255, 0, 255, 0])]);
  const b = decodeTga(rle)!;
  assert.deepEqual([px(b, 0, 1), px(b, 1, 1)], [[0, 0, 255, 255], [0, 0, 255, 255]]); // dolny wiersz = niebieski
  assert.deepEqual([px(b, 0, 0), px(b, 1, 0)], [[255, 0, 0, 255], [0, 255, 0, 255]]); // górny
  const withAlpha = decodeTga(Buffer.concat([head(2, 1, 1, 32, 0x28), Buffer.from([1, 2, 3, 128])]))!;
  assert.deepEqual(px(withAlpha, 0, 0), [3, 2, 1, 128]);
});

function ddsHeader(w: number, h: number, fourCC: string): Buffer {
  const b = Buffer.alloc(128);
  b.write('DDS ', 0, 'latin1');
  b.writeUInt32LE(124, 4);
  b.writeUInt32LE(h, 12);
  b.writeUInt32LE(w, 16);
  b.writeUInt32LE(32, 76);
  b.writeUInt32LE(0x4, 80);
  b.write(fourCC, 84, 'latin1');
  return b;
}

test('DDS: DXT1 (4 kolory, przezroczysty tryb 3 kolorów), DXT5 (alfa interpolowana), nieskompresowany 32 bpp', () => {
  const block = (c0: number, c1: number, idx: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeUInt16LE(c0, 0);
    b.writeUInt16LE(c1, 2);
    b.writeUInt32LE(idx >>> 0, 4);
    return b;
  };
  // dwa bloki obok siebie: czerwony (indeks 0) i niebieski (indeks 1 = c1)
  const dxt1 = decodeDds(Buffer.concat([ddsHeader(8, 4, 'DXT1'), block(0xf800, 0x001f, 0), block(0xf800, 0x001f, 0x55555555)]))!;
  assert.deepEqual(px(dxt1, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(dxt1, 7, 3), [0, 0, 255, 255]);
  // c0 <= c1: tryb 3 kolorów, indeks 3 = przezroczysty
  const t = decodeDds(Buffer.concat([ddsHeader(4, 4, 'DXT1'), block(0x001f, 0xf800, 0xffffffff)]))!;
  assert.equal(px(t, 1, 1)[3], 0);
  // DXT5: alfa a0 = 255, a1 = 0, indeks 0 = 255, indeks 1 = 0; kolor czerwony
  const alphaBlock = (idx3: number): Buffer => {
    const b = Buffer.alloc(8);
    b[0] = 255;
    b[1] = 0;
    let bits = 0n;
    for (let i = 0; i < 16; i++) bits |= BigInt(idx3) << BigInt(3 * i);
    for (let i = 0; i < 6; i++) b[2 + i] = Number((bits >> BigInt(8 * i)) & 0xffn);
    return b;
  };
  const d5a = decodeDds(Buffer.concat([ddsHeader(4, 4, 'DXT5'), alphaBlock(0), block(0xf800, 0, 0)]))!;
  const d5b = decodeDds(Buffer.concat([ddsHeader(4, 4, 'DXT5'), alphaBlock(1), block(0xf800, 0, 0)]))!;
  assert.deepEqual(px(d5a, 2, 2), [255, 0, 0, 255]);
  assert.deepEqual(px(d5b, 2, 2), [255, 0, 0, 0]);
  // nieskompresowany BGRA 2×1
  const h = Buffer.alloc(128);
  h.write('DDS ', 0, 'latin1');
  h.writeUInt32LE(1, 12);
  h.writeUInt32LE(2, 16);
  h.writeUInt32LE(0x41, 80);
  h.writeUInt32LE(32, 88);
  h.writeUInt32LE(0xff0000, 92);
  h.writeUInt32LE(0xff00, 96);
  h.writeUInt32LE(0xff, 100);
  h.writeUInt32LE(0xff000000, 104);
  const u = decodeDds(Buffer.concat([h, Buffer.from([0, 0, 255, 255, 255, 0, 0, 128])]))!; // BGRA: czerwony; niebieski półprzezroczysty
  assert.deepEqual([px(u, 0, 0), px(u, 1, 0)], [[255, 0, 0, 255], [0, 0, 255, 128]]);
  assert.equal(decodeDds(Buffer.concat([ddsHeader(4, 4, 'XXXX'), Buffer.alloc(16)])), null);
});

test('decodeImage dobiera dekoder po zawartości, downscale uśrednia, averageColor waży przezroczystością', () => {
  const b = bmp24(2, 2, [[[255, 0, 0], [255, 0, 0]], [[0, 0, 255], [0, 0, 255]]]);
  const img = decodeImage(b, 'x.dat')!;
  assert.equal(img.w, 2);
  const small = downscale(img, 1);
  assert.deepEqual([small.w, small.h], [1, 1]);
  assert.deepEqual(px(small, 0, 0), [128, 0, 128, 255]);
  assert.deepEqual(averageColor(img), [128, 0, 128]);
  assert.deepEqual(averageColor({ w: 2, h: 1, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0]) }), [255, 0, 0]); // przezroczysty zielony się nie liczy
  assert.equal(decodeImage(Buffer.from('xxxx'), 'a.png'), null);
});

test('resolveTexture: folder texture obok .sli, wielkość liter i zamienne rozszerzenia, podfolder w nazwie, Texture OMSI', () => {
  const omsi = fs.mkdtempSync(path.join(os.tmpdir(), 've-omsi-'));
  fs.mkdirSync(path.join(omsi, 'Splines', 'Marcel', 'texture'), { recursive: true });
  fs.mkdirSync(path.join(omsi, 'Texture', 'Foo'), { recursive: true });
  fs.writeFileSync(path.join(omsi, 'Splines', 'Marcel', 'texture', 'Grass.DDS'), 'x');
  fs.writeFileSync(path.join(omsi, 'Texture', 'Foo', 'bar.tga'), 'x');
  fs.writeFileSync(path.join(omsi, 'Texture', 'asfalt.bmp'), 'x');
  assert.equal(resolveTexture(omsi, 'Splines/Marcel/x.sli', 'grass.bmp'), path.join(omsi, 'Splines', 'Marcel', 'texture', 'Grass.DDS'));
  assert.equal(resolveTexture(omsi, 'Splines/Marcel/x.sli', 'Foo\\bar.bmp'), path.join(omsi, 'Texture', 'Foo', 'bar.tga'));
  assert.equal(resolveTexture(omsi, 'Splines/x.sli', 'ASFALT.BMP'), path.join(omsi, 'Texture', 'asfalt.bmp'));
  assert.equal(resolveTexture(omsi, 'Splines/x.sli', 'brak.bmp'), null);
  fs.rmSync(omsi, { recursive: true, force: true });
});

test('profil .sli: tekstury, profile z indeksem tekstury, pasy między punktami, skala V z pierwszego punktu', () => {
  const invis = ['Invisible', '', '[texture]', 'helper_path_cars_1.bmp', '', '[profile]', '0', '[profilepnt]', '-1.5', '0.1', '0', '-0.1', '[profilepnt]', '1.5', '0.1', '1', '', '[path]', '0', '0', '0.1', '3', '0'].join('\r\n');
  const p = parseSliProfile(invis);
  assert.deepEqual(p.textures, ['helper_path_cars_1.bmp']);
  assert.deepEqual(p.bands, [{ x0: -1.5, x1: 1.5, u0: 0, u1: 1, tex: 0, vs: -0.1 }]);
  const two = [
    '[texture]', 'a.bmp', '[texture]', 'b.dds',
    '[profile]', '1', '[profilepnt]', '-4', '0', '0', '0.167', '[profilepnt]', '0', '0.1', '1', '0.167', '[profilepnt]', '4', '0', '0', '0.167',
    '[profile]', '0', '[profilepnt]', '5', '0', '0', '[profilepnt]', '6', '0', '1',
  ].join('\n');
  const q = parseSliProfile(two);
  assert.deepEqual(q.textures, ['a.bmp', 'b.dds']);
  assert.deepEqual(q.bands.map((b) => [b.x0, b.x1, b.tex, b.vs]), [[-4, 0, 1, 0.167], [0, 4, 1, 0.167], [5, 6, 0, 0.1]]); // brak skali V → domyślnie 0,1 (co 10 m)
  assert.deepEqual(parseSliProfile('nic tu nie ma').bands, []);
  assert.deepEqual(parseSliProfile(['[profile]', '3', '[profilepnt]', '0', '0', '0', '[profilepnt]', '1', '0', '1'].join('\n')).bands, []); // indeks tekstury poza listą
});

test('macierz wzoru tekstury: U biegnie w poprzek pasa, V wzdłuż splinu (z przesunięciem tekstury), dla dowolnego azymutu', () => {
  const o = { px: 400, py: 300, mPx: 10, u0: 0, x0: -3, kU: 6, vs: 0.1, texOff: 4, sMid: 6, W: 64, H: 128 };
  for (const phiDeg of [0, 90, 37, 200]) {
    const phi = (phiDeg * Math.PI) / 180;
    const m = texturePatternMatrix({ ...o, phi });
    const at = (X: number, Y: number): [number, number] => [m.a * X + m.c * Y + m.e, m.b * X + m.d * Y + m.f];
    // dowolny piksel tekstury: boczne położenie z U, położenie wzdłuż z V
    for (const [X, Y] of [[0, 0], [32, 64], [64, 128], [10, 100]]) {
      const lat = o.x0 + (X / o.W - o.u0) * o.kU; // m w prawo od osi
      const along = Y / (o.H * o.vs) - (o.texOff + o.sMid); // m wzdłuż osi względem środka kawałka
      const [sx, sy] = [o.px + (Math.cos(phi) * lat + Math.sin(phi) * along) * o.mPx, o.py + (Math.sin(phi) * lat - Math.cos(phi) * along) * o.mPx];
      const [ax, ay] = at(X, Y);
      assert.ok(Math.hypot(ax - sx, ay - sy) < 1e-6, `phi=${phiDeg} (${X},${Y})`);
    }
  }
  // spline na północ: U = 0 leży na bocznym położeniu x0 (w lewo od osi o 3 m), czyli 30 px na lewo od środka kawałka
  const north = texturePatternMatrix({ ...o, phi: 0 });
  assert.ok(Math.abs(north.e + north.c * (o.H * o.vs * (o.texOff + o.sMid)) - (o.px - 3 * o.mPx)) < 1e-6);
  // powtórzenie co 1/vs metrów: przesunięcie o H pikseli w dół tekstury to 10 m wzdłuż splinu (V rośnie o 1)
  assert.ok(Math.abs(Math.hypot(north.c * o.H, north.d * o.H) - 10 * o.mPx) < 1e-6);
});
