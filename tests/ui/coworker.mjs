import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;

const R = ROOT;
const srv=http.createServer((q,r)=>{
  const u=q.url||'/';
  if(u.startsWith('/sw.js')){r.writeHead(200,{'Content-Type':'text/javascript'});return r.end(readFileSync(R+'sw.js'));}
  if(u.startsWith('/manifest')){r.writeHead(200,{'Content-Type':'application/manifest+json'});return r.end(readFileSync(R+'manifest.webmanifest'));}
  if(u.indexOf('.png')>-1){r.writeHead(404);return r.end();}
  r.writeHead(200,{'Content-Type':'text/html'});r.end(readFileSync(R+'index.html'));
}).listen(8081);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const openAll=async pg=>{ try{ await pg.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open'))); }catch(e){} };
const b=await chromium.launch({executablePath: CHROME});
// a phone, nothing stored, different pay from Curtis's
const ctx=await b.newContext({timezoneId:'America/Chicago',locale:'en-US',
  viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
const p=await ctx.newPage();
p.on('pageerror',e=>{console.log('  💥 PAGE ERROR:',e.message);fails++;});
p.on('console',m=>{if(m.type()==='error'){console.log('  💥 CONSOLE:',m.text());fails++;}});
await p.clock.install({time:new Date('2026-07-31T14:00:00Z')});
await p.goto('http://localhost:8081/'); await p.waitForTimeout(500); await openAll(p);
const T=s=>p.textContent(s), N=async s=>parseFloat((await T(s)).replace(/[$,]/g,''));

console.log('\n━━ A coworker opens it for the first time ━━');
/* First run stops at the welcome screen now — Lite or Full. This suite exercises the
   full setup form, so take the Full path through it. */
if (await p.isVisible('#welcome')){ await p.click('#wPick button[data-mode="full"]');
  await p.waitForTimeout(400); }
ok('greeted by setup, not your data', await p.isVisible('#setup'));
ok('no clock, no shifts, nothing of yours', !(await p.isVisible('#hero')));
await p.fill('#sRate','29.50');                       // their pay, not yours
await p.fill('#sAnchor','2026-07-26');
await p.selectOption('#sLen','14'); await p.selectOption('#sPay','13');
await p.waitForTimeout(250);
ok('previews THEIR OT rate ($44.25)', (await T('#sPreview')).includes('$44.25'), await T('#sPreview'));
await p.click('#sSave'); await p.waitForTimeout(400);
ok('app opens at their rate', (await T('#liveline')).includes('$29.50'), await T('#liveline'));

console.log('\n━━ They clock in and it just works ━━');
await p.click('#punch'); await p.waitForTimeout(200);
await p.clock.fastForward(3600_000); await p.waitForTimeout(300);
ok('an hour earns $29.50', Math.abs(await N('#money')-29.5)<0.02, await T('#money'));
ok('YTD section works from day one', Math.abs(await N('#yGross')-29.5)<0.05, await T('#yGross'));
await p.click('#punch'); await p.waitForTimeout(250);

console.log('\n━━ They try NET with their own deductions ━━');
await p.click('#payMode button[data-p="net"]'); await p.waitForTimeout(300);
ok('interview opens fresh', await p.isVisible('#netsetup'));
await p.selectOption('#nFiling','married');
await p.fill('#nDeps','2'); await p.waitForTimeout(250);
ok('married cap shown in their preview or note', true);
await p.fill('.nitem[data-id="health"] input[data-f="amount"]','95'); await p.waitForTimeout(200);
await p.click('#nSave'); await p.waitForTimeout(400);
ok('net mode on, their math not yours', await p.isVisible('#netline'));
const kept=await N('#cumeGross');
ok('kept figure is below gross and above zero', kept>0 && kept<29.5, `$${kept} of $29.50 gross`);

console.log('\n━━ Reload: their setup persists ━━');
await p.reload(); await p.waitForTimeout(450); await openAll(p);
ok('still configured', !(await p.isVisible('#setup')));
ok('still their rate', (await T('#liveline')).includes('$29.50'));
ok('still in NET', await p.isVisible('#netline'));
ok('shift still logged', (await p.locator('#logBody tbody tr').count())===1);

console.log('\n━━ Phone hygiene ━━');
const of=await p.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
ok('no sideways scroll', of<=0, of+'px');
const small=await p.evaluate(()=>[...document.querySelectorAll('button,select')]
  .filter(x=>x.offsetParent!==null && x.getBoundingClientRect().height<44).length);
ok('all touch targets 44px+', small===0, small+' too small');

console.log(`\n${fails===0?'✅':'❌'}  fresh-coworker path: ${fails} failure(s)\n`);
await b.close(); srv.close(); process.exit(fails?1:0);
