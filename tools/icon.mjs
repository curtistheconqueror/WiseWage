/* The app icon, as source rather than as four PNGs nobody can edit.
 *
 * Everything about the mark lives in the constants below. Changing the colour is two hex
 * values; changing the design is one path. Re-run `node tools/icon.mjs` and every size is
 * regenerated from the same drawing, so they cannot drift apart — which is what happens
 * when icons are hand-exported once and then touched up individually.
 *
 * Needs playwright, which is already a dev dependency for the test suites:
 *   PW_CHROME=/path/to/chrome node tools/icon.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---- the only things you normally change ---------------------------------------- */

const BG  = '#ffffff';   // tile
const INK = '#12823f';   // the letters

/* One W, drawn as a closed outline so the down-strokes can be heavier than the up-strokes
   and every vertex is a real mitred point. Boxed in 100x100 with its own centre at (50,50)
   so the transforms below can place it without further arithmetic. */
const W = 'M 2,16 L 24,16 L 36,66 L 46,32 L 54,32 L 64,66 L 76,16 L 98,16 '
        + 'L 72,84 L 60,84 L 50,54 L 40,84 L 28,84 Z';

const SCALE = 0.60;                        // size of each W within the tile
const LIFT  = 7;                           // vertical stagger: one raised, one dropped
const GAP   = 5.0;                         // width of the knockout where they cross
const SPAN  = 84;                          // how much of the 100 box the pair occupies

/* --------------------------------------------------------------------------------- */

const DX = (SPAN - SPAN * SCALE) / 2;
const place = (dx, dy) =>
  `translate(${50 + dx},${50 + dy}) scale(${SCALE}) translate(-50,-50)`;
const SHARP = 'stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="8"';

/* `inset` shrinks the mark without shrinking the tile. Android maskable icons are cropped
   to a circle by some launchers, and anything outside the middle ~80% can be cut — so the
   maskable build draws the same art smaller rather than being a separate drawing. */
function svg(inset = 1){
  const g = (dx, dy, knock) =>
    `<g transform="${place(dx, dy)}">`
    + (knock ? `<path d="${W}" fill="${BG}" stroke="${BG}" stroke-width="${GAP}" ${SHARP}/>` : '')
    + `<path d="${W}" fill="${INK}" ${SHARP}/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="${BG}"/>
  <g transform="translate(50,50) scale(${inset}) translate(-50,-50)">
    ${g(DX, LIFT, false)}
    ${g(-DX, -LIFT, true)}
  </g>
</svg>`;
}

const OUT = [
  { file: 'icons/icon-192.png',           size: 192, inset: 1    },
  { file: 'icons/icon-512.png',           size: 512, inset: 1    },
  { file: 'icons/icon-maskable-512.png',  size: 512, inset: 0.72 },
  { file: 'apple-touch-icon.png',         size: 180, inset: 1    }
];

mkdirSync(join(ROOT, 'icons'), { recursive: true });
/* The source, committed alongside the PNGs so the drawing is reviewable in a diff. */
writeFileSync(join(ROOT, 'icons/icon.svg'), svg(1) + '\n');

const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const o of OUT){
  const p = await b.newPage({ viewport: { width: o.size, height: o.size } });
  await p.setContent(`<style>html,body{margin:0;padding:0}svg{display:block;width:${o.size}px;height:${o.size}px}</style>${svg(o.inset)}`);
  await p.waitForTimeout(120);
  await p.screenshot({ path: join(ROOT, o.file), omitBackground: false });
  await p.close();
  console.log('wrote', o.file, o.size + 'px', o.inset === 1 ? '' : `(inset ${o.inset} for maskable safe zone)`);
}
await b.close();
console.log('\nicons/icon.svg written too — edit BG and INK at the top of this file to recolour.');
