"""Pulse and Pressure: a private blood pressure log that runs on your own computer.

Run:  python app.py
Then open the address it prints, on this computer or on a phone on the same Wi-Fi.
"""

import csv
import io
import re
import socket
import sqlite3
import urllib.error
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

from parse_test import MODEL, looks_plausible, parse_reading

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "pulse_pressure.db"  # ignored by git (see .gitignore)
PORT = 8000

app = Flask(
    __name__,
    static_folder=str(BASE_DIR / "static"),
    static_url_path="/static",
)
app.json.sort_keys = False  # keep the choices below in the order they're written

# The choices offered when logging. Keys are stored; labels are shown.
POSITIONS = {"sitting": "Sitting", "standing": "Standing", "lying": "Lying down"}
TAGS = {
    "medication": "Medication taken",
    "stressed": "Stressed",
    "exercise": "After exercise",
    "caffeine": "Caffeine",
}

# General American Heart Association adult ranges. A label, not a diagnosis.
CATEGORIES = {
    "normal": "Normal",
    "elevated": "Elevated",
    "stage1": "Stage 1 high",
    "stage2": "Stage 2 high",
    "crisis": "Hypertensive crisis",
}


def categorize(systolic, diastolic):
    """AHA category key for a reading, or None if either number is missing."""
    if systolic is None or diastolic is None:
        return None
    if systolic > 180 or diastolic > 120:
        return "crisis"
    if systolic >= 140 or diastolic >= 90:
        return "stage2"
    if systolic >= 130 or diastolic >= 80:
        return "stage1"
    if systolic >= 120:
        return "elevated"
    return "normal"


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with closing(connect()) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id INTEGER NOT NULL REFERENCES profiles(id),
                taken_at TEXT NOT NULL,
                systolic INTEGER,
                diastolic INTEGER,
                pulse INTEGER,
                note TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_readings_profile_time
                ON readings(profile_id, taken_at);
            """
        )
        # Add columns that older databases don't have yet (keeps existing data)
        columns = {r["name"] for r in conn.execute("PRAGMA table_info(readings)")}
        for name in ("position", "tags"):
            if name not in columns:
                conn.execute(f"ALTER TABLE readings ADD COLUMN {name} TEXT")
        conn.commit()


def profile_exists(conn, profile_id):
    return conn.execute(
        "SELECT 1 FROM profiles WHERE id = ?", (profile_id,)
    ).fetchone() is not None


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/options")
def options():
    return jsonify(positions=POSITIONS, tags=TAGS, categories=CATEGORIES)


# ---------------------------------------------------------------------------
# Profiles
# ---------------------------------------------------------------------------
@app.get("/api/profiles")
def list_profiles():
    with closing(connect()) as conn:
        rows = conn.execute("SELECT id, name FROM profiles ORDER BY id").fetchall()
    return jsonify(profiles=[dict(r) for r in rows])


@app.post("/api/profiles")
def add_profile():
    name = ((request.get_json(silent=True) or {}).get("name") or "").strip()
    if not name or len(name) > 40:
        return jsonify(error="Enter a name (up to 40 characters)."), 400
    try:
        with closing(connect()) as conn:
            cur = conn.execute("INSERT INTO profiles (name) VALUES (?)", (name,))
            conn.commit()
            new_id = cur.lastrowid
    except sqlite3.IntegrityError:
        return jsonify(error="That name already exists."), 409
    return jsonify(id=new_id, name=name), 201


# ---------------------------------------------------------------------------
# Parsing a note with the local model
# ---------------------------------------------------------------------------
@app.post("/api/parse")
def parse():
    note = ((request.get_json(silent=True) or {}).get("note") or "").strip()
    if not note:
        return jsonify(error="Type a reading first."), 400
    if len(note) > 500:
        return jsonify(error="That note is too long. Try one day at a time."), 400

    try:
        readings = parse_reading(note)
    except urllib.error.HTTPError:
        return jsonify(
            error=f"Ollama replied with an error. Is the model downloaded? "
            f"Run: ollama pull {MODEL}"
        ), 503
    except urllib.error.URLError:
        return jsonify(
            error="Can't reach Ollama. Make sure it is running on the computer."
        ), 503
    except Exception:
        return jsonify(
            error="The model gave an unexpected answer. Try rewording the note."
        ), 500

    for r in readings:
        r["problems"] = looks_plausible(r)
    return jsonify(readings=readings)


# ---------------------------------------------------------------------------
# Saving, listing and deleting readings
# ---------------------------------------------------------------------------
def clean_number(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("values must be whole numbers.")
    return value


def clean_time(value):
    try:
        return datetime.fromisoformat(value).isoformat(timespec="minutes")
    except (TypeError, ValueError):
        return datetime.now().isoformat(timespec="minutes")


def clean_details(data):
    """Position and tags from a request, keeping only the known choices."""
    position = data.get("position")
    if position not in POSITIONS:
        position = None
    tags = data.get("tags")
    tags = [t for t in TAGS if isinstance(tags, list) and t in tags]
    return position, ",".join(tags) or None


@app.post("/api/readings")
def save_readings():
    data = request.get_json(silent=True) or {}
    raw = data.get("readings")
    if not isinstance(raw, list) or not 1 <= len(raw) <= 20:
        return jsonify(error="Add at least one reading."), 400

    cleaned, problems = [], []
    for i, r in enumerate(raw, start=1):
        if not isinstance(r, dict):
            return jsonify(error=f"Reading {i} is not valid."), 400
        try:
            item = {k: clean_number(r.get(k)) for k in ("systolic", "diastolic", "pulse")}
        except ValueError as e:
            return jsonify(error=f"Reading {i}: {e}"), 400
        if all(v is None for v in item.values()):
            return jsonify(error=f"Reading {i} is empty."), 400
        item["taken_at"] = clean_time(r.get("taken_at"))
        cleaned.append(item)
        problems += [f"Reading {i}: {p}" for p in looks_plausible(item)]

    # Plain-code safety check. The person can still choose "save anyway".
    if problems and not data.get("force"):
        return jsonify(error="Some values look unusual.", problems=problems), 422

    note = str(data.get("note") or "")[:500]
    position, tags = clean_details(data)
    now = datetime.now().isoformat(timespec="seconds")

    with closing(connect()) as conn:
        profile_id = data.get("profile_id")
        if not profile_exists(conn, profile_id):
            return jsonify(error="Pick a person first."), 400
        conn.executemany(
            "INSERT INTO readings "
            "(profile_id, taken_at, systolic, diastolic, pulse, note, position, tags, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (profile_id, r["taken_at"], r["systolic"], r["diastolic"], r["pulse"],
                 note, position, tags, now)
                for r in cleaned
            ],
        )
        conn.commit()
    crisis = any(categorize(r["systolic"], r["diastolic"]) == "crisis" for r in cleaned)
    return jsonify(saved=len(cleaned), crisis=crisis), 201


@app.get("/api/readings")
def list_readings():
    profile_id = request.args.get("profile_id", type=int)
    limit = min(max(request.args.get("limit", 30, type=int), 1), 200)
    offset = max(request.args.get("offset", 0, type=int), 0)
    with closing(connect()) as conn:
        rows = conn.execute(
            "SELECT id, taken_at, systolic, diastolic, pulse, position, tags FROM readings "
            "WHERE profile_id = ? ORDER BY taken_at DESC, id DESC LIMIT ? OFFSET ?",
            (profile_id, limit, offset),
        ).fetchall()
    readings = []
    for r in rows:
        r = dict(r)
        r["tags"] = r["tags"].split(",") if r["tags"] else []
        r["category"] = categorize(r["systolic"], r["diastolic"])
        readings.append(r)
    return jsonify(readings=readings)


@app.delete("/api/readings/<int:reading_id>")
def delete_reading(reading_id):
    with closing(connect()) as conn:
        conn.execute("DELETE FROM readings WHERE id = ?", (reading_id,))
        conn.commit()
    return jsonify(deleted=reading_id)


# ---------------------------------------------------------------------------
# Stats and export
# ---------------------------------------------------------------------------
def averages(conn, profile_id, days=None):
    """Average reading over the last `days` days (or all time if None)."""
    since = "" if days is None else (
        datetime.now() - timedelta(days=days)
    ).isoformat(timespec="minutes")
    row = conn.execute(
        "SELECT COUNT(*) AS count, AVG(systolic) AS systolic, "
        "AVG(diastolic) AS diastolic, AVG(pulse) AS pulse "
        "FROM readings WHERE profile_id = ? AND taken_at >= ?",
        (profile_id, since),
    ).fetchone()
    avg = {k: None if row[k] is None else round(row[k]) for k in ("systolic", "diastolic", "pulse")}
    return {"count": row["count"], **avg, "category": categorize(avg["systolic"], avg["diastolic"])}


@app.get("/api/stats")
def stats():
    profile_id = request.args.get("profile_id", type=int)
    with closing(connect()) as conn:
        if not profile_exists(conn, profile_id):
            return jsonify(error="Pick a person first."), 404
        periods = [
            {"label": "Last 7 days", **averages(conn, profile_id, 7)},
            {"label": "Last 30 days", **averages(conn, profile_id, 30)},
            {"label": "All time", **averages(conn, profile_id)},
        ]
    return jsonify(periods=periods)


def csv_safe(text):
    """Stop spreadsheet apps from treating a note as a formula."""
    return "'" + text if text[:1] in ("=", "+", "-", "@") else text


@app.get("/api/export.csv")
def export_csv():
    profile_id = request.args.get("profile_id", type=int)
    with closing(connect()) as conn:
        profile = conn.execute(
            "SELECT name FROM profiles WHERE id = ?", (profile_id,)
        ).fetchone()
        if profile is None:
            return jsonify(error="Pick a person first."), 404
        rows = conn.execute(
            "SELECT taken_at, systolic, diastolic, pulse, position, tags, note "
            "FROM readings WHERE profile_id = ? ORDER BY taken_at, id",
            (profile_id,),
        ).fetchall()

    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Date", "Time", "Systolic", "Diastolic", "Pulse",
                     "Category", "Position", "Tags", "Note"])
    for r in rows:
        when = datetime.fromisoformat(r["taken_at"])
        category = categorize(r["systolic"], r["diastolic"])
        tags = [TAGS[t] for t in (r["tags"] or "").split(",") if t in TAGS]
        writer.writerow([
            when.strftime("%Y-%m-%d"),
            when.strftime("%H:%M"),
            r["systolic"], r["diastolic"], r["pulse"],
            CATEGORIES.get(category, ""),
            POSITIONS.get(r["position"], ""),
            "; ".join(tags),
            csv_safe(r["note"] or ""),
        ])

    name = re.sub(r"[^A-Za-z0-9_-]+", "-", profile["name"]).strip("-") or "readings"
    filename = f"pulse-pressure-{name}-{datetime.now():%Y-%m-%d}.csv"
    # The BOM lets Excel open the file with the right encoding
    return Response(
        "﻿" + out.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Start the server
# ---------------------------------------------------------------------------
def local_ip():
    """This computer's address on the home network (sends no data)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    init_db()
    ip = local_ip()
    print()
    print("Pulse and Pressure is running.")
    print(f"  On this computer:  http://localhost:{PORT}")
    print(f"  On your phone:     http://{ip}:{PORT}   (same Wi-Fi)")
    print(f"  Model:             {MODEL}")
    print("Press Ctrl+C to stop.")
    print()
    # debug stays off: debug mode on a network-facing server is unsafe
    app.run(host="0.0.0.0", port=PORT, debug=False)