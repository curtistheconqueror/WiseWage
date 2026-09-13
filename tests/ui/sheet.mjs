import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;
const TMP = join(process.env.TMPDIR || '/tmp', 'wisewage-tests');
try { (await import('node:fs')).mkdirSync(TMP, { recursive: true }); } catch {}

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

/* The fixture is the shape of a real revenue-services roster, with nobody's name on it:
   a week of overnight midnight–08:00 runs, then a week of 07:30–15:30 days. */
const D=(d,h,mi=0)=>+new Date(2026,7,d,h,mi);
const sess=[];
[16,17,19,20,22].forEach((d,i)=>sess.push({id:'a'+i,start:D(d,0),end:D(d,8)}));
[23,25,26,27,29].forEach((d,i)=>sess.push({id:'b'+i,start:D(d,7,30),end:D(d,15,30)}));
const seed={configured:true,cfg:{rate:0,otMode:'weekly',periodAnchor:'2026-08-16',periodLengthDays:14,
  payDateOffsetDays:13,weekStartDay:0,workDays:[true,true,true,true,true,true,true]},
  sessions:sess,activeStart:null,sound:false,ui:{open:{sheet:true}}};

async function boot(ctx){
  const p=await ctx.newPage();
  p.on('pageerror',e=>{console.log('  💥',e.message);fails++;});
  p.on('console',m=>{if(m.type()==='error'){console.log('  💥',m.text());fails++;}});
  await p.addInitScript(([k,v])=>{if(sessionStorage.getItem('__s'))return;sessionStorage.setItem('__s','1');
    localStorage.setItem(k,JSON.stringify(v));},[KEY,seed]);
  await p.clock.install({time:new Date('2026-08-29T20:00:00Z')});
  await p.goto('http://localhost:8211/');
  await p.waitForFunction(()=>typeof state!=='undefined',null,{timeout:15000});
  await p.waitForTimeout(700);
  await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
  await p.waitForTimeout(600);
  return p;
}

const ctx=await b.newContext({viewport:{width:900,height:2000},timezoneId:'America/Chicago',
  locale:'en-US',acceptDownloads:true});
let p=await boot(ctx);

console.log('\n━━ The sheet is generated, not copied out by hand ━━');
ok('the card is there', await p.isVisible('#sheet'));
ok('the heading totals the period', /80\.00 h/.test(await p.textContent('#sum_sheet')),
   await p.textContent('#sum_sheet'));
{
  const prev=(await p.textContent('#shPrev')).replace(/\s+/g,' ');
  ok('a midnight sign-in is written 2400, the way the paper is filled in', /2400/.test(prev));
  ok('day shifts carry their four-digit times', /0730/.test(prev) && /1530/.test(prev));
  const totals=await p.evaluate(()=>[...document.querySelectorAll('#shPrev tfoot .num')].map(e=>e.textContent));
  ok('each weekly block totals its days', totals.join('+')==='40.00+40.00', totals.join('+'));
  ok('unworked dates are still drawn, blank',
     (await p.evaluate(()=>document.querySelectorAll('#shPrev tr.blank').length))===4,
     String(await p.evaluate(()=>document.querySelectorAll('#shPrev tr.blank').length)));
}

console.log('\n━━ Who the sheet says you are, asked once ━━');
await p.fill('#shName','A. Worker'); await p.fill('#shInit','AW');
await p.fill('#shDept','South');     await p.fill('#shSect','Revenue Services');
await p.waitForTimeout(400);
ok('stored on the job', (await p.evaluate(()=>state.cfg.sheet.name))==='A. Worker');
await p.reload(); await p.waitForTimeout(800);
await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
await p.waitForTimeout(500);
ok('and still there after a reload', (await p.inputValue('#shName'))==='A. Worker'
   && (await p.inputValue('#shInit'))==='AW');
await p.waitForTimeout(400);
ok('initials appear on every worked row, no retyping',
   ((await p.textContent('#shPrev')).match(/AW/g)||[]).length===10,
   String(((await p.textContent('#shPrev')).match(/AW/g)||[]).length));

console.log('\n━━ Signed once, stamped after ━━');
{
  /* Raw mouse events land in viewport coordinates; a canvas below the fold is unreachable
     until it is scrolled to. locator.click() would do this for us, but drawing needs the
     mouse, and the mouse does not scroll. */
  await p.locator('#shSig').scrollIntoViewIfNeeded(); await p.waitForTimeout(200);
  const cv=await p.locator('#shSig').boundingBox();
  await p.mouse.move(cv.x+30,cv.y+60); await p.mouse.down();
  await p.mouse.move(cv.x+140,cv.y+30,{steps:8}); await p.mouse.move(cv.x+240,cv.y+80,{steps:8});
  await p.mouse.up(); await p.waitForTimeout(400);
  ok('the signature is stored', await p.evaluate(()=>state.cfg.sheet.sig.startsWith('data:image/png')));
  ok('and said to be', /Signed/.test(await p.textContent('#shSigState')), await p.textContent('#shSigState'));
  await p.click('#shSigClear'); await p.waitForTimeout(300);
  ok('clearing it unsigns', (await p.evaluate(()=>state.cfg.sheet.sig))==='');
  /* Measured AGAIN, not reused. Clearing rewrites the status line above the canvas, which
     reflows it — so the box captured before the clear can be a few pixels stale and the
     stroke lands off the canvas. It missed only sometimes, which is worse than always:
     the suite passed or failed on identical code depending on how the text happened to
     wrap, and cost more than one wrong diagnosis before it was chased down. */
  await p.locator('#shSig').scrollIntoViewIfNeeded(); await p.waitForTimeout(200);
  const cv2 = await p.locator('#shSig').boundingBox();
  await p.mouse.move(cv2.x+30,cv2.y+60); await p.mouse.down();
  await p.mouse.move(cv2.x+200,cv2.y+70,{steps:6}); await p.mouse.up(); await p.waitForTimeout(300);
  ok('and it can simply be signed again', await p.evaluate(()=>state.cfg.sheet.sig.length>500));
}

console.log('\n━━ The Word export is the finished form ━━');
{
  const dl=await Promise.all([p.waitForEvent('download'),p.click('#shWord')]).then(r=>r[0]);
  const f=join(TMP,'sheet.doc'); await dl.saveAs(f);
  const doc=readFileSync(f,'utf8');
  ok('named for the period', /time-report-2026-08-16\.doc/.test(dl.suggestedFilename()),
     dl.suggestedFilename());
  ok('titled as the form is', /DAILY TIME REPORT/.test(doc));
  ok('the name is on every worked row', (doc.match(/A\. Worker/g)||[]).length>=10,
     String((doc.match(/A\. Worker/g)||[]).length));
  ok('initialled at sign-in AND at sign-out, like the paper', (doc.match(/>AW</g)||[]).length===20,
     String((doc.match(/>AW</g)||[]).length));
  ok('midnight written 2400', /2400/.test(doc));
  ok('an unworked day keeps its dated line', /08\/18\/2026/.test(doc));
  ok('the signature image is embedded', /data:image\/png/.test(doc));
  ok('each week totals its premises hours', (doc.match(/40\.00/g)||[]).length>=2);
  ok('department and section carried over', /South/.test(doc) && /Revenue Services/.test(doc));
}

console.log('\n━━ The Excel export is the same rows as data ━━');
{
  const dl=await Promise.all([p.waitForEvent('download'),p.click('#shCsv')]).then(r=>r[0]);
  const f=join(TMP,'sheet.csv'); await dl.saveAs(f);
  const csv=readFileSync(f,'utf8'), lines=csv.trim().split('\n');
  ok('a line per date plus header and two totals', lines.length===17, String(lines.length));
  ok('worked rows carry times, hours, initials and name',
     /2026-08-16,2400,0800,8\.00,AW,A\. Worker/.test(csv), lines[1]);
  ok('blank days stay blank rather than inventing zeros', /2026-08-18,,,,,/m.test(csv));
}

console.log('\n━━ Printing shows the sheet and nothing else ━━');
await p.click('#shPrint'); await p.waitForTimeout(300);
ok('the print copy is built', await p.evaluate(()=>document.getElementById('printSheet').innerHTML.length>1000));
await p.emulateMedia({media:'print'}); await p.waitForTimeout(200);
ok('in print media only the sheet shows', await p.evaluate(()=>
  getComputedStyle(document.getElementById('printSheet')).display!=='none'
  && getComputedStyle(document.querySelector('.wrap')).display==='none'));
ok('on white, in ink', await p.evaluate(()=>{
  const cs=getComputedStyle(document.getElementById('printSheet'));
  return cs.backgroundColor==='rgb(255, 255, 255)' && cs.color==='rgb(0, 0, 0)';}));
await p.emulateMedia({media:'screen'});

console.log('\n━━ Filed copies: photos of the signed paper ━━');
{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR4nGP8z8Dwn4EIwESMolGFlAEAoSsDDzuFdmMAAAAASUVORK5CYII=','base64');
  await p.setInputFiles('#shPhotoFile',{name:'filed.png',mimeType:'image/png',buffer:png});
  await p.waitForTimeout(900);
  ok('a thumbnail appears', (await p.locator('#shPhotos .ph').count())===1);
  ok('the photo is NOT in what a backup would carry — the cfg holds only the signature',
     (await p.evaluate(()=>JSON.stringify(state.cfg.sheet).length))<30000,
     (await p.evaluate(()=>JSON.stringify(state.cfg.sheet).length))+' bytes');
  await p.reload(); await p.waitForTimeout(900);
  await p.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open')));
  await p.waitForTimeout(700);
  ok('and it survives a reload on its own', (await p.locator('#shPhotos .ph').count())===1);
  await p.locator('#shPhotos .ph').click(); await p.waitForTimeout(500);
  ok('tapping opens the full view', await p.isVisible('#shView'));
  /* Delete lives in the viewer as a real 44px button — not a tiny badge on the thumbnail,
     which would dodge the touch rule this app holds every other control to. */
  const db=await p.locator('#shViewDel').boundingBox();
  ok('delete is a real tap target', db && db.height>=44, JSON.stringify(db));
  await p.click('#shViewDel'); await p.waitForTimeout(500);
  ok('deleting closes the view', !(await p.isVisible('#shView')));
  ok('and the copy is gone', /None for this period/.test(await p.textContent('#shPhotos')));
}

console.log('\n━━ Work that is counted, not clocked, gets no punch sheet ━━');
{
  await p.evaluate(()=>{const k=Object.keys(PROFESSIONS).find(x=>PROFESSIONS[x].model==='units');
    activeJob().profession=k; save(); applyStage(); lastHeavySig=''; render();});
  await p.waitForTimeout(600);
  ok('hidden for a units profession', !(await p.isVisible('#sheet')));
  await p.evaluate(()=>{activeJob().profession=''; save(); applyStage(); lastHeavySig=''; render();});
  await p.waitForTimeout(600);
  ok('and back for a clocked one', await p.isVisible('#sheet'));
}

console.log('\n━━ On a phone ━━');
await p.close();
const mob=await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
  deviceScaleFactor:3,timezoneId:'America/Chicago',locale:'en-US'});
p=await boot(mob);
{
  const sw=await p.evaluate(()=>[document.documentElement.scrollWidth,window.innerWidth]);
  ok('no sideways scroll', sw[0]===sw[1], sw.join(' vs '));
  const small=await p.evaluate(()=>[...document.querySelectorAll('#sheet button,#sheet input,#sheet select')]
    .filter(x=>x.offsetParent!==null && x.type!=='file')
    .filter(x=>x.getBoundingClientRect().height<44)
    .map(x=>(x.id||x.className)+':'+Math.round(x.getBoundingClientRect().height)));
  ok('every control in the card meets the 44px minimum', small.length===0, small.join(', '));
  const cv=await p.locator('#shSig').boundingBox();
  ok('the signature pad fits the screen', cv && cv.x>=0 && cv.x+cv.width<=390, JSON.stringify(cv));
}

console.log(fails? `\n❌  ${fails} failed` : '\n✅  all passed');
await b.close(); srv.close();
process.exit(fails?1:0);
