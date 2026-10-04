# Handoff — where WiseWage actually is

**If you are a session picking this up, read this first, then `PLAN.md` for the
architecture.** This file is the current state and the road ahead. `PLAN.md` is the
professions/multi-job design and has not changed.

Current build: **v91**. 18 guards, 937 engine assertions, 74 UI suites / 2,870 assertions —
all green, and all three run in CI on every push.

---

## What this app is, and the three constraints that shape every change

A single-file PWA for tracking hourly pay. One `index.html` (~13,500 lines) with an inline
`<style>` and one `<script>`. No build step, no bundler, no framework, no runtime
dependencies. Hosted as a static site on GitHub Pages; installed to the Home Screen and used
almost entirely on an iPhone.

Three constraints, all load-bearing:

**1. The engine fence.** Everything between `/* ==ENGINE-START== */` and
`/* ==ENGINE-END== */` is extracted verbatim by `tests/pay-engine.test.mjs` through
`new Function(...)`. Nothing inside it may touch `document`, `state` or `localStorage` —
that is what makes it extractable. The style inside the fence is **strict ES5**: `var` and
`function` declarations only, no `const`, no `let`, no arrow functions, no template
literals. There are ~520 declarations in there and exactly zero violations; keep it that
way. To expose a new engine function to the tests, add its name to the returned object in
`tests/pay-engine.test.mjs`.

**2. There is no server.** No backend, no API routes, no database, no edge runtime.
Anything placed in `index.html` is readable by anyone who opens the page, so there is
nowhere to keep a secret. All data lives in `localStorage` under `payclock.v1`, plus
IndexedDB for filed photos. This is why the photo scanner uses the user's own API key held
on their device — see *Scanning* below, which is also the first thing slated to change.

**3. GitHub Pages serves every project a user publishes from one origin.** Clearing site
data to fix this app destroys the stored data of every other project that user has
published. Never advise it. `fresh.html` and the in-app refresh button exist precisely so
nobody has to.

---

## Testing discipline — read this before you trust a green run

`npm test` runs the guards and the engine suite. Neither needs anything installed and
together they take about four seconds, so there is no excuse for skipping them.
`PW_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome TZ=America/Chicago node
tests/run-ui.mjs` runs all 74 browser suites and takes ~19 minutes.

**CI runs all three on every push and pull request** —
`.github/workflows/checks.yml`. Until it existed, the tests ran only because whoever
was writing the code chose to run them, which is the same party the tests are meant to
check. Two bugs that cost money shipped live and passed every suite under that
arrangement. If CI is red, the build is not green, whatever a local run said.

**Run exactly one thing at a time.** Several suites assert on live clocks and running
money totals. Two regressions in parallel, or a suite running alongside a full run, makes
them fail by a few cents or a second — and those failures look exactly like arithmetic
bugs. This has already cost more than one wrong diagnosis in this repository. Before
trusting a result, confirm nothing else is running (`pgrep -c chrome` should be 0).

CI splits the suites with `--shard=N/5`, which does not break that rule: a shard is a
separate machine and is still serial within itself. Do not use `--shard` to run two
slices side by side on one box.

**A rule only covers what the fixture renders.** `smoke.mjs` enforces the 44px touch
minimum over every `button`, `input` and `select`, but it filters on
`offsetParent !== null` — so it measured only controls that were actually on the page, and
its fixture seeded one shift and nothing else. Every control that needs *data* to exist was
never measured. That is how a 12×14px button that gave away a paid day off shipped under a
passing test. The fixture now seeds an allowance with a day spent, a holiday and a shift,
**and asserts it rendered them**, because a fixture that silently fails to populate leaves
the rule passing while measuring nothing — the same bug one level up. When adding a
sweeping rule like that, check what the fixture actually puts on screen, and prove the rule
fails without the fix: removing the fix should make it report `bankdot:27`, and it does.

**The guards are the cheap half of the gate** (`tests/guards.mjs`). They are static, so
they catch things a browser suite can miss entirely — an id collision in markup that is
not currently rendered, a `document` reference on an engine path no test happens to
execute, a version bump applied to one of the two constants that must match. Each guard
carries a note saying which real failure put it there. Add to them when something gets
through; they cost nothing to run.

**A flaky test is worse than a failing one.** Four have been found and fixed here, and
every one first presented as a money bug:

| Symptom | Actual cause |
|---|---|
| `$77.05 vs $77.03` | Test read the *rendered* figure; the display repaints once a second, so under load it compared a stale number to a fresh one |
| Signature not saved | Test reused a canvas bounding box measured before a reflow |
| New build not arriving | The refresh button raced its own service-worker unregistration |
| Drifting totals across many suites | Two full regressions running at once |

If a test fails on a timing or money assertion, check contention first, then look for a
stale read, before touching the engine.

---

## What the app does now

| Card | What it is |
|---|---|
| Clock (`hero`) | Punch in/out, live earnings, auto clock-in, auto-stop, backdating both ends |
| Earnings (`totals`) | Today / this week / period, with each kind of paid leave on its own line |
| Pay period (`period`) | Where the current cheque stands, history by period |
| Shift log (`log`) | Every punch, editable, with the before/after overtime split |
| Floaters & sick days (`banks`) | Paid-day-off balances |
| Year to date (`ytd`), OT outlook (`ote`), Quick pay calculator (`calc`) | |
| Production (`units`), My contract (`salary`) | Non-clock professions — see `PLAN.md` |
| Custom data (`sheet`) | A generated paper time sheet with signature and filed photos |
| Scan a time card (`scan`) | Photograph a punch card, read the stamps, reconcile |

**Lite and Full** (`state.mode`). One CSS class over the same app, not a second app. Lite
shows fewer cards; it never records less, and the ledger is identical on both sides of the
switch — there are tests asserting exactly that. A user with no stored mode is treated as
Full, so nobody's existing install changes.

The rule that governs it, learned the hard way: **if behaviour runs in a mode, its controls
must be reachable in that mode.** Auto clock-in was briefly hidden in Lite while its timer
kept firing, leaving a feature starting shifts that the user could not see or switch off.

**Overtime** supports six regimes including 8-and-40 and FLSA §7(j), plus an off-day rule
(a day outside the roster pays overtime from the first minute, off by default).

---

## Scanning — and why it is about to move

Photograph a punch card; a vision model returns strict JSON of the stamps; deterministic
code pairs them into shifts and checks them; a review screen shows every row; only ticked
rows are written, as one undoable batch.

The model never writes anything. It proposes. Five deterministic layers stand between the
proposal and the data, and the reason is the single most important lesson in this feature:

> **A misread digit produces a valid time.** `1:18` read as `4:18` parses, validates and
> passes every format check — then silently pays three hours nobody worked.

The subtlest failure found so far: when one punch is missing, the parity of the whole
stream flips and every pair after it becomes the *gap between* two shifts wearing a shift's
clothes. On a real card, dropping any one of eight punches produced wrong hours every time,
and in four of eight cases **every pair came back unflagged**. The engine cannot catch this
— it has no idea what time the user starts. `scanReview()` does, by checking each pair
against the roster. That is why the reconcile layer is not optional.

**Status:** everything after the reading is proven against a real photographed card.
The browser→API call works (verified: HTTP 200, ~37 s for a full card, 549 KB upload).
It currently needs the user's own Anthropic key, stored on their device.

---

## The road ahead

### 1. WiseWage AI edition (paid tier)

Scanning moves out of the free app and into a paid, **server-side** tier using MCP and API
connections. This resolves the key problem honestly: the client understands they are paying
for a service that runs on a server, rather than being asked to obtain and paste an API key
into a web page.

**Hard rule, non-negotiable: never ask for an SSN or data of that sensitivity.** Not for
any feature, not at any tier.

### 2. Connected income

Integration with services such as Rocket Money to track real income against what the app
projects, and an open path for other apps that want to do the same.

### 3. GPS location proof

Let somebody evidence where they were when they punched. Treat location as
employee-sensitive from the first line of code: on-device by default, never in a backup
unless explicitly asked for, never transmitted without a clear and specific consent step.

### 4. Android

The app must be as good on Android as on iOS. Known differences to work through: maskable
icon treatment (already handled), install prompts, the share/install flow, and the fact
that Android's PWA storage and iOS's behave differently when an app is removed.

### 5. Deployment SOP — needs its own branch

A written, followed procedure for getting an update to users on **Windows, macOS, Linux,
iOS and Android**. Today the update path is: push to `main` → GitHub Pages → the service
worker fetches network-first → the user may need the in-app refresh button. That works but
is not written down, and the stuck-cache incident (a device pinned to an old build for over
a day) happened because of a gap in it. The SOP should cover version bumping (`APP_BUILD`
in `index.html` and `CACHE` in `sw.js` must match — nothing enforced that until the guards
landed; `tests/guards.mjs` now fails the build if they drift), the CI gate, and what a user
does on each platform when an update does not arrive.

The obvious CI check to add alongside the SOP, deliberately left out until the policy is
written: **fail a change that edits `index.html` without bumping `APP_BUILD`.** It is easy
to add — diff against the base ref in the guards job — but gating on a rule nobody has
written down yet just creates friction, so it belongs with this item rather than before it.

### 6. TimePeace

There is a desktop app called TimePeace on the owner's PC. A local session should examine
how it is built and bring across anything worth having. **This cannot be done from a cloud
session** — the app is on the owner's machine and not in this repository.

---

## Open items

- **This repository is public**, and the test fixtures contain the owner's real hourly rate
  and roster. No paystub, address, account or photo data is in here, and it must stay that
  way — but the rate is readable by anyone who finds the repo. Making it private is a
  decision the owner has not yet taken.
- **The visual overhaul.** The owner's verdict: "entirely too busy", "quirky bugs all over
  the place", "not ready for production." Both audits are finished.

  *Interaction bugs:* 12 findings, every one reproduced in a real browser at 390×844. The
  three that cost money or data are fixed and covered by `tests/ui/editguard.mjs`. Three
  more went in v90, all on the Floaters card and all with one change: a spent day is now a
  44px chip that opens the editor, instead of a 12×14px ✕ that deleted on the first tap.
  That made `openOffEditor`'s edit branch reachable (correcting a date no longer means
  giving the day back and re-booking), put the delete behind a deliberate panel, and left
  the card with fewer controls rather than more.

  The ✎ jump went in v91. `holEdit` sat below the Paid days off and Vacation sections and
  below the vacation editor — three sections from the ✎ that opens it — so the smallest
  scroll that could reveal it was ~755px and it surfaced beneath the Vacation heading. It
  now sits under its own list, the way `vacEdit` always did. Measured at 390×844: the jump
  fell 755px → 446px and the tapped row stays (just) in view.

  **It is reduced, not eliminated.** The panel is 569px in an 844px window and sits below
  the list, so some scroll is unavoidable; shortening that panel belongs to the copy pass.
  Anchoring the scroll on the tapped row was tried and is worse — the row stays visible but
  Save lands 64px below the fold, because row + list + 569px panel is 907px. Save wins.
  `holiday1.mjs` guards this by **DOM order, not pixels**, since position is the thing that
  regresses; verified failing on the old layout (`editor:12, vacList:9`).

  **Still open**, and this is the list rather than a count, because the original tally of
  twelve was summarised rather than itemised and the arithmetic no longer reconciles — trust
  these six, not a number:

  1. two editors can be open at once
  2. "Change in Settings" leaves the target group collapsed — `applyCfgGroups()` re-reads
     persisted state. Confirmed twice over: it also defeated a probe here that set
     `details.open` directly, which is how it was re-found
  3. a 4px gap between ✎ and ✕ in two row types
  4. a 17px holiday on/off checkbox
  5. the net-setup link's one-way scroll trip
  6. a toast that covers editor buttons

  Anything else from that audit is not written down anywhere durable. If the count matters,
  re-run the interaction audit rather than trusting a remembered total.

  *Copy:* 3,940 words on screen, ~2,440 achievable. Settings alone is 1,856 words, 1,177 of
  them prose. Three pieces of copy were simply **wrong** and are fixed. The four sections
  the owner named are cut. **Roughly 30 edits remain**, mostly in Settings. The standard is
  set: a label that names the thing is usually enough; people know their own employment
  terms; anything genuinely load-bearing goes behind the existing `helpnote` disclosure
  rather than on the screen.

  Order the owner asked for: bugs, then the copy pass.
- **`vacationOn()` is dead code** — the calendar uses `vacationCredits()` instead.
- Deductions/NET mode, used-allowance carry-in, and a stray 3.5-second punch remain from
  earlier work.
