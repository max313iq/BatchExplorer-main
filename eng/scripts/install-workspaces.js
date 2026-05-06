/* Per-workspace npm install. Strips @azure/bonito-* and @batch/* deps
 * from each workspace's package.json before installing (those are local
 * workspace packages, not in the npm registry — npm would fail to fetch
 * them), then restores the original package.json after install.
 *
 * Avoids `lerna bootstrap` which fails on Node v24 due to nx native
 * module mismatch.
 */
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

// CLI: pass directories as args, OR rely on the default list below.
const targets = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
          "packages/bonito-core",
          "packages/bonito-ui",
          "packages/react",
          "packages/service",
          "packages/playground",
          "util/bux",
          "util/common-config",
      ];

for (const t of targets) {
    const pjPath = path.join(t, "package.json");
    if (!fs.existsSync(pjPath)) {
        console.log("skip", t);
        continue;
    }
    const orig = fs.readFileSync(pjPath, "utf8");
    const pj = JSON.parse(orig);
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
        if (!pj[key]) continue;
        for (const dep of Object.keys(pj[key])) {
            if (dep.startsWith("@azure/bonito-") || dep.startsWith("@batch/")) {
                delete pj[key][dep];
            }
        }
    }
    fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2));
    console.log("installing", t);
    try {
        cp.execSync(
            "npm install --no-audit --no-fund --legacy-peer-deps --ignore-scripts --no-save",
            { cwd: t, stdio: "inherit" }
        );
    } catch (e) {
        fs.writeFileSync(pjPath, orig);
        throw e;
    }
    fs.writeFileSync(pjPath, orig);
}
console.log("done");
