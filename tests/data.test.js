// Unit tests for static/data.js. No packages needed; run from the repo root with:
//     node --test
// data.js is a plain browser script, so each test runs it in a fresh node:vm
// context with an in-memory localStorage.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "static", "data.js"), "utf8");

// Top-level const/let/function names we want to reach from the tests
const NAMES = [
    "POSITIONS", "TAGS", "CATEGORIES", "DATA_KEY",
    "categorize", "looksPlausible", "toLocalIso", "nowLocal", "loadData", "commit",
    "listProfiles", "checkName", "addProfile", "renameProfile", "deleteProfile", "profileName",
    "addReadings", "updateReading", "deleteReading", "undoDelete", "readingsFor",
    "averagesFor", "statsFor", "exportCsv", "exportFileName", "csvSafe",
    "parseCsv", "parseDate", "parseTime", "importCsv", "reportFor",
    "cleanTarget", "setTarget", "targetFor", "isOnTarget", "targetStats", "sessionAverages",
    "historyFilters", "filterReadings",
];

// const/let aren't properties of the context, so collect them at the end of the script
const EXPOSE = "\nglobalThis.__api = {\n"
    + NAMES.map((n) => "    " + n + ": typeof " + n + " === \"undefined\" ? undefined : " + n + ",").join("\n")
    + "\n    getData: () => data,\n};\n";

// A localStorage stand-in. Set failWrites to make setItem throw like a full disk.
function makeStorage(initial) {
    const items = new Map(Object.entries(initial || {}));
    return {
        failWrites: false,
        getItem(key) { return items.has(key) ? items.get(key) : null; },
        setItem(key, value) {
            if (this.failWrites) throw new Error("QuotaExceededError");
            items.set(key, String(value));
        },
        removeItem(key) { items.delete(key); },
        clear() { items.clear(); },
    };
}

// A fresh copy of data.js with its own storage, so tests never share state
function load(initialStorage) {
    const storage = makeStorage(initialStorage);
    const context = vm.createContext({
        localStorage: storage, navigator: {}, Date, Math, JSON, console,
    });
    vm.runInContext(SOURCE + EXPOSE, context, { filename: "data.js" });
    const api = context.__api;
    api.storage = storage;
    // What's saved in storage right now, parsed
    api.saved = () => JSON.parse(storage.getItem(api.DATA_KEY));
    return api;
}

// Objects made inside the vm have other prototypes; copy them for deepEqual
const plain = (value) => JSON.parse(JSON.stringify(value));

const DAY = 86400000;

// A local time string n days before now (negative n is in the future)
function daysAgo(api, n) {
    return api.toLocalIso(Date.now() - n * DAY);
}

// The fields that should survive a CSV round trip
const essentials = (r) => ({
    taken_at: r.taken_at, systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse,
    position: r.position, tags: plain(r.tags), note: r.note,
});

describe("categorize", () => {
    const api = load();
    const cases = [
        [119, 79, "normal"],
        [120, 79, "elevated"],
        [129, 79, "elevated"],
        [130, 79, "stage1"],
        [120, 80, "stage1"],
        [139, 89, "stage1"],
        [140, 89, "stage2"],
        [120, 90, "stage2"],
        [180, 120, "stage2"],
        [181, 80, "crisis"],
        [120, 121, "crisis"],
    ];
    for (const [sys, dia, expected] of cases) {
        test(sys + "/" + dia + " is " + expected, () => {
            assert.equal(api.categorize(sys, dia), expected);
        });
    }

    test("a missing number gives no category", () => {
        assert.equal(api.categorize(null, 80), null);
        assert.equal(api.categorize(120, null), null);
        assert.equal(api.categorize(null, null), null);
    });
});

describe("looksPlausible", () => {
    const api = load();
    const check = (systolic, diastolic, pulse) => plain(api.looksPlausible({ systolic, diastolic, pulse }));

    test("usual numbers have no problems", () => {
        assert.deepEqual(check(120, 80, 70), []);
        assert.deepEqual(check(70, 40, 30), []);
        assert.deepEqual(check(250, 150, 220), []);
        assert.deepEqual(check(null, null, 70), []);
    });

    test("each number out of range is reported", () => {
        assert.deepEqual(check(260, 80, 70), ["the top number (260) is outside the usual 70 to 250"]);
        assert.deepEqual(check(120, 30, 70), ["the bottom number (30) is outside the usual 40 to 150"]);
        assert.deepEqual(check(120, 80, 25), ["the pulse (25) is outside the usual 30 to 220"]);
        assert.match(check(69, 50, 70)[0], /top number \(69\)/);
        assert.match(check(200, 151, 70)[0], /bottom number \(151\)/);
        assert.match(check(120, 80, 221)[0], /pulse \(221\)/);
    });

    test("the top number must be higher than the bottom number", () => {
        assert.deepEqual(check(100, 100, 70), ["the top number should be higher than the bottom number"]);
        assert.deepEqual(check(90, 100, 70), ["the top number should be higher than the bottom number"]);
    });
});

describe("addReadings", () => {
    test("saves cleaned readings that share a batch id", () => {
        const api = load();
        const p = api.addProfile("Ann");
        const t1 = daysAgo(api, 2);
        const t2 = daysAgo(api, 1);
        const result = api.addReadings(p.id, [
            { taken_at: t1, systolic: 120, diastolic: 80, pulse: 70 },
            { taken_at: t2 + ":59.000Z", systolic: 118, diastolic: 78, pulse: "72" },
        ], { position: "sitting", tags: ["caffeine", "medication"], note: "  morning  " });

        assert.equal(result.saved, 2);
        assert.equal(result.crisis, false);
        const saved = api.saved().readings;
        assert.equal(saved.length, 2);
        assert.equal(saved[0].batch, saved[1].batch);
        assert.notEqual(saved[0].id, saved[1].id);
        assert.deepEqual(essentials(saved[0]), {
            taken_at: t1, systolic: 120, diastolic: 80, pulse: 70,
            position: "sitting", tags: ["medication", "caffeine"], note: "morning",
        });
        // The time is cut to minutes, and a number given as text is dropped
        assert.equal(saved[1].taken_at, t2);
        assert.equal(saved[1].pulse, null);
        assert.equal(saved[1].profile_id, p.id);
    });

    test("a reading with no time is saved at the current time", () => {
        const api = load();
        const p = api.addProfile("Ann");
        const before = api.nowLocal();
        api.addReadings(p.id, [{ systolic: 120, diastolic: 80, pulse: 70 }], {});
        const after = api.nowLocal();
        const t = api.saved().readings[0].taken_at;
        assert.ok(t >= before && t <= after, t);
    });

    test("an empty reading is refused and nothing is saved", () => {
        const api = load();
        const p = api.addProfile("Ann");
        assert.throws(() => api.addReadings(p.id, [{ systolic: null, diastolic: null, pulse: null }], {}),
            /The reading is empty/);
        assert.throws(() => api.addReadings(p.id, [
            { systolic: 120, diastolic: 80, pulse: 70 },
            { systolic: "", diastolic: undefined, pulse: 7.5 },
        ], {}), /Reading 2 is empty/);
        assert.equal(api.saved().readings.length, 0);
    });

    test("a time in the future is refused", () => {
        const api = load();
        const p = api.addProfile("Ann");
        assert.throws(() => api.addReadings(p.id,
            [{ taken_at: daysAgo(api, -2), systolic: 120, diastolic: 80, pulse: 70 }], {}),
        /in the future/);
        assert.equal(api.saved().readings.length, 0);
    });

    test("reports a crisis reading", () => {
        const api = load();
        const p = api.addProfile("Ann");
        const result = api.addReadings(p.id, [
            { systolic: 120, diastolic: 80, pulse: 70 },
            { systolic: 185, diastolic: 100, pulse: 90 },
        ], {});
        assert.equal(result.crisis, true);
    });

    test("the note is trimmed and cut to 500 characters", () => {
        const api = load();
        const p = api.addProfile("Ann");
        api.addReadings(p.id, [{ systolic: 120, diastolic: 80, pulse: 70 }], { note: "   " + "x".repeat(600) });
        assert.equal(api.saved().readings[0].note, "x".repeat(500));
    });

    test("unknown tags and positions are dropped", () => {
        const api = load();
        const p = api.addProfile("Ann");
        api.addReadings(p.id, [{ systolic: 120, diastolic: 80, pulse: 70 }],
            { position: "upside-down", tags: ["caffeine", "bogus", "Stressed"] });
        const r = api.saved().readings[0];
        assert.equal(r.position, null);
        assert.deepEqual(r.tags, ["caffeine"]);
    });
});

describe("updateReading", () => {
    function setUp() {
        const api = load();
        const p = api.addProfile("Ann");
        api.addReadings(p.id, [
            { taken_at: daysAgo(api, 2), systolic: 120, diastolic: 80, pulse: 70 },
            { taken_at: daysAgo(api, 2), systolic: 122, diastolic: 82, pulse: 72 },
        ], { note: "two at once" });
        const [first, second] = api.saved().readings;
        return { api, p, first, second };
    }

    test("changes the numbers, time and details", () => {
        const { api, first } = setUp();
        const t = daysAgo(api, 1);
        api.updateReading(first.id, { taken_at: t, systolic: 130, diastolic: 85, pulse: null },
            { position: "standing", tags: ["exercise"], note: "two at once" });
        const r = api.saved().readings.find((x) => x.id === first.id);
        assert.deepEqual(essentials(r), {
            taken_at: t, systolic: 130, diastolic: 85, pulse: null,
            position: "standing", tags: ["exercise"], note: "two at once",
        });
    });

    test("an unchanged note keeps the reading in its batch", () => {
        const { api, first } = setUp();
        api.updateReading(first.id, { taken_at: first.taken_at, systolic: 125, diastolic: 80, pulse: 70 },
            { note: "  two at once " });
        assert.equal(api.saved().readings.find((x) => x.id === first.id).batch, first.batch);
    });

    test("a changed note moves the reading to a new batch", () => {
        const { api, first, second } = setUp();
        api.updateReading(first.id, { taken_at: first.taken_at, systolic: 120, diastolic: 80, pulse: 70 },
            { note: "just this one" });
        const saved = api.saved().readings;
        const r1 = saved.find((x) => x.id === first.id);
        const r2 = saved.find((x) => x.id === second.id);
        assert.notEqual(r1.batch, first.batch);
        assert.equal(r1.note, "just this one");
        assert.equal(r2.batch, first.batch);
        assert.equal(r2.note, "two at once");
    });

    test("a missing or broken time is refused", () => {
        const { api, first } = setUp();
        assert.throws(() => api.updateReading(first.id, { systolic: 120, diastolic: 80, pulse: 70 }, {}),
            /Enter a date and time/);
        assert.throws(() => api.updateReading(first.id, { taken_at: "yesterday", systolic: 120, diastolic: 80, pulse: 70 }, {}),
            /Enter a date and time/);
        assert.equal(api.saved().readings.find((x) => x.id === first.id).note, "two at once");
    });

    test("an empty or future reading is refused", () => {
        const { api, first } = setUp();
        assert.throws(() => api.updateReading(first.id,
            { taken_at: first.taken_at, systolic: null, diastolic: null, pulse: null }, {}), /empty/);
        assert.throws(() => api.updateReading(first.id,
            { taken_at: daysAgo(api, -1), systolic: 120, diastolic: 80, pulse: 70 }, {}), /future/);
    });
});

describe("deleteReading and undoDelete", () => {
    test("undo puts the same reading back where it was", () => {
        const api = load();
        const p = api.addProfile("Ann");
        for (const sys of [110, 120, 130]) {
            api.addReadings(p.id, [{ taken_at: daysAgo(api, 1), systolic: sys, diastolic: 70, pulse: 60 }], {});
        }
        const before = api.saved().readings;
        const middle = before[1];

        const removed = api.deleteReading(middle.id);
        assert.equal(removed.index, 1);
        assert.deepEqual(api.saved().readings.map((r) => r.id), [before[0].id, before[2].id]);

        api.undoDelete(removed);
        assert.deepEqual(api.saved().readings, before);
        assert.deepEqual(plain(api.getData().readings), before);
    });

    test("deleting an unknown id does nothing", () => {
        const api = load();
        assert.equal(api.deleteReading("nope"), null);
    });
});

describe("people", () => {
    test("names must be unique, ignoring case and spaces", () => {
        const api = load();
        const ann = api.addProfile("  Ann ");
        assert.equal(ann.name, "Ann");
        assert.throws(() => api.addProfile("ann"), /already exists/);
        assert.throws(() => api.addProfile(" ANN"), /already exists/);
        assert.deepEqual(api.saved().profiles.map((p) => p.name), ["Ann"]);
    });

    test("empty or too-long names are refused", () => {
        const api = load();
        assert.throws(() => api.addProfile("   "), /Enter a name/);
        assert.throws(() => api.addProfile(null), /Enter a name/);
        assert.throws(() => api.addProfile("x".repeat(41)), /Enter a name/);
        assert.equal(api.addProfile("x".repeat(40)).name.length, 40);
    });

    test("rename allows the person's own name but not someone else's", () => {
        const api = load();
        const ann = api.addProfile("Ann");
        const bob = api.addProfile("Bob");
        assert.equal(api.renameProfile(ann.id, "ANN"), "ANN");
        assert.throws(() => api.renameProfile(bob.id, "ann"), /already exists/);
        assert.deepEqual(api.saved().profiles.map((p) => p.name), ["ANN", "Bob"]);
    });

    test("delete removes the person and only their readings", () => {
        const api = load();
        const ann = api.addProfile("Ann");
        const bob = api.addProfile("Bob");
        api.addReadings(ann.id, [{ systolic: 120, diastolic: 80, pulse: 70 }], {});
        api.addReadings(bob.id, [{ systolic: 130, diastolic: 85, pulse: 75 }], {});
        api.addReadings(ann.id, [{ systolic: 125, diastolic: 82, pulse: 71 }], {});

        api.deleteProfile(ann.id);
        const saved = api.saved();
        assert.deepEqual(saved.profiles.map((p) => p.name), ["Bob"]);
        assert.deepEqual(saved.readings.map((r) => r.profile_id), [bob.id]);
        assert.equal(api.readingsFor(ann.id).length, 0);
    });
});

describe("readingsFor", () => {
    test("newest first, and most recently added first for the same time", () => {
        const api = load();
        const ann = api.addProfile("Ann");
        const bob = api.addProfile("Bob");
        const same = daysAgo(api, 2);
        const add = (id, taken_at, systolic) =>
            api.addReadings(id, [{ taken_at, systolic, diastolic: 70, pulse: 60 }], {});
        add(ann.id, daysAgo(api, 3), 101);
        add(ann.id, daysAgo(api, 1), 102);
        add(ann.id, same, 103);
        add(bob.id, daysAgo(api, 1), 199);
        add(ann.id, same, 104);

        const list = api.readingsFor(ann.id);
        assert.deepEqual(plain(list).map((r) => r.systolic), [102, 104, 103, 101]);
        assert.equal(list[0].category, "normal");
    });

    test("readings saved together at one time list the last one first", () => {
        const api = load();
        const p = api.addProfile("Ann");
        const t = daysAgo(api, 1);
        api.addReadings(p.id, [
            { taken_at: t, systolic: 120, diastolic: 80, pulse: 70 },
            { taken_at: t, systolic: 185, diastolic: 80, pulse: 70 },
        ], {});
        const list = api.readingsFor(p.id);
        assert.deepEqual(plain(list).map((r) => r.systolic), [185, 120]);
        assert.deepEqual(plain(list).map((r) => r.category), ["crisis", "stage1"]);
    });
});

describe("averages", () => {
    function setUp() {
        const api = load();
        const p = api.addProfile("Ann");
        const add = (n, systolic, diastolic, pulse) =>
            api.addReadings(p.id, [{ taken_at: daysAgo(api, n), systolic, diastolic, pulse }], {});
        add(1, 130, 85, 70);
        add(3, 120, 80, 60);
        add(10, 140, 90, 80);
        add(40, 150, 100, 90);
        return { api, p };
    }

    test("averagesFor only counts readings inside the window", () => {
        const { api, p } = setUp();
        const readings = api.readingsFor(p.id);
        assert.deepEqual(plain(api.averagesFor(readings, 7)),
            { count: 2, systolic: 125, diastolic: 83, pulse: 65, category: "stage1" });
        assert.deepEqual(plain(api.averagesFor(readings, 30)),
            { count: 3, systolic: 130, diastolic: 85, pulse: 70, category: "stage1" });
        assert.deepEqual(plain(api.averagesFor(readings, null)),
            { count: 4, systolic: 135, diastolic: 89, pulse: 75, category: "stage1" });
    });

    test("missing numbers are left out of the averages", () => {
        const api = load();
        const t = daysAgo(api, 1);
        const result = plain(api.averagesFor([
            { taken_at: t, systolic: null, diastolic: null, pulse: 60 },
            { taken_at: t, systolic: null, diastolic: null, pulse: 71 },
        ], 7));
        assert.deepEqual(result, { count: 2, systolic: null, diastolic: null, pulse: 66, category: null });
        assert.deepEqual(plain(api.averagesFor([], null)),
            { count: 0, systolic: null, diastolic: null, pulse: null, category: null });
    });

    test("statsFor gives 7 days, 30 days and all time", () => {
        const { api, p } = setUp();
        const stats = plain(api.statsFor(p.id));
        assert.deepEqual(stats.map((s) => s.label), ["Last 7 days", "Last 30 days", "All time"]);
        assert.deepEqual(stats.map((s) => s.count), [2, 3, 4]);
        assert.deepEqual(stats.map((s) => s.systolic), [125, 130, 135]);
    });
});

describe("targets", () => {
    test("cleanTarget accepts a sensible goal or none", () => {
        const api = load();
        assert.deepEqual(plain(api.cleanTarget(130, 80)), { systolic: 130, diastolic: 80 });
        assert.equal(api.cleanTarget(null, null), null);
        assert.throws(() => api.cleanTarget(130, null), /both target numbers/);
        assert.throws(() => api.cleanTarget(80, 130), /doesn't look right/);
        assert.throws(() => api.cleanTarget(300, 80), /doesn't look right/);
        assert.throws(() => api.cleanTarget(130, 20), /doesn't look right/);
    });

    test("a target is saved per person and can be cleared", () => {
        const api = load();
        const ann = api.addProfile("Ann");
        const bob = api.addProfile("Bob");
        api.setTarget(ann.id, { systolic: 125, diastolic: 75 });
        assert.deepEqual(plain(api.targetFor(ann.id)), { systolic: 125, diastolic: 75 });
        assert.equal(api.targetFor(bob.id), null);
        assert.deepEqual(api.saved().profiles.find((p) => p.id === ann.id).target, { systolic: 125, diastolic: 75 });
        api.setTarget(ann.id, null);
        assert.equal(api.targetFor(ann.id), null);
        assert.ok(!("target" in api.saved().profiles.find((p) => p.id === ann.id)));
    });

    test("on target means under both numbers; readings missing a number aren't counted", () => {
        const api = load();
        const target = { systolic: 130, diastolic: 80 };
        assert.ok(api.isOnTarget({ systolic: 129, diastolic: 79 }, target));
        assert.ok(!api.isOnTarget({ systolic: 130, diastolic: 79 }, target));
        assert.ok(!api.isOnTarget({ systolic: 120, diastolic: 80 }, target));
        const stats = api.targetStats([
            { systolic: 120, diastolic: 70 }, { systolic: 135, diastolic: 70 },
            { systolic: 125, diastolic: 75 }, { systolic: null, diastolic: null, pulse: 70 },
        ], target);
        assert.deepEqual(plain(stats), { count: 3, onTarget: 2, percent: 67 });
        assert.deepEqual(plain(api.targetStats([], target)), { count: 0, onTarget: 0, percent: null });
    });

    test("the report includes the target and how often it was met", () => {
        const api = load();
        const p = api.addProfile("Ann");
        api.setTarget(p.id, { systolic: 130, diastolic: 80 });
        api.addReadings(p.id, [{ systolic: 120, diastolic: 75, pulse: null, taken_at: daysAgo(api, 2) }], {});
        api.addReadings(p.id, [{ systolic: 140, diastolic: 85, pulse: null, taken_at: daysAgo(api, 1) }], {});
        const rep = api.reportFor(p.id, 30);
        assert.deepEqual(plain(rep.target), { systolic: 130, diastolic: 80 });
        assert.equal(rep.targetStats.percent, 50);
    });
});

describe("measurement sessions", () => {
    test("readings sharing a session id are averaged, in the order taken", () => {
        const api = load();
        const p = api.addProfile("Ann");
        const t = daysAgo(api, 1);
        const first = api.addReadings(p.id, [{ systolic: 130, diastolic: 84, pulse: 70, taken_at: t }], { session: "s1" }).readings[0];
        const second = api.addReadings(p.id, [{ systolic: 126, diastolic: 80, pulse: 68, taken_at: t }], { session: "s1" }).readings[0];
        api.addReadings(p.id, [{ systolic: 140, diastolic: 90, pulse: 75, taken_at: t }], { session: "alone" });
        api.addReadings(p.id, [{ systolic: 118, diastolic: 76, pulse: 64, taken_at: t }], {});
        const sessions = api.sessionAverages(api.readingsFor(p.id));
        assert.deepEqual(Object.keys(sessions), ["s1"]);  // a session of one isn't shown
        assert.deepEqual([sessions.s1.count, sessions.s1.systolic, sessions.s1.diastolic, sessions.s1.pulse], [2, 128, 82, 69]);
        assert.deepEqual(plain(sessions.s1.ids), [first.id, second.id]);
        assert.equal(api.saved().readings.find((r) => r.systolic === 118).session, undefined);
    });
});

describe("history filters", () => {
    test("filter by tag, position or having a note", () => {
        const api = load();
        const p = api.addProfile("Ann");
        const add = (n, extra) => api.addReadings(p.id, [{ systolic: 120 + n, diastolic: 80, pulse: null, taken_at: daysAgo(api, n) }], extra);
        add(1, { tags: ["caffeine"], position: "sitting" });
        add(2, { tags: ["caffeine", "stressed"], note: "busy day" });
        add(3, { position: "standing" });
        const all = api.readingsFor(p.id);
        const systolic = (f) => plain(api.filterReadings(all, f).map((r) => r.systolic));
        assert.deepEqual(systolic("all"), [121, 122, 123]);
        assert.deepEqual(systolic("tag:caffeine"), [121, 122]);
        assert.deepEqual(systolic("tag:stressed"), [122]);
        assert.deepEqual(systolic("position:standing"), [123]);
        assert.deepEqual(systolic("note"), [122]);
        const values = api.historyFilters().map(([v]) => v);
        assert.ok(values[0] === "all" && values.includes("tag:medication") && values.includes("position:lying") && values.includes("note"));
    });
});

describe("reportFor", () => {
    // Readings at a set hour, n days ago
    const at = (api, n, time) => daysAgo(api, n).slice(0, 10) + "T" + time;

    function setUp() {
        const api = load();
        const p = api.addProfile("Ann");
        const save = (n, time, systolic, diastolic, pulse) =>
            api.addReadings(p.id, [{ taken_at: at(api, n, time), systolic, diastolic, pulse }], {});
        save(100, "08:00", 150, 95, 80);   // outside 90 days
        save(20, "07:30", 120, 80, 60);    // morning, stage 1
        save(10, "08:15", 130, 84, 70);    // morning, stage 1
        save(5, "19:00", 140, 90, 76);     // evening, stage 2
        save(2, "21:45", 118, 76, null);   // evening, normal
        save(1, "12:00", null, null, 72);  // noon counts as afternoon; pulse only
        return { api, p };
    }

    test("limits to the period and lists readings oldest first", () => {
        const { api, p } = setUp();
        const rep = api.reportFor(p.id, 90);
        assert.equal(rep.readings.length, 5);
        assert.deepEqual(plain(rep.readings.map((r) => r.systolic)), [120, 130, 140, 118, null]);
        assert.equal(rep.from, at(api, 20, "07:30"));
        assert.equal(rep.to, at(api, 1, "12:00"));
        assert.equal(api.reportFor(p.id, null).readings.length, 6);
    });

    test("averages all readings, mornings and the rest of the day", () => {
        const { api, p } = setUp();
        const [all, mornings, later] = api.reportFor(p.id, 90).periods;
        assert.deepEqual([all.count, all.systolic, all.diastolic, all.pulse], [5, 127, 83, 70]);
        assert.deepEqual([mornings.count, mornings.systolic, mornings.diastolic, mornings.pulse, mornings.category],
            [2, 125, 82, 65, "stage1"]);
        assert.deepEqual([later.count, later.systolic, later.diastolic, later.pulse], [3, 129, 83, 74]);
    });

    test("counts categories and finds the highest and lowest", () => {
        const { api, p } = setUp();
        const rep = api.reportFor(p.id, 90);
        assert.deepEqual(plain(rep.counts), { normal: 1, elevated: 0, stage1: 2, stage2: 1, crisis: 0 });
        assert.equal(rep.highest.systolic, 140);
        assert.equal(rep.lowest.systolic, 118);
    });

    test("an empty period has no readings and no highest or lowest", () => {
        const { api } = setUp();
        const bob = api.addProfile("Bob");
        const empty = api.reportFor(bob.id, 30);
        assert.equal(empty.readings.length, 0);
        assert.equal(empty.from, null);
        assert.equal(empty.highest, null);
    });
});

describe("CSV export and import", () => {
    // Ann has single-reading notes, a formula-looking note, and a two-reading save
    function setUp() {
        const api = load();
        const ann = api.addProfile("Ann Smith!");
        api.addReadings(ann.id, [
            { taken_at: daysAgo(api, 3), systolic: 118, diastolic: 76, pulse: 64 },
            { taken_at: daysAgo(api, 3), systolic: 121, diastolic: 79, pulse: 66 },
        ], { note: "118/76 64 then 121/79 66" });
        api.addReadings(ann.id, [{ taken_at: daysAgo(api, 2), systolic: 120, diastolic: 80, pulse: 70 }],
            { position: "sitting", tags: ["medication", "caffeine"], note: "after coffee, \"strong\"\n  felt fine" });
        api.addReadings(ann.id, [{ taken_at: daysAgo(api, 1), systolic: 135, diastolic: 85, pulse: null }],
            { position: "lying", note: "=SUM(1)" });
        return { api, ann };
    }

    test("export writes a header, labels and safe notes", () => {
        const { api, ann } = setUp();
        const csv = api.exportCsv(ann.id);
        assert.ok(csv.startsWith("﻿Date,Time,Systolic,Diastolic,Pulse,Category,Position,Tags,Note\r\n"));
        assert.ok(csv.endsWith("\r\n"));
        const lines = csv.trim().split("\r\n");
        assert.equal(lines.length, 5);
        // Oldest first; a note shared by two readings isn't written
        assert.ok(lines[1].endsWith(",,,"), lines[1]);
        assert.ok(!csv.includes("then 121/79"));
        // Newlines become " / ", and commas and quotes are quoted
        assert.ok(lines[3].endsWith(",Stage 1 high,Sitting,Medication taken; Caffeine,"
            + "\"after coffee, \"\"strong\"\" / felt fine\""), lines[3]);
        assert.ok(lines[4].endsWith(",135,85,,Stage 1 high,Lying down,,'=SUM(1)"), lines[4]);
    });

    test("export then import into another person keeps the readings", () => {
        const { api, ann } = setUp();
        const bob = api.addProfile("Bob");
        const csv = api.exportCsv(ann.id);

        assert.deepEqual(plain(api.importCsv(bob.id, csv)), { added: 4, skipped: 0, unreadable: 0 });
        const expected = api.readingsFor(ann.id).map(essentials);
        // Only the note shared by two readings is lost, and newlines became " / "
        expected.forEach((r) => {
            if (r.note.includes("then")) r.note = "";
            r.note = r.note.replace(/\n\s*/, " / ");
        });
        assert.deepEqual(plain(api.readingsFor(bob.id).map(essentials)), plain(expected));
        assert.equal(api.readingsFor(bob.id)[0].note, "=SUM(1)");
        assert.equal(api.readingsFor(ann.id).length, 4);
    });

    test("importing the same file twice adds nothing the second time", () => {
        const { api, ann } = setUp();
        const bob = api.addProfile("Bob");
        const csv = api.exportCsv(ann.id);
        api.importCsv(bob.id, csv);
        assert.deepEqual(plain(api.importCsv(bob.id, csv)), { added: 0, skipped: 4, unreadable: 0 });
        assert.equal(api.readingsFor(bob.id).length, 4);
        // Importing into the same person also skips everything
        assert.deepEqual(plain(api.importCsv(ann.id, csv)), { added: 0, skipped: 4, unreadable: 0 });
    });

    test("quoted fields can hold commas, newlines and quotes", () => {
        const api = load();
        assert.deepEqual(plain(api.parseCsv("﻿a,\"b,c\",\"d \"\"q\"\" e\",\"multi\r\nline\"\r\nx,y\n\nz")),
            [["a", "b,c", "d \"q\" e", "multi\r\nline"], ["x", "y"], [""], ["z"]]);

        const p = api.addProfile("Ann");
        const csv = "Date,Time,Systolic,Diastolic,Pulse,Note\r\n"
            + "2026-10-01,08:00,120,80,70,\"one, two\nthree \"\"four\"\"\"\r\n";
        assert.deepEqual(plain(api.importCsv(p.id, csv)), { added: 1, skipped: 0, unreadable: 0 });
        assert.equal(api.readingsFor(p.id)[0].note, "one, two\nthree \"four\"");
    });

    test("Excel-style dates and times are understood", () => {
        const api = load();
        assert.deepEqual(plain(api.parseDate("10/3/2026")), ["2026", "10", "3"]);
        assert.deepEqual(plain(api.parseDate("2026-10-03")), ["2026", "10", "03"]);
        assert.equal(api.parseDate("3 Oct 2026"), null);
        assert.deepEqual(plain(api.parseTime("7:42 PM")), [19, "42"]);
        assert.deepEqual(plain(api.parseTime("12:05 am")), [0, "05"]);
        assert.deepEqual(plain(api.parseTime("12:30 PM")), [12, "30"]);
        assert.deepEqual(plain(api.parseTime("19:42:00")), [19, "42"]);
        assert.deepEqual(plain(api.parseTime("")), [0, "00"]);
        assert.equal(api.parseTime("24:00"), null);
        assert.equal(api.parseTime("noon"), null);
        assert.equal(api.parseTime("13:00 PM"), null);
        assert.equal(api.parseTime("0:30 am"), null);
        assert.equal(api.parseTime("10:75"), null);
        assert.equal(api.parseDate("2/30/2026"), null);
        assert.deepEqual(plain(api.parseDate("2/29/2028")), ["2028", "2", "29"]);  // leap year

        const p = api.addProfile("Ann");
        const csv = "date,time,systolic,diastolic,pulse,position,tags\r\n"
            + "10/3/2026,7:42 PM,120,80,70,Lying down,\"Caffeine, stressed; caffeine\"\r\n";
        api.importCsv(p.id, csv);
        const r = api.readingsFor(p.id)[0];
        assert.equal(r.taken_at, "2026-10-03T19:42");
        assert.equal(r.position, "lying");
        // Same order the app saves tags in, with the repeat dropped
        assert.deepEqual(plain(r.tags), ["stressed", "caffeine"]);
    });

    test("a file that isn't an export is refused", () => {
        const api = load();
        const p = api.addProfile("Ann");
        assert.throws(() => api.importCsv(p.id, "Name,Value\r\nx,1\r\n"), /doesn't look like/);
        assert.throws(() => api.importCsv(p.id, ""), /doesn't look like/);
        assert.equal(api.readingsFor(p.id).length, 0);
    });

    test("rows that can't be read are counted, not saved", () => {
        const api = load();
        const p = api.addProfile("Ann");
        const csv = "Date,Time,Systolic,Diastolic,Pulse\r\n"
            + "yesterday,08:00,120,80,70\r\n"
            + "2026-10-01,25:00,120,80,70\r\n"
            + "2026-10-01,08:00,12a,80,70\r\n"
            + "2026-10-01,08:00,,,\r\n"
            + "2026-10-01,08:00,120.5,80,70\r\n"
            + "2026-10-01,08:00,120,80,70\r\n"
            + ",,,,\r\n";
        assert.deepEqual(plain(api.importCsv(p.id, csv)), { added: 1, skipped: 0, unreadable: 5 });
    });

    test("csvSafe only prefixes formula-looking text", () => {
        const api = load();
        assert.equal(api.csvSafe("=SUM(1)"), "'=SUM(1)");
        assert.equal(api.csvSafe("+1"), "'+1");
        assert.equal(api.csvSafe("-2 after walk"), "'-2 after walk");
        assert.equal(api.csvSafe("@home"), "'@home");
        assert.equal(api.csvSafe("fine"), "fine");
        assert.equal(api.csvSafe(""), "");
        assert.equal(api.csvSafe("'=already quoted"), "''=already quoted");
        assert.equal(api.csvSafe("it's fine"), "it's fine");
    });

    test("a note that starts with an apostrophe survives export and import", () => {
        const api = load();
        const ann = api.addProfile("Ann");
        const bob = api.addProfile("Bob");
        api.addReadings(ann.id, [{ systolic: 120, diastolic: 80, pulse: null, taken_at: daysAgo(api, 1) }], { note: "'=x" });
        api.importCsv(bob.id, api.exportCsv(ann.id));
        assert.equal(api.readingsFor(bob.id)[0].note, "'=x");
    });

    test("export file name uses a safe version of the person's name", () => {
        const { api, ann } = setUp();
        const today = api.nowLocal().slice(0, 10);
        assert.equal(api.exportFileName(ann.id), "pulse-pressure-Ann-Smith-" + today + ".csv");
        assert.equal(api.exportFileName("nobody"), "pulse-pressure-readings-" + today + ".csv");
    });

    test("a note shared by two readings stays out of the export after one is deleted", () => {
        const { api, ann } = setUp();
        const pair = api.saved().readings.filter((r) => r.note.includes("then"));
        api.deleteReading(pair[0].id);
        assert.ok(!api.exportCsv(ann.id).includes("then 121/79"));
    });

    test("giving one of two readings its own note leaves the other's shared note out", () => {
        const { api, ann } = setUp();
        const pair = api.saved().readings.filter((r) => r.note.includes("then"));
        api.updateReading(pair[0].id, pair[0], { note: "left arm" });
        const csv = api.exportCsv(ann.id);
        assert.ok(csv.includes("left arm"));
        assert.ok(!csv.includes("then 121/79"));
    });

    test("data saved before versions keeps shared notes out of the export", () => {
        const api = load();
        const p = api.addProfile("Ann");
        api.addReadings(p.id, [{ systolic: 120, diastolic: 80, pulse: null }, { systolic: 121, diastolic: 79, pulse: null }],
            { note: "120/80 then 121/79" });
        // Save it the way older versions did: no version field, no note_shared
        const old = api.saved();
        delete old.version;
        old.readings.forEach((r) => delete r.note_shared);
        api.storage.setItem("pulse-pressure-data", JSON.stringify(old));
        api.loadData();
        assert.ok(api.getData().readings.every((r) => r.note_shared === true));
        assert.ok(!api.exportCsv(p.id).includes("then 121/79"));
    });

    test("an impossible date in a CSV row is counted as unreadable", () => {
        const api = load();
        const p = api.addProfile("Ann");
        const csv = "Date,Time,Systolic,Diastolic,Pulse\r\n2026-13-45,08:00,120,80,70\r\n";
        assert.deepEqual(plain(api.importCsv(p.id, csv)), { added: 0, skipped: 0, unreadable: 1 });
    });

    test("a CSV row dated in the future is not imported", () => {
        const api = load();
        const p = api.addProfile("Ann");
        const future = daysAgo(api, -30);
        const csv = "Date,Time,Systolic,Diastolic,Pulse\r\n"
            + future.slice(0, 10) + "," + future.slice(11, 16) + ",120,80,70\r\n";
        assert.equal(api.importCsv(p.id, csv).added, 0);
    });
});

describe("storage", () => {
    test("missing data starts empty", () => {
        const api = load();
        api.loadData();
        assert.deepEqual(plain(api.listProfiles()), []);
        assert.deepEqual(plain(api.getData().readings), []);
    });

    test("saved data is loaded", () => {
        const first = load();
        const p = first.addProfile("Ann");
        first.addReadings(p.id, [{ systolic: 120, diastolic: 80, pulse: 70 }], {});

        const second = load({ [first.DATA_KEY]: first.storage.getItem(first.DATA_KEY) });
        second.loadData();
        assert.deepEqual(plain(second.listProfiles()), [plain(p)]);
        assert.equal(second.readingsFor(p.id)[0].systolic, 120);
    });

    test("corrupt data throws and isn't overwritten", () => {
        const key = load().DATA_KEY;
        const api = load({ [key]: "{not json" });
        assert.throws(() => api.loadData(), /couldn't be read/);
        assert.equal(api.storage.getItem(key), "{not json");
    });

    test("a failed save is rolled back", () => {
        const api = load();
        const ann = api.addProfile("Ann");
        api.addReadings(ann.id, [{ systolic: 120, diastolic: 80, pulse: 70 }], {});
        const before = api.saved();

        api.storage.failWrites = true;
        assert.throws(() => api.addProfile("Bob"), /Couldn't save/);
        assert.throws(() => api.addReadings(ann.id, [{ systolic: 130, diastolic: 85, pulse: 75 }], {}),
            /Couldn't save/);
        const reading = api.readingsFor(ann.id)[0];
        assert.throws(() => api.deleteReading(reading.id), /Couldn't save/);
        assert.throws(() => api.commit((d) => { d.profiles = []; }), /Couldn't save/);

        assert.deepEqual(plain(api.listProfiles().map((p) => p.name)), ["Ann"]);
        assert.equal(api.readingsFor(ann.id).length, 1);
        assert.deepEqual(api.saved(), before);
    });
});
