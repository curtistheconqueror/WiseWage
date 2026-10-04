/**
 * Static guards — the checks that hold the architecture in place.
 *
 *   node tests/guards.mjs
 *
 * These are the invariants the app is built on. Nothing here opens a browser and nothing
 * here needs anything installed, so it runs in well under a second and is the first thing
 * CI does. Every one of them exists because breaking it has already cost something:
 *
 *   - Two ids collided (`oDate` and three others, reused by a new editor) and every test
 *     still passed, because the markup that came first won and the older editor silently
 *     broke. A browser suite found it eventually. This finds it instantly.
 *   - A device sat on one build for over a day, because the version a user can see and the
 *     cache key that decides whether assets are refetched are two separate constants that
 *     nothing forced to agree.
 *   - The engine fence is only extractable while it stays pure. `tests/pay-engine.test.mjs`
 *     runs it through `new Function(...)` with no DOM, so a stray `document` reference on a
 *     path the suite does not happen to execute would pass there and throw in production.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok    ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? ' — ' + detail : ''}`); }
};

const html = read('index.html');
const sw = read('sw.js');

/* ---- 1. The version a user sees and the cache key must agree -------------------------
   APP_BUILD is printed in the app's footer; CACHE decides whether an installed copy
   refetches its assets. Bumping one without the other either lies about the version or
   leaves a device on stale assets. */
const build = (html.match(/var APP_BUILD\s*=\s*'([^']+)'/) || [])[1];
const cache = (sw.match(/const CACHE\s*=\s*'([^']+)'/) || [])[1];
ok('index.html declares APP_BUILD', !!build, 'no `var APP_BUILD = \'…\'` found');
ok('sw.js declares CACHE', !!cache, 'no `const CACHE = \'…\'` found');
ok('APP_BUILD and the cache key are in lockstep', !!build && cache === 'wisewage-' + build,
   `APP_BUILD is ${build}, CACHE is ${cache} — expected wisewage-${build}`);

/* ---- 2. Every element id in the markup is unique --------------------------------------
   `document.getElementById` returns whichever came first, so a collision does not throw;
   it quietly points one feature's controls at another's.

   Only ids written out literally are counted. One built from a value — `id="row' + i + '"`
   — cannot be checked without running the page, and `tests/ui/smoke.mjs` walks the live
   DOM for exactly that. The lookbehind keeps `data-id="…"` out of it. */
const ids = (html.match(/(?<![\w-])id="[A-Za-z][\w.:-]*"/g) || []).map(s => s.slice(4, -1));
const seen = Object.create(null), dupes = [];
for (const id of ids) {
  if (seen[id]) { if (!dupes.includes(id)) dupes.push(id); } else { seen[id] = 1; }
}
ok(`${ids.length} element ids, all distinct`, dupes.length === 0, dupes.join(', '));

/* ---- 3. The engine fence stays pure and stays ES5 -------------------------------------
   Comments and string contents are blanked before scanning, so prose and user-facing text
   cannot trip these. A backtick in live code is itself the violation, so it is recorded
   during the walk rather than after it. */
const START = '/* ==ENGINE-START==', END = '/* ==ENGINE-END== */';
const a = html.indexOf(START), b = html.indexOf(END);
ok('the engine fence opens exactly once',
   a > -1 && html.indexOf(START, a + 1) === -1);
ok('the engine fence closes exactly once, after it opens',
   b > a && html.indexOf(END, b + 1) === -1);

if (a > -1 && b > a) {
  const fence = html.slice(a, b);
  const lineOf = i => html.slice(0, a + i).split('\n').length;

  // Blank out comments and string bodies, keeping every newline so line numbers survive.
  let code = '', mode = 'code', quote = '', templates = [];
  for (let i = 0; i < fence.length; i++) {
    const c = fence[i], next = fence[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '*') { mode = 'block'; code += '  '; i++; continue; }
      if (c === '/' && next === '/') { mode = 'line'; code += '  '; i++; continue; }
      if (c === '"' || c === "'") { mode = 'string'; quote = c; code += ' '; continue; }
      if (c === '`') {
        const at = lineOf(i);                 // a pair of backticks is one violation
        if (templates[templates.length - 1] !== at) templates.push(at);
        code += ' '; continue;
      }
      code += c; continue;
    }
    if (mode === 'block') { if (c === '*' && next === '/') { mode = 'code'; code += '  '; i++; } else code += c === '\n' ? '\n' : ' '; continue; }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; code += '\n'; } else code += ' '; continue; }
    if (mode === 'string') {
      if (c === '\\') { code += '  '; i++; continue; }
      if (c === quote) mode = 'code';
      code += c === '\n' ? '\n' : ' ';
      continue;
    }
  }

  const first = lineOf(0);               // file line the fence opens on
  const hits = (re) => {
    const out = [];
    code.split('\n').forEach((line, n) => { if (re.test(line)) out.push(first + n); });
    return out;
  };

  const es5 = [
    ['const', /\bconst\b/],
    ['let', /\blet\b/],
    ['arrow functions', /=>/],
  ];
  for (const [name, re] of es5) {
    const at = hits(re);
    ok(`no ${name} inside the fence`, at.length === 0, `line${at.length > 1 ? 's' : ''} ${at.slice(0, 8).join(', ')}`);
  }
  ok('no template literals inside the fence', templates.length === 0,
     `line${templates.length > 1 ? 's' : ''} ${templates.slice(0, 8).join(', ')}`);

  const impure = [
    ['document', /\bdocument\b/],
    ['localStorage', /\b(local|session)Storage\b/],
    ['window', /\bwindow\b/],
  ];
  for (const [name, re] of impure) {
    const at = hits(re);
    ok(`the fence never touches ${name}`, at.length === 0, `line${at.length > 1 ? 's' : ''} ${at.slice(0, 8).join(', ')}`);
  }
}

/* ---- 4. One file, no dependencies -----------------------------------------------------
   The app has to open from a file:// path and run with no signal. A single external
   script, stylesheet or font would break both, and would do it silently on a fast
   connection. Anchors are left alone: a link the user chooses to follow is fine. */
const scripts = (html.match(/<script\b[^>]*\bsrc=/gi) || []);
ok('no external scripts', scripts.length === 0, `${scripts.length} <script src=…>`);
const sheets = (html.match(/<link\b[^>]*\brel="stylesheet"/gi) || []);
ok('no external stylesheets', sheets.length === 0, `${sheets.length} stylesheet link(s)`);
ok('no @import in the styles', !/@import/.test(html));
const remote = (html.match(/<(?:img|iframe|source|video|audio)\b[^>]*\bsrc="https?:/gi) || []);
ok('no remotely-hosted media', remote.length === 0, remote.join(' '));

/* ---- 5. No credential is ever committed -----------------------------------------------
   The scanner takes the user's own API key and keeps it on their device. There is no
   server here and the repository is public, so anything committed is published.

   Every text file in the repository is walked rather than a hand-kept list, because the
   file a key gets pasted into is by definition the one nobody thought of. */
const TEXT = /\.(html|js|mjs|cjs|json|md|css|webmanifest|svg|txt|ya?ml)$/i;
const SKIP = new Set(['node_modules', '.git']);
const walk = (rel) => readdirSync(join(root, rel || '.'), { withFileTypes: true })
  .flatMap(e => SKIP.has(e.name) ? []
    : e.isDirectory() ? walk(rel ? rel + '/' + e.name : e.name)
    : TEXT.test(e.name) ? [rel ? rel + '/' + e.name : e.name] : []);
/* Key-shaped, not merely prefixed. A real Anthropic key is `sk-ant-` and roughly a hundred
   more characters; the tests legitimately set things like `sk-ant-test` to drive the UI, and
   `index.html` shows `sk-ant-...` as placeholder text in the field. Demanding a long tail
   keeps those out without narrowing to one prefix generation. */
const SECRETS = [
  [/sk-ant-[A-Za-z0-9_-]{40,}/, 'an Anthropic API key'],
  [/\bghp_[A-Za-z0-9]{36,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/, 'a GitHub fine-grained token'],
];
const text = walk('');
const leaked = [];
for (const f of text) {
  const body = read(f);
  for (const [re, what] of SECRETS) if (re.test(body)) leaked.push(`${what} in ${f}`);
}
ok(`no credential in any of ${text.length} text files`, leaked.length === 0, leaked.join('; '));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${pass + fail} guards passed\n`);
process.exit(fail === 0 ? 0 : 1);
