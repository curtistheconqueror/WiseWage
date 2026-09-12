/* Battery saver. One switch, not a second app: everything that costs battery without
   changing a number is cut by a single class, and every figure stays exactly what it was.

   This setting used to be called Lite, and its class was body.lite. That word now means the
   other thing entirely — how much of the app you see — so the class is body.saver and this
   file is named for what it tests. The stored value is still the string 'lite', which is why
   every selectOption below still passes it: renaming what people read must not invalidate
   what they saved. */
import { chromium } from 'playwright';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
const CHROME = process.env.PW_CHROME || undefined;

const R = ROOT, KEY = 'payclock.v1';
const TY = {'.html':'text/html','.js':'text/javascript',
            '.webmanifest':'application/manifest+json','.png':'image/png'};
const srv = http.createServer((q,r) => { let p = decodeURIComponent(q.url.split('?')[0]);
  if (p==='/'||p==='/index.html'){ r.writeHead(200,{'Content-Type':'text/html'});
    return r.end(readFileSync(R+'index.html')); }
  if (p==='/favicon.ico'){ r.writeHead(204); return r.end(); }
  const f = R+p; if (!existsSync(f)){ r.writeHead(404); return r.end('no'); }
  r.writeHead(200,{'Content-Type':TY[p.slice(p.lastIndexOf('.'))]||'application/octet-stream'});
  r.end(readFileSync(f));
}).listen(8206);
let fails = 0;
const ok = (n,c,x='') => { console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++; };

const b = await chromium.launch({ executablePath: CHROME });
const ctx = await b.newContext({ viewport:{width:390,height:1200}, isMobile:true, hasTouch:true,
  deviceScaleFactor:3, timezoneId:'America/Chicago', locale:'en-US' });
const T = (d,h) => Date.UTC(2026,7,d,h+5,0);

/* Water and colour-cycling on, a shift running — the most expensive screen the app has. */
const SEED = { configured:true,
  jobs:[{ id:'j1', name:'Pace', profession:'', primary:true,
          activeStart:T(12,14), activeAdj:null,
          cfg:{ rate:37.78, otMultiplier:1.5, otMode:'shift', weeklyThreshold:40,
            periodThreshold:80, dailyThreshold:8, shiftThreshold:8, weekStartDay:0,
            periodAnchor:'2026-08-09', periodLengthDays:14, payDateOffsetDays:13,
            schedStart:'14:00', schedEnd:'22:30', lunchMins:0,
            workDays:[true,true,true,true,true,false,false],
            holidays:[], banks:[], daysOff:[], vacations:[] } }],
  activeJob:'j1', sessions:[], absences:[], units:[], stipends:[], otHist:[],
  unit:'sec', ui:{open:{hero:true}},
  theme:{ preset:'midnight', surface:'water', rgb:'wave' }, net:{} };

const p = await ctx.newPage();
p.on('pageerror', e => { console.log('  PAGE ERROR:', e.message); fails++; });
p.on('console', m => { if (m.type()==='error'){ console.log('  CONSOLE ERROR:', m.text()); fails++; } });
await p.addInitScript(([k,v]) => { if (sessionStorage.getItem('__s')) return;
  sessionStorage.setItem('__s','1'); localStorage.setItem(k, JSON.stringify(v)); }, [KEY, SEED]);
await p.clock.install({ time:new Date(T(12,16)) });
await p.goto('http://localhost:8206/');
await p.waitForFunction(() => typeof state !== 'undefined' && state.jobs, null, { timeout:15000 });
await p.waitForTimeout(600);
const openCfg = async () => { await p.evaluate(() =>
  document.querySelectorAll('#cfg details').forEach(d => d.open = true)); await p.waitForTimeout(300); };
const cls = () => p.evaluate(() => document.body.className);
const money1 = () => p.evaluate(() => document.getElementById('hmoney').textContent);

console.log('\n━━ The switch lives in Appearance ━━');
await openCfg();
ok('a performance control exists', await p.isVisible('#tPerf'));
ok('and starts on Full', (await p.inputValue('#tPerf')) === '', await p.inputValue('#tPerf'));
ok('water and wave are running', /water/.test(await cls()) && /rgb-wave/.test(await cls()),
   await cls());

console.log('\n━━ Lite cuts everything that costs battery ━━');
const beforeMoney = await money1();
await p.selectOption('#tPerf', 'lite'); await p.waitForTimeout(500);
const c = await cls();
ok('the saver class is on', /\bsaver\b/.test(c), c);
ok('water is off', !/\bwater\b/.test(c), c);
ok('and so is the colour cycling', !/rgb-/.test(c), c);
const fx = await p.evaluate(() => {
  const card = document.getElementById('hero'), s = getComputedStyle(card);
  return { anim: getComputedStyle(card, '::before').animationName,
           blur: s.backdropFilter || s.webkitBackdropFilter,
           shadow: s.boxShadow };
});
ok('no animation survives', fx.anim === 'none', fx.anim);
ok('no backdrop blur', /none/.test(fx.blur), fx.blur);
ok('no card shadow', fx.shadow === 'none', fx.shadow);

console.log('\n━━ The money is untouched ━━');
await p.clock.fastForward(60 * 1000); await p.waitForTimeout(600);
const afterMoney = await money1();
ok('the clock still ticks in battery saver', afterMoney !== beforeMoney,
   beforeMoney + ' → ' + afterMoney);
/* A minute at $37.78 is 63 cents — the figures move exactly as they always did. */
const delta = parseFloat(afterMoney.replace(/[$,]/g,'')) - parseFloat(beforeMoney.replace(/[$,]/g,''));
ok('by exactly what a minute is worth', Math.abs(delta - 37.78/60) < 0.02, '$' + delta.toFixed(2));

console.log('\n━━ Full comes back exactly as it was ━━');
await openCfg();
await p.selectOption('#tPerf', ''); await p.waitForTimeout(500);
const back = await cls();
ok('water returns', /\bwater\b/.test(back), back);
ok('the wave returns', /rgb-wave/.test(back), back);
ok('battery saver is gone', !/\bsaver\b/.test(back), back);
ok('because the choices underneath were kept, not overwritten',
   await p.evaluate(() => { const t = JSON.parse(localStorage.getItem('payclock.v1')).theme;
     return t.surface === 'water' && t.rgb === 'wave'; }));

console.log('\n━━ A colour preset must not switch the battery saver off ━━');
await openCfg();
await p.selectOption('#tPerf', 'lite'); await p.waitForTimeout(400);
await p.evaluate(() => { const b = document.querySelector('#presets button'); if (b) b.click(); });
await p.waitForTimeout(500);
ok('battery saver survives tapping a colour preset', /\bsaver\b/.test(await cls()), await cls());
ok('and is still stored', await p.evaluate(() =>
   JSON.parse(localStorage.getItem('payclock.v1')).theme.perf === 'lite'));
await p.evaluate(() => { theme().surface='water'; theme().rgb='wave'; theme().perf='';
  save(); applyTheme(); });
await p.waitForTimeout(300);

console.log('\n━━ It survives a reload ━━');
await openCfg();
await p.selectOption('#tPerf', 'lite'); await p.waitForTimeout(500);
await p.reload(); await p.waitForTimeout(900);
ok('still in battery saver after a reload', /\bsaver\b/.test(await cls()), await cls());
await openCfg();
ok('and the control says so', (await p.inputValue('#tPerf')) === 'lite');
const m = await p.evaluate(() => ({ w:document.documentElement.scrollWidth, win:innerWidth }));
ok('no sideways scroll', m.w <= m.win+1, `${m.w} vs ${m.win}`);

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close(); process.exit(fails===0?0:1);
