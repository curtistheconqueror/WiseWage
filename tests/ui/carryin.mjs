/* Allowances already spent before the app existed.
   Nobody installs a pay app on 1 January. Somebody setting this up in August has usually
   taken a sick day or two since — and "5 of 5 left" is not optimism, it is wrong about the
   single thing the allowance exists to tell them. */
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
}).listen(8207);
let fails = 0;
const ok = (n,c,x='') => { console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++; };

const b = await chromium.launch({ executablePath: CHROME });
const ctx = await b.newContext({ viewport:{width:1100,height:2600},
                                 timezoneId:'America/Chicago', locale:'en-US' });
const NOW = Date.UTC(2026, 7, 12, 21, 0);          // Wed 12 Aug 2026 — mid-year, on purpose

const CFG = { rate:37.78, otMultiplier:1.5, otMode:'weekly', weeklyThreshold:40,
  periodThreshold:80, dailyThreshold:8, shiftThreshold:8, weekStartDay:0,
  periodAnchor:'2026-08-09', periodLengthDays:14, payDateOffsetDays:13,
  schedStart:'14:00', schedEnd:'22:30', lunchMins:30,
  workDays:[true,true,true,true,true,false,false],
  holidays:[], daysOff:[], vacations:[], premiums:[],
  banks:[{ id:'sick', name:'Sick day', count:5, hours:8, ot:false, makeUp:true, slots:[] }] };

const SEED = { configured:true,
  jobs:[{ id:'j1', name:'Pace', profession:'', primary:true, activeStart:null, activeAdj:null,
          cfg: JSON.parse(JSON.stringify(CFG)) }],
  activeJob:'j1', sessions:[], absences:[], units:[], stipends:[], otHist:[],
  unit:'sec', ui:{open:{banks:true}}, net:{} };

async function boot(seed, at){
  const p = await ctx.newPage();
  p.on('pageerror', e => { console.log('  PAGE ERROR:', e.message); fails++; });
  p.on('console', m => { if (m.type()==='error'){ console.log('  CONSOLE ERROR:', m.text()); fails++; } });
  await p.addInitScript(([k,v]) => { if (sessionStorage.getItem('__s')) return;
    sessionStorage.setItem('__s','1');
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); },
    [KEY, seed === undefined ? null : seed]);
  await p.clock.install({ time:new Date(at || NOW) });
  await p.goto('http://localhost:8207/');
  await p.waitForFunction(() => typeof state !== 'undefined', null, { timeout:15000 });
  await p.waitForTimeout(500);
  return p;
}
const txt = (p,sel) => p.evaluate(s => (document.querySelector(s)?.textContent||'').trim(), sel);
const st  = p => p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
const openCfg = async p => { await p.evaluate(() =>
  document.querySelectorAll('#cfg details').forEach(d => d.open = true)); await p.waitForTimeout(300); };

console.log('\n━━ Nothing is assumed about any allowance ━━');
let p = await boot(undefined, NOW);                 // a genuinely fresh install
/* First run stops at the welcome screen now — Lite or Full. This suite exercises the
   full setup form, so take the Full path through it. */
if (await p.isVisible('#welcome')){ await p.click('#wPick button[data-mode="full"]');
  await p.waitForTimeout(400); }
ok('setup is showing', await p.isVisible('#setup'));
/* The app used to hand everybody five sick days and five Pace "vacation random days".
   Neither number came from anywhere, and an invented allowance reads as a fact somebody
   has to notice is wrong — in a screen whose whole job is being right about what you are owed. */
ok('no allowance ships at all',
   (await p.evaluate(() => BANK_DEFAULTS().length)) === 0,
   await p.evaluate(() => BANK_DEFAULTS().map(x => x.id).join(',')));
ok('the list starts empty rather than pre-filled',
   (await p.locator('#sBankList .bankrow').count()) === 0);
ok('and says so instead of showing blank rows',
   /nothing added/i.test(await txt(p, '#sBankList')), await txt(p, '#sBankList'));

console.log('\n━━ You add what you actually have, and name it ━━');
await p.fill('#sRate','37.78'); await p.fill('#sAnchor','2026-08-09');
await p.selectOption('#sBankAdd','float'); await p.waitForTimeout(200);
await p.selectOption('#sBankAdd','sick');  await p.waitForTimeout(200);
ok('two rows appear', (await p.locator('#sBankList .bankrow').count()) === 2,
   String(await p.locator('#sBankList .bankrow').count()));
ok('each starting at zero, not at a guess',
   (await p.locator('#sBankList [data-bct]').first().inputValue()) === '0');

const row = i => p.locator('#sBankList .bankrow').nth(i);
await row(0).locator('[data-bct]').fill('3');
await row(0).locator('[data-bus]').fill('2');
await row(1).locator('[data-bct]').fill('5');
await row(1).locator('[data-bus]').fill('3');
await p.waitForTimeout(400);
const preview = (await txt(p, '#sPreview')).replace(/\s+/g,' ');
ok('the preview shows what is left, not what the contract gives',
   /3 floating holidays \(1 left\)/.test(preview), preview.slice(-160));
ok('for sick days too', /5 sick days \(2 left\)/.test(preview), preview.slice(-160));
await p.click('#sSave'); await p.waitForTimeout(800);

console.log('\n━━ The card opens already telling the truth ━━');
const body = (await txt(p, '#bankBody')).replace(/\s+/g,' ');
ok('one floater left of three', /1 of 3 left/.test(body), body.slice(0,120));
ok('two sick days left of five', /2 of 5 left/.test(body), body.slice(0,220));
ok('and it says where the missing ones went',
   /2 already spent before you started tracking/.test(body), body.slice(0,300));
const dots = await p.evaluate(() => [...document.querySelectorAll('#bankBody .bankdot')]
  .map(d => ({ carried: d.classList.contains('carried'), free: d.classList.contains('free'),
               undo: !!d.querySelector('button') })));
ok('the spent ones are drawn as carried', dots.filter(d => d.carried).length === 5,
   String(dots.filter(d => d.carried).length));
/* The app never watched them go, so there is no record to give back. */
ok('and none of them offers an undo', dots.filter(d => d.carried).every(d => !d.undo));
ok('the rest are still available', dots.filter(d => d.free).length === 3,
   String(dots.filter(d => d.free).length));
ok('the folded heading agrees', /3 of 8 left/.test(await txt(p, '#sum_banks')),
   await txt(p, '#sum_banks'));
ok('it is stored on the bank', (await st(p)).jobs[0].cfg.banks[0].usedBefore === 2,
   JSON.stringify((await st(p)).jobs[0].cfg.banks.map(x => x.usedBefore)));
ok('stamped with the year', (await st(p)).jobs[0].cfg.banks[0].usedYear === 2026,
   String((await st(p)).jobs[0].cfg.banks[0].usedYear));

console.log('\n━━ A carry-in stacks with days the app watches ━━');
/* Banks added by hand carry an opaque id, the same as ones added in Settings — two rows
   both called "Personal day" have to stay distinct. So book against the id the bank
   actually has rather than against the word it happens to be named after. */
await p.evaluate(() => {
  const sick = state.cfg.banks.find(b => /sick/i.test(b.name));
  state.cfg.daysOff = [{ id:'d1', bank: sick.id, slot:null, date:'2026-08-10' }];
  save(); lastHeavySig=''; renderBanks(); render(); });
await p.waitForTimeout(500);
ok('three carried plus one booked leaves one', /1 of 5 left/.test(await txt(p, '#bankBody')),
   (await txt(p, '#bankBody')).replace(/\s+/g,' ').slice(0,240));

console.log('\n━━ It expires with its year ━━');
await p.close();
p = await boot(await (async () => {
  const d = JSON.parse(JSON.stringify(SEED));
  d.jobs[0].cfg.banks[0].usedBefore = 3;
  d.jobs[0].cfg.banks[0].usedYear = 2026;
  return d;
})(), Date.UTC(2027, 0, 5, 18, 0));                 // January of the next year
ok('the new year starts full again', /5 of 5 left/.test(await txt(p, '#bankBody')),
   (await txt(p, '#bankBody')).replace(/\s+/g,' ').slice(0,120));
ok('with nothing marked as carried',
   (await p.evaluate(() => document.querySelectorAll('#bankBody .bankdot.carried').length)) === 0);
await p.close();

console.log('\n━━ It is editable afterwards ━━');
p = await boot(SEED, NOW);
await openCfg(p);
ok('the editor has a used field', await p.isVisible('#cBankList input[data-bf="usedBefore"]'));
ok('starting at nothing',
   (await p.inputValue('#cBankList input[data-bf="usedBefore"]')) === '0');
await p.fill('#cBankList input[data-bf="usedBefore"]', '4');
await p.locator('#cBankList input[data-bf="usedBefore"]').first().blur();
await p.waitForTimeout(600);
ok('typing four leaves one', /1 of 5 left/.test(await txt(p, '#bankBody')),
   (await txt(p, '#bankBody')).replace(/\s+/g,' ').slice(0,110));
ok('and it saved', (await st(p)).jobs[0].cfg.banks[0].usedBefore === 4,
   String((await st(p)).jobs[0].cfg.banks[0].usedBefore));
/* More used than the contract gives must floor, never go negative. */
await p.fill('#cBankList input[data-bf="usedBefore"]', '99');
await p.locator('#cBankList input[data-bf="usedBefore"]').first().blur();
await p.waitForTimeout(600);
ok('an impossible number floors at none left', /0 of 5 left/.test(await txt(p, '#bankBody')),
   (await txt(p, '#bankBody')).replace(/\s+/g,' ').slice(0,110));
ok('and never shows a negative', !/-\d/.test(await txt(p, '#bankBody')));
await p.fill('#cBankList input[data-bf="usedBefore"]', '0');
await p.locator('#cBankList input[data-bf="usedBefore"]').first().blur();
await p.waitForTimeout(600);
ok('back to zero restores the full allowance', /5 of 5 left/.test(await txt(p, '#bankBody')));

console.log('\n━━ A floating holiday is something you add ━━');
await openCfg(p);
const kinds = await p.$$eval('#cBankAdd option', os => os.map(o => o.value).filter(Boolean));
ok('the add control offers real kinds', kinds.includes('float') && kinds.includes('sick')
   && kinds.includes('vrd'), kinds.join(','));
await p.selectOption('#cBankAdd', 'float'); await p.waitForTimeout(700);
const after = await st(p);
ok('a floating holiday can be added', after.jobs[0].cfg.banks.some(x => x.name === 'Floating holiday'),
   after.jobs[0].cfg.banks.map(x => x.name).join(','));
ok('it counts toward overtime, the way a floater does',
   after.jobs[0].cfg.banks.find(x => x.name === 'Floating holiday').ot === true);
ok('it arrives with nothing pre-spent',
   after.jobs[0].cfg.banks.find(x => x.name === 'Floating holiday').usedBefore === 0);
ok('and the picker resets so it cannot be added twice by accident',
   (await p.inputValue('#cBankAdd')) === '', await p.inputValue('#cBankAdd'));
ok('the toast points at the two numbers that matter',
   /how many you get and how many are already spent/.test(await txt(p, '#toast')),
   await txt(p, '#toast'));

console.log('\n━━ Removing a bank you do not have ━━');
const before = (await st(p)).jobs[0].cfg.banks.length;
await p.locator('#cBankList button[data-bdel]').last().click(); await p.waitForTimeout(600);
ok('it goes', (await st(p)).jobs[0].cfg.banks.length === before - 1,
   String((await st(p)).jobs[0].cfg.banks.length));
await p.close();

console.log('\n━━ On a phone ━━');
const mob = await b.newContext({ viewport:{width:390,height:900}, isMobile:true, hasTouch:true,
  deviceScaleFactor:3, timezoneId:'America/Chicago', locale:'en-US' });
const q = await mob.newPage();
q.on('pageerror', e => { console.log('  PAGE ERROR:', e.message); fails++; });
const carried = JSON.parse(JSON.stringify(SEED));
carried.jobs[0].cfg.banks[0].usedBefore = 3;
carried.jobs[0].cfg.banks[0].usedYear = 2026;
await q.addInitScript(([k,v]) => { if (sessionStorage.getItem('__s')) return;
  sessionStorage.setItem('__s','1'); localStorage.setItem(k, JSON.stringify(v)); }, [KEY, carried]);
await q.clock.install({ time:new Date(NOW) });
await q.goto('http://localhost:8207/'); await q.waitForTimeout(800);
ok('the balance is right on a phone too', /2 of 5 left/.test(await txt(q, '#bankBody')),
   (await txt(q, '#bankBody')).replace(/\s+/g,' ').slice(0,110));
await q.evaluate(() => document.querySelectorAll('#cfg details').forEach(d => d.open = true));
await q.waitForTimeout(400);
const m = await q.evaluate(() => {
  const small = [...document.querySelectorAll('#cBankList input, #cBankAdd')]
    .filter(e => e.checkVisibility({contentVisibilityAuto:true, visibilityProperty:true}))
    .filter(e => e.type !== 'checkbox')          // a tick box is not a typing target
    .filter(e => e.getBoundingClientRect().height < 40)
    .map(e => (e.id || e.dataset.bf || e.type) + ':' + Math.round(e.getBoundingClientRect().height));
  return { w:document.documentElement.scrollWidth, win:innerWidth, small };
});
ok('no sideways scroll', m.w <= m.win+1, `${m.w} vs ${m.win}`);
ok('the fields are reachable', m.small.length === 0, m.small.join(', '));

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close(); process.exit(fails===0?0:1);
