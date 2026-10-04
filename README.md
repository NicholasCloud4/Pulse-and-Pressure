# Pulse and Pressure

A private blood pressure and pulse log, built for a friend. You type or dictate
a reading the way you'd write it in a phone note ("128 over 82, pulse 71, after
coffee"), and a small open-weight model running on your own computer turns it
into clean data.

Everything runs locally. No account, no cloud, no API bill, and no health data
leaving the machine.

## Features

- **Two ways to log:** a quick form (three numbers plus tap-to-pick position
  and tags) for everyday use, or a free-text note read by the local model
- **Position and tags:** sitting / standing / lying down; medication taken,
  stressed, after exercise, caffeine. The app remembers your usual position.
- **AHA categories:** each reading is labeled Normal, Elevated, Stage 1 high,
  Stage 2 high or Hypertensive crisis using general adult ranges
- **Crisis alert:** a reading above 180/120 shows a clear warning with what to do
- **Trend chart:** systolic, diastolic and pulse over the last 20 readings
- **Averages:** last 7 days, last 30 days and all time, with reading counts
- **CSV export** to bring to a doctor's appointment

Run `pip install flask`, then `python app.py`, and open the address it prints.

## How it works

- **Model:** `llama3.2:3b` running through [Ollama](https://ollama.com)
- **Structured output:** Ollama is given a JSON schema, so the model can only
  reply in the shape the app expects (a list of readings)
- **Plain-code safety net:** the model only reads the note. Plausibility checks
  (for example, "systolic must be higher than diastolic") are ordinary code.

## Try the parser

1. Install Ollama and run `ollama pull llama3.2:3b`
2. Install Python 3 (no extra packages needed)
3. Run `python parse_test.py` for a quick demo
4. Run `python score.py` to score the model on the test notes

## Results so far (llama3.2:3b, 11 GB RAM PC, no GPU, offline)

| Stage                                            | Result                                                |
| ------------------------------------------------ | ----------------------------------------------------- |
| First version, single reading per note           | 28/30 on made-up notes, then 30/30 after a prompt fix |
| Multi-reading version, first run on unseen notes | 16/20                                                 |
| After worked examples and a small code filter    | 19/20 on a fresh unseen set                           |

About 5 to 7 seconds per note. The test notes are made up and tidier than real
ones, and 20 notes is a small sample, so treat these as encouraging, not final.

Known weak spots: spoken-style numbers ("one fifty over ninety five" came back
as 155/95) and a pulse occasionally attached to the wrong reading. The app will
show what it read and ask for confirmation before saving anything.

## Files

- `parse_test.py`: sends a note to the local model and returns structured readings
- `test_set.py`: made-up test notes with the correct answers
- `score.py`: scores the model on the test notes

## Not medical advice

This is a logging tool. It does not diagnose anything. If you have very high
readings or symptoms like chest pain or severe headache, contact a doctor or
emergency services.
