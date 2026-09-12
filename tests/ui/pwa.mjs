import { chromium } from 'playwright';
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;
const SRC = ROOT_SRC;
const require_fs = () => createRequire(import.meta.url)('node:fs');
// Scratch files (backups under test, screenshots) go to a temp dir, never the repo.
const TMP = join(process.env.TMPDIR || '/tmp', 'wisewage-tests');
try { (await import('node:fs')).mkdirSync(TMP, { recursive: true }); } catch {}


/* A copy of the app laid out as it would be in its own repository. Built here from the real
   files rather than pointed at a directory somebody prepared earlier — a suite that reads a
   snapshot is a suite that passes while the app it claims to test moves on underneath it. */
const ROOT = join(TMP, 'pay-clock');
(function build(){
  const fs = require_fs();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(join(ROOT, 'icons'), { recursive: true });
  ['index.html', 'sw.js', 'manifest.webmanifest', 'apple-touch-icon.png'].forEach(f => {
    if (fs.existsSync(SRC + f)) fs.copyFileSync(SRC + f, join(ROOT, f));
  });
  fs.readdirSync(SRC + 'icons').forEach(f =>
    fs.copyFileSync(SRC + 'icons/' + f, join(ROOT, 'icons', f)));
})();
const TYPES = {'.html':'text/html','.js':'text/javascript','.webmanifest':'application/manifest+json','.png':'image/png','.json':'application/json'};
const srv = http.createServer((q,r)=>{
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = ROOT + p;
  if (!existsSync(f)) { r.writeHead(404); return r.end('nope'); }
  const ext = p.slice(p.lastIndexOf('.'));
  r.writeHead(200, {'Content-Type': TYPES[ext] || 'application/octet-stream'});
  r.end(readFileSync(f));
}).listen(8094);

let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const openAll=async pg=>{ try{ await pg.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open'))); }catch(e){} };
const b = await chromium.launch({executablePath: CHROME});
// iPhone-ish viewport
const ctx = await b.newContext({timezoneId:'America/New_York',locale:'en-US',
  viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
const p = await ctx.newPage();
p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});
/* Pinned to Thu Jul 30 2026 so the pay-period assertions below stay true. Left on the
   real clock, this suite quietly starts failing the moment a period rolls over — which
   is a rotting test, not a bug in the app. */
await p.clock.install({time:new Date(Date.UTC(2026,6,30,16))});
await p.goto('http://localhost:8094/'); await p.waitForTimeout(600); await openAll(p);

console.log('\nInstallable as a home-screen app');
const man = await p.evaluate(async () => {
  const l = document.querySelector('link[rel=manifest]'); if(!l) return null;
  return await (await fetch(l.href)).json();
});
ok('manifest is linked and valid JSON', !!man);
ok('display: standalone (no browser bars)', man.display === 'standalone', man && man.display);
ok('has 192px and 512px icons', man.icons.some(i=>i.sizes==='192x192') && man.icons.some(i=>i.sizes==='512x512'));
ok('has a maskable icon', man.icons.some(i=>i.purpose==='maskable'));
ok('start_url set', !!man.start_url, man && man.start_url);
ok('apple touch icon present', await p.locator('link[rel="apple-touch-icon"]').count() === 1);
ok('iOS fullscreen meta present', await p.locator('meta[name="apple-mobile-web-app-capable"]').count() === 1);
ok('theme colour set', (await p.getAttribute('meta[name=theme-color]','content')) === '#05080f');
for (const i of man.icons) {
  const res = await p.evaluate(u => fetch(u).then(r=>r.status), new URL(i.src, 'http://localhost:8094/').href);
  ok(`icon ${i.sizes}${i.purpose?' ('+i.purpose+')':''} actually loads`, res === 200, 'HTTP '+res);
}

console.log('\nFirst run asks for your numbers');
/* First run stops at the welcome screen now — Lite or Full. This suite exercises the
   full setup form, so take the Full path through it. */
if (await p.isVisible('#welcome')){ await p.click('#wPick button[data-mode="full"]');
  await p.waitForTimeout(400); }
ok('setup screen shows', await p.isVisible('#setup'));
ok('clock is hidden until set up', !(await p.isVisible('#hero')));
ok('no wage baked into the file', !readFileSync(ROOT+'/index.html','utf8').includes('38.00,'), '');
ok('pay-period date defaults to this week', (await p.inputValue('#sAnchor')).length === 10, await p.inputValue('#sAnchor'));
await p.fill('#sRate','38'); await p.fill('#sAnchor','2026-07-26');
await p.selectOption('#sLen','14'); await p.selectOption('#sPay','13'); await p.waitForTimeout(300);
ok('preview shows the period', (await p.textContent('#sPreview')).includes('Jul 26'), await p.textContent('#sPreview'));
ok('preview shows the payday', (await p.textContent('#sPreview')).includes('Aug 21'), await p.textContent('#sPreview'));
ok('preview shows the OT rate', (await p.textContent('#sPreview')).includes('$57.00'), await p.textContent('#sPreview'));
await p.click('#sMode button[data-m="period"]'); await p.waitForTimeout(200);
ok('80 h option updates the preview', (await p.textContent('#sPreview')).includes('80 h'), await p.textContent('#sPreview'));
await p.click('#sMode button[data-m="weekly"]'); await p.waitForTimeout(150);
await p.click('#sSave'); await p.waitForTimeout(400);
ok('setup closes', !(await p.isVisible('#setup')));
ok('clock appears', await p.isVisible('#hero'));
ok('rate took effect', (await p.textContent('#liveline')).includes('$38.00'), await p.textContent('#liveline'));
ok('period correct', (await p.textContent('#prange')).includes('Sun Jul 26'), await p.textContent('#prange'));
ok('payday correct', (await p.textContent('#payday')).includes('Fri Aug 21'), await p.textContent('#payday'));
await p.screenshot({path:join(TMP, '11-setup-done.png'), fullPage:true});

console.log('\nWorks with no signal');
const reg = await p.evaluate(() => navigator.serviceWorker.ready.then(r => !!r.active).catch(()=>false));
ok('service worker is active', reg);
await p.waitForTimeout(800);
await ctx.setOffline(true);
await p.reload({waitUntil:'domcontentloaded'}); await p.waitForTimeout(700); await openAll(p);
ok('page still loads offline', (await p.title()).includes('WiseWage'), await p.title());
ok('setup is remembered offline', !(await p.isVisible('#setup')));
ok('rate survived offline reload', (await p.textContent('#liveline')).includes('$38.00'), await p.textContent('#liveline'));
await p.click('#punch'); await p.waitForTimeout(1200);
ok('can clock in with no connection', (await p.textContent('#statusTxt')).includes('On the clock'));
ok('and it is earning', parseFloat((await p.textContent('#money')).replace(/[$,]/g,'')) > 0, await p.textContent('#money'));
await ctx.setOffline(false);

console.log('\nPhone layout');
const of = await p.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
ok('no sideways scroll at 390px', of<=0, of+'px');
const tap = await p.evaluate(()=>{const r=document.getElementById('punch').getBoundingClientRect();return Math.min(r.width,r.height);});
ok('clock button is a comfortable tap target', tap>=44, tap.toFixed(0)+'px');
await p.screenshot({path:join(TMP, '12-phone.png'), fullPage:true});

console.log(`\n${fails===0?'✅':'❌'}  PWA: ${fails} failure(s)\n`);
await b.close(); srv.close(); process.exit(fails?1:0);
