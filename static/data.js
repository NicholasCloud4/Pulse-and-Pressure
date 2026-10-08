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
// Raise this when the saved format changes, and add a step to upgradeData()
const DATA_VERSION = 1;
let data = { version: DATA_VERSION, profiles: [], readings: [] };

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
    if (r.systolic !== null && !(r.systolic >= 70 && r.systolic <= 250)) {
        problems.push("the top number (" + r.systolic + ") is outside the usual 70 to 250");
    }
    if (r.diastolic !== null && !(r.diastolic >= 40 && r.diastolic <= 150)) {
        problems.push("the bottom number (" + r.diastolic + ") is outside the usual 40 to 150");
    }
    if (r.pulse !== null && !(r.pulse >= 30 && r.pulse <= 220)) {
        problems.push("the pulse (" + r.pulse + ") is outside the usual 30 to 220");
    }
    if (r.systolic !== null && r.diastolic !== null && r.systolic <= r.diastolic) {
        problems.push("the top number should be higher than the bottom number");
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
    if (!raw) { data = { version: DATA_VERSION, profiles: [], readings: [] }; return; }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        // Stop here rather than start fresh, so the saved data isn't overwritten
        throw new Error("The readings saved in this browser couldn't be read.");
    }
    // An older copy of the app (for example one still saved for offline use) must not
    // save over data it doesn't fully understand
    if ((parsed.version || 0) > DATA_VERSION) {
        throw new Error("These readings were saved by a newer version of the app. "
            + "Close the app completely and open it again to update it.");
    }
    data = upgradeData(parsed);
}

// Bring data saved by an older version up to the current format
function upgradeData(saved) {
    const upgraded = { version: DATA_VERSION, profiles: saved.profiles || [], readings: saved.readings || [] };
    if (!saved.version) {
        // Version 1 records whether a note was typed for several readings at once.
        // Before that it was worked out by counting the readings left in each batch.
        const batchSizes = {};
        upgraded.readings.forEach((r) => { batchSizes[r.batch] = (batchSizes[r.batch] || 0) + 1; });
        upgraded.readings.forEach((r) => { r.note_shared = batchSizes[r.batch] > 1; });
    }
    // Future changes go here, e.g. if (saved.version < 2) { ... }
    return upgraded;
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

// A trimmed name, or an error if it's empty, too long, or another person's name
function checkName(name, exceptId) {
    name = (name || "").trim();
    if (!name || name.length > 40) throw new Error("Enter a name (up to 40 characters).");
    if (data.profiles.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("That name already exists.");
    }
    return name;
}

function addProfile(name) {
    const profile = { id: newId(), name: checkName(name) };
    commit((d) => d.profiles.push(profile));
    return profile;
}

function renameProfile(profileId, name) {
    name = checkName(name, profileId);
    commit((d) => { d.profiles.find((p) => p.id === profileId).name = name; });
    return name;
}

// Removes the person and all of their readings
function deleteProfile(profileId) {
    commit((d) => {
        d.profiles = d.profiles.filter((p) => p.id !== profileId);
        d.readings = d.readings.filter((r) => r.profile_id !== profileId);
    });
}

function profileName(profileId) {
    const p = data.profiles.find((x) => x.id === profileId);
    return p ? p.name : "";
}

// ---------- Readings ----------
function cleanNumber(v) {
    return Number.isInteger(v) ? v : null;
}

const VALID_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function cleanTime(value) {
    return VALID_TIME.test(value || "") ? value.slice(0, 16) : nowLocal();
}

function cleanDetails(extra) {
    const position = extra.position in POSITIONS ? extra.position : null;
    const tags = Object.keys(TAGS).filter((t) => (extra.tags || []).includes(t));
    return { position, tags };
}

function cleanNote(note) {
    return String(note || "").trim().slice(0, 500);
}

// The numbers and time of a reading, or an error saying what's wrong
function cleanValues(r, which) {
    const values = {
        taken_at: cleanTime(r.taken_at),
        systolic: cleanNumber(r.systolic), diastolic: cleanNumber(r.diastolic), pulse: cleanNumber(r.pulse),
    };
    if (values.systolic === null && values.diastolic === null && values.pulse === null) {
        throw new Error(which + " is empty.");
    }
    // A mistyped future date would sit at the top of the history forever
    if (values.taken_at > nowLocal()) {
        throw new Error(which + " has a time in the future. Check the date and time.");
    }
    return values;
}

// Save one or more readings. Readings saved together share a batch id. When a
// typed note held several readings, note_shared marks that the note covers all of
// them, so the CSV export can leave it out (it only repeats their numbers).
function addReadings(profileId, readings, extra) {
    const batch = newId();
    const { position, tags } = cleanDetails(extra);
    const note = cleanNote(extra.note);
    const cleaned = readings.map((r, i) => ({
        id: newId(), profile_id: profileId, batch,
        ...cleanValues(r, readings.length === 1 ? "The reading" : "Reading " + (i + 1)),
        position, tags, note, note_shared: readings.length > 1,
    }));
    commit((d) => d.readings.push(...cleaned));
    return {
        saved: cleaned.length,
        readings: cleaned,
        crisis: cleaned.some((r) => categorize(r.systolic, r.diastolic) === "crisis"),
    };
}

// Change a saved reading's numbers, time, position, tags and note
function updateReading(id, reading, extra) {
    if (!VALID_TIME.test(reading.taken_at || "")) throw new Error("Enter a date and time.");
    const changes = { ...cleanValues(reading, "The reading"), ...cleanDetails(extra), note: cleanNote(extra.note) };
    commit((d) => {
        const r = d.readings.find((x) => x.id === id);
        if (!r) return;
        // A note written for this reading alone is exported with it, so it leaves its batch
        if (changes.note !== r.note) {
            r.batch = newId();
            r.note_shared = false;
        }
        Object.assign(r, changes);
    });
}

// Returns what was removed, so it can be put back with undoDelete()
function deleteReading(id) {
    const index = data.readings.findIndex((r) => r.id === id);
    if (index === -1) return null;
    const removed = { reading: data.readings[index], index };
    commit((d) => d.readings.splice(index, 1));
    return removed;
}

function undoDelete(removed) {
    commit((d) => d.readings.splice(Math.min(removed.index, d.readings.length), 0, removed.reading));
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

// Stop spreadsheet apps from treating a note as a formula. Notes that already start
// with apostrophes get one more, so restoring (which removes one) gives back the original.
function csvSafe(text) {
    return /^'*[=+\-@]/.test(text) ? "'" + text : text;
}

function exportCsv(profileId) {
    const readings = readingsFor(profileId).reverse();  // oldest first
    const lines = [CSV_HEADER];
    readings.forEach((r) => {
        // A note that held several readings only repeats numbers already in the columns
        const note = r.note_shared
            ? ""
            : (r.note || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(" / ");
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

// Accepts 2026-10-03 or 10/3/2026 (how Excel may re-save it), but not 2026-13-45
function parseDate(text) {
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    const parts = iso ? [iso[1], iso[2], iso[3]] : us ? [us[3], us[1], us[2]] : null;
    if (!parts) return null;
    const [year, month, day] = parts.map(Number);
    const d = new Date(year, month - 1, day);
    return d.getMonth() === month - 1 && d.getDate() === day ? parts : null;
}

// Accepts 19:42, 19:42:00 or 7:42 PM
function parseTime(text) {
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/i.exec(text || "00:00");
    if (!m || Number(m[2]) > 59) return null;
    let hour = Number(m[1]);
    if (m[3]) {
        if (hour < 1 || hour > 12) return null;  // "13:00 PM" isn't a time
        hour = (hour % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
    }
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
        if (r.taken_at > nowLocal()) { unreadable++; return; }  // same rule as saving
        if (existing.has(sameReading(r))) { skipped++; return; }
        existing.add(sameReading(r));
        let note = cell(row, "note");
        if (/^'+[=+\-@]/.test(note)) note = note.slice(1);  // undo csvSafe()
        found.push({
            ...r, note: cleanNote(note), note_shared: false,
            ...cleanDetails({
                position: keyFor(POSITIONS, cell(row, "position")),
                tags: cell(row, "tags").split(/[;,]/).map((t) => keyFor(TAGS, t)),
            }),
        });
    });

    const added = found.map((r) => ({ id: newId(), profile_id: profileId, batch: newId(), ...r }));
    if (added.length) commit((d) => d.readings.push(...added));
    return { added: added.length, skipped, unreadable };
}
