// The latest-reading line, jumping between number boxes, measurement sessions
// (2-3 readings a minute apart), the doctor's target, and history by day with a filter.

export default async function features({ js, waitFor, check, shot, send, navigate, reload }) {
    await navigate();
    await js(`localStorage.clear(); localStorage.setItem("installSnooze", "2999-01-01T00:00");`);
    await reload();
    await js(`
      window.$$ = (id) => document.getElementById(id);
      // Types like a keyboard does: one character at a time, each with an input event
      window.type = (id, text) => { const e = $$(id); e.focus(); for (const ch of text) { e.value += ch; e.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch })); } };
      window.vis = (id) => !$$(id).hidden && !$$(id).closest("[hidden]");
      window.statusButton = (start) => [...$$("status").querySelectorAll("button")].find((b) => b.textContent.startsWith(start));
      $$("welcome-name").value = "Ann"; $$("welcome-form").requestSubmit();`);

    // --- Faster entry ---
    check("no latest line before any reading", await js(`return !vis("latest")`));
    await js(`type("q-systolic", "128")`);
    check("3 digits in the top number moves to the bottom", await js(`return document.activeElement.id === "q-diastolic"`));
    await js(`$$("q-systolic").value = ""; type("q-systolic", "12")`);
    check("12 waits (it could become 128)", await js(`return document.activeElement.id === "q-systolic"`));
    await js(`type("q-systolic", "9"); type("q-diastolic", "82")`);
    check("82 in the bottom number moves to pulse", await js(`return document.activeElement.id === "q-pulse"`));
    await js(`$$("q-systolic").focus(); $$("q-systolic").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
    check("Enter in the top number goes to the next box instead of saving",
        await js(`return document.activeElement.id === "q-diastolic" && !(localStorage.getItem("pulse-pressure-data") || "").includes("129")`));

    // --- Measurement session ---
    await js(`type("q-pulse", "71"); $$("q-save").click()`);
    check("latest line shows the reading", await js(`return vis("latest") && $$("latest").textContent.includes("129/82") && /now|minute/.test($$("latest").textContent)`),
        await js(`return $$("latest").textContent`));
    check("saving offers to take another", await js(`return !!statusButton("Take another in 1 minute")`));
    await shot("17-offer", false);
    await js(`statusButton("Take another").click()`);
    await js(`await new Promise((r) => setTimeout(r, 1200))`);
    const countdown = await js(`return $$("session-text").textContent`);
    check("a one-minute countdown starts", (await js(`return vis("session")`)) && /Reading 2 in 0:5\d/.test(countdown), countdown);
    await shot("18-countdown", false);
    await js(`$$("session-skip").click()`);
    check("Skip the wait: time for reading 2", await js(`return !vis("session") && $$("status").textContent.includes("Time for reading 2")`));
    await js(`$$("q-systolic").value = "125"; $$("q-diastolic").value = "80"; $$("q-pulse").value = "69"; $$("q-save").click()`);
    let status = await js(`return $$("status").textContent`);
    check("second reading shows the average of 2 and offers a third", status.includes("Average of 2: 127/81") && status.includes("Take a third"), status);
    await js(`statusButton("Take a third").click(); $$("session-skip").click();
      $$("q-systolic").value = "121"; $$("q-diastolic").value = "78"; $$("q-save").click()`);
    status = await js(`return $$("status").textContent`);
    check("third reading: average of 3 and no more offers", status.includes("Average of 3: 125/80") && !status.includes("Take"), status);
    const labels = await js(`return [...document.querySelectorAll("#recent .session-line")].map((e) => e.textContent)`);
    check("history labels the session's readings",
        labels.join("|") === "Reading 3 of 3 · average 125/80|Reading 2 of 3 · average 125/80|Reading 1 of 3 · average 125/80", labels);
    await js(`$$("q-systolic").value = "140"; $$("q-diastolic").value = "90"; $$("q-save").click()`);
    check("saving without Take another starts a new session",
        (await js(`return document.querySelectorAll("#recent .session-line").length`)) === 3 && !!(await js(`return !!statusButton("Take another")`)));
    await js(`statusButton("Take another").click(); $$("session-stop").click()`);
    check("Stop ends the wait", await js(`return !vis("session")`));

    // --- Target from the doctor ---
    check("averages offer to add a target", await js(`return $$("target-line").textContent.includes("Add a target")`));
    await js(`$$("target-line").querySelector("button").click()`);
    check("target boxes show in the person window, focused",
        await js(`return $$("person-dialog").open && vis("person-target") && document.activeElement.id === "target-systolic"`));
    await js(`$$("target-systolic").value = "80"; $$("target-diastolic").value = "130"; $$("person-form").requestSubmit()`);
    check("an upside-down target is refused", (await js(`return $$("person-error").textContent`)).includes("doesn't look right"));
    await js(`$$("target-systolic").value = "130"; $$("target-diastolic").value = "80"; $$("person-form").requestSubmit()`);
    // The window's close event (which refreshes the page) fires a moment later
    await waitFor(`return !$$("person-dialog").open && $$("target-line").textContent.includes("On target")`);
    // 129/82, 125/80, 121/78, 140/90: only 121/78 is under both 130 and 80
    const line = await js(`return $$("target-line").textContent`);
    check("target line shows how many were on target", line.includes("On target (under 130/80): 1 of 4 readings in the last 30 days (25%)"), line);
    check("chart legend shows the target", await js(`return $$("ref-label").textContent === "Target under 130/80" && $$("chart-caption").textContent.includes("target from the doctor")`));
    await js(`$$("add-profile").click()`);
    check("adding a person doesn't show target boxes", await js(`return $$("person-dialog").open && !vis("person-target")`));
    await js(`$$("person-cancel").click(); $$("stats").scrollIntoView()`);
    await shot("19-target", false);

    // --- History by day and filter ---
    await js(`addReadings(profileId, [{ systolic: 132, diastolic: 86, pulse: 75, taken_at: toLocalIso(Date.now() - 86400000) }], { tags: ["caffeine"] });
      addReadings(profileId, [{ systolic: 136, diastolic: 88, pulse: 77, taken_at: toLocalIso(Date.now() - 3 * 86400000) }], { tags: ["caffeine"], note: "big coffee" });
      loadAll();`);
    const heads = await js(`return [...document.querySelectorAll("#recent .day-head")].map((e) => e.textContent)`);
    check("history is grouped by day", heads[0] === "Today" && heads[1] === "Yesterday" && heads.length === 3, heads);
    await js(`$$("history-filter").value = "tag:caffeine"; $$("history-filter").dispatchEvent(new Event("change"))`);
    const filtered = await js(`return { items: document.querySelectorAll("#recent li:not(.day-head)").length, summary: $$("filter-summary").textContent }`);
    check("caffeine filter shows those readings and their average", filtered.items === 2 && filtered.summary.includes("Average of these 2 readings: 134/87"), filtered);
    await js(`$$("history").scrollIntoView()`);
    await shot("20-history-filter", false);
    await js(`$$("history-filter").value = "position:lying"; $$("history-filter").dispatchEvent(new Event("change"))`);
    check("a filter with no matches says so", await js(`return vis("recent-empty") && $$("recent-empty").textContent.includes("No readings match")`));
    await js(`$$("history-filter").value = "all"; $$("history-filter").dispatchEvent(new Event("change"))`);

    // --- The report includes the target ---
    await js(`window.print = () => {}; $$("report-go").click()`);
    check("report mentions the target", (await js(`return $$("report").textContent`)).includes("Target from the doctor: under 130/80"));

    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await js(`window.scrollTo(0, 0)`);
    await shot("21-top-dark", false);
}
