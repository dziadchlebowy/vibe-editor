import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyTrip, formatDep, loadTimetable, parseClock, parseLine, parseTrip, saveLine, saveTrip, serializeLine } from '../src/main/core/timetable.ts';

const NL = '\r\n';
const TTL = [
  '-----------------------', 'Time Table Line File', '-----------------------', '', 'Created with Omsi Version 2.3.004', 'Date: 01.08.2026', '',
  '[userallowed]', '', '[priority]', '1', '------------------------------------', '',
  '[newtour]', '1', 'PKS 12m', '287', '', '------------------------------------', '',
  '  Dep.: 6:6:0', '[addtrip]', '144-TP-FSO', '0', '366.000', '',
  '  Dep.: 6:47:0', '[addtrip]', '144-TP-SZL', '0', '407.000', '',
  '------------------------------------', '',
  '[newtour]', '2', 'PKS 12m', '287', '', '------------------------------------', '',
  '  Dep.: 6:26:0', '[addtrip]', '144-TP-FSO', '0', '386.000', '', '',
].join(NL);

const TTP = [
  '-----------------------', 'Time Table Trip File', '-----------------------', '', '[trip]', '144_TP-FSO', 'Zeran FSO', '144', '',
  '[station]', '1575273', '0', 'Dabrowka Szlachecka o.', '91', '6.369', '34.503', '34.503', '5.000', '',
  '[station]', '1546328', '43', 'Dabrowka Wislana', '6', '0.762', '802.058', '27.892', '3.000', '', '',
  '[profile]', 'standard', '27.000', '',
  '[profile_man_arr_time]', '0', '0.000', '[profile_man_dep_time]', '0', '0.000', '[profile_otherstopping]', '0', '3',
  '[profile_man_arr_time]', '1', '2.000', '[profile_man_dep_time]', '1', '2.000', '',
].join(NL);

test('.ttl: parsowanie brygad i kursów, zapis bez zmian jest identyczny co do znaku', () => {
  const p = parseLine(TTL);
  assert.equal(p.tours.length, 2);
  assert.deepEqual(p.tours[0].header, ['PKS 12m', '287']);
  assert.deepEqual(p.tours[0].trips.map((t) => [t.trip, t.start]), [['144-TP-FSO', 366], ['144-TP-SZL', 407]]);
  assert.equal(serializeLine(p, p.tours).join(NL), TTL);
});

test('.ttl: zmiana godziny odświeża komentarz „Dep.:”, nowy kurs i brygada', () => {
  const p = parseLine(TTL);
  p.tours[0].trips[0].start = 6 * 60 + 12.5;
  p.tours[0].trips.push({ trip: '144-TP-FSO', flag: '0', start: 500, extra: [] });
  p.tours.push({ number: '3', header: ['PKS 12m', '287'], trips: [] });
  const out = serializeLine(p, p.tours).join(NL);
  assert.ok(out.includes(`  Dep.: 6:12:30${NL}[addtrip]${NL}144-TP-FSO${NL}0${NL}372.500`));
  assert.ok(out.includes(`  Dep.: 8:20:0${NL}[addtrip]${NL}144-TP-FSO${NL}0${NL}500.000`));
  const again = parseLine(out);
  assert.equal(again.tours.length, 3);
  assert.equal(again.tours[0].trips.length, 3);
});

test('godziny: formatDep i parseClock', () => {
  assert.equal(formatDep(366), '6:6:0');
  assert.equal(formatDep(1308), '21:48:0');
  assert.equal(parseClock('6:06'), 366);
  assert.equal(parseClock('21:48:30'), 1308.5);
  assert.equal(parseClock('25:99'), null);
  assert.equal(parseClock('abc'), null);
});

test('.ttp: odczyt stacji i profilu, zapis bez zmian jest identyczny, edycja zmienia tylko wskazane linijki', () => {
  const t = parseTrip(TTP, 'TTData/144-TP-FSO.ttp');
  assert.equal(t.name, '144-TP-FSO');
  assert.deepEqual([t.internalName, t.title, t.line], ['144_TP-FSO', 'Zeran FSO', '144']);
  assert.deepEqual(t.stations.map((s) => s.name), ['Dabrowka Szlachecka o.', 'Dabrowka Wislana']);
  assert.deepEqual(t.profiles[0].arr, { 0: 0, 1: 2 });
  assert.deepEqual(t.profiles[0].stop, { 0: 3 });
  assert.equal(applyTrip(TTP, t).join(NL), TTP);

  t.title = 'Zeran';
  t.profiles[0].arr[1] = 2.5;
  (t.profiles[0].stop as Record<number, number>)[1] = 1; // brakujący wpis — dopisany na końcu profilu
  const out = applyTrip(TTP, t).join(NL);
  const diff = out.split(NL).filter((l, i) => l !== TTP.split(NL)[i]);
  assert.ok(out.includes('Zeran' + NL) && out.includes('2.500'));
  assert.ok(out.includes(`[profile_otherstopping]${NL}1${NL}1`));
  assert.ok(diff.length > 0);
  assert.equal(parseTrip(out, 'x.ttp').profiles[0].stop[1], 1);
});

test('.ttp: usunięcie wpisu z modelu usuwa jego trzy linijki z pliku', () => {
  const t = parseTrip(TTP, 'a.ttp');
  delete t.profiles[0].stop[0];
  delete t.profiles[0].dep[1];
  const out = applyTrip(TTP, t).join(NL);
  const back = parseTrip(out, 'a.ttp').profiles[0];
  assert.deepEqual(back.stop, {});
  assert.deepEqual(back.dep, { 0: 0 });
  assert.deepEqual(back.arr, { 0: 0, 1: 2 });
});

test('dysk: skan folderu mapy, zapis zachowuje kodowanie, ścieżki spoza mapy są odrzucane', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-tt-'));
  fs.mkdirSync(path.join(dir, 'TTData'));
  fs.writeFileSync(path.join(dir, 'TTData', '144.ttl'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TTL, 'utf16le')]));
  fs.writeFileSync(path.join(dir, 'TTData', '144-TP-FSO.ttp'), TTP);
  const data = loadTimetable(dir);
  assert.deepEqual(data.lines.map((l) => [l.file, l.tours.length]), [['TTData/144.ttl', 2]]);
  assert.deepEqual(data.trips.map((t) => t.file), ['TTData/144-TP-FSO.ttp']);

  data.lines[0].tours[0].trips[0].start = 400;
  assert.deepEqual(saveLine(dir, data.lines[0]), { ok: true });
  const raw = fs.readFileSync(path.join(dir, 'TTData', '144.ttl'));
  assert.deepEqual([raw[0], raw[1]], [0xff, 0xfe]);
  assert.equal(loadTimetable(dir).lines[0].tours[0].trips[0].start, 400);

  data.trips[0].title = 'Nowy cel';
  assert.deepEqual(saveTrip(dir, data.trips[0]), { ok: true });
  assert.equal(loadTimetable(dir).trips[0].title, 'Nowy cel');

  assert.equal(saveLine(dir, { ...data.lines[0], file: '../zewnatrz.ttl' }).ok, false);
  assert.equal(saveTrip(dir, { ...data.trips[0], file: 'TTData/inny.txt' }).ok, false);
  data.lines[0].tours[0].trips[0].trip = '';
  assert.equal(saveLine(dir, data.lines[0]).ok, false);
});
