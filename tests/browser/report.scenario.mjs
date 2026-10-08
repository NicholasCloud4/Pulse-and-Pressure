// The trend chart's range buttons and time spacing, and the printed doctor report.
import { PHONE } from "./cdp.mjs";

export default async function report({ js, check, shot, save, send, navigate, reload }) {
    await navigate();
    await js(`localStorage.clear(); localStorage.setItem("installSnooze", "2999-01-01T00:00");`);
    await reload();

    // Ann with readings spread over 120 days: mornings and evenings, a gap, a few notes
    await js(`
      document.getElementById("welcome-name").value = "Ann Smith"; document.getElementById("welcome-form").requestSubmit();
      const at = (n, time) => toLocalIso(Date.now() - n * 86400000).slice(0, 10) + "T" + time;
      const rows = [];
      for (let n = 120; n >= 1; n--) {
        if (n > 40 && n < 60) continue;  // a three-week gap
        if (n % 3) continue;
        const drift = Math.round(10 * Math.sin(n / 9));
        rows.push([n, "07:40", 128 + drift, 82 + Math.round(drift / 2), 68 + (n % 5)]);
        if (n % 2 === 0) rows.push([n, "20:15", 136 + drift, 86 + Math.round(drift / 2), 74]);
      }
      rows.forEach(([n, time, s, d, p], i) => addReadings(profileId, [{ systolic: s, diastolic: d, pulse: p, taken_at: at(n, time) }],
        { position: "sitting", tags: i % 7 === 0 ? ["caffeine"] : [], note: i % 9 === 0 ? "after a walk" : "" }));
      addReadings(profileId, [{ systolic: 124, diastolic: 80, pulse: null, taken_at: at(2, "08:00") }, { systolic: 122, diastolic: 79, pulse: null, taken_at: at(2, "08:05") }], { note: "124/80 then 122/79" });
      loadAll(true);
    `);

    check("30 days is the default range", await js(`return document.querySelector('#range [aria-pressed="true"]').dataset.days === "30" && chartData.every((r) => r.taken_at >= toLocalIso(Date.now() - 30 * 86400000))`));
    check("dashed 130 and 80 lines are drawn", (await js(`return document.querySelectorAll("#chart .refline").length`)) === 2);
    await js(`document.querySelector('#range [data-days="all"]').click()`);
    const spacing = await js(`
      const xs = [...document.querySelectorAll("#chart circle.mark.pulse")].map((c) => Number(c.getAttribute("cx")));
      const gaps = xs.slice(1).map((x, i) => x - xs[i]);
      return { count: xs.length, biggest: Math.max(...gaps), typical: gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] };`);
    check("All shows every reading, placed by time (the 3-week gap is wide)", spacing.count > 40 && spacing.biggest > spacing.typical * 4, spacing);
    check("range choice is remembered", await js(`return localStorage.getItem("chartRange") === "all"`));
    await js(`document.getElementById("range").scrollIntoView()`);
    await shot("13-trend-all", false);
    await js(`document.querySelector('#range [data-days="7"]').click()`);
    await shot("14-trend-7d", false);
    await js(`
      const recent = readingsFor(profileId).filter((r) => r.taken_at >= toLocalIso(Date.now() - 7 * 86400000));
      recent.forEach((r) => deleteReading(r.id)); loadAll();`);
    check("an empty range explains itself and keeps the buttons", await js(`return !document.getElementById("chart-empty").hidden && document.getElementById("chart-empty").textContent.includes("last 7 days") && !document.getElementById("range").hidden`));
    await js(`document.querySelector('#range [data-days="90"]').click()`);

    // Doctor report
    check("report card shows", await js(`return !document.getElementById("report-card").hidden`));
    await js(`window.print = () => { window.printed = true; }; document.getElementById("report-days").value = "90"; document.getElementById("report-go").click();`);
    const rep = await js(`const r = document.getElementById("report"); return {
        printed: !!window.printed, h1: r.querySelector("h1")?.textContent, meta: r.querySelector(".report-meta")?.textContent,
        tables: r.querySelectorAll("table").length, rows: r.querySelectorAll("table")[1]?.querySelectorAll("tbody tr").length,
        chart: r.querySelectorAll(".report-chart circle").length > 0, avgRows: [...(r.querySelectorAll("table")[0]?.querySelectorAll("tbody tr") || [])].map((tr) => tr.cells[0].textContent),
        sharedNoteHidden: !r.textContent.includes("124/80 then"), walkNote: r.textContent.includes("after a walk") };`);
    check("report is built and print is called", rep.printed && rep.h1 === "Blood pressure and pulse log" && !!rep.meta?.includes("Ann Smith"), rep);
    check("report has averages incl. mornings/evenings, chart and readings table", rep.tables === 3 && rep.rows > 20 && rep.chart && rep.avgRows.length === 3, rep);
    check("report hides the shared note but keeps single notes", rep.sharedNoteHidden && rep.walkNote, rep);
    check("report is hidden on screen", await js(`return getComputedStyle(document.getElementById("report")).display === "none"`));

    // What it looks like on paper (A4-ish width), in dark mode to prove it prints light
    await send("Emulation.setEmulatedMedia", { media: "print", features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await send("Emulation.setDeviceMetricsOverride", { width: 760, height: 1100, deviceScaleFactor: 1, mobile: false });
    check("on paper only the report shows", await js(`return getComputedStyle(document.querySelector("main")).display === "none" && getComputedStyle(document.getElementById("report")).display === "block"`));
    await shot("15-report-print");
    const pdf = await send("Page.printToPDF", { printBackground: true, paperWidth: 8.27, paperHeight: 11.69 });
    if (pdf.data) save("report.pdf", pdf.data);
    check("PDF renders", !!pdf.data && pdf.data.length > 10000);

    await send("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await send("Emulation.setDeviceMetricsOverride", PHONE);
    await js(`document.getElementById("report-card").scrollIntoView({ block: "center" })`);
    await shot("16-report-card-dark", false);
}
