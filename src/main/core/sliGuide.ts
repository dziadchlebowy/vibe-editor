import fs from 'node:fs';
import path from 'node:path';

/** Ścieżka pliku z instrukcją czytania .sli, względem folderu roboczego. */
export const SLI_GUIDE_REL = '_vibe/jak_czytac_sli.txt';

/** Zawartość instrukcji (źródło: wiki OMSI WebDisk, „Spline files (.sli)”; tag wysokości piszemy [heightprofile]). */
export const SLI_GUIDE = `JAK CZYTAĆ PLIKI .sli (SPLINY OMSI)
==================================

Źródło: https://reboot.omsi-webdisk.de/wiki/entry/33-spline-files-sli/

Ogólnie
-------
- Plik .sli to tekst. Znacznik w nawiasach kwadratowych, a pod nim kolejne linijki wartości (jedna wartość = jedna linijka).
- Liczby zmiennoprzecinkowe mają kropkę dziesiętną.
- Przekrój splinu: oś X to szerokość, oś Z to wysokość. Czytamy od lewej do prawej: lewa strona ma X ujemne, prawa dodatnie.
- Typowe wysokości: ok. 0.1 m dla pasów jezdni, ok. 0.25 m dla chodników.
- Pliki .sli leżą w folderze Splines; tekstury w podfolderze "texture" względem pliku .sli.
- Dokładne kopie używanych plików są w \`_vibe/assets/Splines/...\` (tylko do odczytu).

Znaczniki i linijki pod nimi
----------------------------
[heightprofile]   (dokumentacja pisze [hightprofile], poprawna pisownia to [heightprofile]; przydatność niesprawdzona)
  1. punkt 1: lewa wartość X
  2. punkt 2: prawa wartość X
  3. wysokość 1: wysokość przy lewym X
  4. wysokość 2: wysokość przy prawym X

[texture]
  1. nazwa pliku tekstury (.dds, .tga lub .bmp); kolejne wpisy odwołują się do tej tekstury.
  (Tekstur może być kilka; numerujemy je od 0 w kolejności występowania.)

[matl_alpha]
  1. przezroczystość: 0 = brak, 1 = pełna, 2 = częściowa.

[patchwork_chain]
  1. długość pojedynczego segmentu
  2. przejścia: jedna litera na przejście; ciąg musi być o 1 znak dłuższy niż liczba segmentów
  3. częstość: jedna cyfra 1-9 na segment
  4. odbicie: 1 = segment można odbić lustrzanie, 0 = nie
  Przykład: 10 / AABAAAAAA / 11211114 / 10011111

[profile]
  1. numer tekstury (liczony od 0), której używa ten profil.
  Pod każdym [profile] stoją dokładnie dwa wpisy [profilepnt].

[profilepnt]
  1. współrzędna X punktu
  2. wysokość punktu
  3. punkt tekstury w X: piksel X / szerokość, jako ułamek (zalecane 0.005 i 0.995 zamiast 0 i 1)
  4. współczynnik rozciągnięcia: 1 / długość całej tekstury w metrach

[path]
  1. typ: 0 = pojazdy drogowe, 1 = ludzie, 2 = pojazdy szynowe, 3 = statki powietrzne
  2. X środka ścieżki, liczony od środka splinu
  3. wysokość Z ścieżki (zalecane 0.25 dla pieszych, 0.1 dla ruchu drogowego)
  4. szerokość ścieżki
  5. kierunek: 0 = do przodu, 1 = wstecz, 2 = w obu kierunkach

Jak z tego wyczytać szerokość splinu
------------------------------------
Szerokość to rozpiętość X wszystkich punktów [profilepnt] (największe X minus najmniejsze X). Pozycja boczna pasa
to X ze znacznika [path], a jego szerokość to czwarta linijka tego znacznika.

Przykład (wycinek)
------------------
[profile]
0
[profilepnt]
-3.5
0.1
0.005
0.25
[profilepnt]
3.5
0.1
0.995
0.25
=> jedna tekstura (nr 0), przekrój od X=-3.5 do X=3.5 na wysokości 0.1 m: spline szeroki na 7 m.
`;

/** Zapisuje instrukcję do _vibe/jak_czytac_sli.txt (nadpisuje, gdy treść się różni). Zwraca ścieżkę pliku. */
export function ensureSliGuide(workDir: string): string {
  const file = path.join(workDir, ...SLI_GUIDE_REL.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf-8');
  } catch {
    /* brak pliku */
  }
  if (current !== SLI_GUIDE) fs.writeFileSync(file, SLI_GUIDE, 'utf-8');
  return file;
}
