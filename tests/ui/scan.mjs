/* Scanning a photographed punch card.

   The pipeline is: read the stamps, pair them by the clock, check the pairs against the
   roster, show every row, write only what was ticked, and keep one press undoable.

   What these tests are really guarding is that NOTHING between the photo and the money is
   trusted. The engine that pairs punches is blind in one expensive way — when a punch does
   not take, the parity of the stream flips and every pair after it becomes the GAP BETWEEN
   two shifts wearing a shift\'s clothes. Measured on the real card that produced this
   feature: drop any one of eight punches and the hours come out wrong every time, and in
   four of those eight cases every pair comes back with no flags at all. scanReview is the
   guard, and it can only work because WiseWage knows the roster the engine cannot see.

   The other thing guarded here is the undo. A scan marks both the shifts it ADDED and the
   shifts it CORRECTED with the same batch stamp, and the first version of the undo swept
   everything carrying that stamp — destroying a shift that existed before the scan and
   belonged to the person rather than to the import. An import must never be the way a
   record leaves. */
import { chromium } from 'playwright';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
const TY={'.html':'text/html','.js':'text/javascript','.webmanifest':'application/manifest+json','.png':'image/png'};
const srv=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);
 if(p==='/'||p==='/index.html'){r.writeHead(200,{'Content-Type':'text/html'});return r.end(readFileSync(R+'index.html'));}
 if(p==='/favicon.ico'){r.writeHead(204);return r.end();}
 const f=R+p; if(!existsSync(f)){r.writeHead(404);return r.end('no');}
 r.writeHead(200,{'Content-Type':TY[p.slice(p.lastIndexOf('.'))]||'application/octet-stream'});r.end(readFileSync(f));
}).listen(8322);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`);if(!c)fails++;};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ctx=await b.newContext({viewport:{width:390,height:1400},timezoneId:'America/Chicago'});
const p=await ctx.newPage();
p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});
p.on('console',m=>{if(m.type()==='error'){console.log('  CONSOLE ERROR:',m.text());fails++;}});

/* Curtis's real shape, with the four clean shifts already logged slightly wrong. */
await p.addInitScript(()=>{ if(sessionStorage.__s)return; sessionStorage.__s=1;
  localStorage.setItem('payclock.v1', JSON.stringify({configured:true, mode:'full',
    cfg:{rate:37.78, otMode:'eight40', schedStart:'14:00', schedEnd:'22:30', lunchMins:0,
         workDays:[true,true,true,true,true,false,false],
         periodAnchor:'2026-09-06', periodLengthDays:14, payDateOffsetDays:13,
         holidays:[], banks:[], daysOff:[], vacations:[]},
    sessions:[{id:'a1',start:new Date(2026,8,6,13,18).getTime(),end:new Date(2026,8,7,1,6).getTime()},
              {id:'a2',start:new Date(2026,8,7,13,55).getTime(),end:new Date(2026,8,7,22,30).getTime()}],
    activeStart:null, sound:false, ui:{open:{scan:true}}}));
});
await p.goto('http://localhost:8322/'); await p.waitForTimeout(900);
ok('app boots with the scan card', await p.isVisible('#scan'));
ok('engine reached the page', await p.evaluate(()=>typeof pairPunches==='function'&&typeof scanReview==='function'));

/* Type the ten real stamps. */
const CARD=["'26 SEP  6 PM  1:18","26 SEP  7 AM  1:06","'26 SEP  7 PM  1:55","26 SEP  7 PM 11:47",
 "'26 SEP  8 PM  2:00","26 SEP  8 PM 10:43","'26 SEP  9 PM  2:02","26 SEP 10 AM 12:07",
 "26 SEP 10 PM 11:33","'26 SEP 12 PM  1:01"];
await p.click('#scanTypeToggle'); await p.waitForTimeout(200);
await p.fill('#scanManual', CARD.join('\n'));
await p.click('#scanRead'); await p.waitForTimeout(600);
ok('the review table appears', await p.isVisible('#scanResult'));
const rows = await p.locator('#scanTbl tbody tr').count();
ok('five pairs read off the card', rows===5, String(rows));
const summary = (await p.textContent('#scanSummary')).replace(/\s+/g,' ').trim();
ok('summary names what needs a look', /need a look/.test(summary), summary);
const flagged = await p.locator('#scanTbl tbody tr.flagged').count();
ok('the bogus 37h pair is flagged', flagged>=1, flagged+' flagged rows');
const body = await p.textContent('#scanTbl');
ok('it shows the delta against the logged shift', /\+|−|-/.test(body));

/* Apply, then check the numbers moved and undo restores. */
const before = await p.evaluate(()=>state.sessions.length);
await p.click('#scanApply'); await p.waitForTimeout(700);
const after = await p.evaluate(()=>state.sessions.length);
ok('applying adds the missing shifts', after>before, `${before} → ${after}`);
ok('the corrected Monday now ends 23:47', await p.evaluate(()=>{
  const s=state.sessions.find(s=>s.id==='a2'); return new Date(s.end).getHours()===23 && new Date(s.end).getMinutes()===47;}));
ok('every applied shift keeps its verbatim stamp', await p.evaluate(()=>
  state.sessions.filter(s=>s.scanBatch).every(s=>typeof s.scanRaw==='string'&&s.scanRaw.length>0)));
ok('undo is offered', await p.isVisible('#scanUndoWrap'));
await p.click('#scanUndoBtn'); await p.waitForTimeout(700);
ok('undo restores the original count', (await p.evaluate(()=>state.sessions.length))===before,
   String(await p.evaluate(()=>state.sessions.length)));
ok('and the original Monday end time', await p.evaluate(()=>{
  const s=state.sessions.find(s=>s.id==='a2'); return new Date(s.end).getHours()===22 && new Date(s.end).getMinutes()===30;}));
await p.screenshot({path: R + 'tests/ui/scan.png', fullPage:true});

/* ── Reading a copy already filed ──────────────────────────────────────────
   The first version made you photograph the card a second time, inside a different card,
   to read a photo the app was already holding. This is the route from the filed copy. */
{
  await p.evaluate(()=>{ document.querySelectorAll('#cfg details,.col').forEach(d=>d.classList.add('open')); });
  ok('the viewer offers a read button', await p.evaluate(()=>!!document.getElementById('shViewScan')));
  ok('and a delete button, apart from it', await p.evaluate(()=>{
    const bar=document.querySelector('.shviewbar');
    return !!(bar && bar.querySelector('#shViewScan') && bar.querySelector('#shViewDel'));
  }));
  ok('both are one entry point, not two pipelines',
     await p.evaluate(()=>typeof scanFromBlob==='function'));
  /* A filed copy is a Blob; the camera hands over a File, which is a Blob. Same door. */
  const routed = await p.evaluate(async () => {
    const cv=document.createElement('canvas'); cv.width=cv.height=40;
    const blob=await new Promise(r=>cv.toBlob(r,'image/jpeg',0.7));
    state.scanKey='';                       // no key: must refuse, and say how to proceed
    scanFromBlob(blob);
    await new Promise(r=>setTimeout(r,300));
    const err=document.getElementById('scanErr');
    return { shown: !!err && !err.classList.contains('hide'), text: err? err.textContent : '',
             manualOpen: !document.getElementById('scanManualWrap').classList.contains('hide') };
  });
  ok('with no key it refuses rather than failing silently', routed.shown);
  ok('and names the way that still works', /Type the stamps/i.test(routed.text), routed.text.slice(0,70));
  ok('opening the typing box for you', routed.manualOpen);
}

console.log(`\n${fails===0?'✅':'❌'} ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close(); process.exit(fails?1:0);
