const $ = (id) => document.getElementById(id);
const JSON_HEADERS = { "Content-Type": "application/json" };
const FIELDS = ["systolic", "diastolic", "pulse"];
const STATUS = { normal: "good", elevated: "warning", stage1: "serious", stage2: "critical", crisis: "critical" };

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

let options = { positions: {}, tags: {}, categories: {} };
let profileId = null;
let draft = [];
let chartData = [];
const PAGE_SIZE = 10;  // readings per page in "Recent readings"
let historyPage = 0;
let totalReadings = 0;
const quick = { position: null, tags: new Set(), timeTouched: false };
const noteDetails = { position: null, tags: new Set() };

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

function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* storage blocked */ }
}

function recall(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}

function showStatus(message, isError) {
    const el = $("status");
    el.textContent = message || "";
    el.className = "status" + (isError ? " error" : "");
}

function nowLocal() {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
}

function savedPosition() {
    const p = recall("position");
    return p in options.positions ? p : null;
}

// ---------- People ----------
async function loadProfiles() {
    const { profiles } = await api("/api/profiles");
    const sel = $("profile");
    sel.replaceChildren();
    profiles.forEach((p) => {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name;
        sel.appendChild(o);
    });

    const saved = recall("profileId");
    if (profiles.some((p) => String(p.id) === saved)) sel.value = saved;

    profileId = sel.value ? Number(sel.value) : null;
    const hasPerson = profileId !== null;
    sel.hidden = !hasPerson;
    $("no-profile").hidden = hasPerson;
    $("person-view").hidden = !hasPerson;
    if (hasPerson) await loadAll(true);
}

async function addProfile() {
    const name = (prompt("Whose readings are these? Enter a name:") || "").trim();
    if (!name) return;
    try {
        const p = await api("/api/profiles", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name }) });
        store("profileId", String(p.id));
        await loadProfiles();
    } catch (e) {
        alert(e.message);
    }
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

// ---------- Saving (shared by both ways of logging) ----------
async function saveReadings(readings, extra, force) {
    const body = { profile_id: profileId, readings, ...extra, force: !!force };
    try {
        return await api("/api/readings", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    } catch (e) {
        if (e.status === 422 && e.data && e.data.problems) {
            if (confirm("These look unusual:\n\n" + e.data.problems.join("\n") + "\n\nSave anyway?")) {
                return saveReadings(readings, extra, true);
            }
            return null;
        }
        alert(e.message);
        return null;
    }
}

async function afterSave(result, position) {
    if (position) store("position", position);
    showStatus("Saved.", false);
    $("crisis").hidden = !result.crisis;
    if (result.crisis) $("crisis").scrollIntoView({ behavior: "smooth", block: "start" });
    await loadAll(true);  // back to the newest readings
}

// ---------- Quick entry ----------
function resetQuickTime() {
    quick.timeTouched = false;
    $("q-when").value = nowLocal();
}

async function saveQuick() {
    const reading = {};
    FIELDS.forEach((key) => {
        const v = $("q-" + key).value;
        reading[key] = v === "" ? null : parseInt(v, 10);
    });
    if (FIELDS.every((key) => reading[key] === null)) {
        showStatus("Enter at least one number.", true);
        return;
    }
    // An untouched time means "now"; the server fills it in
    reading.taken_at = quick.timeTouched ? $("q-when").value : null;

    $("q-save").disabled = true;
    try {
        const result = await saveReadings([reading], detailsOf(quick));
        if (!result) return;
        FIELDS.forEach((key) => { $("q-" + key).value = ""; });
        quick.tags.clear();  // the position is kept for next time; tags are per reading
        renderDetails($("q-details"), quick);
        resetQuickTime();
        await afterSave(result, quick.position);
    } finally {
        $("q-save").disabled = false;
    }
}

function setMode(mode) {
    $("quick-mode").hidden = mode !== "quick";
    $("note-mode").hidden = mode !== "note";
    $("tab-quick").setAttribute("aria-selected", mode === "quick");
    $("tab-note").setAttribute("aria-selected", mode === "note");
    if (mode === "quick") cancelDraft();
    showStatus("", false);
    store("mode", mode);
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
            warn.hidden = true;  // the server re-checks when you save
        };
        l.appendChild(inp);
        grid.appendChild(l);
    });

    const whenLabel = document.createElement("label");
    whenLabel.textContent = "When";
    const when = document.createElement("input");
    when.type = "datetime-local";
    when.value = r.taken_at;
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
    $("confirm").hidden = false;
    $("confirm").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelDraft() {
    draft = [];
    $("confirm").hidden = true;
}

async function saveDraft() {
    const readings = draft.map((r) => ({ systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse, taken_at: r.taken_at }));
    $("save").disabled = true;
    try {
        const result = await saveReadings(readings, { note: $("note").value.trim(), ...detailsOf(noteDetails) });
        if (!result) return;
        $("note").value = "";
        cancelDraft();
        await afterSave(result, noteDetails.position);
    } finally {
        $("save").disabled = draft.length === 0;
    }
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

// ---------- Loading everything for a person ----------
async function loadAll(resetPage) {
    if (resetPage) historyPage = 0;
    const [{ readings }, { periods }] = await Promise.all([
        api("/api/readings?profile_id=" + profileId + "&limit=20"),
        api("/api/stats?profile_id=" + profileId),
    ]);
    totalReadings = periods[periods.length - 1].count;  // the "All time" count
    renderStats(periods);
    chartData = readings.slice().reverse();
    renderChart();
    $("export").href = "/api/export.csv?profile_id=" + profileId;
    $("export").hidden = totalReadings === 0;
    await loadHistory();
}

async function loadHistory() {
    const pages = Math.max(1, Math.ceil(totalReadings / PAGE_SIZE));
    historyPage = Math.min(historyPage, pages - 1);  // e.g. after deleting the last reading on a page
    const first = historyPage * PAGE_SIZE;
    const { readings } = await api(
        "/api/readings?profile_id=" + profileId + "&limit=" + PAGE_SIZE + "&offset=" + first
    );
    renderHistory(readings);
    $("pager").hidden = totalReadings <= PAGE_SIZE;
    $("page-info").textContent = (first + 1) + "–" + (first + readings.length) + " of " + totalReadings;
    $("newer").disabled = historyPage === 0;
    $("older").disabled = historyPage >= pages - 1;
}

async function turnPage(step) {
    historyPage += step;
    try {
        await loadHistory();
        $("history").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) { alert(e.message); }
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
        count.textContent = p.count === 1 ? "1 reading" : p.count + " readings";
        tile.append(label, value, pulse, badge(p.category), count);
        box.appendChild(tile);
    });
}

function renderHistory(readings) {
    const ul = $("recent");
    ul.replaceChildren();
    $("recent-empty").hidden = readings.length > 0;
    readings.forEach((r) => {
        const li = document.createElement("li");
        const text = document.createElement("div");
        const line = document.createElement("div");
        line.className = "reading-line";
        const main = document.createElement("span");
        main.className = "big";
        main.textContent = bpText(r);
        line.append(main, badge(r.category));

        const extra = [whenText(r.taken_at)];
        if (r.position && options.positions[r.position]) extra.push(options.positions[r.position]);
        const tags = r.tags.filter((t) => options.tags[t]).map((t) => options.tags[t]);
        if (tags.length) extra.push(tags.join(", "));
        const when = document.createElement("div");
        when.className = "muted";
        when.textContent = extra.join(" · ");
        text.append(line, when);

        const del = document.createElement("button");
        del.type = "button";
        del.className = "link danger";
        del.textContent = "Delete";
        del.onclick = async () => {
            if (!confirm("Delete this reading?")) return;
            try {
                await api("/api/readings/" + r.id, { method: "DELETE" });
                await loadAll();
            } catch (e) { alert(e.message); }
        };
        li.append(text, del);
        ul.appendChild(li);
    });
}

// ---------- Wire it up ----------
$("tab-quick").onclick = () => setMode("quick");
$("tab-note").onclick = () => setMode("note");
$("q-save").onclick = saveQuick;
FIELDS.forEach((key) => {
    $("q-" + key).onkeydown = (e) => { if (e.key === "Enter") saveQuick(); };
});
$("q-when").oninput = () => { quick.timeTouched = true; };
$("read").onclick = readNote;
$("save").onclick = saveDraft;
$("cancel").onclick = cancelDraft;
$("add-row").onclick = () => {
    draft.push({ systolic: null, diastolic: null, pulse: null, problems: [], taken_at: nowLocal() });
    renderDraft();
};
$("crisis-close").onclick = () => { $("crisis").hidden = true; };
$("add-profile").onclick = addProfile;
$("profile").onchange = () => {
    profileId = Number($("profile").value);
    store("profileId", String(profileId));
    cancelDraft();
    $("crisis").hidden = true;
    loadAll(true).catch((e) => showStatus(e.message, true));
};
$("newer").onclick = () => turnPage(-1);
$("older").onclick = () => turnPage(1);
window.addEventListener("resize", renderChart);
// Keep the quick-entry time current while the page sits open
setInterval(() => { if (!quick.timeTouched) $("q-when").value = nowLocal(); }, 30000);

async function start() {
    options = await api("/api/options");
    quick.position = savedPosition();
    renderDetails($("q-details"), quick);
    resetQuickTime();
    setMode(recall("mode") === "note" ? "note" : "quick");
    await loadProfiles();
}

start().catch((e) => showStatus(e.message, true));
