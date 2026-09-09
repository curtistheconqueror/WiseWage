/* Does a deploy actually reach an installed app?

   GitHub Pages serves HTML with Cache-Control: max-age=600. A service worker that calls
   plain fetch() is answered by the browser's own HTTP cache for those ten minutes and
   never reaches the origin — so the app looks unchanged after a deploy, and the stale
   copy gets written in as the offline fallback on top of that. This serves the page the
   way Pages does, changes it mid-flight, and asks whether reopening sees the change. */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;

const R = ROOT;
const TYPES={'.html':'text/html','.js':'text/javascript','.webmanifest':'application/manifest+json',
             '.png':'image/png','.json':'application/json'};
let marker = 'BUILD-ALPHA';
/* Flipped by the test to make the origin unreachable for the page, the way a phone with
   no signal — or a fetch the engine refuses — looks to the worker. */
let fail = false;
/* Everything the worker precaches has to be served for real: install runs
   cache.addAll(ASSETS), and a single 404 in there rejects the whole install, so the
   worker never activates and the test measures nothing. */
const srv=http.createServer((q,r)=>{
  let path=decodeURIComponent(q.url.split('?')[0]);
  const isPage = path==='/' || path==='/index.html';
  if (isPage){
    if (fail){ r.destroy(); return; }
    // the page, served exactly the way GitHub Pages serves it
    const html=readFileSync(R+'index.html','utf8').replace('<title>','<title>'+marker+' ');
    r.writeHead(200,{'Content-Type':'text/html','Cache-Control':'max-age=600'});
    return r.end(html);
  }
  const f=R+path;
  if(!existsSync(f)){r.writeHead(404);return r.end('nope');}
  const ext=path.slice(path.lastIndexOf('.'));
  // GitHub serves the worker itself uncached; assets get the usual long max-age
  r.writeHead(200,{'Content-Type':TYPES[ext]||'application/octet-stream',
                   'Cache-Control': path==='/sw.js' ? 'no-cache' : 'max-age=600'});
  r.end(readFileSync(f));
}).listen(8117);

let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b=await chromium.launch({executablePath: CHROME});
const ctx=await b.newContext({viewport:{width:390,height:844},timezoneId:'America/New_York',locale:'en-US'});
const p=await ctx.newPage();
p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});

console.log('\n━━ First install ━━');
// The app registers its worker on window.load, so the very first page view is not yet
// controlled by it. Wait for the registration to activate, then reload once — that is
// the visit where the worker is actually in charge, and every visit after it.
await p.goto('http://localhost:8117/');
const active = await p.evaluate(() => navigator.serviceWorker.ready.then(r=>!!r.active).catch(()=>false));
ok('the worker installs', active);
await p.reload(); await p.waitForTimeout(1000);
ok('the worker takes over', await p.evaluate(()=>!!navigator.serviceWorker.controller));
ok('running the first build', (await p.title()).includes('BUILD-ALPHA'), await p.title());

console.log('\n━━ A deploy goes out ━━');
marker = 'BUILD-BRAVO';
// no waiting: this is the same minute, well inside the ten-minute max-age window
await p.reload(); await p.waitForTimeout(900);
ok('reopening picks up the new build straight away',
   (await p.title()).includes('BUILD-BRAVO'), await p.title());

console.log('\n━━ And a second one, still inside the window ━━');
marker = 'BUILD-CHARLIE';
await p.reload(); await p.waitForTimeout(900);
ok('still current', (await p.title()).includes('BUILD-CHARLIE'), await p.title());

console.log('\n━━ What got stored for offline is the new one, not the old ━━');
await ctx.setOffline(true);
await p.reload(); await p.waitForTimeout(900);
ok('the app still loads with no signal', (await p.title()).length > 0, await p.title());
ok('and it is the newest build, not a stale copy',
   (await p.title()).includes('BUILD-CHARLIE'), await p.title());
ok('the page really rendered, not an error', await p.isVisible('#punch') || await p.isVisible('#setup'));
await ctx.setOffline(false);

console.log('\n━━ Back online, a later deploy still arrives ━━');
marker = 'BUILD-DELTA';
await p.reload(); await p.waitForTimeout(900);
ok('current again', (await p.title()).includes('BUILD-DELTA'), await p.title());

console.log('\n━━ A device that once fell back to cache does not stay there ━━');
/* The real failure this guards against: an iPhone sat on one build for over a day across
   seven cold starts while the server had the next one. The worker fetched the page with
   { cache: 'no-store' }; if that option is unsupported or the fetch rejects for any
   reason, the branch falls through to the cached copy — and since the cache is only
   rewritten after a SUCCESSFUL fetch, a device that lands there once never leaves.
   Simulated by failing the page request outright, then letting it recover. */
{
  marker = 'BUILD-ECHO';
  fail = true;                                  // every page request now errors
  await p.reload().catch(()=>{}); await p.waitForTimeout(900);
  ok('offline-ish, it still opens from cache', /BUILD-/.test(await p.title()), await p.title());
  fail = false;                                 // the network comes back
  marker = 'BUILD-FOXTROT';
  await p.reload(); await p.waitForTimeout(900);
  ok('and the very next open is current again, not pinned to the cached copy',
     (await p.title()).includes('BUILD-FOXTROT'), await p.title());
}

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close();
process.exit(fails===0?0:1);
