/* Nobody inherits anybody else's contract. First run asks the questions; Settings lets
   every answer be changed afterwards. Tested as a stranger with a different job: rostered
   Mon–Fri 7am–3:30pm, no lunch, 2 personal days, 10 sick days, no paid holidays. */
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
}).listen(8125);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b=await chromium.launch({executablePath: CHROME});

async function fresh(ctx, atMs){
  const p=await ctx.newPage();
  p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});
  p.on('console',m=>{if(m.type()==='error'){console.log('  CONSOLE ERROR:',m.text());fails++;}});
  await p.clock.install({time:new Date(atMs)});
  await p.goto('http://localhost:8125/'); await p.waitForTimeout(700);
  /* First run stops at the welcome screen now — Lite or Full — and setup comes after it.
     This suite is about what the full setup form asks and stores, so every fresh page here
     takes the Full path through that screen. Done in the helper rather than at each call
     site: there are six, and one missed would fail thirty assertions down the page with a
     timeout on a field that is simply not on screen yet. */
  if (await p.isVisible('#welcome')){
    await p.click('#wPick button[data-mode="full"]'); await p.waitForTimeout(400);
  }
  return p;
}
const st = p => p.evaluate(()=>JSON.parse(localStorage.getItem('payclock.v1')));
const dayOn = (p,w) => p.evaluate(x=>document.querySelector('#sWorkDays button[data-w="'+x+'"]').classList.contains('on'), w);
const cfgDayOn = (p,w) => p.evaluate(x=>document.querySelector('#cWorkDays button[data-w="'+x+'"]').classList.contains('on'), w);
const ctx = await b.newContext({viewport:{width:1100,height:2800},timezoneId:'America/New_York',locale:'en-US'});
const NOW = Date.UTC(2026,7,10,16);   // Mon Aug 10 2026, noon EDT

console.log('\n━━ A first visit asks everything ━━');
let p = await fresh(ctx, NOW);
ok('the setup screen is showing', await p.isVisible('#setup'));
ok('and the clock is not', !(await p.isVisible('#hero')));
for (const [id,label] of [['sRate','hourly rate'],['sAnchor','period start'],['sLen','period length'],
     ['sPay','payday'],['sSchedStart','shift start'],['sSchedEnd','shift end'],['sLunch','lunch'],
     ['sHolPreset','paid holidays'],['sBankAdd','paid days off'],['sOffHours','hours each']]){
  ok(`it asks about ${label}`, await p.isVisible('#'+id), id);
}
ok('and which days you work', (await p.locator('#sWorkDays button').count())===7);

/* Holidays used to be six-or-nothing, which could not express what the Postal Service and
   most federal employers observe, and allowances were two hardcoded rows with five sick
   days already filled in. Nobody was asked; they were told. */
console.log('\n━━ Holidays are offered rather than assumed ━━');
ok('every holiday it knows is offered to tick',
   (await p.locator('#sHolPick .holtick').count())
     === (await p.evaluate(() => HOLIDAY_CATALOG().length)),
   String(await p.locator('#sHolPick .holtick').count()));
ok('the six most common start ticked',
   (await p.locator('#sHolPick input:checked').count()) === 6,
   String(await p.locator('#sHolPick input:checked').count()));
await p.selectOption('#sHolPreset','fed'); await p.waitForTimeout(300);
ok('the federal set ticks eleven',
   (await p.locator('#sHolPick input:checked').count()) === 11,
   String(await p.locator('#sHolPick input:checked').count()));
/* A preset seeds the ticks; the ticks are then the truth. Unticking one must not disturb
   the other ten. */
await p.locator('#sHolPick input[data-hpick="columbus"]').uncheck(); await p.waitForTimeout(250);
ok('unticking one leaves the other ten alone',
   (await p.locator('#sHolPick input:checked').count()) === 10,
   String(await p.locator('#sHolPick input:checked').count()));
ok('and it shows when each one lands',
   /Nov/.test(await p.textContent('#sHolPick')), (await p.textContent('#sHolPick')).slice(0,120));
await p.selectOption('#sHolPreset','none'); await p.waitForTimeout(300);
ok('and none is a complete answer', (await p.locator('#sHolPick input:checked').count()) === 0);

console.log('\n━━ The make-up question is asked of the rules it applies to, and only those ━━');
ok('not asked of the weekly rule', !(await p.isVisible('#sMakeUpWrap')));
await p.click('#sMode button[data-m="period"]'); await p.waitForTimeout(250);
ok('nor the pay-period rule', !(await p.isVisible('#sMakeUpWrap')));
await p.click('#sMode button[data-m="daily"]'); await p.waitForTimeout(250);
ok('but it is of the daily rule', await p.isVisible('#sMakeUpWrap'));
await p.click('#sMode button[data-m="shift"]'); await p.waitForTimeout(250);
ok('and the per-shift rule', await p.isVisible('#sMakeUpWrap'));
let muTxt = (await p.textContent('#sMakeUp')).replace(/\s+/g,' ');
console.log('       ' + muTxt);
ok('offering both answers', (await p.locator('#sMakeUp button').count())===2);
ok('with make-up chosen to start',
   await p.evaluate(()=>document.querySelector('#sMakeUp button[data-mu="1"]').classList.contains('on')));
ok('and the other one named for what it is', /California/.test(muTxt), muTxt);
await p.click('#sMode button[data-m="weekly"]'); await p.waitForTimeout(250);
ok('switching back to weekly hides it again', !(await p.isVisible('#sMakeUpWrap')));

console.log('\n━━ It will not start without the answers ━━');
await p.click('#sSave'); await p.waitForTimeout(300);
ok('no rate is refused', await p.isVisible('#sErr'));
ok('and says what is missing', (await p.textContent('#sErr')).includes('per hour'), await p.textContent('#sErr'));
await p.fill('#sRate','24.50'); await p.waitForTimeout(250);
await p.fill('#sSchedStart',''); await p.waitForTimeout(200);
await p.click('#sSave'); await p.waitForTimeout(300);
ok('no shift times is refused too', (await p.textContent('#sErr')).includes('shift usually starts'),
   await p.textContent('#sErr'));
ok('still on the setup screen', await p.isVisible('#setup'));

console.log('\n━━ Answering as somebody with a different job ━━');
await p.fill('#sSchedStart','07:00'); await p.fill('#sSchedEnd','15:30');
await p.selectOption('#sLunch','0');
await p.selectOption('#sHolPreset','none'); await p.waitForTimeout(200);
await p.selectOption('#sBankAdd','float'); await p.waitForTimeout(200);
await p.selectOption('#sBankAdd','sick');  await p.waitForTimeout(200);
await p.locator('#sBankList .bankrow').nth(0).locator('[data-bct]').fill('2');
await p.locator('#sBankList .bankrow').nth(1).locator('[data-bct]').fill('10');
await p.fill('#sOffHours','8.5');
// Mon–Fri, not Sun
await p.click('#sWorkDays button[data-w="0"]'); await p.waitForTimeout(150);
await p.click('#sWorkDays button[data-w="5"]'); await p.waitForTimeout(300);
ok('Sunday off',  !(await dayOn(p,0)));
ok('Friday on',     await dayOn(p,5));
ok('Saturday off',!(await dayOn(p,6)));
let prev = await p.textContent('#sPreview');
console.log('       ' + prev.replace(/\s+/g,' '));
ok('the preview states the shift', prev.includes('7:00 AM') && prev.includes('3:30 PM'), prev);
ok('says all time is paid', prev.includes('all time paid'), prev);
ok('names the days off', prev.includes('Sun') && prev.includes('Sat'), prev);
ok('says there are no paid holidays', prev.includes('No paid holidays'), prev);
ok('and lists the allowances', prev.includes('2 floating holidays') && prev.includes('10 sick days'),
   prev);

console.log('\n━━ Starting tracking ━━');
await p.click('#sSave'); await p.waitForTimeout(600);
ok('setup closes', !(await p.isVisible('#setup')));
ok('the clock appears', await p.isVisible('#hero'));
let s = await st(p);
ok('the rate is theirs — $24.50', s.jobs[0].cfg.rate===24.5, String(s.jobs[0].cfg.rate));
ok('the roster is Mon–Fri', JSON.stringify(s.jobs[0].cfg.workDays)==='[false,true,true,true,true,true,false]',
   JSON.stringify(s.jobs[0].cfg.workDays));
ok('the shift is 07:00–15:30', s.jobs[0].cfg.schedStart==='07:00' && s.jobs[0].cfg.schedEnd==='15:30',
   s.jobs[0].cfg.schedStart+' '+s.jobs[0].cfg.schedEnd);
ok('no lunch is deducted', s.jobs[0].cfg.lunchMins===0, String(s.jobs[0].cfg.lunchMins));
ok('no holidays were assumed', s.jobs[0].cfg.holidays.length===0, String(s.jobs[0].cfg.holidays.length));
ok('two allowances, theirs', s.jobs[0].cfg.banks.length===2, JSON.stringify(s.jobs[0].cfg.banks.map(x=>x.name+':'+x.count)));
ok('2 floating days', s.jobs[0].cfg.banks[0].count===2, String(s.jobs[0].cfg.banks[0].count));
ok('10 sick days',    s.jobs[0].cfg.banks[1].count===10, String(s.jobs[0].cfg.banks[1].count));
ok('worth 8.5 h each', s.jobs[0].cfg.banks.every(x=>x.hours===8.5), JSON.stringify(s.jobs[0].cfg.banks.map(x=>x.hours)));
ok('floating counts toward OT, sick does not', s.jobs[0].cfg.banks[0].ot===true && s.jobs[0].cfg.banks[1].ot===false);
ok('nothing is booked yet', (s.jobs[0].cfg.daysOff||[]).length===0);

console.log('\n━━ None of my defaults leaked through ━━');
ok('not $38/hr', s.jobs[0].cfg.rate!==38);
ok('not Sun–Thu', JSON.stringify(s.jobs[0].cfg.workDays)!=='[true,true,true,true,true,false,false]');
ok('not 14:00–22:30', s.jobs[0].cfg.schedStart!=='14:00');
ok('not four floaters and five sick days',
   !(s.jobs[0].cfg.banks[0].count===4 && s.jobs[0].cfg.banks[1].count===5));
/* Rendered elements, not textContent('body') — the <script> lives inside body, so that
   would match the source code rather than anything on screen. */
await p.evaluate(()=>{ document.querySelectorAll('.col').forEach(c=>c.classList.add('open')); });
await p.waitForTimeout(400);
ok('no holidays are marked on the calendar', (await p.locator('.calcell.hol').count())===0,
   String(await p.locator('.calcell.hol').count()));
ok('and the holiday legend is not shown', !(await p.isVisible('#qCalHols')));

console.log('\n━━ Settings shows it all back ━━');
await p.evaluate(()=>{ document.querySelectorAll('#cfg details').forEach(d=>d.open=true);
                       document.querySelectorAll('.col').forEach(c=>c.classList.add('open')); });
await p.waitForTimeout(400);
ok('the scheduled shift is in Settings', await p.isVisible('#cSchedStart2'));
ok('showing 07:00', (await p.inputValue('#cSchedStart2'))==='07:00', await p.inputValue('#cSchedStart2'));
ok('and 15:30',     (await p.inputValue('#cSchedEnd2'))==='15:30', await p.inputValue('#cSchedEnd2'));
ok('the roster matches', !(await cfgDayOn(p,0)) && await cfgDayOn(p,5) && !(await cfgDayOn(p,6)));
const bankCfg = await p.evaluate(()=>[...document.querySelectorAll('#cBankList .bankcfg')].map(x=>({
  name:x.querySelector('input[data-bf="name"]').value,
  count:x.querySelector('input[data-bf="count"]').value,
  hours:x.querySelector('input[data-bf="hours"]').value,
  ot:x.querySelector('select[data-bf="ot"]').value})));
console.log('       ' + JSON.stringify(bankCfg));
ok('both allowances are editable', bankCfg.length===2, String(bankCfg.length));
ok('with their real numbers', bankCfg[0].count==='2' && bankCfg[1].count==='10',
   JSON.stringify(bankCfg));
ok('and their hours', bankCfg.every(x=>x.hours==='8.5'), JSON.stringify(bankCfg));

console.log('\n━━ Changing an allowance in Settings ━━');
await p.fill('#cBankList input[data-bf="count"]','3');
await p.locator('#cBankList input[data-bf="count"]').first().blur(); await p.waitForTimeout(450);
ok('the count saves', (await st(p)).jobs[0].cfg.banks[0].count===3, String((await st(p)).jobs[0].cfg.banks[0].count));
ok('and the balance follows', (await p.textContent('#bankBody')).includes('3 of 3 left'),
   (await p.textContent('#bankBody')).slice(0,90));
await p.locator('#cBankList select[data-bf="ot"]').first().selectOption('0'); await p.waitForTimeout(400);
ok('the overtime answer saves', (await st(p)).jobs[0].cfg.banks[0].ot===false);
ok('and the note says so', (await p.textContent('#bankBody')).includes('does not count toward overtime'),
   (await p.textContent('#bankBody')).slice(0,220));
await p.fill('#cBankList input[data-bf="name"]','Personal day');
await p.locator('#cBankList input[data-bf="name"]').first().blur(); await p.waitForTimeout(450);
ok('renaming works', (await p.textContent('#bankBody')).includes('Personal day'),
   (await p.textContent('#bankBody')).slice(0,90));

console.log('\n━━ Naming the individual days ━━');
ok('unnamed to start', (await p.locator('#cBankList .slots input').count())===0);
await p.locator('#cBankList input[data-bnamed]').first().check(); await p.waitForTimeout(450);
ok('ticking it gives one field per day', (await p.locator('#cBankList .slots input').count())===3,
   String(await p.locator('#cBankList .slots input').count()));
await p.locator('#cBankList .slots input').first().fill('Birthday');
await p.locator('#cBankList .slots input').first().blur(); await p.waitForTimeout(450);
ok('the name reaches the balances', (await p.textContent('#bankBody')).includes('Birthday'),
   (await p.textContent('#bankBody')).slice(0,120));
await p.locator('#cBankList input[data-bnamed]').first().uncheck(); await p.waitForTimeout(450);
ok('unticking goes back to a plain count',
   (await p.locator('#cBankList .slots input').count())===0);

console.log('\n━━ Adding and removing an allowance ━━');
/* Adding is a picker rather than a button now — a floating holiday is a real kind you
   choose, not a generic row you then have to rename. */
await p.selectOption('#cBankAdd','float'); await p.waitForTimeout(500);
ok('a third appears', (await p.locator('#cBankList .bankcfg').count())===3,
   String(await p.locator('#cBankList .bankcfg').count()));
ok('and it is the kind that was picked',
   (await p.textContent('#cBankList')).includes('Floating holiday')
   || (await p.inputValue('#cBankList input[data-bf="name"] >> nth=2'))==='Floating holiday',
   await p.inputValue('#cBankList input[data-bf="name"] >> nth=2'));
ok('and shows in the balances', (await p.locator('#bankBody .bank').count())===3);
await p.locator('#cBankList button[data-bdel]').last().click(); await p.waitForTimeout(500);
ok('removing takes it away', (await p.locator('#cBankList .bankcfg').count())===2);
ok('and out of the balances', (await p.locator('#bankBody .bank').count())===2);

console.log('\n━━ Removing one that has days booked ━━');
await p.click('#offAdd'); await p.waitForTimeout(350);
await p.fill('#oDate','2026-08-12'); await p.waitForTimeout(300);
await p.click('#oSave'); await p.waitForTimeout(500);
ok('a day is booked', (await st(p)).jobs[0].cfg.daysOff.length===1);
const bookedBank = (await st(p)).jobs[0].cfg.daysOff[0].bank;
const idx = await p.evaluate(bid=>(JSON.parse(localStorage.getItem('payclock.v1')).jobs[0].cfg.banks)
  .findIndex(x=>x.id===bid), bookedBank);
await p.locator('#cBankList button[data-bdel]').nth(idx).click(); await p.waitForTimeout(550);
ok('the booked day goes with it', (await st(p)).jobs[0].cfg.daysOff.length===0,
   JSON.stringify((await st(p)).jobs[0].cfg.daysOff));
ok('and it says how many', (await p.textContent('#toast')).includes('booked from it'),
   await p.textContent('#toast'));

console.log('\n━━ What the answer stores ━━');
{
  const q = await fresh(await b.newContext({viewport:{width:1100,height:2800},
    timezoneId:'America/New_York',locale:'en-US'}), NOW);
  await q.fill('#sRate','30'); await q.fill('#sSchedStart','08:00'); await q.fill('#sSchedEnd','16:30');
  await q.click('#sMode button[data-m="daily"]'); await q.waitForTimeout(250);
  await q.click('#sMakeUp button[data-mu="0"]'); await q.waitForTimeout(250);
  await q.click('#sSave'); await q.waitForTimeout(600);
  const c = (await st(q)).jobs[0].cfg;
  ok('answering no leaves the rule off', c.makeUpOn === false, String(c.makeUpOn));
  ok('with the daily rule saved', c.otMode === 'daily', c.otMode);
  await q.close();

  const r = await fresh(await b.newContext({viewport:{width:1100,height:2800},
    timezoneId:'America/New_York',locale:'en-US'}), NOW);
  await r.fill('#sRate','30'); await r.fill('#sSchedStart','08:00'); await r.fill('#sSchedEnd','16:30');
  await r.click('#sMode button[data-m="shift"]'); await r.waitForTimeout(250);
  await r.click('#sSave'); await r.waitForTimeout(600);
  ok('leaving it as it comes turns it on', (await st(r)).jobs[0].cfg.makeUpOn === true);
  ok('and Settings agrees', (await r.inputValue('#cMakeUp')) === '1', await r.inputValue('#cMakeUp'));
  await r.close();

  const w = await fresh(await b.newContext({viewport:{width:1100,height:2800},
    timezoneId:'America/New_York',locale:'en-US'}), NOW);
  await w.fill('#sRate','30'); await w.fill('#sSchedStart','08:00'); await w.fill('#sSchedEnd','16:30');
  await w.click('#sSave'); await w.waitForTimeout(600);
  ok('the weekly rule never carries it', (await st(w)).jobs[0].cfg.makeUpOn === false);
  await w.close();
}

/* "Back to the defaults" used to restore five sick days and five Pace vacation random days
   — numbers nobody had asked for. There are no defaults to go back to now, so the control
   says what it actually does. */
console.log('\n━━ Clearing the allowances ━━');
await p.click('#cBankReset'); await p.waitForTimeout(450);
const back = await p.evaluate(()=>[...document.querySelectorAll('#cBankList input[data-bf="count"]')].map(x=>x.value));
ok('removing them leaves nothing invented in their place', JSON.stringify(back)==='[]', JSON.stringify(back));
ok('and the button says remove rather than reset',
   /remove/i.test(await p.textContent('#cBankReset')), await p.textContent('#cBankReset'));
/* Put the two back so the reload check below still has something to find. */
await p.selectOption('#cBankAdd','sick'); await p.waitForTimeout(250);
await p.selectOption('#cBankAdd','vrd');  await p.waitForTimeout(250);

console.log('\n━━ The scheduled shift is one value in two places ━━');
await p.fill('#cSchedStart2','06:30'); await p.locator('#cSchedStart2').blur(); await p.waitForTimeout(450);
ok('Settings saves it', (await st(p)).jobs[0].cfg.schedStart==='06:30', (await st(p)).jobs[0].cfg.schedStart);
/* The decimal card states the schedule rather than offering it for editing — it used to
   carry a second live field, which somebody typed a punch into and rewrote their roster. */
ok('and the decimal section states the same', /6:30/.test(await p.textContent('#xSchedVal')),
   await p.textContent('#xSchedVal'));
ok('with no second editable copy to clobber', (await p.locator('#extra input#cSchedStart').count())===0);
await p.fill('#cSchedStart2','07:15'); await p.locator('#cSchedStart2').blur(); await p.waitForTimeout(450);
ok('changing it in Settings updates the card', /7:15/.test(await p.textContent('#xSchedVal')),
   await p.textContent('#xSchedVal'));
ok('and only one value is stored', (await st(p)).jobs[0].cfg.schedStart==='07:15');

console.log('\n━━ It all survives a reload ━━');
await p.reload(); await p.waitForTimeout(800);
await p.evaluate(()=>{ document.querySelectorAll('#cfg details').forEach(d=>d.open=true);
                       document.querySelectorAll('.col').forEach(c=>c.classList.add('open')); });
await p.waitForTimeout(400);
ok('rate still $24.50', (await p.inputValue('#cRate'))==='24.5', await p.inputValue('#cRate'));
ok('shift still 07:15', (await p.inputValue('#cSchedStart2'))==='07:15');
ok('roster still Mon–Fri', !(await cfgDayOn(p,0)) && await cfgDayOn(p,5));
ok('allowances still there', (await p.locator('#cBankList .bankcfg').count())===2,
   String(await p.locator('#cBankList .bankcfg').count()));

console.log('\n━━ On a phone ━━');
await p.close();
const mob = await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
  deviceScaleFactor:3,timezoneId:'America/New_York',locale:'en-US'});
p = await fresh(mob, NOW);
const m = await p.evaluate(()=>({
  pageW:document.documentElement.scrollWidth, winW:window.innerWidth,
  day:Math.round(document.querySelector('#sWorkDays button').getBoundingClientRect().height),
  time:Math.round(document.getElementById('sSchedStart').getBoundingClientRect().height),
  fs:parseFloat(getComputedStyle(document.getElementById('sSchedStart')).fontSize)
}));
ok('setup does not scroll sideways', m.pageW<=m.winW+1, `${m.pageW} vs ${m.winW}`);
ok('the day buttons are tappable', m.day>=28, `${m.day}px`);
ok('the time fields are tappable', m.time>=40, `${m.time}px`);
ok('and will not make iOS zoom', m.fs>=16, `${m.fs}px`);

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close();
process.exit(fails===0?0:1);
