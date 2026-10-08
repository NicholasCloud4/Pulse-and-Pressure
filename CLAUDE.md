# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Pulse & Pressure: a private blood pressure and pulse log, built for a friend and
used by non-technical people on phones. Readings live only in the browser's
`localStorage` on the user's device: no accounts, no database server, and health
data is never sent anywhere. That privacy promise is the core of the app; don't
add anything that sends readings off the device without asking first.

Two ways it runs:
- **Website / installed app (main use):** `static/` is the whole app. It's deployed
  to Vercel with `static` as the root directory, and installs to the home screen on
  iPhone and Android as a PWA.
- **Local server (optional):** `python app.py` serves `static/` and adds the
  "Type a note" tab, which reads free-text notes with a local model through Ollama
  (`llama3.2:3b`). The tab stays hidden unless `/api/status` answers.

## Layout

- `static/index.html`: page structure, including the `<dialog>` windows and the toast
- `static/data.js`: all data logic, with no DOM code: storage and upgrades, people and
  their doctor's targets, readings, AHA categories, plausibility checks, averages,
  measurement sessions, history filters, the doctor report's figures (`reportFor`),
  and CSV export and restore
- `static/chart.js`: SVG trend chart. `drawChart()` is shared by the screen and the
  printed report; `renderChart()` adds the crosshair and readout
- `static/app.js`: UI: rendering, events, windows, toasts, the session countdown,
  the doctor report's page, the install card
- `static/style.css`: styles with light/dark color tokens on `:root`, plus `@media print`
  for the report (always light)
- `static/sw.js`, `static/manifest.webmanifest`, `static/icons/`: PWA (offline + install)
- `tests/data.test.js`: unit tests for `data.js` (runs it in `node:vm` with a fake localStorage)
- `tests/browser/`: end-to-end tests in headless Chrome/Edge over the DevTools protocol,
  with no packages. `run.mjs` serves `static/`, launches the browser and runs every
  `*.scenario.mjs` file. Helpers are in `cdp.mjs`. Scenarios drive the page through
  element ids and app globals (`addReadings`, `loadAll`, `profileId`…), so update them
  when you rename those
- `app.py`: Flask server for local use and note parsing
- `parse_test.py`: the note parser (despite the name, it's not a test). `looks_plausible()`
  mirrors `looksPlausible()` in `data.js`, so keep the two in sync
- `test_set.py` + `score.py`: model accuracy evaluation. `HOLDOUT` must stay unseen;
  if the prompt is tuned on a holdout miss, replace the holdout notes

Scripts load in order `data.js` → `chart.js` → `app.js` as classic scripts sharing
globals. There is no bundler, no npm and no build step.

## Saved data (localStorage key `pulse-pressure-data`)

`{ version, profiles, readings }`
- profile: `{ id, name, target? }`. `target` is `{ systolic, diastolic }` from the
  doctor; a reading is on target when it's under both numbers
- reading: `{ id, profile_id, batch, taken_at, systolic, diastolic, pulse, position,
  tags, note, note_shared, session? }`
  - `taken_at` is local time, `"YYYY-MM-DDTHH:MM"`
  - the numbers are integers or null
  - `note_shared` means a typed note covered several readings, so it's left out of
    the export and report
  - `session` links readings taken a minute apart; their average is shown

Small per-device preferences (the chosen person, chart range, snoozes) are separate
localStorage keys, set through `store()` and `recall()` in `app.js`.

## Commands

- Unit tests: `node --test` (from the repo root; Node 22's `node --test tests/` form doesn't work)
- Browser tests: `node tests/browser/run.mjs` (all), `node tests/browser/run.mjs report`
  (scenarios whose name matches), `--shots <dir>` to keep screenshots. Needs Chrome,
  Edge or Chromium (or `CHROME_PATH`). Run both suites before committing UI changes
- Serve the site like Vercel does: `python -m http.server 8000 -d static`, then open
  http://localhost:8000 (service workers need localhost or https)
- Local server with note reading: `pip install flask`, `ollama pull llama3.2:3b`, `python app.py`
- Model evaluation: `python score.py` (needs Ollama running)

## Rules and conventions

- **No libraries or frameworks.** Plain HTML/CSS/JS, inline SVG for charts. Keep it
  working offline.
- **Never commit health data.** `*.csv`, `*.db` and `real_notes.py` are git-ignored;
  keep it that way, and don't put real readings in tests or examples.
- **Commits:** no `Co-Authored-By` or other Claude attribution lines. Match the
  existing style: a short imperative subject, then a plain-language body with
  bullet points explaining the why.
- **Saved data format:** bump `DATA_VERSION` in `data.js` and add an upgrade step in
  `upgradeData()` whenever the stored shape changes. Older app copies refuse newer
  data instead of overwriting it.
- **Service worker:** add any new static file to `FILES` in `sw.js` and change its
  `VERSION`. It serves cached files first and refreshes in the background, so an
  update shows on the second open.
- **iPhone storage:** the home-screen app on iOS has separate storage from Safari.
  Anything about moving or backing up data must account for that (export, then restore).
- **Writing for users:** the people using this are not technical. UI text is plain
  and friendly ("top number", not "systolic out of range"), never alarming except the
  crisis card, and never diagnostic. Categories are AHA general adult ranges and are
  always labeled as such.
- **No browser popups:** use the in-app helpers in `app.js` (`openDialog`, `ask`,
  `toast`, `showCheck`, `showStatus`) instead of `alert`/`confirm`/`prompt`.
- **Accessibility and phones:** tap targets at least 44px, a text label beside every
  color, work at 360px wide, and light and dark mode via the CSS tokens.
- **Validation lives in `data.js`** (empty readings, future times, names, targets), so
  the UI, editing and restore all get the same rules. Add tests in `tests/data.test.js`
  for new data logic, and a browser scenario (or checks in an existing one) for new UI.
- **Charts:** follow the existing chart: two panels instead of a second y-axis
  (mmHg and bpm are different units), a legend plus end labels, and series colors
  checked for color blindness. Text is never colored by series.
- **Testing on Windows:** Chrome's profile folder must sit in a short path. A long one
  breaks CacheStorage, and the service worker then fails to install. `run.mjs`
  already uses `os.tmpdir()/pp-*`. PowerShell 5.1 garbles non-ASCII characters
  (like "·") when it rewrites files, so edit files with the editor tools instead.
