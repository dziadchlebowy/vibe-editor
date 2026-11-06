import fs from 'node:fs';
import path from 'node:path';

/** Obraz RGBA (wiersze od góry) z kolorem średnim. */
export interface RgbaImage {
  w: number;
  h: number;
  data: Uint8Array;
}

// --- BMP --------------------------------------------------------------------------------------------

export function decodeBmp(buf: Buffer): RgbaImage | null {
  if (buf.length < 54 || buf.toString('latin1', 0, 2) !== 'BM') return null;
  const dataOff = buf.readUInt32LE(10);
  const hdr = buf.readUInt32LE(14);
  if (hdr < 40) return null;
  const w = buf.readInt32LE(18);
  const hRaw = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const comp = buf.readUInt32LE(30);
  const h = Math.abs(hRaw);
  if (w <= 0 || h <= 0 || w > 16384 || h > 16384 || (comp !== 0 && comp !== 3)) return null;
  const topDown = hRaw < 0;
  const out = new Uint8Array(w * h * 4);
  const stride = Math.ceil((w * bpp) / 32) * 4;
  let palette: number[][] = [];
  if (bpp <= 8) {
    const n = buf.readUInt32LE(46) || 1 << bpp;
    for (let i = 0; i < n; i++) {
      const o = 14 + hdr + i * 4;
      if (o + 3 >= buf.length) break;
      palette.push([buf[o + 2], buf[o + 1], buf[o]]);
    }
  }
  let masks: number[] = [0xff0000, 0xff00, 0xff, 0xff000000];
  if (comp === 3 && buf.length >= 14 + hdr && hdr >= 52) masks = [buf.readUInt32LE(54), buf.readUInt32LE(58), buf.readUInt32LE(62), hdr >= 56 ? buf.readUInt32LE(66) : 0];
  const ch = (v: number, mask: number): number => {
    if (!mask) return 255;
    let shift = 0;
    while (((mask >>> shift) & 1) === 0) shift++;
    const max = mask >>> shift;
    return Math.round((((v & mask) >>> shift) * 255) / max);
  };
  let anyAlpha = false;
  for (let y = 0; y < h; y++) {
    const row = dataOff + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 255;
      if (bpp === 24) {
        const o = row + x * 3;
        if (o + 2 >= buf.length) return null;
        [b, g, r] = [buf[o], buf[o + 1], buf[o + 2]];
      } else if (bpp === 32) {
        const o = row + x * 4;
        if (o + 3 >= buf.length) return null;
        const v = buf.readUInt32LE(o);
        [r, g, b] = [ch(v, masks[0]), ch(v, masks[1]), ch(v, masks[2])];
        a = masks[3] ? ch(v, masks[3]) : buf[o + 3];
        if (a) anyAlpha = true;
      } else if (bpp === 16) {
        const o = row + x * 2;
        if (o + 1 >= buf.length) return null;
        const v = buf.readUInt16LE(o);
        const m16 = comp === 3 ? masks : [0x7c00, 0x3e0, 0x1f, 0];
        [r, g, b] = [ch(v, m16[0]), ch(v, m16[1]), ch(v, m16[2])];
      } else if (bpp === 8) {
        const o = row + x;
        if (o >= buf.length) return null;
        [r, g, b] = palette[buf[o]] ?? [0, 0, 0];
      } else return null;
      const q = (y * w + x) * 4;
      out[q] = r;
      out[q + 1] = g;
      out[q + 2] = b;
      out[q + 3] = a;
    }
  }
  // 32-bitowe BMP bez kanału alfa mają w tym bajcie zera — wtedy obraz jest nieprzezroczysty
  if (bpp === 32 && !anyAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { w, h, data: out };
}

// --- TGA --------------------------------------------------------------------------------------------

export function decodeTga(buf: Buffer): RgbaImage | null {
  if (buf.length < 18) return null;
  const idLen = buf[0];
  const type = buf[2];
  const w = buf.readUInt16LE(12);
  const h = buf.readUInt16LE(14);
  const bpp = buf[16];
  const desc = buf[17];
  if (![2, 10, 3, 11].includes(type) || w === 0 || h === 0 || ![8, 24, 32].includes(bpp)) return null;
  if (buf[1] !== 0) return null; // obrazy z paletą nie są obsługiwane
  const bytes = bpp / 8;
  const px = new Uint8Array(w * h * 4);
  let o = 18 + idLen;
  const put = (i: number, src: number): void => {
    if (bytes === 1) px.set([buf[src], buf[src], buf[src], 255], i * 4);
    else px.set([buf[src + 2], buf[src + 1], buf[src], bytes === 4 ? buf[src + 3] : 255], i * 4);
  };
  if (type === 2 || type === 3) {
    if (o + w * h * bytes > buf.length) return null;
    for (let i = 0; i < w * h; i++, o += bytes) put(i, o);
  } else {
    let i = 0;
    while (i < w * h) {
      if (o >= buf.length) return null;
      const head = buf[o++];
      const n = (head & 0x7f) + 1;
      if (head & 0x80) {
        if (o + bytes > buf.length) return null;
        for (let k = 0; k < n && i < w * h; k++) put(i++, o);
        o += bytes;
      } else {
        for (let k = 0; k < n && i < w * h; k++, o += bytes) {
          if (o + bytes > buf.length) return null;
          put(i++, o);
        }
      }
    }
  }
  if (bytes === 4 && ![...Array(Math.min(w * h, 64)).keys()].some((i) => px[i * 4 + 3])) for (let i = 3; i < px.length; i += 4) px[i] = 255;
  // wiersze: domyślnie od dołu (bit 5 deskryptora = od góry)
  if (!(desc & 0x20)) {
    const rowLen = w * 4;
    const flipped = new Uint8Array(px.length);
    for (let y = 0; y < h; y++) flipped.set(px.subarray(y * rowLen, (y + 1) * rowLen), (h - 1 - y) * rowLen);
    return { w, h, data: flipped };
  }
  return { w, h, data: px };
}

// --- DDS (DXT1/3/5 i nieskompresowane 24/32 bpp, tylko największy mip) ----------------------------------------

const c565 = (v: number): [number, number, number] => [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31].map(Math.round) as [number, number, number];

export function decodeDds(buf: Buffer): RgbaImage | null {
  if (buf.length < 128 || buf.toString('latin1', 0, 4) !== 'DDS ') return null;
  const h = buf.readUInt32LE(12);
  const w = buf.readUInt32LE(16);
  const pfFlags = buf.readUInt32LE(80);
  const fourCC = buf.toString('latin1', 84, 88);
  if (w === 0 || h === 0 || w > 16384 || h > 16384) return null;
  const out = new Uint8Array(w * h * 4);
  if (pfFlags & 0x4) {
    // skompresowane: bloki 4×4
    const dxt1 = fourCC === 'DXT1';
    if (!dxt1 && fourCC !== 'DXT3' && fourCC !== 'DXT5') return null;
    const blockBytes = dxt1 ? 8 : 16;
    const bw = Math.ceil(w / 4);
    const bh = Math.ceil(h / 4);
    if (128 + bw * bh * blockBytes > buf.length) return null;
    let o = 128;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++, o += blockBytes) {
        const alpha: number[] = new Array(16).fill(255);
        if (fourCC === 'DXT3') {
          for (let i = 0; i < 16; i++) alpha[i] = ((buf[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
        } else if (fourCC === 'DXT5') {
          const a0 = buf[o];
          const a1 = buf[o + 1];
          const pal = a0 > a1 ? [a0, a1, ...[1, 2, 3, 4, 5, 6].map((k) => ((7 - k) * a0 + k * a1) / 7)] : [a0, a1, ...[1, 2, 3, 4].map((k) => ((5 - k) * a0 + k * a1) / 5), 0, 255];
          let bits = 0n;
          for (let i = 0; i < 6; i++) bits |= BigInt(buf[o + 2 + i]) << BigInt(8 * i);
          for (let i = 0; i < 16; i++) alpha[i] = Math.round(pal[Number((bits >> BigInt(3 * i)) & 7n)]);
        }
        const co = o + (dxt1 ? 0 : 8);
        const c0 = buf.readUInt16LE(co);
        const c1 = buf.readUInt16LE(co + 2);
        const [r0, g0, b0] = c565(c0);
        const [r1, g1, b1] = c565(c1);
        const four = !dxt1 || c0 > c1;
        const pal: [number, number, number, number][] = four
          ? [[r0, g0, b0, 255], [r1, g1, b1, 255], [Math.round((2 * r0 + r1) / 3), Math.round((2 * g0 + g1) / 3), Math.round((2 * b0 + b1) / 3), 255], [Math.round((r0 + 2 * r1) / 3), Math.round((g0 + 2 * g1) / 3), Math.round((b0 + 2 * b1) / 3), 255]]
          : [[r0, g0, b0, 255], [r1, g1, b1, 255], [Math.round((r0 + r1) / 2), Math.round((g0 + g1) / 2), Math.round((b0 + b1) / 2), 255], [0, 0, 0, 0]];
        const idx = buf.readUInt32LE(co + 4);
        for (let i = 0; i < 16; i++) {
          const x = bx * 4 + (i & 3);
          const y = by * 4 + (i >> 2);
          if (x >= w || y >= h) continue;
          const c = pal[(idx >> (2 * i)) & 3];
          out.set([c[0], c[1], c[2], dxt1 ? c[3] : alpha[i]], (y * w + x) * 4);
        }
      }
    }
    return { w, h, data: out };
  }
  const bits = buf.readUInt32LE(88);
  if ((pfFlags & 0x40) && (bits === 32 || bits === 24)) {
    const [rm, gm, bm, am] = [buf.readUInt32LE(92), buf.readUInt32LE(96), buf.readUInt32LE(100), buf.readUInt32LE(104)];
    const bytes = bits / 8;
    if (128 + w * h * bytes > buf.length) return null;
    const ch = (v: number, m: number): number => {
      if (!m) return 255;
      let s = 0;
      while (((m >>> s) & 1) === 0) s++;
      return Math.round((((v & m) >>> s) * 255) / (m >>> s));
    };
    for (let i = 0; i < w * h; i++) {
      const o = 128 + i * bytes;
      const v = bytes === 4 ? buf.readUInt32LE(o) : buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
      out.set([ch(v, rm), ch(v, gm), ch(v, bm), pfFlags & 0x1 && am ? ch(v, am) : 255], i * 4);
    }
    return { w, h, data: out };
  }
  return null;
}

// --- wspólne ------------------------------------------------------------------------------------------

/** Dekoduje BMP / TGA / DDS po zawartości i rozszerzeniu; PNG i JPG obsługuje Electron (nativeImage), tu zwracamy null. */
export function decodeImage(buf: Buffer, file: string): RgbaImage | null {
  const ext = path.extname(file).toLowerCase();
  if (buf.toString('latin1', 0, 4) === 'DDS ' || ext === '.dds') return decodeDds(buf);
  if (buf.toString('latin1', 0, 2) === 'BM' || ext === '.bmp') return decodeBmp(buf);
  if (ext === '.tga') return decodeTga(buf);
  return null;
}

/** Zmniejsza obraz o całkowity współczynnik (uśrednianie), aż największy wymiar nie przekracza `maxDim`. */
export function downscale(img: RgbaImage, maxDim: number): RgbaImage {
  let { w, h, data } = img;
  while (Math.max(w, h) > maxDim && w >= 2 && h >= 2) {
    const nw = w >> 1;
    const nh = h >> 1;
    const out = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        for (let c = 0; c < 4; c++) {
          const i = ((2 * y) * w + 2 * x) * 4 + c;
          out[(y * nw + x) * 4 + c] = (data[i] + data[i + 4] + data[i + w * 4] + data[i + w * 4 + 4] + 2) >> 2;
        }
      }
    }
    [w, h, data] = [nw, nh, out];
  }
  return { w, h, data };
}

/** Średni kolor (ważony przezroczystością). */
export function averageColor(img: RgbaImage): [number, number, number] {
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const w = img.data[i + 3];
    r += img.data[i] * w;
    g += img.data[i + 1] * w;
    b += img.data[i + 2] * w;
    a += w;
  }
  return a === 0 ? [128, 128, 128] : [Math.round(r / a), Math.round(g / a), Math.round(b / a)];
}

const EXTS = ['.dds', '.tga', '.bmp', '.png', '.jpg', '.jpeg'];

function findCI(dir: string, name: string): string | null {
  try {
    const exact = path.join(dir, name);
    if (fs.existsSync(exact) && fs.statSync(exact).isFile()) return exact;
    const lower = name.toLowerCase();
    const hit = fs.readdirSync(dir).find((f) => f.toLowerCase() === lower);
    return hit && fs.statSync(path.join(dir, hit)).isFile() ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

/**
 * Znajduje plik tekstury z .sli w folderze OMSI. Kolejność: podfolder „texture” obok pliku .sli, folder pliku .sli,
 * Texture w głównym folderze OMSI, Texture mapy; nazwa może mieć własny podfolder, a gdy nie ma pliku o podanym rozszerzeniu,
 * próbujemy też .dds, .tga, .bmp, .png i .jpg (wielkość liter nie ma znaczenia).
 */
export function resolveTexture(omsiDir: string, sliRel: string, name: string, mapFolder?: string): string | null {
  const rel = name.replace(/\\/g, '/').replace(/^\.?\//, '');
  const sliDir = path.posix.dirname(sliRel.replace(/\\/g, '/'));
  const dirs = [`${sliDir}/texture`, sliDir, 'Texture', ...(mapFolder ? [`Maps/${mapFolder}/Texture`] : []), ''];
  const stem = rel.replace(/\.[^./]+$/, '');
  const tries = [rel, ...EXTS.map((e) => stem + e)];
  for (const d of dirs) {
    for (const t of tries) {
      const full = path.join(omsiDir, d, path.dirname(t));
      const hit = findCI(full, path.basename(t));
      if (hit) return hit;
    }
  }
  return null;
}
