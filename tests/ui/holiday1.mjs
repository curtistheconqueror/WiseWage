/* Stage 1 of holiday pay: the roster, the holiday definitions, and the calendar marking
   them. No money moves yet — this stage exists so the dates can be checked before any
   pay depends on them. */
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
  if(path==='/favicon.ico'){r.writeHead(204);return r.end();}   // Chromium asks unprompted
  const f=R+path;
  if(!existsSync(f)){r.writeHead(404);return r.end('nope');}
  r.writeHead(200,{'Content-Type':TYPES[path.slice(path.lastIndexOf('.'))]||'application/octet-stream'});
  r.end(readFileSync(f));
}).listen(8119);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b=await chromium.launch({executablePath: CHROME});
const D=(d,h,mi=0)=>Date.UTC(2026,7,d,h+4,mi);

const base={configured:true,cfg:{rate:38,otMultiplier:1.5,otMode:'weekly',weeklyThreshold:40,
  periodThreshold:80,dailyThreshold:8,weekStartDay:0,periodAnchor:'2026-08-02',
  periodLengthDays:14,payDateOffsetDays:13,schedStart:'14:00',schedEnd:'22:30'},
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
  await p.goto('http://localhost:8119/'); await p.waitForTimeout(600);
  await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
  await p.evaluate(()=>{ document.querySelectorAll('#cfg details').forEach(d=>d.open=true); });
  await p.waitForTimeout(250);
  return p;
}
const st = p => p.evaluate(()=>JSON.parse(localStorage.getItem('payclock.v1')));
const ctx = await b.newContext({viewport:{width:1100,height:2600},timezoneId:'America/New_York',locale:'en-US'});

console.log('\n━━ The roster ━━');
let p = await boot(ctx, base, D(11,12));
ok('there are seven day buttons', (await p.locator('#cWorkDays button').count())===7);
// Sunday through Thursday out of the box — the roster Curtis actually works.
ok('it defaults to five days', (await p.locator('#cWorkDays button.on').count())===5,
   String(await p.locator('#cWorkDays button.on').count()));
const dayOn = w => p.evaluate(x=>document.querySelector('#cWorkDays button[data-w="'+x+'"]').classList.contains('on'), w);
ok('Sunday is on',   await dayOn(0));
ok('Thursday is on', await dayOn(4));
ok('Friday is off', !(await dayOn(5)));
ok('Saturday is off',!(await dayOn(6)));
await p.click('#cWorkDays button[data-w="5"]'); await p.waitForTimeout(250);
ok('turning Friday on makes six', (await p.locator('#cWorkDays button.on').count())===6,
   String(await p.locator('#cWorkDays button.on').count()));
await p.click('#cWorkDays button[data-w="5"]'); await p.waitForTimeout(250);
ok('and off again puts it back to five', (await p.locator('#cWorkDays button.on').count())===5);
let note = await p.textContent('#cWorkNote');
ok('and it says so in words', note.includes('5 days') && note.includes('Sunday') && !note.includes('Friday'), note);
ok('saved to settings', JSON.stringify((await st(p)).jobs[0].cfg.workDays)==='[true,true,true,true,true,false,false]',
   JSON.stringify((await st(p)).jobs[0].cfg.workDays));
await p.reload(); await p.waitForTimeout(600);
await p.evaluate(()=>{ document.querySelectorAll('#cfg details').forEach(d=>d.open=true); });
await p.waitForTimeout(200);
ok('and survives a reload', (await p.locator('#cWorkDays button.on').count())===5);

console.log('\n━━ The six holidays ━━');
const rows = await p.evaluate(()=>[...document.querySelectorAll('#cHolList .holrow')]
  .map(r=>({name:r.querySelector('.hnm').textContent,
            when:r.querySelector('.hwhen').innerText.replace(/\n/g,' | '),
            on:r.querySelector('.hon').checked,
            ot:r.querySelector('.hotf').textContent.trim()})));
console.log(rows.map(r=>`       ${r.name} — ${r.when}`).join('\n'));
ok('six are listed', rows.length===6, String(rows.length));
ok('all switched on', rows.every(r=>r.on));
// The six pay eight flat hours and earn no overtime credit, per the contract.
ok('none of them counts toward overtime', rows.every(r=>r.ot!=='OT'), rows.map(r=>r.ot).join('|'));
const want = {"New Year's Day":'Jan 1','Memorial Day':'May 25','Independence Day':'Jul 4',
              'Labor Day':'Sep 7','Thanksgiving Day':'Nov 26','Christmas Day':'Dec 25'};
let bad=[];
for (const [n,d] of Object.entries(want)){
  const r = rows.find(x=>x.name===n);
  if (!r) bad.push(n+' missing'); else if (!r.when.includes(d)) bad.push(`${n}: ${r.when} want ${d}`);
}
ok('every 2026 date is right', bad.length===0, bad.join('; '));

console.log('\n━━ Marked on the calendar ━━');
await p.evaluate(()=>document.getElementById('calc').classList.add('open'));
await p.waitForTimeout(400);
const marked = await p.evaluate(()=>[...document.querySelectorAll('.calcell.hol')]
  .map(c=>({d:c.dataset.d, n:c.dataset.hol, dot:!!c.querySelector('.holdot')})));
console.log('       marked: ' + marked.map(m=>m.d+' '+m.n).join(', '));
ok('the holidays in view are marked', marked.length>0, String(marked.length));
ok('each carries its name', marked.every(m=>m.n && m.n.length>2));
ok('and a corner dot', marked.every(m=>m.dot));
ok('Labor Day 2026 is one of them', marked.some(m=>m.d==='2026-09-07' && m.n==='Labor Day'),
   JSON.stringify(marked.map(m=>m.d)));
ok('an ordinary day is not marked',
   !(await p.evaluate(()=>document.querySelector('.calcell[data-d="2026-09-08"]').classList.contains('hol'))));

console.log('\n━━ The legend under the grid ━━');
const leg = await p.evaluate(()=>[...document.querySelectorAll('#qCalHols .calhol')]
  .map(r=>r.querySelector('.n').textContent+' = '+r.querySelector('.d').textContent));
console.log(leg.map(l=>'       '+l).join('\n'));
ok('all six are listed', leg.length===6, String(leg.length));
ok('with real dates', leg.some(l=>l.includes('Labor Day') && l.includes('Sep 7')), leg.join(' | '));
ok('in date order', leg[0].includes("New Year") && leg[5].includes('Christmas'), leg.join(' | '));

console.log('\n━━ Tapping a holiday says which one it is ━━');
await p.locator('.calcell[data-d="2026-09-07"] input').scrollIntoViewIfNeeded();
await p.locator('.calcell[data-d="2026-09-07"] input').click();
await p.waitForTimeout(300);
let rule = await p.textContent('#qCalRule');
ok('the line names the holiday', rule.includes('Labor Day'), rule);
ok('alongside the date', rule.includes('Sep 7'), rule);
await p.locator('.calcell[data-d="2026-09-08"] input').click(); await p.waitForTimeout(250);
ok('an ordinary day names no holiday', !(await p.textContent('#qCalRule')).includes('Labor Day'),
   await p.textContent('#qCalRule'));
await p.locator('.calcell[data-d="2026-09-08"] input').blur(); await p.waitForTimeout(200);

console.log('\n━━ Switching one off ━━');
await p.evaluate(()=>{ document.querySelectorAll('#cfg details').forEach(d=>d.open=true); });
await p.locator('#cHolList .hon').nth(3).uncheck(); await p.waitForTimeout(400);
ok('it drops off the calendar',
   !(await p.evaluate(()=>document.querySelector('.calcell[data-d="2026-09-07"]').classList.contains('hol'))));
ok('and out of the legend', !(await p.textContent('#qCalHols')).includes('Labor Day'));
ok('the others stay', (await p.locator('#qCalHols .calhol').count())===5,
   String(await p.locator('#qCalHols .calhol').count()));
await p.locator('#cHolList .hon').nth(3).check(); await p.waitForTimeout(400);
ok('and it comes back', (await p.locator('#qCalHols .calhol').count())===6);

console.log('\n━━ Adding your own ━━');
await p.click('#cHolAdd'); await p.waitForTimeout(300);
await p.fill('#hName','Good Friday');
await p.selectOption('#hKind','on'); await p.waitForTimeout(200);
await p.fill('#hDate','2026-04-03'); await p.waitForTimeout(300);
let prev = await p.textContent('#hPreview');
ok('the preview shows the date it lands on', prev.includes('Apr 3, 2026'), prev.replace(/\s+/g,' '));
ok('and says the next years do not repeat it', prev.includes('does not fall'), prev.replace(/\s+/g,' '));
await p.click('#hSave'); await p.waitForTimeout(400);
ok('now seven holidays', (await p.locator('#cHolList .holrow').count())===7,
   String(await p.locator('#cHolList .holrow').count()));
ok('and it is in the legend', (await p.textContent('#qCalHols')).includes('Good Friday'));

console.log('\n━━ A weekday rule ━━');
await p.click('#cHolAdd'); await p.waitForTimeout(300);
await p.fill('#hName','Third Friday');
await p.selectOption('#hKind','nth'); await p.waitForTimeout(200);
await p.selectOption('#hMonth','9'); await p.selectOption('#hNth','3'); await p.selectOption('#hDow','5');
await p.waitForTimeout(300);
prev = await p.textContent('#hPreview');
// 3rd Friday of October 2026 is the 16th; 2027 is the 15th; 2028 the 20th
ok('the preview works out three years ahead',
   prev.includes('Oct 16, 2026') && prev.includes('Oct 15, 2027') && prev.includes('Oct 20, 2028'),
   prev.replace(/\s+/g,' '));
ok('and describes the rule in words', prev.includes('3rd Friday of October'), prev.replace(/\s+/g,' '));
await p.click('#hCancel'); await p.waitForTimeout(250);
ok('cancelling adds nothing', (await p.locator('#cHolList .holrow').count())===7);

console.log('\n━━ Editing and removing ━━');
await p.locator('#cHolList button[data-hedit]').nth(0).click(); await p.waitForTimeout(300);
ok('the editor opens on that holiday', (await p.inputValue('#hName'))==="New Year's Day",
   await p.inputValue('#hName'));
await p.fill('#hName','New Year'); await p.selectOption('#hOt','0'); await p.waitForTimeout(200);
await p.click('#hSave'); await p.waitForTimeout(400);
ok('the rename sticks', (await p.textContent('#cHolList')).includes('New Year'));
ok('and the OT flag came off', (await p.evaluate(()=>
   [...document.querySelectorAll('#cHolList .holrow')][0].querySelector('.hotf').textContent.trim()))==='');
ok('still on the calendar', (await p.textContent('#qCalHols')).includes('New Year'));
await p.locator('#cHolList button[data-hdel]').last().click(); await p.waitForTimeout(400);
ok('removing takes one away', (await p.locator('#cHolList .holrow').count())===6,
   String(await p.locator('#cHolList .holrow').count()));

console.log('\n━━ Putting it back from a standard set ━━');
await p.selectOption('#cHolPreset','common'); await p.waitForTimeout(400);
ok('the six most common return', (await p.locator('#cHolList .holrow').count())===6);
ok('with their names', (await p.textContent('#cHolList')).includes("New Year's Day"));
ok('and all paying flat, none toward overtime',
   (await p.locator('#cHolList .hotf').allTextContents()).every(t=>t.trim()!=='OT'),
   (await p.locator('#cHolList .hotf').allTextContents()).join('|'));

/* Six-or-nothing was the old choice, and it could not express what the Postal Service and
   most federal employers observe. */
console.log('\n━━ The federal set, which six-or-nothing could not say ━━');
await p.selectOption('#cHolPreset','fed'); await p.waitForTimeout(400);
ok('eleven holidays', (await p.locator('#cHolList .holrow').count())===11,
   String(await p.locator('#cHolList .holrow').count()));
{
  const names = await p.textContent('#cHolList');
  ok('including Juneteenth', names.includes('Juneteenth'));
  ok('and MLK Day', names.includes('Martin Luther King'));
  ok('and Veterans Day', names.includes('Veterans Day'));
}
await p.selectOption('#cHolPreset','none'); await p.waitForTimeout(400);
ok('and it can be cleared to none', (await p.locator('#cHolList .holrow').count())===0);
await p.selectOption('#cHolPreset','common'); await p.waitForTimeout(400);

console.log('\n━━ The holiday settings ━━');
ok('a holiday is worth 8 h by default', (await p.inputValue('#cHolHours'))==='8', await p.inputValue('#cHolHours'));
ok('either side is required by default', (await p.inputValue('#cHolAdj'))==='1');
ok('and a day off still pays by default', (await p.inputValue('#cHolOffDay'))==='1');
await p.fill('#cHolHours','10'); await p.locator('#cHolHours').blur(); await p.waitForTimeout(300);
ok('the hours can be changed', (await st(p)).jobs[0].cfg.holidayHours===10, String((await st(p)).jobs[0].cfg.holidayHours));
await p.selectOption('#cHolAdj','0'); await p.waitForTimeout(250);
ok('as can the either-side rule', (await st(p)).jobs[0].cfg.holidayNeedsAdjacent===false);

console.log('\n━━ It all survives a reload and a backup ━━');
await p.reload(); await p.waitForTimeout(700);
await p.evaluate(()=>{ document.querySelectorAll('#cfg details').forEach(d=>d.open=true);
                       document.getElementById('calc').classList.add('open'); });
await p.waitForTimeout(400);
ok('six holidays still there', (await p.locator('#cHolList .holrow').count())===6);
ok('10 h still set', (await p.inputValue('#cHolHours'))==='10');
ok('roster still Sun–Thu', (await p.locator('#cWorkDays button.on').count())===5);
ok('calendar still marks them', (await p.locator('.calcell.hol').count())>0);

console.log('\n━━ Nothing has touched your pay yet ━━');
const money = await p.textContent('#permoney');
ok('the period total is still zero', money.includes('0.00'), money);
ok('and the shift log is untouched', (await p.textContent('#logBody')).length > 0);

console.log('\n━━ A name with markup in it is text, not markup ━━');
await p.click('#cHolAdd'); await p.waitForTimeout(300);
await p.fill('#hName','<img src=x onerror=alert(1)>Break');
await p.waitForTimeout(250);
await p.click('#hSave'); await p.waitForTimeout(400);
ok('no injected element appears', (await p.locator('#cHolList img').count())===0);
ok('the name shows as typed', (await p.textContent('#cHolList')).includes('<img src=x'),
   (await p.textContent('#cHolList')).slice(0,120));

console.log('\n━━ On a phone ━━');
await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(400);
const m = await p.evaluate(()=>({
  pageW:document.documentElement.scrollWidth, winW:window.innerWidth,
  dayBtn:Math.round(document.querySelector('#cWorkDays button').getBoundingClientRect().height),
  holRow:Math.round(document.querySelector('#cHolList .holrow').getBoundingClientRect().height)
}));
ok('no sideways scroll', m.pageW<=m.winW+1, `${m.pageW} vs ${m.winW}`);
ok('day buttons are tappable', m.dayBtn>=28, `${m.dayBtn}px`);
ok('holiday rows are readable', m.holRow>=30, `${m.holRow}px`);

console.log('\n━━ The clock card says when today is a paid holiday ━━');
/* The credit was added by the ledger and announced nowhere. Working a paid holiday looked
   identical to working an ordinary day: eight hours appeared in the period total and the
   card somebody actually watches said nothing about where they came from. */
{
  const U=(d,h,mi=0)=>Date.UTC(2026,8,d,h+5,mi);            // Chicago CDT
  const ctxC=await b.newContext({viewport:{width:430,height:1100},
    timezoneId:'America/Chicago',locale:'en-US'});
  const cfg={rate:37.78,otMode:'eight40',weeklyThreshold:40,shiftThreshold:8,otMultiplier:1.5,
    periodAnchor:'2026-09-06',periodLengthDays:14,payDateOffsetDays:13,weekStartDay:0,
    workDays:[true,true,true,true,true,false,false],schedStart:'14:00',schedEnd:'22:30',
    lunchMins:30,banks:[],daysOff:[]};
  const sun={id:'sun',start:U(6,13,18),end:U(7,1,6)};        // Sun before Labor Day
  const tue={id:'tue',start:U(8,14),end:U(8,22,30)};         // Tue after it
  const mk=(sess,active)=>({configured:true,cfg,sessions:sess,activeStart:active,sound:false});

  /* Earned, and clocked in on the day. */
  let h1=await boot(ctxC, mk([sun,tue], U(7,14)), U(7,19,19));
  ok('the bar shows on a paid holiday', await h1.isVisible('#holBar'));
  {
    const t=(await h1.textContent('#holBar')).replace(/\s+/g,' ');
    ok('it names the holiday', /Labor Day/.test(t), t.slice(0,70));
    ok('and states the hours and the money', /8\.00 h/.test(t) && /\$302\.24/.test(t), t.slice(0,110));
    ok('and says the figures above do not include it',
       /worked hours only/.test(t), t.slice(0,190));
  }
  await h1.close();

  /* Not earned YET is the case worth shouting about: on the morning of the holiday it is
     still something you can act on. */
  let h2=await boot(ctxC, mk([sun], U(7,14)), U(7,19,19));
  ok('an unearned holiday is flagged differently',
     /pending/.test(await h2.getAttribute('#holBar','class')),
     await h2.getAttribute('#holBar','class'));
  {
    const t=(await h2.textContent('#holBar')).replace(/\s+/g,' ');
    ok('and names the day still to work', /Tue Sep 8/.test(t), t.slice(0,140));
  }
  await h2.close();

  /* Not clocked in: the wording must not claim hours are being added to a clock that is
     not running. */
  let h3=await boot(ctxC, mk([sun,tue], null), U(7,10));
  {
    const t=(await h3.textContent('#holBar')).replace(/\s+/g,' ');
    ok('with no clock running it does not talk about clocking',
       !/you are clocking/.test(t), t.slice(0,150));
  }
  await h3.close();

  /* An ordinary day says nothing at all. */
  let h4=await boot(ctxC, mk([sun,tue], null), U(8,19));
  ok('an ordinary day shows no bar', !(await h4.isVisible('#holBar')));
  await h4.close();

  /* A night shift begun on the holiday is still judged against the holiday, not against
     the date the clock happens to show now. */
  let h5=await boot(ctxC, mk([sun,tue], U(7,22)), U(8,1,30));
  ok('a shift begun on the holiday still shows it after midnight',
     await h5.isVisible('#holBar'));
  await h5.close();

  /* The version marker: a build stamp that lies is worse than none. */
  let h6=await boot(ctxC, mk([sun,tue], null), U(8,19));
  const shown=(await h6.textContent('#appVer')).replace(/[^v0-9]/g,'');
  const swv=(readFileSync(R+'sw.js','utf8').match(/wisewage-(v\d+)/)||[])[1];
  ok('the footer states the build', /^v\d+$/.test(shown), shown);
  ok('and it matches the service worker', shown===swv, shown+' vs '+swv);
  await h6.close();
}

console.log('\n━━ The earnings tiles say which hours arrived and which were worked ━━');
/* Holiday hours are straight time, so they land in regHours alongside hours actually
   worked. A week with a paid holiday in it simply read eight hours heavier and nothing
   said why. */
{
  const U=(d,h,mi=0)=>Date.UTC(2026,8,d,h+5,mi);            // Chicago CDT
  const ctxT=await b.newContext({viewport:{width:430,height:1200},
    timezoneId:'America/Chicago',locale:'en-US'});
  const cfg={rate:37.78,otMode:'eight40',weeklyThreshold:40,shiftThreshold:8,otMultiplier:1.5,
    periodAnchor:'2026-09-06',periodLengthDays:14,payDateOffsetDays:13,weekStartDay:0,
    workDays:[true,true,true,true,true,false,false],schedStart:'14:00',schedEnd:'22:30',
    lunchMins:30,banks:[],daysOff:[]};
  const sun={id:'sun',start:U(6,13,18),end:U(7,1,6)};
  const mon={id:'mon',start:U(7,14),end:U(7,23,17)};        // Labor Day, worked
  const tue={id:'tue',start:U(8,14),end:U(8,22,30)};        // earns the holiday

  let t1=await boot(ctxT, {configured:true,cfg,sessions:[sun,mon,tue],activeStart:null,sound:false},
    U(9,12));
  {
    const d=(await t1.innerText('#wDet')).replace(/\s+/g,' ');
    ok('the holiday has a line of its own', /8\.00 h holiday/.test(d), d);
    ok('at straight time', /8\.00 h holiday @ \$37\.78/.test(d), d);
    ok('and it is not double-counted into the worked hours',
       /24\.00 h reg/.test(d), d);
    ok('overtime still stands separately', /4\.08 h OT @ \$56\.67/.test(d), d);
    ok('the line is marked as a holiday', (await t1.locator('#wDet .holline').count())===1);
  }
  await t1.close();

  /* Before the day after is worked the holiday is not earned, so nothing is claimed. */
  let t2=await boot(ctxT, {configured:true,cfg,sessions:[sun,mon],activeStart:null,sound:false},
    U(8,10));
  {
    const d=(await t2.innerText('#wDet')).replace(/\s+/g,' ');
    ok('an unearned holiday adds no line', !/holiday/.test(d), d);
    ok('and no hours', /16\.00 h reg/.test(d), d);
  }
  await t2.close();
}

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close();
process.exit(fails===0?0:1);
