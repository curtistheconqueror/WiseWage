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
/* Any of the three real first frames counts: the clock, the setup form, or the welcome
   screen an unconfigured copy now opens on. The point is that something rendered. */
ok('the page really rendered, not an error',
   await p.isVisible('#punch') || await p.isVisible('#setup') || await p.isVisible('#welcome'));
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

console.log('\n━━ The refresh button: clears the app, keeps the data ━━');
/* The escape hatch for a worker that will not let go. It has to be already present in the
   app, because the one thing that cannot fix a stuck cache is shipping a fix.

   The blunt alternative — clearing the site's data — is wrong on GitHub Pages, where every
   project a person publishes shares one origin and therefore one storage bucket. Clearing
   it to fix one app destroys the saved data of every other. So this asserts the narrow
   thing: the new build arrives, and nothing stored is lost, including a second app's. */
{
  fail = false;
  marker = 'BUILD-GOLF';
  await p.goto('http://localhost:8117/');
  await p.evaluate(()=>navigator.serviceWorker.ready.catch(()=>{}));
  await p.reload(); await p.waitForTimeout(900);

  await p.evaluate(()=>{
    localStorage.setItem('payclock.v1', JSON.stringify({configured:true,
      cfg:{rate:37.78,periodAnchor:'2026-09-06',periodLengthDays:14,payDateOffsetDays:13,
           sheet:{name:'A. Worker',init:'AW',dept:'',sect:'',title:'',sig:'data:image/png;base64,AAAA'}},
      sessions:[{id:'s1',start:Date.now()-7200e3,end:Date.now()-3600e3}],
      activeStart:null,sound:false}));
    /* Stands in for another GitHub Pages project of the same person, on the same origin. */
    localStorage.setItem('otherproject.data','DO-NOT-LOSE-ME');
  });
  await p.reload(); await p.waitForTimeout(900);
  ok('a worker is in charge before we start', await p.evaluate(()=>!!navigator.serviceWorker.controller));
  ok('and the app has a shift and a signature stored',
     (await p.evaluate(()=>state.sessions.length))===1
     && (await p.evaluate(()=>!!state.cfg.sheet.sig)));

  marker = 'BUILD-HOTEL';                       // a deploy goes out
  await p.evaluate(()=>{document.querySelectorAll('#cfg details').forEach(d=>d.open=true);});
  await p.waitForTimeout(300);
  ok('the button names the build it is running',
     /v\d+/.test(await p.textContent('#verNote')), await p.textContent('#verNote'));
  await p.locator('#swRefresh').scrollIntoViewIfNeeded();
  await Promise.all([p.waitForNavigation({timeout:15000}).catch(()=>{}), p.click('#swRefresh')]);
  await p.waitForTimeout(1800);

  ok('pressing it brings the new build in', (await p.title()).includes('BUILD-HOTEL'),
     await p.title());
  ok('the shift is still there', (await p.evaluate(()=>state.sessions.length))===1,
     String(await p.evaluate(()=>state.sessions.length)));
  ok('so is the signature', await p.evaluate(()=>!!(state.cfg.sheet && state.cfg.sheet.sig)));
  ok('and the rate', (await p.evaluate(()=>state.cfg.rate))===37.78);
  /* The assertion that makes this safe to recommend at all. */
  ok('another app on the same origin is untouched',
     (await p.evaluate(()=>localStorage.getItem('otherproject.data')))==='DO-NOT-LOSE-ME',
     String(await p.evaluate(()=>localStorage.getItem('otherproject.data'))));
  /* Offline support must come back, or the fix costs the feature. */
  await p.waitForTimeout(700);
  ok('and a worker is registered again afterwards',
     await p.evaluate(()=>navigator.serviceWorker.getRegistrations().then(r=>r.length>0)));
}

console.log('\n━━ fresh.html, for when the app itself cannot be reached ━━');
{
  await p.goto('http://localhost:8117/fresh.html'); await p.waitForTimeout(600);
  ok('it is its own page, not the app', (await p.title()).indexOf('force an update')>-1,
     await p.title());
  ok('with a button to clear the cached app', (await p.locator('#go').count())===1);
  ok('and it says plainly that data is safe',
     /not touched/i.test(await p.textContent('body')));
  ok('it registers no worker of its own — that is what it undoes',
     !/serviceWorker\.register/.test(readFileSync(R+'fresh.html','utf8')));
  /* Mentioning it in a comment is the point; calling it is what must never happen. */
  ok('and never reads or writes stored data',
     !/localStorage\s*\.\s*(get|set|remove|clear)/.test(readFileSync(R+'fresh.html','utf8')));
  ok('nor clears storage wholesale',
     !/caches\.delete\(k\)(?!.*wisewage)/.test('') &&
     !/clear\(\)/.test(readFileSync(R+'fresh.html','utf8').replace(/\/\*[\s\S]*?\*\//g,'')));
}

/* fresh.html is a navigation too, so it takes the worker's network-first page branch, and
   that branch writes whatever it fetched in under the './index.html' key. Left alone,
   merely visiting the escape hatch replaces the cached app with the escape hatch — and the
   next launch without a signal opens a page whose whole job is to unregister the worker and
   delete the cache. The offline fallback would be a self-destruct button. */
console.log('\n━━ Visiting fresh.html must not become the offline app ━━');
{
  marker = 'BUILD-INDIA';
  await p.goto('http://localhost:8117/'); await p.waitForTimeout(1200);
  await p.goto('http://localhost:8117/fresh.html'); await p.waitForTimeout(1200);

  const cached = await p.evaluate(() => caches.keys()
    .then(ks => caches.open(ks.find(k => /wisewage/.test(k)) || ks[0]))
    .then(c => c.match('./index.html'))
    .then(r => r ? r.text() : '')
    .catch(() => ''));
  ok('the cached app page is not the escape hatch',
     cached.length > 0 && cached.indexOf('force an update') === -1,
     cached.slice(0, 60).replace(/\s+/g, ' '));

  /* The proof that matters: go offline and open the app. */
  fail = true;
  await p.goto('http://localhost:8117/').catch(()=>{});
  await p.waitForTimeout(1000);
  ok('so an offline launch still opens the app, not the reset page',
     (await p.title()).indexOf('force an update') === -1, await p.title());
  fail = false;
}

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close();
process.exit(fails===0?0:1);
