import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;
// Scratch files (backups under test, screenshots) go to a temp dir, never the repo.
const TMP = join(process.env.TMPDIR || '/tmp', 'wisewage-tests');
try { (await import('node:fs')).mkdirSync(TMP, { recursive: true }); } catch {}


const KEY='payclock.v1';
const srv = http.createServer((q, r) => {
  const R = ROOT;
  if (q.url.startsWith('/sw.js')) { r.writeHead(200,{'Content-Type':'text/javascript'}); return r.end(readFileSync(R+'sw.js')); }
  if (q.url.startsWith('/manifest')) { r.writeHead(200,{'Content-Type':'application/manifest+json'}); return r.end(readFileSync(R+'manifest.webmanifest')); }
  if (q.url.indexOf('.png') > -1) { r.writeHead(404); return r.end(); }
  r.writeHead(200,{'Content-Type':'text/html'}); r.end(readFileSync(R+'index.html'));
}).listen(8094);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const openAll=async pg=>{ try{ await pg.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open'))); }catch(e){} };
const b=await chromium.launch({executablePath: CHROME});

async function boot(ctx, seed){
  const p=await ctx.newPage();
  p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});
  p.on('console',m=>{if(m.type()==='error'){console.log('  CONSOLE ERROR:',m.text());fails++;}});
  await p.addInitScript(([k,v])=>{
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded','1');
    if (v) localStorage.setItem(k,JSON.stringify(v)); else localStorage.removeItem(k);
  },[KEY,seed]);
  await p.clock.install({time:new Date('2026-08-05T17:00:00Z')});
  await p.goto('http://localhost:8094/'); await p.waitForTimeout(350); await openAll(p);
  return p;
}

// Period anchored Sun Aug 2 2026, 14 days -> ends Sat Aug 15, payday +13 = Fri Aug 28
const seeded={configured:true,cfg:{rate:38,otMultiplier:1.5,otMode:'weekly',weeklyThreshold:40,periodThreshold:80,
  periodAnchor:'2026-08-02',periodLengthDays:14,payDateOffsetDays:13},sessions:[],activeStart:null,unit:'sec',planOn:false,sound:false};

console.log('\nDefaults come from your real settings — nothing entered twice');
let ctx = await b.newContext({viewport:{width:1000,height:1600}});
let p = await boot(ctx, seeded);

ok('pay frequency defaults to "Use my settings"', (await p.inputValue('#qFreq'))==='', await p.inputValue('#qFreq'));
ok('"Use my rate" checked by default', await p.isChecked('#qMyRate'));
ok('rate box shows your real rate', (await p.inputValue('#qRate'))==='38', await p.inputValue('#qRate'));
ok('rate box is locked while using your rate', await p.locator('#qRate').isDisabled());
ok('starts with exactly one hours row', (await p.locator('#qRows .qrow').count())===1, String(await p.locator('#qRows .qrow').count()));
ok('first row defaults to Regular', (await p.locator('#qRows .qrow select').first().inputValue())==='reg');
ok('payday prefilled from your settings (Fri Aug 28)', (await p.inputValue('#qPayday'))==='2026-08-28', await p.inputValue('#qPayday'));
ok('payday note names the date', (await p.textContent('#qPaydayNote')).includes('Aug 28'), await p.textContent('#qPaydayNote'));
ok('OT option shows your real multiplier (1.5×)', (await p.textContent('#qRows select')).includes('Overtime (1.5×)'), await p.textContent('#qRows select'));
ok('double + triple time offered', (await p.textContent('#qRows select')).includes('Double time (2×)') && (await p.textContent('#qRows select')).includes('Triple time (3×)'));

console.log('\nSingle regular row calculates live');
await p.fill('#qRows .qrow input[data-f=hours]','8');
await p.waitForTimeout(150);
let txt = await p.textContent('#qResult');
ok('8 h regular @ $38 -> $304.00', txt.includes('8.00 h regular @ $38.00') && txt.includes('$304.00'), txt);
ok('gross total line present', txt.includes('8.00 h — gross'), txt);

console.log('\n"Add another" adds an overtime row — the ADP-style flow');
await p.click('#qAddRow');
await p.waitForTimeout(150);
ok('now two rows', (await p.locator('#qRows .qrow').count())===2, String(await p.locator('#qRows .qrow').count()));
ok('added row defaults to Overtime', (await p.locator('#qRows .qrow select').nth(1).inputValue())==='ot');
ok('delete buttons appear once there are 2+ rows', (await p.locator('#qRows [data-del-row]').count())===2);
await p.locator('#qRows .qrow input[data-f=hours]').nth(1).fill('2');
await p.waitForTimeout(150);
txt = await p.textContent('#qResult');
// 8*38=304, 2*38*1.5=114, total 418, 10h
ok('OT row priced at $57.00/h', txt.includes('2.00 h overtime @ $57.00'), txt);
ok('OT row pays $114.00', txt.includes('$114.00'), txt);
ok('total is 10.00 h / $418.00', txt.includes('10.00 h — gross') && txt.includes('$418.00'), txt);

console.log('\nDouble time and triple time');
await p.locator('#qRows .qrow select').nth(1).selectOption('dbl');
await p.waitForTimeout(150);
txt = await p.textContent('#qResult');
// 2 * 38 * 2 = 152 ; total 304+152 = 456
ok('double time @ $76.00/h', txt.includes('2.00 h double time @ $76.00'), txt);
ok('double time total $456.00', txt.includes('$456.00'), txt);
await p.locator('#qRows .qrow select').nth(1).selectOption('trip');
await p.waitForTimeout(150);
txt = await p.textContent('#qResult');
// 2 * 38 * 3 = 228 ; total 304+228 = 532
ok('triple time @ $114.00/h', txt.includes('2.00 h triple time @ $114.00'), txt);
ok('triple time total $532.00', txt.includes('$532.00'), txt);

console.log('\nRemoving a row');
await p.locator('#qRows [data-del-row]').nth(1).click();
await p.waitForTimeout(150);
ok('back to one row', (await p.locator('#qRows .qrow').count())===1, String(await p.locator('#qRows .qrow').count()));
txt = await p.textContent('#qResult');
ok('total drops back to $304.00', txt.includes('$304.00') && !txt.includes('$532.00'), txt);
ok('lone row loses its delete button', (await p.locator('#qRows [data-del-row]').count())===0);

console.log('\nDifferent rate (another job)');
await p.uncheck('#qMyRate');
await p.waitForTimeout(100);
ok('rate box unlocks', !(await p.locator('#qRate').isDisabled()));
await p.fill('#qRate','25');
await p.waitForTimeout(150);
txt = await p.textContent('#qResult');
ok('8 h @ custom $25 -> $200.00', txt.includes('@ $25.00') && txt.includes('$200.00'), txt);
await p.check('#qMyRate');
await p.waitForTimeout(150);
txt = await p.textContent('#qResult');
ok('re-checking snaps back to your real rate', txt.includes('@ $38.00') && txt.includes('$304.00'), txt);

console.log('\nPay frequency + payday are the calculator\'s own, not your settings');
await p.selectOption('#qFreq','7');
await p.waitForTimeout(150);
ok('frequency changed to weekly', (await p.inputValue('#qFreq'))==='7');
ok('your real period settings untouched', await p.evaluate(()=>JSON.parse(localStorage.getItem('payclock.v1')).jobs[0].cfg.periodLengthDays)===14);
await p.fill('#qPayday','2026-09-11');
await p.waitForTimeout(150);
ok('payday note follows the chosen date', (await p.textContent('#qPaydayNote')).includes('Sep 11'), await p.textContent('#qPaydayNote'));

console.log('\nNet works immediately with nothing entered — no forced trip to the top');
await p.click('#qPayMode button[data-p="net"]');
await p.waitForTimeout(250);
ok('does NOT yank you to the deduction interview', !(await p.isVisible('#netsetup')));
ok('net toggle actually switches on', await p.locator('#qPayMode button.on').getAttribute('data-p').then(v=>v==='net'));
txt = await p.textContent('#qResult');
ok('breaks taxes out by line', txt.includes('Federal') && txt.includes('State') && txt.includes('Social Security'), txt);
ok('shows a take-home line', txt.includes('Take-home'), txt);
ok('gross line still shown alongside net', txt.includes('gross'), txt);
let note = await p.textContent('#qNetNote');
ok('note is visible in net mode', await p.isVisible('#qNetNote'));
ok('note says it is only an estimate', note.includes('Estimate only'), note);
ok('note spells out the assumptions used', note.includes('single') && note.includes('0 dependents') && note.includes('Illinois at 4.95%'), note);
ok('note offers the real-deductions path', (await p.textContent('#qEditDed')).includes('Enter my real deductions'), await p.textContent('#qEditDed'));
ok('no "other deductions" line when there are none', !txt.includes('Your other deductions'), txt);

console.log('\nThe note\'s button opens the interview deliberately, and scrolls it into view');
await p.click('#qEditDed');
ok('interview opens on request', await p.isVisible('#netsetup'));
/* Wait for the scroll to stop, not for a stopwatch.

   The panel sits about 10,000px above the calculator and the scroll is animated, so its
   duration is proportional to the distance and varies with how loaded the machine is.
   This used to sleep 1200ms against a ~700ms settle, which looks like plenty until a
   shared CI runner eats the margin: it measured -142px of a 10,179px journey — 98.6%
   of the way there and one frame short. Three quiet polls mean the animation is over.
   If the click did nothing at all, this still returns and the assertion below still
   fails, so nothing is masked. */
await p.waitForFunction(() => {
  const y = Math.round(window.scrollY);
  const s = (window.__scrollWatch = window.__scrollWatch || { y: null, still: 0 });
  if (s.y === y) s.still++; else { s.y = y; s.still = 0; }
  return s.still >= 3;
}, null, { timeout: 15000, polling: 100 });
const inView = await p.evaluate(()=>{ const r=document.getElementById('netsetup').getBoundingClientRect();
  return r.top > -50 && r.top < window.innerHeight; });
ok('and is scrolled into view rather than left off-screen', inView,
   await p.evaluate(()=>Math.round(document.getElementById('netsetup').getBoundingClientRect().top)+'px from top'));
await p.fill('#nDeps','2');
await p.click('#nSave');
await p.waitForTimeout(300);
await openAll(p);
note = await p.textContent('#qNetNote');
ok('note switches to "your saved deductions" once configured', note.includes('Using your saved deductions'), note);
ok('note reflects the dependents just entered', note.includes('2 dependents'), note);
ok('button becomes an edit link', (await p.textContent('#qEditDed')).includes('Edit my deductions'), await p.textContent('#qEditDed'));

console.log('\nBack to gross hides the net note entirely');
await p.click('#qPayMode button[data-p="gross"]');
await p.waitForTimeout(200);
ok('net note hidden in gross mode', !(await p.isVisible('#qNetNote')));
await p.click('#qPayMode button[data-p="net"]'); await p.waitForTimeout(150);

console.log('\nTyping in a row is never clobbered');
await p.click('#qPayMode button[data-p="gross"]');
await p.fill('#qRows .qrow input[data-f=hours]','');
await p.type('#qRows .qrow input[data-f=hours]','37.75', {delay:60});
await p.waitForTimeout(500);
ok('row input keeps exactly what was typed', (await p.locator('#qRows .qrow input[data-f=hours]').inputValue())==='37.75',
   await p.locator('#qRows .qrow input[data-f=hours]').inputValue());

console.log('\nEverything survives a reload');
await p.reload(); await p.waitForTimeout(400); await openAll(p);
ok('hours survive', (await p.locator('#qRows .qrow input[data-f=hours]').inputValue())==='37.75');
ok('frequency survives', (await p.inputValue('#qFreq'))==='7', await p.inputValue('#qFreq'));
ok('chosen payday survives', (await p.inputValue('#qPayday'))==='2026-09-11', await p.inputValue('#qPayday'));

console.log('\nA changed rate in Settings flows straight through');
await p.evaluate(()=>document.querySelectorAll('#cfg details').forEach(d=>d.open=true));
await p.fill('#cRate','40');
await p.locator('#cRate').blur();
await p.waitForTimeout(300);
await openAll(p);
ok('calculator picks up the new $40 rate', (await p.inputValue('#qRate'))==='40', await p.inputValue('#qRate'));
txt = await p.textContent('#qResult');
ok('and reprices with it', txt.includes('@ $40.00'), txt);

console.log('\nMobile — touch targets');
await p.close();
ctx = await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
p = await boot(ctx, seeded);
for (const sel of ['#qPayMode button','#qAddRow','#qRows select','#qFreq']){
  const boxes = await p.locator(sel).all();
  for (const el2 of boxes){
    const box = await el2.boundingBox();
    if (!box) continue;
    ok(`${sel} touch target >= 44px tall`, box.height >= 44 - 0.5, `${box.height}px`);
  }
}
await p.click('#qAddRow'); await p.waitForTimeout(200);
const delBox = await p.locator('#qRows [data-del-row]').first().boundingBox();
ok('row delete button >= 44px tall', delBox && delBox.height >= 44 - 0.5, delBox ? `${delBox.height}px` : 'none');
const bodyW = await p.evaluate(()=>document.documentElement.scrollWidth);
ok('no horizontal overflow at 390px', bodyW <= 391, `${bodyW}px`);
await p.screenshot({path:join(TMP, 'calc-mobile.png'), fullPage:true});

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close();
process.exit(fails===0?0:1);
