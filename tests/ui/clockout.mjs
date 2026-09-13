/* "Forgot to clock out?" — the mirror of "Missed your clock in?", and missing until now.

   Without it, realising at home that you never punched out meant clocking out at the wrong
   time on purpose and then editing the shift in the log: two steps, the first of which puts
   a figure into the app you know is false, and a gap in between where every total on screen
   is wrong. clockOut() already accepted a time, so what was missing was a way in, not any
   arithmetic.

   The two guards are the ones that cost money if they slip. An end in the future pays for
   time not yet worked. An end at or before the clock-in would bin the shift entirely —
   clockOut() silently falls back to "now" in that case, which is defensible as a last
   resort inside the engine and useless as an answer to somebody typing a time. Both are
   refused here, out loud, rather than quietly adjusted. */
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
}).listen(8377);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`);if(!c)fails++;};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ctx=await b.newContext({viewport:{width:390,height:1400},timezoneId:'America/Chicago'});
const p=await ctx.newPage();
p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});
/* Pinned so "in the future" means something fixed: on the clock since 14:00, and it is now
   23:30 — home, an hour and a half after leaving, which is exactly when somebody realises. */
const NOW = new Date(2026,8,9,23,30,0);
await p.clock.install({ time: NOW });
await p.addInitScript(()=>{ if(sessionStorage.__s)return; sessionStorage.__s=1;
  const st=new Date(2026,8,9,14,0,0);
  localStorage.setItem('payclock.v1', JSON.stringify({configured:true, mode:'full',
    cfg:{rate:37.78,otMode:'eight40',schedStart:'14:00',schedEnd:'22:30',lunchMins:0,
         workDays:[true,true,true,true,true,false,false],
         periodAnchor:'2026-09-06',periodLengthDays:14,holidays:[],banks:[],daysOff:[],vacations:[]},
    sessions:[], activeStart:st.getTime(), sound:false, ui:{open:{hero:true}}}));
});
await p.goto('http://localhost:8377/'); await p.waitForTimeout(800);
ok('on the clock', await p.evaluate(()=>!!state.activeStart));
ok('the forgot-to-clock-out way in is offered', await p.isVisible('#outOpen'));
ok('and the clock-in one is not', !(await p.isVisible('#backOpen')));
await p.click('#outOpen'); await p.waitForTimeout(300);
ok('the editor opens', await p.isVisible('#backout'));
const pv = await p.textContent('#coPreview');
ok('it previews what will be banked', /h/.test(pv) && /\$/.test(pv), pv.replace(/\s+/g,' ').slice(0,90));
/* Refuse a future time and a time before the start. */
await p.fill('#coTime','23:59'); await p.waitForTimeout(200);
await p.click('#coStop'); await p.waitForTimeout(250);
const e1 = await p.isVisible('#coErr') ? await p.textContent('#coErr') : '';
ok('a future time is refused', /future/i.test(e1), e1);
await p.fill('#coTime','13:00'); await p.waitForTimeout(200);
await p.click('#coStop'); await p.waitForTimeout(250);
const e2 = await p.isVisible('#coErr') ? await p.textContent('#coErr') : '';
ok('a time before the clock-in is refused', /before you clocked in/i.test(e2), e2);
/* The real case: left at 22:43, realised later. */
await p.fill('#coTime','22:43'); await p.waitForTimeout(250);
await p.click('#coStop'); await p.waitForTimeout(600);
ok('the clock stops', await p.evaluate(()=>!state.activeStart));
const sess = await p.evaluate(()=>state.sessions.map(s=>({h:(s.end-s.start)/3600000, end:new Date(s.end).getHours()+':'+new Date(s.end).getMinutes()})));
ok('one shift banked', sess.length===1, JSON.stringify(sess));
ok('ending at 22:43, not now', sess[0] && sess[0].end==='22:43', JSON.stringify(sess[0]));
ok('worth 8.72 h', sess[0] && Math.abs(sess[0].h-8.7167)<0.01, String(sess[0] && sess[0].h.toFixed(4)));
ok('and the button is gone now the clock is off', !(await p.isVisible('#outOpen')));
ok('with the clock-in one back', await p.isVisible('#backOpen'));
console.log(`\n${fails===0?'✅':'❌'} ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close(); process.exit(fails?1:0);
