// Browser tests: serves static/ locally, starts headless Chrome (or Edge or
// Chromium) and runs each tests/browser/*.scenario.mjs in its own fresh tab.
// No packages needed, just Node 22 and a Chromium-based browser.
//
//   node tests/browser/run.mjs                 run every scenario
//   node tests/browser/run.mjs report          run only scenarios whose name contains "report"
//   node tests/browser/run.mjs --shots <dir>   save screenshots to <dir>
//
// The browser is found through the CHROME_PATH environment variable, or the usual
// install places on Windows, macOS and Linux. Screenshots go to a new folder in the
// system temp folder unless --shots is given. Exits with 1 if any check fails.
//
// A scenario file exports a default async function that receives the helpers from
// openPage() in cdp.mjs, and may export `timeout` (ms) to change its time limit.
// Scenario files are named *.scenario.mjs so `node --test` doesn't pick them up.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, openPage, sleep, withTimeout } from "./cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.resolve(HERE, "..", "..", "static");
const DEFAULT_TIMEOUT = 120000;

// ---------- Command line ----------
function parseArgs(argv) {
    const opts = { filters: [], shots: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--shots") {
            opts.shots = argv[++i];
            if (!opts.shots) usage("--shots needs a folder");
        } else if (a.startsWith("--shots=")) {
            opts.shots = a.slice("--shots=".length);
        } else if (a === "-h" || a === "--help") {
            usage();
        } else if (a.startsWith("-")) {
            usage(`Unknown option ${a}`);
        } else {
            opts.filters.push(a.toLowerCase());
        }
    }
    return opts;
}

function usage(problem) {
    if (problem) console.error(problem + "\n");
    console.log("Usage: node tests/browser/run.mjs [name filter...] [--shots <dir>]");
    process.exit(problem ? 2 : 0);
}

// ---------- Static file server ----------
const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
};

function startServer(root) {
    const server = http.createServer(async (req, res) => {
        const reply = (code, text) => {
            res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(text);
        };
        try {
            if (req.method !== "GET" && req.method !== "HEAD") return reply(405, "Method not allowed");
            const { pathname } = new URL(req.url, "http://localhost");
            let file = path.join(root, decodeURIComponent(pathname));
            if (file !== root && !file.startsWith(root + path.sep)) return reply(403, "Forbidden");
            let info = await stat(file).catch(() => null);
            if (info?.isDirectory()) {
                file = path.join(file, "index.html");
                info = await stat(file).catch(() => null);
            }
            if (!info?.isFile()) return reply(404, "Not found");
            const body = await readFile(file);
            res.writeHead(200, {
                "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
                "Content-Length": body.length,
                "Cache-Control": "no-cache",
            });
            res.end(req.method === "HEAD" ? undefined : body);
        } catch (e) {
            reply(500, String(e));
        }
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

// ---------- Finding and starting the browser ----------
function findBrowser() {
    const fromEnv = process.env.CHROME_PATH;
    if (fromEnv) {
        if (existsSync(fromEnv)) return fromEnv;
        throw new Error(`CHROME_PATH is set to "${fromEnv}", but there is no file there.`);
    }
    const candidates = [];
    if (process.platform === "win32") {
        const bases = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
        for (const app of ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe", "Chromium\\Application\\chrome.exe"]) {
            for (const base of bases) candidates.push(path.join(base, app));
        }
    } else if (process.platform === "darwin") {
        const bases = ["/Applications", path.join(os.homedir(), "Applications")];
        for (const app of ["Google Chrome.app/Contents/MacOS/Google Chrome", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Chromium.app/Contents/MacOS/Chromium"]) {
            for (const base of bases) candidates.push(path.join(base, app));
        }
    } else {
        const dirs = [...(process.env.PATH || "").split(path.delimiter).filter(Boolean), "/usr/bin", "/usr/local/bin", "/snap/bin"];
        for (const name of ["google-chrome", "google-chrome-stable", "microsoft-edge", "microsoft-edge-stable", "chromium", "chromium-browser"]) {
            for (const dir of dirs) candidates.push(path.join(dir, name));
        }
        candidates.push("/opt/google/chrome/chrome", "/opt/microsoft/msedge/msedge");
    }
    const found = candidates.find((file) => existsSync(file));
    if (!found) throw new Error("No Chrome, Edge or Chromium found. Set CHROME_PATH to the browser's executable.");
    return found;
}

async function startBrowser(executable) {
    // Keep the profile path short: a long one broke Chrome's CacheStorage on
    // Windows ("Unexpected internal error"), so the service worker couldn't install.
    const profile = mkdtempSync(path.join(os.tmpdir(), "pp-"));
    const args = [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--hide-scrollbars",
        "--mute-audio",
    ];
    // Chrome refuses to start as root (e.g. in Docker) unless the sandbox is off
    if (process.getuid?.() === 0) args.push("--no-sandbox");
    args.push("about:blank");

    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    const browser = { child, profile, port: null, exited: false };
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => { if (stderr.length < 20000) stderr += text; });
    child.on("exit", () => { browser.exited = true; });
    child.on("error", (e) => { browser.exited = true; stderr += String(e); });

    // The port is written to DevToolsActivePort in the profile, and to stderr
    const portFile = path.join(profile, "DevToolsActivePort");
    const end = Date.now() + 30000;
    while (!browser.port) {
        if (browser.exited) throw Object.assign(new Error(`The browser quit while starting.\n${stderr.trim()}`), { browser });
        if (Date.now() > end) throw Object.assign(new Error(`The browser didn't open its debugging port.\n${stderr.trim()}`), { browser });
        try {
            const port = Number(readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
            if (port > 0) browser.port = port;
        } catch { /* not written yet */ }
        const match = stderr.match(/DevTools listening on ws:\/\/[^:/]+:(\d+)\//);
        if (!browser.port && match) browser.port = Number(match[1]);
        if (!browser.port) await sleep(100);
    }
    return browser;
}

async function stopBrowser(browser) {
    if (!browser) return;
    if (!browser.exited && browser.port) {
        // Close it politely first, so it lets go of the profile folder
        try {
            const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${browser.port}/json/version`)).json();
            const cdp = await connect(webSocketDebuggerUrl);
            cdp.send("Browser.close").catch(() => { });
        } catch { /* already gone */ }
        for (let i = 0; i < 50 && !browser.exited; i++) await sleep(100);
    }
    if (!browser.exited) {
        browser.child.kill("SIGKILL");
        for (let i = 0; i < 20 && !browser.exited; i++) await sleep(100);
    }
    try {
        rmSync(browser.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
        console.warn(`Couldn't remove the browser profile ${browser.profile}: ${e.message}`);
    }
}

// ---------- Running the scenarios ----------
function findScenarios(filters) {
    const all = readdirSync(HERE)
        .filter((f) => f.endsWith(".scenario.mjs"))
        .sort()
        .map((f) => ({ name: f.slice(0, -".scenario.mjs".length), file: path.join(HERE, f) }));
    const chosen = filters.length ? all.filter((s) => filters.some((f) => s.name.toLowerCase().includes(f))) : all;
    if (!chosen.length) {
        console.error(`No scenario matches "${filters.join(" ")}". Scenarios: ${all.map((s) => s.name).join(", ")}`);
        process.exit(2);
    }
    return chosen;
}

async function runScenario(scenario, { debugPort, site, shotDir }) {
    console.log(`\n${scenario.name}`);
    let page;
    try {
        const mod = await import(pathToFileURL(scenario.file).href);
        if (typeof mod.default !== "function") throw new Error("the file has no default export function");
        page = await openPage({ debugPort, site, shotDir });
        await withTimeout(mod.default(page), mod.timeout ?? DEFAULT_TIMEOUT, scenario.name);
        page.check("no page errors", page.errors.length === 0, page.errors);
        return page.results;
    } catch (e) {
        const results = page?.results || { passed: 0, failed: 0 };
        results.failed++;
        console.log(`  FAIL ${scenario.name} stopped early  -> ${e.timedOut ? e.message : e.stack || e.message}`);
        if (page?.errors.length) console.log(`       page errors: ${JSON.stringify(page.errors)}`);
        return results;
    } finally {
        await page?.close().catch(() => { });
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const scenarios = findScenarios(opts.filters);
    const shotDir = opts.shots
        ? path.resolve(opts.shots)
        : path.join(os.tmpdir(), "pp-shots-" + new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-"));

    let server;
    let browser;
    let stopping = false;
    const cleanup = async () => {
        if (stopping) return;
        stopping = true;
        await stopBrowser(browser);
        if (server) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    };
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, async () => {
            console.log(`\nStopping (${signal})...`);
            await cleanup();
            process.exit(130);
        });
    }

    const summary = [];
    try {
        const executable = findBrowser();
        server = await startServer(STATIC);
        const site = `http://localhost:${server.address().port}/`;
        try {
            browser = await startBrowser(executable);
        } catch (e) {
            browser = e.browser;
            throw e;
        }
        mkdirSync(shotDir, { recursive: true });
        console.log(`Browser: ${executable}`);
        console.log(`Site:    ${site} (serving ${STATIC})`);
        for (const scenario of scenarios) {
            const results = await runScenario(scenario, { debugPort: browser.port, site, shotDir });
            summary.push({ name: scenario.name, ...results });
        }
    } catch (e) {
        console.error(`\nCouldn't run the browser tests: ${e.message}`);
        summary.push({ name: "setup", passed: 0, failed: 1 });
    } finally {
        await cleanup();
    }

    const width = Math.max(...summary.map((s) => s.name.length));
    const failed = summary.reduce((n, s) => n + s.failed, 0);
    const passed = summary.reduce((n, s) => n + s.passed, 0);
    console.log("\nSummary");
    for (const s of summary) {
        console.log(`  ${s.failed ? "FAIL" : "ok  "} ${s.name.padEnd(width)}  ${s.passed} passed${s.failed ? `, ${s.failed} failed` : ""}`);
    }
    if (existsSync(shotDir)) console.log(`Screenshots: ${shotDir}`);
    console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASSED (${passed} checks)`);
    process.exit(failed ? 1 : 0);
}

main();
