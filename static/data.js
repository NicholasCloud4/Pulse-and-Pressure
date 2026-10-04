// Pulse & Pressure data: everything is kept in this browser's storage, on this
// device only. Nothing here talks to a server. Loaded before chart.js and app.js.

// The choices offered when logging. Keys are stored; labels are shown.
const POSITIONS = { sitting: "Sitting", standing: "Standing", lying: "Lying down" };
const TAGS = {
    medication: "Medication taken",
    stressed: "Stressed",
    exercise: "After exercise",
    caffeine: "Caffeine",
};

// General American Heart Association adult ranges. A label, not a diagnosis.
const CATEGORIES = {
    normal: "Normal",
    elevated: "Elevated",
    stage1: "Stage 1 high",
    stage2: "Stage 2 high",
    crisis: "Hypertensive crisis",
};

const DATA_KEY = "pulse-pressure-data";
let data = { profiles: [], readings: [] };

function categorize(systolic, diastolic) {
    if (systolic === null || diastolic === null) return null;
    if (systolic > 180 || diastolic > 120) return "crisis";
    if (systolic >= 140 || diastolic >= 90) return "stage2";
    if (systolic >= 130 || diastolic >= 80) return "stage1";
    if (systolic >= 120) return "elevated";
    return "normal";
}

// Same rules as looks_plausible() in parse_test.py
function looksPlausible(r) {
    const problems = [];
    if (r.systolic !== null && !(r.systolic >= 70 && r.systolic <= 250)) problems.push("systolic out of range");
    if (r.diastolic !== null && !(r.diastolic >= 40 && r.diastolic <= 150)) problems.push("diastolic out of range");
    if (r.pulse !== null && !(r.pulse >= 30 && r.pulse <= 220)) problems.push("pulse out of range");
    if (r.systolic !== null && r.diastolic !== null && r.systolic <= r.diastolic) {
        problems.push("systolic should be higher than diastolic");
    }
    return problems;
}

// "2026-10-03T19:42" in local time, the format readings are stored in
function toLocalIso(date) {
    const d = new Date(date);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
}

function nowLocal() {
    return toLocalIso(new Date());
}

function newId() {
    // crypto.randomUUID only works on https or localhost; this also works on a home-network address
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------- Storage ----------
function loadData() {
    let raw;
    try {
        raw = localStorage.getItem(DATA_KEY);
    } catch (e) {
        throw new Error("This browser is blocking storage, so readings can't be saved here. "
            + "Check that site data is allowed, and that this isn't a private window.");
    }
    if (!raw) { data = { profiles: [], readings: [] }; return; }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        // Stop here rather than start fresh, so the saved data isn't overwritten
        throw new Error("The readings saved in this browser couldn't be read.");
    }
    data = { profiles: parsed.profiles || [], readings: parsed.readings || [] };
}

// Apply a change and save it. If saving fails, the change is undone.
function commit(change) {
    change(data);
    try {
        localStorage.setItem(DATA_KEY, JSON.stringify(data));
    } catch (e) {
        loadData();
        throw new Error("Couldn't save on this device. The browser may be out of space or blocking storage.");
    }
}

// Ask the browser not to clear these readings when it's low on space
function askToKeepData() {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
}

// ---------- People ----------
function listProfiles() {
    return data.profiles;
}

function addProfile(name) {
    name = (name || "").trim();
    if (!name || name.length > 40) throw new Error("Enter a name (up to 40 characters).");
    if (data.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("That name already exists.");
    }
    const profile = { id: newId(), name };
    commit((d) => d.profiles.push(profile));
    return profile;
}

function profileName(profileId) {
    const p = data.profiles.find((x) => x.id === profileId);
    return p ? p.name : "";
}

// ---------- Readings ----------
function cleanNumber(v) {
    return Number.isInteger(v) ? v : null;
}

function cleanTime(value) {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value || "") ? value.slice(0, 16) : nowLocal();
}

function cleanDetails(extra) {
    const position = extra.position in POSITIONS ? extra.position : null;
    const tags = Object.keys(TAGS).filter((t) => (extra.tags || []).includes(t));
    return { position, tags };
}

// Save one or more readings. Readings saved together share a batch id,
// so the CSV export can tell a note that held several readings.
function addReadings(profileId, readings, extra) {
    const batch = newId();
    const { position, tags } = cleanDetails(extra);
    const note = String(extra.note || "").slice(0, 500);
    const cleaned = readings.map((r, i) => {
        const item = {
            id: newId(), profile_id: profileId, batch,
            taken_at: cleanTime(r.taken_at),
            systolic: cleanNumber(r.systolic), diastolic: cleanNumber(r.diastolic), pulse: cleanNumber(r.pulse),
            position, tags, note,
        };
        if (item.systolic === null && item.diastolic === null && item.pulse === null) {
            throw new Error("Reading " + (i + 1) + " is empty.");
        }
        return item;
    });
    commit((d) => d.readings.push(...cleaned));
    return { saved: cleaned.length, crisis: cleaned.some((r) => categorize(r.systolic, r.diastolic) === "crisis") };
}

function deleteReading(id) {
    commit((d) => { d.readings = d.readings.filter((r) => r.id !== id); });
}

// A person's readings, newest first, each with its category
function readingsFor(profileId) {
    return data.readings
        .filter((r) => r.profile_id === profileId)
        .reverse()  // most recently added first when two share the same time
        .sort((a, b) => (a.taken_at < b.taken_at ? 1 : a.taken_at > b.taken_at ? -1 : 0))
        .map((r) => ({ ...r, category: categorize(r.systolic, r.diastolic) }));
}

// ---------- Averages ----------
function average(values) {
    const known = values.filter((v) => v !== null);
    return known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null;
}

function averagesFor(readings, days) {
    const since = days ? toLocalIso(Date.now() - days * 86400000) : "";
    const inRange = readings.filter((r) => r.taken_at >= since);
    const systolic = average(inRange.map((r) => r.systolic));
    const diastolic = average(inRange.map((r) => r.diastolic));
    return {
        count: inRange.length, systolic, diastolic,
        pulse: average(inRange.map((r) => r.pulse)),
        category: categorize(systolic, diastolic),
    };
}

function statsFor(profileId) {
    const readings = readingsFor(profileId);
    return [
        { label: "Last 7 days", ...averagesFor(readings, 7) },
        { label: "Last 30 days", ...averagesFor(readings, 30) },
        { label: "All time", ...averagesFor(readings, null) },
    ];
}

// ---------- CSV export ----------
const CSV_HEADER = ["Date", "Time", "Systolic", "Diastolic", "Pulse", "Category", "Position", "Tags", "Note"];

function csvField(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

// Stop spreadsheet apps from treating a note as a formula
function csvSafe(text) {
    return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function exportCsv(profileId) {
    const readings = readingsFor(profileId).reverse();  // oldest first
    // A note that held several readings only repeats numbers already in the
    // columns, so only notes from single-reading saves are written
    const batchSizes = {};
    readings.forEach((r) => { batchSizes[r.batch] = (batchSizes[r.batch] || 0) + 1; });

    const lines = [CSV_HEADER];
    readings.forEach((r) => {
        const note = batchSizes[r.batch] === 1
            ? (r.note || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(" / ")
            : "";
        lines.push([
            r.taken_at.slice(0, 10), r.taken_at.slice(11, 16),
            r.systolic, r.diastolic, r.pulse,
            CATEGORIES[r.category] || "",
            POSITIONS[r.position] || "",
            r.tags.map((t) => TAGS[t]).filter(Boolean).join("; "),
            csvSafe(note),
        ]);
    });
    // The BOM lets Excel open the file with the right encoding
    return "﻿" + lines.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

function exportFileName(profileId) {
    const name = profileName(profileId).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "readings";
    return "pulse-pressure-" + name + "-" + nowLocal().slice(0, 10) + ".csv";
}

// ---------- Restore from an exported CSV ----------
function parseCsv(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field); rows.push(row); row = []; field = "";
        } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// Accepts 2026-10-03 or 10/3/2026 (how Excel may re-save it)
function parseDate(text) {
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
    if (m) return [m[1], m[2], m[3]];
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    return m ? [m[3], m[1], m[2]] : null;
}

// Accepts 19:42, 19:42:00 or 7:42 PM
function parseTime(text) {
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/i.exec(text || "00:00");
    if (!m) return null;
    let hour = Number(m[1]);
    if (m[3]) hour = (hour % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
    return hour < 24 ? [hour, m[2]] : null;
}

function parseNumber(text) {
    if (text === "") return null;
    return /^\d+$/.test(text) ? Number(text) : undefined;  // undefined = not a number
}

// Find the key for a stored key or its label ("Lying down" -> "lying")
function keyFor(choices, text) {
    const t = text.trim().toLowerCase();
    return Object.keys(choices).find((k) => k === t || choices[k].toLowerCase() === t) || null;
}

const pad = (v) => String(v).padStart(2, "0");
const sameReading = (r) => [r.taken_at, r.systolic, r.diastolic, r.pulse].join("|");

// Add the readings from an exported CSV that aren't already on this device
function importCsv(profileId, text) {
    const rows = parseCsv(text).filter((row) => row.some((cell) => cell.trim() !== ""));
    const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
    const col = (name) => header.indexOf(name);
    if (col("date") === -1 || col("systolic") === -1) {
        throw new Error("This file doesn't look like a Pulse & Pressure export.");
    }
    const cell = (row, name) => (col(name) === -1 ? "" : (row[col(name)] || "").trim());

    const existing = new Set(readingsFor(profileId).map(sameReading));
    const found = [];
    let skipped = 0, unreadable = 0;
    rows.forEach((row) => {
        const date = parseDate(cell(row, "date"));
        const time = parseTime(cell(row, "time"));
        const r = {
            systolic: parseNumber(cell(row, "systolic")),
            diastolic: parseNumber(cell(row, "diastolic")),
            pulse: parseNumber(cell(row, "pulse")),
        };
        const numbers = [r.systolic, r.diastolic, r.pulse];
        if (!date || !time || numbers.includes(undefined) || numbers.every((v) => v === null)) {
            unreadable++;
            return;
        }
        r.taken_at = date[0] + "-" + pad(date[1]) + "-" + pad(date[2]) + "T" + pad(time[0]) + ":" + time[1];
        if (existing.has(sameReading(r))) { skipped++; return; }
        existing.add(sameReading(r));
        let note = cell(row, "note");
        if (/^'[=+\-@]/.test(note)) note = note.slice(1);  // undo csvSafe()
        found.push({
            ...r, note,
            position: keyFor(POSITIONS, cell(row, "position")),
            tags: cell(row, "tags").split(/[;,]/).map((t) => keyFor(TAGS, t)).filter(Boolean),
        });
    });

    const added = found.map((r) => ({ id: newId(), profile_id: profileId, batch: newId(), ...r }));
    if (added.length) commit((d) => d.readings.push(...added));
    return { added: added.length, skipped, unreadable };
}
