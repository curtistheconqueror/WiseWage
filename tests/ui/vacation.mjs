/* Vacation blocks, the corrected holiday and allowance defaults, and the split between
   "counts toward overtime" and "still owe the hours". */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;

const KEY='payclock.v1', R = ROOT;
const TYPES={'.html':'text/html','.js':'text/javascript','.webmanifest':'application/manifest+json','.png':'image/png'};
const srv=http.createServer((q,r)=>{
  let path=decodeURIComponent(q.url.split('?')[0]);
  if(path==='/'||path==='/index.html'){r.writeHead(200,{'Content-Type':'text/html'});return r.end(readFileSync(R+'index.html'));}
  if(path==='/favicon.ico'){r.writeHead(204);return r.end();}
  const f=R+path;
  if(!existsSync(f)){r.writeHead(404);return r.end('nope');}
  r.writeHead(200,{'Content-Type':TYPES[path.slice(path.lastIndexOf('.'))]||'application/octet-stream'});
  r.end(readFileSync(f));
}).listen(8153);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b=await chromium.launch({executablePath: CHROME});

// Sun-Thu, 14:00-22:30, half-hour lunch. Period anchored on Sun Sep 20 so the vacation is one.
const seed=(over={},cfgOver={})=>({configured:true,cfg:{rate:38,otMultiplier:1.5,otMode:'shift',
  weeklyThreshold:40,periodThreshold:80,dailyThreshold:8,shiftThreshold:8,weekStartDay:0,
  periodAnchor:'2026-09-20',periodLengthDays:14,payDateOffsetDays:13,
  schedStart:'14:00',schedEnd:'22:30',lunchMins:30,
  workDays:[true,true,true,true,true,false,false],
  holidays:[],banks:[],daysOff:[],vacations:[],
  shiftDayRule:'majority',skewOn:false,skewMins:0,makeUpOn:false,makeUpWindow:'period',...cfgOver},
  sessions:[],absences:[],activeStart:null,unit:'sec',planOn:false,plannedHours:8,sound:false,
  ui:{open:{},tc:true},...over});

async function boot(ctx, st, atMs){
  const p=await ctx.newPage();
  p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});
  p.on('console',m=>{if(m.type()==='error'){console.log('  CONSOLE ERROR:',m.text());fails++;}});
  await p.addInitScript(([k,v])=>{
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded','1'); localStorage.setItem(k,JSON.stringify(v));
  },[KEY,st]);
  await p.clock.install({time:new Date(atMs)});
  await p.goto('http://localhost:8153/'); await p.waitForTimeout(650);
  await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
  await p.evaluate(()=>{ document.querySelectorAll('#cfg details').forEach(d=>d.open=true); });
  await p.waitForTimeout(400);
  return p;
}
const foot = p => p.evaluate(()=>{
  /* Read by name, not by position. This was indexed [1]=hours, [2]=OT, [3]=gross, which
     silently pointed at the wrong figures once the log gained Before and After columns. */
  const t=document.querySelector('#logBody tfoot tr');
  if(!t) return null;
  const c=k=>{const e=t.querySelector('.'+k); return e?e.textContent.trim():null;};
  return { 1:c('f-hours'), 2:c('f-ot'), 3:c('f-gross'),
           hours:c('f-hours'), ot:c('f-ot'), gross:c('f-gross'),
           before:c('f-before'), after:c('f-after') }; });
const VAC = [{id:'v1',name:'Vacation',from:'2026-09-20',to:'2026-10-03',hours:8,ot:false}];
const SEP=(d,h=12)=>Date.UTC(2026,8,d,h+4);

const ctx = await b.newContext({viewport:{width:1100,height:3000},timezoneId:'America/New_York',locale:'en-US'});

console.log('\n━━ Booking Sept 20 through Oct 3 ━━');
let p = await boot(ctx, seed(), SEP(15));
ok('the vacation section is in Settings', await p.isVisible('#cVacList'));
ok('empty to start', (await p.textContent('#cVacList')).includes('No vacation booked'));
await p.click('#cVacAdd'); await p.waitForTimeout(400);
await p.fill('#vName','Vacation');
await p.fill('#vFrom','2026-09-20'); await p.fill('#vTo','2026-10-03');
await p.dispatchEvent('#vTo','change'); await p.waitForTimeout(350);
let prev = await p.textContent('#vPreview');
console.log('       ' + prev.replace(/\s+/g,' '));
ok('ten rostered days inside it', prev.includes('10 rostered days'), prev);
ok('worth 80 hours', prev.includes('80.00 h'), prev);
ok('and it says when you are back', prev.includes('Back on Sun Oct 4'), prev);
await p.click('#vSave'); await p.waitForTimeout(500);
let list = await p.textContent('#cVacList');
console.log('       ' + list.replace(/\s+/g,' '));
ok('it is listed', list.includes('Vacation'), list);
ok('with its dates', list.includes('Sep 20, 2026') && list.includes('Oct 3, 2026'), list);
ok('and marked flat', list.includes('flat, no OT credit'), list);
ok('stored on the config', await p.evaluate(()=>{
  const v=JSON.parse(localStorage.getItem('payclock.v1')).jobs[0].cfg.vacations;
  return v.length===1 && v[0].from==='2026-09-20' && v[0].to==='2026-10-03'; }));

console.log('\n━━ It pays, flat ━━');
await p.close();
p = await boot(ctx, seed({},{vacations:VAC}), SEP(22));
let f = await foot(p);
console.log('       footer ' + JSON.stringify(f));
ok('eighty hours', f[1]==='80.00', f[1]);
ok('none of it overtime', f[2]==='—', f[2]);
ok('two normal weeks of pay', f[3]==='$3,040.00', f[3]);
const rows = await p.evaluate(()=>[...document.querySelectorAll('#logBody tbody tr')].map(tr=>({
  cls:tr.className, pill:(tr.querySelector('.c-in')?.textContent||'').trim(),
  day:(tr.querySelector('.c-day')?.innerText||'').replace(/\s+/g,' ').trim()})));
ok('ten vacation rows', rows.filter(r=>r.cls.includes('vacrowlog')).length===10,
   String(rows.filter(r=>r.cls.includes('vacrowlog')).length));
ok('each labelled VACATION', rows[0].pill==='VACATION', rows[0].pill);
ok('and named', rows[0].day.includes('Vacation'), rows[0].day);
ok('no Friday or Saturday among them',
   !rows.some(r=>r.cls.includes('vacrowlog') && (r.day.includes('Fri')||r.day.includes('Sat'))),
   JSON.stringify(rows.filter(r=>r.cls.includes('vacrowlog')).map(r=>r.day)));

console.log('\n━━ Highlighted on the calendar ━━');
await p.evaluate(()=>{ document.getElementById('qCalOn').checked=true;
  document.getElementById('qCalOn').dispatchEvent(new Event('change',{bubbles:true})); });
await p.waitForTimeout(600);
const cal = await p.evaluate(()=>{
  const on=[...document.querySelectorAll('.calcell.vac')].map(c=>c.dataset.d);
  return { on, dots:document.querySelectorAll('.calcell.vac .vacdot').length,
           tip:(document.querySelector('.calcell.vac')||{}).dataset }; });
console.log('       ' + JSON.stringify(cal.on));
ok('the rostered vacation days are marked', cal.on.length>0, JSON.stringify(cal.on));
ok('every one carries a dot', cal.dots===cal.on.length, `${cal.dots} vs ${cal.on.length}`);
ok('Sep 25 is a Friday and is not marked', !cal.on.includes('2026-09-25'), JSON.stringify(cal.on));
ok('Sep 24 is a Thursday and is', cal.on.includes('2026-09-24'), JSON.stringify(cal.on));

console.log('\n━━ Two weeks off is not two weeks in the hole ━━');
await p.close();
p = await boot(ctx, seed({},{vacations:VAC,makeUpOn:true,otMode:'shift'}), SEP(22));
ok('nothing to work off', !(await p.isVisible('#makeUpBar')));
ok('and no missing days to explain', await p.evaluate(()=>
  ![...document.querySelectorAll('#logBody tbody tr')].some(t=>t.className.includes('gaprowlog'))));

console.log('\n━━ The corrected defaults ━━');
await p.close();
/* Leave the keys out entirely rather than nulling them — a stored null is a value, and
   Object.assign would keep it over the default. */
const bare = seed(); delete bare.cfg.holidays; delete bare.cfg.banks;
p = await boot(ctx, bare, SEP(15));
/* Read the live config: defaults are merged in on load and only written back on the next
   save, so storage still holds exactly what was seeded. */
const d = await p.evaluate(()=>{
  const c=state.cfg;
  return { hols:(c.holidays||[]).map(h=>({n:h.name,ot:h.ot})), banks:(c.banks||[]).map(x=>
    ({id:x.id,count:x.count,ot:x.ot,makeUp:x.makeUp})) }; });
console.log('       ' + JSON.stringify(d.banks));
ok('six holidays', d.hols.length===6, String(d.hols.length));
ok('none earning overtime credit', d.hols.every(h=>h.ot===false), JSON.stringify(d.hols));
/* No allowance ships at all. This used to hand everybody five sick days and five Pace
   "vacation random days" — numbers that came from nowhere. An invented allowance is worse
   than an omitted one: an omission is visibly missing, an invented five reads as a fact. */
ok('nothing is assumed about allowances', d.banks.length===0,
   d.banks.map(x=>x.id).join(','));
/* Each kind is still first-class once added, and each still asks its two questions. */
for (const [i,kind] of [[1,'sick'],[2,'vrd'],[3,'float']]){
  await p.selectOption('#cBankAdd',kind); await p.waitForTimeout(500);
  ok(`a ${kind} allowance can be added`,
     (await p.locator('#cBankList .bankcfg').count())===i,
     String(await p.locator('#cBankList .bankcfg').count()));
}
{
  const added = await p.evaluate(()=>state.cfg.banks.map(x=>
    ({name:x.name,count:x.count,ot:x.ot,makeUp:x.makeUp})));
  ok('each starts at zero rather than at a guess', added.every(x=>x.count===0),
     JSON.stringify(added.map(x=>x.count)));
  ok('the sick day is the one you owe back', added[0].makeUp===true, JSON.stringify(added[0]));
  ok('the VRD is not', added[1].makeUp===false, JSON.stringify(added[1]));
  ok('and the floater is the one that earns overtime credit', added[2].ot===true,
     JSON.stringify(added[2]));
}
ok('both questions are asked per allowance',
   (await p.locator('#cBankList select[data-bf="makeUp"]').count())===3);
ok('as is the already-used one',
   (await p.locator('#cBankList input[data-bf="usedBefore"]').count())===3);

console.log('\n━━ Editing and removing ━━');
await p.close();
p = await boot(ctx, seed({},{vacations:VAC}), SEP(15));
await p.click('#cVacList button[data-vedit]'); await p.waitForTimeout(400);
ok('it reopens on what you saved', (await p.inputValue('#vFrom'))==='2026-09-20', await p.inputValue('#vFrom'));
await p.fill('#vTo','2026-09-26'); await p.dispatchEvent('#vTo','change'); await p.waitForTimeout(300);
await p.click('#vSave'); await p.waitForTimeout(500);
ok('a shorter block re-counts', (await p.textContent('#cVacList')).includes('5 rostered days'),
   (await p.textContent('#cVacList')).replace(/\s+/g,' '));
await p.click('#cVacList button[data-vdel]'); await p.waitForTimeout(450);
ok('and it can be removed', (await p.textContent('#cVacList')).includes('No vacation booked'));

console.log('\n━━ Nonsense is refused ━━');
await p.click('#cVacAdd'); await p.waitForTimeout(300);
await p.fill('#vFrom','2026-09-20'); await p.fill('#vTo','2026-09-10');
await p.dispatchEvent('#vTo','change'); await p.waitForTimeout(300);
await p.click('#vSave'); await p.waitForTimeout(350);
ok('a backwards block is rejected', await p.isVisible('#vErr'));
ok('with a reason', (await p.textContent('#vErr')).includes('cannot be before'), await p.textContent('#vErr'));

console.log('\n━━ On a phone ━━');
await p.close();
const mob = await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
  deviceScaleFactor:3,timezoneId:'America/New_York',locale:'en-US'});
p = await boot(mob, seed({},{vacations:VAC}), SEP(22));
await p.click('#cVacList button[data-vedit]'); await p.waitForTimeout(400);
const m = await p.evaluate(()=>({
  w:document.documentElement.scrollWidth, win:window.innerWidth,
  f:['vName','vFrom','vTo','vHours','vOt'].map(id=>({
    h:Math.round(document.getElementById(id).getBoundingClientRect().height),
    fs:parseFloat(getComputedStyle(document.getElementById(id)).fontSize)}))}));
ok('no sideways scroll', m.w<=m.win+1, `${m.w} vs ${m.win}`);
ok('every field is tappable', m.f.every(x=>x.h>=40), JSON.stringify(m.f));
ok('and none makes iOS zoom', m.f.every(x=>x.fs>=16), JSON.stringify(m.f));


/* ── A fortnight off, reported as a fortnight off ──────────────────────────
   A whole pay period of vacation, which is the shape that exposed the bug: paid leave sits
   inside regHours because it is straight time, and only HOLIDAY was being carved back out
   again. So two weeks nobody worked were reported as "80.00 h reg" — eighty hours at the
   clock, on a screen whose whole job is to say what you earned and why. */
console.log('\n━━ A whole period of vacation says so ━━');
{
  const ctxV = await b.newContext({ viewport:{width:390,height:1400},
    timezoneId:'America/Chicago', locale:'en-US' });
  const pv = await ctxV.newPage();
  pv.on('pageerror', e => { console.log('  PAGE ERROR:', e.message); fails++; });
  await pv.clock.install({ time: new Date(2026, 9, 3, 12, 0) });     // Sat Oct 3 2026
  await pv.addInitScript(() => { if (sessionStorage.__s) return; sessionStorage.__s = 1;
    localStorage.setItem('payclock.v1', JSON.stringify({ configured:true, mode:'full',
      cfg:{ rate:37.78, otMode:'eight40', schedStart:'14:00', schedEnd:'22:30', lunchMins:30,
            workDays:[true,true,true,true,true,false,false],        // Sun-Thu
            periodAnchor:'2026-09-06', periodLengthDays:14, payDateOffsetDays:13,
            holidays:[], banks:[], daysOff:[],
            vacations:[{ id:'v1', name:'Vacation', from:'2026-09-20', to:'2026-10-03', hours:8 }] },
      sessions:[], activeStart:null, sound:false, ui:{open:{calc:true}} }));
  });
  await pv.goto('http://localhost:8153/'); await pv.waitForTimeout(1000);
  await pv.evaluate(() => { document.querySelectorAll('.col').forEach(c => c.classList.add('open'));
                            drawCal(true); });
  await pv.waitForTimeout(600);

  /* Rostered days only. Sep 20-24 and Sep 27-Oct 1; the Fridays and Saturdays inside the
     block pay nothing, because a vacation does not invent shifts that never existed. */
  const credits = await pv.evaluate(() => vacationCredits(state.cfg).length);
  ok('ten rostered days inside the fortnight', credits === 10, String(credits));

  const tile = (await pv.textContent('#pDet')).replace(/\s+/g, ' ');
  ok('the period tile names it as vacation', /vacation/i.test(tile), tile.trim());
  ok('and gives the hours', /80\.00 h vacation/.test(tile), tile.trim());
  /* The bug: eighty hours of leave reported as eighty hours at the clock. */
  ok('without claiming any of it was worked', !/\b80\.00 h reg\b/.test(tile), tile.trim());

  const week = (await pv.textContent('#wDet')).replace(/\s+/g, ' ');
  ok('the week tile says vacation too', /vacation/i.test(week), week.trim());

  const marked = await pv.evaluate(() =>
    [...document.querySelectorAll('.calcell.vac')].map(c => c.dataset.d));
  ok('the calendar marks every rostered day', marked.length === 10, String(marked.length));
  ok('starting the Sunday it began', marked.indexOf('2026-09-20') > -1, marked.join(' '));
  ok('and ending the Thursday it ran out', marked.indexOf('2026-10-01') > -1);
  ok('leaving the unrostered days alone', marked.indexOf('2026-09-25') < 0
     && marked.indexOf('2026-09-26') < 0, marked.join(' '));

  const log = await pv.evaluate(() =>
    [...document.querySelectorAll('#logBody tbody tr')].map(r => r.innerText).join(' | '));
  ok('and the shift log calls each one a vacation', /VACATION/.test(log));

  /* Leave is flat by default: a fortnight off must not manufacture overtime. */
  const ot = await pv.evaluate(() => {
    const pi = periodInfo(Date.now(), state.cfg);
    return sumRange(jobLedger(null, state.cfg, Date.now()).parts, pi.start, pi.end).otHours; });
  ok('with no overtime invented by it', ot === 0, String(ot));
  await pv.close(); await ctxV.close();
}

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close();
process.exit(fails===0?0:1);
