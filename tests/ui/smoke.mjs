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
  // Serve real MIME types: the app registers a service worker, and a text/html
  // response for sw.js makes the browser reject it with a console error.
  const R = ROOT;
  if (q.url.startsWith('/sw.js')) { r.writeHead(200,{'Content-Type':'text/javascript'}); return r.end(readFileSync(R+'sw.js')); }
  if (q.url.startsWith('/manifest')) { r.writeHead(200,{'Content-Type':'application/manifest+json'}); return r.end(readFileSync(R+'manifest.webmanifest')); }
  if (q.url.indexOf('.png') > -1) { r.writeHead(404); return r.end(); }
  r.writeHead(200,{'Content-Type':'text/html'}); r.end(readFileSync(R+'index.html'));
}).listen(8091);

let fails=0, warns=0;
const openAll=async pg=>{ try{ await pg.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open'))); }catch(e){} };
const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b=await chromium.launch({executablePath: CHROME});
const ctx=await b.newContext({timezoneId:'America/New_York',locale:'en-US',
  viewport:{width:900,height:1600},acceptDownloads:true});

let page=null;
async function boot(iso, seed){
  if(page) await page.close();
  page=await ctx.newPage();
  page.on('pageerror',e=>{console.log('  💥 PAGE ERROR:',e.message);fails++;});
  page.on('console',m=>{if(m.type()==='error'){console.log('  💥 CONSOLE ERROR:',m.text());fails++;}});
  await page.addInitScript(([k,v])=>{
    if(sessionStorage.getItem('__s'))return; sessionStorage.setItem('__s','1');
    if(v) localStorage.setItem(k,JSON.stringify(v)); else localStorage.removeItem(k);
  },[KEY,seed||null]);
  await page.clock.install({time:new Date(iso)});
  await page.goto('http://localhost:8091/'); await page.waitForTimeout(300); await openAll(page);
}
const T=s=>page.textContent(s);
const N=async s=>parseFloat((await T(s)).replace(/[$,]/g,''));
const ff=async ms=>{await page.clock.fastForward(ms); await page.waitForTimeout(200);};
/* Built in the browser's timezone, not this process's — new Date(y,m,d,h) here is UTC and
   lands four hours off the New York page. */
const jul=(d,h,m=0)=>Date.UTC(2026,6,d,h+4,m);    // July = EDT, UTC-4
const aug=(d,h,m=0)=>+new Date(2026,7,d,h,m);
const CFG={rate:38,periodAnchor:'2026-07-26',otMode:'period',periodLengthDays:14,payDateOffsetDays:13};
const st=(o={})=>({configured:true,cfg:{...CFG,...(o.cfg||{})},sessions:o.sessions||[],
  activeStart:o.activeStart||null,unit:o.unit||'sec',planOn:!!o.planOn,
  plannedHours:o.plannedHours||8,sound:false});

console.log('\n━━ 1. First run, exactly as a new user meets it ━━');
await boot('2026-07-27T21:00:00Z', null);           // Mon Jul 27, 5 PM ET
/* First run stops at the welcome screen now — Lite or Full. This suite exercises the
   full setup form, so take the Full path through it. */
if (await page.isVisible('#welcome')){ await page.click('#wPick button[data-mode="full"]');
  await page.waitForTimeout(400); }
ok('opens on setup, not a broken screen', await page.isVisible('#setup'));
ok('clock hidden until configured', !(await page.isVisible('#hero')));
ok('refuses to start with no rate', await (async()=>{await page.click('#sSave');await page.waitForTimeout(200);
  return await page.isVisible('#setup');})());
ok('says why', (await T('#sErr')).length>0, await T('#sErr'));
await page.fill('#sRate','38'); await page.fill('#sAnchor','2026-07-26');
await page.selectOption('#sLen','14'); await page.selectOption('#sPay','13');
await page.click('#sMode button[data-m="period"]'); await page.waitForTimeout(250);
ok('previews the real period', (await T('#sPreview')).includes('Jul 26') && (await T('#sPreview')).includes('Aug 8'), await T('#sPreview'));
ok('previews payday Aug 21', (await T('#sPreview')).includes('Aug 21'));
ok('previews OT at $57', (await T('#sPreview')).includes('$57.00'));
await page.click('#sSave'); await page.waitForTimeout(400);
ok('setup completes', !(await page.isVisible('#setup')) && await page.isVisible('#hero'));

console.log('\n━━ 2. A real shift, clocked live ━━');
await page.click('#punch'); await page.waitForTimeout(200);
await ff(4*3600_000 + 37*60_000);                   // 4h37m
ok('timer reads 04:37:00', (await T('#timer'))==='04:37:00', await T('#timer'));
const want=(4+37/60)*38;
ok('pay matches hours exactly', Math.abs(await N('#money')-want)<0.02, `${await T('#money')} vs $${want.toFixed(4)}`);
await page.click('#punch'); await page.waitForTimeout(300);
ok('banked to the log', (await T('#logBody')).includes('4.62'), '');
ok('day total right', Math.abs(await N('#dGross')-want)<0.05, await T('#dGross'));

console.log('\n━━ 3. Add the 10 hours worked today ━━');
await page.click('#addShift'); await page.waitForTimeout(200);
await page.fill('#eHours','10'); await page.waitForTimeout(250);
ok('previews $380.00', (await T('#ePreview')).includes('$380.00'), await T('#ePreview'));
await page.click('#eSave'); await page.waitForTimeout(300);
ok('day now 14.62 h', Math.abs(await N('#dGross')-(14+37/60)*38)<0.05, await T('#dGross'));
ok('cumulative section agrees', Math.abs(await N('#cumeGross')-(14+37/60)*38)<0.05, await T('#cumeGross'));

console.log('\n━━ 4. Forgot to clock out for three days ━━');
await boot('2026-07-30T21:00:00Z', st({activeStart:jul(27,9)}));
const h=(new Date(2026,6,30,17)-new Date(2026,6,27,9))/3600000;
ok(`${h} h shift does not crash`, await page.isVisible('#hero'));
ok('timer shows the full span', (await T('#timer')).startsWith('80:'), await T('#timer'));
ok('80 h rule caught it', (await T('#p80Note')).includes('80 h'), await T('#p80Note'));
ok('never claims "passed" while showing 0.00 h of OT',
   !((await T('#p80Note')).includes('passed') && (await T('#p80Note')).includes('0.00 h so far')), await T('#p80Note'));
/* An 80-hour punch is now questioned rather than banked in silence — this is the exact
   case the guard exists for. The first tap puts the question; tapping again means "bank it
   as it stands", which is what the rest of this section measures. */
const rowsBefore = await page.locator('#logBody tbody tr').count();
await page.click('#punch'); await page.waitForTimeout(400);
ok('it asks before banking eighty hours', await page.isVisible('#forgotBar'));
ok('and the shift is still running', await page.evaluate(()=>!!state.activeStart));
ok('with nothing new in the log', (await page.locator('#logBody tbody tr').count())===rowsBefore,
   rowsBefore + ' → ' + await page.locator('#logBody tbody tr').count());
ok('it offers to end it at the rostered time',
   (await T('#forgotFix')).startsWith('End it at'), await T('#forgotFix'));
await page.click('#punch'); await page.waitForTimeout(400);
ok('clocking out banks it across days', (await page.locator('#logBody tbody tr').count())>=1);
ok('OT priced in', await N('#cumeGross') > 80*38, await T('#cumeGross'));

console.log('\n━━ 5. Crossing 80 h mid-shift on the period rule ━━');
// 78 h banked; clock in and run 4 h. 2 straight, 2 OT.
await boot('2026-08-03T13:00:00Z', st({sessions:[
  {id:'a',start:jul(26,8),end:jul(26,8)+10*3600e3},{id:'b',start:jul(27,8),end:jul(27,8)+10*3600e3},
  {id:'c',start:jul(28,8),end:jul(28,8)+10*3600e3},{id:'d',start:jul(29,8),end:jul(29,8)+10*3600e3},
  {id:'e',start:jul(30,8),end:jul(30,8)+10*3600e3},{id:'f',start:jul(31,8),end:jul(31,8)+10*3600e3},
  {id:'g',start:aug(1,8),end:aug(1,8)+10*3600e3},{id:'h',start:aug(2,8),end:aug(2,8)+8*3600e3}]}));
ok('78 h banked', (await T('#p80Num'))==='78.00 / 80 h', await T('#p80Num'));
ok('says 2 h to OT', (await T('#p80Note')).includes('2.00 h'), await T('#p80Note'));
await page.click('#punch'); await page.waitForTimeout(200);
await ff(2*3600_000 - 60_000);
ok('at 79.98 h still straight', !(await T('#statusTxt')).includes('overtime'), await T('#statusTxt'));
await ff(120_000);                                   // tip over 80
ok('flips to overtime', (await T('#statusTxt')).includes('overtime'), await T('#statusTxt'));
await ff(2*3600_000);
const [H5,M5,S5]=(await T('#timer')).split(':').map(Number);
const el5=H5+M5/60+S5/3600, reg5=Math.min(2,el5), ot5=el5-reg5;
const want5=reg5*38+ot5*57;
ok('day splits straight/OT exactly at the 80 h line',
   Math.abs(await N('#dGross')-want5)<0.02, `${await T('#dGross')} vs $${want5.toFixed(2)} for ${await T('#timer')}`);
ok('and stays OT', (await T('#p80Note')).includes('Every hour for the rest'), await T('#p80Note'));
await page.click('#punch'); await page.waitForTimeout(250);

console.log('\n━━ 6. Editing a shift recomputes everything ━━');
const before6=await N('#cumeGross');
await page.click('#pickEdit'); await page.click('#logBody tbody tr[data-row]'); await page.waitForTimeout(300);
ok('edit form opens prefilled', (await T('#eTitle'))==='Edit this shift' && (await page.inputValue('#eIn')).length===5);
await page.click('#eMode button[data-m="hours"]'); await page.fill('#eHours','2'); await page.waitForTimeout(250);
await page.click('#eSave'); await page.waitForTimeout(350);
ok('totals dropped after shortening it', (await N('#cumeGross')) < before6, `${before6} → ${await N('#cumeGross')}`);

console.log('\n━━ 7. Period rollover wipes nothing it should keep ━━');
await boot('2026-08-09T13:00:00Z', st({sessions:[{id:'old',start:aug(7,9),end:aug(7,17)}]}));
ok('new period Aug 9 – Aug 22', (await T('#prange'))==='Sun Aug 9 → Sat Aug 22, 2026', await T('#prange'));
ok('cumulative resets', (await T('#cumeGross'))==='$0.00', await T('#cumeGross'));
ok('80 h counter resets', (await T('#p80Num'))==='0.00 / 80 h', await T('#p80Num'));
const kept = await page.evaluate(k=>JSON.parse(localStorage.getItem(k)).sessions.length, KEY);
ok('but the old shift is NOT deleted', kept===1, `${kept} session(s) still stored`);

console.log('\n━━ 8. Changing your rate re-prices history ━━');
await boot('2026-07-30T13:00:00Z', st({sessions:[{id:'x',start:jul(27,9),end:jul(27,17)}]}));
ok('at $38 → $304', Math.abs(await N('#cumeGross')-304)<0.01, await T('#cumeGross'));
await page.evaluate(()=>{document.querySelectorAll('#cfg details').forEach(d=>d.open=true)}); await page.waitForTimeout(150);
await page.fill('#cRate','45'); await page.dispatchEvent('#cRate','change'); await page.waitForTimeout(300);
ok('at $45 → $360', Math.abs(await N('#cumeGross')-360)<0.01, await T('#cumeGross'));
await page.fill('#cRate',''); await page.dispatchEvent('#cRate','change'); await page.waitForTimeout(300);
ok('emptying the rate field is rejected, keeps $45', (await page.inputValue('#cRate'))==='45', await page.inputValue('#cRate'));
ok('totals unharmed', Math.abs(await N('#cumeGross')-360)<0.01, await T('#cumeGross'));

console.log('\n━━ 9. Auto-stop ━━');
await boot('2026-07-30T13:00:00Z', st({planOn:true,plannedHours:6}));
await page.click('#punch'); await page.waitForTimeout(200);
ok('shows the stop time', (await T('#planEta')).includes('3:00 PM'), await T('#planEta'));
await ff(6.5*3600_000);
ok('stopped itself', (await T('#statusTxt')).includes('Clocked out'), await T('#statusTxt'));
ok('banked exactly 6 h = $228', Math.abs(await N('#dGross')-228)<0.01, await T('#dGross'));

console.log('\n━━ 10. Backup survives a full wipe ━━');
await boot('2026-07-30T13:00:00Z', st({sessions:[{id:'k',start:jul(27,9),end:jul(27,19)}]}));
await page.evaluate(()=>{document.querySelectorAll('#cfg details').forEach(d=>d.open=true)}); await page.waitForTimeout(150);
const dl=await Promise.all([page.waitForEvent('download'),page.click('#backup')]).then(r=>r[0]);
await dl.saveAs(join(TMP, 'smoke-backup.json'));
/* Arming and confirming used to be the same pixel, so an ordinary double-tap wiped
   everything. The confirm is a separate control now; tapping the first one twice must do
   nothing but ask. */
await page.click('#wipe'); await page.waitForTimeout(150);
await page.click('#wipe'); await page.waitForTimeout(150);
ok('a double-tap only asks', await page.isVisible('#wipeConfirm'));
ok('and erases nothing by itself', (await page.evaluate(()=>state.sessions.length)) > 0);
await page.click('#wipeYes'); await page.waitForTimeout(400);
/* Erase clears the stored Lite/Full choice along with everything else, so it lands all the
   way back at the welcome screen rather than at setup — which is what erasing should mean. */
ok('erase returns to the very beginning', await page.isVisible('#welcome'));
await page.setInputFiles('#restoreFile',join(TMP, 'smoke-backup.json')); await page.waitForTimeout(500); await openAll(page);
ok('restore brings it all back', !(await page.isVisible('#setup')) && Math.abs(await N('#cumeGross')-380)<0.01, await T('#cumeGross'));
ok('rate restored', (await T('#liveline')).includes('$38.00'), await T('#liveline'));

console.log('\n━━ 11. CSV matches the screen ━━');
const csv=await Promise.all([page.waitForEvent('download'),page.click('#exportCsv')]).then(r=>r[0]);
await csv.saveAs(join(TMP, 'smoke.csv'));
const rows=readFileSync(join(TMP, 'smoke.csv'),'utf8').trim().split('\n');
ok('has a header and one row', rows.length===2, `${rows.length} line(s)`);
ok('gross matches the widget', rows[1].includes('380.00'), rows[1]);
ok('hours match', rows[1].includes('10.0000'), rows[1]);

console.log('\n━━ 12. Nothing lost on refresh, mid-shift ━━');
await boot('2026-07-30T13:00:00Z', st({sessions:[{id:'p',start:jul(29,9),end:jul(29,17)}]}));
await page.click('#punch'); await page.waitForTimeout(200);
await ff(3*3600_000);
const m12=await N('#money'), c12=await N('#cumeGross');
await page.reload(); await page.waitForTimeout(400); await openAll(page);
ok('still on the clock', (await T('#statusTxt')).includes('On the clock'));
ok('live figure intact', Math.abs(await N('#money')-m12)<0.05, `${m12} → ${await N('#money')}`);
ok('cumulative intact', Math.abs(await N('#cumeGross')-c12)<0.05, `${c12} → ${await N('#cumeGross')}`);

console.log('\n━━ 13. Phone ━━');
const touch=await b.newContext({timezoneId:'America/New_York',locale:'en-US',
  viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
const mob=await touch.newPage();
await mob.clock.install({time:new Date('2026-07-30T13:00:00Z')});
/* The fixture has to carry data, not just one shift.

   This rule filters on `offsetParent !== null`, so it only ever measured controls that were
   actually on the page — and a control that needs data to exist was therefore never
   measured at all. That is how a 12×14px button that gave away a paid day off shipped
   under a passing test. Seed an allowance with a day spent, a holiday and a shift, so the
   per-row controls in those cards are on screen when the tape measure comes out. */
await mob.addInitScript(([k,v])=>localStorage.setItem(k,JSON.stringify(v)),
  [KEY, st({sessions:[{id:'m',start:jul(29,9),end:jul(29,17)}],
    cfg:{ banks:[{id:'float',name:'Floater',count:3,hours:8,ot:false}],
          daysOff:[{id:'d1',bank:'float',date:'2026-07-28',hours:8}],
          holidays:[{id:'h1',name:'Independence Day',kind:'md',month:7,day:4,on:true}] } })]);
await mob.goto('http://localhost:8091/'); await mob.waitForTimeout(400); await openAll(mob);
const of=await mob.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
ok('no sideways scroll', of<=0, of+'px');
/* The seeding above is only useful if it really put those rows on the page. Without this,
   a fixture that quietly failed to render them would leave the rule below passing while
   measuring nothing — which is the exact failure being fixed, one level up. */
const seeded=await mob.evaluate(()=>({
  dayOff:document.querySelectorAll('#bankBody button[data-offedit]').length,
  holiday:document.querySelectorAll('#cHolList button[data-hedit]').length,
  // The log has no per-row buttons on purpose: a row is selected by tapping the row
  // itself, so there is nothing here for the rule below to measure. Checked anyway, so
  // that a log which rendered nothing at all does not pass for a log with no buttons.
  logRow:document.querySelectorAll('#logBody tbody tr[data-row]').length}));
ok('the fixture really rendered a booked day off', seeded.dayOff>0, JSON.stringify(seeded));
ok('and a holiday row', seeded.holiday>0, JSON.stringify(seeded));
ok('and a shift row', seeded.logRow>0, JSON.stringify(seeded));
const small=await mob.evaluate(()=>[...document.querySelectorAll('button,input,select')]
  .filter(b=>b.offsetParent!==null && b.type!=='file' && b.type!=='checkbox')
  .filter(b=>b.getBoundingClientRect().height < 44)
  .map(b=>(b.id||b.className||b.tagName)+':'+Math.round(b.getBoundingClientRect().height)));
/* Two elements sharing an id is not a style complaint — getElementById returns whichever
   comes first in the document, so one of them silently becomes furniture that never
   updates, and which one depends on markup order rather than on anything anyone decided.
   Found by a real collision: a new editor reused four ids from the day-off editor, its own
   tests passed because its markup happened to come first, and the day-off editor broke. */
{
  const dupes = await page.evaluate(() => {
    const seen = {}, bad = [];
    document.querySelectorAll('[id]').forEach(el => {
      const id = el.id;
      if (seen[id]) { if (bad.indexOf(id) < 0) bad.push(id); } else { seen[id] = 1; }
    });
    return bad;
  });
  ok('no two elements share an id', dupes.length === 0, dupes.join(', ') || 'none');
}
ok('every control meets the 44px touch minimum', small.length===0, small.join(', '));
/* The rule above exempts checkboxes, because the box is small by design and the label
   around it is the target. That exemption only ever had a matching label check inside the
   Custom Data Sheet — whose comment claimed this suite applied it app-wide, which it did
   not — so everywhere else a bare checkbox was unguarded. That is how a 17px holiday
   on/off switch shipped. The rule lives here now, where it covers the whole app. */
const boxes=await mob.evaluate(()=>[...document.querySelectorAll('input[type=checkbox]')]
  .filter(x=>x.offsetParent!==null)
  .map(x=>{ const l=x.closest('label');
            return (x.id||x.className||'checkbox')+':'+Math.round((l||x).getBoundingClientRect().height); })
  .filter(s=>+s.split(':')[1] < 44));
ok('and every checkbox has a label big enough to hit', boxes.length===0, boxes.join(', '));

/* A ratchet on wordiness, because nothing else guards it.
   
   The whole copy pass that took on-screen prose from 1,281 words to 700 broke not one
   assertion — tests check labels and figures, never paragraphs, so the prose can grow back
   silently. This counts the words a user can actually SEE: every card expanded, help notes
   left closed, and runs of 12+ words counted as prose rather than labels.

   Two traps are worth knowing if this ever needs changing. Force-opening every <details>
   counts the help bodies, which turns a cut into an apparent increase. And `offsetParent`
   is not a visibility test here — in this Chromium the contents of a CLOSED <details> still
   report a layout box, which is why the check below walks up looking for one instead.

   The ceiling is deliberately above today's figure: this is a ratchet against creep, not a
   freeze. If a genuinely necessary explanation pushes past it, raise the number in the same
   commit and say why — that is the point, to make it a decision rather than a drift. */
{
  const prose = await mob.evaluate(() => {
    document.querySelectorAll('.col').forEach(c => c.classList.add('open'));
    document.querySelectorAll('details').forEach(d => {
      if (!d.classList.contains('helpnote')) d.open = true;
    });
    const visible = (node) => {
      const el = node.parentElement;
      if (!el) return false;
      if (el.offsetParent === null && el.tagName !== 'BODY') return false;
      for (let n = el; n && n !== document.body; n = n.parentElement){
        if (n.tagName === 'DETAILS' && !n.open){
          let inSummary = false;
          for (let m = el; m && m !== n; m = m.parentElement) if (m.tagName === 'SUMMARY') inSummary = true;
          if (!inSummary) return false;
        }
      }
      return true;
    };
    let total = 0;
    document.querySelectorAll('section.card').forEach(card => {
      if (card.offsetParent === null) return;
      const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walk.nextNode())){
        const el = n.parentElement;
        if (!el || /^(SCRIPT|STYLE|OPTION)$/.test(el.tagName)) continue;
        if (!visible(n)) continue;
        const w = (n.nodeValue || '').trim().split(/\s+/).filter(Boolean).length;
        if (w >= 12) total += w;       // a run this long reads as a sentence, not a label
      }
    });
    return total;
  });
  const CEILING = 850;                 // measured at 700 the day this landed
  ok(`on-screen prose stays under ${CEILING} words`, prose <= CEILING, prose + ' words');
}
await mob.close();

console.log(`\n${fails===0?'✅ ALL CLEAR':'❌ PROBLEMS FOUND'} — ${fails} failure(s)\n`);
await b.close(); srv.close(); process.exit(fails?1:0);
