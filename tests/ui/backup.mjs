import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;
// Scratch files (backups under test, screenshots) go to a temp dir, never the repo.
const TMP = join(process.env.TMPDIR || '/tmp', 'wisewage-tests');
try { (await import('node:fs')).mkdirSync(TMP, { recursive: true }); } catch {}


const KEY='payclock.v1';
const srv = http.createServer((q, r) => {
  // Serve real MIME types: the app registers a service worker, and a text/html
  // response for sw.js makes the browser reject it with a console error.
  const R = ROOT;
  if (q.url.startsWith('/sw.js')) { r.writeHead(200,{'Content-Type':'text/javascript'}); return r.end(readFileSync(R+'sw.js')); }
  if (q.url.startsWith('/manifest')) { r.writeHead(200,{'Content-Type':'application/manifest+json'}); return r.end(readFileSync(R+'manifest.webmanifest')); }
  if (q.url.indexOf('.png') > -1) { r.writeHead(404); return r.end(); }
  r.writeHead(200,{'Content-Type':'text/html'}); r.end(readFileSync(R+'index.html'));
}).listen(8092);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const openAll=async pg=>{ try{ await pg.evaluate(()=>document.querySelectorAll('.col').forEach(c=>c.classList.add('open'))); }catch(e){} };
const b=await chromium.launch({executablePath: CHROME});
const ctx=await b.newContext({timezoneId:'America/New_York',locale:'en-US',
  viewport:{width:900,height:1500},acceptDownloads:true});

const day=(d,h)=>+new Date(2026,6,d,h);
const seeded={configured:true,cfg:{rate:38,periodAnchor:'2026-07-26',otMode:'period',
    schedStart:'08:00',schedEnd:'18:00',workDays:[false,true,true,true,true,true,false],
    vacations:[{id:'v',name:'Autumn week',from:'2026-09-07',to:'2026-09-11',hours:8}]},
  sessions:[{id:'x',start:day(27,8),end:day(27,18)},{id:'y',start:day(28,8),end:day(28,18)}],
  absences:[{id:'a1',date:'2026-07-30',kind:'fmla',hours:8,note:'approved'},
            {id:'a2',date:'2026-07-31',kind:'calloff',hours:4,note:''}],
  activeStart:null,unit:'min',planOn:true,plannedHours:10,sound:false};

async function boot(seed){
  const p=await ctx.newPage();
  p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});
  p.on('console',m=>{if(m.type()==='error'){console.log('  CONSOLE ERROR:',m.text());fails++;}});
  await p.addInitScript(([k,v])=>{
    if (sessionStorage.getItem('__seeded')) return;   // a reload must read what the app saved
    sessionStorage.setItem('__seeded','1');
    if (v) localStorage.setItem(k,JSON.stringify(v)); else localStorage.removeItem(k);
  },[KEY,seed]);
  await p.clock.install({time:new Date('2026-07-29T17:00:00Z')});
  await p.goto('http://localhost:8092/'); await p.waitForTimeout(350); await openAll(p);
  return p;
}

console.log('\nSaving a backup');
let p = await boot(seeded);
await p.evaluate(()=>{document.querySelectorAll('#cfg details').forEach(d=>d.open=true)}); await p.waitForTimeout(200);
const dl = await Promise.all([p.waitForEvent('download'), p.click('#backup')]).then(r=>r[0]);
const file = join(TMP, 'backup.json');
await dl.saveAs(file);
ok('backup downloads', !!dl);
ok('named by date', dl.suggestedFilename().includes('2026-07-29'), dl.suggestedFilename());
const data = JSON.parse(readFileSync(file,'utf8'));
ok('marked as a wisewage backup', data.app==='wisewage' && data.version===1);
ok('carries the rate', data.cfg.rate===38, String(data.cfg.rate));
ok('carries the OT rule', data.cfg.otMode==='period', data.cfg.otMode);
ok('carries the period anchor', data.cfg.periodAnchor==='2026-07-26', data.cfg.periodAnchor);
ok('carries both shifts', data.sessions.length===2, String(data.sessions.length));
ok('carries preferences', data.unit==='min' && data.planOn===true && data.plannedHours===10);
/* Absences live outside cfg, so they have to be listed explicitly — they were missing from
   the payload once, which silently dropped every FMLA and call-off on the way out. */
ok('carries the absences', Array.isArray(data.absences) && data.absences.length===2,
   JSON.stringify(data.absences));
ok('with their kind and hours',
   data.absences.some(a=>a.kind==='fmla' && a.hours===8) &&
   data.absences.some(a=>a.kind==='calloff' && a.hours===4), JSON.stringify(data.absences));
ok('and the vacation rides along inside cfg',
   (data.cfg.vacations||[]).length===1, JSON.stringify(data.cfg.vacations));

console.log('\nRestoring into a completely fresh copy');
await p.close();
p = await boot(null);                       // nothing stored — first run
/* First run now opens on the welcome screen — Lite or Full — and setup comes after it. */
ok('fresh copy starts at the welcome screen', await p.isVisible('#welcome'));
await p.setInputFiles('#restoreFile', file); await p.waitForTimeout(500);
ok('the welcome screen is gone after restore', !(await p.isVisible('#welcome')));
ok('and so is setup', !(await p.isVisible('#setup')));
ok('rate restored', (await p.textContent('#liveline')).includes('$38.00'), await p.textContent('#liveline'));
ok('period restored', (await p.textContent('#prange')).includes('Sun Jul 26'), await p.textContent('#prange'));
ok('payday restored', (await p.textContent('#payday')).includes('Fri Aug 21'), await p.textContent('#payday'));
ok('both shifts restored', (await p.locator('#logBody tbody tr[data-row]').count())===2,
   String(await p.locator('#logBody tbody tr[data-row]').count()));
ok('earnings restored', Math.abs(parseFloat((await p.textContent('#cumeGross')).replace(/[$,]/g,''))-760)<0.01, await p.textContent('#cumeGross'));
ok('80 h rule restored', (await p.textContent('#p80Note')).includes('60.00 h'), await p.textContent('#p80Note'));
ok('preferences restored', (await p.inputValue('#planHrs'))==='10' && await p.isChecked('#planOn'));

ok('absences restored', (await p.evaluate(()=>state.absences.length))===2,
   String(await p.evaluate(()=>JSON.stringify(state.absences))));
ok('vacation restored', (await p.evaluate(()=>(state.cfg.vacations||[]).length))===1);

/* The tests above drive #restoreFile straight, which is not a path any person has — it skips
   the button entirely. So it went unnoticed that there WAS no button to reach on a first run:
   restore lives in settings, and applyStage() hides settings until setup is finished. Somebody
   moving to a new phone had to answer a page of questions the restore then threw away. This
   section clicks what a thumb can actually reach. */
console.log('\n━━ Somebody moving in from another phone can reach restore ━━');
await p.close();
p = await boot(null);
/* The very first screen is now the welcome screen, so that is where the route has to be.
   Putting it only on setup would have re-created the exact problem this section was written
   for: a screen in front of restore that has to be answered before restore can be found. */
ok('a fresh copy opens at the welcome screen', await p.isVisible('#welcome'));
ok('and offers restore right there', await p.isVisible('#wRestore'));
{
  const txt = await p.textContent('#welcomeRestore');
  ok('worded for moving, not for setting up',
     /already using|another|moved|phone/i.test(txt), txt);
}
{
  /* The input sits outside every section on purpose. Were it still inside #cfg, this click
     would reach a display:none ancestor and no picker would open — silently, on a phone. */
  const chooser = await Promise.all([
    p.waitForEvent('filechooser', {timeout:4000}),
    p.click('#wRestore'),
  ]).then(r=>r[0]).catch(()=>null);
  ok('tapping it opens a file picker', !!chooser);
  if (chooser) await chooser.setFiles(file);
  await p.waitForTimeout(600); await openAll(p);
}
ok('the welcome screen gives way to the app', !(await p.isVisible('#welcome')));
ok('without stopping at setup', !(await p.isVisible('#setup')));
/* A backup written before Lite existed carries no mode. Such a person had the whole app
   and must get the whole app back — restoring must never quietly hide their cards. */
ok('an older backup comes back as Full', await p.evaluate(()=>appMode()==='full'));
ok('the history came across', (await p.locator('#logBody tbody tr[data-row]').count())===2,
   String(await p.locator('#logBody tbody tr[data-row]').count()));
ok('at the right rate', (await p.textContent('#liveline')).includes('$38.00'), await p.textContent('#liveline'));
ok('and settings is reachable now', await p.isVisible('#cfg'));

console.log('\nSurvives a reload after restore');
await p.reload(); await p.waitForTimeout(400); await openAll(p);
ok('still configured', !(await p.isVisible('#setup')));
ok('shifts still there', (await p.locator('#logBody tbody tr[data-row]').count())===2,
   String(await p.locator('#logBody tbody tr[data-row]').count()));

console.log('\nBad input is refused, not crashed on');
writeFileSync(join(TMP, 'junk.json'),'{"hello":"world"}');
await p.setInputFiles('#restoreFile',join(TMP, 'junk.json')); await p.waitForTimeout(400);
ok('rejects a non-backup file', (await p.textContent('#toast')).includes('not a WiseWage backup'), await p.textContent('#toast'));
ok('existing data untouched', (await p.locator('#logBody tbody tr[data-row]').count())===2,
   String(await p.locator('#logBody tbody tr[data-row]').count()));
writeFileSync(join(TMP, 'bad.json'),'not json at all{{{');
await p.setInputFiles('#restoreFile',join(TMP, 'bad.json')); await p.waitForTimeout(400);
ok('rejects malformed json', (await p.locator('#logBody tbody tr[data-row]').count())===2,
   String(await p.locator('#logBody tbody tr[data-row]').count()));

/* Restoring is "make this device look like that file". Absences already here belong to the
   old data and must not survive onto somebody else's shifts. Last, because pages in one
   context share localStorage and this rewrites it. */
console.log('\nRestoring over an existing copy replaces rather than merges');
await p.close();
p = await boot({...seeded, absences:[{id:'z',date:'2026-07-27',kind:'noshow',hours:8}]});
await p.setInputFiles('#restoreFile', file); await p.waitForTimeout(500);
{
  const got = await p.evaluate(()=>state.absences.map(a=>a.id).sort().join(','));
  ok('the old absence is gone', !got.includes('z'), got);
  ok("and only the file's two remain", got==='a1,a2', got);
}

/* Moving to a new phone, or to a new address, in the middle of a shift. The clock used to be
   dropped on every restore — which is right about a six-month-old file and wrong about the
   case that actually happens, where it silently loses the shift you are standing in. */
console.log('\nA clock still running is judged, not simply dropped');
{
  await p.close();
  /* The seed's schedule runs 09:00–17:00 and the harness stands at 12:00, so a punch made at
     10:00 is an ordinary shift in progress. */
  const midShift = { ...seeded, jobs: undefined,
    activeStart: +new Date('2026-07-29T15:00:00Z') };
  p = await boot(null);
  const f = join(TMP, 'running.json');
  writeFileSync(f, JSON.stringify({ app:'wisewage', version:1, savedAt:new Date().toISOString(),
    cfg: seeded.cfg, sessions: seeded.sessions, absences: [],
    activeStart: midShift.activeStart, configured: true }));
  await p.setInputFiles('#restoreFile', f); await p.waitForTimeout(700);
  const st = await p.evaluate(()=>state.activeStart);
  ok('a punch made two hours ago comes back', st === midShift.activeStart,
     st ? new Date(st).toISOString() : 'dropped');
  ok('and the toast says so', /still clocked in since/.test(await p.textContent('#toast')),
     await p.textContent('#toast'));

  /* An ancient one is a different thing entirely, and must not start accruing money from a
     start three months back. */
  await p.close();
  p = await boot(null);
  const g = join(TMP, 'stale.json');
  writeFileSync(g, JSON.stringify({ app:'wisewage', version:1, savedAt:new Date().toISOString(),
    cfg: seeded.cfg, sessions: seeded.sessions, absences: [],
    activeStart: +new Date('2026-04-01T15:00:00Z'), configured: true }));
  await p.setInputFiles('#restoreFile', g); await p.waitForTimeout(700);
  ok('a punch from April is not restarted', (await p.evaluate(()=>state.activeStart)) === null,
     String(await p.evaluate(()=>state.activeStart)));
  ok('and it says why rather than saying nothing',
     /too long ago to trust/.test(await p.textContent('#toast')), await p.textContent('#toast'));
  ok('pointing at the log for the real fix',
     /from the log/.test(await p.textContent('#toast')), await p.textContent('#toast'));
  ok('the shifts still restored either way',
     (await p.locator('#logBody tbody tr[data-row]').count())>0);
}

console.log(`\n${fails===0?'✅':'❌'}  backup/restore: ${fails} failure(s)\n`);
await b.close(); srv.close(); process.exit(fails?1:0);
