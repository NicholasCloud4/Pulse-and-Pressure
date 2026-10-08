// The app installs to the home screen, opens offline, shows the right install card
// on Android and iPhone, and won't overwrite data saved by a newer version.
export default async function install({ js, waitFor, check, shot, sleep, send, navigate, reload }) {
    await send("Network.enable");
    await navigate();
    await js(`localStorage.clear()`);
    await reload();

    const manifest = await send("Page.getAppManifest");
    check("manifest loads without errors", manifest.errors.length === 0 && !!manifest.data?.includes("Pulse"), manifest.errors);
    const sw = await js(`try {
        const reg = await navigator.serviceWorker.register("sw.js");
        for (let i = 0; i < 50 && !reg.active; i++) await new Promise((r) => setTimeout(r, 100));
        return { active: !!reg.active, installing: !!reg.installing, waiting: !!reg.waiting, secure: isSecureContext };
      } catch (e) { return { error: e.message }; }`);
    check("service worker is active", sw && sw.active === true, sw);
    await sleep(1000);
    const inst = await send("Page.getInstallabilityErrors");
    check("Chrome says it's installable", (inst.installabilityErrors || []).length === 0, inst.installabilityErrors);
    const cached = await js(`const c = await caches.open((await caches.keys())[0]); return (await c.keys()).length`);
    check("app files are saved for offline use", cached >= 11, cached);

    // Add a person and a reading, then go offline and reload
    await js(`document.getElementById("welcome-name").value = "Ann"; document.getElementById("welcome-form").requestSubmit();
      document.getElementById("q-systolic").value = "121"; document.getElementById("q-diastolic").value = "79"; document.getElementById("q-save").click();`);
    await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await reload({ ignoreCache: false });
    check("opens offline with the readings", await waitFor(`return !document.getElementById("person-view").hidden && document.getElementById("recent").textContent.includes("121/79")`));
    check("chart script works offline", await js(`return typeof renderChart === "function"`));
    await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    // Chrome on Android offers its own install prompt, which the app turns into an Install button.
    // (The iPhone user agent below doesn't stop headless Chrome from firing that prompt.)
    await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
    await reload();
    check("Android-style install prompt shows an Install button", await waitFor(`return installPrompt !== null && !document.getElementById("install").hidden && !document.getElementById("install-go").hidden`));
    // Safari on iPhone never fires beforeinstallprompt
    const ios = await js(`installPrompt = null; renderInstall(); try { const c = document.getElementById("install"); return { ua: navigator.userAgent.slice(0, 40), apple: isApple, installed: isInstalled(), shown: !c.hidden, text: c.textContent.includes("Add to Home Screen"), move: !document.getElementById("install-move").hidden, go: !document.getElementById("install-go").hidden, profile: profileId }; } catch (e) { return { error: e.message }; }`);
    check("iPhone sees the Add to Home Screen card", ios && ios.shown && ios.text && ios.move && !ios.go, ios);
    await js(`document.getElementById("install").scrollIntoView()`);
    await shot("12-install-iphone", false);
    await js(`document.getElementById("install-later").click()`);
    check("Not now hides it", await js(`return document.getElementById("install").hidden`));

    // Newer saved data is refused rather than overwritten
    const version = await js(`return JSON.parse(localStorage.getItem("pulse-pressure-data")).version`);
    check("stored data has the app's version", version === (await js(`return DATA_VERSION`)) && version >= 1, version);
    await js(`const d = JSON.parse(localStorage.getItem("pulse-pressure-data")); d.version = 99; localStorage.setItem("pulse-pressure-data", JSON.stringify(d));`);
    await reload();
    check("data from a newer version is not touched", await js(`return !document.getElementById("storage-error").hidden && JSON.parse(localStorage.getItem("pulse-pressure-data")).version === 99`));
}
