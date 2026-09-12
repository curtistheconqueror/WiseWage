/* Professions.
   A profession is a data record, not a code path: it sets sensible starting points and
   decides which controls are worth showing. It never locks anything, and it never silently
   corrects a choice already made. */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
const CHROME = process.env.PW_CHROME || undefined;
const KEY = 'payclock.v1';

const TYPES = {'.html':'text/html','.js':'text/javascript',
               '.webmanifest':'application/manifest+json','.png':'image/png'};
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/' || p === '/index.html'){ r.writeHead(200,{'Content-Type':'text/html'});
    return r.end(readFileSync(ROOT + 'index.html')); }
  if (p === '/favicon.ico'){ r.writeHead(204); return r.end(); }
  const f = ROOT + p.slice(1);
  if (!existsSync(f)){ r.writeHead(404); return r.end('no'); }
  r.writeHead(200, {'Content-Type': TYPES[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream'});
  r.end(readFileSync(f));
}).listen(8199);

let fails = 0;
const ok = (n, c, x = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${x ? '  → ' + x : ''}`); if (!c) fails++; };
const b = await chromium.launch({ executablePath: CHROME });
const ctx = await b.newContext({ viewport:{width:1100,height:2200},
                                 timezoneId:'America/Chicago', locale:'en-US' });
const T = (d, h) => Date.UTC(2026, 7, d, h + 5, 0);

const CFG = { rate:37.78, otMultiplier:1.5, otMode:'weekly', weeklyThreshold:40,
  periodThreshold:80, dailyThreshold:8, shiftThreshold:8, weekStartDay:0,
  periodAnchor:'2026-08-09', periodLengthDays:14, payDateOffsetDays:13,
  schedStart:'14:00', schedEnd:'22:30', lunchMins:30,
  workDays:[true,true,true,true,true,false,false],
  holidays:[], banks:[], daysOff:[], vacations:[] };
const SEED = { configured:true,
  jobs:[{ id:'j1', name:'My job', profession:'', primary:true, activeStart:null, activeAdj:null,
          cfg: JSON.parse(JSON.stringify(CFG)) }],
  activeJob:'j1', sessions:[], absences:[], unit:'sec', ui:{open:{}}, net:{} };

async function boot(seed, at){
  const p = await ctx.newPage();
  p.on('pageerror', e => { console.log('  PAGE ERROR:', e.message); fails++; });
  p.on('console', m => { if (m.type()==='error'){ console.log('  CONSOLE ERROR:', m.text()); fails++; } });
  await p.addInitScript(([k,v]) => { if (sessionStorage.getItem('__s')) return;
    sessionStorage.setItem('__s','1');
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); },
    [KEY, seed === undefined ? null : seed]);
  await p.clock.install({ time: new Date(at) });
  await p.goto('http://localhost:8199/'); await p.waitForTimeout(700);
  return p;
}
const openCfg = async p => { await p.evaluate(() =>
  document.querySelectorAll('#cfg details').forEach(d => d.open = true)); await p.waitForTimeout(300); };
const st = p => p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
const seen = (p, sel) => p.evaluate(s => { const e = document.querySelector(s);
  return !!e && e.checkVisibility({contentVisibilityAuto:true, visibilityProperty:true}); }, sel);
const NOW = T(12, 16);

console.log('\n━━ The table is grouped by field, then role ━━');
let p = await boot(SEED, NOW);
const groups = await p.evaluate(() => professionGroups().map(g => g.group + ':' + g.roles.length));
ok('fields are grouped', groups.length >= 3, groups.join(' | '));
ok('Medical is one of them', groups.some(g => g.startsWith('Medical')), groups.join(' | '));
const nurse = await p.evaluate(() => PROFESSIONS.nurse);
ok('a nurse runs on a clock', nurse.model === 'clock', nurse.model);
ok('and defaults to the hospital overtime rule', nurse.otDefault === 'eighty80', nurse.otDefault);

console.log('\n━━ Choosing one sets a starting point ━━');
await openCfg(p);
ok('every job has a profession picker', await seen(p, '#jobList select[data-jprof]'));
ok('the overtime rule starts weekly',
   (await st(p)).jobs[0].cfg.otMode === 'weekly', (await st(p)).jobs[0].cfg.otMode);
await p.selectOption('#jobList select[data-jprof]', 'nurse'); await p.waitForTimeout(700);
let d = await st(p);
ok('the profession saves on the job', d.jobs[0].profession === 'nurse', d.jobs[0].profession);
ok('and it moved the overtime rule to 8 and 80', d.jobs[0].cfg.otMode === 'eighty80',
   d.jobs[0].cfg.otMode);
/* It has to be a starting point, not a lock. */
await p.selectOption('#cMode', 'weekly'); await p.waitForTimeout(600);
d = await st(p);
ok('which can be changed straight back', d.jobs[0].cfg.otMode === 'weekly', d.jobs[0].cfg.otMode);
ok('without losing the profession', d.jobs[0].profession === 'nurse', d.jobs[0].profession);

console.log('\n━━ The profession never silently corrects you ━━');
/* Someone who has already chosen a rule has decided. Re-picking the same profession must
   not quietly put it back. */
/* Changing the rule by hand in Settings is what marks it as decided — no test-only flag. */
await p.selectOption('#cMode', 'weekly'); await p.waitForTimeout(500);
ok('changing the rule by hand marks it as yours',
   (await p.evaluate(() => !!activeJob().cfgTouched)));
await p.selectOption('#jobList select[data-jprof]', 'tech'); await p.waitForTimeout(700);
d = await st(p);
ok('a settled overtime rule is left alone', d.jobs[0].cfg.otMode === 'weekly', d.jobs[0].cfg.otMode);
ok('though the profession still changes', d.jobs[0].profession === 'tech', d.jobs[0].profession);

console.log('\n━━ A clock profession shows the clock settings ━━');
await openCfg(p);
ok('pay & overtime is there', await seen(p, '#gPay'));
ok('so is the schedule', await seen(p, '#gSched'));
ok('and premiums', await seen(p, '#gPrem'));
ok('the model is a clock', (await p.evaluate(() => jobModel())) === 'clock');

console.log('\n━━ Clearing it back to nothing ━━');
await p.selectOption('#jobList select[data-jprof]', ''); await p.waitForTimeout(700);
d = await st(p);
ok('the profession clears', d.jobs[0].profession === '', JSON.stringify(d.jobs[0].profession));
ok('and everything is still on screen', (await seen(p, '#gPay')) && (await seen(p, '#gSched')));
ok('the rule is untouched by clearing', d.jobs[0].cfg.otMode === 'weekly', d.jobs[0].cfg.otMode);
await p.close();

console.log('\n━━ Two jobs can be different kinds of work ━━');
const two = JSON.parse(JSON.stringify(SEED));
two.jobs[0].profession = 'transit_operator'; two.jobs[0].name = 'Pace';
two.jobs.push({ id:'j2', name:'Hospital', profession:'nurse', primary:false,
                activeStart:null, activeAdj:null,
                cfg: Object.assign(JSON.parse(JSON.stringify(CFG)), { otMode:'eighty80' }) });
p = await boot(two, NOW);
ok('the first is a transit operator',
   (await p.evaluate(() => jobById('j1').profession)) === 'transit_operator');
ok('the second is a nurse', (await p.evaluate(() => jobById('j2').profession)) === 'nurse');
ok('and they run different overtime rules',
   (await p.evaluate(() => jobById('j1').cfg.otMode)) === 'weekly'
   && (await p.evaluate(() => jobById('j2').cfg.otMode)) === 'eighty80');
await p.evaluate(() => { state.activeJob = 'j2'; save(); syncControls(); render(); });
await p.waitForTimeout(500); await openCfg(p);
ok('switching job switches the rule on screen',
   (await p.inputValue('#cMode')) === 'eighty80', await p.inputValue('#cMode'));
await p.close();

console.log('\n━━ First-run setup asks it, and it is optional ━━');
p = await boot(undefined, NOW);
/* First run stops at the welcome screen now — Lite or Full. This suite exercises the
   full setup form, so take the Full path through it. */
if (await p.isVisible('#welcome')){ await p.click('#wPick button[data-mode="full"]');
  await p.waitForTimeout(400); }
ok('setup is showing', await seen(p, '#setup'));
ok('and asks what kind of work', await seen(p, '#sProf'));
const opts = await p.$$eval('#sProf option', os => os.map(o => o.value));
ok('with a way to decline', opts[0] === '', JSON.stringify(opts[0]));
ok('and real roles behind it', opts.includes('nurse') && opts.includes('transit_operator'));

await p.selectOption('#sProf', 'nurse'); await p.waitForTimeout(400);
const picked = await p.$$eval('#sMode button.on', bs => bs.map(x => x.dataset.m));
ok('picking a nurse preselects 8 and 80 visibly', picked[0] === 'eighty80', picked.join(','));

await p.fill('#sRate', '41'); await p.fill('#sAnchor', '2026-08-09');
await p.fill('#sSchedStart', '07:00'); await p.fill('#sSchedEnd', '19:00');
await p.click('#sSave'); await p.waitForTimeout(800);
d = await st(p);
ok('setup saved the profession onto the job', d.jobs[0].profession === 'nurse', d.jobs[0].profession);
ok('and named the job after it', /Nurse/.test(d.jobs[0].name), d.jobs[0].name);
ok('with the rule it preselected', d.jobs[0].cfg.otMode === 'eighty80', d.jobs[0].cfg.otMode);
ok('the app is running', await seen(p, '#hero'));
await p.close();

console.log('\n━━ Declining it changes nothing ━━');
p = await boot(undefined, NOW);
if (await p.isVisible('#welcome')){ await p.click('#wPick button[data-mode="full"]');
  await p.waitForTimeout(400); }
await p.fill('#sRate', '30'); await p.fill('#sAnchor', '2026-08-09');
await p.click('#sSave'); await p.waitForTimeout(800);
d = await st(p);
ok('no profession is stored', d.jobs[0].profession === '', JSON.stringify(d.jobs[0].profession));
ok('the default rule is untouched', d.jobs[0].cfg.otMode === 'weekly', d.jobs[0].cfg.otMode);
ok('and the job keeps its plain name', d.jobs[0].name === 'My job', d.jobs[0].name);

console.log('\n━━ On a phone ━━');
await p.close();
const mob = await b.newContext({ viewport:{width:390,height:900}, isMobile:true, hasTouch:true,
  deviceScaleFactor:3, timezoneId:'America/Chicago', locale:'en-US' });
const q = await mob.newPage();
await q.addInitScript(([k,v]) => { if (sessionStorage.getItem('__s')) return;
  sessionStorage.setItem('__s','1'); localStorage.setItem(k, JSON.stringify(v)); }, [KEY, SEED]);
await q.clock.install({ time: new Date(NOW) });
await q.goto('http://localhost:8199/'); await q.waitForTimeout(700);
await q.evaluate(() => document.querySelectorAll('#cfg details').forEach(d => d.open = true));
await q.waitForTimeout(300);
const m = await q.evaluate(() => {
  const s = document.querySelector('#jobList select[data-jprof]');
  return { w: document.documentElement.scrollWidth, win: innerWidth,
           h: s ? Math.round(s.getBoundingClientRect().height) : 0 };
});
ok('no sideways scroll', m.w <= m.win + 1, `${m.w} vs ${m.win}`);
ok('the picker is finger-sized', m.h >= 44, m.h + 'px');

console.log(`\n${fails === 0 ? '✅' : '❌'}  ${fails === 0 ? 'all passed' : fails + ' failed'}`);
await b.close(); srv.close();
process.exit(fails === 0 ? 0 : 1);
