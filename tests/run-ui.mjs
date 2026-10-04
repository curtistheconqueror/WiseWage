/**
 * Runs every UI suite in tests/ui and reports one line each.
 *
 *   node tests/run-ui.mjs                 every suite
 *   node tests/run-ui.mjs smoke drive     only those
 *   node tests/run-ui.mjs --shard=2/5     the second of five equal slices
 *   node tests/run-ui.mjs --shard=2/5 --list    name them without running them
 *   PW_CHROME=/path/to/chrome node …      a specific browser build
 *
 * Each suite starts its own static server on its own port, drives a real Chromium against
 * the app, and exits non-zero if anything failed. They are run one at a time on purpose:
 * they are browser-driving and timing-sensitive, and a machine running six at once reports
 * failures that are really contention.
 *
 * --shard exists so CI can finish in minutes instead of twenty, and it does not break that
 * rule: a shard is for a *separate machine*. Each one still runs its suites one at a time.
 * Never use it to run two shards side by side on one box — that is the contention this
 * runner was written to avoid, and it has already cost wrong diagnoses here.
 *
 * Suites are dealt out round-robin rather than in contiguous blocks, because they range
 * from two seconds to two minutes and alphabetical neighbours are not the same size.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'ui');
const args = process.argv.slice(2);
const pick = args.filter(s => !s.startsWith('--')).map(s => s.replace(/\.mjs$/, ''));

const shardArg = (args.find(s => s.startsWith('--shard=')) || '').slice(8);
let shard = null;
if (shardArg) {
  const [n, of] = shardArg.split('/').map(Number);
  if (!(Number.isInteger(n) && Number.isInteger(of) && n >= 1 && n <= of)) {
    console.error(`--shard wants N/M with 1 <= N <= M, got "${shardArg}"`);
    process.exit(1);
  }
  shard = { n, of };
}

const all = readdirSync(dir).filter(f => f.endsWith('.mjs')).sort();
let suites = pick.length ? all.filter(f => pick.includes(f.replace(/\.mjs$/, ''))) : all;
if (shard) suites = suites.filter((_, i) => i % shard.of === shard.n - 1);

if (!suites.length) {
  console.error(pick.length ? `No suite matched: ${pick.join(', ')}`
    : shard ? `Shard ${shard.n}/${shard.of} is empty — there are only ${all.length} suites.`
    : 'No suites found.');
  process.exit(1);
}

if (args.includes('--list')) {
  // Which suites a shard would run, without running them. Useful for proving a shard
  // split covers every suite exactly once.
  suites.forEach(f => console.log(f.replace(/\.mjs$/, '')));
  process.exit(0);
}

const run = (file) => new Promise((res) => {
  const p = spawn(process.execPath, [join(dir, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.stderr.on('data', d => { out += d; });
  p.on('close', code => res({ code, out }));
});

let failed = [];
const t0 = Date.now();
console.log(`\nRunning ${suites.length} UI suite${suites.length === 1 ? '' : 's'}`
  + (shard ? ` — shard ${shard.n} of ${shard.of}, from ${all.length} in all` : '') + '\n');

for (const file of suites) {
  const name = file.replace(/\.mjs$/, '');
  const { code, out } = await run(file);
  // Each suite prints its own tally; surface that line rather than its whole transcript.
  const summary = (out.match(/^[✅❌].*$/m) || [''])[0].replace(/\s+/g, ' ').trim();
  const asserts = (out.match(/^\s{2}(ok|FAIL)\s/gm) || []).length;
  if (code === 0) {
    console.log(`  ok    ${name.padEnd(16)} ${String(asserts).padStart(3)} assertions`);
  } else {
    failed.push(name);
    console.log(`  FAIL  ${name.padEnd(16)} ${String(asserts).padStart(3)} assertions  ${summary}`);
    // A failure is only useful with the lines that failed.
    (out.match(/^\s{2}FAIL.*$/gm) || []).slice(0, 12).forEach(l => console.log('        ' + l.trim()));
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n${failed.length === 0 ? '✅' : '❌'}  ${suites.length - failed.length}/${suites.length} suites passed in ${secs}s`
  + (failed.length ? `\n   failed: ${failed.join(', ')}` : '') + '\n');
process.exit(failed.length === 0 ? 0 : 1);
