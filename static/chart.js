// Trend chart for Pulse & Pressure. Loaded after data.js and before app.js,
// which calls renderChart() and provides chartData, options, bpText and whenText.
// The doctor report draws the same chart with drawChart().

// ---------- Trend chart (plain SVG, no library, works offline) ----------
const SVG_NS = "http://www.w3.org/2000/svg";

// Where AHA's high range starts (stage 1). The chart's dashed lines show this,
// or the person's own target from their doctor when they have one.
const HIGH_FROM = { systolic: 130, diastolic: 80 };

function svgEl(tag, attrs, parent, text) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    if (text !== undefined) el.textContent = text;
    parent.appendChild(el);
    return el;
}

function niceRange(values, step) {
    const lo = Math.floor(Math.min(...values) / step) * step;
    let hi = Math.ceil(Math.max(...values) / step) * step;
    if (hi === lo) hi += step;
    return [lo, hi];
}

function renderReadout(i) {
    const box = $("readout");
    box.replaceChildren();
    const r = chartData[i === null ? chartData.length - 1 : i];
    if (!r) return;
    const value = document.createElement("span");
    value.className = "big";
    value.textContent = bpText(r);
    const meta = document.createElement("span");
    meta.className = "muted";
    const cat = r.category ? " · " + options.categories[r.category] : "";
    meta.textContent = (i === null ? "Latest · " : "") + whenText(r.taken_at) + cat;
    box.append(value, meta);
}

// Draws readings (oldest first) into an <svg>, placed along the bottom by their
// actual time, so a two-week gap looks like one. reference is the dashed lines'
// { systolic, diastolic }. Returns what the pointer handlers need: the x
// position of each reading and the plot's edges.
function drawChart(svg, data, width, reference) {
    reference = reference || HIGH_FROM;
    svg.replaceChildren();
    const left = 34, right = 38;  // room for tick labels and end labels
    const plotW = width - left - right;
    const bpTop = 22, bpH = 170, pulseTop = bpTop + bpH + 36, pulseH = 90;
    const height = pulseTop + pulseH + 26;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);

    const times = data.map((r) => new Date(r.taken_at).getTime());
    const t0 = times[0], t1 = times[times.length - 1];
    const xs = times.map((t) => (t1 === t0 ? left + plotW / 2 : left + (t - t0) / (t1 - t0) * plotW));
    const dense = data.length > 60;

    // Two panels on separate scales: mmHg and bpm are different units
    const panels = [
        { top: bpTop, h: bpH, title: "Blood pressure (mmHg)", series: [["systolic", "sys"], ["diastolic", "dia"]], lines: [reference.systolic, reference.diastolic] },
        { top: pulseTop, h: pulseH, title: "Pulse (bpm)", series: [["pulse", "pulse"]], lines: [] },
    ];
    panels.forEach((p) => {
        svgEl("text", { x: left, y: p.top - 10, class: "panel-title" }, svg, p.title);
        const values = p.series.flatMap(([key]) => data.map((r) => r[key])).filter((v) => v !== null);
        if (!values.length) {
            svgEl("text", { x: left, y: p.top + p.h / 2, class: "axis-text" }, svg, "Nothing logged");
            return;
        }
        const scaleValues = values.concat(p.lines);  // keep the reference lines in view
        let step = 20;
        let [lo, hi] = niceRange(scaleValues, step);
        if ((hi - lo) / step > Math.floor(p.h / 24)) { step = 40; [lo, hi] = niceRange(scaleValues, step); }
        const y = (v) => p.top + p.h - (v - lo) / (hi - lo) * p.h;

        for (let v = lo; v <= hi; v += step) {
            svgEl("line", { x1: left, x2: width - right, y1: y(v), y2: y(v), class: "gridline" }, svg);
            svgEl("text", { x: left - 6, y: y(v) + 4, "text-anchor": "end", class: "axis-text" }, svg, v);
        }
        p.lines.forEach((v) => {
            svgEl("line", { x1: left, x2: width - right, y1: y(v), y2: y(v), class: "refline" }, svg);
        });

        p.series.forEach(([key, cls]) => {
            let d = "";
            let penDown = false;
            let lastTime = null;
            data.forEach((r, i) => {
                if (r[key] === null) { penDown = false; return; }  // leave a gap for missing values
                // Don't draw a line across more than a week with no readings
                if (lastTime !== null && times[i] - lastTime > 7 * 86400000) penDown = false;
                lastTime = times[i];
                d += (penDown ? "L" : "M") + xs[i].toFixed(1) + " " + y(r[key]).toFixed(1);
                penDown = true;
            });
            svgEl("path", { d, class: "line " + cls }, svg);
            let last = -1;
            data.forEach((r, i) => {
                if (r[key] === null) return;
                svgEl("circle", { cx: xs[i], cy: y(r[key]), r: dense ? 2.5 : 4, class: "mark " + cls }, svg);
                last = i;
            });
            svgEl("text", { x: xs[last] + 8, y: y(data[last][key]) + 4, class: "end-label" }, svg, data[last][key]);
        });
    });

    const dateOpts = { month: "short", day: "numeric" };
    const axisY = pulseTop + pulseH + 18;
    svgEl("text", { x: left, y: axisY, class: "axis-text" }, svg,
        new Date(data[0].taken_at).toLocaleDateString([], dateOpts));
    svgEl("text", { x: width - right, y: axisY, "text-anchor": "end", class: "axis-text" }, svg,
        new Date(data[data.length - 1].taken_at).toLocaleDateString([], dateOpts));

    return { xs, height, top: bpTop, bottom: pulseTop + pulseH };
}

function renderChart() {
    const data = chartData;
    const svg = $("chart");
    const enough = data.length >= 2;
    $("chart-wrap").hidden = !enough;
    if (!enough) { svg.replaceChildren(); return; }

    const width = $("chart-wrap").clientWidth || 600;
    const { xs, height, top, bottom } = drawChart(svg, data, width, targetFor(profileId));

    // Crosshair: snaps to the reading nearest the pointer
    const cross = svgEl("line", { y1: top, y2: bottom, class: "crosshair", visibility: "hidden" }, svg);
    const hit = svgEl("rect", { x: 0, y: 0, width, height, fill: "transparent" }, svg);
    let current = null;
    const show = (i) => {
        current = i;
        if (i === null) {
            cross.setAttribute("visibility", "hidden");
        } else {
            cross.setAttribute("x1", xs[i]);
            cross.setAttribute("x2", xs[i]);
            cross.setAttribute("visibility", "visible");
        }
        renderReadout(i);
    };
    const indexAt = (e) => {
        const rect = svg.getBoundingClientRect();
        const px = (e.clientX - rect.left) * width / rect.width;
        let best = 0;
        xs.forEach((x, i) => { if (Math.abs(x - px) < Math.abs(xs[best] - px)) best = i; });
        return best;
    };
    hit.onpointermove = (e) => show(indexAt(e));
    hit.onpointerdown = (e) => show(indexAt(e));
    hit.onpointerleave = (e) => { if (e.pointerType === "mouse") show(null); };
    svg.onkeydown = (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const start = current === null ? data.length - 1 : current;
        show(Math.min(Math.max(start + (e.key === "ArrowRight" ? 1 : -1), 0), data.length - 1));
    };
    svg.onblur = () => show(null);
    show(null);
}
