import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;

const KEY='payclock.v1', R = ROOT;
const srv=http.createServer((q,r)=>{
  const u=q.url||'/';
  if(u.startsWith('/sw.js')){r.writeHead(200,{'Content-Type':'text/javascript'});return r.end(readFileSync(R+'sw.js'));}
  if(u.startsWith('/manifest')){r.writeHead(200,{'Content-Type':'application/manifest+json'});return r.end(readFileSync(R+'manifest.webmanifest'));}
  if(u.indexOf('.png')>-1){r.writeHead(404);return r.end();}
  r.writeHead(200,{'Content-Type':'text/html'});r.end(readFileSync(R+'index.html'));
}).listen(8211);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b=await chromium.launch({executablePath: CHROME});

const BASE={configured:true,cfg:{rate:40,otMode:'weekly',periodAnchor:'2026-08-09',
  periodLengthDays:14,payDateOffsetDays:13,weekStartDay:0},
  sessions:[],activeStart:null,sound:false};

/* Each visit is its own context: a Shortcut opens a URL cold, which is the case that matters. */
async function go(url, st){
  const ctx=await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
    timezoneId:'America/New_York',locale:'en-US'});
  const p=await ctx.newPage();
  p.on('pageerror',e=>{console.log('  💥',e.message);fails++;});
  p.on('console',m=>{if(m.type()==='error'){console.log('  💥',m.text());fails++;}});
  await p.addInitScript(([k,v])=>{if(sessionStorage.getItem('__s'))return;sessionStorage.setItem('__s','1');
    if(v) localStorage.setItem(k,JSON.stringify(v)); else localStorage.removeItem(k);},
    [KEY, st===undefined?BASE:st]);
  await p.goto('http://localhost:8211/'+url);
  await p.waitForFunction(()=>typeof state!=='undefined',null,{timeout:15000});
  await p.waitForTimeout(450);
  return p;
}
const running = p => p.evaluate(()=>!!state.activeStart);
const shifts  = p => p.evaluate(()=>state.sessions.length);
const IN = ms => ({...BASE, activeStart: Date.now()-ms});

console.log('\n━━ A link can punch, whether or not it asks for the widget ━━');
/* iOS ignores the manifest's shortcut menu completely, so on an iPhone a Shortcut opening a
   URL is the only route in. The action used to live inside widget mode, which meant a
   Shortcut aimed at the full app could not punch at all. */
{
  let p = await go('?action=clockin');
  ok('the full app punches in from a link', await running(p));
  ok('and says so', /Clocked in/i.test(await p.textContent('#toast')), await p.textContent('#toast'));
  await p.close();
  p = await go('?widget=1&action=clockin');
  ok('so does the widget', await running(p));
  ok('and the widget card is what is shown', await p.isVisible('#wcard'));
  ok('reading as clocked in', /clocked in/i.test(await p.textContent('#wstatus')),
     await p.textContent('#wstatus'));
  await p.close();
}

console.log('\n━━ The action is spent the moment it is read ━━');
/* It used to stay in the address bar, so reloading ran it again. */
{
  let p = await go('?action=clockin');
  ok('the link is stripped from the URL', (await p.evaluate(()=>location.search))==='',
     await p.evaluate(()=>location.search));
  await p.reload(); await p.waitForTimeout(450);
  ok('so a reload does not punch a second time', (await shifts(p))===0 && await running(p),
     'shifts=' + await shifts(p));
  await p.close();

  p = await go('?widget=1&action=clockin');
  ok('but the rest of the query survives', (await p.evaluate(()=>location.search))==='?widget=1',
     await p.evaluate(()=>location.search));
  ok('so the widget is still the widget after a reload', await p.isVisible('#wcard'));
  await p.close();
}

console.log('\n━━ The hazard this was really about ━━');
/* A stale ?action=clockout tab, reloaded after a genuine clock-in, used to end the shift the
   person was standing in. Clocking in twice is harmless because clockIn() guards itself;
   this direction is not harmless at all. */
{
  const p = await go('?widget=1&action=clockout', IN(3600e3));
  ok('the link ends the shift', !(await running(p)));
  ok('and banks it', (await shifts(p))===1, String(await shifts(p)));
  await p.evaluate(()=>clockIn()); await p.waitForTimeout(250);
  ok('the person punches back in for real', await running(p));
  await p.reload(); await p.waitForTimeout(500);
  ok('and reloading that tab no longer ends it', await running(p));
  ok('with nothing extra banked', (await shifts(p))===1, String(await shifts(p)));
  await p.close();
}

console.log('\n━━ One button that does whichever is right ━━');
/* A Lock Screen has room for one, so it has to decide for itself. */
{
  let p = await go('?widget=1&action=toggle');
  ok('out becomes in', await running(p));
  await p.close();
  p = await go('?widget=1&action=toggle', IN(3600e3));
  ok('in becomes out', !(await running(p)));
  ok('banking the shift', (await shifts(p))===1, String(await shifts(p)));
  await p.close();
}

console.log('\n━━ A redundant tap says so rather than doing nothing ━━');
{
  let p = await go('?action=clockin', IN(3600e3));
  ok('clocking in while in explains itself',
     /already clocked in/i.test(await p.textContent('#toast')), await p.textContent('#toast'));
  ok('and does not start a second shift', (await shifts(p))===0, String(await shifts(p)));
  await p.close();
  p = await go('?action=clockout');
  ok('clocking out while out explains itself',
     /nothing to end/i.test(await p.textContent('#toast')), await p.textContent('#toast'));
  ok('and banks nothing', (await shifts(p))===0, String(await shifts(p)));
  await p.close();
}

console.log('\n━━ Ending a shift by link still gets questioned ━━');
/* Arriving by Shortcut is no reason to lose three hours to a punch nobody ended. The full
   app can show that banner, so it does; the widget has nowhere to put it and never could. */
{
  const p = await go('?action=clockout', IN(26*3600e3));
  ok('a punch left running for a day is not banked silently',
     await p.isVisible('#forgotBar'), 'forgotBar hidden');
  ok('and nothing was written yet', (await shifts(p))===0, String(await shifts(p)));
  ok('the shift is still open pending the answer', await running(p));
  await p.close();
}

console.log('\n━━ Nonsense is ignored rather than thrown ━━');
{
  let p = await go('?action=explode');
  ok('an unknown action does nothing', !(await running(p)));
  ok('and leaves a clean URL', (await p.evaluate(()=>location.search))==='');
  await p.close();
  p = await go('?action=clockin', null);            // never set up
  ok('a link into an unconfigured app does not punch', !(await running(p)));
    /* First run stops at the welcome screen now — Lite or Full. This suite exercises the
     full setup form, so take the Full path through it. */
  if (await p.isVisible('#welcome')){ await p.click('#wPick button[data-mode="full"]');
    await p.waitForTimeout(400); }
  ok('it shows setup instead', await p.isVisible('#setup'));
  await p.close();
}

console.log('\n━━ The manifest offers them where they are honoured ━━');
/* Android reads these from the manifest on a long-press; iOS ignores the member entirely,
   which is why the URLs above have to work when opened by hand. */
{
  const m = JSON.parse(readFileSync(R+'manifest.webmanifest','utf8'));
  const urls = (m.shortcuts||[]).map(s=>s.url);
  ok('a toggle shortcut is offered', urls.some(u=>/action=toggle/.test(u)), urls.join(' '));
  ok('as are clock in and clock out',
     urls.some(u=>/action=clockin/.test(u)) && urls.some(u=>/action=clockout/.test(u)), urls.join(' '));
  ok('every shortcut url is one the app acts on',
     (m.shortcuts||[]).every(s=>/^\.\/\?/.test(s.url)), urls.join(' '));
  ok('and each is named for a person, not a developer',
     (m.shortcuts||[]).every(s=>s.name && s.name.length>2 && s.short_name));
}

console.log(fails? `\n❌  ${fails} failed` : '\n✅  all passed');
await b.close(); srv.close();
process.exit(fails?1:0);
