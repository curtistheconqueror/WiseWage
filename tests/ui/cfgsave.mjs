/* A Save button in every settings group.

   Settings have always written on change, so nothing was ever lost — but being asked to
   trust a pay record is not the same as being shown, and the owner's words were that it
   "just does not feel right" to change a time and have nothing to press.

   A button that only reassured would be a placebo. The point of this suite is that this one
   is not: `syncControls` deliberately skips a field that currently has focus, so a value
   typed and not yet tapped away from lives in the input and nowhere else. The button blurs
   first, which commits it. Section 3 is the one that matters — it proves the button does
   something a placebo would not. */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
const KEY = 'payclock.v1';
const srv = http.createServer((q, r) => {
  const u = q.url || '/';
  if (u.startsWith('/sw.js')) { r.writeHead(200, {'Content-Type':'text/javascript'}); return r.end(readFileSync(ROOT+'sw.js')); }
  if (u.startsWith('/manifest')) { r.writeHead(200, {'Content-Type':'application/manifest+json'}); return r.end(readFileSync(ROOT+'manifest.webmanifest')); }
  if (u.indexOf('.png') > -1) { r.writeHead(404); return r.end(); }
  r.writeHead(200, {'Content-Type':'text/html'}); r.end(readFileSync(ROOT+'index.html'));
}).listen(8439);

let fails = 0;
const ok = (n, c, x='') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${x ? '  → ' + x : ''}`); if (!c) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });

const SEED = { configured: true, mode: 'full',
  cfg: { rate: 37.78, otMode: 'eight40', otMultiplier: 1.5, weeklyThreshold: 40,
         schedStart: '14:00', schedEnd: '22:30', lunchMins: 30,
         workDays: [true, true, true, true, true, false, false],
         periodAnchor: '2026-11-01', periodLengthDays: 14, payDateOffsetDays: 11,
         holidays: [], banks: [], daysOff: [], vacations: [] },
  sessions: [], absences: [], units: [], stipends: [], otHist: [],
  activeStart: null, activeAdj: null, unit: 'sec', planOn: false, plannedHours: 8,
  sound: false, otAsk: null };

async function open_() {
  const ctx = await b.newContext({ viewport: { width: 390, height: 1800 },
    isMobile: true, hasTouch: true, timezoneId: 'America/Chicago', locale: 'en-US' });
  const p = await ctx.newPage();
  p.on('pageerror', e => { console.log('  PAGE ERROR:', e.message); fails++; });
  /* Seed once per context. addInitScript runs on EVERY navigation, so without this guard a
     reload re-seeds storage and wipes the very change section 4 is checking survived. */
  await p.addInitScript(([k, v]) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    localStorage.setItem(k, JSON.stringify(v));
  }, [KEY, SEED]);
  await p.clock.install({ time: new Date(2026, 10, 22, 11, 0) });
  await p.goto('http://localhost:8439/');
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    const d = document.querySelector('#cfg>details'); if (d) d.open = true;
    document.querySelectorAll('#cfg .cfgsec').forEach(x => { x.open = true; });
  });
  await p.waitForTimeout(400);
  return { ctx, p };
}

console.log('\n━━ 1. Every group has one ━━');
{
  const { ctx, p } = await open_();
  const got = await p.evaluate(() => {
    const out = [];
    document.querySelectorAll('#cfg .cfgsec').forEach(sec => {
      const body = sec.querySelector(':scope > .cfgbody');
      const row = body && body.querySelector(':scope > .cfgsave');
      out.push({ id: sec.id, has: !!row,
                 last: !!row && (!row.nextElementSibling
                        || row.nextElementSibling.classList.contains('helpnote')) });
    });
    return out;
  });
  ok(`all ${got.length} settings groups have a Save`, got.length >= 7 && got.every(g => g.has),
     JSON.stringify(got.filter(g => !g.has)));
  ok('each sits at the foot of its own group, above any help note',
     got.every(g => g.last), JSON.stringify(got.filter(g => !g.last)));
  /* Only the ones on screen: some groups are hidden for the current mode or profession,
     and measuring a button in a hidden group reports 0 and says nothing. */
  const h = await p.evaluate(() => {
    const on = [...document.querySelectorAll('.cfgsave .btn')].filter(x => x.offsetParent !== null);
    return { n: on.length, min: Math.min(...on.map(x => Math.round(x.getBoundingClientRect().height))) };
  });
  ok('and every one on screen is finger-sized', h.n > 0 && h.min >= 44, JSON.stringify(h));
  await ctx.close();
}

console.log('\n━━ 2. It confirms, so there is something to see ━━');
{
  const { ctx, p } = await open_();
  const row = '#gSched .cfgsave';
  ok('nothing is claimed before it is pressed',
     (await p.textContent(`${row} .cfgsaved`)).trim() === '');
  await p.click(`${row} .btn`);
  await p.waitForTimeout(250);
  ok('it says Saved', (await p.textContent(`${row} .cfgsaved`)).trim() === 'Saved',
     await p.textContent(`${row} .cfgsaved`));
  await ctx.close();
}

console.log('\n━━ 3. It is not a placebo: it commits a field still being edited ━━');
{
  /* The real gap. syncControls skips a focused field, so a value typed and not blurred is
     only in the input. Type into the schedule WITHOUT firing change, then press Save. */
  const { ctx, p } = await open_();
  await p.focus('#cSchedEnd2');
  await p.evaluate(() => {
    const el = document.getElementById('cSchedEnd2');
    el.focus();
    el.value = '23:15';          // set directly, no change event, focus retained
  });
  const stillFocused = await p.evaluate(() => document.activeElement.id);
  ok('the field holds the new value and still has focus', stillFocused === 'cSchedEnd2', stillFocused);
  ok('and the setting has NOT been written yet',
     (await p.evaluate(() => state.cfg.schedEnd)) === '22:30',
     await p.evaluate(() => state.cfg.schedEnd));

  await p.click('#gSched .cfgsave .btn');
  await p.waitForTimeout(400);
  ok('pressing Save commits it', (await p.evaluate(() => state.cfg.schedEnd)) === '23:15',
     await p.evaluate(() => state.cfg.schedEnd));
  /* Read it the way it is actually stored: once jobs exist the config lives on the active
     job, and `state.cfg` is an accessor onto it. */
  const stored = () => p.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('payclock.v1'));
    const j = (s.jobs || []).filter(x => x.id === s.activeJob)[0];
    return (j && j.cfg && j.cfg.schedEnd) || (s.cfg && s.cfg.schedEnd) || null;
  });
  ok('and it is in storage, not just in memory', (await stored()) === '23:15', await stored());
  await ctx.close();
}

console.log('\n━━ 4. It survives a reload, which is the thing being doubted ━━');
{
  const { ctx, p } = await open_();
  await p.evaluate(() => {
    const el = document.getElementById('cSchedStart2');
    el.focus(); el.value = '13:00';
  });
  await p.click('#gSched .cfgsave .btn');
  await p.waitForTimeout(400);
  await p.reload();
  await p.waitForTimeout(700);
  ok('the change is still there after reopening',
     (await p.evaluate(() => state.cfg.schedStart)) === '13:00',
     await p.evaluate(() => state.cfg.schedStart));
  await ctx.close();
}

console.log('\n━━ 5. Saving one group does not disturb another ━━');
{
  const { ctx, p } = await open_();
  const before = await p.evaluate(() => JSON.stringify(state.cfg));
  await p.click('#gLook .cfgsave .btn');
  await p.waitForTimeout(350);
  ok('pressing Save with nothing changed changes nothing',
     (await p.evaluate(() => JSON.stringify(state.cfg))) === before);
  ok('and it still confirms, rather than looking broken',
     (await p.textContent('#gLook .cfgsave .cfgsaved')).trim() === 'Saved');
  await ctx.close();
}

console.log(`\n${fails === 0 ? '✅' : '❌'}  ${fails === 0 ? 'all passed' : fails + ' failed'}\n`);
await b.close(); srv.close();
process.exit(fails ? 1 : 0);
