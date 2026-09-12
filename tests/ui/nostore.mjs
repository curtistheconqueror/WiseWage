import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;

const inner=readFileSync(ROOT + 'index.html','utf8');
const srv=http.createServer((q,r)=>{
  r.writeHead(200,{'Content-Type':'text/html'});
  if(q.url.startsWith('/inner')) return r.end(inner);
  // A frame WITHOUT allow-same-origin — an opaque origin, exactly like the artifact.
  r.end(`<!doctype html><html><body style="margin:0"><iframe src="/inner" sandbox="allow-scripts"
    style="border:0;width:100vw;height:100vh"></iframe></body></html>`);
}).listen(8090);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const openAll=async pg=>{ try{ await pg.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open'))); }catch(e){} };
const b=await chromium.launch({executablePath: CHROME});
const ctx=await b.newContext({timezoneId:'America/New_York',locale:'en-US',viewport:{width:900,height:1200}});
const p=await ctx.newPage();
p.on('pageerror',e=>{console.log('  💥 PAGE ERROR:',e.message);fails++;});
await p.goto('http://localhost:8090/'); await p.waitForTimeout(600); await openAll(p);
const f=p.frames()[1]; await openAll(f);

console.log('\nStorage blocked (an embedded frame, like the artifact)');
/* First run stops at the welcome screen now — Lite or Full. This suite exercises the
   full setup form, so take the Full path through it. */
if (await f.isVisible('#welcome')){ await f.click('#wPick button[data-mode="full"]');
  await f.waitForTimeout(400); }
ok('app still loads rather than crashing', await f.isVisible('#setup'));
ok('warns that nothing will save', await f.isVisible('#noStore'));
const w=await f.textContent('#noStore');
ok('says data will disappear', w.includes("disappear"), w.replace(/\s+/g,' ').slice(0,110));
ok('says what to do instead', w.includes('downloaded copy') || w.includes('own address'), '');
ok('still usable — setup accepts input', await (async()=>{
  await f.fill('#sRate','38'); await f.fill('#sAnchor','2026-07-26');
  await f.click('#sSave'); await p.waitForTimeout(400);
  return await f.isVisible('#hero');})());
ok('clock still runs with no storage', await (async()=>{
  await f.click('#punch'); await p.waitForTimeout(1200);
  return (await f.textContent('#statusTxt')).includes('On the clock');})());
ok('warning stays visible while working', await f.isVisible('#noStore'));

console.log('\nStorage available (a normal page)');
const p2=await ctx.newPage();
p2.on('pageerror',e=>{console.log('  💥 PAGE ERROR:',e.message);fails++;});
await p2.goto('http://localhost:8090/inner'); await p2.waitForTimeout(500); await openAll(p2);
ok('no warning when storage works', !(await p2.isVisible('#noStore')));
if (await p2.isVisible('#welcome')){ await p2.click('#wPick button[data-mode="full"]');
  await p2.waitForTimeout(400); }
await p2.fill('#sRate','38'); await p2.fill('#sAnchor','2026-07-26');
await p2.click('#sSave'); await p2.waitForTimeout(400);
await p2.reload(); await p2.waitForTimeout(500); await openAll(p2);
ok('and setup is remembered', !(await p2.isVisible('#setup')));

console.log(`\n${fails===0?'✅':'❌'}  storage warning: ${fails} failure(s)\n`);
await b.close(); srv.close(); process.exit(fails?1:0);
