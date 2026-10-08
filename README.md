# Pulse and Pressure

A private blood pressure and pulse log, built for a friend. Log a reading with a
quick form, or (when running on your own computer) type or dictate it the way
you'd write a phone note ("128 over 82, pulse 71, after coffee") and a small
open-weight model turns it into clean data.

Readings are saved only on the device you use, in that browser's storage. There's
no account, no database server and no API bill, and health data is never sent
anywhere.

## Features

- **Two ways to log:** a quick form (three numbers plus tap-to-pick position
  and tags) for everyday use, or a free-text note read by a local model (when
  running on your own computer with Ollama)
- **Position, tags and notes:** sitting / standing / lying down; medication
  taken, stressed, after exercise, caffeine; and an optional short note ("left
  arm", "felt dizzy"). The app remembers your usual position.
- **Fix mistakes:** edit any saved reading, and undo a delete for a few seconds
  afterwards. Unusual numbers (like a top number of 300) ask you to check
  before saving, and times in the future aren't accepted.
- **AHA categories:** each reading is labeled using general adult ranges from
  the American Heart Association (see the table below)
- **Crisis alert:** a reading above 180/120 shows a clear warning with what to do
- **Trend chart:** systolic, diastolic and pulse over the last 20 readings
- **Averages:** last 7 days, last 30 days and all time, with reading counts
- **Reading history:** 10 readings per page with Newer / Older buttons
- **Export CSV** to bring to a doctor's appointment or keep as a backup
- **Restore** from an exported CSV to bring back missing readings or move them
  to a new device
- **Backup reminder:** once there are 10 or more readings, the app suggests an
  export if there hasn't been one in the last 30 days
- **More than one person:** each person gets their own readings. Tap **⋯**
  next to the name to rename or delete a person.
- Works on phones and computers, in light and dark mode

## Two ways to use it

### 1. On the web

The `static/` folder is a complete website on its own, and can be hosted for
free on a static host like Vercel (see [Deploying to Vercel](#deploying-to-vercel)).
Anyone who opens the address gets their own empty log, saved on their own
device. The "Type a note" tab is hidden on the web, because it needs Ollama
running on a computer.

### 2. On your own computer (with note reading)

You need:

- **Python 3** with Flask: `pip install flask`
- **[Ollama](https://ollama.com)** with the model: `ollama pull llama3.2:3b`
  (only needed for the "Type a note" tab)

Then, from this folder:

```
python app.py
```

It prints two addresses:

- **On this computer:** http://localhost:8000
- **On your phone:** something like `http://192.168.1.77:8000`. The phone must
  be on the same Wi-Fi.

Type the address with `http://`, not `https://`. The app doesn't have a
security certificate when running this way, so an `https://` address won't
load. Leave the terminal open while you use the app, and press **Ctrl+C** to
stop it.

The phone address can change after the router or computer restarts. If it stops
working, use the one `python app.py` prints when it starts.

## Your data

- **Readings live in the browser you log them in.** A phone and a computer each
  keep their own readings, and so do different browsers on the same device.
  The website, `localhost:8000` and the phone address each count separately too.
- **Export now and then as a backup.** Clearing your browser's history or site
  data deletes the readings. On an iPhone, Safari can also clear a website's
  data after about a week without a visit. Adding the site to the Home Screen
  (Share, then Add to Home Screen) and opening it from there avoids that.
- **Export CSV** (above the reading history) downloads every reading for the
  selected person, oldest first, with date, time, numbers, category, position,
  tags and notes. A note typed with several readings in it is left out of the
  export, since those numbers already have their own rows.
- **Restore** reads an exported CSV and adds any readings that aren't already
  on the device. Readings already there are skipped, so restoring the same file
  twice is harmless. On a new device, tap **Restore from file** on the welcome
  screen and it sets up the person for you. Files re-saved by Excel work too.
- Exported `.csv` files are listed in `.gitignore`, so they're never committed.

## Deploying to Vercel

1. Push this repository to GitHub.
2. Sign in at [vercel.com](https://vercel.com) with your GitHub account.
3. Choose **Add New → Project** and import the `Pulse-and-Pressure` repository.
4. Next to **Root Directory**, choose **Edit** and select the `static` folder.
5. Leave **Framework Preset** as **Other**, with no build command.
6. Choose **Deploy**. Vercel gives you an address like
   `https://pulse-and-pressure.vercel.app`.

From then on, every push to GitHub updates the website automatically. Because
only `static/` is deployed, `app.py` and the parser files never run on Vercel.

## Blood pressure categories

General adult ranges from the American Heart Association. Your doctor may set
different targets for you.

| Category            | Top (systolic)  |        | Bottom (diastolic) |
| ------------------- | --------------- | ------ | ------------------ |
| Normal              | under 120       | and    | under 80           |
| Elevated            | 120 to 129      | and    | under 80           |
| Stage 1 high        | 130 to 139      | or     | 80 to 89           |
| Stage 2 high        | 140 or higher   | or     | 90 or higher       |
| Hypertensive crisis | higher than 180 | and/or | higher than 120    |

A reading needs both the top and bottom number to get a category.

## How it works

- **Page:** plain HTML, CSS and JavaScript with no outside libraries. Readings
  are stored with the browser's `localStorage`, and the chart is drawn with SVG,
  so it works offline once loaded.
- **Server (optional):** `app.py` is a small [Flask](https://flask.palletsprojects.com)
  app that serves the page and adds note reading. The page asks `/api/status`
  whether note reading is available and shows the "Type a note" tab only if it is.
- **Model:** `llama3.2:3b` running through Ollama
- **Structured output:** Ollama is given a JSON schema, so the model can only
  reply in the shape the app expects (a list of readings)
- **Plain-code safety net:** the model only reads the note. Plausibility checks
  (for example, "systolic must be higher than diastolic") are ordinary code, and
  the app shows what the model read and asks you to confirm before saving.

## Try the parser on its own

1. Install Ollama and run `ollama pull llama3.2:3b`
2. Install Python 3 (no extra packages needed for the parser)
3. Run `python parse_test.py` for a quick demo
4. Run `python score.py` to score the model on the test notes

## Parser results so far (llama3.2:3b, 11 GB RAM PC, no GPU, offline)

| Stage                                            | Result                                                |
| ------------------------------------------------ | ----------------------------------------------------- |
| First version, single reading per note           | 28/30 on made-up notes, then 30/30 after a prompt fix |
| Multi-reading version, first run on unseen notes | 16/20                                                 |
| After worked examples and a small code filter    | 19/20 on a fresh unseen set                           |

About 5 to 7 seconds per note. The test notes are made up and tidier than real
ones, and 20 notes is a small sample, so treat these as encouraging, not final.

Known weak spots: spoken-style numbers ("one fifty over ninety five" came back
as 155/95) and a pulse occasionally attached to the wrong reading. That's why
the app always shows what it read and asks for confirmation before saving.

## Files

- `static/index.html`: the page layout
- `static/style.css`: the styling, including dark mode
- `static/data.js`: saving readings on the device, categories, averages,
  export and restore
- `static/app.js`: logging, the reading history and the buttons
- `static/chart.js`: the trend chart
- `app.py`: optional local server that serves the page and reads notes with Ollama
- `parse_test.py`: sends a note to the local model and returns structured readings
- `test_set.py`: made-up test notes with the correct answers
- `score.py`: scores the model on the test notes

## Not medical advice

This is a logging tool. It does not diagnose anything. If you have very high
readings or symptoms like chest pain or severe headache, contact a doctor or
emergency services.
