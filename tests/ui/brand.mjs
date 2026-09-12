/* The name has to be visible in every state the app can be opened in. */
import { chromium } from 'playwright';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;

const R = ROOT, KEY='payclock.v1';
const T={'.html':'text/html','.js':'text/javascript','.webmanifest':'application/manifest+json','.png':'image/png'};
const srv=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);
  if(p==='/'||p==='/index.html'){r.writeHead(200,{'Content-Type':'text/html'});return r.end(readFileSync(R+'index.html'));}
  if(p==='/favicon.ico'){r.writeHead(204);return r.end();}
  const f=R+p; if(!existsSync(f)){r.writeHead(404);return r.end('no');}
  r.writeHead(200,{'Content-Type':T[p.slice(p.lastIndexOf('.'))]||'application/octet-stream'});r.end(readFileSync(f));
}).listen(8179);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b=await chromium.launch({executablePath: CHROME});
const ctx=await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
  deviceScaleFactor:3,timezoneId:'America/Chicago',locale:'en-US'});
const full={configured:true,cfg:{rate:37.78,otMultiplier:1.5,otMode:'weekly',weeklyThreshold:40,
  periodThreshold:80,dailyThreshold:8,shiftThreshold:8,weekStartDay:0,periodAnchor:'2026-08-09',
  periodLengthDays:14,payDateOffsetDays:13,schedStart:'14:00',schedEnd:'22:30',lunchMins:30,
  workDays:[false,true,true,true,true,true,false]},sessions:[],absences:[],activeStart:null,
  unit:'sec',ui:{open:{}},net:{}};
async function open(st, qs=''){
  const p=await ctx.newPage();
  p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});
  if (st) await p.addInitScript(([k,v])=>{if(sessionStorage.getItem('__s'))return;
    sessionStorage.setItem('__s','1');localStorage.setItem(k,JSON.stringify(v));},[KEY,st]);
  await p.goto('http://localhost:8179/'+qs); await p.waitForTimeout(700);
  return p;
}
// Visible means on screen with real size, not merely present in the DOM.
const seen = (p,sel)=>p.evaluate(s=>{const e=document.querySelector(s); if(!e) return false;
  const r=e.getBoundingClientRect(), st=getComputedStyle(e);
  return r.width>0 && r.height>0 && st.display!=='none' && st.visibility!=='hidden' && +st.opacity>0;}, sel);

const cases = [
  ['a brand new install, nothing set up',   null,                                    ''],
  ['a configured app',                      full,                                    ''],
  ['mid-shift, on the clock',               {...full, activeStart: Date.now()-3600e3},''],
  ['light theme',                           {...full, theme:'light'},                ''],
  ['every section collapsed',               {...full, ui:{open:{}}},                 ''],
  ['net mode on',                           {...full, net:{enabled:true,configured:true,filing:'single',
                                              dependents:0,ficaOn:true,statePct:4.95,items:[]}}, ''],
];
console.log('\n━━ The name is on screen in every state ━━');
for (const [label, st, qs] of cases){
  const p = await open(st, qs);
  /* Either heading counts. A brand new install now opens on the welcome screen, which
     carries the mark and the name itself and hides the app header so that the two are not
     on screen saying the same thing in different words. What this suite protects is that
     the name is visible in every state, not that one particular element is showing it. */
  const via = (await seen(p,'header')) ? 'header h1'
            : (await seen(p,'#welcome')) ? '#welcome h1' : null;
  const h1 = via ? await p.textContent(via).catch(()=>'') : '';
  ok(label, !!via && h1==='WiseWage', (h1 || '(no h1)') + (via ? ' — via ' + via : ''));
  await p.close();
}

console.log('\n━━ The compact widget carries it too ━━');
let p = await open(full, '?widget=1');
ok('the widget card is what renders', await seen(p,'#wcard'));
ok('the full header is deliberately hidden', !(await seen(p,'header')));
ok('but the name is still on screen', await seen(p,'#wbrand'),
   await p.textContent('#wbrand').catch(()=>'(missing)'));
await p.close();
p = await open(null, '?widget=1');
ok('and on an unconfigured widget too', await seen(p,'#wbrand'),
   await p.textContent('#wbrand').catch(()=>'(missing)'));
await p.close();

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close(); process.exit(fails===0?0:1);
