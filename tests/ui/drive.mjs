import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;
// Screenshots and scratch files go to a temp dir, never the repo.
const TMP = join(process.env.TMPDIR || '/tmp', 'wisewage-tests');
try { (await import('node:fs')).mkdirSync(TMP, { recursive: true }); } catch {}




// Screenshots land beside the suite unless told otherwise.
// Beside the suite would mean a test run leaves five PNGs in version control.
const SHOT = process.env.PW_SHOTS || TMP;
const KEY = 'payclock.v1';

const srv = http.createServer((req, res) => {
  // Correct MIME types: the app registers a service worker, and text/html for sw.js
  // makes the browser reject it with a console error.
  const u = req.url || '/';
  if (u.startsWith('/sw.js')) { res.writeHead(200,{'Content-Type':'text/javascript'}); return res.end(readFileSync(ROOT+'/sw.js')); }
  if (u.startsWith('/manifest')) { res.writeHead(200,{'Content-Type':'application/manifest+json'}); return res.end(readFileSync(ROOT+'/manifest.webmanifest')); }
  if (u.indexOf('.png') > -1) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(readFileSync(ROOT + '/index.html'));
}).listen(8099);

let fails = 0;
const openAll=async pg=>{ try{ await pg.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open'))); }catch(e){} };
const ok = (n, c, x = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${x ? '  → ' + x : ''}`); if (!c) fails++; };

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({
  timezoneId: 'America/New_York', locale: 'en-US', viewport: { width: 900, height: 1500 }, deviceScaleFactor: 2,
});

let page = null;
/** Fresh page with `seed` written to localStorage BEFORE the app boots, clock set to `iso`. */
async function boot(iso, seed) {
  if (page) await page.close();                       // close() does not run beforeunload
  page = await ctx.newPage();
  page.on('pageerror', e => { console.log('  PAGE ERROR:', e.message); fails++; });
  page.on('console', m => { if (m.type() === 'error') { console.log('  CONSOLE ERROR:', m.text()); fails++; } });
  await page.addInitScript(([k, v]) => {
    if (sessionStorage.getItem('__seeded')) return;   // reloads must read what the app saved
    sessionStorage.setItem('__seeded', '1');
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
  }, [KEY, seed === undefined ? null : seed]);
  await page.clock.install({ time: new Date(iso) });
  await page.goto('http://localhost:8099/');
  await page.waitForTimeout(250); await openAll(page);
  return page;
}
const T = s => page.textContent(s);
const num = async s => parseFloat((await T(s)).replace(/[$,]/g, ''));
const money = () => num('#money');
// The fake clock drifts a second or two past what the script asked for, so verify the
// money against the elapsed time the widget itself is showing.
const elapsedSec = async () => {
  const [h, m, sec] = (await T('#timer')).split(':').map(Number);
  return h * 3600 + m * 60 + sec;
};
const expectPay = async (label, unit, rate = 38) => {
  const sec = await elapsedSec();
  const step = unit === 'hr' ? 3600 : unit === 'min' ? 60 : 1;
  const tol = unit === 'sec' ? 0.002 : 0.005;   // MIN/HR render 2 dp, so allow half a cent
  const want = Math.floor(sec / step) * step / 3600 * rate;
  ok(label, Math.abs(await money() - want) < tol, `$${await money()} vs $${want.toFixed(4)} for ${sec}s`);
};
const ff = async ms => { await page.clock.fastForward(ms); await page.waitForTimeout(180); };
// July 2026, US/Eastern. Jul 26 is the Sunday the period opens.
/* Built in the browser's timezone. new Date(y,m,d,h) here is UTC and lands four hours off
   the New York page, which silently moved every fixture. */
const day = (d, h) => Date.UTC(2026, 6, d, h + 4);      // July = EDT, UTC-4
const seedShift = (id, d, h, len) => ({ id, start: day(d, h), end: day(d, h + len) });
const BASE = { configured: true, cfg: { rate: 38, periodAnchor: '2026-07-26' }, sessions: [], activeStart: null, unit: 'sec', planOn: false, plannedHours: 8, sound: false };

/* ---------------------------------------------------------------- */
console.log('\nIdle state');
await boot('2026-07-27T13:00:00Z', BASE);            // Mon Jul 27, 9:00 AM ET, nothing stored
ok('shows clocked out', (await T('#statusTxt')).includes('Clocked out'));
ok('money starts at $0.00', (await T('#money')) === '$0.00');
ok('period reads Sun Jul 26 → Sat Aug 8', (await T('#prange')) === 'Sun Jul 26 → Sat Aug 8, 2026', await T('#prange'));
ok('payday reads Fri Aug 21', (await T('#payday')) === 'Fri Aug 21, 2026', await T('#payday'));
ok('idle line shows the $38.00 base rate', (await T('#liveline')).includes('$38.00'), await T('#liveline'));
ok('period countdown shown', /\d+d/.test(await T('#pleft')), await T('#pleft'));
ok('40 h to OT with nothing worked', (await T('#otNum')).includes('40.00 h to OT'), await T('#otNum'));
await page.screenshot({ path: SHOT + '/01-idle.png', fullPage: true });

/* ---------------------------------------------------------------- */
console.log('\nClock in — live accrual in SEC');
await page.click('#punch'); await page.waitForTimeout(150);
ok('status flips to On the clock', (await T('#statusTxt')).includes('On the clock'));
ok('button becomes Clock Out', (await T('#punch')).includes('Clock Out'));

await page.clock.runFor(10_000); await page.waitForTimeout(150);
await expectPay('10 s of pay matches the elapsed timer', 'sec');
ok('SEC shows 4 dp so the crawl is visible', /\.\d{4}$/.test(await T('#money')), await T('#money'));
ok('timer 00:00:10', (await T('#timer')) === '00:00:10', await T('#timer'));

await ff(2 * 3600_000 - 10_000);                      // exactly 2 h in
await expectPay('2 h of pay matches the elapsed timer', 'sec');
ok('timer 02:00:00', (await T('#timer')) === '02:00:00', await T('#timer'));
// A cent of slack: the fake clock overshoots the requested span by a second or two.
// Penny-exact accrual is asserted by expectPay against the widget's own timer.
ok('today total tracks the shift', Math.abs(await num('#dGross') - 76) < 0.05, await T('#dGross'));
ok('period-to-date tracks the shift', Math.abs(await num('#pGross') - 76) < 0.05, await T('#pGross'));
ok('OT bar counts 2.00 / 40 h', (await T('#otNum')).includes('2.00 / 40 h'), await T('#otNum'));
await page.screenshot({ path: SHOT + '/02-running.png', fullPage: true });

/* ---------------------------------------------------------------- */
console.log('\nSEC / MIN / HR toggle');
await page.click('#seg button[data-u="min"]'); await page.waitForTimeout(150);
ok('MIN hint', (await T('#seghint')).includes('every minute'));
await ff(90_000);                                     // 2 h 01 m 30 s
await expectPay('MIN truncates to the whole minute', 'min');
await page.click('#seg button[data-u="hr"]'); await page.waitForTimeout(150);
ok('HR hint', (await T('#seghint')).includes('every hour'));
await expectPay('HR truncates to the whole hour', 'hr');
ok('live figure still shown alongside', (await T('#liveline')).includes('live'), await T('#liveline'));
await page.click('#seg button[data-u="sec"]'); await page.waitForTimeout(150);
ok('back to SEC', (await T('#seghint')).includes('every second'));
await expectPay('SEC reflects every elapsed second', 'sec');

/* ---------------------------------------------------------------- */
console.log('\nClock out banks the shift');
/* Read and punched in the same evaluate. A live shift bills about a cent a second, so
   reading the figure in one call and clocking out in the next compares two moments and
   fails by exactly the time between them. */
const bankedPay = await page.evaluate(() => {
  /* Repaint FIRST. #money carries whatever the last tick drew, and the ticker runs once a
     second — so under load the text on screen can be seconds behind the clock, while
     clocking out prices the real moment. Reading one and banking the other then differs by
     however far behind the paint had fallen: it passed on an idle machine and failed on a
     busy one, by a couple of cents, looking exactly like a rounding bug in the money. */
  render();
  const v = parseFloat(document.querySelector('#money').textContent.replace(/[$,]/g, ''));
  document.querySelector('#punch').click();
  return v;
});
await page.waitForTimeout(300);
ok('back to Clocked out', (await T('#statusTxt')).includes('Clocked out'));
ok('shift landed in the log', (await T('#logBody')).includes('Mon Jul 27'));
ok('log shows 2.03 h', (await T('#logBody')).includes('2.03'));
ok('day total = the banked shift, to the cent',
   Math.abs(await num('#dGross') - bankedPay) < 0.01, `${await T('#dGross')} vs $${bankedPay.toFixed(2)}`);
ok('log footer totals the period', (await T('#logBody')).includes('Period total'));

/* ---------------------------------------------------------------- */
console.log('\nRefresh mid-shift recovers the right amount');
await boot('2026-07-27T13:00:00Z', { ...BASE, activeStart: day(27, 9) });
await ff(3600_000);
const before = await money();
await page.reload(); await page.waitForTimeout(300); await openAll(page);
ok('still clocked in after reload', (await T('#statusTxt')).includes('On the clock'));
ok('amount survived the reload', Math.abs(await money() - before) < 0.05, `${before} → ${await money()}`);
ok('timer survived the reload', (await T('#timer')).startsWith('01:00'), await T('#timer'));

/* ---------------------------------------------------------------- */
console.log('\nOvertime crossover — weekly 40 h');
// 38 h banked Sun–Wed; clock in Thu 9 AM. OT must begin exactly 2 h later.
const WEEK38 = [seedShift('a', 26, 8, 10), seedShift('b', 27, 8, 10), seedShift('c', 28, 8, 10), seedShift('d', 29, 8, 8)];
await boot('2026-07-30T13:00:00Z', { ...BASE, sessions: WEEK38 });
ok('38 h banked this week', (await T('#otNum')).includes('38.00 / 40 h'), await T('#otNum'));
ok('2 h left to OT', (await T('#otNum')).includes('2.00 h to OT'), await T('#otNum'));
ok('week total = 38 × $38 = $1,444', Math.abs(await num('#wGross') - 1444) < 0.01, await T('#wGross'));

await page.click('#punch'); await page.waitForTimeout(150);
await ff(1.5 * 3600_000);                             // 39.5 h — still straight time
ok('at 39.5 h still straight time', !(await T('#statusTxt')).includes('overtime'), await T('#statusTxt'));
ok('no OT badge yet', (await T('#otBadge')).trim() === '');
ok('still earning $0.0106/s', (await T('#liveline')).includes('0.0106'), await T('#liveline'));

await ff(1.5 * 3600_000);                             // 41 h — day is 2 reg + 1 OT
ok('flips into overtime', (await T('#statusTxt')).includes('overtime'), await T('#statusTxt'));
ok('OT badge appears', (await T('#otBadge')).includes('1.5'), await T('#otBadge'));
ok('hero switches to the OT treatment', await page.evaluate(() => document.getElementById('hero').classList.contains('ot')));
ok('rate steps up to $57/hr ($0.0158/s)', (await T('#liveline')).includes('0.0158'), await T('#liveline'));
ok('today split 2 reg + 1 OT = $133.00', Math.abs(await num('#dGross') - (2 * 38 + 57)) < 0.02, await T('#dGross'));
ok('week detail breaks out the OT hours', (await T('#wDet')).includes('OT'), await T('#wDet'));
ok('week gross = 40×38 + 1×57 = $1,577', Math.abs(await num('#wGross') - (40 * 38 + 57)) < 0.02, await T('#wGross'));
ok('OT bar reports 1.00 h in OT', (await T('#otNum')).includes('1.00 h in OT'), await T('#otNum'));
ok('running shift is listed live in the log', (await T('#logBody')).includes('running'));
/* Both read in one evaluate. A live shift bills $0.0158 a second, so reading the log and
   the tile in separate awaits compares two different moments and fails on the gap. */
const agree = await page.evaluate(() => {
  const log = document.querySelector('#logBody').textContent;
  const m = log.match(/Period total[\s\S]*?\$([\d,]+\.\d{2})/);
  return { log: m && m[1], tile: document.querySelector('#pGross').textContent };
});
ok('log total now agrees with the period tile',
   Math.abs(parseFloat(String(agree.log).replace(/,/g, ''))
            - parseFloat(agree.tile.replace(/[^0-9.]/g, ''))) < 0.01,
   agree.log + ' vs ' + agree.tile);
await page.screenshot({ path: SHOT + '/03-overtime.png', fullPage: true });

/* ---------------------------------------------------------------- */
console.log('\nAuto-stop at the planned hours');
await boot('2026-07-30T13:00:00Z', { ...BASE, planOn: true, plannedHours: 4 });
ok('auto-stop checkbox restored', await page.isChecked('#planOn'));
ok('planned hours restored', (await page.inputValue('#planHrs')) === '4');
await page.click('#punch'); await page.waitForTimeout(150);
ok('projects a 1:00 PM stop', (await T('#planEta')).includes('1:00 PM'), await T('#planEta'));
await ff(3.9 * 3600_000);
ok('still running just before the target', (await T('#statusTxt')).includes('On the clock'));
await ff(0.2 * 3600_000);
ok('auto-stopped itself', (await T('#statusTxt')).includes('Clocked out'), await T('#statusTxt'));
ok('banked exactly 4 h = $152.00', Math.abs(await num('#dGross') - 152) < 0.005, await T('#dGross'));
ok('log shows a clean 4.00 h', (await T('#logBody')).includes('4.00'));
ok('stopped at 1:00 PM, no overrun', (await T('#logBody')).includes('1:00 PM'));
await page.screenshot({ path: SHOT + '/04-autostop.png', fullPage: true });

/* ---------------------------------------------------------------- */
console.log('\nAuto-stop counts hours already banked today');
await boot('2026-07-30T17:00:00Z', { ...BASE, planOn: true, plannedHours: 8, sessions: [seedShift('am', 30, 6, 3)] });
await page.click('#punch'); await page.waitForTimeout(150);   // clock in 1 PM with 3 h banked
ok('5 h left → stops at 6:00 PM', (await T('#planEta')).includes('6:00 PM'), await T('#planEta'));

/* ---------------------------------------------------------------- */
console.log('\nPay period rollover');
await boot('2026-08-09T13:00:00Z', {
  ...BASE, sessions: [{ id: 'old', start: +new Date(2026, 7, 7, 9), end: +new Date(2026, 7, 7, 17) }],
});
ok('new period Sun Aug 9 → Sat Aug 22', (await T('#prange')) === 'Sun Aug 9 → Sat Aug 22, 2026', await T('#prange'));
ok('next payday Fri Sep 4', (await T('#payday')) === 'Fri Sep 4, 2026', await T('#payday'));
ok('period-to-date reset to $0.00', (await T('#pGross')) === '$0.00', await T('#pGross'));
// The log now reassures rather than showing an empty state when shifts exist elsewhere.
ok('last period shift not listed, and says why',
   (await T('#logBody')).includes('saved outside this pay period'), (await T('#logBody')).trim().slice(0,70));
ok('OT counter reset to 0', (await T('#otNum')).includes('0.00 / 40 h'), await T('#otNum'));

/* ---------------------------------------------------------------- */
console.log('\nPeriod-mode OT (80 h) via settings');
await boot('2026-07-30T13:00:00Z', { ...BASE, sessions: WEEK38 });
await page.evaluate(()=>{document.querySelectorAll('#cfg details').forEach(d=>d.open=true)}); await page.waitForTimeout(150);
await page.selectOption('#cMode', 'period'); await page.waitForTimeout(250);
ok('threshold label switches to 80 h', (await T('#otLbl')).includes('80'), await T('#otLbl'));
ok('counter targets 80 h', (await T('#otNum')).includes('38.00 / 80 h'), await T('#otNum'));
ok('same 38 h, no OT under the 80 h rule', !(await T('#wDet')).includes('OT'), await T('#wDet'));
await page.selectOption('#cMode', 'weekly'); await page.waitForTimeout(250);
ok('switching back restores the 40 h rule', (await T('#otNum')).includes('/ 40 h'), await T('#otNum'));

console.log('\nSettings round-trip');
await page.fill('#cRate', '41.50'); await page.dispatchEvent('#cRate', 'change'); await page.waitForTimeout(250);
ok('rate change re-prices the week', Math.abs(await num('#wGross') - 38 * 41.5) < 0.01, await T('#wGross'));
await page.reload(); await page.waitForTimeout(300); await openAll(page);
ok('rate persisted across reload', (await page.inputValue('#cRate')) === '41.5', await page.inputValue('#cRate'));
await page.evaluate(()=>{document.querySelectorAll('#cfg details').forEach(d=>d.open=true)}); await page.waitForTimeout(150);
await page.fill('#cRate', '38'); await page.dispatchEvent('#cRate', 'change'); await page.waitForTimeout(250);
ok('restored to $38', Math.abs(await num('#wGross') - 1444) < 0.01, await T('#wGross'));

/* ---------------------------------------------------------------- */
console.log('\nMobile layout');
const mob = await ctx.newPage();
await mob.setViewportSize({ width: 390, height: 1500 });
await mob.clock.install({ time: new Date('2026-07-30T13:00:00Z') });
await mob.goto('http://localhost:8099/'); await mob.waitForTimeout(400); await openAll(mob);
const overflow = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('no horizontal overflow at 390px', overflow <= 0, `overflow ${overflow}px`);
await mob.screenshot({ path: SHOT + '/05-mobile.png', fullPage: true });

console.log(`\n${fails === 0 ? '✅' : '❌'}  browser drive: ${fails} failure(s)\n`);
await browser.close(); srv.close();
process.exit(fails ? 1 : 0);
