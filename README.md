# WiseWage

A live earnings clock. Clock in and watch your pay climb in real time — through straight time, into overtime, across pay periods.

One self-contained HTML file. No build, no server, no dependencies. Open it and it works, online or off.

[![Checks](https://github.com/curtistheconqueror/WiseWage/actions/workflows/checks.yml/badge.svg)](https://github.com/curtistheconqueror/WiseWage/actions/workflows/checks.yml)

## Use it

**On a computer** — download `index.html` and open it. That's it. (Viewing it on GitHub shows the source code rather than the page; that's just how GitHub displays `.html` files.)

**On a phone** — open the published URL (see [Hosting](#hosting)) and choose **Add to Home Screen** on iOS, or **Install app** on Android. You get an icon that opens fullscreen with no browser bars and runs with no signal.

## What it does

**Earnings that move.** Clock in and the counter climbs at your hourly rate. The **SEC / MIN / HR** toggle sets how the number steps — every second, every minute, or every hour — while the elapsed timer runs live regardless. At $38/hr that's $0.0106 a second, $0.6333 a minute.

**Overtime at 1.5×, switching mid-shift.** Cross the threshold at hour 39 and the *rest of that same shift* bills at the overtime rate, split at the exact crossing point rather than rounded into whichever bucket the shift started in. Two rules:

| Rule | Threshold | Resets |
|---|---|---|
| Weekly *(default)* | 40 h | Every week, on your chosen start day |
| Pay period | 80 h | Every pay period |

Weekly is how US payroll normally calculates overtime — it's owed per workweek, and a slow week can't cancel out overtime already earned in a busy one. That's why it's the default. The 80 h rule is there if your employer genuinely runs a cumulative period.

**A period total that keeps climbing.** The weekly figures reset each week, but *Pay period progress* holds a cumulative total that runs from day one to payday, with a card per week beneath it and a bar counting down the hours until every remaining hour bills at overtime.

**Pay periods that keep themselves.** Set one start date and a length; they repeat from there forever, rolling over on schedule and starting the counters fresh. No reconfiguring every two weeks.

**Stop on your terms.** Clock out by hand, or set a target for the day and it stops itself the moment you reach it — counting hours you already banked earlier that day.

**A shift log you can correct.** Add shifts you forgot, by duration (*date + 10 hours*) or exact clock times, with a live preview of the hours and pay before you save. Edit or delete any of them. A shift running past midnight is understood as overnight rather than rejected. Export to CSV to check against a real paystub.

## It survives real life

Every figure derives from wall-clock timestamps, never from counting ticks. Refresh the page, background the tab, sleep the machine mid-shift — it recovers the correct amount instead of drifting or losing time. Data persists in the browser, and two open tabs stay in sync rather than overwriting each other.

## First run

Nothing personal ships in this file. The first launch asks for your hourly rate, when your current pay period started, how long a period is, when payday lands, and which overtime rule applies — previewing the resulting period and overtime rate before you save. Those values live in your browser and nowhere else.

Change any of them later under **Settings**.

## Hosting

GitHub Pages serves this repository directly, because the app sits at the root:

**Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)`**

Push to `main`, and the published URL has the new build on the next open. That is the whole
deployment path — there is nothing to compile.

The published URL is what you install from on a phone. Pages on a private repository requires a paid GitHub plan; on a free plan the repository must be public. Nothing personal is in the code either way — your numbers are entered at first run and stay on your device.

### If you move it to another URL

Data lives in the browser's storage **per origin** and does not follow a move, so **export a
backup from the old URL before switching and import it at the new one**. The home-screen icon
has to be added again as well. The old URL keeps working until Pages is turned off there, so
the two can overlap for as long as you like.

One thing to know before you ever consider clearing site data to fix something: GitHub Pages
serves *every* project you publish from a single origin, so clearing it wipes the stored data
of all of them. `fresh.html` and the in-app refresh button exist so you never have to.

## Tests

Three layers, cheapest first. The first two need nothing installed:

```sh
npm test            # guards, then the pay engine
```

**Guards** (18 of them, under a second) are the static invariants the app is built on: that
the version a user can see and the service worker's cache key agree, that no two elements
share an id, that the pay engine stays pure and stays ES5, that no external script or
stylesheet has crept in, and that no API key is committed. Each one is there because
breaking it has already cost something — see the notes in `tests/guards.mjs`.

**The engine suite** is 937 assertions covering period and week boundaries, all six overtime
rules, mid-shift threshold crossings, overnight and DST-spanning shifts, period rollover,
auto-stop targets, the SEC/MIN/HR stepping, holidays and banked days off, absences and the
make-up rule, vacation blocks, the shop-clock offset, the shift differential, the federal
tax table, the Social Security wage base, and the FLSA qualified-overtime rule.

It extracts the pay engine directly out of `index.html`, so what is tested is exactly what
ships — there is no second copy to fall out of sync.

**The UI suites** drive a real browser, so they need Playwright:

```sh
npm install
npx playwright install chromium
npm run test:ui                        # every suite
npm run test:ui -- smoke drive         # only those
npm run test:ui -- --shard=2/5         # one slice of five
npm run test:all                       # guards, engine, then UI
```

Seventy-four suites, 2,860 assertions. Each starts its own static server, seeds
`localStorage`, installs a fixed clock and drives the real page — clocking in and out,
editing shifts, changing settings, reloading, and checking what is actually on screen at
phone and desktop sizes. A full run takes about seventeen minutes.

**They run one at a time on purpose.** Several assert on live clocks and running money
totals, so two suites sharing a machine report contention as a money bug. That has already
caused wrong diagnoses here. `--shard` is for splitting across *separate machines*, which
is how CI finishes in minutes; never run two shards side by side on one box.

Set `PW_CHROME` to use a particular browser build rather than Playwright's own.

## CI

`.github/workflows/checks.yml` runs all three layers on every push and pull request, and
can be started by hand from the Actions tab. Guards and the engine go first on their own
runner and fail in seconds; the 74 UI suites then split across five runners, serial within
each. Nothing here is optional — it is the only thing standing between a regression and a
phone.

## Picking this up

`HANDOFF.md` is the current state and the road ahead — read it first.
`PLAN.md` is the professions / multi-job architecture.

## Files

| | |
|---|---|
| `index.html` | The entire app — markup, styling, pay engine, UI |
| `manifest.webmanifest`, `sw.js`, `icons/` | Home-screen install and offline cache |
| `fresh.html` | Escape hatch: clears the cached app when a stuck copy won't update. Never touches your data |
| `tools/icon.mjs` | Draws the app icon and writes every size from one source |
| `tests/guards.mjs` | Static invariants — no dependencies, runs in under a second |
| `tests/pay-engine.test.mjs` | The engine suite — no dependencies |
| `tests/ui/`, `tests/run-ui.mjs` | Browser suites and their runner |
| `.github/workflows/checks.yml` | CI: guards, engine, then the UI suites across five runners |

### Changing the icon

The icon is generated rather than hand-exported, so the four sizes cannot drift apart. Edit
the constants at the top of `tools/icon.mjs` — `BG` and `INK` are the two colours, `W` is
the letterform, and `SCALE` / `LIFT` / `GAP` set how the two W's sit together — then:

```sh
node tools/icon.mjs          # add PW_CHROME=/path/to/chrome if Playwright can't find one
```

That rewrites `icons/icon.svg` (the reviewable source) and all four PNGs together. Bump
`APP_BUILD` in `index.html` and `CACHE` in `sw.js` so installed copies fetch the new one.
iOS caches home-screen icons hard — an existing install usually keeps the old icon until it
is removed from the Home Screen and re-added.

## Worth knowing

- Figures are **gross** — before taxes and deductions. This won't match your take-home.
- Data lives only in the browser you use it in. Nothing is sent anywhere, and nothing syncs between devices — so clock in and out in one place, or your hours end up split across copies.
- This is your own record, not your employer's system of record.
