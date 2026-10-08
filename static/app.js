const $ = (id) => document.getElementById(id);
const JSON_HEADERS = { "Content-Type": "application/json" };
const FIELDS = ["systolic", "diastolic", "pulse"];
const STATUS = { normal: "good", elevated: "warning", stage1: "serious", stage2: "critical", crisis: "critical" };
const options = { positions: POSITIONS, tags: TAGS, categories: CATEGORIES };
const DAY = 86400000;

// Words in a typed note that pre-select a tag or position (you can still change them)
const TAG_HINTS = {
    medication: /\b(meds?|medication|medicine|pills?)\b/i,
    stressed: /\b(stress|stressed|stressful|anxious|upset|tense)\b/i,
    exercise: /\b(exercis\w*|walk\w*|run|ran|running|jog\w*|gym|workout|bike|biking|swim\w*)\b/i,
    caffeine: /\b(coffee|caffeine|espresso|energy drink|tea|soda)\b/i,
};
const POSITION_HINTS = {
    sitting: /\b(sit|sitting|sat|seated)\b/i,
    standing: /\b(stand|standing|stood)\b/i,
    lying: /\b(lying|laying|lay|lie|in bed)\b/i,
};

let profileId = null;
let draft = [];
let chartData = [];
const PAGE_SIZE = 10;  // readings per page in "Recent readings"
let historyPage = 0;
let totalReadings = 0;
const CHART_RANGES = ["7", "30", "90", "all"];
let chartRange = "30";  // days shown in the trend chart
let historyFilter = "all";  // see historyFilters() in data.js
let latestReading = null;
// Taking 2 or 3 readings a minute apart. Every quick-entry reading gets a session id;
// "Take another" makes the next reading join it, and their average is shown.
const session = { id: null, count: 0, joining: false, readyAt: 0, timer: null };
const quick = { position: null, tags: new Set(), timeTouched: false };
const noteDetails = { position: null, tags: new Set() };
const editDetails = { position: null, tags: new Set() };

// Only used for reading notes, which needs app.py and Ollama on a computer
async function api(path, options) {
    const res = await fetch(path, options);
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
        const err = new Error(data.error || "Something went wrong.");
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

// Small per-device preferences (not readings)
function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* storage blocked */ }
}

function recall(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}

function forget(key) {
    try { localStorage.removeItem(key); } catch (e) { /* storage blocked */ }
}

// el("p", "muted", "Some text")
function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

function plural(n, word) {
    return n === 1 ? "1 " + word : n + " " + word + "s";
}

let statusTimer = null;
function showStatus(message, isError) {
    clearTimeout(statusTimer);
    const box = $("status");
    box.textContent = message || "";
    box.className = "status" + (isError ? " error" : "");
}

// "Saved 128/82 · pulse 71 ● Stage 1 high", cleared after a few seconds
function showSaved(readings) {
    showStatus("", false);
    const box = $("status");
    if (readings.length === 1) {
        const r = readings[0];
        box.append("Saved ", el("strong", "", bpText(r)), " ", badge(categorize(r.systolic, r.diastolic)));
    } else {
        box.textContent = "Saved " + readings.length + " readings.";
    }
    box.classList.add("saved");
    statusTimer = setTimeout(() => showStatus(""), 8000);
}

// A short message at the bottom of the screen, with an optional button like "Undo"
let toastTimer = null;
function toast(message, action, onAction) {
    clearTimeout(toastTimer);
    $("toast-text").textContent = message;
    const button = $("toast-action");
    button.hidden = !action;
    button.textContent = action || "";
    button.onclick = () => { hideToast(); onAction(); };
    $("toast").hidden = false;
    toastTimer = setTimeout(hideToast, Math.max(action ? 8000 : 5000, message.length * 60));
}

function hideToast() {
    clearTimeout(toastTimer);
    $("toast").hidden = true;
}

function savedPosition() {
    const p = recall("position");
    return p in options.positions ? p : null;
}

// ---------- Windows (dialogs) ----------
// Opens a window. submit() runs when its form is sent: it returns a result to close with,
// undefined to stay open, or throws to show an error. Resolves with the result, or null if cancelled.
function openDialog(name, submit, focusOn) {
    const dialog = $(name + "-dialog");
    $(name + "-error").textContent = "";
    dialog.showModal();
    if (focusOn) focusOn.focus();

    return new Promise((resolve) => {
        let result = null;
        $(name + "-form").onsubmit = (e) => {
            e.preventDefault();
            try {
                const value = submit();
                if (value === undefined) return;
                result = value;
                dialog.close();
            } catch (err) {
                $(name + "-error").textContent = err.message;  // e.g. the name is already taken
            }
        };
        $(name + "-cancel").onclick = () => dialog.close();
        dialog.onclick = (e) => { if (e.target === dialog) dialog.close(); };  // tap outside to cancel
        dialog.onclose = () => resolve(result);  // also runs when Escape is pressed
    });
}

// A yes/no question. With typeToConfirm, that word has to be typed first.
// Resolves with true, or null if cancelled.
function ask({ title, message, button, danger, typeToConfirm }) {
    $("ask-title").textContent = title;
    $("ask-message").textContent = message;
    $("ask-ok").textContent = button;
    $("ask-ok").classList.toggle("destructive", !!danger);
    $("ask-type").hidden = !typeToConfirm;
    $("ask-type-text").textContent = typeToConfirm ? "Type " + typeToConfirm + " to confirm" : "";
    $("ask-input").value = "";
    return openDialog("ask", () => {
        if (typeToConfirm && $("ask-input").value.trim().toLowerCase() !== typeToConfirm.toLowerCase()) {
            throw new Error("Type " + typeToConfirm + " to confirm.");
        }
        return true;
    }, typeToConfirm ? $("ask-input") : $("ask-ok"));
}

// "These numbers look unusual" with Fix it / Save anyway, shown above the save button
function showCheck(box, problems, saveAnyway, fixField) {
    const list = el("ul");
    problems.forEach((p) => list.appendChild(el("li", "", p[0].toUpperCase() + p.slice(1))));
    const fix = el("button", "primary compact", "Fix it");
    fix.type = "button";
    fix.onclick = () => { box.hidden = true; fixField.focus(); };
    const anyway = el("button", "compact", "Save anyway");
    anyway.type = "button";
    anyway.onclick = () => { box.hidden = true; saveAnyway(); };
    const actions = el("div", "actions");
    actions.append(fix, anyway);
    box.replaceChildren(el("strong", "", "These numbers look unusual:"), list, actions);
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- People ----------
function renderProfiles() {
    const profiles = listProfiles();
    const sel = $("profile");
    sel.replaceChildren();
    profiles.forEach((p) => {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name;
        sel.appendChild(o);
    });

    const saved = recall("profileId");
    if (profiles.some((p) => p.id === saved)) sel.value = saved;

    profileId = sel.value || null;
    const hasPerson = profileId !== null;
    $("who").hidden = !hasPerson;
    $("no-profile").hidden = hasPerson;
    $("person-view").hidden = !hasPerson;
    if (hasPerson) loadAll(true);
}

// Adding a person asks only for a name; editing also offers the target and Delete
function setPersonDialog(title, button, name, message, editing) {
    $("person-title").textContent = title;
    $("person-ok").textContent = button;
    $("person-name").value = name || "";
    $("person-message").textContent = message || "";
    $("person-message").hidden = !message;
    $("person-target").hidden = !editing;
    $("person-remove").hidden = !editing;
    $("person-delete").textContent = "Delete " + name + "…";
}

// Shows the "Add a person" window. Resolves with the new person, or null if cancelled.
async function openPersonDialog(suggestedName, message) {
    setPersonDialog("Add a person", "Add person", suggestedName, message || "Whose readings are these?", false);
    const added = await openDialog("person", () => addProfile($("person-name").value), $("person-name"));
    if (added) {
        store("profileId", added.id);
        renderProfiles();
    }
    return added;
}

// Rename, set or clear the doctor's target, or delete. focusTarget starts at the target.
async function editPerson(focusTarget) {
    const before = profileName(profileId);
    const target = targetFor(profileId);
    setPersonDialog("Edit person", "Save", before, "", true);
    $("target-systolic").value = target ? target.systolic : "";
    $("target-diastolic").value = target ? target.diastolic : "";
    let remove = false;
    $("person-delete").onclick = () => { remove = true; $("person-dialog").close(); };
    const number = (id) => ($(id).value === "" ? null : parseInt($(id).value, 10));
    const saved = await openDialog("person", () => {
        const newTarget = cleanTarget(number("target-systolic"), number("target-diastolic"));  // checked first
        const name = renameProfile(profileId, $("person-name").value);
        setTarget(profileId, newTarget);
        return name;
    }, focusTarget === true ? $("target-systolic") : $("person-name"));
    if (saved) {
        renderProfiles();
        toast(saved !== before ? "Renamed to " + saved + "." : "Saved.");
    }
    if (remove) await deletePerson();
}

async function deletePerson() {
    const name = profileName(profileId);
    const count = readingsFor(profileId).length;
    const sure = await ask({
        title: "Delete " + name + "?",
        message: "This deletes " + name + " and " + plural(count, "reading") + " from this device, and it "
            + "can't be undone. If you might want them later, export a CSV first.",
        button: "Delete",
        danger: true,
        typeToConfirm: name,
    });
    if (!sure) return;
    try {
        deleteProfile(profileId);
    } catch (e) {
        toast(e.message);
        return;
    }
    ["lastExport:", "backupSnooze:"].forEach((key) => forget(key + profileId));
    forget("profileId");
    cancelDraft();
    $("crisis").hidden = true;
    renderProfiles();
    toast("Deleted " + name + ".");
}

// ---------- Position and tags ----------
function renderDetails(box, state) {
    box.replaceChildren();
    [["Position", options.positions, false], ["Tags", options.tags, true]].forEach(([title, choices, multi]) => {
        const label = document.createElement("div");
        label.className = "chip-label";
        label.textContent = title + (multi ? " (tap all that apply)" : "");
        const row = document.createElement("div");
        row.className = "chips";
        row.setAttribute("role", "group");
        row.setAttribute("aria-label", title);

        const isOn = (key) => multi ? state.tags.has(key) : state.position === key;
        const sync = () => row.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", isOn(b.dataset.key)));
        Object.entries(choices).forEach(([key, text]) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "chip";
            b.dataset.key = key;
            b.textContent = text;
            b.onclick = () => {
                if (multi) {
                    if (state.tags.has(key)) state.tags.delete(key); else state.tags.add(key);
                } else {
                    state.position = isOn(key) ? null : key;  // tap again to clear
                }
                sync();
            };
            row.appendChild(b);
        });
        sync();
        box.append(label, row);
    });
}

function detailsOf(state) {
    return { position: state.position, tags: [...state.tags] };
}

// The unusual-looking numbers in some readings, numbered when there's more than one
function problemsIn(readings) {
    const problems = [];
    readings.forEach((r, i) => looksPlausible(r).forEach((p) => {
        problems.push(readings.length > 1 ? "Reading " + (i + 1) + ": " + p : p);
    }));
    return problems;
}

// ---------- Saving (shared by both ways of logging) ----------
function saveReadings(readings, extra, showError) {
    try {
        return addReadings(profileId, readings, extra);
    } catch (e) {
        showError(e.message);
        return null;
    }
}

function afterSave(result, position) {
    if (position) store("position", position);
    showSaved(result.readings);
    $("crisis").hidden = !result.crisis;
    if (result.crisis) $("crisis").scrollIntoView({ behavior: "smooth", block: "start" });
    loadAll(true);  // back to the newest readings
}

// ---------- Measurement session: 2 or 3 readings a minute apart ----------
// After a quick-entry save: the average so far, and an offer to take another
function offerSession(saved) {
    const box = $("status");
    const sessions = sessionAverages(readingsFor(profileId));
    const avg = sessions[session.id];
    if (avg && avg.systolic !== null && avg.diastolic !== null) {
        box.append(el("span", "session-avg", "Average of " + avg.count + ": "),
            el("strong", "", avg.systolic + "/" + avg.diastolic), " ", badge(avg.category));
    }
    const hasBoth = saved.systolic !== null && saved.diastolic !== null;
    if (hasBoth && session.count < 3) {
        const another = el("button", "compact", session.count === 1 ? "Take another in 1 minute" : "Take a third in 1 minute");
        another.type = "button";
        another.onclick = startSessionWait;
        box.append(another);
    }
    clearTimeout(statusTimer);  // keep the offer and average on screen until the next action
}

function startSessionWait() {
    session.joining = true;
    session.readyAt = Date.now() + 60000;
    showStatus("", false);
    $("session").hidden = false;
    sessionTick();
    clearInterval(session.timer);
    session.timer = setInterval(sessionTick, 1000);
}

function sessionTick() {
    const left = Math.ceil((session.readyAt - Date.now()) / 1000);
    if (left > 0) {
        $("session-text").textContent = "Sit still and relax. Reading " + (session.count + 1) + " in 0:"
            + String(left).padStart(2, "0") + ".";
        return;
    }
    stopSessionWait(false);
    showStatus("Time for reading " + (session.count + 1) + ". Take it now, then enter the numbers above.", false);
    $("q-systolic").focus();
}

// Hides the countdown. end: the next reading starts a new session.
function stopSessionWait(end) {
    clearInterval(session.timer);
    session.timer = null;
    $("session").hidden = true;
    if (end) session.joining = false;
}

// ---------- Quick entry ----------
function resetQuickTime() {
    quick.timeTouched = false;
    $("q-when").value = nowLocal();
    $("q-when").max = nowLocal();
}

function saveQuick(force) {
    const reading = {};
    FIELDS.forEach((key) => {
        const v = $("q-" + key).value;
        reading[key] = v === "" ? null : parseInt(v, 10);
    });
    if (FIELDS.every((key) => reading[key] === null)) {
        showStatus("Enter at least one number.", true);
        return;
    }
    // An untouched time means "now"
    reading.taken_at = quick.timeTouched ? $("q-when").value : null;

    const problems = problemsIn([reading]);
    if (problems.length && force !== true) {
        showStatus("", false);
        showCheck($("q-check"), problems, () => saveQuick(true), $("q-systolic"));
        return;
    }
    $("q-check").hidden = true;
    const sessionId = session.joining ? session.id : newId();
    const result = saveReadings([reading], { note: $("q-note").value, session: sessionId, ...detailsOf(quick) },
        (message) => showStatus(message, true));
    if (!result) return;
    session.count = session.joining ? session.count + 1 : 1;
    session.id = sessionId;
    stopSessionWait(true);
    FIELDS.forEach((key) => { $("q-" + key).value = ""; });
    $("q-note").value = "";
    quick.tags.clear();  // the position is kept for next time; tags are per reading
    renderDetails($("q-details"), quick);
    resetQuickTime();
    afterSave(result, quick.position);
    offerSession(result.readings[0]);
}

function setMode(mode) {
    $("quick-mode").hidden = mode !== "quick";
    $("note-mode").hidden = mode !== "note";
    $("tab-quick").setAttribute("aria-selected", mode === "quick");
    $("tab-note").setAttribute("aria-selected", mode === "note");
    if (mode === "quick") cancelDraft();
    stopSessionWait(true);
    showStatus("", false);
    store("mode", mode);
}

// The note tab only shows when app.py is running with Ollama (not on the website)
async function checkNotes() {
    let available = false;
    try {
        available = !!(await api("/api/status")).notes;
    } catch (e) { /* no server: hosted as a plain website */ }
    $("tabs").hidden = !available;
    setMode(available && recall("mode") === "note" ? "note" : "quick");
}

// ---------- Reading a note ----------
async function readNote() {
    const note = $("note").value.trim();
    if (!note) { showStatus("Type a reading first.", true); return; }

    $("read").disabled = true;
    showStatus("Reading your note... this can take a few seconds.", false);
    try {
        const data = await api("/api/parse", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ note }) });
        const when = nowLocal();
        draft = data.readings.map((r) => ({
            systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse,
            problems: r.problems || [], taken_at: when,
        }));
        noteDetails.tags = new Set(Object.keys(options.tags).filter((k) => TAG_HINTS[k] && TAG_HINTS[k].test(note)));
        noteDetails.position = Object.keys(options.positions).find((k) => POSITION_HINTS[k] && POSITION_HINTS[k].test(note))
            || savedPosition();
        renderDetails($("n-details"), noteDetails);
        showStatus("", false);
        renderDraft();
    } catch (e) {
        showStatus(e.message, true);
    } finally {
        $("read").disabled = false;
    }
}

function rowEl(r, i) {
    const wrap = document.createElement("div");
    wrap.className = "row";

    const head = document.createElement("div");
    head.className = "row-head";
    const title = document.createElement("strong");
    title.textContent = "Reading " + (i + 1);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link danger";
    remove.textContent = "Remove";
    remove.onclick = () => { draft.splice(i, 1); renderDraft(); };
    head.append(title, remove);

    const warn = document.createElement("p");
    warn.className = "warn";
    warn.hidden = r.problems.length === 0;
    warn.textContent = r.problems.length ? "Please double-check: " + r.problems.join(", ") + "." : "";

    const grid = document.createElement("div");
    grid.className = "grid";
    [["systolic", "Top (systolic)"], ["diastolic", "Bottom (diastolic)"], ["pulse", "Pulse"]].forEach(([key, label]) => {
        const l = document.createElement("label");
        l.textContent = label;
        const inp = document.createElement("input");
        inp.type = "number";
        inp.inputMode = "numeric";
        inp.step = "1";
        inp.min = "0";
        inp.value = r[key] === null || r[key] === undefined ? "" : r[key];
        inp.oninput = () => {
            r[key] = inp.value === "" ? null : parseInt(inp.value, 10);
            warn.hidden = true;  // checked again when you save
        };
        l.appendChild(inp);
        grid.appendChild(l);
    });

    const whenLabel = document.createElement("label");
    whenLabel.textContent = "When";
    const when = document.createElement("input");
    when.type = "datetime-local";
    when.value = r.taken_at;
    when.max = nowLocal();
    when.oninput = () => { r.taken_at = when.value; };
    whenLabel.appendChild(when);

    wrap.append(head, grid, whenLabel, warn);
    return wrap;
}

function renderDraft() {
    const box = $("rows");
    box.replaceChildren();
    draft.forEach((r, i) => box.appendChild(rowEl(r, i)));
    $("empty-msg").hidden = draft.length > 0;
    $("save").disabled = draft.length === 0;
    $("n-check").hidden = true;
    $("n-error").textContent = "";
    $("confirm").hidden = false;
    $("confirm").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelDraft() {
    draft = [];
    $("confirm").hidden = true;
}

function saveDraft(force) {
    const readings = draft.map((r) => ({ systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse, taken_at: r.taken_at }));
    const problems = problemsIn(readings);
    if (problems.length && force !== true) {
        showCheck($("n-check"), problems, () => saveDraft(true), $("rows").querySelector("input") || $("save"));
        return;
    }
    $("n-check").hidden = true;
    $("n-error").textContent = "";
    const result = saveReadings(readings, { note: $("note").value.trim(), ...detailsOf(noteDetails) },
        (message) => { $("n-error").textContent = message; });
    if (!result) return;
    $("note").value = "";
    cancelDraft();
    afterSave(result, noteDetails.position);
}

// ---------- Shared display helpers ----------
function bpText(r) {
    const parts = [];
    if (r.systolic !== null || r.diastolic !== null) {
        parts.push((r.systolic ?? "?") + "/" + (r.diastolic ?? "?"));
    }
    if (r.pulse !== null) parts.push("pulse " + r.pulse);
    return parts.join(" · ");
}

function whenText(iso) {
    return new Date(iso).toLocaleString([], {
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
}

function badge(category) {
    const span = document.createElement("span");
    span.className = "badge" + (category === "crisis" ? " crisis-badge" : "");
    if (!category) { span.hidden = true; return span; }
    const dot = document.createElement("span");
    dot.className = "dot " + STATUS[category];
    dot.setAttribute("aria-hidden", "true");
    span.append(dot, (category === "crisis" ? "⚠ " : "") + options.categories[category]);
    return span;
}

// ---------- Showing everything for a person ----------
function loadAll(resetPage) {
    if (resetPage) historyPage = 0;
    const readings = readingsFor(profileId);
    totalReadings = readings.length;
    latestReading = readings[0] || null;
    renderLatest();
    renderStats(statsFor(profileId));
    renderTarget(readings);
    renderTrend(readings);
    $("export").hidden = totalReadings === 0;
    $("report-card").hidden = totalReadings === 0;
    renderBackupNudge();
    renderInstall();
    loadHistory(readings);
}

// "Latest: 128/82 · pulse 71 ● Stage 1 high · 2 hours ago" above the form
function renderLatest() {
    const box = $("latest");
    box.hidden = !latestReading;
    if (!latestReading) return;
    const r = latestReading;
    box.replaceChildren(el("span", "", "Latest"), el("strong", "", bpText(r)), badge(r.category),
        el("span", "muted", agoText(r.taken_at)));
}

// "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", then the date
function agoText(iso) {
    const minutes = Math.round((Date.now() - new Date(iso)) / 60000);
    if (minutes < 1) return "just now";
    const say = new Intl.RelativeTimeFormat([], { numeric: "auto" });
    if (minutes < 60) return say.format(-minutes, "minute");
    if (minutes < 12 * 60) return say.format(-Math.round(minutes / 60), "hour");
    const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / DAY);
    if (days === 0) return say.format(-Math.round(minutes / 60), "hour");
    return days <= 30 ? say.format(-days, "day") : whenText(iso);
}

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// "Today", "Yesterday" or "Mon, Oct 5" (with the year when it's not this year)
function dayText(iso) {
    const d = new Date(iso);
    const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    const opts = { weekday: "short", month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString([], opts);
}

// Under the averages: how the last 30 days compare with the doctor's target,
// or a way to add one
function renderTarget(readings) {
    const box = $("target-line");
    const target = targetFor(profileId);
    const change = el("button", "link", target ? "Change target" : "Add a target from your doctor");
    change.type = "button";
    change.onclick = () => editPerson(true);
    if (!target) { box.replaceChildren(change); return; }

    const goal = "under " + target.systolic + "/" + target.diastolic;
    const recent = readings.filter((r) => r.taken_at >= toLocalIso(Date.now() - 30 * DAY));
    const stats = targetStats(recent, target);
    box.replaceChildren(stats.count
        ? el("span", "", "On target (" + goal + "): " + stats.onTarget + " of " + plural(stats.count, "reading")
            + " in the last 30 days (" + stats.percent + "%). ")
        : el("span", "", "Target: " + goal + ". No readings in the last 30 days yet. "), change);
}

// The trend chart for the chosen time range. readings are newest first.
function renderTrend(readings) {
    const days = chartRange === "all" ? null : Number(chartRange);
    const since = days ? toLocalIso(Date.now() - days * DAY) : "";
    chartData = readings.filter((r) => r.taken_at >= since).reverse();  // oldest first
    $("range").hidden = readings.length < 2;
    $("range").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.days === chartRange));
    const empty = $("chart-empty");
    empty.hidden = chartData.length >= 2;
    empty.textContent = readings.length < 2 ? "Save at least two readings to see a trend."
        : chartData.length === 0 ? "No readings in the last " + days + " days. Choose a longer time above."
            : "Only one reading in the last " + days + " days. Choose a longer time above to see a trend.";
    const target = targetFor(profileId);
    $("ref-label").textContent = target ? "Target under " + target.systolic + "/" + target.diastolic : "High from 130/80";
    $("chart-caption").textContent = "Oldest on the left. "
        + (target ? "Dashed lines mark the target from the doctor, " + target.systolic + " and " + target.diastolic + ". "
            : "Dashed lines mark 130 and 80, where the high range starts. ")
        + "Tap or hover to see a reading.";
    renderChart();
}

// The history list for the chosen filter. readings are newest first.
function loadHistory(readings) {
    const all = readings || readingsFor(profileId);
    const shown = filterReadings(all, historyFilter);
    const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
    historyPage = Math.min(historyPage, pages - 1);  // e.g. after deleting the last reading on a page
    const first = historyPage * PAGE_SIZE;
    const page = shown.slice(first, first + PAGE_SIZE);
    renderHistory(page, sessionAverages(all));
    $("filter-wrap").hidden = all.length < 2 && historyFilter === "all";
    $("recent-empty").textContent = all.length ? "No readings match. Choose another filter above." : "Nothing saved yet.";
    $("pager").hidden = shown.length <= PAGE_SIZE;
    $("page-info").textContent = (first + 1) + "–" + (first + page.length) + " of " + shown.length;
    $("newer").disabled = historyPage === 0;
    $("older").disabled = historyPage >= pages - 1;

    // With a filter on, its average, to compare (e.g. readings after caffeine)
    const summary = $("filter-summary");
    summary.hidden = historyFilter === "all" || shown.length === 0;
    if (!summary.hidden) {
        const avg = averagesFor(shown, null);
        const value = avg.systolic !== null && avg.diastolic !== null ? avg.systolic + "/" + avg.diastolic : "—";
        summary.replaceChildren("Average of these " + plural(shown.length, "reading") + ": ",
            el("strong", "", value + (avg.pulse !== null ? " · pulse " + avg.pulse : "")), " ", badge(avg.category));
    }
}

function turnPage(step) {
    historyPage += step;
    loadHistory();
    $("history").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderStats(periods) {
    const box = $("stats");
    box.replaceChildren();
    periods.forEach((p) => {
        const tile = document.createElement("div");
        tile.className = "tile";
        const label = document.createElement("div");
        label.className = "muted";
        label.textContent = p.label;
        const value = document.createElement("div");
        value.className = "value";
        value.textContent = p.systolic !== null && p.diastolic !== null ? p.systolic + "/" + p.diastolic : "—";
        const pulse = document.createElement("div");
        pulse.textContent = p.pulse !== null ? "pulse " + p.pulse : "";
        const count = document.createElement("div");
        count.className = "muted";
        count.textContent = plural(p.count, "reading");
        tile.append(label, value, pulse, badge(p.category), count);
        box.appendChild(tile);
    });
}

// sessions: from sessionAverages(), to show "Reading 2 of 3 · average 126/81"
function renderHistory(readings, sessions) {
    const ul = $("recent");
    ul.replaceChildren();
    $("recent-empty").hidden = readings.length > 0;
    let lastDay = null;
    readings.forEach((r) => {
        const day = dayText(r.taken_at);
        if (day !== lastDay) {
            ul.appendChild(el("li", "day-head", day));
            lastDay = day;
        }
        const li = document.createElement("li");
        const text = document.createElement("div");
        const line = document.createElement("div");
        line.className = "reading-line";
        const main = document.createElement("span");
        main.className = "big";
        main.textContent = bpText(r);
        line.append(main, badge(r.category));

        const extra = [new Date(r.taken_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })];
        if (r.position && options.positions[r.position]) extra.push(options.positions[r.position]);
        const tags = r.tags.filter((t) => options.tags[t]).map((t) => options.tags[t]);
        if (tags.length) extra.push(tags.join(", "));
        const when = document.createElement("div");
        when.className = "muted";
        when.textContent = extra.join(" · ");
        text.append(line, when);
        const session = r.session && sessions[r.session];
        if (session) {
            const avg = session.systolic !== null && session.diastolic !== null
                ? "average " + session.systolic + "/" + session.diastolic : "";
            text.appendChild(el("div", "session-line", "Reading " + (session.ids.indexOf(r.id) + 1) + " of "
                + session.ids.length + (avg ? " · " + avg : "")));
        }
        if (r.note) text.appendChild(el("div", "note", r.note));

        const edit = el("button", "link", "Edit");
        edit.type = "button";
        edit.setAttribute("aria-label", "Edit " + bpText(r) + ", " + whenText(r.taken_at));
        edit.onclick = () => editReading(r);
        const del = el("button", "link danger", "Delete");
        del.type = "button";
        del.setAttribute("aria-label", "Delete " + bpText(r) + ", " + whenText(r.taken_at));
        del.onclick = () => removeReading(r);
        const actions = el("div", "row-actions");
        actions.append(edit, del);
        li.append(text, actions);
        ul.appendChild(li);
    });
}

// Deletes straight away, with a few seconds to undo
function removeReading(r) {
    let removed;
    try {
        removed = deleteReading(r.id);
    } catch (e) {
        toast(e.message);
        return;
    }
    loadAll();
    if (!removed) return;
    toast("Deleted " + bpText(r) + ".", "Undo", () => {
        try {
            undoDelete(removed);
            loadAll();
        } catch (e) { toast(e.message); }
    });
}

async function editReading(r) {
    FIELDS.forEach((key) => { $("e-" + key).value = r[key] ?? ""; });
    $("e-when").value = r.taken_at;
    $("e-when").max = nowLocal();
    $("e-note").value = r.note || "";
    editDetails.position = r.position;
    editDetails.tags = new Set(r.tags);
    renderDetails($("e-details"), editDetails);
    $("e-check").hidden = true;

    let force = false;
    const saved = await openDialog("edit", () => {
        const reading = { taken_at: $("e-when").value };
        FIELDS.forEach((key) => {
            const v = $("e-" + key).value;
            reading[key] = v === "" ? null : parseInt(v, 10);
        });
        const problems = problemsIn([reading]);
        if (problems.length && !force) {
            showCheck($("e-check"), problems, () => { force = true; $("edit-form").requestSubmit(); }, $("e-systolic"));
            return undefined;
        }
        try {
            updateReading(r.id, reading, { note: $("e-note").value, ...detailsOf(editDetails) });
        } finally {
            force = false;
        }
        return true;
    }, $("e-systolic"));
    if (saved) {
        loadAll();
        toast("Reading updated.");
    }
}

// ---------- Backup reminder ----------
// Shown once there's a fair amount to lose and no recent export
function renderBackupNudge() {
    const last = recall("lastExport:" + profileId);
    const snoozedUntil = recall("backupSnooze:" + profileId);
    const days = last ? Math.floor((Date.now() - new Date(last)) / DAY) : null;
    const due = totalReadings >= 10 && (days === null || days >= 30) && !(snoozedUntil && snoozedUntil > nowLocal());
    $("backup-nudge").hidden = !due;
    if (!due) return;
    $("backup-text").textContent = (days === null
        ? "These " + totalReadings + " readings are only saved in this browser, and there's no copy yet."
        : "The last export was " + days + " days ago.")
        + " Clearing the browser's data would delete them. Export a CSV file and keep it somewhere safe.";
}

function snoozeBackup() {
    store("backupSnooze:" + profileId, toLocalIso(Date.now() + 7 * DAY));
    $("backup-nudge").hidden = true;
}

// ---------- Doctor report (printed, or saved as PDF from the print window) ----------
function dateText(iso) {
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function tableEl(headers, rows) {
    const table = el("table");
    const head = el("tr");
    headers.forEach((h) => head.appendChild(el("th", "", h)));
    const thead = el("thead");
    thead.appendChild(head);
    const tbody = el("tbody");
    rows.forEach((cells) => {
        const tr = el("tr");
        cells.forEach((c) => {
            const td = el("td");
            td.append(c === null || c === undefined ? "" : c);
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    return table;
}

function buildReport(days) {
    const rep = reportFor(profileId, days);
    const box = $("report");
    box.replaceChildren();
    if (!rep.readings.length) return false;

    const bp = (r) => (r.systolic !== null || r.diastolic !== null ? (r.systolic ?? "?") + "/" + (r.diastolic ?? "?") : "");
    box.append(
        el("h1", "", "Blood pressure and pulse log"),
        el("p", "report-meta", profileName(profileId) + " · " + dateText(rep.from) + " to " + dateText(rep.to)
            + " · " + plural(rep.readings.length, "reading") + " · Printed " + dateText(nowLocal())),
        el("h2", "", "Averages"),
        tableEl(["", "Readings", "Average", "Pulse", "Category"], rep.periods.map((p) => [
            p.label, p.count,
            p.systolic !== null && p.diastolic !== null ? p.systolic + "/" + p.diastolic : "—",
            p.pulse ?? "—",
            p.category ? badge(p.category) : "",
        ])),
    );
    const notes = [];
    if (rep.highest) notes.push("Highest: " + bp(rep.highest) + " on " + whenText(rep.highest.taken_at));
    if (rep.lowest) notes.push("Lowest: " + bp(rep.lowest) + " on " + whenText(rep.lowest.taken_at));
    notes.push(Object.keys(CATEGORIES).filter((c) => rep.counts[c])
        .map((c) => CATEGORIES[c] + ": " + rep.counts[c]).join(" · "));
    if (rep.target && rep.targetStats.count) {
        notes.push("Target from the doctor: under " + rep.target.systolic + "/" + rep.target.diastolic + ". On target: "
            + rep.targetStats.onTarget + " of " + plural(rep.targetStats.count, "reading") + " (" + rep.targetStats.percent + "%)");
    }
    notes.forEach((n) => box.appendChild(el("p", "report-line", n)));

    if (rep.readings.length >= 2) {
        box.appendChild(el("h2", "", "Trend"));
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "chart report-chart");
        box.appendChild(svg);
        drawChart(svg, rep.readings, 680, rep.target);
        box.appendChild(el("p", "report-line", "Blue: systolic · Orange: diastolic · Green: pulse · Dashed lines: "
            + (rep.target ? "the target, " + rep.target.systolic + " and " + rep.target.diastolic
                : "130 and 80, where the high range starts")));
    }

    box.append(
        el("h2", "", "All readings"),
        tableEl(["Date", "Time", "Blood pressure", "Pulse", "Category", "Position", "Tags", "Note"],
            rep.readings.map((r) => [
                dateText(r.taken_at),
                new Date(r.taken_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
                bp(r), r.pulse,
                r.category ? CATEGORIES[r.category] : "",
                POSITIONS[r.position] || "",
                r.tags.map((t) => TAGS[t]).filter(Boolean).join(", "),
                r.note_shared ? "" : r.note,  // a note typed with several readings only repeats their numbers
            ])),
        el("h2", "", "How readings are categorized"),
        tableEl(["Category (American Heart Association, 2025)", "Top (systolic)", "", "Bottom (diastolic)"], CATEGORY_RANGES),
        el("p", "report-line", "When the two numbers fall in different categories, the higher category is used. "
            + "A reading needs both numbers to get a category."),
        el("p", "report-foot", "Categories use general American Heart Association ranges for adults; the "
            + "doctor may set different targets. Logged at home with Pulse & Pressure. This is a log, not a diagnosis."),
    );
    return true;
}

function printReport() {
    const choice = $("report-days").value;
    if (!buildReport(choice === "all" ? null : Number(choice))) {
        toast("There are no readings in that period. Choose a longer one.");
        return;
    }
    window.print();
}

// ---------- Installing to the home screen ----------
// Android (Chrome, Edge, Samsung Internet) offers an install prompt we can trigger;
// iPhone and iPad only install from the Share menu, so they get instructions instead.
let installPrompt = null;
const isApple = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);  // iPads report as a Mac

function isInstalled() {
    return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function renderInstall() {
    const snoozedUntil = recall("installSnooze");
    const show = profileId !== null && !isInstalled() && (installPrompt !== null || isApple)
        && !(snoozedUntil && snoozedUntil > nowLocal());
    $("install").hidden = !show;
    if (!show) return;
    $("install-go").hidden = installPrompt === null;
    $("install-text").replaceChildren(...(installPrompt
        ? ["Install Pulse & Pressure to open it like any other app, even without a connection."]
        : ["Tap the Share button ", el("span", "", "(the square with an arrow)"), ", then ",
            el("strong", "", "Add to Home Screen"), ". It then opens like an app, works without a connection, "
            + "and Safari won't clear your readings after a week without a visit."]));
    $("install-move").hidden = installPrompt !== null || totalReadings === 0;
}

async function install() {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;  // a prompt can only be used once
    renderInstall();
}

// ---------- Export and restore ----------
function downloadCsv() {
    const blob = new Blob([exportCsv(profileId)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName(profileId);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    store("lastExport:" + profileId, nowLocal());
    $("backup-nudge").hidden = true;
    toast("Downloaded " + a.download + ". Keep it somewhere safe.");
}

// "pulse-pressure-Nicholas-2026-10-03 (2).csv" -> "Nicholas"
function nameFromFile(fileName) {
    const m = /^pulse-pressure-(.+?)-\d{4}-\d{2}-\d{2}/.exec(fileName);
    return m ? m[1].replace(/-/g, " ") : "";
}

async function restoreFile(file) {
    let text;
    try {
        text = await file.text();
    } catch (e) {
        toast("Couldn't open that file.");
        return;
    }
    const fileName = nameFromFile(file.name);
    if (profileId === null
        && !(await openPersonDialog(fileName, "Whose readings are in " + file.name + "?"))) return;
    const who = profileName(profileId);
    if (fileName && fileName.toLowerCase() !== who.toLowerCase()
        && !(await ask({
            title: "Add them to " + who + "?",
            message: "This file looks like " + fileName + "'s readings.",
            button: "Add to " + who,
        }))) {
        return;
    }
    try {
        const { added, skipped, unreadable } = importCsv(profileId, text);
        const lines = ["Restored " + plural(added, "reading") + " for " + who + "."];
        if (skipped) lines.push(skipped + (skipped === 1 ? " was" : " were") + " already on this device.");
        if (unreadable) lines.push(plural(unreadable, "row") + " couldn't be read and " + (unreadable === 1 ? "was" : "were") + " skipped.");
        loadAll(true);
        toast(lines.join("\n"));
    } catch (e) {
        toast(e.message);
    }
}

// ---------- Wire it up ----------
$("tab-quick").onclick = () => setMode("quick");
$("tab-note").onclick = () => setMode("note");
$("q-save").onclick = () => saveQuick();
// Enter moves top → bottom → pulse, then saves (from the pulse or the note)
const NEXT_FIELD = { systolic: "diastolic", diastolic: "pulse" };
FIELDS.concat("note").forEach((key) => {
    $("q-" + key).onkeydown = (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (NEXT_FIELD[key]) $("q-" + NEXT_FIELD[key]).focus(); else saveQuick();
    };
});
// Jump to the next box as soon as a number is clearly complete: "128" or "95" for the
// top, "82" for the bottom. Two digits that could still grow ("12" toward 128) wait.
const COMPLETE_AT = { systolic: 30, diastolic: 16 };
Object.entries(COMPLETE_AT).forEach(([key, twoDigitMin]) => {
    $("q-" + key).addEventListener("input", (e) => {
        if (e.inputType && !e.inputType.startsWith("insert")) return;  // not while deleting
        const v = $("q-" + key).value;
        if (v.length >= 3 || (v.length === 2 && Number(v) >= twoDigitMin)) $("q-" + NEXT_FIELD[key]).focus();
    });
});
$("q-when").oninput = () => { quick.timeTouched = true; };
$("quick-mode").addEventListener("input", () => { $("q-check").hidden = true; });  // numbers changed: check again on save
$("read").onclick = readNote;
$("save").onclick = () => saveDraft();
$("cancel").onclick = cancelDraft;
$("rows").addEventListener("input", () => { $("n-check").hidden = true; });
$("edit-form").addEventListener("input", () => { $("e-check").hidden = true; });
$("add-row").onclick = () => {
    draft.push({ systolic: null, diastolic: null, pulse: null, problems: [], taken_at: nowLocal() });
    renderDraft();
};
$("crisis-close").onclick = () => { $("crisis").hidden = true; };
$("add-profile").onclick = () => openPersonDialog();
$("edit-profile").onclick = () => editPerson();
$("welcome-form").onsubmit = (e) => {
    e.preventDefault();
    try {
        const added = addProfile($("welcome-name").value);
        store("profileId", added.id);
        $("welcome-name").value = "";
        $("welcome-error").textContent = "";
        renderProfiles();
        $("q-systolic").focus();
    } catch (err) {
        $("welcome-error").textContent = err.message;
    }
};
$("profile").onchange = () => {
    profileId = $("profile").value;
    store("profileId", profileId);
    cancelDraft();
    stopSessionWait(true);
    showStatus("", false);
    $("q-check").hidden = true;
    $("crisis").hidden = true;
    historyFilter = "all";
    $("history-filter").value = "all";
    loadAll(true);
};
$("session-skip").onclick = () => {
    session.readyAt = Date.now();
    sessionTick();
};
$("session-stop").onclick = () => stopSessionWait(true);
$("history-filter").onchange = () => {
    historyFilter = $("history-filter").value;
    historyPage = 0;
    loadHistory();
};
$("range").onclick = (e) => {
    const button = e.target.closest("button");
    if (!button) return;
    chartRange = button.dataset.days;
    store("chartRange", chartRange);
    renderTrend(readingsFor(profileId));
};
$("newer").onclick = () => turnPage(-1);
$("older").onclick = () => turnPage(1);
$("export").onclick = downloadCsv;
$("nudge-export").onclick = downloadCsv;
$("nudge-later").onclick = snoozeBackup;
document.querySelectorAll(".restore").forEach((b) => { b.onclick = () => $("restore-file").click(); });
$("restore-file").onchange = async () => {
    const file = $("restore-file").files[0];
    $("restore-file").value = "";  // so picking the same file again still works
    if (file) await restoreFile(file);
};
$("report-go").onclick = printReport;
$("install-go").onclick = install;
$("install-later").onclick = () => {
    store("installSnooze", toLocalIso(Date.now() + 30 * DAY));
    renderInstall();
};
window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();  // show our own Install button instead of the browser's banner
    installPrompt = e;
    renderInstall();
});
window.addEventListener("appinstalled", () => {
    installPrompt = null;
    renderInstall();
});
window.addEventListener("resize", renderChart);
// Keep the quick-entry time current while the page sits open
setInterval(() => {
    $("q-when").max = nowLocal();
    if (!quick.timeTouched) $("q-when").value = nowLocal();
    renderLatest();  // "5 minutes ago" keeps counting
}, 30000);

function start() {
    try {
        loadData();
    } catch (e) {
        $("storage-error").textContent = e.message;
        $("storage-error").hidden = false;
        return;
    }
    askToKeepData();
    // Works offline and installs to the home screen. Browsers only allow this on
    // https or localhost, so it's skipped on a home-network address like 192.168.x.x.
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
    quick.position = savedPosition();
    if (CHART_RANGES.includes(recall("chartRange"))) chartRange = recall("chartRange");
    historyFilters().forEach(([value, label]) => {
        const o = el("option", "", label);
        o.value = value;
        $("history-filter").appendChild(o);
    });
    renderDetails($("q-details"), quick);
    resetQuickTime();
    setMode("quick");
    checkNotes();
    renderProfiles();
}

start();
