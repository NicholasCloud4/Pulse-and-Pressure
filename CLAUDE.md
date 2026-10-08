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
- `static/data.js`: all data logic (storage, people, readings, AHA categories,
  plausibility checks, averages, CSV export and restore). No DOM code
- `static/chart.js`: SVG trend chart
- `static/app.js`: UI: rendering, events, windows, toasts, install card
- `static/style.css`: styles with light/dark color tokens on `:root`
- `static/sw.js`, `static/manifest.webmanifest`, `static/icons/`: PWA (offline + install)
- `tests/data.test.js`: unit tests for `data.js` (runs it in `node:vm` with a fake localStorage)
- `app.py`: Flask server for local use and note parsing
- `parse_test.py`: the note parser (despite the name, it's not a test). `looks_plausible()`
  mirrors `looksPlausible()` in `data.js`, so keep the two in sync
- `test_set.py` + `score.py`: model accuracy evaluation. `HOLDOUT` must stay unseen;
  if the prompt is tuned on a holdout miss, replace the holdout notes

Scripts load in order `data.js` → `chart.js` → `app.js` as classic scripts sharing
globals. There is no bundler, no npm and no build step.

## Commands

- Unit tests: `node --test` (from the repo root; Node 22's `node --test tests/` form doesn't work)
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
- **Validation lives in `data.js`** (empty readings, future times, names), so the UI,
  editing and restore all get the same rules. Add tests in `tests/data.test.js`
  for new data logic.
