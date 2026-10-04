/* Three bugs found by a browser audit of the whole app, each reproduced before it was
   fixed. They share a shape: none of them looked like a bug on screen.

   1. The holiday editor held an ARRAY INDEX. Delete another holiday, or change the preset,
      while it is open and the array reshuffles underneath it — so Save wrote the edit over
      whichever holiday had slid into that slot, and the toast said "Holiday updated."
      Silently wrong holiday pay, confirmed by a success message.

   2. "Erase all data" armed and fired on the SAME 135x44 target. An ordinary double-tap —
      which iOS Safari also generates from double-tap-to-zoom — wiped every shift and
      setting with no undo. The app already had the right pattern a few hundred lines away
      in "Clear this period", which puts the confirm somewhere else entirely.

   3. The night-differential field was only written when the shift being opened already had
      one. It is hidden until a kind is picked, so the LAST shift's rate sat in the DOM:
      mark an ordinary shift as a night shift and it silently inherited $9.75/h from
      whatever you edited before. */
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
}).listen(8412);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`);if(!c)fails++;};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ctx=await b.newContext({viewport:{width:390,height:844},timezoneId:'America/Chicago'});
const p=await ctx.newPage();
p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});
const SEED={configured:true, mode:'full',
  cfg:{rate:37.78,otMode:'eight40',schedStart:'14:00',schedEnd:'22:30',
       workDays:[true,true,true,true,true,false,false],
       periodAnchor:'2026-09-06',periodLengthDays:14,payDateOffsetDays:13,
       holidays:[],banks:[],daysOff:[],vacations:[]},
  sessions:[{id:'a',start:+new Date(2026,8,7,14,0),end:+new Date(2026,8,7,22,0)},
            {id:'b',start:+new Date(2026,8,8,14,0),end:+new Date(2026,8,8,22,0)}],
  activeStart:null,sound:false};
await p.addInitScript((s)=>{ if(sessionStorage.__s)return; sessionStorage.__s=1;
  localStorage.setItem('payclock.v1', JSON.stringify(s)); }, SEED);
await p.goto('http://localhost:8412/'); await p.waitForTimeout(900);
await p.evaluate(()=>{document.querySelectorAll('.col,#cfg details').forEach(c=>{c.classList.add('open'); if(c.tagName==='DETAILS')c.open=true;});});
await p.waitForTimeout(400);

console.log('\n── HIGH 1: editing a holiday after deleting another ──');
await p.evaluate(()=>{ state.cfg.holidays = holidaysFromCatalog(holidayPresetIds('common')); save(); renderHolidayList(); });
await p.waitForTimeout(300);
const before = await p.evaluate(()=>state.cfg.holidays.map(h=>h.name));
await p.evaluate(()=>openHolEditor(2));                       // edit the 3rd
await p.evaluate(()=>{ const btns=[...document.querySelectorAll('#cHolList button')].filter(b=>b.dataset.hdel!=null);
                       btns[0].click(); });                   // delete the 1st
await p.waitForTimeout(300);
await p.evaluate(()=>{ const sv=document.getElementById('hSave'); if(sv) sv.click(); });
await p.waitForTimeout(400);
const after = await p.evaluate(()=>state.cfg.holidays.map(h=>h.name));
const dupes = after.length !== new Set(after).size;
ok('no holiday is duplicated over another', !dupes, after.join(', '));
ok('and one was removed, not two', after.length === before.length-1, `${before.length} → ${after.length}`);

console.log('\n── HIGH 2: erase needs two different targets ──');
await p.evaluate(()=>document.getElementById('wipe').click());
await p.evaluate(()=>document.getElementById('wipe').click());   // double-tap the same pixel
await p.waitForTimeout(400);
ok('a double-tap does not erase anything', (await p.evaluate(()=>state.sessions.length))===2,
   String(await p.evaluate(()=>state.sessions.length)));
ok('it asks, somewhere else', await p.isVisible('#wipeConfirm'));
await p.click('#wipeNo'); await p.waitForTimeout(200);
ok('and backing out keeps the data', (await p.evaluate(()=>state.sessions.length))===2);

console.log('\n── HIGH 3: a differential must not follow you to the next shift ──');
/* Put the differential on shift B directly, then open B and A in turn through the real
   editor — what is under test is what openEditor() leaves in the field. */
await p.evaluate(()=>{ const s=state.sessions.find(x=>x.id==='b');
                       s.adj={diff:9.75}; save(); render(); });
await p.evaluate(()=>openEditor('b')); await p.waitForTimeout(200);
ok('a shift that has one shows its own', (await p.evaluate(()=>el('eDiff').value))==='9.75',
   await p.evaluate(()=>el('eDiff').value));
await p.evaluate(()=>openEditor('a')); await p.waitForTimeout(200);
const leaked = await p.evaluate(()=>el('eDiff').value);
ok('a shift that has none shows the default, not the last one', leaked === '2', leaked);
await p.evaluate(()=>openEditor('b')); await p.waitForTimeout(200);
ok('and going back still shows the real one', (await p.evaluate(()=>el('eDiff').value))==='9.75');

/* Found by the same audit: nothing stopped two of the eight editor panels being open at
   the same time. Two Save buttons for different things on one screen, and — the part that
   could cost you — a live editing id left behind in the panel you walked away from, so
   the wrong Save could write to a holiday you were no longer looking at. */
console.log('\n── Only one editor open at a time ──');
await p.evaluate(()=>{ state.cfg.banks=[{id:'float',name:'Floater',count:3,hours:8,ot:false}];
  save(); renderBanks(); renderBankCfg(); });
await p.waitForTimeout(250);
const panels = () => p.evaluate(()=>[...document.querySelectorAll('.editor')]
  .filter(e=>!e.classList.contains('hide')).map(e=>e.id));

await p.evaluate(()=>openHolEditor(1)); await p.waitForTimeout(200);
ok('the holiday editor opens alone', (await panels()).join()==='holEdit', (await panels()).join()||'(none)');
const heldHoliday = await p.evaluate(()=>holEditing);
ok('and it is holding that holiday', !!heldHoliday, String(heldHoliday));

await p.evaluate(()=>openVacation(null)); await p.waitForTimeout(200);
ok('opening the vacation editor closes it', (await panels()).join()==='vacEdit', (await panels()).join()||'(none)');
ok('and lets go of the holiday it was editing',
   (await p.evaluate(()=>holEditing))===null, String(await p.evaluate(()=>holEditing)));

await p.evaluate(()=>openOffEditor(null)); await p.waitForTimeout(200);
ok('the day-off editor replaces that one too', (await panels()).join()==='offEdit', (await panels()).join()||'(none)');
ok('and the vacation editor let go as well',
   (await p.evaluate(()=>vacEditing))===null, String(await p.evaluate(()=>vacEditing)));

await p.evaluate(()=>openEditor('a')); await p.waitForTimeout(200);
ok('and a shift editor in another card closes the lot', (await panels()).join()==='editor',
   (await panels()).join()||'(none)');
ok('with nothing left holding a day off',
   (await p.evaluate(()=>offEditing))===null, String(await p.evaluate(()=>offEditing)));
/* The log's two editors both hide `logActions`, so whichever opens last has to win it. */
await p.evaluate(()=>openAbsence ? openAbsence() : null); await p.waitForTimeout(250);
const logState = await p.evaluate(()=>({ panels:[...document.querySelectorAll('.editor')]
  .filter(e=>!e.classList.contains('hide')).map(e=>e.id),
  actionsHidden: document.getElementById('logActions').classList.contains('hide') }));
ok('the absence editor replaces the shift editor', logState.panels.join()==='absEdit',
   logState.panels.join()||'(none)');
ok('and the log actions stay hidden behind it, not restored by the panel it closed',
   logState.actionsHidden, JSON.stringify(logState));

console.log(`\n${fails===0?'✅':'❌'} ${fails===0?'all fixed':fails+' failed'}`);
await b.close(); srv.close(); process.exit(fails?1:0);
