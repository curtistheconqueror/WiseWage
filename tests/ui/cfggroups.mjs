/* Settings broken into collapsible groups: nothing lost, nothing broken, summaries live. */
import { chromium } from 'playwright';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The app under test sits two directories up from tests/ui/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
// Set PW_CHROME to point at a specific build; otherwise Playwright finds its own.
const CHROME = process.env.PW_CHROME || undefined;

const R = ROOT, KEY='payclock.v1';
const TY={'.html':'text/html','.js':'text/javascript','.webmanifest':'application/manifest+json','.png':'image/png'};
const srv=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);
  if(p==='/'||p==='/index.html'){r.writeHead(200,{'Content-Type':'text/html'});return r.end(readFileSync(R+'index.html'));}
  if(p==='/favicon.ico'){r.writeHead(204);return r.end();}
  const f=R+p; if(!existsSync(f)){r.writeHead(404);return r.end('no');}
  r.writeHead(200,{'Content-Type':TY[p.slice(p.lastIndexOf('.'))]||'application/octet-stream'});r.end(readFileSync(f));
}).listen(8183);
let fails=0; const ok=(n,c,x='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++;};
const b=await chromium.launch({executablePath: CHROME});
const T=(d,h)=>Date.UTC(2026,7,d,h+5,0);
const seed={configured:true,cfg:{rate:37.78,otMultiplier:1.5,otMode:'weekly',weeklyThreshold:40,
  periodThreshold:80,dailyThreshold:8,shiftThreshold:8,weekStartDay:0,periodAnchor:'2026-08-09',
  periodLengthDays:14,payDateOffsetDays:13,schedStart:'14:00',schedEnd:'22:30',lunchMins:30,
  workDays:[true,true,true,true,true,false,false],clock24:false,
  nightOn:true,nightFrom:'18:00',nightTo:'06:00',nightRate:0.15,
  vacations:[{id:'v1',name:'Vacation',from:'2026-09-20',to:'2026-10-03',hours:8,ot:false}],
  shiftDayRule:'majority',skewOn:false,makeUpOn:false},
  sessions:[{id:'a',start:T(10,14),end:T(10,22)+30*60000},{id:'b',start:T(11,14),end:T(11,22)+30*60000}],
  absences:[],activeStart:null,unit:'sec',sound:true,ui:{open:{}},net:{}};
const ctx=await b.newContext({viewport:{width:390,height:900},isMobile:true,hasTouch:true,
  deviceScaleFactor:3,timezoneId:'America/Chicago',locale:'en-US'});
async function boot(){
  const p=await ctx.newPage();
  p.on('pageerror',e=>{console.log('  PAGE ERROR:',e.message);fails++;});
  p.on('console',m=>{if(m.type()==='error'){console.log('  CONSOLE ERROR:',m.text());fails++;}});
  await p.addInitScript(([k,v])=>{if(sessionStorage.getItem('__s'))return;
    sessionStorage.setItem('__s','1');localStorage.setItem(k,JSON.stringify(v));},[KEY,seed]);
  await p.clock.install({time:new Date(T(12,16))});
  await p.goto('http://localhost:8183/'); await p.waitForTimeout(700);
  await p.evaluate(()=>{const d=document.querySelector('#cfg>details'); if(d) d.open=true;});
  await p.waitForTimeout(300); return p;
}
const CONTROLS=`cRate cMult cMode cWeekStart cWeekThr cPeriodThr cDailyThr cShiftThr cAnchor cLen
cPayOff cClock24 cSound cLunch cLunchExtra rNew rDate rApply cYtd cSchedStart2 cSchedEnd2 cNightOn
cNightRate cNightFrom cNightTo cShiftDay cSkewOn cSkewMins cMakeUp cMakeUpWin cOffDayOt cHolHours cHolAdj
cHolOffDay cHolAdd cHolPreset cBankAdd cBankReset cVacAdd presets tFont tBgStyle swatches themeReset
backup restore wipe`.split(/\s+/).filter(Boolean);

let p=await boot();
console.log('\n━━ Settings opens to nine headings, not fifty controls ━━');
const secs=await p.$$eval('#cfg .cfgsec',es=>es.map(e=>({id:e.id,open:e.open,
  title:e.querySelector('.cfgt').textContent})));
/* Counted against the app's own list rather than a number written here. A new group must
   arrive with a heading and a place in the order; it must not arrive by breaking a test
   whose only complaint is that there is one more than there used to be. */
const appGroups=await p.evaluate(()=>CFG_GROUPS.slice());
ok('one heading per group', secs.length===appGroups.length,
   secs.length+' of '+appGroups.length+': '+secs.map(s=>s.title).join(' | '));
ok('every heading is named', secs.every(s=>s.title && s.title.trim().length>2),
   secs.map(s=>JSON.stringify(s.title)).join(' | '));
ok('and no two share a name', new Set(secs.map(s=>s.title)).size===secs.length,
   secs.map(s=>s.title).join(' | '));
ok('all closed on a first run', secs.every(s=>!s.open), JSON.stringify(secs.map(s=>s.open)));
ok('they are in the order planned', secs.map(s=>s.id).join()===appGroups.join(),
   secs.map(s=>s.id).join()+' vs '+appGroups.join());
const visible=await p.evaluate(()=>[...document.querySelectorAll('#cfg input,#cfg select')]
  .filter(e=>e.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true})).length);
ok('almost nothing is on screen until you open one', visible<=2, visible+' controls visible');

console.log('\n━━ Every control survived the move ━━');
const present=await p.evaluate(ids=>ids.filter(i=>!document.getElementById(i)),CONTROLS);
ok('no control was lost', present.length===0, present.join(',')||'all '+CONTROLS.length+' present');
await p.evaluate(()=>document.querySelectorAll('#cfg .cfgsec').forEach(d=>d.open=true));
await p.waitForTimeout(400);
const reach=await p.evaluate(ids=>ids.filter(i=>{const e=document.getElementById(i);
  return !e || !e.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true});}),CONTROLS);
ok('and every one is reachable once its group is open', reach.length===0, reach.join(',')||'all reachable');

console.log('\n━━ A folded group still tells you what is inside ━━');
await p.evaluate(()=>document.querySelectorAll('#cfg .cfgsec').forEach(d=>d.open=false));
await p.waitForTimeout(300);
/* Keyed by group rather than by position. Indices shift every time a group is added, and
   a suite that then checks the wrong summary against the wrong group reports a failure
   that has nothing to do with what broke. */
const sums=await p.$$eval('#cfg .cfgsec',es=>{const o={};
  es.forEach(e=>{o[e.id]=(e.querySelector('.cfgsum')?.textContent||'').trim();}); return o;});
Object.keys(sums).forEach(k=>console.log('       '+k.padEnd(10)+' '+sums[k]));
const S=k=>sums[k]||'';
ok('jobs names the job', /\w/.test(S('gJobs')), S('gJobs'));
ok('every group has a summary',
   Object.keys(sums).every(k=>sums[k].length>0),
   Object.keys(sums).filter(k=>!sums[k]).join(',')||'none empty');
ok('pay names the rate and the rule', /37\.78/.test(S('gPay')) && /40 h a week/.test(S('gPay')), S('gPay'));
ok('period names its length and payday',
   /14 days/.test(S('gPeriod')) && /13 days after/.test(S('gPeriod')), S('gPeriod'));
ok('schedule names hours, days and lunch',
   /2:00 PM–10:30 PM/.test(S('gSched')) && /Sun Mon Tue Wed Thu/.test(S('gSched'))
   && /30 min lunch/.test(S('gSched')), S('gSched'));
ok('premiums names the differential', /\$0\.15\/h/.test(S('gPrem')) && /6:00 PM/.test(S('gPrem')), S('gPrem'));
ok('time off counts what you have', /holidays/.test(S('gOff')) && /1 vacation/.test(S('gOff')), S('gOff'));
ok('appearance names the theme and clock',
   /12-hour/.test(S('gLook')) && /sound on/.test(S('gLook')), S('gLook'));
ok('your data counts the shifts', /2 shifts/.test(S('gData')), S('gData'));
ok('the salary contract reports itself', /\w/.test(S('gContract')), S('gContract'));
ok('and so does the production one', /\w/.test(S('gUnits')), S('gUnits'));

console.log('\n━━ Summaries are live ━━');
await p.evaluate(()=>{document.getElementById('gPay').open=true;});
await p.fill('#cRate','44.50'); await p.dispatchEvent('#cRate','change'); await p.waitForTimeout(500);
ok('changing the rate updates its summary', /44\.50/.test(await p.textContent('#sumPay')),
   await p.textContent('#sumPay'));
await p.selectOption('#cMode','eighty80'); await p.waitForTimeout(500);
ok('and so does changing the rule',
   /8 h a day or 80 h a period/.test(await p.textContent('#sumPay')), await p.textContent('#sumPay'));
await p.selectOption('#cMode','weekly'); await p.fill('#cRate','37.78');
await p.dispatchEvent('#cRate','change'); await p.waitForTimeout(400);

console.log('\n━━ Which groups are open is remembered ━━');
await p.evaluate(()=>{document.getElementById('gPay').open=false;
  document.getElementById('gOff').open=true;});
await p.waitForTimeout(500);
const stored=await p.evaluate(()=>JSON.parse(localStorage.getItem('payclock.v1')).ui.cfg);
ok('the choice is saved', stored && stored.gOff===true && stored.gPay===false, JSON.stringify(stored));
await p.reload(); await p.waitForTimeout(800);
await p.evaluate(()=>{const d=document.querySelector('#cfg>details'); if(d) d.open=true;});
await p.waitForTimeout(300);
const after=await p.$$eval('#cfg .cfgsec',es=>es.filter(e=>e.open).map(e=>e.id));
ok('and survives a reload', after.join()==='gOff', after.join()||'(none open)');

console.log('\n━━ Controls still actually save ━━');
await p.evaluate(()=>document.querySelectorAll('#cfg .cfgsec').forEach(d=>d.open=true));
await p.waitForTimeout(300);
await p.selectOption('#cSkewOn','1'); await p.waitForTimeout(400);
await p.fill('#cSkewMins','2'); await p.dispatchEvent('#cSkewMins','change'); await p.waitForTimeout(500);
await p.selectOption('#cLunch','60'); await p.waitForTimeout(500);
await p.selectOption('#cClock24','1'); await p.waitForTimeout(500);
const cfg=await p.evaluate(()=>JSON.parse(localStorage.getItem('payclock.v1')).jobs[0].cfg);
ok('a control in Your schedule saved', cfg.lunchMins===60, 'lunch '+cfg.lunchMins);
ok('a control in Appearance saved', cfg.clock24===true, 'clock24 '+cfg.clock24);
ok('the shop-clock offset saved', cfg.skewOn===true && cfg.skewMins===2,
   'skew '+cfg.skewOn+'/'+cfg.skewMins);
ok('and the schedule summary followed the clock format',
   /14:00–22:30/.test(await p.textContent('#sumSched')), await p.textContent('#sumSched'));

console.log('\n━━ Undo stays outside the groups ━━');
const undoIn=await p.evaluate(()=>!!document.getElementById('cfgUndo').closest('.cfgsec'));
ok('the undo bar is not buried in a group', !undoIn);

console.log('\n━━ On a phone ━━');
const m=await p.evaluate(()=>{const s=document.querySelector('#gPay>summary');
  return {w:document.documentElement.scrollWidth,win:innerWidth,
    h:Math.round(s.getBoundingClientRect().height)};});
ok('no sideways scroll', m.w<=m.win+1, `${m.w} vs ${m.win}`);
ok('the headings are finger-sized', m.h>=44, m.h+'px');


/* "Change in Settings" has to land on an OPEN group.

   It used to set `g.open = true` and then call applyCfgGroups() on the next line. The spec
   fires `toggle` on a <details> asynchronously, so the listener that persists the new state
   had not run yet — applyCfgGroups() read the old stored value and shut the group the click
   had just opened. The group is started closed here on purpose, because that is the state
   that made the race visible. */
console.log('\n━━ Jumping to a setting from another card ━━');
await p.evaluate(()=>{document.querySelectorAll('#cfg .cfgsec').forEach(d=>d.open=false);});
await p.waitForTimeout(400);
ok('the schedule group starts closed', (await p.evaluate(()=>document.getElementById('gSched').open))===false);
await p.evaluate(()=>{document.querySelectorAll('.col').forEach(c=>c.classList.add('open'));});
await p.waitForTimeout(200);
await p.evaluate(()=>document.getElementById('xSchedEdit').click());
await p.waitForTimeout(700);
ok('the link leaves it open, not collapsed again',
   (await p.evaluate(()=>document.getElementById('gSched').open))===true);
/* There was a third assertion here, checking that `cSchedStart2` was laid out. It sits
   inside this group, so it looked like a fair proxy — but it passed with the bug present
   and the group reporting closed, so it discriminated nothing and is gone rather than kept
   for the look of it. Whatever Chromium does with the contents of a closed <details>, it is
   not a signal about this fix. `.open` is. */
/* Still open after the state is reapplied, which is what used to undo it. */
await p.evaluate(()=>applyCfgGroups());
await p.waitForTimeout(300);
ok('and it survives the group state being reapplied',
   (await p.evaluate(()=>document.getElementById('gSched').open))===true);

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close(); process.exit(fails===0?0:1);
