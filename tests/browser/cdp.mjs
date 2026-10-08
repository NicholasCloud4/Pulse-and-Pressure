// Small helpers for driving a page in Chrome over the DevTools protocol, using
// Node 22's built-in fetch and WebSocket (no packages). run.mjs uses openPage()
// to give each scenario a fresh tab and the helpers it needs.
import { writeFileSync } from "node:fs";
import path from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The phone-sized screen every scenario starts with
export const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };

// Rejects if `promise` hasn't settled within `ms`
export function withTimeout(promise, ms, what) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms / 1000}s`), { timedOut: true })), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Opens a DevTools WebSocket. send() resolves with the command's result and
// rejects on a protocol error or when the connection closes.
export async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new Error(`Could not connect to ${wsUrl}`)), { once: true });
    });
    let nextId = 1;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id !== undefined) {
            const call = pending.get(msg.id);
            if (!call) return;
            pending.delete(msg.id);
            if (msg.error) call.reject(new Error(`${call.method}: ${msg.error.message}`));
            else call.resolve(msg.result);
            return;
        }
        for (const fn of listeners.get(msg.method) || []) fn(msg.params);
    });
    ws.addEventListener("close", () => {
        for (const call of pending.values()) call.reject(new Error(`${call.method}: the connection closed`));
        pending.clear();
    });

    const send = (method, params = {}) => new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
            reject(new Error(`${method}: the connection is closed`));
            return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params }));
    });
    const on = (method, fn) => {
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(fn);
        return () => listeners.get(method).delete(fn);
    };
    // Waits for the next `method` event. Call it before the command that triggers it.
    const once = (method, ms = 15000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            off();
            reject(new Error(`no ${method} event within ${ms / 1000}s`));
        }, ms);
        const off = on(method, (params) => {
            clearTimeout(timer);
            off();
            resolve(params);
        });
    });
    return { send, on, once, close: () => ws.close() };
}

// Opens a fresh tab with the site's stored data (localStorage, caches, service
// workers) wiped, at phone size. Returns the helpers a scenario receives:
//   site                 the app's address, e.g. http://localhost:51234/
//   send(method, params) a raw DevTools command; resolves with its result
//   js(body)             runs `body` in the page as an async function; returns its value
//   waitFor(body, ms)    re-runs js(body) until it returns something truthy
//   check(name, ok, detail)  records a PASS/FAIL line
//   shot(name, full)     saves a screenshot <name>.png to the screenshot folder
//   save(name, base64)   saves any other file there (e.g. a PDF)
//   navigate(url) / reload(params)  load a page and wait for it to finish
//   sleep(ms), errors (uncaught page errors and console.error messages)
export async function openPage({ debugPort, site, shotDir, settle = 300 }) {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" });
    if (!res.ok) throw new Error(`Chrome would not open a tab (HTTP ${res.status})`);
    const target = await res.json();
    const cdp = await connect(target.webSocketDebuggerUrl);
    const { send } = cdp;

    const errors = [];
    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => errors.push(d.exception?.description || d.text));
    cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
        if (type === "error") errors.push(args.map((a) => a.value ?? a.description).join(" "));
    });

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Storage.clearDataForOrigin", { origin: new URL(site).origin, storageTypes: "all" });
    await send("Emulation.setDeviceMetricsOverride", PHONE);

    const results = { passed: 0, failed: 0 };
    function check(name, ok, detail) {
        if (ok) results.passed++;
        else results.failed++;
        console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
    }

    async function js(body) {
        const r = await send("Runtime.evaluate", {
            expression: `(async () => { ${body} })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        if (r.exceptionDetails) {
            const d = r.exceptionDetails;
            throw new Error(`in page: ${d.exception?.description || d.text}`);
        }
        return r.result.value;
    }

    async function waitFor(body, ms = 5000) {
        const end = Date.now() + ms;
        let value;
        do {
            value = await js(body);
            if (value) return value;
            await sleep(100);
        } while (Date.now() < end);
        return value;
    }

    async function load(method, params) {
        const loaded = cdp.once("Page.loadEventFired");
        const r = await send(method, params);
        if (r?.errorText) throw new Error(`${method} failed: ${r.errorText}`);
        await loaded;
        await sleep(settle);
    }

    async function shot(name, full = true) {
        await sleep(300);
        const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
        save(`${name}.png`, r.data);
    }

    function save(name, base64) {
        writeFileSync(path.join(shotDir, name), Buffer.from(base64, "base64"));
    }

    async function close() {
        cdp.close();
        await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`).catch(() => { });
    }

    return {
        site,
        send,
        on: cdp.on,
        js,
        waitFor,
        check,
        shot,
        save,
        sleep,
        errors,
        results,
        navigate: (url = site) => load("Page.navigate", { url }),
        reload: (params = {}) => load("Page.reload", params),
        close,
    };
}
