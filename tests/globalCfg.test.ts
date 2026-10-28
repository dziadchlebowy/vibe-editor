import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyGlobalInfo,
  decodeCfg,
  encodeCfg,
  findMapFolders,
  parseGlobalCfg,
  writeMapInfo,
} from '../src/main/core/globalCfg.ts';

const SAMPLE = `[name]
Warszawa 2008 [A5]

[friendlyname]
Warszawa

[description]
Bialoleka to jedna z największych dzielnic Warszawy.

Blablabla
123 test.
[end]
`;

test('parseGlobalCfg czyta name, friendlyname i wieloliniowy opis', () => {
  const info = parseGlobalCfg(SAMPLE)!;
  assert.equal(info.name, 'Warszawa 2008 [A5]');
  assert.equal(info.friendlyname, 'Warszawa');
  assert.equal(info.description, 'Bialoleka to jedna z największych dzielnic Warszawy.\n\nBlablabla\n123 test.');
});

test('parseGlobalCfg odrzuca pliki bez właściwych pierwszych znaczników', () => {
  assert.equal(parseGlobalCfg('[friendlyname]\nX\n[name]\nY\n[description]\nZ\n'), null);
  assert.equal(parseGlobalCfg('coś\n[name]\nA\n[friendlyname]\nB\n[description]\nC\n'), null);
  assert.equal(parseGlobalCfg('[name]\nA\n[description]\nC\n'), null);
  assert.equal(parseGlobalCfg(''), null);
});

test('parseGlobalCfg działa z CRLF i znacznikami w innej wielkości liter', () => {
  const info = parseGlobalCfg('[Name]\r\nMapa\r\n\r\n[FriendlyName]\r\nM\r\n\r\n[Description]\r\nopis\r\n[end]\r\n')!;
  assert.equal(info.name, 'Mapa');
  assert.equal(info.friendlyname, 'M');
  assert.equal(info.description, 'opis');
});

test('applyGlobalInfo podmienia dane i zachowuje resztę pliku oraz CRLF', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n') + '[other]\r\nx\r\n';
  const out = applyGlobalInfo(crlf, { name: 'Nowa', friendlyname: 'N', description: 'a\nb' });
  assert.ok(out.includes('\r\n') && !/[^\r]\n/.test(out));
  const info = parseGlobalCfg(out)!;
  assert.equal(info.name, 'Nowa');
  assert.equal(info.friendlyname, 'N');
  assert.equal(info.description, 'a\nb');
  assert.ok(out.includes('[end]'));
  assert.ok(out.includes('[other]\r\nx'));
});

test('applyGlobalInfo bez zmian daje identyczny tekst', () => {
  const info = parseGlobalCfg(SAMPLE)!;
  assert.equal(applyGlobalInfo(SAMPLE, info), SAMPLE);
});

test('kodek Windows-1250 robi round-trip polskich znaków', () => {
  const text = '[name]\nŁódź\n\n[friendlyname]\nŻółć\n\n[description]\nzażółć gęślą jaźń\n[end]\n';
  const bytes = encodeCfg(text, 'windows-1250', false);
  const decoded = decodeCfg(bytes);
  assert.equal(decoded.encoding, 'windows-1250');
  assert.equal(decoded.text, text);
});

test('findMapFolders znajduje tylko foldery z poprawnym global.cfg; writeMapInfo zachowuje kodowanie', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-maps-'));
  fs.mkdirSync(path.join(dir, 'Warszawa'));
  fs.mkdirSync(path.join(dir, 'Inny'));
  fs.mkdirSync(path.join(dir, '_vibe'));
  fs.writeFileSync(path.join(dir, 'Warszawa', 'global.cfg'), encodeCfg(SAMPLE, 'windows-1250', false));
  fs.writeFileSync(path.join(dir, 'Inny', 'global.cfg'), 'nic tu nie ma\n');
  fs.writeFileSync(path.join(dir, 'luzem.txt'), 'x');

  const maps = findMapFolders(dir);
  assert.equal(maps.length, 1);
  assert.equal(maps[0].folder, 'Warszawa');
  assert.ok(maps[0].description.includes('największych'));

  const changed = writeMapInfo(maps[0].cfgPath, { name: 'Łódź', friendlyname: 'Łódź', description: 'zażółć' });
  assert.equal(changed, true);
  const raw = fs.readFileSync(maps[0].cfgPath);
  assert.equal(decodeCfg(raw).encoding, 'windows-1250');
  assert.equal(findMapFolders(dir)[0].name, 'Łódź');
  assert.equal(writeMapInfo(maps[0].cfgPath, findMapFolders(dir)[0]), false);

  assert.deepEqual(findMapFolders(path.join(dir, 'nie-ma')), []);
});
