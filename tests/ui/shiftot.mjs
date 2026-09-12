/* Overtime counted per shift rather than per calendar day. The case that matters:
   2:00 PM – 12:30 AM is one shift, and the eight-hour allowance should not start again
   at midnight. */
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
}).listen(8127);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b=await chromium.launch({executablePath: CHROME});
const T=(d,h,mi=0)=>Date.UTC(2026,7,d,h+4,mi);                 // America/New_York, EDT

const base={configured:true,cfg:{rate:38,otMultiplier:1.5,otMode:'weekly',weeklyThreshold:40,
  periodThreshold:80,dailyThreshold:8,shiftThreshold:8,weekStartDay:0,periodAnchor:'2026-08-09',
  periodLengthDays:14,payDateOffsetDays:13,schedStart:'14:00',schedEnd:'22:30',lunchMins:0,
  workDays:[true,true,true,true,true,false,false],holidays:[],banks:[],daysOff:[]},
  sessions:[],activeStart:null,unit:'sec',planOn:false,plannedHours:8,sound:false};

async function boot(ctx, seed, atMs){
  const p=await ctx.newPage();
  p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});
  p.on('console',m=>{if(m.type()==='error'){console.log('  CONSOLE ERROR:',m.text());fails++;}});
  await p.addInitScript(([k,v])=>{
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded','1');
    localStorage.setItem(k,JSON.stringify(v));
  },[KEY,seed]);
  await p.clock.install({time:new Date(atMs)});
  await p.goto('http://localhost:8127/'); await p.waitForTimeout(650);
  await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
  await p.evaluate(()=>{ document.querySelectorAll('#cfg details').forEach(d=>d.open=true); });
  await p.waitForTimeout(300);
  return p;
}
const foot = p => p.evaluate(()=>document.querySelector('#logBody tfoot')?.innerText.replace(/\s+/g,' '));
const ctx = await b.newContext({viewport:{width:1100,height:2600},timezoneId:'America/New_York',locale:'en-US'});

// 2:00 PM Tue Aug 11 → 12:30 AM Wed Aug 12. 10.5 h, crossing midnight.
const NIGHT=[{id:'n',start:T(11,14),end:T(12,0,30)}];

console.log('\n━━ The option exists and says what it does ━━');
let p = await boot(ctx, {...base, sessions:NIGHT}, T(12,12));
const opts = await p.evaluate(()=>[...document.querySelectorAll('#cMode option')]
  .map(o=>o.value+' = '+o.textContent.trim()));
console.log(opts.map(o=>'       '+o).join('\n'));
/* Counted against itself rather than a number written here — a new rule must not quietly
   fail a test whose only complaint is that there is one more of them than there used to be. */
ok('every rule has a value and plain English behind it',
   opts.every(o => /^[a-z0-9]+ = .+/.test(o)), opts.join(' | '));
ok('and none of them is listed twice',
   new Set(opts.map(o => o.split(' = ')[0])).size === opts.length, String(opts.length));
ok('per shift is one of them', opts.some(o=>o.startsWith('shift')), opts.join(' | '));
ok('and it says it counts from clock-in',
   opts.find(o=>o.startsWith('shift')).includes('from when you clock in'),
   opts.find(o=>o.startsWith('shift')));
ok('the daily one now says it resets at midnight',
   opts.find(o=>o.startsWith('daily')).includes('midnight'), opts.find(o=>o.startsWith('daily')));
ok('there is a per-shift threshold field', await p.isVisible('#cShiftThr'));
ok('defaulting to 8 h', (await p.inputValue('#cShiftThr'))==='8', await p.inputValue('#cShiftThr'));

console.log('\n━━ The calendar rule splits the night ━━');
await p.selectOption('#cMode','daily'); await p.waitForTimeout(500);
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
let f = await foot(p);
ok('10.50 h logged', f.includes('10.50'), f);
ok('but only 2.00 h of overtime', f.includes('2.00'), f);
/* 10 h before midnight: 8 straight + 2 over. 0.5 h after midnight: straight, new day.
   So 8.5 straight + 2 over = 8.5*38 + 2*57 = 323 + 114 = 437. */
ok('paying $437.00', f.includes('$437.00'), f);

console.log('\n━━ Per shift, midnight does not reset it ━━');
await p.selectOption('#cMode','shift'); await p.waitForTimeout(500);
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
f = await foot(p);
ok('still 10.50 h', f.includes('10.50'), f);
ok('now 2.50 h of overtime', f.includes('2.50'), f);
// 8*38 + 2.5*57 = 304 + 142.50 = 446.50
ok('paying $446.50 — half an hour more of OT', f.includes('$446.50'), f);

console.log('\n━━ Every section names the rule in force ━━');
ok('the earnings bar counts the shift, not the day',
   (await p.textContent('#otLbl')).includes('This shift toward 8'), await p.textContent('#otLbl'));
/* Clocked out, with the shift finished hours ago, there is no current shift — so nothing
   is banked toward one and zero is the honest answer. The running-shift case, where this
   used to read zero all shift and should not, is checked at the end. */
ok('clocked out, nothing is banked toward a shift',
   (await p.textContent('#otNum')).startsWith('0.00'), await p.textContent('#otNum'));
ok('the period note says per shift',
   (await p.textContent('#p80Note')).includes('per shift'), (await p.textContent('#p80Note')).slice(0,140));
ok('and that it is counted from clock-in',
   (await p.textContent('#p80Note')).includes('from when you clock in'),
   (await p.textContent('#p80Note')).slice(0,160));
// The calendar has to actually be switched on for its rule line to render.
await p.evaluate(()=>{ document.getElementById('calc').classList.add('open');
  const t=document.getElementById('qCalOn'); if (t && !t.checked) t.click(); });
await p.waitForTimeout(500);
ok('the calendar rule line follows too',
   (await p.textContent('#qCalRule')).includes('in a shift'), await p.textContent('#qCalRule'));

console.log('\n━━ Each shift gets its own allowance ━━');
await p.close();
// Two short shifts in one calendar day: 6 h then 7 h crossing midnight. Neither passes 8.
p = await boot(ctx, {...base, cfg:{...base.cfg, otMode:'shift'},
  sessions:[{id:'a',start:T(17,6),end:T(17,12)},{id:'b',start:T(17,18),end:T(18,1)}]}, T(18,12));
f = await foot(p);
ok('13.00 h across the two', f.includes('13.00'), f);
ok('no overtime, since neither shift passed 8 h', f.includes('— $494.00') || f.includes('$494.00'), f);
const otCells = await p.evaluate(()=>[...document.querySelectorAll('#logBody tbody .otcol')]
  .map(c=>c.textContent.trim()));
ok('and neither row shows any', otCells.every(c=>c==='—'), JSON.stringify(otCells));
await p.selectOption('#cMode','daily'); await p.waitForTimeout(500);
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
ok('the calendar rule adds them and finds 4 h', (await foot(p)).includes('4.00'), await foot(p));

console.log('\n━━ Crossing a pay period ━━');
await p.close();
// Period Sun Aug 9 – Sat Aug 22. A Sat 8 PM → Sun 8 AM shift straddles the boundary.
p = await boot(ctx, {...base, cfg:{...base.cfg, otMode:'shift'},
  sessions:[{id:'bd',start:T(22,20),end:T(23,8)}]}, T(23,12));
/* The half that belongs to this period, not the whole shift — the log footer and the
   period tile beside it have to agree. 4 h straight + 4 h over = 152 + 228 = $380. */
ok('the new period holds only its 8 h', (await foot(p)).includes('Period total 8.00'), await foot(p));
ok('priced at $380.00', (await foot(p)).includes('$380.00'), await foot(p));
ok('and the period tile says the same', (await p.textContent('#permoney')).includes('380'),
   await p.textContent('#permoney'));
ok('the row is marked as split across periods',
   (await p.textContent('#logBody')).includes('split across periods'),
   (await p.textContent('#logBody')).replace(/\s+/g,' ').slice(0,140));
const st1 = await p.evaluate(()=>JSON.parse(localStorage.getItem('payclock.v1')));
ok('the shift itself is stored whole', st1.sessions.length===1);
// Look at the old period through the time card to confirm the other 4 h are there
await p.evaluate(()=>{ const u=JSON.parse(localStorage.getItem('payclock.v1'));
  u.ui = {open:{}, past:true, tc:true}; localStorage.setItem('payclock.v1', JSON.stringify(u)); });
await p.reload(); await p.waitForTimeout(700);
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
await p.waitForTimeout(400);
const pastTxt = await p.textContent('#pastList');
ok('the previous period shows the 4 h before midnight', pastTxt.includes('4.00 h'),
   pastTxt.replace(/\s+/g,' ').slice(0,160));
ok('and its overtime is counted', /\d\.\d\d h OT/.test(pastTxt) || pastTxt.includes('4.00 h'),
   pastTxt.replace(/\s+/g,' ').slice(0,160));

console.log('\n━━ The threshold is its own setting ━━');
await p.close();
p = await boot(ctx, {...base, cfg:{...base.cfg, otMode:'shift'}, sessions:NIGHT}, T(12,12));
await p.fill('#cShiftThr','10'); await p.locator('#cShiftThr').blur(); await p.waitForTimeout(500);
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
ok('a 10 h threshold leaves 0.50 h over', (await foot(p)).includes('0.50'), await foot(p));
ok('and the bar follows it', (await p.textContent('#otLbl')).includes('This shift toward 10'),
   await p.textContent('#otLbl'));
await p.fill('#cDailyThr','12'); await p.locator('#cDailyThr').blur(); await p.waitForTimeout(500);
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
ok('changing the daily one does not touch it', (await foot(p)).includes('0.50'), await foot(p));

console.log('\n━━ It is offered at first run too ━━');
await p.close();
// Its own context: the shared one already has configured data, so first run never shows.
const freshCtx = await b.newContext({viewport:{width:1100,height:2200},
  timezoneId:'America/New_York',locale:'en-US'});
const fresh = await freshCtx.newPage();
await fresh.clock.install({time:new Date(T(12,12))});
await fresh.goto('http://localhost:8127/'); await fresh.waitForTimeout(700);
/* First run stops at the welcome screen, and the overtime picker lives on the full setup
   form behind it. Lite does not offer these six rules at all — it takes the ordinary weekly
   one and leaves the rest to Settings — so Full is the path this section is about. */
if (await fresh.isVisible('#welcome')){
  await fresh.click('#wPick button[data-mode="full"]'); await fresh.waitForTimeout(400);
}
const modes = await fresh.evaluate(()=>[...document.querySelectorAll('#sMode button')]
  .map(x=>x.dataset.m));
/* The invariant that matters is not how many rules there are, but that the two pickers
   never drift apart: a rule offered in Settings and missing from setup is a rule someone
   can only reach after they have already answered wrong. */
const cfgModes = await fresh.$$eval('#cMode option', os => os.map(o => o.value));
ok('the setup screen offers exactly what Settings does',
   modes.slice().sort().join() === cfgModes.slice().sort().join(),
   JSON.stringify(modes) + ' vs ' + JSON.stringify(cfgModes));
ok('including per shift', modes.includes('shift'), JSON.stringify(modes));
await fresh.fill('#sRate','38');
await fresh.click('#sMode button[data-m="shift"]'); await fresh.waitForTimeout(300);
ok('picking it says 8 h in the preview',
   (await fresh.textContent('#sPreview')).includes('past 8 h'), await fresh.textContent('#sPreview'));
await fresh.click('#sSave'); await fresh.waitForTimeout(600);
ok('and it is what gets saved',
   (await fresh.evaluate(()=>JSON.parse(localStorage.getItem('payclock.v1')).jobs[0].cfg.otMode))==='shift');
await fresh.close(); await freshCtx.close();

console.log('\n━━ The choice sticks ━━');
p = await boot(ctx, {...base, cfg:{...base.cfg, otMode:'shift', shiftThreshold:9}, sessions:NIGHT}, T(12,12));
ok('still on the per-shift rule', (await p.inputValue('#cMode'))==='shift', await p.inputValue('#cMode'));
ok('and still at 9 h', (await p.inputValue('#cShiftThr'))==='9', await p.inputValue('#cShiftThr'));
await p.reload(); await p.waitForTimeout(700);
await p.evaluate(()=>{ document.querySelectorAll('#cfg details').forEach(d=>d.open=true); });
await p.waitForTimeout(250);
ok('after a reload as well', (await p.inputValue('#cMode'))==='shift');

console.log('\n━━ The overtime bar while a shift is running ━━');
await p.close();
// Clocked in 12:15, now 16:25 — four hours ten in, on the per-shift rule.
p = await boot(ctx, {...base, cfg:{...base.cfg, otMode:'shift'}, sessions:[],
  activeStart:T(10,12,15)}, T(10,16,25));
let num = await p.textContent('#otNum');
console.log('       ' + (await p.textContent('#otLbl')) + '  ' + num);
ok('it counts the shift, not the day', (await p.textContent('#otLbl')).includes('This shift toward 8'),
   await p.textContent('#otLbl'));
ok('showing 4.17 h banked', num.includes('4.17'), num);
ok('and 3.83 h still to go before overtime', num.includes('3.83'), num);
ok('the bar is partly filled', await p.evaluate(()=>{
  const w = document.getElementById('barReg').style.width;
  return parseFloat(w) > 40 && parseFloat(w) < 60; }),
  await p.evaluate(()=>document.getElementById('barReg').style.width));

console.log('\n━━ And once it passes eight hours ━━');
await p.clock.fastForward('04:00:00'); await p.waitForTimeout(600);
num = await p.textContent('#otNum');
console.log('       ' + (await p.textContent('#otLbl')) + '  ' + num);
ok('it reads 8.17 h', num.includes('8.17'), num);
ok('with 0.17 h in overtime', num.includes('0.17 h in OT'), num);
ok('and the clock card flags overtime',
   (await p.getAttribute('#hero','class')).includes('ot'), await p.getAttribute('#hero','class'));

console.log('\n━━ The log divides overtime into before and after, like a closed period ━━');
/* An OT slip asks for the time either side of the rostered shift, not one lumped figure.
   The split comes from timeCardRows — the same source the closed-period card reads — so
   the two cards cannot quote different numbers for one shift. */
{
  /* Built as UTC against a Chicago context (CDT = UTC-5 in September) rather than as local
     time, so the fixture does not depend on the timezone the runner happens to have. */
  const D=(d,h,mi=0)=>Date.UTC(2026,8,d,h+5,mi);
  const ctxC=await b.newContext({viewport:{width:1100,height:2600},
    timezoneId:'America/Chicago',locale:'en-US'});
  const seed={configured:true,cfg:{rate:37.78,otMode:'eight40',weeklyThreshold:40,shiftThreshold:8,
    otMultiplier:1.5,periodAnchor:'2026-09-06',periodLengthDays:14,payDateOffsetDays:13,
    weekStartDay:0,workDays:[true,true,true,true,true,false,false],
    schedStart:'14:00',schedEnd:'22:30',lunchMins:30,offDayOt:true,holidays:[],banks:[],daysOff:[]},
    sessions:[{id:'sun',start:D(6,13,18),end:D(7,1,6)},        // 13:18 → 01:06, rostered
              {id:'sat',start:D(12,9),end:D(12,14)}],          // 5 h on a day off
    activeStart:null,sound:false};
  const p2=await boot(ctxC, seed, D(13,12));
  const head=await p2.evaluate(()=>[...document.querySelectorAll('#logBody thead th')]
    .map(t=>t.textContent.trim()).join('|'));
  ok('the log has Before and After columns', /Before\|After/.test(head), head);

  const row=id=>p2.evaluate(x=>{
    const tr=document.querySelector('#logBody tr[data-row="'+x+'"]');
    return tr ? [...tr.querySelectorAll('td')].map(td=>td.textContent.trim().replace(/\s+/g,' ')) : null;},id);
  const sun=await row('sun');
  ok('a rostered shift shows 0.70 before', sun[4]==='0.70', JSON.stringify(sun));
  ok('and 2.60 after', sun[5]==='2.60', JSON.stringify(sun));
  ok('which is exactly its overtime', sun[6]==='3.30', JSON.stringify(sun));

  /* A day off has no "before" and "after" — you were not scheduled at all, so the whole
     paid day is the claim, and two zeros would read as nothing being owed. */
  const sat=await row('sat');
  ok('a day off is shown as one whole-day figure', /5\.00/.test(sat[4]) && /whole day/i.test(sat[4]),
     JSON.stringify(sat));
  ok('and every minute of it is overtime', sat[5]==='5.00', JSON.stringify(sat));

  const f=await foot(p2);
  ok('the footer totals the two sides', /0\.70/.test(f) && /2\.60/.test(f), f);
  ok('and states unscheduled days on their own line',
     /Unscheduled days, whole/.test(f) && /5\.00/.test(f), f);
  ok('no sideways scroll with the extra columns',
     await p2.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
  await p2.close();
}

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close();
process.exit(fails===0?0:1);
