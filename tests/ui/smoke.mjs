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
await page.click('#wipe'); await page.waitForTimeout(150);
await page.click('#wipe'); await page.waitForTimeout(400);
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
await mob.addInitScript(([k,v])=>localStorage.setItem(k,JSON.stringify(v)),
  [KEY, st({sessions:[{id:'m',start:jul(29,9),end:jul(29,17)}]})]);
await mob.goto('http://localhost:8091/'); await mob.waitForTimeout(400); await openAll(mob);
const of=await mob.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
ok('no sideways scroll', of<=0, of+'px');
const small=await mob.evaluate(()=>[...document.querySelectorAll('button,input,select')]
  .filter(b=>b.offsetParent!==null && b.type!=='file' && b.type!=='checkbox')
  .filter(b=>b.getBoundingClientRect().height < 44)
  .map(b=>(b.id||b.className||b.tagName)+':'+Math.round(b.getBoundingClientRect().height)));
ok('every control meets the 44px touch minimum', small.length===0, small.join(', '));
await mob.close();

console.log(`\n${fails===0?'✅ ALL CLEAR':'❌ PROBLEMS FOUND'} — ${fails} failure(s)\n`);
await b.close(); srv.close(); process.exit(fails?1:0);
