/* eslint-disable no-console */
/**
 * Test build (convencion de la cartera, skill pbiviz-appsource).
 *
 * Produces a .pbiviz for Power BI Desktop with its own GUID suffix, so it can be installed
 * alongside the AppSource build without conflicting with it.
 *
 * The source tree always stays in PRODUCTION state: this script patches, packages and then
 * restores, including on failure. Never commit a patched source.
 *
 *   node build-test.js            Pro tier forced on,          GUID + "_test"
 *   node build-test.js --free     real licence check (Free),   GUID + "_testfree"
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = __dirname;
const VISUAL_TS = path.join(ROOT, "src", "visual.ts");
const PBIVIZ_JSON = path.join(ROOT, "pbiviz.json");
const forceFree = process.argv.includes("--free");

/** Exact text the patcher expects to find, and what it becomes. */
const PATCHES = [];
if (!forceFree) {
    PATCHES.push({
        find: "private isPro = false; // ISPRO_MARKER",
        replace: "private isPro = true; // PATCHED BY build-test.js",
        why: "force the Pro tier on"
    });
}

{
    const d = new Date(), z = n => String(n).padStart(2, "0");
    const stamp = (forceFree ? "testfree " : "test ") + d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()) + " " + z(d.getHours()) + ":" + z(d.getMinutes());
    PATCHES.push({
        find: 'const TEST_STAMP = ""; // TEST_STAMP_MARKER',
        replace: 'const TEST_STAMP = "' + stamp + '"; // PATCHED BY build-test.js',
        why: "build stamp in the corner, to know which build Desktop is running"
    });
}

function fail(message) {
    console.error("\n  x " + message + "\n");
    process.exit(1);
}

function main() {
    console.log("\n  Sales Territory Balancer - TEST build (" + (forceFree ? "Free, real licence" : "Pro forced") + ")\n");

    const originals = {
        visualTs: fs.readFileSync(VISUAL_TS, "utf8"),
        pbivizJson: fs.readFileSync(PBIVIZ_JSON, "utf8")
    };
    let restaurado = false;
    const restore = () => {
        if (restaurado) return;
        restaurado = true;
        fs.writeFileSync(VISUAL_TS, originals.visualTs, "utf8");
        fs.writeFileSync(PBIVIZ_JSON, originals.pbivizJson, "utf8");
        console.log("  <- source restored to production state");
    };
    // Una compilacion INTERRUMPIDA (Ctrl+C, terminal cerrada, proceso cortado) dejaba el fuente
    // parcheado: Pro forzado, GUID con _test y "(TEST)" en el nombre (07-10-2026, dos veces).
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
        try { process.on(sig, () => { restore(); process.exit(130); }); } catch (e) { /* senal no disponible en esta plataforma */ }
    }
    process.on("exit", restore);

    for (const p of PATCHES) {
        if (originals.visualTs.indexOf(p.find) === -1) {
            fail("Patch target not found in src/visual.ts:\n\n      " + p.find + "\n\n" +
                "    Update the PATCHES in build-test.js - do not change the source to fit the script.");
        }
    }

    const pbiviz = JSON.parse(originals.pbivizJson);
    const realGuid = pbiviz.visual.guid;
    if (/_test|_DEBUG/.test(realGuid)) {
        fail("pbiviz.json already carries a test GUID. Restore it before building.");
    }

    let ok = false;
    try {
        let ts = originals.visualTs;
        for (const p of PATCHES) {
            ts = ts.replace(p.find, p.replace);
            console.log("  * " + p.why);
        }
        fs.writeFileSync(VISUAL_TS, ts, "utf8");

        pbiviz.visual.guid = realGuid + (forceFree ? "_testfree" : "_test");
        pbiviz.visual.displayName = pbiviz.visual.displayName + (forceFree ? " (TEST FREE)" : " (TEST)");
        fs.writeFileSync(PBIVIZ_JSON, JSON.stringify(pbiviz, null, 4) + "\n", "utf8");
        console.log("  * GUID " + pbiviz.visual.guid);

        console.log("\n  Packaging...\n");
        execSync("npx pbiviz package", { cwd: ROOT, stdio: "inherit" });
        ok = true;
        console.log("\n  OK Test build created: dist/" + pbiviz.visual.guid + "." + pbiviz.visual.version + ".pbiviz");
        console.log("    This build must never be submitted to AppSource.\n");
    } catch (err) {
        console.error("\n  x Packaging failed: " + (err && err.message ? err.message : err));
    } finally {
        restore();
    }
    if (!ok) { process.exit(1); }
}

main();
