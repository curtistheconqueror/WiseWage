/* "What if I work…" — the sum done at the clock. Curtis's shape: scheduled 14:00–22:30,
   rostered Sun–Thu, half-hour unpaid lunch, $38/hr. Decimal hours are the point; money
   is a toggle. */
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
}).listen(8124);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b=await chromium.launch({executablePath: CHROME});
const T=(mo,d,h,mi=0)=>Date.UTC(2026,mo-1,d,h+4,mi);          // America/New_York, EDT
const S=(id,mo,d,h1,m1,h2,m2)=>({id,start:T(mo,d,h1,m1),end:T(mo,d,h2,m2)});

const base={configured:true,cfg:{rate:38,otMultiplier:1.5,otMode:'weekly',weeklyThreshold:40,
  periodThreshold:80,dailyThreshold:8,weekStartDay:0,periodAnchor:'2026-07-26',
  periodLengthDays:14,payDateOffsetDays:13,schedStart:'14:00',schedEnd:'22:30',lunchMins:30,
  workDays:[true,true,true,true,true,false,false],holidays:[],banks:[],daysOff:[]},
  sessions:[],activeStart:null,unit:'sec',planOn:false,plannedHours:8,sound:false,
  ui:{open:{hero:true},wif:true}};

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
  await p.goto('http://localhost:8124/'); await p.waitForTimeout(600);
  await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
  await p.waitForTimeout(300);
  return p;
}
const fig = p => p.evaluate(()=>({
  big: document.querySelector('#wifOut .wifbig')?.textContent.trim(),
  sub: document.querySelector('#wifOut .wifsub')?.textContent.trim(),
  cells: [...document.querySelectorAll('#wifOut .wifcell')].map(c=>
    c.querySelector('.k').textContent.trim()+'='+c.querySelector('.v').textContent.trim()),
  note: document.querySelector('#wifOut .wifnote')?.innerText.replace(/\s+/g,' ').trim()}));
const set = async (p, i, o) => {
  await p.fill('#wIn', i); await p.fill('#wOut', o); await p.waitForTimeout(350);
};
// Mon Aug 3 2026 at 12:15 — a scheduled day, mid-shift-ish
const ctx = await b.newContext({viewport:{width:1100,height:2200},timezoneId:'America/New_York',locale:'en-US'});

console.log('\n━━ Where it lives ━━');
let p = await boot(ctx, {...base, ui:{open:{hero:true}}}, T(8,3,12,15));
ok('the button is inside the clock card',
   await p.evaluate(()=>!!document.querySelector('#hero #wifBtn')));
ok('below the auto-stop row', await p.evaluate(()=>{
  const a=document.getElementById('planOn').closest('.planrow'), b=document.getElementById('wifBtn');
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }));
ok('folded away to start', !(await p.isVisible('#wifBody')));
await p.click('#wifBtn'); await p.waitForTimeout(400);
ok('it opens', await p.isVisible('#wifBody'));
ok('and the clock card did not collapse', await p.isVisible('#timer'),
   'tapping inside the hero must not fold it');

console.log('\n━━ It comes prefilled ━━');
ok('clock in is now — 12:15', (await p.inputValue('#wIn'))==='12:15', await p.inputValue('#wIn'));
ok('clock out is your usual finish — 22:30', (await p.inputValue('#wOut'))==='22:30',
   await p.inputValue('#wOut'));
let f = await fig(p);
console.log(`       ${f.big}  |  ${f.cells.join('  ')}`);
ok('1.75 h early', f.cells.includes('Early=1.75'), f.cells.join(' '));
ok('nothing late', f.cells.includes('Late=0.00'), f.cells.join(' '));
ok('claiming 1.75', f.big==='1.75 h', f.big);

console.log('\n━━ The case you described: in 12:15, out 12:30 AM ━━');
await set(p,'12:15','00:30');
f = await fig(p);
console.log(`       ${f.big}  |  ${f.cells.join('  ')}\n       ${f.note}`);
ok('1.75 early',  f.cells.includes('Early=1.75'), f.cells.join(' '));
ok('2.00 late',   f.cells.includes('Late=2.00'), f.cells.join(' '));
ok('3.75 to claim', f.big==='3.75 h', f.big);
ok('it says the clock-out is the next day', f.note.includes('next day'), f.note);
ok('12.25 h on the clock', f.note.includes('12.25 h'), f.note);
ok('11.75 h paid after lunch', f.note.includes('11.75 h'), f.note);

console.log('\n━━ And out at 12:45 AM ━━');
await set(p,'12:15','00:45');
f = await fig(p);
ok('2.25 late now', f.cells.includes('Late=2.25'), f.cells.join(' '));
ok('4.00 to claim', f.big==='4.00 h', f.big);

console.log('\n━━ Straight to the minute ━━');
await set(p,'13:13','22:30');           // 47 minutes early
f = await fig(p);
ok('47 minutes reads 0.78', f.cells.includes('Early=0.78'), f.cells.join(' '));
await set(p,'14:00','22:30');
f = await fig(p);
ok('bang on schedule claims nothing', f.big==='0.00 h', f.big);
ok('and both ends are zero', f.cells.includes('Early=0.00') && f.cells.includes('Late=0.00'),
   f.cells.join(' '));
await set(p,'14:00','23:17');           // 47 minutes late
f = await fig(p);
ok('47 minutes late reads 0.78', f.cells.includes('Late=0.78'), f.cells.join(' '));

console.log('\n━━ Money is off until you ask for it ━━');
ok('the toggle is there', await p.isVisible('#wPay'));
ok('and off', !(await p.isChecked('#wPay')));
ok('no money on screen', !(await p.isVisible('#wifMoney')));
await set(p,'12:15','00:30');
await p.check('#wPay'); await p.waitForTimeout(400);
ok('ticking it shows the pay', await p.isVisible('#wifMoney'));
let mny = await p.evaluate(()=>document.getElementById('wifMoney').innerText.replace(/\s+/g,' '));
console.log('       ' + mny);
// 11.75 h paid, nothing banked, weekly 40 h rule -> all straight: 11.75 * 38 = 446.50
ok('11.75 h at $38 is $446.50', mny.includes('$446.50'), mny);
ok('and all of it straight time', mny.includes('all straight time'), mny);
await p.uncheck('#wPay'); await p.waitForTimeout(350);
ok('unticking hides it again', !(await p.isVisible('#wifMoney')));

console.log('\n━━ The overtime is real, not a guess ━━');
await p.close();
/* Sun–Wed clocked 9 h each, but a half-hour lunch comes out of every one, so 34 h is
   what is actually banked. A 11.75 h Thursday leaves 6 h of headroom and 5.75 h over. */
p = await boot(ctx, {...base, sessions:[2,3,4,5].map(d=>S('w'+d,8,d,9,0,18,0)),
  ui:{open:{hero:true},wif:true,wifPay:true}}, T(8,6,12,15));
await set(p,'12:15','00:30');
mny = await p.evaluate(()=>document.getElementById('wifMoney').innerText.replace(/\s+/g,' '));
console.log('       ' + mny);
// 6 h straight + 5.75 h OT = 6*38 + 5.75*57 = 228 + 327.75 = 555.75
ok('5.75 h of it is overtime', mny.includes('5.75 h at'), mny);
ok('at $57.00/hr', mny.includes('$57.00'), mny);
ok('so the day is $555.75', mny.includes('$555.75'), mny);
/* Reworded: "Counted against the 11.00 h this shift adds to what you have already banked,
   so the overtime is what you would really be paid" was three clauses for one idea, and the
   number in it was the shift's own hours, which read as the banked total. */
ok('and it says what it counted against',
   mny.includes('Counted on top of the hours you have already worked'), mny);

console.log('\n━━ An unscheduled day counts whole ━━');
await p.close();
// Sat Aug 8 is not a rostered day
p = await boot(ctx, {...base, ui:{open:{hero:true},wif:true}}, T(8,8,9,0));
await set(p,'09:00','17:30');
f = await fig(p);
console.log(`       ${f.big}  |  ${f.cells.join('  ')}\n       ${f.sub}`);
ok('the whole paid day is the claim — 8.00', f.big==='8.00 h', f.big);
ok('and it says why', f.sub.includes('not a scheduled day') && f.sub.includes('Saturday'), f.sub);
ok('no early figure', f.cells.includes('Early=—'), f.cells.join(' '));
ok('no late figure',  f.cells.includes('Late=—'), f.cells.join(' '));
await p.evaluate(()=>{
  const s=JSON.parse(localStorage.getItem('payclock.v1'));
  s.jobs[0].cfg.workDays=[true,true,true,true,true,true,true];
  localStorage.setItem('payclock.v1',JSON.stringify(s));
});
await p.reload(); await p.waitForTimeout(700);
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
await set(p,'09:00','17:30');
f = await fig(p);
ok('rostering Saturday switches it back to edges', f.cells.includes('Early=5.00'), f.cells.join(' '));
ok('and nothing late', f.cells.includes('Late=0.00'), f.cells.join(' '));

console.log('\n━━ The Now button ━━');
await p.close();
p = await boot(ctx, {...base, ui:{open:{hero:true},wif:true}}, T(8,3,16,42));
await set(p,'08:00','12:00');
await p.click('#wNow'); await p.waitForTimeout(400);
ok('it snaps the clock-in to now', (await p.inputValue('#wIn'))==='16:42', await p.inputValue('#wIn'));
ok('and the clock-out to your usual finish', (await p.inputValue('#wOut'))==='22:30',
   await p.inputValue('#wOut'));

console.log('\n━━ Already on the clock ━━');
await p.close();
p = await boot(ctx, {...base, activeStart:T(8,3,12,15), ui:{open:{hero:true}}}, T(8,3,16,0));
await p.click('#wifBtn'); await p.waitForTimeout(400);
ok('it prefills from the shift you are on, not from now',
   (await p.inputValue('#wIn'))==='12:15', await p.inputValue('#wIn'));
await p.check('#wPay'); await p.waitForTimeout(400);
mny = await p.evaluate(()=>document.getElementById('wifMoney').innerText.replace(/\s+/g,' '));
ok('and the running shift is not counted twice', mny.includes('all straight time'), mny);
ok('the timer is still running', /^0?3:4\d:\d\d$/.test(await p.textContent('#timer')),
   await p.textContent('#timer'));

console.log('\n━━ It sticks ━━');
await p.reload(); await p.waitForTimeout(700);
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
await p.waitForTimeout(300);
ok('still open after a reload', await p.isVisible('#wifBody'));
ok('and the money toggle is still on', await p.isChecked('#wPay'));
ok('with the pay showing', await p.isVisible('#wifMoney'));

console.log('\n━━ Nothing typed ━━');
await p.fill('#wIn',''); await p.waitForTimeout(350);
ok('it asks rather than showing a wrong number',
   (await p.textContent('#wifOut')).includes('work themselves out'), await p.textContent('#wifOut'));
ok('and no money is claimed', !(await p.isVisible('#wifMoney')));

console.log('\n━━ On a phone ━━');
await p.close();
const mob = await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
  deviceScaleFactor:3,timezoneId:'America/New_York',locale:'en-US'});
p = await boot(mob, {...base, ui:{open:{hero:true},wif:true}}, T(8,3,12,15));
await set(p,'12:15','00:30');
const m = await p.evaluate(()=>({
  pageW:document.documentElement.scrollWidth, winW:window.innerWidth,
  btn:Math.round(document.getElementById('wifBtn').getBoundingClientRect().height),
  inH:Math.round(document.getElementById('wIn').getBoundingClientRect().height),
  inFs:parseFloat(getComputedStyle(document.getElementById('wIn')).fontSize),
  cells:[...document.querySelectorAll('.wifcell')].map(c=>Math.round(c.getBoundingClientRect().right)),
  bigVisible: !!document.querySelector('.wifbig')
}));
ok('no sideways scroll', m.pageW<=m.winW+1, `${m.pageW} vs ${m.winW}`);
ok('the fold-out button is a real tap target', m.btn>=44, `${m.btn}px`);
ok('the time fields are tappable', m.inH>=40, `${m.inH}px`);
ok('and will not make iOS zoom', m.inFs>=16, `${m.inFs}px`);
ok('all three figures fit on screen', m.cells.every(r=>r<=m.winW), JSON.stringify(m.cells));
ok('the big number shows', m.bigVisible);

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close();
process.exit(fails===0?0:1);
