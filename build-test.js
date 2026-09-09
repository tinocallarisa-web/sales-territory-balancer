/**
 * build-test.js
 *
 * Builds a TEST version of the Cluster Weighted visual.
 * - Adds "_DEBUG" suffix to the GUID in pbiviz.json (matches pbiviz devMode convention)
 * - Runs pbiviz package
 * - Restores pbiviz.json to production state
 *
 * Usage:  node build-test.js
 */

const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PBIVIZ_JSON = path.join(__dirname, "pbiviz.json");
const BACKUP_JSON = path.join(__dirname, "pbiviz.json.bak");

function main() {
    // ── Read & validate ────────────────────────────────────────────────────────
    const original = fs.readFileSync(PBIVIZ_JSON, "utf8");
    const config   = JSON.parse(original);
    const guid     = config?.visual?.guid;

    if (!guid) {
        console.error("ERROR: visual.guid not found in pbiviz.json");
        process.exit(1);
    }

    if (guid.endsWith("_DEBUG")) {
        console.warn("WARNING: pbiviz.json already has _DEBUG suffix — restoring first");
        console.error("Run manually: restore pbiviz.json from backup or git.");
        process.exit(1);
    }

    console.log(`\n[build-test] GUID:    ${guid}`);
    console.log(`[build-test] Version: ${config.visual.version}`);
    console.log(`[build-test] Patching GUID → ${guid}_DEBUG\n`);

    // ── Backup ─────────────────────────────────────────────────────────────────
    fs.writeFileSync(BACKUP_JSON, original, "utf8");

    // ── Patch ──────────────────────────────────────────────────────────────────
    config.visual.guid = guid + "_DEBUG";
    fs.writeFileSync(PBIVIZ_JSON, JSON.stringify(config, null, 4), "utf8");

    // ── Build ──────────────────────────────────────────────────────────────────
    let buildOk = false;
    try {
        execSync("npx pbiviz package", { stdio: "inherit", cwd: __dirname });
        buildOk = true;
    } catch (err) {
        console.error("\n[build-test] pbiviz package FAILED");
    } finally {
        // ── Restore ALWAYS ──────────────────────────────────────────────────────
        fs.writeFileSync(PBIVIZ_JSON, original, "utf8");
        fs.unlinkSync(BACKUP_JSON);
        console.log("\n[build-test] pbiviz.json restored to production state.");
    }

    if (!buildOk) process.exit(1);

    console.log("\n✅ TEST build complete. Import the .pbiviz from /dist into Power BI Desktop.");
    console.log("   When ready to release, run: npx pbiviz package  (production build)\n");
}

main();
