/* The decimal time card for a closed pay period. Curtis's real shape: scheduled
   14:00–22:30, rostered Sun–Thu, half-hour unpaid lunch. Fri and Sat are not scheduled,
   so the whole paid day counts rather than the edges. */
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
}).listen(8123);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b=await chromium.launch({executablePath: CHROME});
// America/New_York, EDT (UTC-4) through Jul/Aug 2026
const T=(mo,d,h,mi=0)=>Date.UTC(2026,mo-1,d,h+4,mi);
const S=(id,mo,d,h1,m1,h2,m2)=>({id,start:T(mo,d,h1,m1),end:T(mo,d,h2,m2)});

const base={configured:true,cfg:{rate:38,otMultiplier:1.5,otMode:'weekly',weeklyThreshold:40,
  periodThreshold:80,dailyThreshold:8,weekStartDay:0,periodAnchor:'2026-07-26',
  periodLengthDays:14,payDateOffsetDays:13,schedStart:'14:00',schedEnd:'22:30',lunchMins:30,
  workDays:[true,true,true,true,true,false,false],holidays:[],banks:[],daysOff:[]},
  sessions:[],activeStart:null,unit:'sec',planOn:false,plannedHours:8,sound:false,
  ui:{open:{},past:false,tc:true}};

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
  await p.goto('http://localhost:8123/'); await p.waitForTimeout(600);
  await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
  await p.waitForTimeout(300);
  return p;
}
const tcRows = p => p.evaluate(()=>[...document.querySelectorAll('#tcList .tcrow:not(.head)')].map(r=>({
  day: r.querySelector('.d').textContent.trim(),
  clocked: r.querySelector('.t').textContent.replace(/\s+/g,' ').trim(),
  early: r.querySelector('.b').textContent.trim(),
  late: r.querySelector('.a').textContent.trim(),
  claim: r.querySelector('.x').textContent.trim(),
  whole: r.classList.contains('un')})));
const tcSum = p => p.evaluate(()=>document.querySelector('#tcList .tcsum')?.innerText.replace(/\s+/g,' '));

/* A fortnight in Curtis's shape. Period Sun Jul 26 – Sat Aug 8, standing on Aug 10.
     Sun Aug 2  12:33 – 23:03   1h27 early, 33 min late
     Mon Aug 3  14:00 – 00:15   on time,    1h45 late
     Tue Aug 4  14:00 – 00:01   on time,    1h31 late
     Wed Aug 5  12:31 – 00:01   1h29 early, 1h31 late
     Thu Aug 6  12:32 – 23:55   1h28 early, 1h25 late
     Fri Aug 7  09:00 – 17:30   NOT scheduled — whole paid day (8.00)
     Sat Aug 8  09:30 – 18:00   NOT scheduled — whole paid day (8.00)          */
const WEEK=[S('sun',8,2,12,33,23,3), S('mon',8,3,14,0,24,15), S('tue',8,4,14,0,24,1),
            S('wed',8,5,12,31,24,1), S('thu',8,6,12,32,23,55),
            S('fri',8,7,9,0,17,30),  S('sat',8,8,9,30,18,0),
            S('next',8,10,14,0,22,30)];   // in the following period, must not appear
const ctx = await b.newContext({viewport:{width:1100,height:2800},timezoneId:'America/New_York',locale:'en-US'});

console.log('\n━━ Where it sits ━━');
let p = await boot(ctx, {...base, sessions:WEEK, ui:{open:{},tc:false}}, T(8,10,18));
ok('the button is in the pay period card',
   await p.evaluate(()=>!!document.querySelector('#period #tcBtn')));
ok('below the previous-periods one', await p.evaluate(()=>{
  const a=document.getElementById('pastBtn'), b=document.getElementById('tcBtn');
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }));
ok('folded away to start', !(await p.isVisible('#tcBody')));
await p.click('#tcBtn'); await p.waitForTimeout(400);
ok('it opens', await p.isVisible('#tcBody'));
ok('and the section stays open', await p.isVisible('#prange'));

console.log('\n━━ It defaults to the period that just closed ━━');
ok('the picker shows Jul 26 – Aug 8', (await p.locator('#tcPick').inputValue()) !== '' &&
   (await p.textContent('#tcPick')).includes('Jul 26'), await p.textContent('#tcPick'));
let sched = await p.textContent('#tcSched');
ok('it states the scheduled shift', sched.includes('2:00 PM') && sched.includes('10:30 PM'), sched);
ok('and names the unscheduled days', sched.includes('Fri') && sched.includes('Sat'), sched);

console.log('\n━━ The days ━━');
let rows = await tcRows(p);
console.log(rows.map(r=>`       ${r.day.padEnd(22)} ${r.clocked.padEnd(34)} ${r.early.padStart(5)} ${r.late.padStart(5)} ${r.claim.padStart(5)}`).join('\n'));
ok('seven days from that period', rows.length===7, String(rows.length));
ok('the next period is left out', !rows.some(r=>r.day.includes('Aug 10')),
   JSON.stringify(rows.map(r=>r.day)));

const by = d => rows.find(r=>r.day.includes(d));
ok('Sun Aug 2 — 1.45 early',  by('Aug 2').early==='1.45', by('Aug 2').early);
ok('and 0.55 late',            by('Aug 2').late==='0.55',  by('Aug 2').late);
ok('claiming 2.00',            by('Aug 2').claim==='2.00', by('Aug 2').claim);
ok('Mon Aug 3 — nothing early', by('Aug 3').early==='—',   by('Aug 3').early);
ok('and 1.75 late',            by('Aug 3').late==='1.75',  by('Aug 3').late);
ok('Tue Aug 4 — 1.52 late',    by('Aug 4').late==='1.52',  by('Aug 4').late);
ok('Wed Aug 5 — 1.48 and 1.52', by('Aug 5').early==='1.48' && by('Aug 5').late==='1.52',
   by('Aug 5').early+' / '+by('Aug 5').late);
ok('claiming 3.00',            by('Aug 5').claim==='3.00', by('Aug 5').claim);
ok('Thu Aug 6 — 1.47 and 1.42', by('Aug 6').early==='1.47' && by('Aug 6').late==='1.42',
   by('Aug 6').early+' / '+by('Aug 6').late);
ok('claiming 2.89, not 2.88',  by('Aug 6').claim==='2.89', by('Aug 6').claim);

console.log('\n━━ The unscheduled days ━━');
ok('Friday is flagged as a whole day', by('Aug 7').whole===true);
ok('and says so on the row', by('Aug 7').day.includes('WHOLE DAY'), by('Aug 7').day);
ok('with no early column', by('Aug 7').early==='—', by('Aug 7').early);
ok('no late column',        by('Aug 7').late==='—',  by('Aug 7').late);
ok('and a clean 8.00 claim', by('Aug 7').claim==='8.00', by('Aug 7').claim);
ok('the clocked line shows 8.00 h paid after lunch',
   by('Aug 7').clocked.includes('8.00 h paid'), by('Aug 7').clocked);
ok('Saturday the same — 8.00', by('Aug 8').claim==='8.00', by('Aug 8').claim);
ok('even though it was clocked 8:30', by('Aug 8').clocked.includes('9:30 AM') &&
   by('Aug 8').clocked.includes('6:00 PM'), by('Aug 8').clocked);
ok('a scheduled day is not flagged', by('Aug 2').whole===false);

console.log('\n━━ The totals ━━');
let sum = await tcSum(p);
console.log('       ' + sum);
ok('early totals 4.40', sum.includes('Before your shift 4.40 h'), sum);
ok('late totals 6.76',  sum.includes('After your shift 6.76 h'), sum);
ok('unscheduled days total 16.00', sum.includes('Unscheduled days, whole 16.00 h'), sum);
ok('and the claim is 27.16 h', sum.includes('Total to claim 27.16 h'), sum);
ok('7 days clocked', sum.includes('7 days clocked'), sum);
// 27.16 * 38 * 1.5 = 1548.12
ok('priced at the overtime rate — $1,548.12', sum.includes('$1,548.12'), sum);
ok('and it says booked days are excluded', sum.includes('left out'), sum);

console.log('\n━━ Rounding matches the slip ━━');
// two 47-minute early starts: 0.78 each, 1.56 together — not 1.57
await p.close();
p = await boot(ctx, {...base, sessions:[S('a',8,3,13,13,22,30), S('b',8,4,13,13,22,30)]}, T(8,10,18));
rows = await tcRows(p);
ok('each 47-minute start reads 0.78', rows.every(r=>r.early==='0.78'),
   JSON.stringify(rows.map(r=>r.early)));
ok('and two of them total 1.56', (await tcSum(p)).includes('Before your shift 1.56 h'),
   await tcSum(p));

console.log('\n━━ Picking a different period ━━');
await p.close();
// Mon Jul 20 sits in the period BEFORE Jul 26 – Aug 8, so there are genuinely two closed.
p = await boot(ctx, {...base, sessions:WEEK.concat([S('old',7,20,12,0,23,0)])}, T(8,10,18));
ok('two periods to choose from', (await p.locator('#tcPick option').count())===2,
   String(await p.locator('#tcPick option').count()));
ok('the newest is selected', (await p.locator('#tcPick').inputValue())==='0',
   await p.locator('#tcPick').inputValue());
await p.selectOption('#tcPick','-1'); await p.waitForTimeout(450);
rows = await tcRows(p);
ok('the older period shows its own day', rows.length===1 && rows[0].day.includes('Jul 20'),
   JSON.stringify(rows.map(r=>r.day)));
ok('with its own figures', rows[0].early==='2.00' && rows[0].late==='0.50',
   rows[0].early+' / '+rows[0].late);
await p.reload(); await p.waitForTimeout(700);
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
await p.waitForTimeout(300);
ok('the choice sticks across a reload', (await p.locator('#tcPick').inputValue())==='-1',
   await p.locator('#tcPick').inputValue());

console.log('\n━━ Edges ━━');
await p.close();
p = await boot(ctx, {...base, sessions:[S('a',8,10,14,0,22,30)]}, T(8,10,18));  // nothing closed
ok('before anything closes it explains itself',
   (await p.textContent('#tcList')).includes('once it ends'), await p.textContent('#tcList'));
await p.close();
p = await boot(ctx, {...base, sessions:[S('n',8,10,14,0,22,30), S('o',7,27,14,0,22,30)],
  cfg:{...base.cfg, schedStart:'', schedEnd:''}}, T(8,10,18));
/* It used to send people to "the Decimal Time Conversion section", where the schedule
   fields had been removed — a message naming a control that is not there. */
ok('with no schedule set it says where to actually fix that',
   (await p.textContent('#tcSched')).includes('Settings'), await p.textContent('#tcSched'));
ok('and claims nothing rather than guessing', (await tcRows(p))[0].claim==='—',
   (await tcRows(p))[0].claim);

console.log('\n━━ Every day scheduled ━━');
await p.close();
p = await boot(ctx, {...base, sessions:WEEK,
  cfg:{...base.cfg, workDays:[true,true,true,true,true,true,true]}}, T(8,10,18));
rows = await tcRows(p);
ok('no whole-day rows', rows.every(r=>!r.whole));
sum = await tcSum(p);
ok('and no unscheduled line in the totals', !sum.includes('Unscheduled days'), sum);
ok('Friday now claims only its edges', (await tcRows(p)).find(r=>r.day.includes('Aug 7')).claim!=='8.00',
   (await tcRows(p)).find(r=>r.day.includes('Aug 7')).claim);

console.log('\n━━ It follows a correction in the shift log ━━');
await p.close();
p = await boot(ctx, {...base, sessions:WEEK}, T(8,10,18));
ok('Sun Aug 2 starts at 1.45', (await tcRows(p)).find(r=>r.day.includes('Aug 2')).early==='1.45');
await p.evaluate(()=>{
  const s=JSON.parse(localStorage.getItem('payclock.v1'));
  const sun=s.sessions.find(x=>x.id==='sun');
  sun.start = Date.UTC(2026,7,2,17,0);            // 13:00 local — one hour early instead
  localStorage.setItem('payclock.v1', JSON.stringify(s));
});
await p.reload(); await p.waitForTimeout(700);
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
await p.waitForTimeout(300);
ok('correcting the shift corrects the card',
   (await tcRows(p)).find(r=>r.day.includes('Aug 2')).early==='1.00',
   (await tcRows(p)).find(r=>r.day.includes('Aug 2')).early);

console.log('\n━━ On a phone ━━');
await p.close();
const mob = await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
  deviceScaleFactor:3,timezoneId:'America/New_York',locale:'en-US'});
p = await boot(mob, {...base, sessions:WEEK}, T(8,10,18));
const m = await p.evaluate(()=>({
  pageW:document.documentElement.scrollWidth, winW:window.innerWidth,
  btn:Math.round(document.getElementById('tcBtn').getBoundingClientRect().height),
  claimRight:Math.round(document.querySelector('#tcList .tcrow:not(.head) .x').getBoundingClientRect().right),
  pick:Math.round(document.getElementById('tcPick').getBoundingClientRect().height),
  pickFs:parseFloat(getComputedStyle(document.getElementById('tcPick')).fontSize)
}));
ok('no sideways scroll', m.pageW<=m.winW+1, `${m.pageW} vs ${m.winW}`);
ok('the button is a real tap target', m.btn>=44, `${m.btn}px`);
ok('the claim column is on screen', m.claimRight<=m.winW, `${m.claimRight} vs ${m.winW}`);
ok('the period picker is tappable', m.pick>=40, `${m.pick}px`);
ok('and will not make iOS zoom', m.pickFs>=16, `${m.pickFs}px`);

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close();
process.exit(fails===0?0:1);
