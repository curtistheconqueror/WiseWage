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



// Serve the widget inside a SANDBOXED iframe — the exact context where prompt() died.
/* The live app, not a snapshot. This used to read a frozen copy that stopped matching the
   real thing in July, so it was quietly testing an app that no longer exists. */
const inner = readFileSync(ROOT + 'index.html', 'utf8');
const srv = http.createServer((q, r) => {
  r.writeHead(200, { 'Content-Type': 'text/html' });
  if (q.url.startsWith('/inner')) return r.end(`<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${inner}</body></html>`);
  r.end(`<!doctype html><html><body style="margin:0">
    <iframe src="/inner" sandbox="allow-scripts allow-same-origin"
      style="border:0;width:100vw;height:100vh"></iframe></body></html>`);
}).listen(8096);

let fails = 0;
const openAll=async pg=>{ try{ await pg.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open'))); }catch(e){} };
const ok = (n, c, x='') => { console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c) fails++; };

const b = await chromium.launch({ executablePath: CHROME });
const ctx = await b.newContext({ timezoneId:'America/New_York', locale:'en-US', viewport:{width:900,height:1500}, deviceScaleFactor:2 });
const p = await ctx.newPage();
p.on('pageerror', e => { console.log('  PAGE ERROR:', e.message); fails++; });
p.on('console', m => { const t = m.text();
  /* This harness serves one inline document from every route, so the service worker fetch
     comes back as text/html and fails to register. That is the fixture, not the app. */
  if (m.type()==='error' && !t.includes('allow-same-origin')
      && !t.includes('unsupported MIME type')) { console.log('  CONSOLE ERROR:', t); fails++; } });
await p.clock.install({ time: new Date('2026-07-27T21:00:00Z') });   // Mon Jul 27, 5:00 PM ET
await p.goto('http://localhost:8096/'); await p.waitForTimeout(400); await openAll(p);
let f = p.frames()[1];
// The app now opens on the welcome screen and then setup; clear both before the log. Full,
// because this suite drives the full setup form's fields.
if (await f.isVisible('#welcome')) {
  await f.click('#wPick button[data-mode="full"]'); await p.waitForTimeout(400);
}
if (await f.isVisible('#setup')) {
  await f.fill('#sRate','38'); await f.fill('#sAnchor','2026-07-26');
  await f.selectOption('#sLen','14'); await f.selectOption('#sPay','13');
  await f.click('#sSave'); await p.waitForTimeout(400);
}
await openAll(f);
const T = s => f.textContent(s);
const num = async s => parseFloat((await T(s)).replace(/[$,]/g,''));
const vis = s => f.isVisible(s);

console.log('\nThe reported bug: Add shift inside a sandboxed page');
ok('editor starts hidden', !(await vis('#editor')));
await f.click('#addShift'); await p.waitForTimeout(250);
ok('clicking Add actually opens the form', await vis('#editor'));
ok('titled for adding', (await T('#eTitle')) === 'Add a shift', await T('#eTitle'));
ok('defaults to the Just hours mode', await f.getAttribute('#eMode button[data-m="hours"]', 'class') === 'on');
ok('date defaults to today', (await f.inputValue('#eDate')) === '2026-07-27', await f.inputValue('#eDate'));

console.log('\nAdding the 10 hours worked today');
await f.fill('#eHours', '10'); await p.waitForTimeout(200);
ok('preview shows 10.00 h', (await T('#ePreview')).includes('10.00 h'), await T('#ePreview'));
ok('preview prices it at $380.00', (await T('#ePreview')).includes('$380.00'), await T('#ePreview'));
ok('preview names the window used', (await T('#ePreview')).includes('8:00 AM'), await T('#ePreview'));
await f.click('#eSave'); await p.waitForTimeout(300);
ok('editor closes on save', !(await vis('#editor')));
ok('shift is in the log', (await T('#logBody')).includes('Mon Jul 27'));
ok('log shows 10.00 h', (await T('#logBody')).includes('10.00'));
ok('today total = $380.00', Math.abs(await num('#dGross') - 380) < 0.01, await T('#dGross'));
ok('period total = $380.00', Math.abs(await num('#pGross') - 380) < 0.01, await T('#pGross'));
await p.screenshot({ path:join(TMP, '07-added.png'), fullPage:true });

console.log('\nExact start/end times');
await f.click('#addShift'); await p.waitForTimeout(200);
await f.click('#eMode button[data-m="times"]'); await p.waitForTimeout(150);
ok('time fields appear', await vis('#eIn') && await vis('#eOut'));
ok('hours field hides', !(await vis('#eHours')));
await f.fill('#eDate', '2026-07-28');
await f.fill('#eIn', '09:30'); await f.fill('#eOut', '14:00'); await p.waitForTimeout(200);
ok('preview computes 4.50 h', (await T('#ePreview')).includes('4.50 h'), await T('#ePreview'));
ok('preview prices at $171.00', (await T('#ePreview')).includes('$171.00'), await T('#ePreview'));
await f.click('#eSave'); await p.waitForTimeout(300);
ok('second shift logged', (await T('#logBody')).includes('Tue Jul 28'));
ok('period now $551.00', Math.abs(await num('#pGross') - 551) < 0.01, await T('#pGross'));

console.log('\nOvernight shift rolls to the next morning');
await f.click('#addShift'); await p.waitForTimeout(200);
await f.click('#eMode button[data-m="times"]'); await p.waitForTimeout(150);
await f.fill('#eDate', '2026-07-29'); await f.fill('#eIn', '22:00'); await f.fill('#eOut', '06:00');
await p.waitForTimeout(200);
ok('recognised as overnight', (await T('#ePreview')).includes('next morning'), await T('#ePreview'));
ok('counts 8.00 h, not negative', (await T('#ePreview')).includes('8.00 h'), await T('#ePreview'));
await f.click('#eCancel'); await p.waitForTimeout(200);
ok('cancel discards it', !(await vis('#editor')) && !(await T('#logBody')).includes('Wed Jul 29'));

console.log('\nValidation speaks plainly');
await f.click('#addShift'); await p.waitForTimeout(200);
await f.fill('#eHours', '0'); await p.waitForTimeout(150);
await f.click('#eSave'); await p.waitForTimeout(200);
ok('refuses zero hours', await vis('#eErr'), await T('#eErr'));
ok('still open so it can be fixed', await vis('#editor'));
await f.fill('#eHours', '30'); await f.click('#eSave'); await p.waitForTimeout(200);
ok('refuses more than a day', (await T('#eErr')).includes('24 hours'), await T('#eErr'));
await f.fill('#eHours', '6'); await f.click('#eSave'); await p.waitForTimeout(250);
ok('accepts once valid', !(await vis('#editor')));

console.log('\nEdit an existing shift');
await f.click('#pickEdit'); await f.click('#logBody tbody tr[data-row]'); await p.waitForTimeout(250);
ok('opens titled for editing', (await T('#eTitle')) === 'Edit this shift', await T('#eTitle'));
ok('prefilled with real times', (await f.inputValue('#eIn')).length === 5, await f.inputValue('#eIn'));
await f.fill('#eOut', '23:00'); await p.waitForTimeout(200);
await f.click('#eSave'); await p.waitForTimeout(300);
ok('edit saved, no duplicate row', (await T('#logBody')).includes('11:00 PM'), '');

console.log('\nDelete asks in the page, not a popup');
const rowsBefore = await f.locator('#logBody tbody tr').count();
await f.click('#pickDelete'); await f.click('#logBody tbody tr[data-row]'); await p.waitForTimeout(250);
ok('row asks to confirm', (await T('#logBody')).includes('Delete?'));
await f.click('#logBody button[data-del-no]'); await p.waitForTimeout(250);
ok('declining keeps the shift', await f.locator('#logBody tbody tr').count() === rowsBefore);
await f.click('#pickDelete'); await f.click('#logBody tbody tr[data-row]'); await p.waitForTimeout(250);
await f.click('#logBody button[data-del-yes]'); await p.waitForTimeout(300);
ok('confirming removes it', await f.locator('#logBody tbody tr').count() === rowsBefore - 1);

console.log('\nClear period confirms inline');
await f.click('#clearPeriod'); await p.waitForTimeout(250);
ok('inline confirm appears', await vis('#clearConfirm'));
await f.click('#clearNo'); await p.waitForTimeout(200);
ok('keeping them works', !(await vis('#clearConfirm')) && (await f.locator('#logBody tbody tr').count()) > 0);
await f.click('#clearPeriod'); await f.click('#clearYes'); await p.waitForTimeout(300);
ok('clearing empties the period', (await T('#logBody')).includes('No shifts'));
ok('totals reset', (await T('#pGross')) === '$0.00', await T('#pGross'));

console.log('\nPersistence');
await f.click('#addShift'); await p.waitForTimeout(200);
await f.fill('#eHours', '10'); await f.click('#eSave'); await p.waitForTimeout(300);
await p.reload(); await p.waitForTimeout(500); await openAll(p);
const f2 = p.frames()[1]; await openAll(f2);
ok('manually added shift survives reload', (await f2.textContent('#logBody')).includes('10.00'));
ok('and its pay', Math.abs(parseFloat((await f2.textContent('#dGross')).replace(/[$,]/g,'')) - 380) < 0.01,
   await f2.textContent('#dGross'));

const of = await f2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('no horizontal overflow', of <= 0, `${of}px`);
await p.screenshot({ path:join(TMP, '08-editor.png'), fullPage:true });

console.log(`\n${fails===0?'✅':'❌'}  editor: ${fails} failure(s)\n`);
await b.close(); srv.close(); process.exit(fails?1:0);
