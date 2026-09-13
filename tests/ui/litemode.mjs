/* Lite and Full.

   The app grew feature by feature until the first thing a stranger saw was thirteen setup
   questions about overtime regimes, holiday presets and stipends — an honest description of
   what it can do and a terrible answer to "what is this". Lite is the fix: one welcome
   screen, one choice, three questions.

   The thing these tests exist to protect is the promise made on that welcome screen — that
   Lite only shows less, and never records less. A Lite user who works a year and switches
   to Full must find a whole year waiting, not a year of gaps. So the assertions that matter
   most here are not about what is on screen; they are about the ledger being identical on
   both sides of the switch. */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';
const CHROME = process.env.PW_CHROME || undefined;

const KEY = 'payclock.v1', R = ROOT;
const TYPES = {'.html':'text/html','.js':'text/javascript',
               '.webmanifest':'application/manifest+json','.png':'image/png'};
const srv = http.createServer((q,r)=>{
  let path = decodeURIComponent(q.url.split('?')[0]);
  if (path==='/'||path==='/index.html'){ r.writeHead(200,{'Content-Type':'text/html'});
    return r.end(readFileSync(R+'index.html')); }
  if (path==='/favicon.ico'){ r.writeHead(204); return r.end(); }
  const f = R+path;
  if (!existsSync(f)){ r.writeHead(404); return r.end('nope'); }
  r.writeHead(200,{'Content-Type':TYPES[path.slice(path.lastIndexOf('.'))]||'application/octet-stream'});
  r.end(readFileSync(f));
}).listen(8213);

let fails = 0;
const ok = (n,c,x='') => { console.log(`  ${c?'ok  ':'FAIL'} ${n}${x?'  → '+x:''}`); if(!c)fails++; };

const b = await chromium.launch({ executablePath: CHROME });
const ctx = await b.newContext({ viewport:{width:390,height:900},
  timezoneId:'America/Chicago', locale:'en-US' });
const p = await ctx.newPage();
p.on('pageerror', e => { console.log('  PAGE ERROR:', e.message); fails++; });
p.on('console', m => { if (m.type()==='error'){ console.log('  CONSOLE ERROR:', m.text()); fails++; } });

/* Visible means visible to a person: a card hidden by the Lite class has no offsetParent,
   the same as one hidden any other way. Asking the class directly would pass even if the
   rule that acts on it had been deleted. */
const seen = (id) => p.evaluate(i => { const e = document.getElementById(i);
  return !!(e && e.offsetParent); }, id);

console.log('\n━━ The welcome screen ━━');
await p.goto('http://localhost:8213/'); await p.waitForTimeout(700);
ok('a first-time visitor gets the welcome screen', await p.isVisible('#welcome'));
ok('not the setup form', !(await p.isVisible('#setup')));
ok('with exactly two ways forward', (await p.locator('#wPick button').count()) === 2);
ok('Lite is the one pointed at', await p.evaluate(() =>
  document.querySelector('#wPick button[data-mode="lite"]').classList.contains('rec')));
ok('the app heading is out of the way', !(await p.isVisible('#appHead')));
/* Restore lives in Settings, and Settings does not exist yet. Without a route here, moving
   to a new phone means answering a page of questions the restore then overwrites. */
ok('somebody moving phones can restore from here', await p.isVisible('#wRestore'));
/* Every card used to sit under the setup screen, empty and meaningless, because first-run
   only hid six of the fourteen. */
for (const id of ['hero','totals','period','progress','log','banks','ytd','calc',
                  'salary','units','extra','sheet','ote','cfg']){
  ok(`${id} is not left sitting underneath it`, !(await seen(id)));
}

console.log('\n━━ Lite setup asks three questions, not thirteen ━━');
await p.click('#wPick button[data-mode="lite"]'); await p.waitForTimeout(500);
ok('choosing Lite moves on to setup', await p.isVisible('#setup'));
ok('and the welcome screen is done', !(await p.isVisible('#welcome')));
ok('it asks what you earn', await p.isVisible('#sRate'));
ok('when the period started', await p.isVisible('#sAnchor'));
ok('and how long it is', await p.isVisible('#sLen'));
for (const [id,what] of [['sProf','your profession'],['sMode','the six overtime regimes'],
  ['sHolPreset','paid holidays'],['sWorkDays','which days you work'],
  ['sSchedStart','shift times'],['sLunch','unpaid lunch'],['sBankAdd','paid days off'],
  ['sPay','when payday lands']]){
  ok(`it does not ask about ${what}`, !(await seen(id)));
}
const fieldCount = await p.evaluate(() =>
  [...document.querySelectorAll('#setup input,#setup select')].filter(e => e.offsetParent).length);
ok('three fields on screen', fieldCount === 3, String(fieldCount));

console.log('\n━━ What Lite shows once it is running ━━');
await p.fill('#sRate','25'); await p.click('#sSave'); await p.waitForTimeout(700);
ok('setup finishes into the app', await p.isVisible('#hero'));
for (const id of ['hero','totals','period','progress','log','banks','ytd','calc','cfg']){
  ok(`${id} is shown`, await seen(id));
}
for (const id of ['salary','units','extra','sheet','ote']){
  ok(`${id} is not`, !(await seen(id)));
}
/* Named individually by the person this was built for, as things that made the clock card
   look harder than it is. */
ok('no running monthly total on the clock card', !(await seen('monmoney')));
ok('no note explaining a disagreement nobody has hit yet',
   !(await p.evaluate(() => { const e = document.querySelector('#hero .helpnote');
     return !!(e && e.offsetParent); })));
ok('no auto clock-in row', !(await seen('autoOn')));
ok('no what-if projector', !(await seen('wifBtn')));
ok('and no By pay month list under Earnings', !(await seen('monBtn')));
ok('the backdate button names the mistake, not the fix',
   (await p.textContent('#backOpen')).includes('Missed your clock in'));

/* Lite never asked about holidays, so Lite must not have invented any. The preset ships
   reading "the six most common", which would put six paid days into a stranger's year. */
ok('Lite invented no paid holidays', (await p.evaluate(() => state.cfg.holidays.length)) === 0);
ok('and took the ordinary overtime rule',
   (await p.evaluate(() => state.cfg.otMode)) === 'weekly');

console.log('\n━━ Switching to Full shows more and changes nothing ━━');
/* A shift worked in Lite, then the switch. The figures either side have to match exactly:
   that is the promise the welcome screen makes. */
await p.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('payclock.v1'));
  const day = new Date(); day.setHours(9,0,0,0);
  s.sessions = [{ id:'x1', start: day.getTime(), end: day.getTime() + 8*3600e3 }];
  localStorage.setItem('payclock.v1', JSON.stringify(s));
});
await p.reload(); await p.waitForTimeout(800);
const liteFig = await p.evaluate(() => {
  const t = sumRange(jobLedger(null, state.cfg, Date.now()).parts, -Infinity, Infinity);
  return { h: t.hours, g: Math.round(t.gross*100), ot: t.otHours };
});
ok('the shift is on the books in Lite', liteFig.h === 8, JSON.stringify(liteFig));

await p.evaluate(() => { document.querySelectorAll('#cfg details').forEach(d => d.open = true); });
await p.waitForTimeout(300);
ok('the way out of Lite is in Settings', await seen('cfgMode'));
await p.selectOption('#cfgMode','full'); await p.waitForTimeout(700);
ok('Full brings the rest back', await seen('extra'));
ok('and the clock card extras with it', await seen('wifBtn'));
const fullFig = await p.evaluate(() => {
  const t = sumRange(jobLedger(null, state.cfg, Date.now()).parts, -Infinity, Infinity);
  return { h: t.hours, g: Math.round(t.gross*100), ot: t.otHours };
});
ok('the hours are identical', fullFig.h === liteFig.h, `${liteFig.h} → ${fullFig.h}`);
ok('the money is identical', fullFig.g === liteFig.g, `${liteFig.g} → ${fullFig.g}`);
ok('the overtime is identical', fullFig.ot === liteFig.ot, `${liteFig.ot} → ${fullFig.ot}`);
ok('the rate survived', (await p.evaluate(() => state.cfg.rate)) === 25);
ok('and so did the shift', (await p.evaluate(() => state.sessions.length)) === 1);

/* Back again, because a one-way door is not a switch. */
await p.selectOption('#cfgMode','lite'); await p.waitForTimeout(600);
ok('going back to Lite hides them again', !(await seen('extra')));
ok('and still has not touched the shift',
   (await p.evaluate(() => state.sessions.length)) === 1);

console.log('\n━━ Full is unchanged for everyone already using it ━━');
{
  const p2 = await ctx.newPage();
  p2.on('pageerror', e => { console.log('  PAGE ERROR:', e.message); fails++; });
  /* Somebody who set the app up before Lite existed has no stored mode at all. They must
     land in the app exactly as they left it — not on a welcome screen asking them to pick
     something, and not in Lite with half their cards gone. */
  await p2.addInitScript(() => {
    if (sessionStorage.__s) return; sessionStorage.__s = 1;
    localStorage.setItem('payclock.v1', JSON.stringify({ configured:true,
      cfg:{ rate:37.78, otMode:'eight40', periodAnchor:'2026-09-06', periodLengthDays:14 },
      sessions:[], activeStart:null, sound:false }));
  });
  await p2.goto('http://localhost:8213/'); await p2.waitForTimeout(800);
  const seen2 = (id) => p2.evaluate(i => { const e = document.getElementById(i);
    return !!(e && e.offsetParent); }, id);
  ok('no welcome screen for an existing user', !(await p2.isVisible('#welcome')));
  ok('they are treated as Full', await p2.evaluate(() => appMode() === 'full'));
  ok('with the whole app on screen', await seen2('extra'));
  ok('and their overtime rule untouched',
     (await p2.evaluate(() => state.cfg.otMode)) === 'eight40');
  await p2.close();
}

console.log('\n━━ Battery saver is a separate setting and still works ━━');
/* It used to be called Lite and its class was body.lite. Renaming what people read must not
   invalidate what they saved, so the stored value is still the string 'lite'. */
{
  /* Set the view mode here rather than relying on where the last section left it. The app
     re-reads its state when another tab writes storage — correct behaviour, and the
     previous section opened a second tab, so this page's mode came back from disk. */
  await p.evaluate(() => { state.mode = 'lite'; save(); applyMode(); });
  await p.evaluate(() => { theme().perf = 'lite'; save(); applyTheme(); });
  await p.waitForTimeout(300);
  ok('a saved battery-saver preference still applies',
     await p.evaluate(() => document.body.classList.contains('saver')));
  /* They were one word apart and are now two unrelated switches, so turning the battery
     setting on must leave the view mode exactly where it was. */
  ok('and turning it on did not change which view you are in',
     await p.evaluate(() => appMode() === 'lite'));
  ok('the two are independent', await p.evaluate(() => {
    state.mode = 'full'; applyMode();
    return document.body.classList.contains('saver') && !document.body.classList.contains('lite');
  }));
  ok('nothing on screen offers two different Lites',
     !/Lite — battery/i.test(await p.content()));
}


/* ── The first screen stays a decision, not a briefing ─────────────────────
   It opened with four sentences of prose: a tagline, a paragraph under each of the two
   buttons, a footer about switching, and another about restoring. A newcomer choosing
   between two things had to read ninety words to do it. Everything still exists behind the
   "?" — the point is that none of it is in the way. */
{
  /* Its own context, not just a new page: the tests above configured the app, and storage
     is shared across pages in one context — a "first run" sharing it is not a first run. */
  const fresh = await b.newContext({ viewport:{width:390,height:900},
    timezoneId:'America/Chicago', locale:'en-US' });
  const p2 = await fresh.newPage();
  await p2.goto('http://localhost:8213/'); await p2.waitForTimeout(700);
  ok('this really is a first run', await p2.isVisible('#welcome'));
  const seen = (sel) => p2.evaluate(s => { const e = document.querySelector(s);
    return !!(e && e.offsetParent); }, sel);

  const words = await p2.evaluate(() => {
    const w = document.getElementById('welcome');
    const help = w.querySelector('.wnote');
    return w.innerText.replace(help ? help.innerText : '', '')
            .trim().split(/\s+/).filter(Boolean).length;
  });
  ok('the choice is made in a handful of words', words <= 30, words + ' words');

  /* The detail is not deleted — that would be worse. It is one tap away. */
  ok('the detail is still reachable', await seen('#welcome .wnote'));
  /* Opened the way a person opens it, rather than read out of the DOM — what is being
     checked is that one tap gets you the whole explanation, not that the words exist
     somewhere in the markup. */
  await p2.click('#welcome .wnote > summary'); await p2.waitForTimeout(250);
  const help = await p2.evaluate(() => document.querySelector('#welcome .wnote').innerText);
  ok('and still explains both modes', /Lite/.test(help) && /Full/.test(help));
  ok('that switching loses nothing', /never records less/i.test(help));
  ok('and that the data stays put', /stays on this phone/i.test(help));

  /* Sized to be read at arm's length: these two buttons are the whole screen. */
  const size = await p2.evaluate(() => parseFloat(getComputedStyle(
    document.querySelector('#wPick button b')).fontSize));
  ok('the two options are set large', size >= 20, size + 'px');

  /* Nothing above the decision competing with it. */
  ok('no app header above it', !(await seen('#appHead')));
  ok('and no tagline in the footer', !(await seen('#footNote')));
  ok('but the build number is still findable', await seen('#appVer'));
  await p2.close(); await fresh.close();
}

console.log(`\n${fails===0?'✅':'❌'}  ${fails===0?'all passed':fails+' failed'}`);
await b.close(); srv.close();
process.exit(fails===0?0:1);
