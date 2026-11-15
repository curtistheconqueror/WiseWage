/* The clock that ran for weeks.

   The owner left the app with a shift running, believing that a scheduled end of 22:30
   would stop it. Nothing used that end to stop anything. He came back to a clock that had
   counted thousands of dollars nobody earned, and closed it by hand.

   Three things had to be true for that to happen, and this suite holds all three shut:

     1. A scheduled end now actually ends the shift — retroactively, on open, because no
        code runs while the page is closed.
     2. A clock left running is ended whatever the settings say. There is no configuration
        under which counting a three-week punch is correct.
     3. The hours that were cut are offered straight back, by a prompt that survives the
        app being closed and stays up until the next shift is due.

   The old banner is not enough and this suite says why: it only ever asked, while the
   clock kept climbing behind the question. */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
const CHROME = process.env.PW_CHROME || undefined;
const KEY = 'payclock.v1';
const srv = http.createServer((q, r) => {
  const u = q.url || '/';
  if (u.startsWith('/sw.js')) { r.writeHead(200, {'Content-Type':'text/javascript'}); return r.end(readFileSync(ROOT+'sw.js')); }
  if (u.startsWith('/manifest')) { r.writeHead(200, {'Content-Type':'application/manifest+json'}); return r.end(readFileSync(ROOT+'manifest.webmanifest')); }
  if (u.indexOf('.png') > -1) { r.writeHead(404); return r.end(); }
  r.writeHead(200, {'Content-Type':'text/html'}); r.end(readFileSync(ROOT+'index.html'));
}).listen(8431);

let fails = 0;
const ok = (n, c, x='') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${x ? '  → ' + x : ''}`); if (!c) fails++; };

const b = await chromium.launch({ executablePath: CHROME });

// The shape this was reported from: a Sun–Thu roster, an evening shift, 8-and-40 overtime.
const CFG = { rate: 37.78, otMode: 'eight40', otMultiplier: 1.5, weeklyThreshold: 40,
              schedStart: '14:00', schedEnd: '22:30',
              /* Switched on explicitly: it is OFF by default, because closing at the roster
                 every day is a daily question and the owner's real shifts routinely run
                 past it. The runaway floor below needs no setting and gets none. */
              autoOut: true,
              workDays: [true, true, true, true, true, false, false],
              periodAnchor: '2026-09-06', periodLengthDays: 14, payDateOffsetDays: 13,
              holidays: [], banks: [], daysOff: [], vacations: [] };

const IN = +new Date(2026, 10, 11, 14);          // Wed 11 Nov 2026, 2 PM — clocked in
const seed = (over = {}) => ({ configured: true, mode: 'full',
  cfg: Object.assign({}, CFG, over.cfg || {}),
  sessions: over.sessions || [], absences: [], units: [], stipends: [], otHist: [],
  activeStart: IN, activeAdj: null, unit: 'sec', planOn: false, plannedHours: 8,
  sound: false, otAsk: over.otAsk === undefined ? null : over.otAsk });

async function open_(at, over = {}) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 1500 },
    isMobile: true, hasTouch: true, timezoneId: 'America/Chicago', locale: 'en-US' });
  const p = await ctx.newPage();
  p.on('pageerror', e => { console.log('  PAGE ERROR:', e.message); fails++; });
  await p.addInitScript(([k, v]) => { localStorage.setItem(k, JSON.stringify(v)); }, [KEY, seed(over)]);
  await p.clock.install({ time: new Date(at) });
  await p.goto('http://localhost:8431/');
  await p.waitForTimeout(700);
  await p.evaluate(() => document.querySelectorAll('.col').forEach(c => c.classList.add('open')));
  await p.waitForTimeout(250);
  return { ctx, p };
}
const shifts = p => p.evaluate(() => state.sessions.map(s => ({
  id: s.id, start: s.start, end: s.end, h: +((s.end - s.start) / 3600000).toFixed(2) })));

console.log('\n━━ 1. Opened the next morning: the shift ended at 22:30, not now ━━');
{
  const { ctx, p } = await open_(+new Date(2026, 10, 12, 9));     // Thu 9 AM
  ok('the clock is not still running', (await p.evaluate(() => state.activeStart)) === null,
     String(await p.evaluate(() => state.activeStart)));
  const s = await shifts(p);
  ok('one shift was banked', s.length === 1, JSON.stringify(s));
  ok('and it is 8.50 h, not 19', s[0] && s[0].h === 8.5, s[0] && String(s[0].h));
  ok('ending exactly at the scheduled end',
     s[0] && s[0].end === +new Date(2026, 10, 11, 22, 30), s[0] && String(new Date(s[0].end)));
  ok('the overtime question is up', await p.isVisible('#otAsk'));
  const txt = await p.textContent('#otAsk');
  ok('and it names the time and the day', /10:30\s*PM/i.test(txt) && /Nov 11/i.test(txt), txt.replace(/\s+/g,' ').slice(0, 150));
  await ctx.close();
}

console.log('\n━━ 2. "Yes, I stayed" puts the real hours back ━━');
{
  const { ctx, p } = await open_(+new Date(2026, 10, 12, 9));
  await p.click('#otAskYes'); await p.waitForTimeout(250);
  ok('it asks what time instead of guessing', await p.isVisible('#otAskWhen'));
  const pre = await p.inputValue('#otAskTime');
  ok('prefilled with the time it cut at', pre === '22:30', pre);
  await p.fill('#otAskTime', '01:15');          // stayed until 1:15 AM
  await p.click('#otAskSave'); await p.waitForTimeout(500);
  const s = await shifts(p);
  ok('the shift now runs to 1:15 AM the next day',
     s[0] && s[0].end === +new Date(2026, 10, 12, 1, 15), s[0] && String(new Date(s[0].end)));
  ok('which is 11.25 h', s[0] && s[0].h === 11.25, s[0] && String(s[0].h));
  ok('and the question is gone', !(await p.isVisible('#otAsk')));
  ok('and it does not come back on reload', (await p.evaluate(() => state.otAsk)) === null);
  await ctx.close();
}

console.log('\n━━ 3. A time of day alone does not say which day ━━');
{
  // 9 PM is that evening; the save must not push it to tomorrow.
  const { ctx, p } = await open_(+new Date(2026, 10, 12, 9));
  await p.click('#otAskYes'); await p.waitForTimeout(200);
  await p.fill('#otAskTime', '21:00');
  await p.click('#otAskSave'); await p.waitForTimeout(400);
  let s = await shifts(p);
  ok('9 PM reads as that evening, shortening the shift',
     s[0] && s[0].end === +new Date(2026, 10, 11, 21), s[0] && String(new Date(s[0].end)));
  ok('so correcting it EARLIER works too, not only later', s[0] && s[0].h === 7, s[0] && String(s[0].h));
  await ctx.close();
}

console.log('\n━━ 4. "No" leaves it alone and stays answered ━━');
{
  const { ctx, p } = await open_(+new Date(2026, 10, 12, 9));
  await p.click('#otAskNo'); await p.waitForTimeout(400);
  ok('the question closes', !(await p.isVisible('#otAsk')));
  ok('the shift is untouched at 8.50 h', (await shifts(p))[0].h === 8.5);
  ok('and the answer is remembered', (await p.evaluate(() => state.otAsk)) === null);
  await ctx.close();
}

console.log('\n━━ 5. The question survives the app being closed ━━');
{
  // Reopened later the same day: the answer was never given, so it must still be asked.
  const { ctx, p } = await open_(+new Date(2026, 10, 12, 9));
  const carried = await p.evaluate(() => JSON.stringify(state.otAsk));
  await ctx.close();
  const again = await b.newContext({ viewport: { width: 390, height: 1500 },
    isMobile: true, hasTouch: true, timezoneId: 'America/Chicago', locale: 'en-US' });
  const p2 = await again.newPage();
  await p2.addInitScript(([k, v]) => { localStorage.setItem(k, v); },
    [KEY, JSON.stringify(Object.assign(JSON.parse(JSON.stringify(seed())), {
      activeStart: null, otAsk: JSON.parse(carried),
      sessions: [{ id: JSON.parse(carried).shiftId, jobId: null, start: IN,
                   end: +new Date(2026, 10, 11, 22, 30), note: '' }] }))]);
  await p2.clock.install({ time: new Date(2026, 10, 12, 13) });    // Thu 1 PM, before the 2 PM shift
  await p2.goto('http://localhost:8431/');
  await p2.waitForTimeout(700);
  await p2.evaluate(() => document.querySelectorAll('.col').forEach(c => c.classList.add('open')));
  ok('still being asked an hour before the next shift', await p2.isVisible('#otAsk'));
  await again.close();
}

console.log('\n━━ 6. It expires when the next shift is due, not overnight ━━');
{
  const asked = { shiftId: 'x1', at: +new Date(2026, 10, 11, 22, 30), why: 'sched',
                  until: +new Date(2026, 10, 12, 14), cutHours: 10.5 };
  const ctx = await b.newContext({ viewport: { width: 390, height: 1500 },
    isMobile: true, hasTouch: true, timezoneId: 'America/Chicago', locale: 'en-US' });
  const p = await ctx.newPage();
  await p.addInitScript(([k, v]) => { localStorage.setItem(k, v); },
    [KEY, JSON.stringify(Object.assign(JSON.parse(JSON.stringify(seed())), {
      activeStart: null, otAsk: asked,
      sessions: [{ id: 'x1', jobId: null, start: IN, end: asked.at, note: '' }] }))]);
  await p.clock.install({ time: new Date(2026, 10, 12, 15) });     // 3 PM — the shift has begun
  await p.goto('http://localhost:8431/');
  await p.waitForTimeout(700);
  await p.evaluate(() => document.querySelectorAll('.col').forEach(c => c.classList.add('open')));
  ok('gone once the next shift has started', !(await p.isVisible('#otAsk')));
  ok('and it is not left sitting in storage', (await p.evaluate(() => state.otAsk)) === null);
  await ctx.close();
}

console.log('\n━━ 7. The runaway: the money stops, the shift stays open ━━');
{
  /* The incident itself: auto-out off, app reopened nineteen days later, 452 hours on the
     clock. Nothing is banked — writing a shift nobody confirmed is the one thing this app
     refuses to do, and `shortcut` and `smoke` both assert it by name. What stops is the
     COUNTING: the figure freezes at the end the banner is already offering, so a punch
     nobody closed can no longer cost anybody an accurate record. */
  const { ctx, p } = await open_(+new Date(2026, 10, 30, 10), { cfg: { autoOut: false } });
  const ran = (+new Date(2026, 10, 30, 10) - IN) / 3600000;
  ok('the punch really is 452 h long', ran > 450, ran.toFixed(0) + ' h');
  ok('the shift is still open, not banked behind the user',
     (await p.evaluate(() => state.activeStart)) === IN);
  ok('and nothing was written to the log', (await shifts(p)).length === 0);
  ok('the banner is asking about it', await p.isVisible('#forgotBar'));

  /* The money is the point. 452 h with 8-and-40 overtime is tens of thousands of dollars;
     frozen at the plausible end it is a single ordinary shift. */
  const shown = await p.evaluate(() => document.getElementById('money').textContent);
  const cash = +shown.replace(/[^0-9.]/g, '');
  ok('the live figure is frozen at one shift, not 452 hours of it', cash > 0 && cash < 1000, shown);
  /* The wall clock is NOT falsified — it still says how long the punch has been open. */
  ok('while the timer still tells the truth about the span',
     /^\d{3,}:/.test(await p.evaluate(() => document.getElementById('timer').textContent)),
     await p.evaluate(() => document.getElementById('timer').textContent));

  /* A number that has stopped moving with nothing saying why is its own kind of wrong. */
  ok('the label says the figure is paused',
     /paused/i.test(await p.evaluate(() => document.getElementById('moneyLbl').textContent)),
     await p.evaluate(() => document.getElementById('moneyLbl').textContent));

  /* "No, it is still running" is believed: somebody on a genuine marathon keeps counting. */
  await p.click('#forgotKeep'); await p.waitForTimeout(400);
  const after = +(await p.evaluate(() => document.getElementById('money').textContent))
    .replace(/[^0-9.]/g, '');
  ok('saying it is still running unfreezes it', after > cash, `${shown} -> ${after}`);
  ok('and the label stops saying paused',
     !/paused/i.test(await p.evaluate(() => document.getElementById('moneyLbl').textContent)),
     await p.evaluate(() => document.getElementById('moneyLbl').textContent));
  await ctx.close();
}

console.log('\n━━ 8. An ordinary long day is still left alone ━━');
{
  /* The cost of crying wolf is the warning itself. Eleven hours on an 8.5 h roster with
     auto-out off is a real day, and nothing should touch it. */
  const { ctx, p } = await open_(+new Date(2026, 10, 12, 1), { cfg: { autoOut: false } });
  ok('still on the clock at 1 AM', (await p.evaluate(() => state.activeStart)) === IN);
  ok('nothing was banked behind the user', (await shifts(p)).length === 0);
  ok('and no overtime question was invented', !(await p.isVisible('#otAsk')));
  await ctx.close();
}

console.log('\n━━ 9. Mid-shift, with auto-out ON, nothing happens early ━━');
{
  const { ctx, p } = await open_(+new Date(2026, 10, 11, 20));     // 8 PM, before 22:30
  ok('the clock is still running', (await p.evaluate(() => state.activeStart)) === IN);
  ok('nothing banked', (await shifts(p)).length === 0);
  ok('and nothing is being asked', !(await p.isVisible('#otAsk')));
  await ctx.close();
}

console.log('\n━━ 10. The question is first in the card and reachable ━━');
{
  const { ctx, p } = await open_(+new Date(2026, 10, 12, 9));
  const geo = await p.evaluate(() => {
    const a = document.getElementById('otAsk');
    const money = document.getElementById('money');
    const yes = document.getElementById('otAskYes');
    return { aboveTheMoney: a.getBoundingClientRect().top < money.getBoundingClientRect().top,
             firstInBody: a.parentElement.firstElementChild.id === 'otAsk'
                       || a.previousElementSibling === null,
             yesH: Math.round(yes.getBoundingClientRect().height),
             heroOpen: document.getElementById('hero').classList.contains('open') };
  });
  ok('it sits above the live earnings figure', geo.aboveTheMoney, JSON.stringify(geo));
  ok('and the buttons are finger-sized', geo.yesH >= 44, geo.yesH + 'px');
  await ctx.close();
}

console.log('\n━━ 11. A folded clock card is opened so it cannot hide the question ━━');
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 1500 },
    isMobile: true, hasTouch: true, timezoneId: 'America/Chicago', locale: 'en-US' });
  const p = await ctx.newPage();
  await p.addInitScript(([k, v]) => { localStorage.setItem(k, JSON.stringify(v)); }, [KEY, seed()]);
  await p.clock.install({ time: new Date(2026, 10, 12, 9) });
  await p.goto('http://localhost:8431/');
  await p.waitForTimeout(700);
  // deliberately NOT opening the cards by hand this time
  ok('the clock card was opened for it', await p.evaluate(() =>
     document.getElementById('hero').classList.contains('open')));
  ok('and the question is actually on screen', await p.isVisible('#otAsk'));
  await ctx.close();
}

console.log(`\n${fails === 0 ? '✅' : '❌'}  ${fails === 0 ? 'all passed' : fails + ' failed'}\n`);
await b.close(); srv.close();
process.exit(fails ? 1 : 0);
