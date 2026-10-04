// Trend chart for Pulse & Pressure. Loaded before app.js, which calls
// renderChart() and provides chartData, options, bpText and whenText.

// ---------- Trend chart (plain SVG, no library, works offline) ----------
const SVG_NS = "http://www.w3.org/2000/svg";

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

function renderChart() {
    const data = chartData;
    const svg = $("chart");
    svg.replaceChildren();
    const enough = data.length >= 2;
    $("chart-empty").hidden = enough;
    $("chart-wrap").hidden = !enough;
    if (!enough) return;

    const width = $("chart-wrap").clientWidth || 600;
    const left = 34, right = 38;  // room for tick labels and end labels
    const plotW = width - left - right;
    const bpTop = 22, bpH = 170, pulseTop = bpTop + bpH + 36, pulseH = 90;
    const height = pulseTop + pulseH + 26;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    const x = (i) => left + i * plotW / (data.length - 1);

    // Two panels on separate scales: mmHg and bpm are different units
    const panels = [
        { top: bpTop, h: bpH, title: "Blood pressure (mmHg)", series: [["systolic", "sys"], ["diastolic", "dia"]] },
        { top: pulseTop, h: pulseH, title: "Pulse (bpm)", series: [["pulse", "pulse"]] },
    ];
    panels.forEach((p) => {
        svgEl("text", { x: left, y: p.top - 10, class: "panel-title" }, svg, p.title);
        const values = p.series.flatMap(([key]) => data.map((r) => r[key])).filter((v) => v !== null);
        if (!values.length) {
            svgEl("text", { x: left, y: p.top + p.h / 2, class: "axis-text" }, svg, "Nothing logged yet");
            return;
        }
        let step = 20;
        let [lo, hi] = niceRange(values, step);
        if ((hi - lo) / step > Math.floor(p.h / 24)) { step = 40; [lo, hi] = niceRange(values, step); }
        const y = (v) => p.top + p.h - (v - lo) / (hi - lo) * p.h;

        for (let v = lo; v <= hi; v += step) {
            svgEl("line", { x1: left, x2: width - right, y1: y(v), y2: y(v), class: "gridline" }, svg);
            svgEl("text", { x: left - 6, y: y(v) + 4, "text-anchor": "end", class: "axis-text" }, svg, v);
        }

        p.series.forEach(([key, cls]) => {
            let d = "";
            let penDown = false;
            data.forEach((r, i) => {
                if (r[key] === null) { penDown = false; return; }  // leave a gap for missing values
                d += (penDown ? "L" : "M") + x(i).toFixed(1) + " " + y(r[key]).toFixed(1);
                penDown = true;
            });
            svgEl("path", { d, class: "line " + cls }, svg);
            let last = -1;
            data.forEach((r, i) => {
                if (r[key] === null) return;
                svgEl("circle", { cx: x(i), cy: y(r[key]), r: 4, class: "mark " + cls }, svg);
                last = i;
            });
            svgEl("text", { x: x(last) + 8, y: y(data[last][key]) + 4, class: "end-label" }, svg, data[last][key]);
        });
    });

    const dateOpts = { month: "short", day: "numeric" };
    const axisY = pulseTop + pulseH + 18;
    svgEl("text", { x: left, y: axisY, class: "axis-text" }, svg,
        new Date(data[0].taken_at).toLocaleDateString([], dateOpts));
    svgEl("text", { x: width - right, y: axisY, "text-anchor": "end", class: "axis-text" }, svg,
        new Date(data[data.length - 1].taken_at).toLocaleDateString([], dateOpts));

    // Crosshair: snaps to the nearest reading under the pointer
    const cross = svgEl("line", { y1: bpTop, y2: pulseTop + pulseH, class: "crosshair", visibility: "hidden" }, svg);
    const hit = svgEl("rect", { x: 0, y: 0, width, height, fill: "transparent" }, svg);
    let current = null;
    const show = (i) => {
        current = i;
        if (i === null) {
            cross.setAttribute("visibility", "hidden");
        } else {
            cross.setAttribute("x1", x(i));
            cross.setAttribute("x2", x(i));
            cross.setAttribute("visibility", "visible");
        }
        renderReadout(i);
    };
    const indexAt = (e) => {
        const rect = svg.getBoundingClientRect();
        const px = (e.clientX - rect.left) * width / rect.width;
        const i = Math.round((px - left) / plotW * (data.length - 1));
        return Math.min(Math.max(i, 0), data.length - 1);
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
