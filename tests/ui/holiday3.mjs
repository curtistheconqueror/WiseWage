/* Stage 3: the banks. Four floaters — Birthday, Anniversary, MLK Day, Extra floater —
   and five sick days. Booking one files it against a date and it flows into that date's
   pay period, including dates still to come. */
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
}).listen(8121);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b=await chromium.launch({executablePath: CHROME});
// January 2026, America/New_York (EST, UTC-5)
const J=(d,h,mi=0)=>Date.UTC(2026,0,d,h+5,mi);
const shift=(id,d,from,to)=>({id,start:J(d,from),end:J(d,to)});

const base={configured:true,cfg:{rate:38,otMultiplier:1.5,otMode:'weekly',weeklyThreshold:40,
  periodThreshold:80,dailyThreshold:8,weekStartDay:0,periodAnchor:'2026-01-04',
  periodLengthDays:14,payDateOffsetDays:13,schedStart:'09:00',schedEnd:'17:00',
  /* Floating holidays are an add-on rather than a shipped default now, and this whole
     suite is about booking one — so the bank is seeded rather than assumed. */
  banks:[{id:'float',name:'Floating holiday',count:3,hours:8,ot:true,makeUp:false,
          slots:['MLK Day','Birthday','Anniversary']},
         {id:'sick',name:'Sick day',count:5,hours:8,ot:false,makeUp:true,slots:[]},
         {id:'vrd',name:'Vacation random day',count:5,hours:8,ot:false,makeUp:false,slots:[]}]},
  sessions:[],activeStart:null,unit:'sec',planOn:false,plannedHours:8,sound:false,
  calCal:{on:true,show:'money',otStyle:'accrue',dailyAfter:8,hours:{}}};

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
  await p.goto('http://localhost:8121/'); await p.waitForTimeout(600);
  await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
  await p.waitForTimeout(300);
  return p;
}
const st = p => p.evaluate(()=>JSON.parse(localStorage.getItem('payclock.v1')));
const logRows = p => p.evaluate(()=>[...document.querySelectorAll('#logBody tbody tr')].map(tr=>({
  day: tr.querySelector('.c-day')?.innerText.trim().replace(/\s+/g,' '),
  in:  tr.querySelector('.c-in')?.textContent.trim(),
  hrs: tr.querySelector('.c-hours')?.textContent.trim(),
  ot:  tr.querySelector('.otcol')?.textContent.trim(),
  gross: tr.querySelector('.c-gross')?.textContent.trim(),
  off: tr.classList.contains('offrowlog'),
  row: tr.getAttribute('data-row')})));
const foot = p => p.evaluate(()=>document.querySelector('#logBody tfoot')?.innerText.replace(/\s+/g,' '));
const banks = p => p.evaluate(()=>[...document.querySelectorAll('.bank')].map(x=>({
  name:x.querySelector('b').textContent, left:x.querySelector('.left').textContent,
  dots:[...x.querySelectorAll('.bankdot')].map(d=>d.innerText.replace(/\s+/g,' ').trim()),
  note:x.querySelector('.banknote').textContent})));
const ctx = await b.newContext({viewport:{width:1100,height:2800},timezoneId:'America/New_York',locale:'en-US'});

console.log('\n━━ The allowances ━━');
// Period Sun Jan 18 – Sat Jan 31; MLK Day 2026 is Mon Jan 19.
let p = await boot(ctx, {...base, sessions:[shift('a',20,9,17)]}, J(21,12));
let bk = await banks(p);
console.log(bk.map(x=>`       ${x.name}: ${x.left}\n         ${x.dots.join(' | ')}\n         ${x.note}`).join('\n'));
ok('three allowances', bk.length===3, String(bk.length));
ok('three floaters', bk[0].left==='3 of 3 left', bk[0].left);
ok('five sick days', bk[1].left==='5 of 5 left', bk[1].left);
ok('the floaters are named', bk[0].dots.join(' ').includes('Birthday') &&
   bk[0].dots.join(' ').includes('Anniversary') && bk[0].dots.join(' ').includes('MLK Day'),
   bk[0].dots.join(' | '));
ok('floaters count toward overtime', bk[0].note.includes('counts toward overtime') &&
   !bk[0].note.includes('does not'), bk[0].note);
ok('sick days do not', bk[1].note.includes('does not count toward overtime'), bk[1].note);
ok('both are 8 h at your rate', bk[0].note.includes('8 h') && bk[1].note.includes('8 h'));
ok('and reset each January', bk[0].note.includes('resets each January'));
ok('the section header counts them', (await p.textContent('#sum_banks'))==='13 of 13 left',
   await p.textContent('#sum_banks'));

console.log('\n━━ Booking MLK Day ━━');
await p.click('#offAdd'); await p.waitForTimeout(300);
ok('the editor opens', await p.isVisible('#offEdit'));
ok('offering all three allowances', (await p.locator('#oBank option').count())===3);
await p.selectOption('#oBank','float'); await p.waitForTimeout(250);
ok('and the three named floaters', (await p.locator('#oSlot option').count())===3,
   String(await p.locator('#oSlot option').count()));
await p.selectOption('#oSlot','0');                       // MLK Day, now the first
await p.fill('#oDate','2026-01-19'); await p.waitForTimeout(350);
let prev = await p.textContent('#oPreview');
ok('the preview prices it', prev.includes('$304.00'), prev.replace(/\s+/g,' '));
ok('names the pay period it lands in', prev.includes('Jan 18') && prev.includes('Jan 31'),
   prev.replace(/\s+/g,' '));
ok('and the payday', prev.includes('Feb 13'), prev.replace(/\s+/g,' '));
ok('says it counts toward overtime', prev.includes('counts toward overtime') && !prev.includes('does not'),
   prev.replace(/\s+/g,' '));
ok('and what is left after it', prev.includes('2 left after this in 2026'), prev.replace(/\s+/g,' '));
await p.click('#oSave'); await p.waitForTimeout(500);
bk = await banks(p);
ok('two floaters left', bk[0].left==='2 of 3 left', bk[0].left);
ok('MLK Day shows the date it was used', bk[0].dots.some(d=>d.includes('MLK Day') && d.includes('Jan 19')),
   bk[0].dots.join(' | '));
ok('the birthday is still free', bk[0].dots.some(d=>d.trim().startsWith('Birthday') && !/Jan|Feb/.test(d)),
   bk[0].dots.join(' | '));

console.log('\n━━ It flows into the pay period ━━');
let rows = await logRows(p);
const orow = rows.find(r=>r.off);
ok('a row appears in the log', !!orow, JSON.stringify(rows.map(r=>r.day)));
ok('named MLK Day', orow && orow.day.includes('MLK Day'), orow&&orow.day);
ok('marked DAY OFF instead of clock times', orow && orow.in==='DAY OFF', orow&&orow.in);
ok('worth 8 h', orow && orow.hrs==='8.00', orow&&orow.hrs);
ok('paid $304.00', orow && orow.gross==='$304.00', orow&&orow.gross);
ok('and cannot be edited or deleted from the log', orow && orow.row===null);
let f = await foot(p);
ok('the period total is 16 h', f.includes('16.00'), f);
ok('and $608.00', f.includes('$608.00'), f);
ok('the pay-period tile agrees', (await p.textContent('#permoney')).includes('608'),
   await p.textContent('#permoney'));

console.log('\n━━ On the calendar ━━');
await p.evaluate(()=>document.getElementById('calc').classList.add('open'));
await p.waitForTimeout(400);
ok('the day is marked', await p.evaluate(()=>
   document.querySelector('.calcell[data-d="2026-01-19"]')?.classList.contains('off')));
ok('carrying its name', (await p.getAttribute('.calcell[data-d="2026-01-19"]','data-off'))==='MLK Day',
   await p.getAttribute('.calcell[data-d="2026-01-19"]','data-off'));
await p.locator('.calcell[data-d="2026-01-19"] input').scrollIntoViewIfNeeded();
await p.locator('.calcell[data-d="2026-01-19"] input').click(); await p.waitForTimeout(300);
ok('tapping it says which day it is', (await p.textContent('#qCalRule')).includes('MLK Day'),
   await p.textContent('#qCalRule'));
await p.locator('.calcell[data-d="2026-01-19"] input').blur(); await p.waitForTimeout(200);

console.log('\n━━ Scheduling a sick day ahead of time ━━');
await p.click('#offAdd'); await p.waitForTimeout(300);
await p.selectOption('#oBank','sick'); await p.waitForTimeout(250);
ok('a sick day has no named slots to pick', !(await p.isVisible('#foSlot')));
await p.fill('#oDate','2026-01-28'); await p.waitForTimeout(350);   // a week ahead
prev = await p.textContent('#oPreview');
ok('a future date is accepted', prev.includes('Jan 28'), prev.replace(/\s+/g,' '));
ok('landing in the same period', prev.includes('Jan 18') && prev.includes('Jan 31'),
   prev.replace(/\s+/g,' '));
ok('and marked as not counting toward overtime', prev.includes('does not count toward overtime'),
   prev.replace(/\s+/g,' '));
await p.click('#oSave'); await p.waitForTimeout(500);
bk = await banks(p);
ok('four sick days left', bk[1].left==='4 of 5 left', bk[1].left);
f = await foot(p);
ok('the scheduled day is already in the period total — 24 h', f.includes('24.00'), f);
ok('and $912.00', f.includes('$912.00'), f);
rows = await logRows(p);
ok('with its own row', rows.filter(r=>r.off).length===2, String(rows.filter(r=>r.off).length));

console.log('\n━━ A sick day does not move the overtime line, a floater does ━━');
await p.close();
// Sun Jan 18 – Thu Jan 22 at 9 h = 45 h in the week.
const week=[18,19,20,21,22].map(d=>shift('w'+d,d,9,18));
p = await boot(ctx, {...base, sessions:week}, J(23,12));
f = await foot(p);
ok('45 h with 5 h of overtime to start', f.includes('45.00') && f.includes('5.00'), f);
await p.click('#offAdd'); await p.waitForTimeout(300);
await p.selectOption('#oBank','sick'); await p.fill('#oDate','2026-01-19'); await p.waitForTimeout(300);
await p.click('#oSave'); await p.waitForTimeout(500);
f = await foot(p);
ok('a sick day adds 8 h', f.includes('53.00'), f);
ok('but overtime stays at 5 h', f.includes('5.00'), f);
/* Swap it for a floater on the same day. Giving a day back goes through the editor now:
   the chip opens it, and the panel carries the button that gives the day up. It used to be
   one tap on a 12px ✕ in the list, with nothing between a mis-tap and a lost day. */
await p.locator('#bankBody button[data-offedit]').first().click(); await p.waitForTimeout(300);
await p.click('#oDel'); await p.waitForTimeout(400);
await p.click('#offAdd'); await p.waitForTimeout(300);
await p.selectOption('#oBank','float'); await p.waitForTimeout(250);
await p.selectOption('#oSlot','0'); await p.fill('#oDate','2026-01-19'); await p.waitForTimeout(300);
await p.click('#oSave'); await p.waitForTimeout(500);
f = await foot(p);
ok('a floater adds the same 8 h', f.includes('53.00'), f);
ok('but pushes overtime to 13 h', f.includes('13.00'), f);
rows = await logRows(p);
ok('the floater itself stays straight time', rows.find(r=>r.off)?.ot==='—', rows.find(r=>r.off)?.ot);

console.log('\n━━ Giving one back ━━');
bk = await banks(p);
ok('two floaters left while booked', bk[0].left==='2 of 3 left', bk[0].left);
await p.locator('#bankBody button[data-offedit]').first().click(); await p.waitForTimeout(300);
ok('the editor opens on the day you tapped, ready to change it',
   (await p.textContent('#offTitle')).includes('Change this day off'), await p.textContent('#offTitle'));
ok('and the save button agrees it is a change, not a booking',
   (await p.textContent('#oSave')).includes('Save changes'), await p.textContent('#oSave'));
/* Moving a booked day to another date. None of this could be reached before: the editor
   supported it, but nothing in the list ever opened it for an existing day, so correcting
   a date meant giving the day back and booking it again.
   The second assertion is the one that matters — saveDayOff excludes the day being
   changed from its own allowance check, so moving a day must not spend a second one. */
await p.fill('#oDate','2026-01-20'); await p.waitForTimeout(250);
await p.click('#oSave'); await p.waitForTimeout(500);
bk = await banks(p);
ok('the day moved to the new date', bk[0].dots.some(d=>d.includes('Jan 20')), bk[0].dots.join(' | '));
ok('and moving it did not spend a second one', bk[0].left==='2 of 3 left', bk[0].left);

await p.locator('#bankBody button[data-offedit]').first().click(); await p.waitForTimeout(300);
await p.click('#oDel'); await p.waitForTimeout(500);
bk = await banks(p);
ok('all three back', bk[0].left==='3 of 3 left', bk[0].left);
ok('the log row is gone', !(await logRows(p)).some(r=>r.off));
ok('and the total is back to 45 h', (await foot(p)).includes('45.00'), await foot(p));

console.log('\n━━ The allowance is enforced ━━');
await p.close();
p = await boot(ctx, {...base, sessions:[shift('a',20,9,17)]}, J(21,12));
for (const [slot,date] of [['0','2026-02-02'],['1','2026-02-03'],['2','2026-02-04']]){
  await p.click('#offAdd'); await p.waitForTimeout(250);
  await p.selectOption('#oBank','float'); await p.waitForTimeout(200);
  await p.selectOption('#oSlot',slot); await p.fill('#oDate',date); await p.waitForTimeout(200);
  await p.click('#oSave'); await p.waitForTimeout(400);
}
bk = await banks(p);
ok('all three spent', bk[0].left==='0 of 3 left', bk[0].left);
await p.click('#offAdd'); await p.waitForTimeout(300);
await p.selectOption('#oBank','float'); await p.waitForTimeout(250);
const disabled = await p.locator('#oSlot option:disabled').count();
ok('every named floater is shown as used', disabled===3, String(disabled));
await p.fill('#oDate','2026-02-10'); await p.waitForTimeout(200);
await p.click('#oSave'); await p.waitForTimeout(400);
ok('booking a fifth is refused', await p.isVisible('#oErr'));
// The named-slot check fires first and gives the more specific answer.
const err = await p.textContent('#oErr');
ok('with a reason you can act on', /already (used|booked)/.test(err), err);
ok('naming the year it applies to', err.includes('2026'), err);
ok('and nothing was added', (await st(p)).jobs[0].cfg.daysOff.length===3,
   String((await st(p)).jobs[0].cfg.daysOff.length));
await p.click('#oCancel'); await p.waitForTimeout(250);

console.log('\n━━ Next year starts full ━━');
await p.click('#offAdd'); await p.waitForTimeout(300);
await p.selectOption('#oBank','float'); await p.fill('#oDate','2027-01-18'); await p.waitForTimeout(350);
prev = await p.textContent('#oPreview');
ok('2027 has all three again', prev.includes('2 left after this in 2027'), prev.replace(/\s+/g,' '));
ok('and its slots are offered', (await p.locator('#oSlot option:disabled').count())===0,
   String(await p.locator('#oSlot option:disabled').count()));
await p.click('#oCancel'); await p.waitForTimeout(250);

console.log('\n━━ Both kinds on the same day as a paid holiday ━━');
await p.close();
// New Year's Day 2026 is Thu Jan 1. Roster Sun–Thu: either side is Wed Dec 31 and Sun Jan 4.
p = await boot(ctx, {...base,
  sessions:[{id:'d31',start:Date.UTC(2025,11,31,14),end:Date.UTC(2025,11,31,22)},
            shift('j4',4,9,17)],
  cfg:{...base.cfg, periodAnchor:'2025-12-28'}}, J(5,12));
rows = await logRows(p);
ok('the holiday pays', rows.some(r=>r.day.includes("New Year")), JSON.stringify(rows.map(r=>r.day)));
await p.click('#offAdd'); await p.waitForTimeout(300);
await p.selectOption('#oBank','float'); await p.waitForTimeout(250);
await p.selectOption('#oSlot','1'); await p.fill('#oDate','2026-01-01'); await p.waitForTimeout(300);
await p.click('#oSave'); await p.waitForTimeout(500);
rows = await logRows(p);
ok('and the floater pays alongside it, as two entries',
   rows.some(r=>r.day.includes("New Year")) && rows.some(r=>r.off && r.day.includes('Birthday')),
   JSON.stringify(rows.map(r=>r.day+(r.off?' [off]':''))));
ok('16 h worked + 8 h holiday + 8 h floater = 32 h', (await foot(p)).includes('32.00'), await foot(p));

console.log('\n━━ It survives a reload ━━');
await p.reload(); await p.waitForTimeout(700);
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
await p.waitForTimeout(300);
bk = await banks(p);
ok('the booking is still there', bk[0].left==='2 of 3 left', bk[0].left);
ok('and still in the total', (await foot(p)).includes('32.00'), await foot(p));

console.log('\n━━ On a phone ━━');
await p.close();
const mob = await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
  deviceScaleFactor:3,timezoneId:'America/New_York',locale:'en-US'});
p = await boot(mob, {...base, sessions:[shift('a',20,9,17)],
  cfg:{...base.cfg, daysOff:[{id:'x',bank:'float',slot:2,date:'2026-01-19',hours:8}]}}, J(21,12));
const m = await p.evaluate(()=>({
  pageW:document.documentElement.scrollWidth, winW:window.innerWidth,
  dot:Math.round(document.querySelector('.bankdot').getBoundingClientRect().height),
  row:!!document.querySelector('tr.offrowlog')
}));
ok('no sideways scroll', m.pageW<=m.winW+1, `${m.pageW} vs ${m.winW}`);
ok('the chips are readable', m.dot>=24, `${m.dot}px`);
ok('and the log row shows', m.row);

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close();
process.exit(fails===0?0:1);
