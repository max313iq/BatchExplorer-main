/* Junction the workspace packages into root or web/ node_modules so
 * Node/webpack can resolve `@azure/bonito-core`, `@batch/ui-react`, etc.
 * Avoids `lerna bootstrap` (broken on Node v24).
 *
 * Usage:
 *   node eng/scripts/link-workspaces.js          # root
 *   node eng/scripts/link-workspaces.js web      # web/node_modules
 */
const fs = require("fs");
const path = require("path");

const target = process.argv[2] || "";
const baseDir = target ? path.resolve(target, "node_modules") : path.resolve("node_modules");

const links = {
    "@azure/bonito-core": "packages/bonito-core",
    "@azure/bonito-ui": "packages/bonito-ui",
    "@batch/ui-react": "packages/react",
    "@batch/ui-service": "packages/service",
    "@batch/ui-playground": "packages/playground",
    "@batch/common-config": "util/common-config",
};

for (const [scope, src] of Object.entries(links)) {
    const linkPath = path.resolve(baseDir, scope);
    const srcAbs = path.resolve(src);
    if (!fs.existsSync(srcAbs)) {
        console.log("skip (missing source)", src);
        continue;
    }
    const dir = path.dirname(linkPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true });
    fs.symlinkSync(srcAbs, linkPath, "junction");
    console.log("linked", linkPath, "->", src);
}
console.log("done");
