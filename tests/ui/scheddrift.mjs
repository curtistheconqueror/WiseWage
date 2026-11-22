/* A roster that does not match the shifts actually worked.

   Reported from real use. Somebody planning to go in an hour and a half early and stay an
   hour and a half late asked the what-if card and was told 0.80 h outside the shift. The
   arithmetic was right; the roster it measured against was not — a start 48 minutes off
   what they actually work, and an end nearly three hours off.

   The roster is quietly load-bearing: overtime either side of the shift, the decimal time
   card, holiday eligibility and this card all measure against it. Nothing checked it, so a
   wrong one stayed wrong for months and every figure derived from it was wrong in the same
   direction without one number ever looking odd. */
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
}).listen(8437);

let fails = 0;
const ok = (n, c, x='') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${x ? '  → ' + x : ''}`); if (!c) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });

/* The roster as it was actually stored — neither the hours worked nor the hours believed. */
const WRONG = { schedStart: '13:18', schedEnd: '01:06' };
const REAL  = { start: '14:00', end: '22:30' };

const CFG = over => Object.assign({
  rate: 37.78, otMode: 'eight40', otMultiplier: 1.5, weeklyThreshold: 40, dailyThreshold: 8,
  workDays: [true, true, true, true, true, false, false], lunchMins: 30,
  periodAnchor: '2026-11-01', periodLengthDays: 14, payDateOffsetDays: 11,
  holidays: [], banks: [], daysOff: [], vacations: [] }, over);

// Eight shifts that genuinely run 14:00 -> 23:46, the pattern the roster should reflect.
const worked = [];
for (let d = 1; d <= 8; d++) {
  worked.push({ id: 'w' + d, jobId: null, note: '',
    start: +new Date(2026, 10, d, 14, 0), end: +new Date(2026, 10, d, 23, 46) });
}

async function open_(cfg) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 1800 },
    isMobile: true, hasTouch: true, timezoneId: 'America/Chicago', locale: 'en-US' });
  const p = await ctx.newPage();
  p.on('pageerror', e => { console.log('  PAGE ERROR:', e.message); fails++; });
  await p.addInitScript(([k, v]) => { localStorage.setItem(k, JSON.stringify(v)); },
    [KEY, { configured: true, mode: 'full', cfg, sessions: worked, absences: [], units: [],
            stipends: [], otHist: [], activeStart: null, activeAdj: null, unit: 'sec',
            planOn: false, plannedHours: 8, sound: false, otAsk: null,
            ui: { wifPay: true, open: {} } }]);
  await p.clock.install({ time: new Date(2026, 10, 22, 11, 0) });
  await p.goto('http://localhost:8437/');
  await p.waitForTimeout(700);
  await p.evaluate(() => document.querySelectorAll('.col').forEach(c => c.classList.add('open')));
  await p.waitForTimeout(300);
  return { ctx, p };
}

// Ask the what-if the question that was actually asked: in 1.5 h early, out 1.5 h late.
async function askWhatIf(p, inAt, outAt) {
  // The card is behind its own disclosure button, not a <details>.
  if (!(await p.isVisible('#wIn'))) { await p.click('#wifBtn'); await p.waitForTimeout(300); }
  await p.fill('#wIn', inAt);
  await p.fill('#wOut', outAt);
  await p.dispatchEvent('#wIn', 'change');
  await p.dispatchEvent('#wOut', 'change');
  await p.waitForTimeout(400);
  return p.evaluate(() => document.getElementById('wifOut').innerText.replace(/\s+/g, ' '));
}

console.log('\n━━ 1. The reported figure, against the roster that was stored ━━');
{
  const { ctx, p } = await open_(CFG(WRONG));
  const out = await askWhatIf(p, '12:30', '00:00');
  ok('reports 0.80 h outside the shift, exactly as reported', /0\.80/.test(out), out.slice(0, 120));
  ok('and no late time at all, because 00:00 is before a 01:06 finish',
     /LATE 0\.00|0\.00/.test(out), out.slice(0, 160));
  await ctx.close();
}

console.log('\n━━ 2. The same question against the roster actually worked ━━');
{
  const { ctx, p } = await open_(CFG({ schedStart: REAL.start, schedEnd: REAL.end }));
  const out = await askWhatIf(p, '12:30', '00:00');
  ok('1.50 early and 1.50 late', (out.match(/1\.50/g) || []).length >= 2, out.slice(0, 160));
  ok('3.00 h to claim', /3\.00/.test(out), out.slice(0, 160));
  await ctx.close();
}

console.log('\n━━ 3. The roster is now questioned where it misleads ━━');
{
  const { ctx, p } = await open_(CFG(WRONG));
  await askWhatIf(p, '12:30', '00:00');
  ok('the mismatch is pointed out', await p.isVisible('#schedDrift'));
  const txt = await p.textContent('#schedDriftTxt');
  ok('naming what the shifts actually run', /2:00\s*PM/i.test(txt) && /11:46\s*PM/i.test(txt), txt.slice(0, 140));
  ok('and what the schedule claims', /1:18\s*PM/i.test(txt) && /1:06\s*AM/i.test(txt), txt.slice(0, 200));
  ok('and says plainly what it costs', /hides overtime you could claim/i.test(txt), txt.slice(-90));
  await ctx.close();
}

console.log('\n━━ 4. It must NOT copy the usual times into the roster ━━');
{
  /* The first version of this did exactly that, and it would have cost money. The roster is
     the hours somebody is ROSTERED for; the median of what they work includes their
     overtime, so writing it in moves the line overtime is measured against. On this log it
     cut the claimable figure from 3.00 h to 1.73 — a fix that quietly took 1.27 h a day off
     what could be claimed. Only the person knows their contracted hours. */
  const { ctx, p } = await open_(CFG(WRONG));
  await askWhatIf(p, '12:30', '00:00');
  const before = await p.evaluate(() => ({ s: state.cfg.schedStart, e: state.cfg.schedEnd }));
  await p.click('#schedDriftFix');
  await p.waitForTimeout(700);
  const after = await p.evaluate(() => ({ s: state.cfg.schedStart, e: state.cfg.schedEnd }));
  ok('the roster is left exactly as it was', JSON.stringify(before) === JSON.stringify(after),
     JSON.stringify(before) + ' -> ' + JSON.stringify(after));
  ok('and it never writes the worked pattern in', after.e !== '23:46', after.e);
  ok('the schedule group is opened for editing instead',
     await p.evaluate(() => document.getElementById('gSched').open));
  await ctx.close();
}

console.log('\n━━ 4b. What a wrongly-widened roster costs, measured ━━');
{
  // Same question, the only difference being an end time that includes worked overtime.
  const real = await open_(CFG({ schedStart: '14:00', schedEnd: '22:30' }));
  const a = await askWhatIf(real.p, '12:30', '00:00');
  await real.ctx.close();
  const wide = await open_(CFG({ schedStart: '14:00', schedEnd: '23:46' }));
  const c = await askWhatIf(wide.p, '12:30', '00:00');
  await wide.ctx.close();
  ok('a roster at the contracted end claims 3.00 h', /3\.00/.test(a), a.slice(0, 90));
  ok('one widened to the worked pattern claims only 1.73', /1\.73/.test(c), c.slice(0, 90));
}

console.log('\n━━ 5. A roster that matches is left alone ━━');
{
  const { ctx, p } = await open_(CFG({ schedStart: '14:00', schedEnd: '23:46' }));
  await askWhatIf(p, '12:30', '00:00');
  ok('no nudge when the schedule agrees with the log', !(await p.isVisible('#schedDrift')));
  await ctx.close();
}

console.log('\n━━ 6. Overtime is not a wrong roster ━━');
{
  /* The direction is the whole idea. Clocking in early and out late is OVERTIME — the thing
     this app exists to count — and warning about it would nag exactly the people using it
     correctly. A warning that fires on normal behaviour is one nobody reads.
     These shifts run 90 minutes past the rostered finish and must not trip it. */
  const early = worked.map((s, i) => ({ ...s, id: 'e' + i,
    start: +new Date(2026, 10, i + 1, 13, 50), end: +new Date(2026, 11, 0, 0, 0) }));
  early.forEach((s, i) => { s.end = +new Date(2026, 10, i + 1, 23, 59); });
  const ctx = await b.newContext({ viewport: { width: 390, height: 1800 },
    isMobile: true, hasTouch: true, timezoneId: 'America/Chicago', locale: 'en-US' });
  const p = await ctx.newPage();
  await p.addInitScript(([k, v]) => { localStorage.setItem(k, JSON.stringify(v)); },
    [KEY, { configured: true, mode: 'full', cfg: CFG({ schedStart: '14:00', schedEnd: '22:30' }),
            sessions: early, absences: [], units: [], stipends: [], otHist: [],
            activeStart: null, activeAdj: null, unit: 'sec', planOn: false, plannedHours: 8,
            sound: false, otAsk: null, ui: { wifPay: true, open: {} } }]);
  await p.clock.install({ time: new Date(2026, 10, 22, 11, 0) });
  await p.goto('http://localhost:8437/');
  await p.waitForTimeout(700);
  await p.evaluate(() => document.querySelectorAll('.col').forEach(c => c.classList.add('open')));
  await askWhatIf(p, '12:30', '00:00');
  ok('working well past the rostered end does not trip it', !(await p.isVisible('#schedDrift')));
  await ctx.close();
}

console.log('\n━━ 7. The message under the pay figure ━━');
{
  const { ctx, p } = await open_(CFG({ schedStart: '14:00', schedEnd: '22:30' }));
  await askWhatIf(p, '12:30', '00:00');
  const m = (await p.textContent('#wifMoney')).replace(/\s+/g, ' ');
  ok('says plainly what the figure includes',
     /Counted on top of the hours you have already worked/.test(m), m.slice(-110));
  ok('and no longer quotes the shift hours as if they were the banked total',
     !/adds to what you have already banked/.test(m), m.slice(-110));
  await ctx.close();
}

console.log(`\n${fails === 0 ? '✅' : '❌'}  ${fails === 0 ? 'all passed' : fails + ' failed'}\n`);
await b.close(); srv.close();
process.exit(fails ? 1 : 0);
