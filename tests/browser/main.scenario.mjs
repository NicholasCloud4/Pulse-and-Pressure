// The main flow: welcome card, quick save, unusual numbers, future times, editing,
// delete with undo, people, restore, the backup reminder, and dark mode.
export default async function main({ js, waitFor, check, shot, sleep, send, navigate, reload }) {
    await navigate();
    await js(`localStorage.clear()`);
    await reload();

    // Helpers available in the page as `t`
    await js(`
      window.t = {
        vis: (id) => !document.getElementById(id).hidden && !document.getElementById(id).closest("[hidden]"),
        text: (id) => document.getElementById(id).textContent.trim(),
        set: (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); },
        click: (id) => document.getElementById(id).click(),
        quick: (s, d, p, note) => { t.set("q-systolic", s); t.set("q-diastolic", d); t.set("q-pulse", p); t.set("q-note", note || ""); t.click("q-save"); },
        // History rows, newest first, skipping the day headings ("Today", ...)
        rows: () => [...document.querySelectorAll("#recent li:not(.day-head)")].map((li) => li.textContent.replace(/\\s+/g, " ").trim()),
        stored: () => JSON.parse(localStorage.getItem("pulse-pressure-data")),
      };
    `);

    // --- Welcome ---
    check("welcome card shows on first visit", await js(`return t.vis("no-profile") && !t.vis("who") && !t.vis("person-view")`));
    await shot("01-welcome");
    await js(`document.getElementById("welcome-form").requestSubmit()`);
    check("empty name shows an error", (await js(`return t.text("welcome-error")`)).includes("Enter a name"));
    await js(`t.set("welcome-name", "Ann"); document.getElementById("welcome-form").requestSubmit()`);
    check("Get started creates the person", await js(`return t.vis("person-view") && t.vis("who") && document.getElementById("profile").selectedOptions[0].text === "Ann"`));

    // --- Quick save with a note ---
    await js(`t.quick("128", "82", "71", "left arm, felt fine")`);
    let status = await js(`return t.text("status")`);
    check("save message shows numbers and category", status.includes("Saved 128/82 · pulse 71") && status.includes("Stage 1 high"), status);
    const firstRow = await js(`return t.rows()[0]`);
    check("note saved and shown in history", !!firstRow?.includes("left arm, felt fine"), firstRow);
    check("note field cleared after save", (await js(`return document.getElementById("q-note").value`)) === "");
    await shot("02-saved");

    // --- Unusual numbers: Fix it / Save anyway ---
    await js(`t.quick("300", "82", "71")`);
    check("unusual numbers show the check box, not a popup", await js(`return t.vis("q-check") && t.text("q-check").includes("The top number (300)")`));
    check("nothing saved yet", (await js(`return t.stored().readings.length`)) === 1);
    await shot("03-check");
    await js(`[...document.querySelectorAll("#q-check button")].find((b) => b.textContent === "Fix it").click()`);
    check("Fix it hides the box and focuses the top number", await js(`return !t.vis("q-check") && document.activeElement.id === "q-systolic"`));
    await js(`t.click("q-save")`);
    await js(`[...document.querySelectorAll("#q-check button")].find((b) => b.textContent === "Save anyway").click()`);
    check("Save anyway saves", (await js(`return t.stored().readings.length`)) === 2);

    // --- Future time is blocked ---
    await js(`t.set("q-when", "2099-01-01T10:00"); t.set("q-systolic", "120"); t.set("q-diastolic", "80"); t.click("q-save")`);
    status = await js(`return t.text("status")`);
    check("future time is refused", status.includes("in the future") && (await js(`return t.stored().readings.length`)) === 2, status);
    check("When field has a max", await js(`return !!document.getElementById("q-when").max`));
    await js(`t.set("q-when", toLocalIso(Date.now() - 3600000)); t.click("q-save")`);
    check("past time saves", (await js(`return t.stored().readings.length`)) === 3);

    // --- Edit a reading ---
    await js(`[...document.querySelectorAll("#recent li")].find((li) => li.textContent.includes("300/82")).querySelector(".row-actions .link").click()`);
    check("Edit opens the window filled in", await js(`return document.getElementById("edit-dialog").open && document.getElementById("e-systolic").value === "300"`));
    await shot("04-edit");
    await js(`t.set("e-systolic", "130"); t.set("e-note", "typo fixed"); document.getElementById("edit-form").requestSubmit()`);
    await sleep(100);
    check("edit saves and closes", await js(`return !document.getElementById("edit-dialog").open && t.text("toast-text") === "Reading updated."`));
    check("edited values stored", await js(`const r = t.stored().readings.find((x) => x.note === "typo fixed"); return !!r && r.systolic === 130`));
    // Editing to an unusual value shows the check inside the window
    await js(`document.querySelector("#recent li .row-actions .link").click(); t.set("e-diastolic", "20"); document.getElementById("edit-form").requestSubmit()`);
    check("edit warns about unusual numbers", await js(`return document.getElementById("edit-dialog").open && t.vis("e-check")`));
    await js(`[...document.querySelectorAll("#e-check button")].find((b) => b.textContent === "Save anyway").click()`);
    await sleep(100);
    check("edit Save anyway saves", await js(`return !document.getElementById("edit-dialog").open && t.stored().readings.some((r) => r.diastolic === 20)`));
    await js(`document.querySelector("#recent li .row-actions .link").click(); t.set("e-diastolic", "80"); t.set("e-when", ""); document.getElementById("edit-form").requestSubmit()`);
    check("edit requires a time", (await js(`return t.text("edit-error")`)).includes("date and time"));
    await js(`t.click("edit-cancel")`);

    // --- Delete: confirm first, then undo ---
    const before = await js(`return t.stored().readings.length`);
    await js(`document.querySelector("#recent li .row-actions .danger").click()`);
    const asked = await js(`return { open: document.getElementById("ask-dialog").open, title: t.text("ask-title"), message: t.text("ask-message"),
      button: t.text("ask-ok"), red: document.getElementById("ask-ok").classList.contains("destructive"), focus: document.activeElement.id, count: t.stored().readings.length }`);
    check("Delete asks first and deletes nothing yet", asked.open && asked.title === "Delete this reading?" && asked.button === "Delete" && asked.red && asked.count === before, asked);
    check("the question names the reading", /^\d+\/\d+/.test(asked.message), asked.message);
    check("Cancel has the focus, so Enter doesn't delete", asked.focus === "ask-cancel", asked.focus);
    await shot("05-confirm-delete");
    await js(`t.click("ask-cancel")`);
    await waitFor(`return !document.getElementById("ask-dialog").open`);
    check("Cancel keeps the reading", (await js(`return t.stored().readings.length`)) === before);
    await js(`document.querySelector("#recent li .row-actions .danger").click(); document.getElementById("ask-form").requestSubmit()`);
    await waitFor(`return t.stored().readings.length === ${before - 1}`);
    check("confirming deletes it, with Undo", (await js(`return t.stored().readings.length`)) === before - 1 && await js(`return t.vis("toast") && t.text("toast-action") === "Undo"`));
    await shot("05-undo");
    await js(`t.click("toast-action")`);
    check("Undo puts it back", (await js(`return t.stored().readings.length`)) === before);

    // --- Add a second person, rename, duplicate names ---
    await js(`t.click("add-profile"); t.set("person-name", "Bob"); document.getElementById("person-form").requestSubmit()`);
    await sleep(50);
    check("add second person", await js(`return document.getElementById("profile").selectedOptions[0].text === "Bob"`));
    await js(`t.click("edit-profile")`);
    check("edit person window shows delete", await js(`return t.vis("person-remove") && t.text("person-title") === "Edit person"`));
    await js(`t.set("person-name", "ann"); document.getElementById("person-form").requestSubmit()`);
    check("rename to an existing name is refused", (await js(`return t.text("person-error")`)).includes("already exists"));
    await js(`t.set("person-name", "Robert"); document.getElementById("person-form").requestSubmit()`);
    await sleep(50);
    check("rename works", await js(`return document.getElementById("profile").selectedOptions[0].text === "Robert" && t.text("toast-text") === "Renamed to Robert."`));

    // --- Restore with a name mismatch uses the in-page window ---
    await js(`
      document.getElementById("profile").value = t.stored().profiles[0].id;
      document.getElementById("profile").dispatchEvent(new Event("change"));
      window.csv = exportCsv(profileId);
      document.getElementById("profile").value = t.stored().profiles[1].id;
      document.getElementById("profile").dispatchEvent(new Event("change"));
      window.restoring = restoreFile(new File([csv], "pulse-pressure-Ann-2026-10-01.csv"));
    `);
    await sleep(100);
    check("restore mismatch asks in a window", await js(`return document.getElementById("ask-dialog").open && t.text("ask-title") === "Add them to Robert?"`));
    await shot("06-ask");
    await js(`document.getElementById("ask-form").requestSubmit(); await window.restoring;`);
    const restored = await js(`return t.text("toast-text")`);
    check("restore result in a toast", restored.startsWith("Restored 3 readings for Robert."), restored);

    // --- Backup reminder ---
    await js(`for (let i = 0; i < 7; i++) addReadings(profileId, [{ systolic: 120 + i, diastolic: 80, pulse: 70, taken_at: toLocalIso(Date.now() - (i + 2) * 86400000) }], {}); loadAll(true);`);
    check("backup reminder shows at 10+ readings", await js(`return t.vis("backup-nudge") && t.text("backup-text").includes("10 readings")`), await js(`return t.text("backup-text")`));
    await shot("07-nudge");
    await js(`t.click("nudge-later")`);
    await js(`loadAll()`);
    check("Not now hides it", await js(`return !t.vis("backup-nudge")`));
    await js(`localStorage.removeItem("backupSnooze:" + profileId); loadAll();`);
    check("it comes back after the snooze", await js(`return t.vis("backup-nudge")`));
    await js(`t.click("nudge-export")`);
    check("export records the date and hides it", await js(`return !t.vis("backup-nudge") && !!localStorage.getItem("lastExport:" + profileId)`));

    // --- Delete a person ---
    await js(`t.click("edit-profile"); t.click("person-delete")`);
    await sleep(50);
    check("delete person asks to type the name", await js(`return document.getElementById("ask-dialog").open && t.vis("ask-type") && document.getElementById("ask-ok").classList.contains("destructive")`));
    await shot("08-delete-person");
    await js(`t.set("ask-input", "Rob"); document.getElementById("ask-form").requestSubmit()`);
    check("wrong name is refused", (await js(`return t.text("ask-error")`)).includes("Type Robert"));
    await js(`t.set("ask-input", "robert"); document.getElementById("ask-form").requestSubmit()`);
    await sleep(50);
    check("person and readings deleted", await js(`const d = t.stored(); return d.profiles.length === 1 && d.profiles[0].name === "Ann" && d.readings.every((r) => r.profile_id === d.profiles[0].id)`));
    check("falls back to the remaining person", await js(`return document.getElementById("profile").selectedOptions[0].text === "Ann"`));
    await js(`t.click("edit-profile"); t.click("person-delete"); await new Promise((r) => setTimeout(r, 50)); t.set("ask-input", "Ann"); document.getElementById("ask-form").requestSubmit()`);
    await sleep(50);
    check("deleting the last person shows the welcome card", await js(`return t.vis("no-profile") && !t.vis("who")`));

    // --- Screenshots of a filled page, light and dark ---
    await js(`t.set("welcome-name", "Ann"); document.getElementById("welcome-form").requestSubmit();
      [[118,76,62,"morning"],[131,85,74,""],[142,91,80,"after coffee"]].forEach(([s,d,p,n], i) => addReadings(profileId, [{ systolic: s, diastolic: d, pulse: p, taken_at: toLocalIso(Date.now() - (3 - i) * 86400000) }], { note: n, position: "sitting", tags: i === 2 ? ["caffeine"] : [] }));
      loadAll(true);`);
    await shot("09-light-full");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await js(`document.querySelector("#recent li .row-actions .danger").click(); document.getElementById("ask-form").requestSubmit()`);
    await waitFor(`return !document.getElementById("ask-dialog").open`);
    await shot("10-dark-full");
    await js(`t.quick("300", "82", "71")`);
    await js(`document.getElementById("q-check").scrollIntoView()`);
    await shot("11-dark-check");
}
