// The page at the narrowest phone size (360px) with a realistic amount of data:
// Save fits on the first screen, the save message is never hidden below the
// fold, tap targets are 44px, labels are plain words, sessions show as one
// history row, and the severe-reading alert can start the 1-minute timer.
export const timeout = 150000;

const SMALL = { width: 360, height: 740, deviceScaleFactor: 1, mobile: true };

export default async function layout({ js, waitFor, check, shot, send, navigate, reload }) {
    await send("Emulation.setDeviceMetricsOverride", SMALL);
    await navigate();
    await js(`localStorage.clear(); localStorage.setItem("installSnooze", "2999-01-01T00:00");`);
    await reload();
    await js(`
      window.$$ = (id) => document.getElementById(id);
      window.shown = (e) => e.offsetParent !== null && !e.closest("[hidden], dialog:not([open])");
      // Visible controls smaller than 44px (both sides for buttons, height for fields)
      window.smallTargets = () => [...document.querySelectorAll("button, input, select")].filter(shown)
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ e, r }) => r.height < 44 || (e.tagName === "BUTTON" && r.width < 44))
        .map(({ e, r }) => (e.id || e.textContent.trim().slice(0, 20)) + " " + Math.round(r.width) + "x" + Math.round(r.height));
      $$("welcome-name").value = "Sam"; $$("welcome-form").requestSubmit();
      // 45 days of made-up readings, morning and evening, some taken as 2-reading sessions
      let seed = 7;
      const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
      for (let d = 45; d >= 1; d--) {
        for (const hour of [7, 20]) {
          if (rnd() < 0.2) continue;
          const t = new Date(); t.setDate(t.getDate() - d); t.setHours(hour, Math.floor(rnd() * 50), 0, 0);
          const r = { systolic: Math.round(122 + rnd() * 22), diastolic: Math.round(76 + rnd() * 12), pulse: Math.round(64 + rnd() * 14), taken_at: toLocalIso(t) };
          const session = newId();
          addReadings(profileId, [r], { position: "sitting", tags: rnd() < 0.15 ? ["caffeine"] : [], session });
          if (rnd() < 0.3) { t.setMinutes(t.getMinutes() + 1); addReadings(profileId, [{ ...r, systolic: r.systolic - 3, taken_at: toLocalIso(t) }], { position: "sitting", session }); }
        }
      }
      setTarget(profileId, { systolic: 130, diastolic: 80 });
      loadAll(true);
      scrollTo(0, 0);`);

    // --- P1: Save fits on the first screen ---
    const save = await js(`const r = $$("q-save").getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }`);
    check("Save reading is on the first screen", save.bottom <= SMALL.height, save);
    await shot("30-first-screen", false);

    // --- P2: the save message is visible after saving, keyboard closed or open ---
    for (const visible of [740, 450]) {
        await send("Emulation.setDeviceMetricsOverride", { ...SMALL, height: visible });
        const seen = await js(`
          const b = $$("q-save").getBoundingClientRect().bottom + scrollY;
          scrollTo(0, Math.max(0, b - innerHeight + 4));
          $$("q-systolic").value = "126"; $$("q-diastolic").value = "81"; $$("q-pulse").value = "70"; $$("q-save").click();
          await new Promise((r) => setTimeout(r, 700));  // smooth scrolling
          const r = $$("status").getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: innerHeight, text: $$("status").textContent.slice(0, 30) }`);
        check("the save message is in view (" + visible + "px visible)", seen.text.startsWith("Saved") && seen.top >= 0 && seen.bottom <= seen.height, seen);
    }
    await shot("31-after-save", false);
    await send("Emulation.setDeviceMetricsOverride", SMALL);
    await js(`scrollTo(0, 0)`);

    // --- P3: 44px tap targets, P4: averages on one row, P5: plain words ---
    const small = await js(`return smallTargets()`);
    check("every visible control is at least 44px", small.length === 0, small);
    const tiles = await js(`return [...document.querySelectorAll("#stats .tile")].map((t) => t.offsetTop)`);
    check("the three averages share one row", tiles.length === 3 && new Set(tiles).size === 1, tiles);
    const words = await js(`return document.querySelector("main").innerText`);
    const jargon = ["Export CSV", "Systolic", "Diastolic"].filter((w) => words.includes(w));
    check("no technical words on screen", jargon.length === 0, jargon);
    const people = await js(`return [$$("edit-profile").textContent.trim(), $$("add-profile").textContent.trim()]`);
    check("the person buttons say what they do", people.every((t) => /[a-z]{3}/i.test(t)), people);
    check("no sideways scrolling at 360px", await js(`return document.documentElement.scrollWidth <= innerWidth`));
    // --- P6: a session is one history row, rows open Edit, Delete lives in the edit window ---
    await js(`
      const t = Date.now() - 5 * 60000, s = newId();
      addReadings(profileId, [{ systolic: 131, diastolic: 84, pulse: 70, taken_at: toLocalIso(t) }], { session: s });
      addReadings(profileId, [{ systolic: 127, diastolic: 82, pulse: 68, taken_at: toLocalIso(t + 60000) }], { session: s });
      loadAll(true); $$("history").scrollIntoView();`);
    const rows = await js(`return [...document.querySelectorAll("#recent li:not(.day-head)")].map((li) => li.innerText.replace(/\\s+/g, " ")).filter((t) => /131\\/84|127\\/82/.test(t))`);
    check("a 2-reading session is one row with its average",
        rows.length === 1 && rows[0].includes("Average of 2: 129/83") && rows[0].includes("131/84") && rows[0].includes("127/82"), rows);
    check("history rows have no Delete button", await js(`return ![...document.querySelectorAll("#recent button")].some((b) => /delete/i.test(b.textContent))`));
    await shot("32-history", false);
    const count = await js(`return readingsFor(profileId).length`);
    await js(`[...document.querySelectorAll("#recent button")].find((b) => b.textContent.includes("127/82")).click()`);
    check("tapping a reading opens it for editing", await js(`return $$("edit-dialog").open && $$("e-systolic").value === "127"`));
    check("edit window controls are 44px", (await js(`return smallTargets()`)).length === 0, await js(`return smallTargets()`));
    await shot("33-edit", false);
    await js(`$$("edit-delete").click()`);
    await waitFor(`return $$("ask-dialog").open`);
    check("Delete in the edit window still asks first", await js(`return $$("ask-title").textContent === "Delete this reading?" && readingsFor(profileId).length === ${count}`));
    await js(`$$("ask-form").requestSubmit()`);
    await waitFor(`return readingsFor(profileId).length === ${count - 1}`);
    check("deleting offers Undo", await js(`return !$$("toast").hidden && $$("toast-action").textContent === "Undo"`));
    await js(`$$("toast-action").click()`);
    check("Undo puts it back", await js(`return readingsFor(profileId).length === ${count}`));

    // --- P7: the severe-reading alert can start the 1-minute timer ---
    await js(`scrollTo(0, 0); $$("q-systolic").value = "186"; $$("q-diastolic").value = "122"; $$("q-pulse").value = "90"; $$("q-save").click()`);
    check("the alert offers the 1-minute timer", await js(`return !!$$("crisis-timer") && shown($$("crisis-timer"))`));
    await js(`$$("crisis-timer").click(); await new Promise((r) => setTimeout(r, 1200))`);
    const timer = await js(`const r = $$("session").getBoundingClientRect(); return { shown: shown($$("session")), text: $$("session-text").textContent, top: Math.round(r.top), bottom: Math.round(r.bottom), height: innerHeight }`);
    check("the timer counts down where it can be seen", timer.shown && /in 0:5\d/.test(timer.text) && timer.top >= 0 && timer.bottom <= timer.height, timer);
    await shot("34-crisis-timer", false);
    await js(`$$("session-stop").click(); $$("crisis-close").click()`);

    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await js(`scrollTo(0, 0)`);
    await shot("35-first-screen-dark", false);
    await shot("36-full-dark", true);
}
