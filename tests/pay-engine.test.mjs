/**
 * Tests the pay engine by extracting it verbatim from pay-clock.html — so what's
 * verified here is exactly the code that ships, with no duplicated copy to drift.
 *
 *   node tests/pay-engine.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// index.html when the widget is the whole site; pay-clock.html when it sits alongside
// other pages. Pick by which file actually carries the engine, not by name — a repo can
// have an unrelated index.html.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKERS = /\/\* ==ENGINE-START==[\s\S]*?\*\/([\s\S]*?)\/\* ==ENGINE-END== \*\//;

let m = null, widget = null;
for (const name of ['pay-clock.html', 'index.html']) {
  const path = join(root, name);
  if (!existsSync(path)) continue;
  const found = readFileSync(path, 'utf8').match(MARKERS);
  if (found) { m = found; widget = name; break; }
}
if (!m) { console.error('FATAL: no file with engine markers found'); process.exit(1); }
console.log(`engine source: ${widget}`);

const E = new Function(m[1] + `
  return { DEFAULTS, periodInfo, weekInfo, splitSession, buildLedger,
           sumRange, sumSession, bucketHoursAt, plannedStopAt, quantize, HOUR_MS,
           HOLIDAY_DEFAULTS, nthDow, holidayDate, holidaysInYear, holidayOn,
           HOLIDAY_CATALOG, holidaysFromCatalog, holidayPresetIds, easterSunday,
           isWorkDay, anyWorkDay, adjacentWorkDay, dkey,
           workedOn, holidayEligibility, holidayYears, holidayCredits, holidayOutlook,
           BANK_DEFAULTS, BANK_KINDS, bankById, daysOffUsed, bankLeft, bankSlots, dayOffName,
           bankUsedBefore, bankUsed,
           bankCredits, daysOffOutlook, periodHistory, timeCardRows, timeCardTotals,
           extraTime, chartHours, otThresholdOf, otBucketKey, sumSessionRange,
           payMonths, currentPayMonth, shiftDayMs, toMinute,
           fmtSheetTime, sheetRows, sheetBlocks,
           skewMs, shopTime, phoneTime, shopSession,
           ABSENCE_KINDS, absenceKindName, schedHoursOn, schedEndMs, absenceHoursOn,
           workedPaidOn, scheduleGaps, makeUpOwed, makeUpBalance, applyMakeUp,
           bankOwes, vacationCredits, vacationOn, vacationDays,
           sumShiftDay, todayShiftDay,
           nightWindow, inNightWindow, splitNight, sumNight, scheduledWeekHours,
           premiumList, premiumCovers, premiumsAt, splitPremiums,
           callbackMin, applyCallback,
           unitCfg, unitsInRange, unitPay, unitPace,
           contractCfg, stipendTotal, contractProgress, chequesPaid, contractView,
           oteRand, otePeriodSamples, oteAllSamples, oteDrawPool, oteForecast, OTE_MIN_SAMPLES,
           forgottenShift, FORGOT_FALLBACK_H, shiftShape,
           pctSplit, itemBasis,
           fedNotWithheld, netBreakdown, periodNetView,
           TAX_YEAR, TAX2026, bracketTax, fedWithholding };
`)();

// The shipped defaults carry no wage or pay schedule — those come from first-run setup —
// so the suite supplies the numbers it asserts against.
const cfg = { ...E.DEFAULTS, rate: 38, periodAnchor: '2026-07-26' };
let pass = 0, fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '  → ' + extra : ''}`); }
}
function near(name, got, want, tol = 1e-9) {
  ok(name, Math.abs(got - want) <= tol, `got ${got}, want ${want}`);
}
function group(t) { console.log(`\n${t}`); }

// Local-time helper so the suite is timezone-agnostic.
const at = (y, mo, d, h = 0, mi = 0) => +new Date(y, mo - 1, d, h, mi, 0, 0);
const shift = (id, a, b) => ({ id, start: a, end: b });
const gross = (sessions, c = cfg) => {
  const l = E.buildLedger(sessions, c);
  return l.parts.reduce((s, p) => s + p.gross, 0);
};

/* ---------------- the 8 and 80 rule (FLSA 7(j)) ---------------- */
{
  const c = { ...E.DEFAULTS, rate: 40, otMultiplier: 1.5, otMode: 'eighty80',
              dailyThreshold: 8, periodThreshold: 80, lunchMins: 0,
              holidays: [], banks: [], daysOff: [], vacations: [],
              periodAnchor: '2026-08-09', periodLengthDays: 14 };
  const day = (d, len) => ({ id: 'd' + d, start: +new Date(2026, 7, d, 7),
                             end: +new Date(2026, 7, d, 7) + len * E.HOUR_MS });
  const tot = ss => { const l = E.buildLedger(ss, c, +new Date(2026, 8, 1));
                      return E.sumRange(l.parts, +new Date(2026, 7, 9), +new Date(2026, 7, 23)); };

  /* Three twelves a week — 72 hours across the period. A 40-hour week gives none of it as
     overtime; every twelve-hour day gives four. This gap is the whole reason the mode exists. */
  const twelves = [9,10,11,16,17,18].map(d => day(d, 12));
  const t1 = tot(twelves);
  near('six twelve-hour days is 72 hours', t1.hours, 72);
  near('and 24 of them are overtime',      t1.otHours, 24);
  near('paid accordingly', t1.gross, 48 * 40 + 24 * 60);

  const weekly = E.sumRange(E.buildLedger(twelves, { ...c, otMode: 'weekly', weeklyThreshold: 40 },
                            +new Date(2026, 8, 1)).parts,
                            +new Date(2026, 7, 9), +new Date(2026, 7, 23));
  near('the same schedule under a 40-hour week has no overtime at all', weekly.otHours, 0);
  ok('which is worth real money', t1.gross - weekly.gross > 0,
     '$' + (t1.gross - weekly.gross).toFixed(2) + ' a period');

  /* And it cuts the other way. Six eights then four eights is 80 hours: no day passes eight
     and the period never passes eighty, so nothing is overtime — where a 40-hour week would
     have paid eight hours of it. */
  const uneven = [9,10,11,12,13,14].map(d => day(d, 8)).concat([16,17,18,19].map(d => day(d, 8)));
  const t2 = tot(uneven);
  near('48 then 32 is 80 hours', t2.hours, 80);
  near('and none of it is overtime here', t2.otHours, 0);
  const w2 = E.sumRange(E.buildLedger(uneven, { ...c, otMode: 'weekly', weeklyThreshold: 40 },
                        +new Date(2026, 8, 1)).parts,
                        +new Date(2026, 7, 9), +new Date(2026, 7, 23));
  near('where a 40-hour week would pay eight', w2.otHours, 8);

  /* The period rule on its own: ten eights then two more days of eight is 96 hours, no day
     over eight, so the only overtime comes from passing eighty. */
  const long = [9,10,11,12,13,16,17,18,19,20,21,22].map(d => day(d, 8));
  const t3 = tot(long);
  near('twelve eight-hour days is 96 hours', t3.hours, 96);
  near('sixteen hours past eighty are overtime', t3.otHours, 16);

  /* Both rules at once, with the credit rule doing its job. Ten ten-hour days is 100 hours:
     20 hours of daily overtime, and 80 straight hours — so exactly 20, not 40. */
  const tens = [9,10,11,12,13,16,17,18,19,20].map(d => day(d, 10));
  const t4 = tot(tens);
  near('ten ten-hour days is 100 hours', t4.hours, 100);
  near('and 20 hours of overtime, not 40 — the credit rule', t4.otHours, 20);
  near('so straight time is capped at eighty', t4.regHours, 80);

  /* Once eighty straight hours are gone, a fresh short day is overtime from its first minute. */
  const past = [9,10,11,12,13,16,17,18,19,20].map(d => day(d, 8)).concat([day(21, 6)]);
  const t5 = tot(past);
  near('80 straight then a six-hour day', t5.hours, 86);
  near('every hour of that day is overtime', t5.otHours, 6);

  /* Straight-time hours can never exceed either cap, whatever the schedule. */
  [twelves, uneven, long, tens, past].forEach(function(ss, i){
    const t = tot(ss);
    ok('schedule ' + (i + 1) + ': straight time never passes eighty', t.regHours <= 80 + 1e-9,
       t.regHours.toFixed(2));
    near('schedule ' + (i + 1) + ': hours all accounted for', t.regHours + t.otHours, t.hours);
  });

  /* The progress bar: the day bucket while there is period allowance left, pinned full once
     there is not. */
  /* The ledger holds what has been worked so far, so a shift four hours old is four hours
     in the bucket. */
  const led = E.buildLedger([day(9, 4)], c, +new Date(2026, 7, 9, 11));
  near('four hours into a day reads four',
       E.bucketHoursAt(led, +new Date(2026, 7, 9, 11), c), 4);
  near('and a second day starts from nothing again',
       E.bucketHoursAt(E.buildLedger([day(9, 8), day(10, 3)], c, +new Date(2026, 7, 10, 10)),
                       +new Date(2026, 7, 10, 10), c), 3);
  const ledPast = E.buildLedger(past, c, +new Date(2026, 8, 1));
  near('but past eighty straight the bar reads full',
       E.bucketHoursAt(ledPast, +new Date(2026, 7, 21, 9), c), 8);

  near('the headline threshold is the daily one', E.otThresholdOf(c), 8);
}

/* ---------------- the 8 and 40 rule — the ordinary union one ---------------- */
{
  const c = { ...E.DEFAULTS, rate: 40, otMultiplier: 1.5, otMode: 'eight40',
              shiftThreshold: 8, weeklyThreshold: 40, lunchMins: 0, weekStartDay: 0,
              holidays: [], banks: [], daysOff: [], vacations: [],
              periodAnchor: '2026-08-09', periodLengthDays: 14 };
  /* Sunday 9 August 2026 is a week start. Shifts run from 2 PM the way a late run does,
     so the long ones cross midnight — which is the case the rule has to get right. */
  const run = (d, len, h = 14) => ({ id: 'r' + d + '_' + h, start: +new Date(2026, 7, d, h),
                                     end: +new Date(2026, 7, d, h) + len * E.HOUR_MS });
  const week = (ss, cfg = c) => E.sumRange(E.buildLedger(ss, cfg, +new Date(2026, 7, 20)).parts,
                                           +new Date(2026, 7, 9), +new Date(2026, 7, 16));
  const under = (ss, mode) => week(ss, { ...c, otMode: mode });

  /* A real week: four shifts of 11.35 h, Sunday to Wednesday, each running past midnight.
     45.40 hours. The per-shift rule pays 13.40 h of overtime; a 40-hour week pays 5.40.
     8 and 40 has to pay the larger without inventing anything. */
  const longDays = [9, 10, 11, 12].map(d => run(d, 11.35));
  const L = week(longDays);
  near('four 11.35 h shifts is 45.40 hours', L.hours, 45.4);
  near('and 13.40 of them are overtime',     L.otHours, 13.4);
  near('per shift alone pays the same',      under(longDays, 'shift').otHours, 13.4);
  near('a 40-hour week alone pays 5.40',     under(longDays, 'weekly').otHours, 5.4);
  ok('so the combined rule takes the bigger of the two',
     Math.abs(L.otHours - Math.max(under(longDays, 'shift').otHours,
                                   under(longDays, 'weekly').otHours)) < 1e-9);

  /* The week that catches the per-shift rule out: six seven-hour shifts. No shift ever
     reaches eight, so a shift rule pays nothing — but the week is 42 hours. */
  const shortDays = [9, 10, 11, 12, 13, 14].map(d => run(d, 7));
  const S = week(shortDays);
  near('six seven-hour shifts is 42 hours', S.hours, 42);
  near('per shift alone pays nothing',      under(shortDays, 'shift').otHours, 0);
  near('but two hours are past forty',      S.otHours, 2);
  near('and they are paid for',             S.gross, 40 * 40 + 2 * 60);

  /* Neither leg reached: 39 hours, no shift over eight. Nothing is overtime. */
  const quiet = [9, 10, 11, 12, 13, 14].map(d => run(d, 6.5));
  near('six six-and-a-half hour shifts is 39 hours', week(quiet).hours, 39);
  near('and none of it is overtime',                 week(quiet).otHours, 0);

  /* The credit rule, which is the no-pyramiding clause. Five nines is 45 hours: 5 hours past
     eight in a shift, and 40 straight hours exactly. Five, not ten — an hour already paid at
     time and a half is never counted toward the forty and then charged for again. */
  const nines = [9, 10, 11, 12, 13].map(d => run(d, 9));
  const N = week(nines);
  near('five nine-hour shifts is 45 hours', N.hours, 45);
  near('five hours of overtime, not ten',   N.otHours, 5);
  near('so straight time is exactly forty', N.regHours, 40);

  /* Past forty straight hours, a fresh short shift is overtime from its first minute — the
     thing that cannot happen under a per-shift rule however long the week has been. */
  const pastForty = [9, 10, 11, 12, 13].map(d => run(d, 8)).concat([run(14, 5)]);
  const P = week(pastForty);
  near('five eights then a five is 45 hours', P.hours, 45);
  near('every hour of that last shift is overtime', P.otHours, 5);
  near('and the per-shift rule would have paid none', under(pastForty, 'shift').otHours, 0);

  /* Straight time can never pass either cap, whatever the schedule. */
  [longDays, shortDays, quiet, nines, pastForty].forEach(function(ss, i){
    const t = week(ss);
    ok('schedule ' + (i + 1) + ': straight time never passes forty', t.regHours <= 40 + 1e-9,
       t.regHours.toFixed(2));
    near('schedule ' + (i + 1) + ': hours all accounted for', t.regHours + t.otHours, t.hours);
  });

  /* It is never worse than either rule on its own — the whole reason to be on it. Checked
     across every shape of week rather than asserted: shift lengths from half an hour to
     sixteen, start times around the clock, one to seven shifts. */
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let worse = 0, better = 0, exact = 0, n = 0;
  for (let t = 0; t < 1500; t++){
    const ss = [];
    for (let i = 0, k = 1 + Math.floor(rnd() * 7); i < k; i++)
      ss.push(run(9 + i, 0.5 + rnd() * 15.5, Math.floor(rnd() * 22)));
    const both = week(ss).otHours, sh = under(ss, 'shift').otHours, wk = under(ss, 'weekly').otHours;
    n++;
    if (both < Math.max(sh, wk) - 1e-9) worse++;
    else if (both > Math.max(sh, wk) + 1e-9) better++;
    else exact++;
  }
  ok('over ' + n + ' random weeks it is never worse than the better single rule', worse === 0,
     worse + ' worse, ' + exact + ' equal, ' + better + ' better');
  ok('and usually exactly the better one', exact > n * 0.9, exact + ' of ' + n);

  /* Where it beats both totals it is because a shift crossed a week boundary: the eight-hour
     allowance carries over with the shift while the forty resets, so each workweek is judged
     on its own. Inside a single week it is exactly the better of the two, never more. */
  let inWeek = 0, over = 0;
  for (let t = 0; t < 1500; t++){
    const ss = [];
    for (let i = 0, k = 1 + Math.floor(rnd() * 6); i < k; i++){
      const h = Math.floor(rnd() * 14);
      ss.push(run(9 + i, Math.min(0.5 + rnd() * 9.5, 24 - h), h));   // never crosses a midnight
    }
    inWeek++;
    if (Math.abs(week(ss).otHours
                 - Math.max(under(ss, 'shift').otHours, under(ss, 'weekly').otHours)) > 1e-9) over++;
  }
  ok('inside one week it is exactly the better of the two, every time', over === 0,
     over + ' of ' + inWeek + ' differed');

  near('the headline threshold is the shift one', E.otThresholdOf(c), 8);

  /* The progress bar counts the shift, then pins full once forty straight hours are gone —
     a bar that reset on each punch would promise an allowance that is not there. */
  const mid = E.buildLedger([run(9, 4)], c, +new Date(2026, 7, 9, 18));
  near('four hours into a shift reads four',
       E.bucketHoursAt(mid, +new Date(2026, 7, 9, 18), c, 'r9_14'), 4);
  const spent = E.buildLedger(pastForty, c, +new Date(2026, 7, 20));
  near('but past forty straight the bar reads full',
       E.bucketHoursAt(spent, +new Date(2026, 7, 14, 16), c, 'r14_14'), 8);
}

/* ---------------- a punch that was never ended ---------------- */
{
  /* Curtis's roster: Sun–Thu, 2:00 PM to 10:30 PM. The shift that matters runs past
     midnight, which is exactly where a naive "same calendar day" test falls over. */
  const c = { ...E.DEFAULTS, rate: 37.78, otMultiplier: 1.5, otMode: 'shift',
              shiftThreshold: 8, weekStartDay: 0, lunchMins: 30,
              schedStart: '14:00', schedEnd: '22:30',
              workDays: [true,true,true,true,true,false,false],
              holidays: [], banks: [], daysOff: [], vacations: [],
              periodAnchor: '2026-08-09', periodLengthDays: 14, payDateOffsetDays: 13 };
  const IN = +new Date(2026, 7, 12, 14);              // Wed 12 Aug, 2 PM
  const at = (d, h, mi) => +new Date(2026, 7, d, h, mi || 0);
  const f = (nowMs, cfg, ss) => E.forgottenShift(IN, nowMs, cfg || c, ss);

  /* ---- with no history yet ----
     The roster is deliberately NOT the yardstick. A new starter whose first shifts each run
     three hours long would be questioned on every one, and would learn to dismiss the thing
     before it ever caught a real mistake. Missing a forgotten punch for a few hours costs
     little — the banner is still there next time the app opens. Crying wolf costs the
     warning itself. */
  ok('mid-shift, nothing is wrong',        f(at(12, 18)) === null);
  ok('finishing on time is fine',          f(at(12, 22, 30)) === null);
  ok('three hours past the roster is not questioned', f(at(13, 1, 30)) === null);
  ok('nor is a twelve-hour day',           f(at(13, 2)) === null);
  ok('past fourteen hours it speaks up',   !!f(at(13, 4, 30)), JSON.stringify(f(at(13, 4, 30))));

  /* The overnight case this exists for: clocked in at 2 PM, noticed at 7 the next morning. */
  const nextDay = f(at(13, 7));
  ok('a forgotten punch is caught',        !!nextDay);
  near('seventeen hours on the clock',     nextDay.hours, 17);
  near('and with no history it suggests the rostered end', nextDay.suggested, at(12, 22, 30), 1);
  near('which is 8.5 h of shift',          nextDay.suggestedHours, 8.5);
  near('leaving 8.5 h it had been counting', nextDay.extra, 8.5);
  ok('it knows a midnight was crossed',    nextDay.overnight === true);

  /* ---- with history, which is the case that actually matters ----
     A real operator's log: rostered 8.5 h, works about 11.4, longest ever 12.98. Judged
     against the roster, eighteen of twenty-three real shifts would have been questioned. */
  const hist = [10.0, 10.25, 10.07, 11.19, 11.41, 8.58, 9.62, 10.77, 9.12, 9.49, 12.0,
                11.5, 9.01, 12.98, 11.5, 11.4, 11.52, 12.31, 9.13, 12.51, 11.5, 11.25, 10.5]
    .map(function(len, i){
      const st = +new Date(2026, 6, 26 + i, 14);
      return { id: 'h' + i, start: st, end: st + len * E.HOUR_MS };
    });
  const shape = E.shiftShape(hist);
  ok('the shape is read from the last twenty', shape.n === 20, String(shape.n));
  near('they typically work about 11.4 h', shape.typical, 11.4, 0.2);
  near('and their longest is 12.98',       shape.longest, 12.98, 0.01);

  ok('an eleven-hour night is not questioned', f(at(13, 1), c, hist) === null);
  ok('nor is their longest ever',              f(at(13, 3), c, hist) === null);
  ok('nor two hours past even that',           f(at(13, 4, 45), c, hist) === null);
  const caught = f(at(13, 7), c, hist);
  ok('but seventeen hours is',                 !!caught, JSON.stringify(caught && caught.why));
  ok('judged against their own record',        caught.why === 'history', caught.why);
  near('and it suggests their usual length',   caught.suggestedHours, shape.typical, 0.01);
  ok('which is far later than the roster would have said',
     caught.suggested > at(12, 22, 30), new Date(caught.suggested).toISOString());

  /* Not one of the twenty-three real shifts would have raised the question. */
  let cried = 0;
  hist.forEach(function(h, i){
    if (E.forgottenShift(h.start, h.end, c, hist.slice(0, i))) cried++;
  });
  ok('none of the twenty-three real shifts is questioned', cried === 0, cried + ' were');

  /* Too little history to generalise from falls back rather than guessing. */
  ok('three shifts is not a pattern', E.shiftShape(hist.slice(0, 3)) === null);
  ok('four is',                       E.shiftShape(hist.slice(0, 4)) !== null);
  ok('and rubbish rows are ignored',
     E.shiftShape([{start:1,end:0},{start:0,end:1},null].concat(hist.slice(0,4))).n === 4);

  /* The money this saves, priced the way the app prices it. Under a per-shift rule the
     8.5 phantom hours are ALL overtime, because the first eight were already used. */
  const real = E.buildLedger([{ id: 'r', start: IN, end: at(12, 22, 30) }], c);
  const runaway = E.buildLedger([{ id: 'r', start: IN, end: at(13, 7) }], c);
  const sum = l => l.parts.reduce((a, p) => a + p.gross, 0);
  const otOf = l => l.parts.reduce((a, p) => a + p.otHours, 0);
  /* 2 PM to 10:30 PM less the half-hour lunch is exactly 8.00 h paid — the threshold, and
     not a minute past it. */
  near('the real shift carries no overtime at all', otOf(real), 0);
  ok('the runaway invents hours of it', otOf(runaway) > 8, otOf(runaway).toFixed(2) + ' h');
  ok('worth hundreds of dollars that were never earned',
     sum(runaway) - sum(real) > 400, '$' + (sum(runaway) - sum(real)).toFixed(2));

  /* A day off the roster has no scheduled end to measure against, so it falls back to a
     length no ordinary shift reaches rather than saying nothing at all. */
  const sat = +new Date(2026, 7, 15, 14);             // Saturday, not a work day
  ok('an unrostered day is quiet at nine hours',
     E.forgottenShift(sat, sat + 9 * E.HOUR_MS, c) === null);
  const long = E.forgottenShift(sat, sat + 15 * E.HOUR_MS, c);
  ok('but speaks up past the fallback', !!long, JSON.stringify(long));
  ok('and says so',                     long.why === 'long', long.why);
  near('suggesting the fallback length', long.suggestedHours, E.FORGOT_FALLBACK_H);

  /* No schedule configured at all — the same fallback, not a crash and not silence. */
  const bare = { ...c, schedStart: '', schedEnd: '' };
  ok('no roster is quiet early',   f(at(12, 20), bare) === null);
  ok('and speaks up late',         !!f(at(13, 5), bare), JSON.stringify(f(at(13, 5), bare)));

  /* Nothing running, nothing to say. This is called on every render. */
  ok('no active shift returns nothing',    E.forgottenShift(null, at(13, 7), c) === null);
  ok('nor does a punch from the future',   E.forgottenShift(at(13, 9), at(13, 7), c) === null);

  /* The suggestion is never later than now, and never earlier than the punch — either would
     bank a negative shift or extend one that has not happened. */
  [at(13, 5), at(13, 7), at(14, 3), at(20, 12)].forEach(function(t){
    const x = E.forgottenShift(IN, t, c);
    ok('at ' + new Date(t).toISOString().slice(5, 16) + ' the suggestion sits inside the shift',
       x && x.suggested > IN && x.suggested <= t, x ? String(x.suggested) : 'null');
  });
}

/* ---------------- OT expectancy: resampled, not curve-fit ---------------- */
{
  const c = { ...E.DEFAULTS, rate: 40, otMultiplier: 1.5, otMode: 'weekly',
              weeklyThreshold: 40, weekStartDay: 0, lunchMins: 0,
              schedStart: '08:00', schedEnd: '16:00',
              workDays: [false,true,true,true,true,true,false],
              holidays: [], banks: [], daysOff: [], vacations: [],
              periodAnchor: '2026-01-04', periodLengthDays: 14, payDateOffsetDays: 13 };
  const mk = (month, ot) => ({ month, ot });
  /* Exactly a period boundary, so no partial-period weighting muddies the arithmetic:
     eleven whole periods remain in the year. */
  const NOW = +new Date(2026, 7, 16, 0, 0);   // Jan 4 + 16 fortnights — a true boundary
  /* basePer pinned so every figure below is arithmetic, not schedule reconstruction:
     $3,200 a period of straight time, 26 periods, OT at $60. */
  const fc = (samples, opts) => E.oteForecast(samples, c, NOW, 60000,
    Object.assign({ basePer: 3200, draws: 2000 }, opts));

  /* Below the minimum it refuses to answer at all — a probability from four periods is a
     lie with a percent sign, and this feature exists to be trusted by someone who is not
     the user. */
  const few = [mk(0,4), mk(1,0), mk(2,8), mk(3,2)];
  ok('below the minimum there is no probability', fc(few).ready === false,
     JSON.stringify(fc(few)));
  ok('and it says how much history it needs', fc(few).need === E.OTE_MIN_SAMPLES
     && fc(few).n === 4, fc(few).n + ' of ' + fc(few).need);

  /* Degenerate history reproduces itself exactly: if every period held 10 h of OT, the
     forecast is not allowed to invent variance the data does not have. */
  const flat10 = Array.from({length: 12}, (_, i) => mk(i, 10));
  const f1 = fc(flat10, { targets: [1, 10 ** 9] });
  ok('a flat history forecasts itself', Math.abs(f1.expOtPeriod - 10) < 1e-9, f1.expOtPeriod);
  near('every replay lands on the same year', f1.p90 - f1.p10, 0);
  ok('a trivial target is certain', f1.probs[1] === 1, String(f1.probs[1]));
  ok('an absurd one is impossible', f1.probs[10 ** 9] === 0, String(f1.probs[10 ** 9]));

  /* The year a flat-10 history produces, by hand: $60k banked + 11 remaining periods of
     (3200 + 10 × 60) = $101,800. So the probability must step exactly there. */
  /* Ten whole periods remain after 16 August: $60k banked + 10 × (3,200 + 10 × 60). */
  near('the projected year is hand-checkable', f1.expYear, 60000 + 10 * 3800, 1);
  const step = fc(flat10, { targets: [97999, 98001] });
  ok('a dollar under the true year is certain', step.probs[97999] === 1);
  ok('a dollar over it is impossible',          step.probs[98001] === 0);

  /* Probabilities move the right way. Same history, rising target → falling chance. */
  const mixed = [4,0,12,2,0,8,16,0,3,6,0,10].map((ot, i) => mk(i, ot));
  const m = fc(mixed, { targets: [90000, 100000, 110000] });
  ok('a higher target is never likelier',
     m.probs[90000] >= m.probs[100000] && m.probs[100000] >= m.probs[110000],
     [m.probs[90000], m.probs[100000], m.probs[110000]].join(' ≥ '));

  /* The lever: more overtime per period raises the chance, never lowers it. */
  const lever = fc(mixed, { targets: [96000], extraOt: 6 });
  const flatL = fc(mixed, { targets: [96000] });
  ok('six extra hours a period raises the chance',
     lever.probs[96000] > flatL.probs[96000],
     (100 * flatL.probs[96000]).toFixed(0) + '% → ' + (100 * lever.probs[96000]).toFixed(0) + '%');

  /* Seasonality: a history where winter is heavy must forecast a heavier December than
     June. The pool for a December draw prefers November-to-January. */
  const seasonal = [];
  for (const y of [0, 1]){                       // two winters, which is the point
    for (let mo = 0; mo < 12; mo++) seasonal.push(mk(mo, (mo === 11 || mo === 0) ? 20 : 2));
  }
  const decPool = E.oteDrawPool(seasonal, 11), junPool = E.oteDrawPool(seasonal, 5);
  const avg = pool => pool.reduce((a, s) => a + s.ot, 0) / pool.length;
  ok('a December draw sees the winter effect', avg(decPool) > 10, avg(decPool).toFixed(1));
  ok('a June draw does not', avg(junPool) < 5, avg(junPool).toFixed(1));
  ok('and the pools are genuinely different', avg(decPool) - avg(junPool) > 8,
     (avg(decPool) - avg(junPool)).toFixed(1) + ' h apart');

  /* Determinism: the same inputs give the same answer, so the score does not flicker
     between renders — it moves once per pay period. */
  const a1 = fc(mixed, { targets: [100000] }), a2 = fc(mixed, { targets: [100000] });
  ok('the same period gives the same figure', a1.probs[100000] === a2.probs[100000],
     a1.probs[100000] + ' vs ' + a2.probs[100000]);

  /* Manual months normalise into per-period samples: 26 hours in a month on a biweekly
     calendar is 12 per period, tagged with its month for the season match. */
  const manual = E.oteAllSamples([], c, NOW, [{ ym: '2025-12', otHours: 26 }]);
  near('a manual month becomes a per-period sample', manual[0].ot, 26 * 12 / 26, 0.01);
  ok('tagged with its month', manual[0].month === 11, String(manual[0].month));
  ok('and marked as manual', manual[0].manual === true);
  ok('garbage entries are dropped',
     E.oteAllSamples([], c, NOW, [{ ym: '', otHours: 5 }, { ym: '2025-03', otHours: 'x' }]).length === 0);

  /* Hostile samples cannot poison the money: one NaN in the pool once turned the whole
     projection into "$NaN" on screen. Dropped here, whatever door they came through. */
  const dirty = flat10.concat([mk(0, NaN), mk(1, Infinity), mk(2, -5), mk(3, 1e9), mk(-1, 5)]);
  const clean = fc(dirty.filter(x => isFinite(x.ot) && x.ot >= 0 && x.ot < 1e6
                                     && x.month >= 0), { targets: [97999] });
  const poisoned = fc(dirty, { targets: [97999] });
  ok('a NaN sample never reaches the projection', isFinite(poisoned.expYear),
     String(poisoned.expYear));
  ok('negative and unplaced samples are dropped too',
     poisoned.n === flat10.length + 1, poisoned.n + ' kept');   // the 1e9 outlier survives — huge is legal, NaN is not

  /* Ancient history must not crowd out the present. With a first shift ten years back, the
     capped walk once started at the beginning and never reached the recent periods — the
     only ones a forecast is entitled to lean on. */
  {
    const ancient = [{ id: 'old', start: +new Date(2016, 0, 4, 8),
                       end: +new Date(2016, 0, 4, 8) + 8 * E.HOUR_MS }];
    let n = 0;
    for (let w = 0; w < 8; w++) for (let d = 0; d < 5; d++){
      const st = +new Date(2026, 5, 7 + w * 7 + d, 8);
      ancient.push({ id: 'r' + (n++), start: st, end: st + 9 * E.HOUR_MS });
    }
    const oldLed = E.buildLedger(ancient, c, NOW);
    const got = E.otePeriodSamples(oldLed.parts, c, NOW);
    ok('a ten-year-old first shift keeps the recent periods',
       got.filter(x => x.ot > 0).length >= 4, got.length + ' samples, '
       + got.filter(x => x.ot > 0).length + ' with OT');
  }

  /* Real periods come off the ledger: two fortnights, each holding two weeks of five
     9-hour shifts — 5 h of OT a week, so 10 h a period under a 40-hour week. */
  const sh = []; let id = 0;
  for (const wk of [4, 11, 18, 25]){             // four consecutive weeks of Jan 2026
    for (let d = 0; d < 5; d++){
      const st = +new Date(2026, 0, wk + 1 + d, 8);
      sh.push({ id: 's' + (id++), start: st, end: st + 9 * E.HOUR_MS });
    }
  }
  const led = E.buildLedger(sh, c, +new Date(2026, 1, 10));
  const ps = E.otePeriodSamples(led.parts, c, +new Date(2026, 1, 10));
  ok('two completed periods become two samples', ps.length === 2, String(ps.length));
  ok('each carrying its ten hours of overtime', ps.every(x => Math.abs(x.ot - 10) < 0.01),
     ps.map(x => x.ot.toFixed(2)).join(', '));
}

/* ---------------- salary under contract: ten months worked, twelve months paid ---------------- */
{
  /* A teacher on $72,000. Contract 17 August 2026 to 4 June 2027, spread over 26 biweekly
     cheques on the same fortnightly calendar everything else in the app runs on. */
  const c = { ...E.DEFAULTS, salary: 72000, contractStart: '2026-08-17',
              contractEnd: '2027-06-04', contractCheques: 26,
              periodAnchor: '2026-08-09', periodLengthDays: 14, payDateOffsetDays: 13,
              weekStartDay: 0 };
  const on = d => +new Date(d + 'T12:00:00');
  const v = (d, st) => E.contractView(c, on(d), st || []);

  near('a cheque is the salary over twenty-six', v('2027-01-01').perCheque, 72000 / 26, 0.01);
  near('which is $2,769.23', v('2027-01-01').perCheque, 2769.23);

  /* Accrual is linear across the contract calendar. Halfway through the dates is halfway
     through the money. */
  const mid = v('2027-01-10');
  ok('halfway through the contract is about half earned',
     Math.abs(mid.earnedFrac - 0.5) < 0.02, (mid.earnedFrac * 100).toFixed(1) + '%');
  near('the last day earns all of it', v('2027-06-04').earnedFrac, 1);
  near('and nothing accrues after it', v('2027-09-01').earnedFrac, 1);
  near('nor before it starts', v('2026-07-01').earnedFrac, 0);
  near('the day it starts is nothing yet', v('2026-08-17').earnedFrac, 0, 0.01);

  /* The number the whole model exists for. On the last day of the school year the salary is
     fully earned but only twenty of twenty-six cheques have been handed over — so the
     district is holding six cheques' worth, and that is exactly what the summer is paid
     from. It is not a bonus and it is not the district's money. */
  const last = v('2027-06-04');
  near('twenty cheques paid by the last day of school', last.chequesPaid, 20);
  near('so $55,384.60 has been handed over',            last.paid, 55384.60, 0.05);
  near('and $16,615.40 is still being held',            last.deferred, 16615.40, 0.05);
  near('which is exactly six cheques of summer pay',    last.deferred / last.perCheque, 6, 0.01);
  near('six still to come',                             last.chequesLeft, 6);

  /* It drains over the summer rather than sitting there. */
  const jul = v('2027-07-01');
  ok('the balance falls once school is out', jul.deferred < last.deferred,
     '$' + last.deferred.toFixed(2) + ' → $' + jul.deferred.toFixed(2));
  near('and the total paid climbs to meet it', jul.paid, 22 * last.perCheque, 0.05);
  const aug = v('2027-08-15');
  near('one cheque left at the end', aug.chequesLeft, 1);
  near('and one cheque still held',  aug.deferred, last.perCheque, 0.05);

  /* Never negative. The first payday of a contract can land before much has accrued, and
     "you owe the district" is both wrong and frightening. */
  ['2026-08-17','2026-08-25','2026-09-05','2026-09-20'].forEach(function(d){
    ok('deferred is never negative on ' + d, v(d).deferred >= 0, v(d).deferred.toFixed(2));
  });

  /* Stipends are earnings. They lift the total, the per-cheque figure and everything
     downstream — a coach on $5,200 and a yearbook sponsor on $1,800 is $7,000 more a year,
     and the pension is assessed on all of it. */
  const stips = [{ id:'a', name:'Head track coach', amount: 5200 },
                 { id:'b', name:'Yearbook',         amount: 1800 }];
  const withS = v('2027-06-04', stips);
  near('two stipends total $7,000',        withS.stipendPay, 7000);
  near('the contract year is worth $79,000', withS.total, 79000);
  near('and each cheque grows with it',    withS.perCheque, 79000 / 26, 0.01);
  ok('so more is earned by the last day',  withS.earned > last.earned,
     '$' + (withS.earned - last.earned).toFixed(2));
  near('no stipends means no addition', v('2027-06-04', []).stipendPay, 0);
  near('and a nonsense stipend adds nothing',
       E.stipendTotal([{ id: 'x', name: 'broken', amount: 'abc' }]), 0);

  /* Cheques are counted off the real pay calendar, not assumed evenly spaced — so a
     district on a different anchor or a different lag is still counted correctly. */
  const shifted = { ...c, periodAnchor: '2026-08-16', payDateOffsetDays: 45 };
  ok('a different pay calendar gives a different count',
     E.chequesPaid(shifted, on('2027-06-04')) !== E.chequesPaid(c, on('2027-06-04')),
     E.chequesPaid(c, on('2027-06-04')) + ' vs ' + E.chequesPaid(shifted, on('2027-06-04')));
  ok('and it is never more than the contract has',
     E.chequesPaid(c, on('2029-01-01')) <= 26, String(E.chequesPaid(c, on('2029-01-01'))));

  /* Nothing configured must not produce nonsense — this runs on every render. */
  /* And the last cheque squares the rounding rather than leaving two cents outstanding. */
  const done = v('2027-09-30');
  near('by the final cheque the whole salary has been handed over', done.paid, 72000);
  near('with nothing left held', done.deferred, 0);
  near('and nothing outstanding', done.remaining, 0);

  const empty = E.contractView({ ...E.DEFAULTS }, on('2027-01-01'), []);
  near('no contract earns nothing', empty.earned, 0);
  near('holds nothing',             empty.deferred, 0);
  near('and owes nothing',          empty.remaining, 0);
  ok('with no cheques counted',     empty.chequesPaid === 0, String(empty.chequesPaid));
  const noDates = E.contractView({ ...E.DEFAULTS, salary: 60000 }, on('2027-01-01'), []);
  near('a salary with no dates still prices a cheque', noDates.perCheque, 60000 / 26, 0.01);
  near('but earns nothing without a calendar', noDates.earned, 0);

  /* Everything reconciles: what is held plus what is paid is what has been earned. */
  ['2026-10-15','2026-12-24','2027-02-15','2027-04-15','2027-06-04'].forEach(function(d){
    const x = v(d, stips);
    near('on ' + d + ' held plus paid is earned', x.deferred + x.paid, x.earned, 0.02);
    ok('on ' + d + ' nothing is earned twice', x.earned <= x.total + 1e-9,
       x.earned.toFixed(2) + ' of ' + x.total.toFixed(2));
  });
}

/* ---------------- what a deduction comes out BEFORE ---------------- */
{
  /* Settled against a real Pace stub rather than assumed. A Section 125 health premium comes
     out before every tax including Social Security; a 401(k) deferral comes out before
     income tax only, and FICA is still charged on it. The app used to have one boolean for
     both, which under-withheld Social Security by $17.88 on a single fortnight. */
  const P = 26, G = 3376.57;
  const base = { filing: 'single', dependents: 0, fedExempt: true, statePct: 4.95,
                 ficaOn: true, otBreak: false };
  const HEALTH = 130.00, K = 135.06 + 151.95;      // the stub's two 401k lines

  const right = E.netBreakdown(G, HEALTH, 0, { ...base, fixedIncome: K }, P);
  near('Social Security is charged on the 401k', right.ss, (G - HEALTH) * E.TAX2026.ssRate, 0.01);
  near('and so is Medicare',                     right.medicare, (G - HEALTH) * E.TAX2026.medicareRate, 0.01);
  near('but state tax is not',                   right.state, (G - HEALTH - K) * 0.0495, 0.01);
  near('the stub says $201.37 of Social Security', right.ss, 201.37, 0.10);
  near('$47.09 of Medicare',                      right.medicare, 47.09, 0.10);
  near('and $146.50 to Illinois',                 right.state, 146.50, 0.10);

  /* The mistake the three-way choice exists to prevent. */
  const wrong = E.netBreakdown(G, HEALTH + K, 0, base, P);
  ok('treating a 401k as fully pre-tax under-withholds Social Security',
     right.ss - wrong.ss > 17, '$' + (right.ss - wrong.ss).toFixed(2) + ' a fortnight');
  near('by $17.79 on this cheque', right.ss - wrong.ss, 17.79, 0.02);

  /* The two wage figures are reported separately, because they are different numbers. */
  near('FICA wages exclude only the health premium', right.ficaWages, G - HEALTH, 0.01);
  near('taxable wages exclude the 401k as well',     right.taxable, G - HEALTH - K, 0.01);
  ok('and everything still reconciles',
     Math.abs(right.gross - right.deductions - right.net) < 0.01,
     right.gross.toFixed(2) + ' − ' + right.deductions.toFixed(2) + ' = ' + right.net.toFixed(2));

  /* Percentages, which is how payroll actually assesses these. */
  const pcts = [{ name: '401k Vol', rate: 4.0, basis: 'income' },
                { name: '401k Mand', rate: 4.5, basis: 'income' }];
  const byPct = E.netBreakdown(G, HEALTH, 0, { ...base, pcts: pcts }, P);
  near('4% and 4.5% reproduce the stub exactly', byPct.pctTotal, K, 0.02);
  near('with the same Social Security', byPct.ss, right.ss, 0.01);
  near('the same state tax',            byPct.state, right.state, 0.01);
  near('and the same net',              byPct.net, right.net, 0.02);

  /* The whole point of a percentage: it follows the gross without being retyped. */
  const big = E.netBreakdown(5500, HEALTH, 0, { ...base, pcts: pcts }, P);
  near('on a bigger cheque it scales itself', big.pctTotal, 5500 * 0.085, 0.01);
  ok('where a typed figure would have stayed still',
     E.netBreakdown(5500, HEALTH, 0, { ...base, fixedIncome: K }, P).taxable
     > big.taxable, 'the fixed one leaves more taxable');

  /* Each basis does what it says. */
  const one = b => E.netBreakdown(1000, 0, 0,
    { ...base, pcts: [{ name: 'x', rate: 10, basis: b }] }, P);
  near('before every tax cuts FICA',        one('all').ficaWages, 900, 0.01);
  near('before income tax only does not',   one('income').ficaWages, 1000, 0.01);
  near('though it still cuts taxable',      one('income').taxable, 900, 0.01);
  near('after tax cuts neither',            one('none').taxable, 1000, 0.01);
  near('but comes off the net all the same', one('none').net,
       one('none').gross - one('none').deductions, 0.01);
  [['all',900],['income',900],['none',1000]].forEach(function(c){
    near(c[0] + ' leaves the same $100 out of pocket',
         1000 - one(c[0]).net - one(c[0]).taxes, 100, 0.01);
  });

  /* An older save has only the boolean, where true meant "before everything". */
  ok('a legacy pre-tax item still means before everything',
     E.itemBasis({ pretax: true }) === 'all');
  ok('and a legacy after-tax one still means after',
     E.itemBasis({ pretax: false }) === 'none');
  ok('an explicit basis wins over the old flag',
     E.itemBasis({ pretax: true, basis: 'income' }) === 'income');
  ok('and nothing at all is after-tax', E.itemBasis(null) === 'none');

  /* Rubbish rates contribute nothing rather than a NaN on screen. */
  [null, undefined, NaN, -5, 'x'].forEach(function(r){
    near('a rate of ' + JSON.stringify(r) + ' takes nothing',
         E.pctSplit(1000, [{ rate: r, basis: 'income' }]).total, 0);
  });
  near('an unknown basis is treated as after-tax',
       E.pctSplit(1000, [{ rate: 10, basis: 'nonsense' }]).none, 100, 0.01);
  near('and no list at all is nothing', E.pctSplit(1000, null).total, 0);
}

/* ---------------- a public pension in place of Social Security ---------------- */
{
  /* Fifteen states keep most of their teachers outside Social Security, and the same
     arrangement covers a lot of police, fire and municipal work. Illinois TRS: 9% of
     creditable earnings, picked up pre-tax under IRC 414(h)(2), no OASDI, Medicare still
     withheld. Checked against $72,000 over 24 cheques. */
  const P = 24, per = 72000 / P;
  const base = { filing: 'single', dependents: 0, ficaOn: true, statePct: 4.95 };
  const trs  = { ...base, ssOn: false, pension: { rate: 9, preTax: true, name: 'TRS' } };
  const a = E.netBreakdown(per, 0, 0, base, P);
  const b = E.netBreakdown(per, 0, 0, trs,  P);

  near('nine per cent of the cheque goes to the pension', b.pension, per * 0.09);
  near('which is $6,480 across the year',                 b.pension * P, 6480);
  near('no Social Security is withheld',                  b.ss, 0);
  ok('where a covered job would have paid it', a.ss > 0, '$' + a.ss.toFixed(2) + ' a cheque');
  near('and $4,464 of it across the year',                a.ss * P, 4464);

  /* The part that is easy to get wrong. Medicare covers essentially every public employee
     hired since April 1986 whether Social Security does or not, so it is still withheld —
     on the reduced wage, because the pension came out first. */
  near('Medicare is still withheld', b.medicare, (per - b.pension) * E.TAX2026.medicareRate);
  ok('on the wage after the pension, not before', b.medicare < a.medicare,
     '$' + b.medicare.toFixed(2) + ' vs $' + a.medicare.toFixed(2));
  near('which is $950 across the year', b.medicare * P, 950.04, 0.2);

  /* Pre-tax means pre-tax: federal and state are both figured on the reduced wage. */
  near('taxable wages drop by the contribution', b.taxable, per - b.pension);
  ok('so federal withholding falls', b.fed < a.fed, '$' + (a.fed - b.fed).toFixed(2) + ' a cheque');
  ok('and state with it',            b.state < a.state, '$' + (a.state - b.state).toFixed(2));
  near('state is 4.95% of the reduced wage', b.state, (per - b.pension) * 0.0495);

  /* The number someone actually wants: 9% out is more than 6.2% out, but the tax not paid
     gives most of the difference back. */
  const cost = (a.net - b.net) * P;
  ok('take-home is only a little lower despite contributing $2,016 more',
     cost > 250 && cost < 300, '$' + cost.toFixed(2) + ' a year');
  near('the extra actually contributed is $2,016', (b.pension - a.ss) * P, 2016);

  /* After-tax is a different cheque, and some funds are. */
  const post = E.netBreakdown(per, 0, 0,
                 { ...trs, pension: { rate: 9, preTax: false, name: 'TRS' } }, P);
  near('after-tax leaves taxable wages alone', post.taxable, per);
  ok('so it takes more home off you', post.net < b.net,
     '$' + (b.net - post.net).toFixed(2) + ' a cheque');
  near('but the contribution itself is the same', post.pension, b.pension);
  ok('and it is reported as a post-tax deduction', post.pensionPre === false);
  ok('where the pre-tax one is not', b.pensionPre === true);

  /* Every dollar still adds up, whichever side of tax it comes out of. */
  [a, b, post].forEach(function(x, i){
    near('breakdown ' + (i + 1) + ': gross minus everything is net',
         x.gross - x.deductions, x.net);
  });

  /* The two switches are not the same switch. Turning off FICA entirely is a student or a
     visa case and takes Medicare with it; a pension takes only Social Security. */
  const noFica = E.netBreakdown(per, 0, 0, { ...base, ficaOn: false }, P);
  near('no FICA at all means no Medicare either', noFica.medicare, 0);
  ok('a pension still pays Medicare', b.medicare > 0, '$' + b.medicare.toFixed(2));

  /* The surtax above $200,000 is Medicare's, so it survives the swap too — a superintendent
     on $260,000 owes it with no Social Security anywhere on the stub. */
  const big = E.netBreakdown(260000 / P, 0, 0,
                { ...trs, wagesBefore: 250000 }, P);
  ok('the Additional Medicare surtax still applies', big.addMedicare > 0,
     '$' + big.addMedicare.toFixed(2));
  near('and Social Security is still nothing', big.ss, 0);

  /* No pension configured changes nothing at all — the field is optional and absent by
     default, and every existing figure has to be untouched by its arrival. */
  const plain = E.netBreakdown(per, 0, 0, base, P);
  near('an absent pension contributes nothing', plain.pension, 0);
  near('and leaves net exactly where it was', plain.net, a.net);
}

/* ---------------- Social Security is an annual cap, not a per-cheque one ---------------- */
{
  const T = E.TAX2026;
  const nc = { filing: 'single', dependents: 0, ficaOn: true, statePct: 4.95, items: [] };
  const P = 26, per = 600000 / P;                    // $23,076.92 a cheque

  /* Left out, it behaves as it always did: the base divided by the number of periods. That
     is exactly right for anyone who never reaches the base, which is nearly everyone. */
  const flat = E.netBreakdown(per, 0, 0, nc, P);
  near('with no year-to-date it uses the per-period ceiling',
       flat.ss, (T.ssWageBase / P) * T.ssRate);

  /* Given the year to date, it does what payroll does: full rate until the base, nothing
     after. The annual total is the same either way — only the distribution differs, and the
     distribution is what a cheque shows. */
  let ytd = 0, paid = [], crossed = 0;
  for (let i = 0; i < P; i++){
    const bd = E.netBreakdown(per, 0, 0, { ...nc, wagesBefore: ytd }, P);
    paid.push(bd.ss); ytd += per;
    if (bd.ss > 0.005) crossed = i + 1;
  }
  near('the first cheque pays the full rate', paid[0], per * T.ssRate);
  near('the last one pays nothing',           paid[P - 1], 0);
  /* $184,500 / $23,076.92 is just under eight cheques, so the eighth is the one that
     straddles the base and the ninth is the first clear of it. */
  near('it stops during the eighth',          crossed, 8);
  near('and the year still totals the same',
       paid.reduce((a, b) => a + b, 0), T.ssWageBase * T.ssRate);
  near('which is the same total the old way gave', flat.ss * P, T.ssWageBase * T.ssRate);

  /* The cheque you actually get is more than three times what a per-period cap claimed. */
  ok('an early cheque withholds far more than the flat figure said',
     paid[0] > flat.ss * 3, '$' + paid[0].toFixed(2) + ' vs $' + flat.ss.toFixed(2));

  // A wage that never reaches the base is untouched by any of this.
  const small = 87530 / P;
  near('someone under the base pays the same either way',
       E.netBreakdown(small, 0, 0, { ...nc, wagesBefore: 87530 - small }, P).ss,
       E.netBreakdown(small, 0, 0, nc, P).ss);

  // Exactly at the base, and one dollar past it.
  near('the cheque that lands exactly on the base is still fully taxed',
       E.netBreakdown(1000, 0, 0, { ...nc, wagesBefore: T.ssWageBase - 1000 }, P).ss, 1000 * T.ssRate);
  near('the next dollar is not', E.netBreakdown(1000, 0, 0, { ...nc, wagesBefore: T.ssWageBase }, P).ss, 0);
  near('and a cheque straddling it is split',
       E.netBreakdown(1000, 0, 0, { ...nc, wagesBefore: T.ssWageBase - 400 }, P).ss, 400 * T.ssRate);

  near('switching FICA off zeroes it whatever the year to date',
       E.netBreakdown(per, 0, 0, { ...nc, ficaOn: false, wagesBefore: 0 }, P).ss, 0);
}

/* ---------------- Additional Medicare, 0.9% over $200,000 ---------------- */
{
  const T = E.TAX2026;
  const nc = { filing: 'single', dependents: 0, ficaOn: true, statePct: 4.95, items: [] };
  const P = 26;

  near('the rate is 0.9%',    T.addMedicareRate, 0.009);
  near('it starts at 200,000', T.addMedicareFrom, 200000);

  near('below the line nothing is owed',
       E.netBreakdown(3000, 0, 0, { ...nc, wagesBefore: 100000 }, P).addMedicare, 0);
  near('above it the whole cheque is surcharged',
       E.netBreakdown(3000, 0, 0, { ...nc, wagesBefore: 250000 }, P).addMedicare, 3000 * 0.009);
  /* The cheque that crosses the line is surcharged only on the part above it. */
  near('the crossing cheque is split at the line',
       E.netBreakdown(3000, 0, 0, { ...nc, wagesBefore: 199000 }, P).addMedicare, 2000 * 0.009);

  // A whole year at $600k: the surtax is owed on everything past the first $200,000.
  let ytd = 0, add = 0;
  for (let i = 0; i < P; i++){
    add += E.netBreakdown(600000 / P, 0, 0, { ...nc, wagesBefore: ytd }, P).addMedicare;
    ytd += 600000 / P;
  }
  near('a $600,000 year owes 0.9% on $400,000', add, 400000 * 0.009);
  ok('which is $3,600 nobody was withholding before', Math.abs(add - 3600) < 0.01, '$' + add.toFixed(2));

  /* Withheld from $200,000 whatever the filing status: the higher married threshold is
     settled on the return, not in payroll. */
  near('married is withheld on the same $200,000 basis',
       E.netBreakdown(3000, 0, 0, { ...nc, filing: 'married', wagesBefore: 250000 }, P).addMedicare,
       3000 * 0.009);

  near('with no year-to-date given, nothing is assumed',
       E.netBreakdown(3000, 0, 0, nc, P).addMedicare, 0);
  near('and FICA off zeroes it too',
       E.netBreakdown(3000, 0, 0, { ...nc, ficaOn: false, wagesBefore: 250000 }, P).addMedicare, 0);

  // It reaches the totals rather than being computed and dropped.
  const bd = E.netBreakdown(3000, 0, 0, { ...nc, wagesBefore: 250000 }, P);
  near('it is inside the tax total', bd.taxes, bd.fed + bd.state + bd.ss + bd.medicare + bd.addMedicare);
  near('and taken out of take-home', bd.net, 3000 - bd.taxes);

  /* periodNetView is the door every screen comes through, so the year to date has to survive
     the trip. */
  const cfg = { ...E.DEFAULTS, rate: 200, otMultiplier: 1.5, periodLengthDays: 14 };
  const withY = E.periodNetView(3000, 80, [], nc, cfg, 'hole', 0, 0, 250000);
  const noY   = E.periodNetView(3000, 80, [], nc, cfg, 'hole', 0, 0);
  ok('periodNetView passes the year to date down', withY.addMedicare > 0 && noY.addMedicare === 0,
     `$${withY.addMedicare.toFixed(2)} vs $${noY.addMedicare.toFixed(2)}`);
  /* Take-home goes UP, not down, and that is the whole point of doing this properly: by
     $250,000 Social Security has stopped, and losing 6.2% dwarfs picking up 0.9%. Someone
     high-earning sees their cheque grow mid-year, which the old per-period cap hid
     completely. */
  ok('Social Security has stopped by then', withY.ss === 0 && noY.ss > 0,
     `$${withY.ss.toFixed(2)} vs $${noY.ss.toFixed(2)}`);
  ok('so take-home rises despite the surtax', withY.net > noY.net,
     `$${withY.net.toFixed(2)} vs $${noY.net.toFixed(2)}`);
  near('by the 6.2% that stopped, less the 0.9% that started',
       withY.net - noY.net, noY.ss - withY.addMedicare);
}

/* ---------------- qualified overtime is FLSA's, not the contract's ---------------- */
{
  /* The 2025-2028 deduction is defined by the FLSA: only hours past 40 in a workweek
     qualify, and only the half-time premium the FLSA itself requires is deductible. Neither
     figure comes from the employer's own rule, which is the whole point. */
  const base = { ...E.DEFAULTS, rate: 40, lunchMins: 0, weekStartDay: 0,
                 holidays: [], banks: [], daysOff: [], vacations: [],
                 periodAnchor: '2026-08-09', periodLengthDays: 14 };
  const day = (d, len) => ({ id: 'd' + d, start: +new Date(2026, 7, d, 7),
                             end: +new Date(2026, 7, d, 7) + len * E.HOUR_MS });
  const sum = (ss, cfg) => E.sumRange(E.buildLedger(ss, cfg, +new Date(2026, 8, 1)).parts,
                                      +new Date(2026, 7, 9), +new Date(2026, 7, 23));

  // Five nines: 45 hours in a week, so five of them are past forty.
  const nines = [9, 10, 11, 12, 13].map(d => day(d, 9));
  near('45 hours in a week qualifies 5',
       sum(nines, { ...base, otMode: 'weekly', weeklyThreshold: 40 }).qualOt, 5);

  /* Same shifts on a daily rule pay overtime every day — nine hours of contractual overtime
     — but the FLSA figure does not move, because the week is still 45. */
  const daily = sum(nines, { ...base, otMode: 'daily', dailyThreshold: 8 });
  near('a daily rule pays overtime on all five days', daily.otHours, 5);
  near('but qualified overtime is still 5',           daily.qualOt, 5);

  /* Four eights and one four: 36 hours. A daily rule at 6 h pays contractual overtime; the
     FLSA qualifies none of it, because the week never reached forty. */
  const short = [9, 10, 11, 12].map(d => day(d, 8)).concat([day(13, 4)]);
  const s6 = sum(short, { ...base, otMode: 'daily', dailyThreshold: 6 });
  ok('a low daily threshold pays contractual overtime', s6.otHours > 0, s6.otHours + ' h');
  near('and none of it qualifies',                     s6.qualOt, 0);

  /* Under 8 and 80, three twelves a week is 24 hours of contractual overtime and 0 qualified
     — 36 hours a week never reaches forty. This is exactly the case the old formula got
     wrong, and it is the commonest schedule in a hospital. */
  const twelves = [9, 10, 11, 16, 17, 18].map(d => day(d, 12));
  const e80 = sum(twelves, { ...base, otMode: 'eighty80', dailyThreshold: 8, periodThreshold: 80 });
  near('8 and 80 pays 24 hours of overtime', e80.otHours, 24);
  near('and qualifies none of it',           e80.qualOt, 0);

  /* The multiplier changes what is PAID, never what is deductible. */
  const cfg15 = { ...base, otMode: 'weekly', weeklyThreshold: 40, otMultiplier: 1.5 };
  const cfg2  = { ...cfg15, otMultiplier: 2 };
  near('double time pays more', sum(nines, cfg2).gross - sum(nines, cfg15).gross, 5 * 40 * 0.5);
  near('but qualifies the same hours', sum(nines, cfg2).qualOt, sum(nines, cfg15).qualOt);

  const nc = { filing: 'single', dependents: 0, ficaOn: true, statePct: 4.95, items: [], otBreak: true };
  const at15 = E.periodNetView(4000, 80, [], nc, cfg15, 'hole', 5, 0);
  const at2  = E.periodNetView(4000, 80, [], nc, cfg2,  'hole', 5, 0);
  near('and the deduction is half-time either way', at15.otDeducted, 5 * 40 * 0.5);
  near('double time deducts no more than time and a half', at2.otDeducted, at15.otDeducted);

  // Paid leave is not time worked, so a holiday week does not qualify on the holiday's hours.
  const withHol = { ...base, otMode: 'weekly', weeklyThreshold: 40,
                    holidays: [{ id: 'x', name: 'Test', on: true, kind: 'on', date: '2026-08-12',
                                 ot: true }] };
  const w = sum([9, 10, 11, 12, 13].map(d => day(d, 8)), withHol);
  ok('a holiday week can be paid past forty', w.hours >= 40, w.hours + ' h');
  near('without qualifying any hours for the deduction', w.qualOt, 0);

  // The annual cap still applies on top.
  const capped = E.periodNetView(60000, 80, [], nc, cfg15, 'hole', 800, 0);
  near('the deduction is still capped', capped.otDeducted, E.TAX2026.otCap.single);

  near('turning the break off deducts nothing',
       E.periodNetView(4000, 80, [], { ...nc, otBreak: false }, cfg15, 'hole', 5, 0).otDeducted, 0);
}

/* ---------------- premiums that stack ---------------- */
{
  const base = { ...E.DEFAULTS, rate: 40, otMultiplier: 1.5, otMode: 'weekly',
                 weeklyThreshold: 999999, lunchMins: 0, weekStartDay: 0,
                 holidays: [], banks: [], daysOff: [], vacations: [],
                 periodAnchor: '2026-08-09', periodLengthDays: 14 };
  // Sun Aug 9 2026 is a Sunday; Mon Aug 10 a Monday.
  const shift = (d, from, len) => ({ id: 'x' + d + from,
    start: +new Date(2026, 7, d, from), end: +new Date(2026, 7, d, from) + len * E.HOUR_MS });
  const sum = (ss, cfg) => E.sumRange(E.buildLedger(ss, cfg, +new Date(2026, 8, 1)).parts,
                                      +new Date(2026, 7, 9), +new Date(2026, 7, 23));

  /* The original single differential still works untouched, and is simply the first premium
     in the list — nothing existing had to be migrated. */
  const oneOnly = { ...base, nightOn: true, nightFrom: '18:00', nightTo: '06:00', nightRate: 0.15 };
  near('the old single differential is one premium', E.premiumList(oneOnly).length, 1);
  const t1 = sum([shift(10, 14, 8)], oneOnly);      // 2 PM–10 PM, four hours after six
  near('eight hours', t1.hours, 8);
  near('four of them earn the differential', t1.gross, 8 * 40 + 4 * 0.15);

  /* Three at once: nights, weekends and charge. A Sunday night charge hour carries all
     three, and they add rather than replace. */
  const cfg = { ...oneOnly, nightRate: 5,
    premiums: [
      { id: 'wknd',   name: 'Weekend', rate: 3, days: [true,false,false,false,false,false,true] },
      { id: 'charge', name: 'Charge',  rate: 2 }                       // no window: all shift
    ] };
  near('three premiums', E.premiumList(cfg).length, 3);

  const sunNight = +new Date(2026, 7, 9, 20);        // Sunday, 8 PM
  const monDay   = +new Date(2026, 7, 10, 10);       // Monday, 10 AM
  const monNight = +new Date(2026, 7, 10, 20);       // Monday, 8 PM
  const list = E.premiumList(cfg);
  near('a Sunday night hour stacks all three', E.premiumsAt(sunNight, list).rate, 10);
  ok('and names them',
     E.premiumsAt(sunNight, list).names.join(',') === 'Night,Weekend,Charge',
     E.premiumsAt(sunNight, list).names.join(','));
  near('a Monday daytime hour earns only charge', E.premiumsAt(monDay, list).rate, 2);
  near('a Monday night hour earns night and charge', E.premiumsAt(monNight, list).rate, 7);

  /* Paid across a real shift: Sunday 6 PM to midnight is six hours, all night, all weekend,
     all charge. */
  const sun = sum([shift(9, 18, 6)], cfg);
  near('six hours', sun.hours, 6);
  near('at base plus ten dollars', sun.gross, 6 * 50);

  // A shift straddling the night edge is split at it, not averaged across it.
  const straddle = sum([shift(10, 15, 6)], cfg);     // Mon 3 PM–9 PM: 3 h day, 3 h night
  near('three hours at base plus charge, three at base plus night and charge',
       straddle.gross, 3 * 42 + 3 * 47);

  /* Premiums ride on the base rate, so overtime is worked out on rate plus premium. */
  const ot = { ...cfg, weeklyThreshold: 4 };
  const otT = E.sumRange(E.buildLedger([shift(9, 18, 6)], ot, +new Date(2026, 8, 1)).parts,
                         +new Date(2026, 7, 9), +new Date(2026, 7, 23));
  near('two hours of it are overtime', otT.otHours, 2);
  near('paid at time and a half on base plus premium', otT.gross, 4 * 50 + 2 * 50 * 1.5);

  // A premium switched off, or set to nothing, is not a premium.
  near('an off premium is ignored',
       E.premiumList({ ...cfg, premiums: [{ id:'x', name:'X', rate: 9, on: false }] }).length, 1);
  near('and a zero one too',
       E.premiumList({ ...cfg, premiums: [{ id:'x', name:'X', rate: 0 }] }).length, 1);

  /* Paid leave never earns a premium: a vacation day is not a night shift, whatever hour
     the credit happens to be stamped at. */
  const vacCfg = { ...cfg, workDays: [true,true,true,true,true,true,true],
    vacations: [{ id:'v', name:'Vacation', from:'2026-08-11', to:'2026-08-11', hours:8, ot:false }] };
  const withVac = sum([shift(10, 18, 6)], vacCfg);
  const noVac   = sum([shift(10, 18, 6)], { ...vacCfg, vacations: [] });
  near('the vacation day pays flat, with no premium on it', withVac.gross - noVac.gross, 8 * 40);
  const vacParts = E.buildLedger([shift(10, 18, 6)], vacCfg, +new Date(2026, 8, 1)).parts
                    .filter(p => String(p.sessionId).indexOf('__vac') === 0);
  ok('and its hours are not counted as premium hours',
     vacParts.length > 0 && vacParts.every(p => (p.nightHours || 0) === 0),
     vacParts.length + ' parts');
}

/* ---------------- callback minimums ---------------- */
{
  const cfg = { ...E.DEFAULTS, rate: 40, otMultiplier: 1.5, otMode: 'weekly',
                weeklyThreshold: 999999, lunchMins: 0, weekStartDay: 0, callbackMin: 3,
                holidays: [], banks: [], daysOff: [], vacations: [],
                periodAnchor: '2026-08-09', periodLengthDays: 14 };
  const at = (d, h, mi = 0) => +new Date(2026, 7, d, h, mi);
  const sum = (ss, c) => E.sumRange(E.buildLedger(ss, c || cfg, +new Date(2026, 8, 1)).parts,
                                    +new Date(2026, 7, 9), +new Date(2026, 7, 23));

  // Twenty minutes at 3 AM, called in.
  const short = { id: 'c1', callback: true, start: at(10, 3), end: at(10, 3, 20) };
  near('twenty minutes pays the three-hour minimum', sum([short]).hours, 3);
  near('at the ordinary rate',                       sum([short]).gross, 3 * 40);

  /* Without the flag it is just a short shift — the guarantee is a contract term, not
     something to assume from the length. */
  near('an ordinary twenty-minute shift pays twenty minutes',
       sum([{ id: 'c2', start: at(10, 3), end: at(10, 3, 20) }]).hours, 1 / 3);

  // Longer than the minimum, so the minimum does nothing.
  near('four hours called in pays four',
       sum([{ id: 'c3', callback: true, start: at(10, 3), end: at(10, 7) }]).hours, 4);

  // With no minimum configured, the flag changes nothing.
  near('no minimum set, nothing guaranteed',
       sum([short], { ...cfg, callbackMin: 0 }).hours, 1 / 3);
  near('and callbackMin reports zero', E.callbackMin({ ...cfg, callbackMin: 0 }), 0);

  /* The guaranteed hours are hours worked, so they push you toward overtime like any
     others. Thirty-eight hours plus a twenty-minute callback is forty-one, not thirty-eight
     and a third — which is three hours of overtime, not none. */
  const week = [9, 10, 11, 12].map(d => ({ id: 'w' + d, start: at(d, 9), end: at(d, 18, 30) }));
  const withCb = sum(week.concat([short]), { ...cfg, weeklyThreshold: 40 });
  near('the week is 41 hours', withCb.hours, 41);
  near('so one of them is overtime', withCb.otHours, 1);

  // The record keeps both figures: what was worked, and what the guarantee paid.
  const applied = E.applyCallback(short, cfg);
  near('it remembers what was actually worked', applied.callbackWorked, 1 / 3);
  near('and what it was brought up to',         applied.callbackPaid, 3);
  ok('the original is left alone', short.end === at(10, 3, 20));

  // Premiums still apply to the guaranteed hours — a 3 AM callback is a night callback.
  const night = { ...cfg, nightOn: true, nightFrom: '18:00', nightTo: '06:00', nightRate: 5 };
  near('the whole guaranteed block earns the night rate', sum([short], night).gross, 3 * 45);
}

/* ---------------- work counted rather than clocked ---------------- */
{
  /* An orthopedic contract at the market median: $703,000 total on 8,812 wRVU at $79.78 —
     which implies a base covering roughly 8,812 - (703,000 - base)/79.78. Rounded to a
     shape a real contract has: $400,000 base covering 5,000 wRVU, $79.78 each after. */
  const cfg = { ...E.DEFAULTS, unitBase: 400000, unitThreshold: 5000, unitRate: 79.78,
                unitName: 'wRVU' };

  const u = E.unitCfg(cfg);
  near('the base is read',      u.base, 400000);
  near('and the threshold',     u.threshold, 5000);
  near('and the rate',          u.rate, 79.78);

  /* Below the threshold the salary is the whole of it. Productivity pay is for going past
     what the base already covers, not a replacement for it. */
  near('nothing past the threshold pays the base', E.unitPay(3000, cfg).total, 400000);
  near('with no productivity at all',              E.unitPay(3000, cfg).productivity, 0);
  near('exactly at the threshold, still the base', E.unitPay(5000, cfg).total, 400000);
  near('one past it earns the rate',               E.unitPay(5001, cfg).total, 400000 + 79.78);
  near('8,812 pays base plus 3,812 at the rate',
       E.unitPay(8812, cfg).total, 400000 + 3812 * 79.78);
  near('which is a market-median orthopedic year', E.unitPay(8812, cfg).total, 704121.36, 1);

  // Entries are summed by date, and only inside the window asked for.
  const list = [
    { id:'a', date:'2026-01-15', count: 20.7 },      // a total knee
    { id:'b', date:'2026-02-02', count: 9.5 },       // a lap appendectomy
    { id:'c', date:'2025-12-30', count: 100 }        // last year, not this
  ];
  near('this year sums to 30.2',
       E.unitsInRange(list, +new Date(2026, 0, 1), +new Date(2027, 0, 1)), 30.2);
  near('last year is not counted',
       E.unitsInRange(list, +new Date(2026, 0, 1), +new Date(2027, 0, 1)) < 100, true ? 1 : 0);

  /* Pace: where the year lands if the rest runs like the part already done. Ninety days in
     with 2,000 logged is a shade over 8,100 by December. */
  const mar31 = +new Date(2026, 2, 31, 12);
  const many = [{ id:'x', date:'2026-01-05', count: 2000 }];
  const p = E.unitPace(many, cfg, mar31, 1);
  near('two thousand so far', p.soFar, 2000);
  near('ninety days elapsed',  p.elapsed, 90, 1);
  ok('projecting past eight thousand', p.projected > 8000 && p.projected < 8300,
     p.projected.toFixed(0));
  near('and the year priced on that', p.year.total,
       400000 + (p.projected - 5000) * 79.78, 1);

  /* The what-if is a multiplier on that pace, which is what a "pick up ten per cent"
     control adjusts. */
  const faster = E.unitPace(many, cfg, mar31, 1.1);
  near('ten per cent more is ten per cent more units', faster.projected, p.projected * 1.1, 1);
  ok('and worth real money', faster.year.total - p.year.total > 60000,
     '$' + (faster.year.total - p.year.total).toFixed(0));

  /* Money already earned is measured on what has actually been done, not on the pace —
     two thousand units is under the threshold, so it is the base and nothing more. */
  near('earned so far is the base alone', p.now.total, 400000);

  // A contract with nothing set prices nothing rather than dividing by zero.
  const empty = { ...E.DEFAULTS };
  near('an unset contract pays nothing', E.unitPay(500, empty).total, 0);
  near('and has no threshold', E.unitCfg(empty).threshold, 0);
}


group('Pay period boundaries (anchor 2026-07-26, 14 days)');
{
  const p = E.periodInfo(at(2026, 7, 30, 12), cfg);
  ok('current period starts Sun Jul 26', p.start.getMonth() === 6 && p.start.getDate() === 26);
  ok('...and is a Sunday', p.start.getDay() === 0);
  ok('last day is Sat Aug 8', p.lastDay.getMonth() === 7 && p.lastDay.getDate() === 8);
  ok('...and is a Saturday', p.lastDay.getDay() === 6);
  ok('payday is Fri Aug 21', p.payDate.getMonth() === 7 && p.payDate.getDate() === 21 && p.payDate.getDay() === 5);

  // The instant that ends the period belongs to the NEXT one — midnight closing Aug 8.
  ok('23:59 Aug 8 is still this period', E.periodInfo(at(2026, 8, 8, 23, 59), cfg).index === p.index);
  ok('00:00 Aug 9 rolls to the next period', E.periodInfo(at(2026, 8, 9, 0, 0), cfg).index === p.index + 1);

  const nxt = E.periodInfo(at(2026, 8, 9), cfg);
  ok('next period is Aug 9 – Aug 22', nxt.start.getDate() === 9 && nxt.lastDay.getDate() === 22);
  ok('next payday is Fri Sep 4', nxt.payDate.getMonth() === 8 && nxt.payDate.getDate() === 4 && nxt.payDate.getDay() === 5);

  // Self-perpetuating: a period a year out still lands on a Sunday.
  ok('period a year later still starts Sunday', E.periodInfo(at(2027, 7, 30), cfg).start.getDay() === 0);
  ok('a date before the anchor resolves to a negative index', E.periodInfo(at(2026, 7, 20), cfg).index === -1);
}

/* ------------------------------------------------------------------ */
group('Work weeks nest cleanly inside the period');
{
  const w1 = E.weekInfo(at(2026, 7, 28), cfg), w2 = E.weekInfo(at(2026, 8, 5), cfg);
  ok('week 1 starts Sun Jul 26', w1.start.getDate() === 26);
  ok('week 2 starts Sun Aug 2', w2.start.getDate() === 2);
  ok('the two weeks are adjacent', w2.index === w1.index + 1);
  ok('Sat Aug 1 23:59 is still week 1', E.weekInfo(at(2026, 8, 1, 23, 59), cfg).index === w1.index);
  ok('Sun Aug 2 00:00 opens week 2', E.weekInfo(at(2026, 8, 2, 0, 0), cfg).index === w2.index);
}

/* ------------------------------------------------------------------ */
group('Straight time');
{
  near('1 h  = $38.00', gross([shift('a', at(2026, 7, 27, 9), at(2026, 7, 27, 10))]), 38);
  near('8 h  = $304.00', gross([shift('a', at(2026, 7, 27, 9), at(2026, 7, 27, 17))]), 304);
  near('30 min = $19.00', gross([shift('a', at(2026, 7, 27, 9), at(2026, 7, 27, 9, 30))]), 19);
  near('1 min  = $0.6333…', gross([shift('a', at(2026, 7, 27, 9), at(2026, 7, 27, 9, 1))]), 38 / 60, 1e-9);
  near('per-second rate', 38 / 3600, 0.010555555555555556, 1e-15);
}

/* ------------------------------------------------------------------ */
group('Weekly OT — 40 h, resets Sunday');
{
  // Mon–Fri 9-to-5 = 40 h exactly. Nothing should tip into OT.
  const week1 = [1, 2, 3, 4, 5].map(i => shift('d' + i, at(2026, 7, 26 + i, 9), at(2026, 7, 26 + i, 17)));
  const l1 = E.buildLedger(week1, cfg);
  near('40 h flat  → 40 reg / 0 OT', l1.parts.reduce((s, p) => s + p.otHours, 0), 0);
  near('40 h flat  → $1,520.00', gross(week1), 1520);

  // Sixth day: every hour is OT.
  const plusSat = week1.concat([shift('sat', at(2026, 8, 1, 9), at(2026, 8, 1, 13))]);
  const l2 = E.buildLedger(plusSat, cfg);
  near('+4 h on Sat → 4 h OT', l2.parts.reduce((s, p) => s + p.otHours, 0), 4);
  near('+4 h on Sat → $1,520 + $228 = $1,748', gross(plusSat), 1520 + 4 * 57);

  // THE case that matters: a single shift straddling the 40 h line must split, not round.
  const straddle = [1, 2, 3, 4].map(i => shift('d' + i, at(2026, 7, 26 + i, 9), at(2026, 7, 26 + i, 17)))
    .concat([shift('fri', at(2026, 7, 31, 9), at(2026, 7, 31, 21))]); // 32 h banked, then 12 h
  const l3 = E.buildLedger(straddle, cfg);
  const fri = E.sumSession(l3.parts, 'fri');
  near('straddling shift: 8 h billed straight', fri.regHours, 8);
  near('straddling shift: 4 h billed OT', fri.otHours, 4);
  near('straddling shift gross = 8×38 + 4×57 = $532', fri.gross, 532);

  // New week, clean slate.
  const twoWeeks = plusSat.concat([shift('nw', at(2026, 8, 3, 9), at(2026, 8, 3, 17))]);
  const l4 = E.buildLedger(twoWeeks, cfg);
  near('week 2 Monday is straight time again', E.sumSession(l4.parts, 'nw').otHours, 0);
  near('week 2 Monday = $304', E.sumSession(l4.parts, 'nw').gross, 304);
}

/* ------------------------------------------------------------------ */
group('Period OT — 80 h cumulative, no weekly reset');
{
  const pcfg = { ...cfg, otMode: 'period' };
  // 10 straight days × 9 h = 90 h. Under weekly rules some of week 1 would already be OT;
  // under period rules OT starts only once the 80th hour is passed.
  const days = [];
  for (let i = 0; i < 10; i++) days.push(shift('p' + i, at(2026, 7, 26 + i, 8), at(2026, 7, 26 + i, 17)));
  const lp = E.buildLedger(days, pcfg);
  const totH = lp.parts.reduce((s, p) => s + p.hours, 0);
  const totOt = lp.parts.reduce((s, p) => s + p.otHours, 0);
  near('90 h worked', totH, 90);
  near('10 h of it is OT', totOt, 10);
  near('gross = 80×38 + 10×57 = $3,610', gross(days, pcfg), 80 * 38 + 10 * 57);

  const lw = E.buildLedger(days, cfg);
  const wOt = lw.parts.reduce((s, p) => s + p.otHours, 0);
  ok('weekly mode finds more OT on the same hours', wOt > totOt, `weekly ${wOt} vs period ${totOt}`);

  // The 80 h counter resets with the new pay period, not with the week.
  const across = days.concat([shift('next', at(2026, 8, 9, 9), at(2026, 8, 9, 17))]);
  near('first shift of the new period is straight time',
    E.sumSession(E.buildLedger(across, pcfg).parts, 'next').otHours, 0);
}

/* ------------------------------------------------------------------ */
group('Shifts that cross midnight');
{
  const night = [shift('n', at(2026, 7, 27, 22), at(2026, 7, 28, 6))]; // 10pm → 6am
  const l = E.buildLedger(night, cfg);
  near('8 h total', E.sumSession(l.parts, 'n').hours, 8);
  ok('split into two day-parts', l.parts.length === 2);
  near('2 h land on the first day',
    E.sumRange(l.parts, +new Date(2026, 6, 27), +new Date(2026, 6, 28)).hours, 2);
  near('6 h land on the second day',
    E.sumRange(l.parts, +new Date(2026, 6, 28), +new Date(2026, 6, 29)).hours, 6);
  near('gross unaffected by the split', E.sumSession(l.parts, 'n').gross, 8 * 38);

  // Sat→Sun overnight: the hours after midnight belong to the NEW week's 40 h bucket.
  const over = [shift('o', at(2026, 8, 1, 22), at(2026, 8, 2, 6))];
  const lo = E.buildLedger(over, cfg);
  const w1 = E.weekInfo(at(2026, 8, 1), cfg).index;
  ok('overnight shift straddles two week buckets',
    lo.parts[0].weekKey === 'w' + w1 && lo.parts[1].weekKey === 'w' + (w1 + 1));
}

/* ------------------------------------------------------------------ */
group('Period rollover resets the totals');
{
  const s = [shift('old', at(2026, 8, 7, 9), at(2026, 8, 7, 17)),   // this period
             shift('new', at(2026, 8, 10, 9), at(2026, 8, 10, 17))]; // next period
  const l = E.buildLedger(s, cfg);
  const p1 = E.periodInfo(at(2026, 8, 7), cfg), p2 = E.periodInfo(at(2026, 8, 10), cfg);
  near('period 1 shows only its own shift', E.sumRange(l.parts, p1.startMs, p1.endMs).gross, 304);
  near('period 2 shows only its own shift', E.sumRange(l.parts, p2.startMs, p2.endMs).gross, 304);
  ok('they really are different periods', p1.index !== p2.index);
}

/* ------------------------------------------------------------------ */
group('Auto-stop target');
{
  const start = at(2026, 7, 27, 9);
  near('8 h target with nothing banked → stops at 5pm',
    E.plannedStopAt(start, 8, [], cfg), at(2026, 7, 27, 17));

  // A morning shift already banked shortens the remainder.
  const morning = [shift('am', at(2026, 7, 27, 6), at(2026, 7, 27, 9))]; // 3 h
  near('3 h already banked → 5 h left, stops at 2pm',
    E.plannedStopAt(at(2026, 7, 27, 9), 8, morning, cfg), at(2026, 7, 27, 14));

  ok('no target set → no auto-stop', E.plannedStopAt(start, 0, [], cfg) === null);
  ok('not clocked in → no auto-stop', E.plannedStopAt(null, 8, [], cfg) === null);
  ok('target already met → stops immediately',
    E.plannedStopAt(at(2026, 7, 27, 18), 8, [shift('f', at(2026, 7, 27, 9), at(2026, 7, 27, 18))], cfg)
      === at(2026, 7, 27, 18));
}

/* ------------------------------------------------------------------ */
group('SEC / MIN / HR stepping');
{
  const ms = 90 * 60 * 1000 + 45 * 1000 + 500; // 1h 30m 45.5s
  near('sec quantises to the second', E.quantize(ms, 'sec'), 90 * 60000 + 45000);
  near('min quantises to the minute', E.quantize(ms, 'min'), 90 * 60000);
  near('hr  quantises to the hour', E.quantize(ms, 'hr'), 3600000);

  // What each toggle actually shows after 1h 30m 45.5s at $38/hr.
  const st = at(2026, 7, 27, 9);
  const shown = u => gross([shift('q', st, st + E.quantize(ms, u))]);
  near('SEC shows 1:30:45 of pay', shown('sec'), (90 * 60 + 45) / 3600 * 38, 1e-9);
  near('MIN shows 1:30:00 of pay', shown('min'), 1.5 * 38, 1e-9);
  near('HR  shows 1:00:00 of pay', shown('hr'), 38, 1e-9);
}

/* ------------------------------------------------------------------ */
group('Robustness');
{
  ok('zero-length shift is ignored', E.buildLedger([shift('z', at(2026, 7, 27, 9), at(2026, 7, 27, 9))], cfg).parts.length === 0);
  ok('inverted shift is ignored', E.buildLedger([shift('i', at(2026, 7, 27, 17), at(2026, 7, 27, 9))], cfg).parts.length === 0);

  // Out-of-order input must not change the answer — the ledger sorts before filling buckets.
  const a = [shift('x', at(2026, 7, 27, 9), at(2026, 7, 27, 21)),
             shift('y', at(2026, 7, 28, 9), at(2026, 7, 28, 21)),
             shift('z', at(2026, 7, 29, 9), at(2026, 7, 29, 21)),
             shift('w', at(2026, 7, 30, 9), at(2026, 7, 30, 21))]; // 48 h → 8 h OT
  near('chronological order → 8 h OT', E.buildLedger(a, cfg).parts.reduce((s, p) => s + p.otHours, 0), 8);
  near('reversed input → identical gross', gross(a.slice().reverse()), gross(a));

  // A long shift across a DST transition still bills real elapsed hours.
  // (US DST ends Sun Nov 1 2026; a 22:00 → 06:00 shift is 9 real hours where DST applies.)
  const dst = [shift('dst', at(2026, 10, 31, 22), at(2026, 11, 1, 6))];
  const dstH = E.sumSession(E.buildLedger(dst, cfg).parts, 'dst').hours;
  const realH = (at(2026, 11, 1, 6) - at(2026, 10, 31, 22)) / E.HOUR_MS;
  near('DST-night hours match real elapsed time', dstH, realH);

  ok('a whole 24 h day splits into exactly one part',
    E.splitSession(at(2026, 7, 27, 0), at(2026, 7, 28, 0), cfg).length === 1);

  // Marathon shift: must terminate and stay exact.
  const long = [shift('L', at(2026, 7, 27, 0), at(2026, 8, 3, 0))]; // 168 h
  near('7-day shift = 168 h', E.sumSession(E.buildLedger(long, cfg).parts, 'L').hours, 168);
}


/* ---------------- holidays and the roster ---------------- */
{
  const H = E.HOLIDAY_DEFAULTS();
  const by = id => H.find(h => h.id === id);
  const on = (h, y) => { const d = E.holidayDate(h, y); return d && E.dkey(d.getFullYear(), d.getMonth(), d.getDate()); };

  // Fixed dates are the easy half.
  ok("New Year's 2026 is Jan 1",  on(by('newyear'), 2026) === '2026-01-01');
  ok('July 4th 2026 is Jul 4',    on(by('july4'),   2026) === '2026-07-04');
  ok('Christmas 2026 is Dec 25',  on(by('xmas'),    2026) === '2026-12-25');
  ok('and they move year to year without editing',
     on(by('xmas'), 2031) === '2031-12-25' && on(by('july4'), 2044) === '2044-07-04');

  // The weekday rules are where a calendar goes wrong. Checked against real almanac dates.
  ok('Labor Day 2026 = Mon Sep 7',        on(by('labor'),    2026) === '2026-09-07');
  ok('Labor Day 2027 = Mon Sep 6',        on(by('labor'),    2027) === '2027-09-06');
  ok('Memorial Day 2026 = Mon May 25',    on(by('memorial'), 2026) === '2026-05-25');
  ok('Memorial Day 2027 = Mon May 31',    on(by('memorial'), 2027) === '2027-05-31');
  ok('Memorial Day 2032 = Mon May 31',    on(by('memorial'), 2032) === '2032-05-31');
  ok('Thanksgiving 2026 = Thu Nov 26',    on(by('thanks'),   2026) === '2026-11-26');
  ok('Thanksgiving 2027 = Thu Nov 25',    on(by('thanks'),   2027) === '2027-11-25');
  ok('Thanksgiving 2028 = Thu Nov 23',    on(by('thanks'),   2028) === '2028-11-23');

  // A month whose 1st IS the weekday in question — the classic off-by-one.
  // Sep 1 2025 was a Monday, so the 1st Monday is the 1st itself, not the 8th.
  ok('a month starting on the weekday counts that day as the first',
     on(by('labor'), 2025) === '2025-09-01');
  // May 31 2027 is a Monday, so "last Monday" is the final day of the month.
  ok('"last" reaches the final day when it lands there', on(by('memorial'), 2027) === '2027-05-31');

  // n past the end of the month has no date rather than spilling into the next one.
  ok('a 5th weekday that does not exist returns null',
     E.nthDow(2026, 1, 1, 5) === null);                       // no 5th Monday in Feb 2026
  ok('but a 5th weekday that does exist is found',
     E.dkey(2026, 2, E.nthDow(2026, 2, 1, 5).getDate()) === '2026-03-30');

  // One-off dates belong to their own year only.
  const once = { id: 'x', name: 'Contract day', rule: { kind: 'on', date: '2026-04-10' } };
  ok('a one-off lands on its date',      on(once, 2026) === '2026-04-10');
  ok('and does not repeat next year',    E.holidayDate(once, 2027) === null);

  const cfg = { holidays: H, workDays: [true, true, true, true, true, false, false] };
  const list = E.holidaysInYear(cfg, 2026);
  ok('six holidays in a year', list.length === 6, list.length);
  ok('in date order', list.every((h, i) => i === 0 || h.ms >= list[i - 1].ms));
  ok('and each carries the day it falls on', list[0].key === '2026-01-01');

  // Switching one off removes it without disturbing the rest.
  const off = H.map(h => h.id === 'july4' ? Object.assign({}, h, { on: false }) : h);
  ok('a holiday switched off drops out', E.holidaysInYear({ holidays: off }, 2026).length === 5);

  ok('a date with a holiday is recognised',
     E.holidayOn(cfg, new Date(2026, 8, 7).getTime()).id === 'labor');
  ok('and an ordinary day is not', E.holidayOn(cfg, new Date(2026, 8, 8).getTime()) === null);

  // The roster: Curtis works Sunday through Thursday.
  ok('Sunday is a work day',   E.isWorkDay(cfg, 0));
  ok('Thursday is a work day', E.isWorkDay(cfg, 4));
  ok('Friday is not',         !E.isWorkDay(cfg, 5));
  ok('Saturday is not',       !E.isWorkDay(cfg, 6));
  ok('an unset roster counts every day', E.isWorkDay({}, 6));

  // "The day before and the day after" means the shifts either side, not the dates.
  const key = d => E.dkey(d.getFullYear(), d.getMonth(), d.getDate());
  const mon = new Date(2026, 8, 7);                            // Labor Day 2026, a Monday
  ok('the shift before a Monday holiday is the Sunday',
     key(E.adjacentWorkDay(cfg, +mon, -1)) === '2026-09-06');
  ok('and the shift after is the Tuesday',
     key(E.adjacentWorkDay(cfg, +mon,  1)) === '2026-09-08');

  // A holiday on a day off has to skip the weekend to find the shifts either side.
  const fri = new Date(2026, 6, 3);                            // Fri Jul 3 2026
  ok('from a Friday, the shift before is the Thursday',
     key(E.adjacentWorkDay(cfg, +fri, -1)) === '2026-07-02');
  ok('and the shift after skips the weekend to Sunday',
     key(E.adjacentWorkDay(cfg, +fri,  1)) === '2026-07-05');

  // A one-day roster still resolves rather than spinning.
  const sundays = { workDays: [true, false, false, false, false, false, false] };
  ok('a one-day roster still finds the shift before',
     key(E.adjacentWorkDay(sundays, +new Date(2026, 8, 9), -1)) === '2026-09-06');
  ok('an empty roster has no adjacent shift',
     E.adjacentWorkDay({ workDays: [false,false,false,false,false,false,false] }, +mon, -1) === null);
}


/* ---------------- holiday pay ---------------- */
{
  // $38/hr, weekly 40 h overtime, Sunday-start weeks, Curtis's Sun-Thu roster.
  /* These cover a holiday that accrues toward overtime — still a supported arrangement,
     just no longer the default, so the flag is set here rather than assumed. */
  const hcfg = { ...E.DEFAULTS, rate: 38, periodAnchor: '2026-11-22',
                 holidays: E.HOLIDAY_DEFAULTS().map(h => ({ ...h, ot: true })),
                 workDays: [true, true, true, true, true, false, false] };
  const at = (y, mo, d, h) => new Date(y, mo, d, h).getTime();
  const sh = (id, mo, d, from, to) => ({ id, start: at(2026, mo, d, from), end: at(2026, mo, d, to) });
  const H = 3600000;

  // Thanksgiving 2026 is Thu Nov 26. Roster Sun-Thu, so either side means Wed 25 and Sun 29.
  const wed = sh('wed', 10, 25, 9, 17);          // 8 h
  const sun = sh('sun', 10, 29, 9, 17);          // 8 h
  const thu = sh('thu', 10, 26, 9, 17);          // 8 h worked ON the holiday

  const credits = s => E.holidayCredits(s, hcfg);
  const thxOnly = c => c.filter(x => x.id === '__hol:2026-11-26');

  ok('no credit with neither side worked', thxOnly(credits([])).length === 0);
  ok('no credit with only the day before', thxOnly(credits([wed])).length === 0);
  ok('no credit with only the day after',  thxOnly(credits([sun])).length === 0);
  ok('both sides worked earns it',         thxOnly(credits([wed, sun])).length === 1);

  const c = thxOnly(credits([wed, sun]))[0];
  ok('worth 8 hours',   Math.abs((c.end - c.start) / H - 8) < 1e-9, (c.end - c.start) / H);
  ok('placed on the holiday itself', E.dkey(new Date(c.start).getFullYear(),
     new Date(c.start).getMonth(), new Date(c.start).getDate()) === '2026-11-26');
  ok('flagged straight so it never pays overtime on itself', c.adj.straight === true);
  ok('and carries no lunch deduction', c.adj.noLunch === true);

  // Not working it: 16 h worked + 8 h holiday = 24 h, all straight. 24 * 38 = 912.
  const off = E.buildLedger([wed, sun], hcfg);
  const offT = off.parts.reduce((t, p) => ({ hours: t.hours + p.hours, gross: t.gross + p.gross,
                                             ot: t.ot + p.otHours }), { hours: 0, gross: 0, ot: 0 });
  near('not working it: 24 h banked', offT.hours, 24);
  near('paid $912.00', offT.gross, 912);
  near('none of it overtime', offT.ot, 0);

  // Working it: 24 h worked + 8 h holiday = 32 h. 32 * 38 = 1216.
  const on = E.buildLedger([wed, thu, sun], hcfg);
  const onT = on.parts.reduce((t, p) => ({ hours: t.hours + p.hours, gross: t.gross + p.gross,
                                           ot: t.ot + p.otHours }), { hours: 0, gross: 0, ot: 0 });
  near('working it: 32 h banked', onT.hours, 32);
  near('the worked hours are paid on top — $1,216.00', onT.gross, 1216);
  ok('which is exactly 8 h more than not working it', Math.abs((onT.gross - offT.gross) - 8 * 38) < 1e-6);

  /* The 8 holiday hours push worked hours into overtime sooner. Sun 22 - Wed 25 at 9 h
     banks 36 h straight. The credit sits at midnight opening Thursday, taking the bucket
     to 44 — past the 40 h line — so every one of Thursday's 9 worked hours is overtime.
     Without the credit Thursday would have had 4 h of headroom left, so 4 straight and
     5 over. The holiday therefore turns 5 h of overtime into 9. */
  const week = [sh('w22', 10, 22, 9, 18), sh('w23', 10, 23, 9, 18),   // 9 h each
                sh('w24', 10, 24, 9, 18), sh('w25', 10, 25, 9, 18),   // 36 h by Wed
                sh('w26', 10, 26, 9, 18)];                            // 9 h on the holiday
  const withHol = E.buildLedger(week.concat([sun]), hcfg);
  const wk = withHol.parts.filter(p => p.weekKey === withHol.parts.find(x => x.sessionId === 'w22').weekKey);
  const wkOt = wk.reduce((s, p) => s + p.otHours, 0);
  const wkHours = wk.reduce((s, p) => s + p.hours, 0);
  near('the holiday week banks 45 h + 8 h holiday = 53 h', wkHours, 53);
  near('9 h of it is overtime once the holiday counts', wkOt, 9);
  const noHol = E.buildLedger(week, { ...hcfg, holidayCredit: false });
  near('without the holiday counting it would be 5 h', noHol.parts.reduce((s, p) => s + p.otHours, 0), 5);
  // The holiday is paid straight even though the bucket was already past the line.
  const hp = withHol.parts.filter(p => p.sessionId === '__hol:2026-11-26');
  near('and the holiday itself is still straight time', hp.reduce((s, p) => s + p.otHours, 0), 0);
  near('worth 8 x $38 = $304.00', hp.reduce((s, p) => s + p.gross, 0), 304);

  // A holiday whose own flag says it does not count stays out of the bucket entirely.
  const noOtCfg = { ...hcfg, holidays: hcfg.holidays.map(h =>
                    h.id === 'thanks' ? { ...h, ot: false } : h) };
  const nc = E.holidayCredits([wed, sun], noOtCfg).filter(x => x.id === '__hol:2026-11-26')[0];
  ok('an OT-exempt holiday is flagged noOt', nc.adj.noOt === true && !nc.adj.straight);

  // Switching the rule off pays it regardless of what was worked.
  ok('with the either-side rule off it pays on its own',
     E.holidayCredits([], { ...hcfg, holidayNeedsAdjacent: false, holidays: hcfg.holidays })
      .filter(x => x.id === '__hol:2026-11-26').length === 1);

  // A holiday on a day off: July 4 2026 is a Saturday. Either side = Thu Jul 2, Sun Jul 5.
  const jcfg = { ...hcfg, periodAnchor: '2026-06-28' };
  const thu2 = sh('j2', 6, 2, 9, 17), sun5 = sh('j5', 6, 5, 9, 17);
  const j4 = cc => E.holidayCredits(cc, jcfg).filter(x => x.id === '__hol:2026-07-04').length;
  ok('a Saturday holiday still pays when either side is worked', j4([thu2, sun5]) === 1);
  ok('and does not when the Thursday is missed',                 j4([sun5]) === 0);
  ok('nor when the Sunday is missed',                            j4([thu2]) === 0);
  ok('set to not pay on a day off, it does not',
     E.holidayCredits([thu2, sun5], { ...jcfg, holidayOffDayPays: false })
      .filter(x => x.id === '__hol:2026-07-04').length === 0);

  // The outlook: what the app shows about each holiday.
  const look = E.holidayOutlook([wed], hcfg, at(2026, 10, 27, 12));   // the Friday after
  const thx = look.find(h => h.key === '2026-11-26');
  ok('Thanksgiving is still pending on the Friday', thx.status === 'pending', thx.status);
  ok('and names the Sunday as what is still needed',
     thx.need.length === 1 && E.dkey(thx.need[0].getFullYear(), thx.need[0].getMonth(),
                                     thx.need[0].getDate()) === '2026-11-29');
  const late = E.holidayOutlook([wed], hcfg, at(2026, 11, 5, 12)).find(h => h.key === '2026-11-26');
  ok('by the following week it is lost', late.status === 'lost', late.status);
  const got = E.holidayOutlook([wed, sun], hcfg, at(2026, 11, 5, 12)).find(h => h.key === '2026-11-26');
  ok('and earned once both are in', got.paid === true && got.status === 'paid');
  ok('the outlook prices it', Math.abs(got.pay - 8 * 38) < 1e-6, got.pay);

  /* A holiday from before the first shift on file was not missed — nothing was being
     tracked yet. Saying "missed" there would put four red badges on a new user's screen
     for days they may well have been paid for. */
  const early = E.holidayOutlook([wed, sun], hcfg, at(2026, 11, 5, 12));
  const ny = early.find(h => h.key === '2026-01-01');
  ok('a holiday before the first shift reads as untracked', ny.status === 'untracked', ny.status);
  ok('and claims nothing is owed for it', ny.paid === false && ny.need.length === 0);
  const xmas = early.find(h => h.key === '2026-12-25');
  ok('while one still ahead stays pending', xmas.status === 'pending', xmas.status);
  ok('an untracked holiday is still never credited',
     E.holidayCredits([wed, sun], hcfg).some(c => c.id === '__hol:2026-01-01') === false);
  ok('and knows whether it was worked', got.worked === false &&
     E.holidayOutlook([wed, thu, sun], hcfg, at(2026, 11, 5, 12))
      .find(h => h.key === '2026-11-26').worked === true);

  // Nothing is credited twice, however many times the ledger is built.
  const twice = E.buildLedger([wed, sun], hcfg);
  ok('one credit per holiday, not one per rebuild',
     twice.parts.filter(p => p.sessionId === '__hol:2026-11-26').length === 1);

  ok('an empty roster earns nothing rather than throwing',
     E.holidayCredits([wed, sun], { ...hcfg, workDays: [false,false,false,false,false,false,false] }).length === 0);
  ok('zero holiday hours credits nothing', E.holidayCredits([wed, sun], { ...hcfg, holidayHours: 0 }).length === 0);
  ok('no holidays configured credits nothing', E.holidayCredits([wed, sun], { ...hcfg, holidays: [] }).length === 0);
}


/* ---------------- a total can say which part of it was worked ---------------- */
{
  const D=(d,h,mi=0)=>+new Date(2026,8,d,h,mi);
  const cfg={...E.DEFAULTS,rate:40,otMultiplier:1.5,otMode:'eight40',weeklyThreshold:40,
    shiftThreshold:8,periodAnchor:'2026-09-06',periodLengthDays:14,payDateOffsetDays:13,
    weekStartDay:0,workDays:[true,true,true,true,true,false,false],
    schedStart:'14:00',schedEnd:'22:30',lunchMins:0,
    holidays:E.holidaysFromCatalog(['labor']),banks:[],daysOff:[],vacations:[]};
  /* Labor Day 2026 is Mon Sep 7; the rostered days either side are Sun 6 and Tue 8. */
  const work=[{id:'sun',start:D(6,14),end:D(6,22)},{id:'tue',start:D(8,14),end:D(8,22)}];
  const t=E.sumRange(E.buildLedger(work,cfg).parts,D(6,0),D(13,0));

  ok('the holiday is in the total', Math.abs(t.hours-24)<0.005, String(t.hours));
  /* Straight time, so it lands in regHours — which is exactly why it needs carving out. */
  ok('and inside the regular hours', Math.abs(t.regHours-24)<0.005, String(t.regHours));
  ok('holHours names the eight that arrived', Math.abs(t.holHours-8)<0.005, String(t.holHours));
  ok('and what they were worth', Math.abs(t.holGross-320)<0.005, String(t.holGross));
  ok('so the hours actually worked can be told apart',
     Math.abs((t.regHours-t.holHours)-16)<0.005, String(t.regHours-t.holHours));
  ok('leaveHours counts every kind of paid leave', Math.abs(t.leaveHours-8)<0.005, String(t.leaveHours));

  /* A week with no holiday reports zero rather than undefined, so callers can add freely. */
  const plain=E.sumRange(E.buildLedger(work,{...cfg,holidays:[]}).parts,D(6,0),D(13,0));
  ok('a week without one reports zero, not undefined',
     plain.holHours===0 && plain.holGross===0 && plain.leaveHours===0,
     JSON.stringify([plain.holHours,plain.holGross,plain.leaveHours]));

  /* A sick day is paid leave but not a holiday — the two must not be conflated. */
  const sickCfg={...cfg,holidays:[],
    banks:[{id:'sick',name:'Sick day',count:5,hours:8,ot:false,makeUp:true,slots:[]}],
    daysOff:[{id:'d1',bank:'sick',slot:null,date:'2026-09-09'}]};
  const sk=E.sumRange(E.buildLedger(work,sickCfg).parts,D(6,0),D(13,0));
  ok('a sick day counts as leave but not as a holiday',
     Math.abs(sk.leaveHours-8)<0.005 && sk.holHours===0,
     'leave '+sk.leaveHours+' hol '+sk.holHours);
}

/* ---------------- work on a day you are not rostered ---------------- */
{
  const D=(d,h,mi=0)=>+new Date(2026,8,d,h,mi);
  /* Sun–Thu roster, 8-and-40, the shape of a fixed-roster transit job. */
  const base={...E.DEFAULTS,rate:40,otMultiplier:1.5,otMode:'eight40',weeklyThreshold:40,
    shiftThreshold:8,periodAnchor:'2026-09-06',periodLengthDays:14,payDateOffsetDays:13,
    weekStartDay:0,workDays:[true,true,true,true,true,false,false],
    schedStart:'14:00',schedEnd:'22:30',lunchMins:0,holidays:[],banks:[],daysOff:[],vacations:[]};
  const on={...base,offDayOt:true};
  const sat=[{id:'sat',start:D(12,9),end:D(12,14)}];              // Sat, 5 h, under every threshold
  const sum=(cfg,ss)=>E.sumRange(E.buildLedger(ss,cfg).parts,D(6,0),D(20,0));

  ok('off by default, so a short Saturday is ordinary time',
     sum(base,sat).otHours===0, String(sum(base,sat).otHours));
  const s2=sum(on,sat);
  ok('switched on, every minute of it is overtime', s2.otHours===5 && s2.regHours===0,
     'reg '+s2.regHours+' ot '+s2.otHours);
  ok('and it is paid at the overtime rate', Math.abs(s2.gross-5*60)<0.005, String(s2.gross));

  /* The configured rule cannot see this day at all — five hours is under every threshold
     there is — so without the rule the ledger quietly pays a day off as ordinary time. */
  ok('which the threshold rule could never have found', sum(base,sat).gross===200);

  /* A rostered day is untouched: the ordinary rule still decides. */
  const mon=[{id:'mon',start:D(7,14),end:D(7,19)}];               // Mon, 5 h, rostered
  ok('a rostered short day is unaffected', sum(on,mon).otHours===0, String(sum(on,mon).otHours));

  /* A shift is judged on the day it IS, not on every calendar day it touches. A Thursday
     run finishing after midnight is a Thursday shift, not part Friday. */
  const thu=[{id:'thu',start:D(10,22),end:D(11,1)}];              // Thu 22:00 → Fri 01:00
  ok('a Thursday run past midnight stays a Thursday shift',
     sum(on,thu).otHours===0, 'ot '+sum(on,thu).otHours);
  const fri=[{id:'fri',start:D(11,22),end:D(12,1)}];              // Fri 22:00 → Sat 01:00
  ok('and a Friday one is off-roster throughout', sum(on,fri).otHours===3,
     'ot '+sum(on,fri).otHours);

  /* Off-roster hours still fill the bucket, so they count toward the week like any work. */
  const week=[{id:'a',start:D(6,14),end:D(6,22)},{id:'b',start:D(7,14),end:D(7,22)},
              {id:'c',start:D(8,14),end:D(8,22)},{id:'d',start:D(9,14),end:D(9,22)},
              {id:'e',start:D(10,14),end:D(10,22)},                       // 40 h Sun–Thu
              {id:'f',start:D(12,9),end:D(12,14)}];                       // + 5 h Saturday
  const w=sum(on,week);
  ok('the week is still 45 hours', w.hours===45, String(w.hours));
  ok('with the Saturday all overtime', w.otHours===5 && w.regHours===40,
     'reg '+w.regHours+' ot '+w.otHours);

  /* Paid leave booked on a day off is not work and must not become overtime. */
  const withSick={...on,banks:[{id:'sick',name:'Sick day',count:5,hours:8,ot:false,
    makeUp:true,slots:[]}],daysOff:[{id:'d1',bank:'sick',slot:null,date:'2026-09-12'}]};
  const sk=E.sumRange(E.buildLedger([],withSick).parts,D(6,0),D(20,0));
  ok('a sick day booked on a Saturday is not overtime', sk.otHours===0,
     'ot '+sk.otHours+' of '+sk.hours);

  /* A roster of seven days has no unscheduled day, so the setting is inert. */
  const every={...on,workDays:[true,true,true,true,true,true,true]};
  ok('a seven-day roster is unaffected by the rule',
     sum(every,sat).otHours===0, String(sum(every,sat).otHours));
}

/* ---------------- the paper time sheet ---------------- */
{
  const D = (d, h, mi=0) => +new Date(2026, 7, d, h, mi);
  /* An overnight roster like a revenue-services one: in at midnight, out at 08:00. */
  const overnight = [
    { id:'a', start: D(16, 0), end: D(16, 8) },
    { id:'b', start: D(17, 0), end: D(17, 8) },
    { id:'c', start: D(19, 0), end: D(19, 8) },
  ];

  ok('midnight is written 2400, the way the paper is filled in',
     E.fmtSheetTime(D(16, 0)) === '2400', E.fmtSheetTime(D(16, 0)));
  ok('other times are four digits', E.fmtSheetTime(D(16, 7, 30)) === '0730', E.fmtSheetTime(D(16,7,30)));
  ok('a null punch renders as nothing', E.fmtSheetTime(null) === '');

  const rows = E.sheetRows(overnight, D(16, 0), D(23, 0));
  ok('one row per day worked', rows.length === 3, String(rows.length));
  ok('eight raw hours each', rows.every(r => r.hours === 8), JSON.stringify(rows.map(r=>r.hours)));

  /* Signing out for a break and back in is still one line on the paper: first in, last out. */
  const split = [
    { id:'a', start: D(16, 7, 30), end: D(16, 11) },
    { id:'b', start: D(16, 12),    end: D(16, 15, 30) },
  ];
  const one = E.sheetRows(split, D(16, 0), D(17, 0));
  ok('two punches in a day make one row', one.length === 1, String(one.length));
  ok('first in and last out', E.fmtSheetTime(one[0].inMs) === '0730' && E.fmtSheetTime(one[0].outMs) === '1530',
     E.fmtSheetTime(one[0].inMs) + '-' + E.fmtSheetTime(one[0].outMs));
  ok('and the gap does not count as premises time', one[0].hours === 7, String(one[0].hours));

  /* A shift that runs past midnight stays on the day it started, one line, like the paper. */
  const late = [{ id:'x', start: D(16, 14), end: D(17, 1) }];
  const lr = E.sheetRows(late, D(16, 0), D(23, 0));
  ok('an overnight run is one row on its starting day', lr.length === 1 && lr[0].dayMs === +new Date(2026,7,16),
     JSON.stringify(lr.map(r => new Date(r.dayMs).getDate())));
  ok('with the out time on the far side of midnight', E.fmtSheetTime(lr[0].outMs) === '0100',
     E.fmtSheetTime(lr[0].outMs));

  /* A fourteen-day period folds into two weekly blocks, every date present even unworked —
     the form prints a line per day and a supervisor expects to see it. */
  const blocks = E.sheetBlocks(overnight, +new Date(2026, 7, 16), 14);
  ok('two blocks for a fortnight', blocks.length === 2, String(blocks.length));
  ok('seven dates in each, worked or not',
     blocks[0].days.length === 7 && blocks[1].days.length === 7);
  ok('unworked days are present and blank',
     blocks[0].days.filter(d => d.inMs == null).length === 4,
     String(blocks[0].days.filter(d => d.inMs == null).length));
  ok('the block total is the sum of its days', blocks[0].hours === 24, String(blocks[0].hours));
  ok('and the second block is empty but still drawn', blocks[1].hours === 0 && blocks[1].days.length === 7);

  /* A seven-day period is one block. */
  ok('a weekly period folds into one block',
     E.sheetBlocks(overnight, +new Date(2026, 7, 16), 7).length === 1);

  /* A shift that began before the period is the previous sheet's row, not this one's. */
  const straddle = [{ id:'p', start: D(15, 22), end: D(16, 6) }].concat(overnight);
  const b2 = E.sheetBlocks(straddle, +new Date(2026, 7, 16), 14);
  ok('a shift started before the period stays off this sheet',
     b2[0].days[0].inMs === D(16, 0), E.fmtSheetTime(b2[0].days[0].inMs));

  ok('an empty log is a sheet of blank dated lines',
     E.sheetBlocks([], +new Date(2026, 7, 16), 14).every(b => b.hours === 0));
}

/* ---------------- the holiday catalog ---------------- */
{
  const iso = d => d ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : 'null';
  const cat = E.HOLIDAY_CATALOG();
  const by = id => cat.find(h => h.id === id);

  /* Easter is here because Good Friday cannot be written as a date or as a weekday of a
     month. Checked against the published Gregorian tables rather than against itself. */
  const easters = { 2020:'2020-04-12', 2023:'2023-04-09', 2024:'2024-03-31', 2025:'2025-04-20',
                    2026:'2026-04-05', 2027:'2027-03-28', 2038:'2038-04-25', 2049:'2049-04-18',
                    1943:'1943-04-25', 2076:'2076-04-19' };
  ok('Easter matches the published tables',
     Object.keys(easters).every(y => iso(E.easterSunday(+y)) === easters[y]),
     Object.keys(easters).map(y => y + ':' + iso(E.easterSunday(+y))).join(' '));

  let dowBad = 0, lo = '99-99', hi = '00-00';
  for (let y = 1700; y < 2400; y++){
    const e = E.easterSunday(y);
    if (e.getDay() !== 0) dowBad++;
    const md = `${String(e.getMonth()+1).padStart(2,'0')}-${String(e.getDate()).padStart(2,'0')}`;
    if (md < lo) lo = md;
    if (md > hi) hi = md;
  }
  ok('Easter is a Sunday in all 700 years checked', dowBad === 0, String(dowBad));
  ok('and never leaves its Mar 22 – Apr 25 bounds', lo >= '03-22' && hi <= '04-25', lo + ' .. ' + hi);
  ok('Good Friday 2026 is April 3', iso(E.holidayDate(by('goodfri'), 2026)) === '2026-04-03',
     iso(E.holidayDate(by('goodfri'), 2026)));

  /* The day after Thanksgiving is not a date anyone can write down — it moves with
     Thanksgiving, and a catalog of fixed dates would have had to leave it out. */
  ok('the day after Thanksgiving 2026 is Nov 27',
     iso(E.holidayDate(by('dayafter'), 2026)) === '2026-11-27', iso(E.holidayDate(by('dayafter'), 2026)));
  let offBad = 0;
  for (let y = 2000; y < 2040; y++){
    const t = E.holidayDate(by('thanks'), y), a = E.holidayDate(by('dayafter'), y);
    if (t.getDay() !== 4 || a.getDay() !== 5) offBad++;
    if ((a - t) !== 86400000) offBad++;
  }
  ok('and it follows Thanksgiving for 40 years running', offBad === 0, String(offBad));

  /* A saved config is user data and may have been hand-edited, so a rule that points at
     itself has to end rather than recurse. */
  const evil = { rule: { kind: 'offset', days: 1 } };
  evil.rule.from = evil.rule;
  ok('a self-referencing rule returns null rather than hanging', E.holidayDate(evil, 2026) === null);

  ok('the federal preset is the eleven federal holidays',
     E.holidayPresetIds('fed').length === 11, String(E.holidayPresetIds('fed').length));
  ok('and includes Juneteenth, which the old six could not express',
     E.holidayPresetIds('fed').includes('juneteenth'));
  ok('the common preset is still six', E.holidayPresetIds('common').length === 6,
     String(E.holidayPresetIds('common').length));
  ok('every catalog entry resolves in every year 2020-2040', (() => {
    for (let y = 2020; y <= 2040; y++) if (cat.some(h => !E.holidayDate(h, y))) return false;
    return true;
  })());
  ok('a preset builds holidays this config can hold',
     E.holidaysFromCatalog(E.holidayPresetIds('fed')).every(h => h.on === true && h.ot === false && h.rule),
     JSON.stringify(E.holidaysFromCatalog(['xmas'])));
  ok('an unknown id is dropped rather than invented',
     E.holidaysFromCatalog(['xmas', 'nope']).length === 1);
}

/* ---------------- floaters and sick days ---------------- */
{
  /* Nothing ships at all. The app used to hand everybody five sick days and five Pace
     "vacation random days"; neither number came from anywhere. An invented allowance is
     worse than an omitted one — an omission is visibly missing, whereas an invented five
     reads as a fact somebody has to notice is wrong. */
  const B = E.BANK_DEFAULTS();
  ok('no allowance is assumed at all', B.length === 0, JSON.stringify(B));
  ok('so nothing has to be noticed and deleted', !E.bankById({ banks: B }, 'sick'));

  /* Every kind offered as a starting point begins at zero, so choosing one never tells
     somebody how many they have. */
  const KINDS = E.BANK_KINDS;
  ok('the offered kinds are reachable from the engine', !!KINDS && Object.keys(KINDS).length > 4,
     String(KINDS && Object.keys(KINDS).length));
  ok('every offered kind starts at zero',
     Object.keys(KINDS).every(k => !KINDS[k].count),
     JSON.stringify(Object.keys(KINDS).map(k => [k, KINDS[k].count])));
  ok('and the Pace one is offered rather than assumed', !!KINDS.vrd && !B.some(b => b.id === 'vrd'));

  /* Banks the person adds are first-class — everything below still has to work for them. */
  const SICK = { id: 'sick', name: 'Sick day', count: 5, hours: 8, ot: false,
                 makeUp: true, slots: [] };
  const VRD  = { id: 'vrd', name: 'Vacation random day', count: 5, hours: 8, ot: false,
                 makeUp: false, slots: [] };
  const FL = { id: 'float', name: 'Floating holiday', count: 3, hours: 8, ot: true,
               makeUp: false, slots: ['MLK Day','Birthday','Anniversary'] };
  const cfg3 = { ...E.DEFAULTS, rate: 38, periodAnchor: '2026-01-04',
                 banks: [FL, SICK, VRD],
                 workDays: [true,true,true,true,true,false,false], daysOff: [] };

  ok('a fresh year has all three floaters', E.bankLeft(cfg3, 'float', 2026) === 3);
  ok('and all five sick days',             E.bankLeft(cfg3, 'sick',  2026) === 5);

  /* ---- days already spent before the app was installed ----
     Nobody installs a pay app on 1 January. "5 of 5 left" in August is not optimism; it is
     wrong about the one thing the allowance exists to tell you. */
  const carried = { ...cfg3, banks: [
    { ...FL, usedBefore: 2, usedYear: 2026 },
    { ...SICK, usedBefore: 3, usedYear: 2026 }
  ]};
  ok('a carry-in is subtracted', E.bankLeft(carried, 'float', 2026) === 1,
     String(E.bankLeft(carried, 'float', 2026)));
  ok('and counted as used',      E.bankUsed(carried, 'float', 2026) === 2,
     String(E.bankUsed(carried, 'float', 2026)));
  ok('sick days too', E.bankLeft(carried, 'sick', 2026) === 2,
     String(E.bankLeft(carried, 'sick', 2026)));

  /* It stacks with days the app has actually watched, rather than replacing them. */
  const mixedUse = { ...carried,
    daysOff: [{ id: 'x', bank: 'sick', slot: null, date: '2026-09-02' }] };
  ok('a carry-in plus a real day is four used', E.bankUsed(mixedUse, 'sick', 2026) === 4,
     String(E.bankUsed(mixedUse, 'sick', 2026)));
  ok('leaving one',                             E.bankLeft(mixedUse, 'sick', 2026) === 1,
     String(E.bankLeft(mixedUse, 'sick', 2026)));

  /* Year-scoped. The allowance resets each January, so a 2026 carry-in must not go on
     eating 2027's days — the quiet kind of wrong that only shows up months later. */
  ok('the carry-in expires with its year', E.bankLeft(carried, 'sick', 2027) === 5,
     String(E.bankLeft(carried, 'sick', 2027)));
  ok('and did not apply the year before',  E.bankLeft(carried, 'sick', 2025) === 5,
     String(E.bankLeft(carried, 'sick', 2025)));

  /* Nonsense never produces a negative allowance or a phantom one. */
  const silly = { ...cfg3, banks: [{ ...SICK, usedBefore: 99, usedYear: 2026 }] };
  ok('a carry-in bigger than the allowance floors at zero',
     E.bankLeft(silly, 'sick', 2026) === 0, String(E.bankLeft(silly, 'sick', 2026)));
  ok('and never reports more used than exist',
     E.bankUsed(silly, 'sick', 2026) === 5, String(E.bankUsed(silly, 'sick', 2026)));
  [null, undefined, NaN, -4, 'two'].forEach(function(v){
    ok('a carry-in of ' + JSON.stringify(v) + ' is simply none',
       E.bankUsedBefore({ count: 5, usedBefore: v, usedYear: 2026 }, 2026) === 0,
       String(E.bankUsedBefore({ count: 5, usedBefore: v, usedYear: 2026 }, 2026)));
  });
  ok('an unstamped carry-in still applies',
     E.bankUsedBefore({ count: 5, usedBefore: 2 }, 2026) === 2);
  ok('and no carry-in at all changes nothing',
     E.bankLeft(cfg3, 'sick', 2026) === 5);

  // Spend the MLK floater on MLK day 2026 (Mon Jan 19) and a sick day in March.
  const spent = { ...cfg3, daysOff: [
    { id: 'a', bank: 'float', slot: 0, date: '2026-01-19' },
    { id: 'b', bank: 'sick',  slot: null, date: '2026-03-10' }
  ]};
  ok('spending a floater leaves two', E.bankLeft(spent, 'float', 2026) === 2, E.bankLeft(spent, 'float', 2026));
  ok('spending a sick day leaves four', E.bankLeft(spent, 'sick',  2026) === 4, E.bankLeft(spent, 'sick', 2026));
  ok('and it is named by its slot', E.dayOffName(spent, spent.daysOff[0]) === 'MLK Day',
     E.dayOffName(spent, spent.daysOff[0]));
  ok('a slotless bank falls back to the bank name',
     E.dayOffName(spent, spent.daysOff[1]) === 'Sick day', E.dayOffName(spent, spent.daysOff[1]));

  const slots = E.bankSlots(spent, 'float', 2026);
  ok('three slots are reported', slots.length === 3);
  ok('MLK Day shows as taken', slots[0].used && slots[0].used.date === '2026-01-19');
  ok('the birthday is still free', slots[1].name === 'Birthday' && !slots[1].used);

  // Allowances run by calendar year, so next year starts full without anything being cleared.
  ok('next year is full again', E.bankLeft(spent, 'float', 2027) === 3);
  ok('and last year is too',    E.bankLeft(spent, 'float', 2025) === 3);
  ok('the used list is per year', E.daysOffUsed(spent, 'float', 2026).length === 1 &&
                                  E.daysOffUsed(spent, 'float', 2027).length === 0);

  // Pricing.
  const cr = E.bankCredits(spent);
  ok('two credits', cr.length === 2, cr.length);
  const flc = cr.find(c => c.bank === 'float'), skc = cr.find(c => c.bank === 'sick');
  near('a floater is worth 8 h', (flc.end - flc.start) / 3600000, 8);
  ok('a floater fills the overtime bucket', flc.adj.straight === true && !flc.adj.noOt);
  ok('a sick day does not',                 skc.adj.noOt === true && !skc.adj.straight);
  ok('neither has lunch taken off', flc.adj.noLunch === true && skc.adj.noLunch === true);
  ok('a floater is named on its credit', flc.dayOff === 'MLK Day', flc.dayOff);

  // In the ledger, next to real work. Week of Mon Jan 19 2026 (Sun Jan 18 starts it).
  const d = (day, from, to) => ({ id: 'w' + day, start: +new Date(2026, 0, day, from),
                                                 end: +new Date(2026, 0, day, to) });
  // Sun 18 - Thu 22 at 9 h = 45 h. Add the MLK floater on the Monday.
  const wk = [d(18,9,18), d(19,9,18), d(20,9,18), d(21,9,18), d(22,9,18)];
  /* Just the floater for this one — `spent` also holds a sick day in March, and the
     ledger prices everything it is given; the period windows come later, in sumRange. */
  const floatOnly = { ...spent, daysOff: [spent.daysOff[0]] };
  const led = E.buildLedger(wk, floatOnly);
  const tot = led.parts.reduce((t, p) => ({ h: t.h + p.hours, ot: t.ot + p.otHours, g: t.g + p.gross }),
                               { h: 0, ot: 0, g: 0 });
  near('45 h worked plus an 8 h floater = 53 h', tot.h, 53);
  const noFloat = E.buildLedger(wk, { ...spent, daysOff: [] });
  near('the March sick day is priced too, just outside this week',
       E.buildLedger(wk, spent).parts.reduce((s, p) => s + p.hours, 0), 61);
  near('without it, 45 h gives 5 h of overtime',
       noFloat.parts.reduce((s, p) => s + p.otHours, 0), 5);
  // The floater sits at midnight opening Monday: 9 h banked, +8 = 17, so the line is
  // reached 8 h sooner and overtime rises by 8.
  near('with it, 13 h of overtime', tot.ot, 13);
  const fp = led.parts.filter(p => p.sessionId === '__off:a');
  near('the floater itself is straight time', fp.reduce((s, p) => s + p.otHours, 0), 0);
  near('worth 8 x $38 = $304.00',             fp.reduce((s, p) => s + p.gross, 0), 304);

  // A sick day is paid but never moves the overtime line.
  const sickWeek = { ...cfg3, daysOff: [{ id: 's', bank: 'sick', slot: null, date: '2026-01-19' }] };
  const sl = E.buildLedger(wk, sickWeek);
  near('a sick day pays its 8 h', sl.parts.filter(p => p.sessionId === '__off:s')
       .reduce((s, p) => s + p.gross, 0), 304);
  near('but overtime stays where it was', sl.parts.reduce((s, p) => s + p.otHours, 0), 5);
  near('53 h all the same', sl.parts.reduce((s, p) => s + p.hours, 0), 53);

  // The outlook the app lists.
  const look = E.daysOffOutlook(spent, 2026);
  ok('both spent days are listed', look.length === 2, look.length);
  ok('earliest first', look[0].key === '2026-01-19');
  ok('named', look[0].name === 'MLK Day' && look[1].name === 'Sick day');
  ok('priced', Math.abs(look[0].pay - 304) < 1e-6);
  ok('and flagged for overtime correctly', look[0].ot === true && look[1].ot === false);

  // Robustness.
  ok('an unknown bank is skipped', E.bankCredits({ banks: B, daysOff: [{ id: 'x', bank: 'nope', date: '2026-01-01' }] }).length === 0);
  ok('a broken date is skipped',   E.bankCredits({ banks: B, daysOff: [{ id: 'x', bank: 'sick', date: 'not-a-date' }] }).length === 0);
  ok('zero hours credits nothing', E.bankCredits({ banks: [{ id: 'z', name: 'Z', count: 1, hours: 0 }],
                                                   daysOff: [{ id: 'x', bank: 'z', date: '2026-01-01' }] }).length === 0);
  ok('the calculator opts out entirely',
     E.bankCredits({ ...spent, holidayCredit: false }).length === 0);
  ok('spending more than the allowance cannot push the balance below zero',
     E.bankLeft({ ...cfg3, daysOff: [1,2,3,4,5,6].map(i => ({ id: 'f' + i, bank: 'float', slot: i - 1, date: '2026-0' + i + '-01' })) },
                'float', 2026) === 0);

  // A floater and a paid holiday on the same day are two separate entries, not one.
  const both = { ...spent, daysOff: [{ id: 'x', bank: 'float', slot: 0, date: '2026-12-25' }] };
  const dec = E.buildLedger([{ id: 'w1', start: +new Date(2026, 11, 24, 9), end: +new Date(2026, 11, 24, 17) },
                             { id: 'w2', start: +new Date(2026, 11, 27, 9), end: +new Date(2026, 11, 27, 17) }], both);
  ok('Christmas pays as a holiday', dec.parts.some(p => p.sessionId === '__hol:2026-12-25'));
  ok('and the floater pays as well', dec.parts.some(p => p.sessionId === '__off:x'));
  near('16 h worked + 8 h holiday + 8 h floater = 32 h',
       dec.parts.reduce((s, p) => s + p.hours, 0), 32);
}


/* ---------------- completed pay periods ---------------- */
{
  // Anchor Sun Jul 26 2026, 14-day periods, payday 13 days after the last day.
  const hcfg = { ...E.DEFAULTS, rate: 38, periodAnchor: '2026-07-26', periodLengthDays: 14,
                 payDateOffsetDays: 13, holidays: [], banks: [], daysOff: [] };
  const day = (mo, d, from, to) => ({ id: `s${mo}-${d}`, start: +new Date(2026, mo - 1, d, from),
                                                          end: +new Date(2026, mo - 1, d, to) });
  // Period 0: Jul 26 – Aug 8. Period 1: Aug 9 – Aug 22. Period 2: Aug 23 – Sep 5.
  const work = [
    day(7, 27, 9, 17), day(7, 28, 9, 17),               // 16 h in period 0
    day(8, 10, 9, 17), day(8, 11, 9, 17), day(8, 12, 9, 17),   // 24 h in period 1
    day(8, 24, 9, 17)                                    // 8 h in period 2
  ];
  const led = E.buildLedger(work, hcfg);
  // Standing in period 2, so periods 0 and 1 are complete.
  const now = +new Date(2026, 7, 25, 12);
  const hist = E.periodHistory(led.parts, hcfg, now, 24);

  ok('two completed periods', hist.length === 2, hist.length);
  ok('newest first', hist[0].index > hist[1].index, `${hist[0].index}, ${hist[1].index}`);
  ok('the period you are standing in is not listed',
     !hist.some(h => h.startMs <= now && h.endMs > now));

  const p1 = hist[0], p0 = hist[1];
  ok('the newer one is Aug 9 – Aug 22',
     p1.start.getDate() === 9 && p1.lastDay.getDate() === 22, `${p1.start} ${p1.lastDay}`);
  near('with 24 h', p1.hours, 24);
  near('and $912.00', p1.gross, 912);
  ok('payday Fri Sep 4', p1.payDate.getMonth() === 8 && p1.payDate.getDate() === 4);
  ok('not paid yet on Aug 25', p1.paid === false);

  ok('the older one is Jul 26 – Aug 8',
     p0.start.getDate() === 26 && p0.lastDay.getDate() === 8);
  near('with 16 h', p0.hours, 16);
  near('and $608.00', p0.gross, 608);
  ok('payday Fri Aug 21', p0.payDate.getMonth() === 7 && p0.payDate.getDate() === 21);
  ok('and it has been paid', p0.paid === true);

  // A period with nothing in it is skipped rather than listed as zeroes.
  const gap = [day(7, 27, 9, 17), day(8, 24, 9, 17)];    // nothing at all in period 1
  const gh = E.periodHistory(E.buildLedger(gap, hcfg).parts, hcfg, now, 24);
  ok('an empty period is left out', gh.length === 1 && gh[0].index === 0, gh.map(h => h.index));

  // Overtime is reported per period, and the premium banked before it is carried
  // so a past period's tax break is worked out on the room left at the time.
  const heavy = [];
  for (let d = 26; d <= 31; d++) heavy.push(day(7, d, 8, 20));   // 6 x 12 h in period 0
  const hl = E.buildLedger(heavy, hcfg);
  const hh = E.periodHistory(hl.parts, hcfg, now, 24);
  near('72 h in that period', hh[hh.length - 1].hours, 72);
  ok('with overtime recorded', hh[hh.length - 1].otHours > 0, hh[hh.length - 1].otHours);
  near('and nothing banked before it in the year', hh[hh.length - 1].otHoursBefore, 0);

  const twoBusy = heavy.concat([day(8, 10, 8, 20), day(8, 11, 8, 20), day(8, 12, 8, 20),
                                day(8, 13, 8, 20)]);            // 48 h in period 1
  const tb = E.periodHistory(E.buildLedger(twoBusy, hcfg).parts, hcfg, now, 24);
  ok('the later period knows what came before it', tb[0].otHoursBefore > 0, tb[0].otHoursBefore);
  near('and it is period 0\'s overtime', tb[0].otHoursBefore, tb[1].otHours);

  // Limits and edges.
  ok('the limit is respected', E.periodHistory(led.parts, hcfg, now, 1).length === 1);
  ok('no parts means no history', E.periodHistory([], hcfg, now, 24).length === 0);
  ok('standing in the first period there is nothing behind you',
     E.periodHistory(E.buildLedger([day(7, 27, 9, 17)], hcfg).parts, hcfg,
                     +new Date(2026, 6, 30, 12), 24).length === 0);
  // Holiday and booked days count toward a completed period the same as worked hours.
  /* A floater is an added allowance rather than a shipped one, so the bank is built here
     — the behaviour under test is that a BOOKED day counts, not where the bank came from. */
  const withHol = { ...hcfg, holidays: E.HOLIDAY_DEFAULTS(),
                    workDays: [true,true,true,true,true,false,false],
                    banks: [{ id: 'float', name: 'Floating holiday', count: 3, hours: 8,
                              ot: true, makeUp: false, slots: ['MLK Day','Birthday','Anniversary'] }]
                           .concat(E.BANK_DEFAULTS()),
                    daysOff: [{ id: 'f', bank: 'float', slot: 0, date: '2026-08-11' }] };
  const wh = E.periodHistory(E.buildLedger(work, withHol).parts, withHol, now, 24);
  near('a booked floater lands in its period', wh[0].hours, 32);
  near('and is paid in its total', wh[0].gross, 1216);
}


/* ---------------- the decimal time card ---------------- */
{
  // Curtis's real shape: scheduled 14:00–22:30, rostered Sun–Thu, half-hour unpaid lunch.
  const tcfg = { ...E.DEFAULTS, rate: 38, periodAnchor: '2026-07-26', periodLengthDays: 14,
                 schedStart: '14:00', schedEnd: '22:30', lunchMins: 30,
                 workDays: [true, true, true, true, true, false, false],
                 holidays: [], banks: [], daysOff: [] };
  const S = (id, mo, d, h1, m1, h2, m2) => ({ id, start: +new Date(2026, mo - 1, d, h1, m1),
                                                   end: +new Date(2026, mo - 1, d, h2, m2) });
  const from = +new Date(2026, 6, 26), to = +new Date(2026, 7, 9);

  // Sun Aug 2 is rostered: in at 12:33 (1h27 early), out at 23:03 (33 min late).
  const sun = S('sun', 8, 2, 12, 33, 23, 3);
  let r = E.timeCardRows([sun], tcfg, from, to)[0];
  ok('a rostered day is marked as such', r.rostered === true);
  near('1.45 h before the shift', r.before, 1.45);
  near('0.55 h after it',         r.after, 0.55);
  near('2.00 h to claim',         r.extra, 2.00);

  // Fri Aug 7 is NOT rostered: clocked 8:30 with a half-hour lunch = 8.00 paid, all of it.
  const fri = S('fri', 8, 7, 9, 0, 17, 30);
  r = E.timeCardRows([fri], tcfg, from, to)[0];
  ok('an unrostered day is marked', r.rostered === false);
  near('the whole paid day counts — 8.00', r.extra, 8.00);
  near('which is the paid hours, lunch already out', r.paid, 8.00);
  ok('and it is not split into before and after', r.before === 0 && r.after === 0);

  // Saturday behaves the same way.
  const sat = E.timeCardRows([S('sat', 8, 8, 9, 30, 18, 0)], tcfg, from, to)[0];
  near('Saturday is a clean 8.00 too', sat.extra, 8.00);
  ok('and is flagged unrostered', sat.rostered === false);

  // A rostered day worked exactly to schedule claims nothing.
  const onTime = E.timeCardRows([S('ot', 8, 3, 14, 0, 22, 30)], tcfg, from, to)[0];
  near('on-time day claims nothing', onTime.extra, 0);
  near('but its paid hours are still reported', onTime.paid, 8.00);

  // Only early.
  const early = E.timeCardRows([S('e', 8, 4, 12, 0, 22, 30)], tcfg, from, to)[0];
  near('two hours early', early.before, 2.00);
  near('nothing late',    early.after, 0);
  // Only late.
  const late = E.timeCardRows([S('l', 8, 5, 14, 0, 24, 1)], tcfg, from, to)[0];
  near('nothing early', late.before, 0);
  near('1.52 h late',   late.after, 1.52);

  // The whole period, the way it gets filled in.
  const week = [sun, S('mon', 8, 3, 14, 0, 24, 15), S('tue', 8, 4, 14, 0, 24, 1),
                S('wed', 8, 5, 12, 31, 24, 1), S('thu', 8, 6, 12, 32, 23, 55), fri, sat];
  const rows = E.timeCardRows(week, tcfg, from, to);
  ok('every day is listed', rows.length === 7, rows.length);
  ok('in date order', rows.every((x, i) => i === 0 || x.start >= rows[i - 1].start));
  ok('five rostered, two not', rows.filter(x => x.rostered).length === 5 &&
                               rows.filter(x => !x.rostered).length === 2);
  const t = E.timeCardTotals(rows);
  // rostered: Sun 1.45+0.55, Mon 0+1.75, Tue 0+1.52, Wed 1.48+1.52, Thu 1.47+1.42
  near('early time totals 4.40', t.before, 4.40);
  near('late time totals 6.76',  t.after, 6.76);
  near('unrostered days total 16.00', t.whole, 16.00);
  near('and the claim is 27.16', t.extra, 27.16);
  ok('the day count is right', t.days === 7);

  // Rounding is per entry, the way a slip adds them, not on the exact total.
  const two = [S('a', 8, 3, 13, 13, 22, 30), S('b', 8, 4, 13, 13, 22, 30)];   // 47 min early twice
  const tr = E.timeCardRows(two, tcfg, from, to);
  near('each 47-minute entry rounds to 0.78', tr[0].before, 0.78);
  near('and two of them make 1.56, not 1.57', E.timeCardTotals(tr).before, 1.56);

  // Windows and edges.
  ok('a shift outside the window is left out',
     E.timeCardRows([S('x', 9, 1, 14, 0, 22, 0)], tcfg, from, to).length === 0);
  ok('a zero-length shift is ignored',
     E.timeCardRows([S('z', 8, 3, 14, 0, 14, 0)], tcfg, from, to).length === 0);
  ok('with no schedule set, a rostered day claims nothing rather than guessing',
     E.timeCardRows([sun], { ...tcfg, schedStart: '', schedEnd: '' }, from, to)[0].extra === 0);
  ok('but an unrostered day still claims its whole paid day',
     E.timeCardRows([fri], { ...tcfg, schedStart: '', schedEnd: '' }, from, to)[0].extra === 8);
  ok('with every day rostered, nothing is a whole-day claim',
     E.timeCardTotals(E.timeCardRows(week, { ...tcfg, workDays: [1,1,1,1,1,1,1].map(Boolean) },
                                     from, to)).whole === 0);
}


/* ---------------- overtime counted per shift, not per calendar day ---------------- */
{
  /* The distinction that matters to anyone on nights: a shift running 2 PM to 12:30 AM is
     one shift, and the eight-hour allowance should not start again at midnight. */
  const scfg = { ...E.DEFAULTS, rate: 38, otMode: 'shift', shiftThreshold: 8,
                 periodAnchor: '2026-08-09', lunchMins: 0,
                 holidays: [], banks: [], daysOff: [],
                 workDays: [true, true, true, true, true, false, false] };
  const dcfg = { ...scfg, otMode: 'daily', dailyThreshold: 8 };
  const at = (d, h, mi = 0) => +new Date(2026, 7, d, h, mi);
  const tot = (sessions, c) => {
    const l = E.buildLedger(sessions, c);
    return l.parts.reduce((a, p) => ({ h: a.h + p.hours, ot: a.ot + p.otHours, g: a.g + p.gross }),
                          { h: 0, ot: 0, g: 0 });
  };

  // 2:00 PM – 12:30 AM = 10.5 h. Per shift: 8 straight, 2.5 over.
  const night = [{ id: 'n', start: at(11, 14), end: at(12, 0, 30) }];
  near('a shift crossing midnight is 10.5 h', tot(night, scfg).h, 10.5);
  near('per shift: 2.5 h of overtime',        tot(night, scfg).ot, 2.5);
  near('paid 8x38 + 2.5x57 = $446.50',        tot(night, scfg).g, 8 * 38 + 2.5 * 57);
  // The calendar rule gives less, because the last half hour starts a fresh allowance.
  near('the daily rule would say 2.0 h',      tot(night, dcfg).ot, 2.0);
  ok('so the shift rule is worth more here', tot(night, scfg).g > tot(night, dcfg).g,
     `${tot(night, scfg).g} vs ${tot(night, dcfg).g}`);

  // A longer one: 12:15 PM – 12:30 AM = 12.25 h -> 4.25 h over per shift, 3.75 daily.
  const longNight = [{ id: 'L', start: at(13, 12, 15), end: at(14, 0, 30) }];
  near('12.25 h shift gives 4.25 h per shift', tot(longNight, scfg).ot, 4.25);
  near('and 3.75 h by the calendar',           tot(longNight, dcfg).ot, 3.75);

  // Midnight genuinely does not reset it: a shift starting at 8 PM and running 12 h has
  // 4 h before midnight and 8 h after, and should still be 4 h over.
  const deep = [{ id: 'd', start: at(15, 20), end: at(16, 8) }];
  near('8 PM to 8 AM is 12 h', tot(deep, scfg).h, 12);
  near('per shift: 4 h over',  tot(deep, scfg).ot, 4);
  near('the daily rule finds none of it', tot(deep, dcfg).ot, 0);

  // A shift entirely inside one day behaves identically under both rules.
  const dayShift = [{ id: 'x', start: at(10, 9), end: at(10, 20) }];   // 11 h
  near('an 11 h day shift is 3 h over per shift', tot(dayShift, scfg).ot, 3);
  near('and 3 h over by the calendar too',        tot(dayShift, dcfg).ot, 3);

  // Each shift gets its own allowance — two short shifts in a day are not added together.
  const split = [{ id: 'a', start: at(17, 6), end: at(17, 12) },     // 6 h
                 { id: 'b', start: at(17, 18), end: at(18, 1) }];    // 7 h, crosses midnight
  near('13 h across two shifts', tot(split, scfg).h, 13);
  near('neither passes 8 h on its own, so no overtime', tot(split, scfg).ot, 0);
  // The same two under the calendar rule: 6 h + 6 h on the 17th is 12 h, so 4 h over.
  near('the calendar rule adds them and finds 4 h', tot(split, dcfg).ot, 4);

  // The threshold is its own setting, independent of the daily one.
  near('a 10 h per-shift threshold leaves 0.5 h over',
       tot(night, { ...scfg, shiftThreshold: 10 }).ot, 0.5);
  near('and changing the daily one does not touch it',
       tot(night, { ...scfg, dailyThreshold: 12 }).ot, 2.5);
  ok('the threshold reads back from the right field',
     E.otThresholdOf({ ...scfg, shiftThreshold: 9 }) === 9 &&
     E.otThresholdOf({ ...dcfg, dailyThreshold: 7 }) === 7);

  // An unpaid lunch comes out before the allowance is counted.
  near('with a half-hour lunch, 10.5 clocked is 10 paid',
       tot(night, { ...scfg, lunchMins: 30 }).h, 10);
  near('and 2 h over rather than 2.5',
       tot(night, { ...scfg, lunchMins: 30 }).ot, 2);

  // Crossing a pay-period boundary: the hours still belong to the periods they fall in,
  // but the shift's own overtime allowance runs straight through.
  // Period anchor Sun Aug 9, 14 days -> period ends midnight closing Sat Aug 22.
  const boundary = [{ id: 'bd', start: at(22, 20), end: at(23, 8) }];   // Sat 8 PM -> Sun 8 AM
  const bl = E.buildLedger(boundary, scfg);
  near('12 h in total', bl.parts.reduce((n, p) => n + p.hours, 0), 12);
  near('4 h of it over, counted across the boundary',
       bl.parts.reduce((n, p) => n + p.otHours, 0), 4);
  const p1 = E.periodInfo(at(22, 21), scfg), p2 = E.periodInfo(at(23, 1), scfg);
  ok('the two halves really are in different periods', p1.index !== p2.index,
     `${p1.index} vs ${p2.index}`);
  near('4 h land in the old period', E.sumRange(bl.parts, p1.startMs, p1.endMs).hours, 4);
  near('and 8 h in the new one',     E.sumRange(bl.parts, p2.startMs, p2.endMs).hours, 8);

  /* A shift belongs to both periods, and each has to be able to ask for just its own half.
     Without this the shift log summed the whole shift into whichever period was on screen
     while the period tile beside it summed only that period's share — two figures for the
     same fortnight, on the same screen. */
  const oldHalf = E.sumSessionRange(bl.parts, 'bd', p1.startMs, p1.endMs);
  const newHalf = E.sumSessionRange(bl.parts, 'bd', p2.startMs, p2.endMs);
  near('the old period\'s share is 4 h', oldHalf.hours, 4);
  near('the new period\'s share is 8 h', newHalf.hours, 8);
  ok('both know they are only part of a shift', oldHalf.clipped && newHalf.clipped);
  near('and the two halves add back to the whole', oldHalf.gross + newHalf.gross,
       bl.parts.reduce((n, p) => n + p.gross, 0));
  near('with the overtime landing in the half that earned it', newHalf.otHours, 4);
  near('and none of it in the other',                          oldHalf.otHours, 0);

  // A shift wholly inside one period is not marked as split.
  const inside = E.buildLedger([{ id: 'w', start: at(11, 14), end: at(12, 0, 30) }], scfg);
  const whole = E.sumSessionRange(inside.parts, 'w',
                                  E.periodInfo(at(11, 15), scfg).startMs,
                                  E.periodInfo(at(11, 15), scfg).endMs);
  ok('a shift inside one period is not clipped', whole.clipped === false);
  near('and reports all of its hours', whole.hours, 10.5);
}


/* ---------------- what you are paid in a month ---------------- */
{
  /* Curtis's real shape: 14-day periods anchored Sun Jul 26 2026, payday 13 days after
     the period ends.
       period 0  Jul 26 – Aug  8  -> paid Fri Aug 21   (August)
       period 1  Aug  9 – Aug 22  -> paid Fri Sep  4   (September)
       period 2  Aug 23 – Sep  5  -> paid Fri Sep 18   (September)
       period 3  Sep  6 – Sep 19  -> paid Fri Oct  2   (October)
     Two periods land in September, which is the case a naive calendar-month total gets
     wrong. */
  const mcfg = { ...E.DEFAULTS, rate: 38, periodAnchor: '2026-07-26', periodLengthDays: 14,
                 payDateOffsetDays: 13, lunchMins: 0, holidays: [], banks: [], daysOff: [] };
  const d = (mo, day, from, to) => ({ id: `${mo}-${day}`, start: +new Date(2026, mo - 1, day, from),
                                                          end: +new Date(2026, mo - 1, day, to) });
  const work = [
    d(7, 27, 9, 17), d(7, 28, 9, 17),                    // 16 h in period 0
    d(8, 10, 9, 17), d(8, 11, 9, 17),                    // 16 h in period 1
    d(8, 24, 9, 17)                                      // 8 h in period 2
  ];
  const parts = E.buildLedger(work, mcfg).parts;
  const now = +new Date(2026, 7, 25, 12);                // Tue Aug 25, inside period 2
  const months = E.payMonths(parts, mcfg, now, 0);

  ok('two pay months so far', months.length === 2, months.map(m => m.ym));
  ok('newest first', months[0].ym === '2026-09' && months[1].ym === '2026-08',
     months.map(m => m.ym));

  const aug = months.find(m => m.ym === '2026-08');
  const sep = months.find(m => m.ym === '2026-09');

  // August's money is period 0 only — worked mostly in July, paid Aug 21.
  near('August is paid 16 h', aug.hours, 16);
  near('worth $608.00',       aug.gross, 608);
  ok('from one period',       aug.periods.length === 1, aug.periods.length);
  ok('which was worked in July', aug.periods[0].start.getMonth() === 6);
  ok('August is not the live month', aug.live === false);

  // September gets BOTH periods that pay in it.
  ok('September collects two periods', sep.periods.length === 2, sep.periods.length);
  near('24 h between them', sep.hours, 24);
  near('worth $912.00',     sep.gross, 912);
  ok('and it is the live one', sep.live === true);

  ok('currentPayMonth points at September',
     E.currentPayMonth(parts, mcfg, now).ym === '2026-09');

  // Paid vs still owed.
  ok('August has been paid by Aug 25', aug.allPaid === true);
  ok('September has not', sep.allPaid === false);
  const early = E.payMonths(parts, mcfg, +new Date(2026, 7, 12, 12), 0);
  ok('and on Aug 12, August is not paid yet',
     early.find(m => m.ym === '2026-08').allPaid === false);

  // A month total is NOT the calendar month of the work.
  const augWork = E.sumRange(parts, +new Date(2026, 7, 1), +new Date(2026, 8, 1));
  near('work actually done in August is 24 h', augWork.hours, 24);
  ok('which is not what August pays', Math.abs(augWork.hours - aug.hours) > 0.001,
     `${augWork.hours} worked vs ${aug.hours} paid`);

  // The live month exists even before any hours are in it.
  const fresh = E.payMonths(E.buildLedger([], mcfg).parts, mcfg, now, 0);
  ok('an empty ledger still names the month being earned', fresh.length === 1 && fresh[0].live,
     JSON.stringify(fresh.map(m => m.ym)));
  near('at zero', fresh[0].gross, 0);

  // Overtime is carried through.
  const heavy = [];
  for (let x = 26; x <= 31; x++) heavy.push(d(7, x, 8, 20));    // 6 x 12 h in period 0
  const hm = E.payMonths(E.buildLedger(heavy, mcfg).parts, mcfg, now, 0);
  const hAug = hm.find(m => m.ym === '2026-08');
  near('72 h paid in August', hAug.hours, 72);
  ok('with overtime counted', hAug.otHours > 0, hAug.otHours);
  near('and priced with it', hAug.gross, 40 * 38 + 32 * 57);

  // Holidays and booked days land in the month their period pays in.
  const withOff = { ...mcfg,
                    banks: [{ id: 'float', name: 'Floating holiday', count: 3, hours: 8,
                              ot: true, makeUp: false, slots: [] }].concat(E.BANK_DEFAULTS()),
                    daysOff: [{ id: 'f', bank: 'float', slot: 0, date: '2026-08-12' }] };
  const om = E.payMonths(E.buildLedger(work, withOff).parts, withOff, now, 0);
  near('a floater on Aug 12 pays in September', om.find(m => m.ym === '2026-09').hours, 32);
  near('and August is unchanged', om.find(m => m.ym === '2026-08').hours, 16);

  // Limits and edges.
  ok('the limit is respected', E.payMonths(parts, mcfg, now, 1).length === 1);
  ok('an empty month with no live flag is dropped',
     E.payMonths(parts, mcfg, now, 0).every(m => m.gross > 0 || m.live));
  ok('the months add back to the ledger',
     Math.abs(months.reduce((s, m) => s + m.gross, 0)
              - parts.reduce((s, p) => s + p.gross, 0)) < 1e-6);
}


/* ---------------- how close to overtime, under every rule ---------------- */
{
  /* Days, weeks and periods can be named from an instant alone. A shift cannot — two
     shifts can cover the same time of day — so the per-shift rule has to be told which
     shift, or find it. Getting this wrong reads the bucket "sundefined", which is always
     zero, so the overtime bar sits at nothing all shift and never warns. */
  const mk = m => ({ ...E.DEFAULTS, rate: 38, otMode: m, weeklyThreshold: 40,
                     periodThreshold: 80, dailyThreshold: 8, shiftThreshold: 8,
                     periodAnchor: '2026-08-09', lunchMins: 0,
                     holidays: [], banks: [], daysOff: [] });
  const start = +new Date(2026, 7, 10, 12, 15), now = +new Date(2026, 7, 10, 16, 25);
  const live = [{ id: '__active', start: start, end: now }];

  ['weekly', 'daily', 'shift'].forEach(mode => {
    const c = mk(mode), led = E.buildLedger(live, c);
    near(`${mode}: named shift reports the hours banked`,
         E.bucketHoursAt(led, now, c, '__active'), 25 / 6);
    near(`${mode}: and finds them without being told`,
         E.bucketHoursAt(led, now, c), 25 / 6);
  });

  // A wrong or unknown id must not silently read as zero-but-plausible; it reads zero,
  // which is why the caller has to pass the id it actually used.
  const sc = mk('shift'), sled = E.buildLedger(live, sc);
  near('an unknown shift id banks nothing', E.bucketHoursAt(sled, now, sc, '__nope'), 0);

  // Two shifts in one day: each has its own allowance, and the bar must follow the one
  // being worked rather than adding them.
  const two = [{ id: 'a', start: +new Date(2026, 7, 10, 6), end: +new Date(2026, 7, 10, 12) },
               { id: 'b', start: +new Date(2026, 7, 10, 18), end: +new Date(2026, 7, 10, 23) }];
  const tled = E.buildLedger(two, sc);
  near('the morning shift banks 6 h', E.bucketHoursAt(tled, +new Date(2026, 7, 10, 11), sc), 6);
  near('the evening one banks 5 h',   E.bucketHoursAt(tled, +new Date(2026, 7, 10, 22), sc), 5);
  const dled = E.buildLedger(two, mk('daily'));
  near('while the daily rule adds both to 11 h',
       E.bucketHoursAt(dled, +new Date(2026, 7, 10, 22), mk('daily')), 11);

  // Between shifts nothing is banked toward the next one.
  near('an hour with no shift on it banks nothing',
       E.bucketHoursAt(tled, +new Date(2026, 7, 10, 15), sc), 0);

  /* Across midnight the shift keeps its bucket, which is the whole point of the rule.
     Note what this function means: it is the bucket's total, not the hours up to `t`. That
     reads as "so far" in the app only because the ledger there is built up to now — the
     same is true of the weekly and daily rules. Here the shift is already complete, so all
     10.75 h of it are in the bucket at any instant inside it. */
  const night = [{ id: 'n', start: +new Date(2026, 7, 11, 14), end: +new Date(2026, 7, 12, 0, 45) }];
  const nled = E.buildLedger(night, sc);
  near('the shift banks all 10.75 h of itself',
       E.bucketHoursAt(nled, +new Date(2026, 7, 11, 23), sc), 10.75);
  near('and midnight does not divide it',
       E.bucketHoursAt(nled, +new Date(2026, 7, 12, 0, 30), sc), 10.75);
  const nd = mk('daily'), ndl = E.buildLedger(night, nd);
  near('where the daily rule starts the new day at 0.75 h',
       E.bucketHoursAt(ndl, +new Date(2026, 7, 12, 0, 30), nd), 0.75);
  near('and gives the evening 10 h of its own',
       E.bucketHoursAt(ndl, +new Date(2026, 7, 11, 23), nd), 10);

  // Hours-so-far, the way the app actually asks it: a ledger built up to the moment.
  const sofar = E.buildLedger([{ id: 'n', start: +new Date(2026, 7, 11, 14),
                                 end: +new Date(2026, 7, 11, 23) }], sc);
  near('a shift nine hours in reads nine hours',
       E.bucketHoursAt(sofar, +new Date(2026, 7, 11, 23), sc, 'n'), 9);
}


/* ---------------- which day a shift belongs to ---------------- */
{
  const c = { ...E.DEFAULTS, rate: 38, schedStart: '14:00', schedEnd: '22:30', lunchMins: 30,
              workDays: [true, true, true, true, true, false, false],
              holidays: [], banks: [], daysOff: [], periodAnchor: '2026-08-09' };
  // Sun Aug 16 2026 through Mon Aug 17.
  const on = (d, h, mi = 0) => +new Date(2026, 7, d, h, mi);
  const sh = (d1, h1, m1, d2, h2, m2) => ({ id: 'x', start: on(d1, h1, m1), end: on(d2, h2, m2) });
  const dayOf = (s, cfg = c) => {
    const d = new Date(E.shiftDayMs(s, cfg));
    return E.dkey(d.getFullYear(), d.getMonth(), d.getDate());
  };

  ok('a shift inside one day is that day',       dayOf(sh(16, 9, 0, 16, 17, 0)) === '2026-08-16');
  ok('6 PM to 2 AM is the evening it started',   dayOf(sh(16, 18, 0, 17, 2, 0)) === '2026-08-16');
  ok('10 PM to 6 AM is the next day',            dayOf(sh(16, 22, 0, 17, 6, 0)) === '2026-08-17');
  ok("Curtis's 2 PM to 10:30 PM is that day",    dayOf(sh(16, 14, 0, 16, 22, 30)) === '2026-08-16');
  ok("and his 12:15 PM to 12:45 AM too",         dayOf(sh(16, 12, 15, 17, 0, 45)) === '2026-08-16');
  ok('a shift ending exactly at midnight is the day it worked',
     dayOf(sh(16, 16, 0, 17, 0, 0)) === '2026-08-16');
  ok('an exact 50/50 split keeps the day it started',
     dayOf(sh(16, 20, 0, 17, 4, 0)) === '2026-08-16');
  ok('a minute past half tips it over',
     dayOf(sh(16, 20, 0, 17, 4, 1)) === '2026-08-17');
  ok('a shift spanning three days takes the fullest',
     dayOf({ id: 'l', start: on(16, 22, 0), end: on(18, 2, 0) }) === '2026-08-17');

  // Overrides, for employers who name shifts their own way.
  const byStart = { ...c, shiftDayRule: 'start' }, byEnd = { ...c, shiftDayRule: 'end' };
  ok('forced to the start day', dayOf(sh(16, 22, 0, 17, 6, 0), byStart) === '2026-08-16');
  ok('forced to the end day',   dayOf(sh(16, 18, 0, 17, 2, 0), byEnd) === '2026-08-17');
  ok('and "end" still will not claim a day with no hours in it',
     dayOf(sh(16, 16, 0, 17, 0, 0), byEnd) === '2026-08-16');
  ok('a zero-length shift falls back to its start day',
     dayOf({ id: 'z', start: on(16, 9), end: on(16, 9) }) === '2026-08-16');

  /* The reason this matters, with a real night worker: rostered Mon-Fri, scheduled
     10 PM to 6 AM. Their Monday shift starts Sunday night. Judged by the date it begins on
     it lands on Sunday — not a rostered day — and the time card would claim the whole
     shift as extra time instead of nothing. */
  const night = { ...c, schedStart: '22:00', schedEnd: '06:00', lunchMins: 0,
                  workDays: [false, true, true, true, true, true, false] };   // Mon-Fri
  const mondayShift = { id: 'm', start: on(16, 22, 0), end: on(17, 6, 0) };   // Sun 22:00 -> Mon 06:00
  ok('it is Monday\'s shift', dayOf(mondayShift, night) === '2026-08-17');
  const row = E.timeCardRows([mondayShift], night, on(9, 0), on(23, 0))[0];
  ok('so it counts as rostered', row.rostered === true);
  near('and a shift worked exactly to schedule claims nothing', row.extra, 0);
  near('while still reporting its 8 paid hours', row.paid, 8);

  const rowStart = E.timeCardRows([mondayShift], { ...night, shiftDayRule: 'start' },
                                  on(9, 0), on(23, 0))[0];
  ok('named by the day it began, it reads as unrostered', rowStart.rostered === false);
  near('and the whole shift is wrongly claimed', rowStart.extra, 8);

  // Clocking in an hour early on that same shift is an hour to claim, not eight.
  const early = E.timeCardRows([{ id: 'e', start: on(16, 21, 0), end: on(17, 6, 0) }],
                               night, on(9, 0), on(23, 0))[0];
  near('an hour early is 1.00 to claim', early.before, 1);
  near('nothing late',                   early.after, 0);

  // A genuinely unrostered shift is still unrostered.
  const satDay = { id: 'd', start: on(15, 9, 0), end: on(15, 17, 30) };
  ok('a Saturday daytime shift is still not rostered',
     E.timeCardRows([satDay], c, on(9, 0), on(23, 0))[0].rostered === false);
  const satNight = { id: 's', start: on(15, 22, 0), end: on(16, 6, 0) };
  ok('and a Saturday night that is really Sunday is rostered for a Sun-Thu roster',
     E.timeCardRows([satNight], c, on(9, 0), on(23, 0))[0].rostered === true);
}


/* ---------------- slip figures read the punch as printed ---------------- */
{
  /* Curtis clocked in at 12:15-and-some-seconds against a 2 PM start. The screen said
     12:15 PM, so the slip says 1.75 — but measuring from the raw stamp gave 104 minutes
     and 1.73. A hundredth, every shift, on the figure that goes to payroll. */
  const c = { ...E.DEFAULTS, rate: 38, schedStart: '14:00', schedEnd: '22:30', lunchMins: 30,
              workDays: [true, true, true, true, true, false, false],
              holidays: [], banks: [], daysOff: [], periodAnchor: '2026-08-09' };
  const at = (h, mi, sec = 0) => +new Date(2026, 7, 9, h, mi, sec);
  const ex = (h, mi, sec) => E.extraTime(at(h, mi, sec), at(22, 30), 14 * 60, 22 * 60 + 30);

  near('a clean 12:15 is 1.75 h early', E.chartHours(ex(12, 15, 0).before), 1.75);
  near('12:15 and 40 seconds is still 1.75',  E.chartHours(ex(12, 15, 40).before), 1.75);
  near('12:15 and 59 seconds is still 1.75',  E.chartHours(ex(12, 15, 59).before), 1.75);
  near('12:16 on the nose drops to 1.73',     E.chartHours(ex(12, 16, 0).before), 1.73);
  near('and 12:16:59 is still 1.73',          E.chartHours(ex(12, 16, 59).before), 1.73);

  // The same at the other end of the shift.
  const late = (h, mi, sec) => E.extraTime(at(14, 0), at(h, mi, sec), 14 * 60, 22 * 60 + 30);
  near('out at 23:00 flat is 0.50 late',   E.chartHours(late(23, 0, 0).after), 0.50);
  near('23:00 and 50 seconds is still 0.50', E.chartHours(late(23, 0, 50).after), 0.50);
  near('23:01 is 0.52',                    E.chartHours(late(23, 1, 0).after), 0.52);

  ok('toMinute drops the seconds', E.toMinute(at(12, 15, 59)) === at(12, 15, 0));
  ok('and leaves a clean minute alone', E.toMinute(at(12, 15, 0)) === at(12, 15, 0));

  // The time card's own figures follow the same rule.
  const row = E.timeCardRows([{ id: 'r', start: at(12, 15, 40), end: at(22, 30, 20) }],
                             c, at(0, 0), at(23, 59))[0];
  near('the card reads 1.75 early', row.before, 1.75);
  near('nothing late',              row.after, 0);
  near('claiming 1.75',             row.extra, 1.75);
  near('and 9.75 h paid after the half-hour lunch', row.paid, 9.75);

  // A whole fortnight of punches with seconds on them must not drift.
  const week = [];
  for (let d = 9; d <= 13; d++)
    week.push({ id: 'd' + d, start: +new Date(2026, 7, d, 12, 15, 37),
                             end:   +new Date(2026, 7, d, 22, 30, 11) });
  const t = E.timeCardTotals(E.timeCardRows(week, c, +new Date(2026, 7, 8), +new Date(2026, 7, 15)));
  near('five days at 1.75 is 8.75, not 8.65', t.before, 8.75);
  near('with nothing late',                   t.after, 0);
  near('and 8.75 to claim',                   t.extra, 8.75);
}


/* ---------------- the shop clock runs behind the phone ---------------- */
{
  /* The machine at work prints the card, and it is a couple of minutes behind the phone.
     With the offset on, the app shows the machine's times — which lengthens the run-up to a
     scheduled start, and must leave hours and pay exactly where they were. */
  const base = { ...E.DEFAULTS, rate: 38, schedStart: '14:00', schedEnd: '22:30', lunchMins: 30,
                 workDays: [true, true, true, true, true, false, false],
                 holidays: [], banks: [], daysOff: [], periodAnchor: '2026-08-09' };
  const off   = { ...base, skewOn: false, skewMins: 2 };
  const ahead = { ...base, skewOn: true,  skewMins: 2 };    // phone 2 min ahead of the machine
  const behind= { ...base, skewOn: true,  skewMins: -2 };   // phone 2 min behind
  const at = (h, mi, sec = 0) => +new Date(2026, 7, 9, h, mi, sec);

  near('with it off the offset is zero even when minutes are set', E.skewMs(off), 0);
  near('two minutes is 120000 ms',            E.skewMs(ahead), 120000);
  near('and it counts backwards too',         E.skewMs(behind), -120000);
  near('a fractional setting is held to whole minutes',
       E.skewMs({ skewOn: true, skewMins: 2.4 }), 120000);
  near('the machine reads earlier than the phone', E.shopTime(at(12, 15), ahead), at(12, 13));
  near('and converting back lands where it started',
       E.phoneTime(E.shopTime(at(12, 15), ahead), ahead), at(12, 15));

  // The figure Curtis reads off the screen and writes on the slip.
  const exAt = (cfg, h, mi, sec = 0) => {
    const sh = E.shopSession({ id: 'x', start: at(h, mi, sec), end: at(22, 30) }, cfg);
    return E.chartHours(E.extraTime(sh.start, sh.end, 14 * 60, 22 * 60 + 30).before);
  };
  near('untouched, a 12:15 punch is 1.75 early', exAt(off, 12, 15), 1.75);
  near('on the shop clock it is 12:13, so 1.78', exAt(ahead, 12, 15), 1.78);
  near('and the seconds still do not show through', exAt(ahead, 12, 15, 40), 1.78);
  near('a phone running slow claims less, not more', exAt(behind, 12, 15), 1.72);

  /* The safety property, and the reason this is a lens and not an edit: shifting both ends
     of a shift cannot change how long it is. If this ever fails, the offset is stealing
     hours. */
  const week = [
    { id: 'a', start: at(9, 12, 15), end: at(9, 22, 30) },
    { id: 'b', start: +new Date(2026, 7, 10, 13, 58, 20), end: +new Date(2026, 7, 10, 23, 5) },
    { id: 'c', start: +new Date(2026, 7, 11, 14, 0), end: +new Date(2026, 7, 11, 22, 30) }
  ];
  const from = +new Date(2026, 7, 9), to = +new Date(2026, 7, 23);
  const paidOff    = E.timeCardRows(week, off,    from, to).map(r => r.paid);
  const paidAhead  = E.timeCardRows(week, ahead,  from, to).map(r => r.paid);
  const paidBehind = E.timeCardRows(week, behind, from, to).map(r => r.paid);
  ok('paid hours are identical with the offset on',  JSON.stringify(paidOff) === JSON.stringify(paidAhead),
     JSON.stringify(paidOff) + ' vs ' + JSON.stringify(paidAhead));
  ok('and identical in the other direction too',     JSON.stringify(paidOff) === JSON.stringify(paidBehind),
     JSON.stringify(paidOff) + ' vs ' + JSON.stringify(paidBehind));

  // Pay is built from the stored stamps and never sees the offset at all.
  const grossOf = cfg => E.sumRange(E.buildLedger(week, cfg).parts, from, to).gross;
  near('gross pay does not move', grossOf(ahead), grossOf(off));
  near('nor does it the other way', grossOf(behind), grossOf(off));

  // What does move is the claim, which is the point.
  const tcOff   = E.timeCardTotals(E.timeCardRows(week, off,   from, to));
  const tcAhead = E.timeCardTotals(E.timeCardRows(week, ahead, from, to));
  ok('the time to claim goes up when the machine runs behind', tcAhead.before > tcOff.before,
     tcOff.before + ' → ' + tcAhead.before);
  near('by two minutes a shift, three shifts — 0.10 h', E.chartHours(tcAhead.before - tcOff.before), 0.1);

  // A punch either side of midnight is filed by the machine's date.
  const nightCfg = { ...ahead, schedStart: '22:00', schedEnd: '06:00', shiftDayRule: 'majority' };
  const justAfter = { id: 'm', start: +new Date(2026, 7, 10, 0, 1, 0), end: +new Date(2026, 7, 10, 8, 0) };
  near('a 00:01 punch on a phone 2 min fast is 23:59 the day before',
       E.shopTime(justAfter.start, nightCfg), +new Date(2026, 7, 9, 23, 59));

  const plain = { id: 'p', start: at(14, 0), end: at(22, 30), adj: { noOt: true } };
  ok('with no offset the session is passed straight through', E.shopSession(plain, off) === plain);
  ok('and with one, its adjustments survive the shift',
     E.shopSession(plain, ahead).adj.noOt === true);
  near('while both ends move together',
       E.shopSession(plain, ahead).end - E.shopSession(plain, ahead).start, plain.end - plain.start);
}

/* ---------------- absences: time you were scheduled for and did not work ---------------- */
{
  /* Sun-Thu, 2 PM - 10:30 PM with a half-hour lunch: eight paid hours a scheduled day. */
  const c = { ...E.DEFAULTS, rate: 38, otMode: 'shift', shiftThreshold: 8, lunchMins: 30,
              schedStart: '14:00', schedEnd: '22:30',
              workDays: [true, true, true, true, true, false, false],
              holidays: [], banks: [], daysOff: [], periodAnchor: '2026-08-09' };
  const on = (d, h = 0, mi = 0) => +new Date(2026, 7, d, h, mi);
  const AFTER = on(15, 12);                       // the whole week is behind us

  near('a scheduled day is worth its paid hours', E.schedHoursOn(c, on(10)), 8);
  near('lunch comes out of it, so it is not 8.5', E.schedHoursOn(c, on(10)), 8);
  near('a day you are not rostered for is worth nothing', E.schedHoursOn(c, on(14)), 0);
  ok('and the day is only judged once it has ended',
     E.schedEndMs(c, on(10)) === on(10, 22, 30), String(new Date(E.schedEndMs(c, on(10)))));

  // Nothing missed: a full week is no hole at all.
  const full = [10, 11, 12, 13].map((d, i) => ({ id: 'f' + i, start: on(d, 14), end: on(d, 22, 30) }))
    .concat([{ id: 'f4', start: on(9, 14), end: on(9, 22, 30) }]);
  near('working every scheduled shift owes nothing',
       E.makeUpOwed(full, c, [], on(9), on(16), AFTER), 0);

  // A whole day missed with nothing recorded.
  const missed = full.filter(s => s.id !== 'f1');            // Tue Aug 11 gone
  near('a missed day is eight hours in the hole',
       E.makeUpOwed(missed, c, [], on(9), on(16), AFTER), 8);
  const gapRow = E.scheduleGaps(missed, c, [], on(9), on(16), AFTER).filter(g => g.short > 0)[0];
  ok('and it is flagged as unaccounted, so the app can ask rather than assume',
     gapRow.unaccounted === 8, String(gapRow.unaccounted));

  // Labelling it does not change the hole — it only stops the app asking.
  const abs = [{ id: 'a1', date: '2026-08-11', kind: 'fmla', hours: 8 }];
  near('labelling it FMLA leaves the hole exactly where it was',
       E.makeUpOwed(missed, c, abs, on(9), on(16), AFTER), 8);
  const labelled = E.scheduleGaps(missed, c, abs, on(9), on(16), AFTER).filter(g => g.short > 0)[0];
  near('but there is nothing left to ask about', labelled.unaccounted, 0);

  // Curtis's own example: half of Monday, all of Tuesday, back Wednesday.
  const partial = [
    { id: 'p0', start: on(9, 14), end: on(9, 22, 30) },       // Sun, full
    // Left after four paid hours. Short of five, so no lunch is deducted from it.
    { id: 'p1', start: on(10, 14), end: on(10, 18) },         // Mon, half a day
    { id: 'p3', start: on(12, 14), end: on(12, 22, 30) },     // Wed, back
    { id: 'p4', start: on(13, 14), end: on(13, 22, 30) }      // Thu
  ];
  near('half a Monday and all of Tuesday is twelve hours in the hole',
       E.makeUpOwed(partial, c, [], on(9), on(16), AFTER), 12);

  // A day off that earns overtime credit fills the schedule; one that does not, does not.
  const withFloat = { ...c,
    banks: [{ id: 'float', name: 'Floating holiday', count: 4, hours: 8, ot: true, slots: [] },
            { id: 'sick',  name: 'Sick day',        count: 5, hours: 8, ot: false, slots: [] }],
    daysOff: [{ id: 'd1', bank: 'float', slot: 0, date: '2026-08-11', hours: 8 }] };
  near('a floater counts toward overtime, so it leaves no hole',
       E.makeUpOwed(missed, withFloat, [], on(9), on(16), AFTER), 0);
  const withSick = { ...withFloat,
    daysOff: [{ id: 'd1', bank: 'sick', slot: 0, date: '2026-08-11', hours: 8 }] };
  near('a sick day earns no overtime credit, so it does',
       E.makeUpOwed(missed, withSick, [], on(9), on(16), AFTER), 8);
  const sickGap = E.scheduleGaps(missed, withSick, [], on(9), on(16), AFTER).filter(g => g.short > 0)[0];
  near('though the app has nothing to ask about — the day is accounted for', sickGap.unaccounted, 0);

  // A day that has not finished yet is not a day you missed.
  near('mid-shift on a scheduled day owes nothing yet',
       E.makeUpOwed(full, c, [], on(9), on(16), on(13, 18)), 0);
  ok('and a day still to come is not even listed',
     E.scheduleGaps(full, c, [], on(9), on(16), on(11, 12)).every(g => g.dayMs <= on(10)),
     JSON.stringify(E.scheduleGaps(full, c, [], on(9), on(16), on(11, 12)).map(g => g.dayMs)));

  // Hours worked are attributed to the day the shift belongs to.
  near('a night shift counts once, against its own day',
       E.workedPaidOn([{ id: 'n', start: on(10, 22), end: on(11, 6) }],
                      { ...c, schedStart: '22:00', schedEnd: '06:00' }, on(11)), 7.5);
  near('an unscheduled Saturday is pure surplus, owing nothing',
       E.makeUpOwed(full.concat([{ id: 'sat', start: on(15, 8), end: on(15, 16, 30) }]),
                    c, [], on(9), on(16), AFTER), 0);

  ok('every absence kind has a name', E.ABSENCE_KINDS().every(k => k.id && k.name));
  ok('FMLA is one of them', E.absenceKindName('fmla') === 'FMLA', E.absenceKindName('fmla'));
  ok('and an unknown kind still reads as something',
     E.absenceKindName('zzz') === 'Absence', E.absenceKindName('zzz'));
  near('absence hours are totalled per date', E.absenceHoursOn(
       [{ date: '2026-08-11', hours: 4 }, { date: '2026-08-11', hours: 2 },
        { date: '2026-08-12', hours: 8 }], on(11)), 6);
}

/* ---------------- the make-up rule: work the hole off before overtime ---------------- */
{
  /* Sun-Thu, 2 PM - 10:30 PM, half-hour lunch, per-shift overtime after 8 paid hours.
     Pay period starts Sun Aug 9. */
  const c = { ...E.DEFAULTS, rate: 38, otMultiplier: 1.5, otMode: 'shift', shiftThreshold: 8,
              dailyThreshold: 8, lunchMins: 30, schedStart: '14:00', schedEnd: '22:30',
              workDays: [true, true, true, true, true, false, false],
              holidays: [], banks: [], daysOff: [], periodAnchor: '2026-08-09',
              periodLengthDays: 14, makeUpOn: true, makeUpWindow: 'period' };
  const off = { ...c, makeUpOn: false };
  const on = (d, h = 0, mi = 0) => +new Date(2026, 7, d, h, mi);
  const P0 = on(9), P1 = on(23);
  // A shift of n paid hours starting at 2 PM. Over five hours it carries the unpaid lunch.
  const shift = (d, paid) => ({ id: 'd' + d, start: on(d, 14),
                                end: on(d, 14) + (paid + (paid > 5 ? 0.5 : 0)) * 3600000 });
  const sum = (ss, cfg, now) => E.sumRange(E.buildLedger(ss, cfg, now).parts, P0, P1);

  /* Curtis's own case. Monday ten hours, Wednesday called off, Thursday however long.
     Sunday is worked to schedule so it neither helps nor hurts. */
  const week = x => [shift(9, 8), shift(10, 10), shift(11, 8), shift(13, x)];
  const AFTER = on(14, 12);

  near('a ten-hour Monday on its own is two hours of overtime',
       sum([shift(9, 8), shift(10, 10)], c, on(11, 12)).otHours, 2);

  let t = sum(week(8), c, AFTER);
  near('call off Wednesday and Monday\'s overtime is gone', t.otHours, 0);
  near('the hours worked are untouched', t.hours, 34);
  near('and all of it is paid straight', t.gross, 34 * 38);

  near('working thirteen on Thursday is still not enough', sum(week(13), c, AFTER).otHours, 0);
  near('fourteen gets you exactly square',                 sum(week(14), c, AFTER).otHours, 0);
  near('and the fifteenth hour is the first that pays overtime',
       sum(week(15), c, AFTER).otHours, 1);
  near('sixteen gives two',                                sum(week(16), c, AFTER).otHours, 2);

  // The balance is what drives it, and it reads the way you would say it out loud.
  near('after Monday you are two hours up',
       E.makeUpBalance([shift(9, 8), shift(10, 10)], c, P0, P1, on(11, 12)), 2);
  /* Read on Thursday, before Thursday's shift has ended — so Wednesday is the only day
     missing. Reading it on Friday would count Thursday as missed too. */
  const THU = on(13, 12);
  near('after calling off Wednesday you are six down',
       E.makeUpBalance([shift(9, 8), shift(10, 10), shift(11, 8)], c, P0, P1, THU), -6);
  near('so the app says six hours to work off',
       E.makeUpOwed([shift(9, 8), shift(10, 10), shift(11, 8)], c, [], P0, P1, THU), 6);
  near('and a fourteen-hour Thursday clears it',
       E.makeUpBalance(week(14), c, P0, P1, AFTER), 0);

  /* Without the rule, the same week pays the daily overtime it always did — which is the
     under-reporting the rule exists to correct, seen from the other side. */
  near('with the rule off, Monday keeps its two hours', sum(week(8), off, AFTER).otHours, 2);
  near('and the week is worth $76 more', sum(week(8), off, AFTER).gross - sum(week(8), c, AFTER).gross,
       2 * 38 * 0.5);

  // What survives is the most recent overtime, not the earliest.
  const settled = E.buildLedger(week(15), c, AFTER).parts.filter(p => p.otHours > 0.0001);
  ok('the overtime that survives is Thursday\'s, not Monday\'s',
     settled.every(p => +new Date(p.start).getDate() === 13 || +new Date(p.start).getDate() === 14),
     JSON.stringify(settled.map(p => new Date(p.start).toDateString())));

  // Today is not held against you while you are still working it.
  near('mid-shift on a scheduled day owes nothing',
       E.makeUpOwed([shift(9, 8), shift(10, 8)], c, [], P0, P1, on(11, 18)), 0);

  // An unscheduled day is pure balance even though it never passes a daily threshold.
  const satWeek = [shift(9, 8), shift(10, 8), shift(12, 8), shift(13, 8),
                   { id: 'sat', start: on(15, 8), end: on(15, 16, 30) }];
  near('a missed Tuesday made up on Saturday leaves you square',
       E.makeUpBalance(satWeek, c, P0, P1, on(16, 12)), 0);
  // Sunday the 16th is rostered too, so it has to be worked for the next week to start clean.
  near('so a later ten-hour day pays its overtime in full',
       sum(satWeek.concat([shift(16, 8), shift(17, 10)]), c, on(18, 12)).otHours, 2);

  // Paid time off behaves the way its overtime flag says it does.
  const withBanks = { ...c,
    banks: [{ id: 'float', name: 'Floating holiday', count: 4, hours: 8, ot: true, slots: [] },
            { id: 'sick',  name: 'Sick day',        count: 5, hours: 8, ot: false, slots: [] }] };
  const gone = [shift(9, 8), shift(10, 10), shift(13, 8)];        // Tue and Wed missing
  const floated = { ...withBanks,
    daysOff: [{ id: 'f1', bank: 'float', slot: 0, date: '2026-08-11', hours: 8 },
              { id: 'f2', bank: 'float', slot: 1, date: '2026-08-12', hours: 8 }] };
  near('two floaters fill the schedule, so Monday keeps its overtime',
       sum(gone, floated, AFTER).otHours, 2);
  const sicked = { ...withBanks,
    daysOff: [{ id: 's1', bank: 'sick', slot: 0, date: '2026-08-11', hours: 8 },
              { id: 's2', bank: 'sick', slot: 0, date: '2026-08-12', hours: 8 }] };
  near('two sick days do not, so it does not', sum(gone, sicked, AFTER).otHours, 0);

  // Only the two rules that need it.
  ['weekly', 'period'].forEach(function(mode){
    const m = { ...c, otMode: mode, weeklyThreshold: 40, periodThreshold: 80 };
    ok('under the ' + mode + ' rule the hole is already inherent, so nothing is settled twice',
       JSON.stringify(sum(week(8), m, AFTER)) === JSON.stringify(sum(week(8), { ...m, makeUpOn: false }, AFTER)),
       JSON.stringify(sum(week(8), m, AFTER)));
  });

  // The window is a setting.
  const wk = { ...c, makeUpWindow: 'week', weekStartDay: 0 };
  near('on a weekly window, last week\'s hole does not follow you into this one',
       sum(week(8).concat([shift(16, 10)]), wk, on(17, 12)).otHours, 2);
  near('on a pay-period window it does',
       sum(week(8).concat([shift(16, 10)]), c, on(17, 12)).otHours, 0);
}

/* ---------------- holidays, allowances and vacation, as the contract reads ------------- */
{
  const c = { ...E.DEFAULTS, rate: 38, otMultiplier: 1.5, otMode: 'shift', shiftThreshold: 8,
              lunchMins: 30, schedStart: '14:00', schedEnd: '22:30',
              workDays: [true, true, true, true, true, false, false],
              periodAnchor: '2026-08-09', periodLengthDays: 14 };
  const on = (d, h = 0) => +new Date(2026, 7, d, h);

  // The six pay flat and earn no overtime credit.
  ok('all six holidays are off the overtime clock',
     E.HOLIDAY_DEFAULTS().every(h => h.ot === false),
     JSON.stringify(E.HOLIDAY_DEFAULTS().map(h => h.ot)));
  ok('and none of them has to be made up',
     E.HOLIDAY_DEFAULTS().every(h => E.bankOwes({ ot: h.ot, makeUp: h.makeUp }) === false));

  /* What actually ships: nothing. See the BANK_DEFAULTS block above for why. */
  const B = E.BANK_DEFAULTS();
  ok('no banks ship', B.length === 0, B.map(b => b.id).join(','));
  ok('a sick day earns no overtime credit and is owed back',
     E.bankOwes({ ot: false, makeUp: true }) === true);
  ok('a VRD earns none but is owed nothing',
     E.bankOwes({ ot: false, makeUp: false }) === false);
  ok('an allowance saved before the two were told apart keeps its old meaning',
     E.bankOwes({ ot: false }) === true && E.bankOwes({ ot: true }) === false);

  /* Working a holiday: the flat eight is paid on top, and only the hours you actually
     worked push you toward overtime. Christmas 2026 is a Friday, which is not rostered,
     so use Thanksgiving — Thursday Nov 26. */
  const hc = { ...c, holidays: E.HOLIDAY_DEFAULTS(), banks: [], daysOff: [], vacations: [],
               holidayNeedsAdjacent: false, periodAnchor: '2026-11-22' };
  const nov = (d, h, len) => ({ id: 'n' + d, start: +new Date(2026, 10, d, h),
                                end: +new Date(2026, 10, d, h) + len * 3600000 });
  const worked = E.buildLedger([nov(26, 14, 10.5)], hc, +new Date(2026, 10, 30));
  const tot = E.sumRange(worked.parts, +new Date(2026, 10, 22), +new Date(2026, 11, 6));
  near('ten paid hours worked on the holiday, plus eight flat', tot.hours, 18);
  near('the eight flat hours earn no overtime', tot.otHours, 2);
  near('so it pays 16 straight and 2 at time and a half', tot.gross, 16 * 38 + 2 * 57);

  /* Vacation: Sept 20 through Oct 3, back on the 4th. Ten rostered days inside it. */
  const vc = { ...c, holidays: [], banks: [], daysOff: [],
               vacations: [{ id: 'v1', name: 'Vacation', from: '2026-09-20', to: '2026-10-03', hours: 8 }] };
  const cred = E.vacationCredits(vc);
  near('ten rostered days are credited', cred.length, 10);
  near('at eight hours each', cred.reduce((a, v) => a + (v.end - v.start) / E.HOUR_MS, 0), 80);
  ok('starting Sunday Sep 20', new Date(cred[0].start).toDateString() === 'Sun Sep 20 2026',
     new Date(cred[0].start).toDateString());
  ok('and ending Thursday Oct 1 — the Friday and Saturday are not rostered',
     new Date(cred[cred.length - 1].start).toDateString() === 'Thu Oct 01 2026',
     new Date(cred[cred.length - 1].start).toDateString());
  ok('every one of them is flat, earning no overtime credit',
     cred.every(v => v.adj.noOt === true));
  ok('and none is owed back', cred.every(v => v.owed === false));
  ok('a date inside the block is recognised', !!E.vacationOn(vc, +new Date(2026, 8, 24)));
  ok('and one after it is not', !E.vacationOn(vc, +new Date(2026, 9, 4)));

  /* The point of telling the two flags apart: a fortnight off must not read as eighty
     hours in the hole. */
  const mk = { ...vc, makeUpOn: true, makeUpWindow: 'period', periodAnchor: '2026-09-20' };
  near('two weeks of vacation leaves you owing nothing',
       E.makeUpOwed([], mk, [], +new Date(2026, 8, 20), +new Date(2026, 9, 4), +new Date(2026, 9, 4)), 0);
  const sickCfg = { ...c, holidays: [], vacations: [], makeUpOn: true, makeUpWindow: 'period',
                    periodAnchor: '2026-09-20',
                    banks: [{ id: 'sick', name: 'Sick day', count: 5, hours: 8, ot: false, makeUp: true, slots: [] }],
                    daysOff: [{ id: 'd1', bank: 'sick', slot: 0, date: '2026-09-21', hours: 8 }] };
  near('but a sick day still is',
       E.makeUpOwed([{ id: 'a', start: +new Date(2026, 8, 20, 14), end: +new Date(2026, 8, 20, 22, 30) }],
                    sickCfg, [], +new Date(2026, 8, 20), +new Date(2026, 9, 4), +new Date(2026, 8, 22, 12)), 8);

  // Vacation pays.
  const vpay = E.sumRange(E.buildLedger([], vc, +new Date(2026, 9, 4)).parts,
                          +new Date(2026, 8, 20), +new Date(2026, 9, 4));
  near('a fortnight off pays eighty flat hours', vpay.hours, 80);
  near('none of it overtime',                    vpay.otHours, 0);
  near('worth two normal weeks',                 vpay.gross, 80 * 38);

  // Days you were not rostered for pay nothing, even mid-block.
  const oneWeek = { ...c, holidays: [], banks: [], daysOff: [],
                    vacations: [{ id: 'v2', from: '2026-08-14', to: '2026-08-15', hours: 8 }] };
  near('a Friday-and-Saturday vacation credits nothing', E.vacationCredits(oneWeek).length, 0);
  near('and vacationDays says so too', E.vacationDays(oneWeek, oneWeek.vacations[0]), 0);
}

/* ---------------- a day's total follows the shift, not the calendar ---------------- */
{
  const c = { ...E.DEFAULTS, rate: 38, otMultiplier: 1.5, otMode: 'shift', shiftThreshold: 8,
              lunchMins: 30, schedStart: '14:00', schedEnd: '22:30',
              workDays: [true, true, true, true, true, false, false],
              holidays: [], banks: [], daysOff: [], vacations: [], periodAnchor: '2026-08-09' };
  const at = (d, h = 0, mi = 0) => +new Date(2026, 7, d, h, mi);
  const SUN = at(9), MON = at(10), TUE = at(11);
  // 12:15 PM Sunday to 12:45 AM Monday: 12 paid hours, and one day's work.
  const night = { id: 'n', start: at(9, 12, 15), end: at(10, 0, 45) };
  const led = E.buildLedger([night], c, at(10, 12));

  const bySpan = (from) => E.sumRange(led.parts, from, from + 86400000);
  near('summed between midnights, Sunday keeps only part of it', bySpan(SUN).hours, 11.25);
  near('and the rest lands on Monday',                            bySpan(MON).hours, 0.75);

  const byShift = (d) => E.sumShiftDay(led.parts, [night], c, d);
  near('summed by shift day, Sunday has all of it', byShift(SUN).hours, 12);
  near('worth the whole shift',                     byShift(SUN).gross, 8 * 38 + 4 * 57);
  near('and Monday has none of it',                 byShift(MON).hours, 0);

  // Which day "today" means, hour by hour across the boundary.
  ok('on the clock before midnight it is Sunday',
     E.todayShiftDay([], night.start, c, at(9, 23)) === SUN);
  ok('on the clock after midnight it is still Sunday',
     E.todayShiftDay([], night.start, c, at(10, 0, 30)) === SUN);
  ok('just clocked out, it stays on that shift',
     E.todayShiftDay([night], null, c, at(10, 0, 50)) === SUN,
     new Date(E.todayShiftDay([night], null, c, at(10, 0, 50))).toDateString());
  ok('later the same day, still that shift',
     E.todayShiftDay([night], null, c, at(10, 9)) === SUN);
  ok('a new day with nothing worked is simply today',
     E.todayShiftDay([night], null, c, at(11, 14)) === TUE,
     new Date(E.todayShiftDay([night], null, c, at(11, 14))).toDateString());
  ok('and with nothing on file at all it is today',
     E.todayShiftDay([], null, c, at(11, 9)) === TUE);

  // Two shifts in one day still add up.
  const twice = [{ id: 'a', start: at(12, 6), end: at(12, 10) },
                 { id: 'b', start: at(12, 14), end: at(12, 18) }];
  const led2 = E.buildLedger(twice, c, at(12, 20));
  near('two shifts on one day are one figure',
       E.sumShiftDay(led2.parts, twice, c, at(12)).hours, 8);

  // A credit with a date of its own stays on that date.
  const hc = { ...c, holidays: E.HOLIDAY_DEFAULTS(), holidayNeedsAdjacent: false,
               periodAnchor: '2026-11-22' };
  const nov26 = +new Date(2026, 10, 26);
  const led3 = E.buildLedger([], hc, +new Date(2026, 10, 30));
  near('a holiday counts on the holiday', E.sumShiftDay(led3.parts, [], hc, nov26).hours, 8);
  near('and not on the day after', E.sumShiftDay(led3.parts, [], hc, nov26 + 86400000).hours, 0);
}

/* ---------------- a shift differential on part of a shift ---------------- */
{
  /* 2 PM - 10:30 PM with a half-hour lunch, 15 cents an hour after 6 PM. The lunch falls at
     7 PM, so four of the eight paid hours qualify — exactly half, which is what the stub
     this was built from shows. */
  const c = { ...E.DEFAULTS, rate: 37.78, otMultiplier: 1.5, otMode: 'shift', shiftThreshold: 8,
              lunchMins: 30, schedStart: '14:00', schedEnd: '22:30',
              workDays: [true, true, true, true, true, false, false],
              holidays: [], banks: [], daysOff: [], vacations: [],
              periodAnchor: '2026-07-12', periodLengthDays: 14,
              nightOn: true, nightFrom: '18:00', nightTo: '06:00', nightRate: 0.15 };
  const off = { ...c, nightOn: false };
  const on = (d, h = 0, mi = 0) => +new Date(2026, 6, d, h, mi);
  const shift = (d) => ({ id: 's' + d, start: on(d, 14), end: on(d, 22, 30) });
  const span = (ss, cfg) => {
    const led = E.buildLedger(ss, cfg, on(26));
    return { t: E.sumRange(led.parts, on(12), on(26)), n: E.sumNight(led.parts, on(12), on(26)) };
  };

  let r = span([shift(12)], c);
  near('eight paid hours in the shift', r.t.hours, 8);
  near('four of them after six', r.n.hours, 4);
  near('worth sixty cents', r.n.pay, 0.6);
  near('and the shift is worth base plus that', r.t.gross, 8 * 37.78 + 0.6);

  // Eight shifts, the shape of a fortnight.
  const two = [12, 13, 14, 15, 19, 20, 21, 22].map(shift);
  r = span(two, c);
  near('sixty-four paid hours', r.t.hours, 64);
  near('half of them qualify', r.n.hours, 32);
  near('worth $4.80',          r.n.pay, 4.8);

  // Turned off it changes nothing at all.
  near('off, the hours are the same', span(two, off).t.hours, 64);
  near('and the money is base only',  span(two, off).t.gross, 64 * 37.78);
  near('with no differential to report', span(two, off).n.hours, 0);

  // A day shift never touches the window.
  const daycfg = { ...c, schedStart: '06:00', schedEnd: '14:30' };
  near('a 6 AM to 2:30 PM shift earns none',
       span([{ id: 'd', start: on(12, 6), end: on(12, 14, 30) }], daycfg).n.hours, 0);

  // A window that wraps midnight is one night, not a contradiction.
  const night = { ...c, schedStart: '22:00', schedEnd: '06:00' };
  const nr = span([{ id: 'n', start: on(12, 22), end: on(13, 6) }], night);
  near('a 10 PM to 6 AM shift qualifies throughout', nr.n.hours, nr.t.hours);
  near('which is seven and a half paid hours',       nr.n.hours, 7.5);

  // Overtime is worked out on rate plus differential, as the regular rate of pay requires.
  const long = span([{ id: 'L', start: on(12, 14), end: on(13, 0, 30) }], c);
  near('ten paid hours', long.t.hours, 10);
  near('two of them overtime', long.t.otHours, 2);
  near('six qualify for the differential', long.n.hours, 6);
  near('and it is paid at time and a half on the overtime part',
       long.n.pay, (4 + 2 * 1.5) * 0.15);
  /* Four hours before six at base, four after it at base plus the differential, then the
     last two at time and a half on the higher rate. Not the whole shift at the higher rate:
     the premium only ever touches the hours inside the window. */
  near('the shift totals base outside the window and base-plus inside it',
       long.t.gross, 4 * 37.78 + 4 * 37.93 + 2 * 37.93 * 1.5);

  // Paid leave is not time on the clock.
  const withHol = { ...c, holidays: E.HOLIDAY_DEFAULTS(), holidayNeedsAdjacent: false,
                    periodAnchor: '2026-07-01' };
  const hled = E.buildLedger([], withHol, +new Date(2026, 6, 10));
  near('a holiday earns no differential',
       E.sumNight(hled.parts, +new Date(2026, 6, 1), +new Date(2026, 6, 15)).hours, 0);
  const vac = { ...c, vacations: [{ id: 'v', from: '2026-07-13', to: '2026-07-17', hours: 8 }] };
  const vled = E.buildLedger([], vac, on(26));
  near('nor does a vacation day', E.sumNight(vled.parts, on(12), on(26)).hours, 0);

  // The window itself.
  ok('a zero rate is the same as off', E.nightWindow({ ...c, nightRate: 0 }) === null);
  ok('and a missing time is too',      E.nightWindow({ ...c, nightFrom: '' }) === null);
  const w = E.nightWindow(c);
  ok('7 PM is inside',  E.inNightWindow(on(12, 19), w));
  ok('2 AM is inside',  E.inNightWindow(on(12, 2), w));
  ok('noon is not',    !E.inNightWindow(on(12, 12), w));
  ok('6 PM exactly is inside',  E.inNightWindow(on(12, 18), w));
  ok('6 AM exactly is outside', !E.inNightWindow(on(12, 6), w));
}

/* ---------------- a week of your roster, for the projection ---------------- */
{
  const five8 = { ...E.DEFAULTS, schedStart: '14:00', schedEnd: '22:30', lunchMins: 30,
                  workDays: [true, true, true, true, true, false, false] };
  near('five eight-hour days is a 40 h week', E.scheduledWeekHours(five8), 40);

  const four10 = { ...five8, schedStart: '06:00', schedEnd: '16:30',
                   workDays: [false, true, true, true, true, false, false] };
  near('four tens is also 40', E.scheduledWeekHours(four10), 40);

  const part = { ...five8, workDays: [false, true, true, true, false, false, false] };
  near('three eights is 24, not the 40 h threshold', E.scheduledWeekHours(part), 24);

  const noSched = { ...E.DEFAULTS, schedStart: '', schedEnd: '', weeklyThreshold: 40 };
  near('with no schedule it falls back to the threshold', E.scheduledWeekHours(noSched), 40);
  near('and follows that threshold when it is not 40',
       E.scheduledWeekHours({ ...noSched, weeklyThreshold: 37.5 }), 37.5);
}

/* ---------------- federal tax not withheld while exempt ---------------- */
{
  const c = { ...E.DEFAULTS, rate: 37.78, otMultiplier: 1.5, otMode: 'weekly', weeklyThreshold: 40,
              lunchMins: 30, schedStart: '14:00', schedEnd: '22:30',
              workDays: [false, true, true, true, true, true, false],
              holidays: [], banks: [], daysOff: [], vacations: [],
              periodAnchor: '2026-06-01', periodLengthDays: 14 };
  const nc = { filing: 'single', dependents: 0, ficaOn: true, statePct: 4.95, items: [],
               otBreak: true, fedExempt: true };
  const at = (m, d, h = 14, mi = 0) => +new Date(2026, m, d, h, mi);
  const ss = [];
  [[5, [1,2,3,4,5,8,9,10,11,12,15,16,17,18,19]], [6, [6,7,8,9,10,13,14,15,16,17,20,21,22,23,24]]]
    .forEach(([m, days]) => days.forEach(d =>
      ss.push({ id: 'w' + m + d, start: at(m, d), end: at(m, d, 22, 30) })));
  const led = E.buildLedger(ss, c, at(6, 27, 12));

  const jul = E.fedNotWithheld(led.parts, c, nc, +new Date(2026, 6, 1), +new Date(2026, 6, 28));
  ok('July alone is a real figure', jul.fed > 0, '$' + jul.fed.toFixed(2));
  ok('on the pay inside that window', jul.pay > 0, '$' + jul.pay.toFixed(2));
  ok('the effective rate is plausible for a single filer',
     jul.fed / jul.pay > 0.05 && jul.fed / jul.pay < 0.18,
     (100 * jul.fed / jul.pay).toFixed(1) + '%');

  const both = E.fedNotWithheld(led.parts, c, nc, +new Date(2026, 5, 1), +new Date(2026, 6, 28));
  ok('a longer window is worth more', both.fed > jul.fed, `${both.fed} vs ${jul.fed}`);
  ok('and covers more pay',           both.pay > jul.pay, `${both.pay} vs ${jul.pay}`);

  // Nothing worked inside it, nothing to report.
  const none = E.fedNotWithheld(led.parts, c, nc, +new Date(2026, 3, 1), +new Date(2026, 3, 30));
  near('a window with no work reports nothing', none.fed, 0);
  near('and no pay',                            none.pay, 0);
  near('an empty window is empty too',
       E.fedNotWithheld(led.parts, c, nc, +new Date(2026, 6, 1), +new Date(2026, 6, 1)).fed, 0);

  /* It is a counterfactual: what would have come out. So the exempt flag on the config must
     not silence it — that is the whole point. */
  const notEx = E.fedNotWithheld(led.parts, c, { ...nc, fedExempt: false },
                                 +new Date(2026, 6, 1), +new Date(2026, 6, 28));
  near('being flagged exempt does not zero the counterfactual', notEx.fed, jul.fed);

  // It follows the things a real cheque follows.
  const married = E.fedNotWithheld(led.parts, c, { ...nc, filing: 'married' },
                                   +new Date(2026, 6, 1), +new Date(2026, 6, 28));
  ok('married withholds less than single', married.fed < jul.fed, `${married.fed} vs ${jul.fed}`);
  const kids = E.fedNotWithheld(led.parts, c, { ...nc, dependents: 2 },
                                +new Date(2026, 6, 1), +new Date(2026, 6, 28));
  ok('dependents withhold less too', kids.fed < jul.fed, `${kids.fed} vs ${jul.fed}`);
  const pre = E.fedNotWithheld(led.parts, c,
                { ...nc, items: [{ id: 'k', name: '401k', amount: 200, pretax: true }] },
                +new Date(2026, 6, 1), +new Date(2026, 6, 28));
  ok('a pre-tax deduction lowers it', pre.fed < jul.fed, `${pre.fed} vs ${jul.fed}`);
  const ovr = E.fedNotWithheld(led.parts, c, { ...nc, fedOverride: 300 },
                               +new Date(2026, 6, 1), +new Date(2026, 6, 28));
  ok('and a per-check override is honoured', ovr.fed > 0 && ovr.fed !== jul.fed,
     '$' + ovr.fed.toFixed(2));

  /* Overtime is not a separate calculation to bolt on — OT pay is inside the gross the
     counterfactual taxes. These days are all plain eights, so nothing has been earned at
     time and a half yet. */
  near('plain weeks report no overtime', jul.otHours, 0);

  /* Same fortnight, but four of the July days run four hours long. */
  const otSs = ss.map(s => {
    const d = new Date(s.start);
    const long = d.getMonth() === 6 && [20, 21, 22, 23].indexOf(d.getDate()) >= 0;
    return long ? { ...s, end: s.end + 4 * E.HOUR_MS } : s;
  });
  const otLed = E.buildLedger(otSs, c, at(6, 27, 12));
  const withOt = E.fedNotWithheld(otLed.parts, c, nc,
                                  +new Date(2026, 6, 1), +new Date(2026, 6, 28));
  ok('overtime hours are reported', withOt.otHours > 0, E.chartHours(withOt.otHours) + ' h');
  ok('the pay it is figured on includes them', withOt.pay > jul.pay,
     `$${withOt.pay} vs $${jul.pay}`);
  ok('and the tax not withheld goes up with them', withOt.fed > jul.fed,
     `$${withOt.fed} vs $${jul.fed}`);

  /* The overtime tax break is federal-income-tax only, so switching it off must raise the
     figure — proof the break is being applied to the premium rather than ignored. */
  const noBreak = E.fedNotWithheld(otLed.parts, c, { ...nc, otBreak: false },
                                   +new Date(2026, 6, 1), +new Date(2026, 6, 28));
  ok('without the overtime deduction more would have been withheld',
     noBreak.fed > withOt.fed, `$${noBreak.fed} vs $${withOt.fed}`);
  near('the hours are the same either way', noBreak.otHours, withOt.otHours);
}

/* ---------------- the 2026 federal table ----------------
   Pinned to IRS Rev. Proc. 2025-32 (released 9 Oct 2025), the Social Security
   Administration's 2026 wage-base announcement, and the OBBBA overtime deduction.
   A stale table produces a wrong take-home rather than an obviously missing one, so the
   numbers themselves are asserted, not just the arithmetic that uses them. */
{
  const T = E.TAX2026;
  near('the table is for the year the app says it is', E.TAX_YEAR, 2026);
  near('single standard deduction',  T.fed.single.std,  16100);
  near('married standard deduction', T.fed.married.std, 32200);
  near('head of household standard deduction', T.fed.hoh.std, 24150);

  ['single', 'married', 'hoh'].forEach(f => {
    const b = T.fed[f].brackets;
    near(f + ' has seven brackets', b.length, 7);
    ok(f + ' rates run 10 to 37',
       b.map(x => x[1]).join() === '0.1,0.12,0.22,0.24,0.32,0.35,0.37',
       b.map(x => x[1]).join());
    ok(f + ' thresholds only ever climb',
       b.every((x, i) => i === 0 ? x[0] === 0 : x[0] > b[i - 1][0]));
  });

  ok('single thresholds match the published table',
     T.fed.single.brackets.map(x => x[0]).join() ===
     '0,12400,50400,105700,201775,256225,640600');
  ok('married thresholds match the published table',
     T.fed.married.brackets.map(x => x[0]).join() ===
     '0,24800,100800,211400,403550,512450,768700');
  ok('head of household thresholds match the published table',
     T.fed.hoh.brackets.map(x => x[0]).join() ===
     '0,17700,67450,105700,201750,256200,640600');

  near('Social Security wage base', T.ssWageBase, 184500);
  near('Social Security rate',      T.ssRate,     0.062);
  near('Medicare rate',             T.medicareRate, 0.0145);
  near('dependent credit',          T.depCredit,  2200);
  near('overtime deduction cap, single',  T.otCap.single,  12500);
  near('overtime deduction cap, married', T.otCap.married, 25000);

  /* The brackets are progressive, so crossing one only ever taxes the dollars above it.
     $60,000 of taxable income as a single filer: 12,400 at 10, then 38,000 at 12,
     then 9,600 at 22. */
  near('bracket walk at $60,000 taxable',
       E.bracketTax(60000, T.fed.single.brackets),
       12400 * .10 + (50400 - 12400) * .12 + (60000 - 50400) * .22);
  near('the first dollar is taxed at 10%', E.bracketTax(1, T.fed.single.brackets), 0.10);
  near('no taxable income, no tax',        E.bracketTax(0, T.fed.single.brackets), 0);
  near('exactly at a threshold, nothing above it is taxed yet',
       E.bracketTax(12400, T.fed.single.brackets), 1240);

  /* Crossing a threshold must move the marginal dollar, not the whole income. */
  const justUnder = E.bracketTax(50399, T.fed.single.brackets);
  const justOver  = E.bracketTax(50401, T.fed.single.brackets);
  ok('crossing into 22% costs 22 cents on the two dollars, not a cliff',
     Math.abs((justOver - justUnder) - (0.12 + 0.22)) < 1e-6,
     '$' + (justOver - justUnder).toFixed(4));

  /* One period of withholding, annualized and brought back. At $37.78 for 80 hours the
     annual taxable is 26 periods of $3,022.40 less the standard deduction. */
  const per = E.fedWithholding(3022.40, 26, 'single', 0);
  const annual = 3022.40 * 26 - 16100;
  near('a period of withholding is the annual figure divided back',
       per, E.bracketTax(annual, T.fed.single.brackets) / 26);
  ok('which at that wage is roughly a tenth of the check',
     per / 3022.40 > 0.09 && per / 3022.40 < 0.14,
     (100 * per / 3022.40).toFixed(1) + '%');

  /* Effective rate rises with income; marginal rate is the higher number and always
     above it. This is the whole point of the table being progressive. */
  const eff = t => E.bracketTax(Math.max(0, t - 16100), T.fed.single.brackets) / t;
  ok('effective rate climbs with income', eff(40000) < eff(90000) && eff(90000) < eff(300000),
     [eff(40000), eff(90000), eff(300000)].map(x => (100 * x).toFixed(1) + '%').join(' < '));
  ok('and stays below the top marginal rate', eff(300000) < 0.37,
     (100 * eff(300000)).toFixed(1) + '%');

  // Dependents come off the tax, not the income, and never below zero.
  ok('two dependents cut a period more than one does',
     E.fedWithholding(3022.40, 26, 'single', 2) < E.fedWithholding(3022.40, 26, 'single', 1));
  near('enough dependents floor it at zero',
       E.fedWithholding(3022.40, 26, 'single', 20), 0);
  ok('married withholds less than single on the same check',
     E.fedWithholding(3022.40, 26, 'married', 0) < per);
  ok('head of household sits between the two',
     E.fedWithholding(3022.40, 26, 'hoh', 0) < per &&
     E.fedWithholding(3022.40, 26, 'hoh', 0) > E.fedWithholding(3022.40, 26, 'married', 0));
  near('an unknown filing status falls back to single',
       E.fedWithholding(3022.40, 26, 'nonsense', 0), per);
}

/* ------------------------------------------------------------------ */
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
