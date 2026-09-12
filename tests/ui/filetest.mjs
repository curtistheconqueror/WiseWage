import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;

let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b = await chromium.launch({executablePath: CHROME});
const ctx = await b.newContext({timezoneId:'America/New_York',locale:'en-US',viewport:{width:900,height:1400}});
const p = await ctx.newPage();
p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});
await p.clock.install({time:new Date('2026-07-27T13:00:00Z')});

// Opened straight off disk, exactly as a downloaded file behaves.
await p.goto('file://' + ROOT + 'index.html');
await p.waitForTimeout(500);

ok('page renders from file://', (await p.title()).includes('WiseWage'), await p.title());
ok('localStorage is usable from file://',
   await p.evaluate(()=>{try{localStorage.setItem('t','1');const v=localStorage.getItem('t')==='1';localStorage.removeItem('t');return v;}catch(e){return false;}}));
/* First run stops at the welcome screen now — Lite or Full. This suite exercises the
   full setup form, so take the Full path through it. */
if (await p.isVisible('#welcome')){ await p.click('#wPick button[data-mode="full"]');
  await p.waitForTimeout(400); }
ok('setup screen shows', await p.isVisible('#setup'));
await p.fill('#sRate','38'); await p.fill('#sAnchor','2026-07-26');
await p.selectOption('#sLen','14'); await p.selectOption('#sPay','13');
// Setup grew a required scheduled shift after this suite was written.
await p.fill('#sSchedStart','09:00'); await p.fill('#sSchedEnd','17:00');
await p.click('#sMode button[data-m="period"]');
await p.click('#sSave'); await p.waitForTimeout(400);
ok('setup completes', !(await p.isVisible('#setup')));
ok('rate applied', (await p.textContent('#liveline')).includes('$38.00'), await p.textContent('#liveline'));
ok('80 h rule took', (await p.textContent('#p80Note')).includes('80.00 h'), await p.textContent('#p80Note'));

await p.click('#punch'); await p.clock.fastForward(2*3600_000); await p.waitForTimeout(300);
ok('clock runs', (await p.textContent('#timer'))==='02:00:00', await p.textContent('#timer'));
ok('earning correctly', Math.abs(parseFloat((await p.textContent('#money')).replace(/[$,]/g,''))-76)<0.02, await p.textContent('#money'));
await p.click('#punch'); await p.waitForTimeout(300);

// Sections fold by default now; the log has to be open before its buttons are reachable.
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
await p.waitForTimeout(250);
await p.click('#addShift'); await p.fill('#eHours','10'); await p.waitForTimeout(250);
await p.click('#eSave'); await p.waitForTimeout(300);
ok('add-a-shift works offline from disk', (await p.textContent('#logBody')).includes('10.00'));
ok('cumulative section populated', parseFloat((await p.textContent('#cumeGross')).replace(/[$,]/g,''))>0, await p.textContent('#cumeGross'));

await p.reload(); await p.waitForTimeout(500);
ok('data SURVIVES a reload from file://', !(await p.isVisible('#setup')));
ok('and the hours are still there', (await p.textContent('#logBody')).includes('10.00'));
console.log(`\n${fails===0?'✅':'❌'}  file:// : ${fails} failure(s)\n`);
await b.close(); process.exit(fails?1:0);
