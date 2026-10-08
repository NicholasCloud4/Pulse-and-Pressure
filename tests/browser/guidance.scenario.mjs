// The severe-reading alert and the category labels follow the AHA's 2025 guidance,
// and the printed report explains how readings are categorized.

export default async function guidance({ js, check, shot, send, navigate, reload }) {
    await navigate();
    await js(`localStorage.clear(); localStorage.setItem("installSnooze", "2999-01-01T00:00");`);
    await reload();
    await js(`
      window.$$ = (id) => document.getElementById(id);
      $$("welcome-name").value = "Ann"; $$("welcome-form").requestSubmit();
      $$("q-systolic").value = "185"; $$("q-diastolic").value = "95"; $$("q-save").click();`);

    const alert = await js(`return { shown: !$$("crisis").hidden, text: $$("crisis").textContent.replace(/\\s+/g, " ") }`);
    check("a reading above 180/120 shows the alert", alert.shown, alert);
    check("the alert uses the 2025 name", alert.text.includes("severe hypertension range") && !/crisis/i.test(alert.text), alert.text);
    const callFirst = alert.text.indexOf("call 911");
    const waitAfter = alert.text.indexOf("wait at least 1 minute");
    check("symptoms mean calling 911 first, without waiting", callFirst > -1 && alert.text.includes("Don't wait"), alert.text);
    check("without symptoms: wait at least 1 minute and measure again", waitAfter > callFirst && alert.text.includes("contact your doctor as soon as possible"), alert.text);
    check("history badge says Severe hypertension", await js(`return document.querySelector("#recent .crisis-badge").textContent.includes("Severe hypertension")`));
    await js(`$$("crisis").scrollIntoView()`);
    await shot("22-severe-alert", false);

    await js(`window.print = () => {}; $$("report-go").click()`);
    const table = await js(`const t = [...$$("report").querySelectorAll("table")].pop(); return [...t.querySelectorAll("tbody tr")].map((tr) => [...tr.cells].map((c) => c.textContent).join(" | "))`);
    check("report explains the AHA categories", table.length === 5 && table[0] === "Normal | Less than 120 | and | Less than 80"
        && table[4] === "Severe hypertension | Higher than 180 | and/or | Higher than 120", table);
    await send("Emulation.setEmulatedMedia", { media: "print" });
    await send("Emulation.setDeviceMetricsOverride", { width: 760, height: 1100, deviceScaleFactor: 1, mobile: false });
    await shot("23-report-categories", true);
}
