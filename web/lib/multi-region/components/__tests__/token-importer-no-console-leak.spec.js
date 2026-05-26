/**
 * Regression test: the Token Importer page must not contain ANY in-app code
 * path that logs a full bearer token. The page does ship a "portal-side
 * snippet" string (PORTAL_SNIPPET) that operators paste into the Azure
 * Portal's DevTools; that snippet runs in the PORTAL's console, not ours,
 * but we still want to keep it from logging full token strings so the
 * portal log doesn't end up on a colleague's shoulder-surf screencap.
 *
 * What the test checks:
 *   - No `console.log(t)` in the snippet (where `t` is the full token).
 *   - No `console.log(<JWT-shaped variable>)` anywhere else in the file.
 *   - Any logging line under `dedup.forEach` only logs `.slice(0, N)`.
 *
 * The token-importer page is huge — we read the source as text and scan
 * with regex rather than mounting the React tree, both because a full
 * mount needs heavy mocks (msal-auth, store, etc.) and because the leak
 * vector is purely textual.
 */
import * as fs from "fs";
import * as path from "path";
const TOKEN_IMPORTER_PATH = path.resolve(__dirname, "..", "token-importer", "token-importer-page.tsx");
describe("token-importer-page.tsx: no bearer-token console leak", () => {
    const source = fs.readFileSync(TOKEN_IMPORTER_PATH, "utf8");
    it("does not log a raw `t` token variable to console", () => {
        // Match `console.log(t)` or `console.log(t,` (i.e. logging the bare
        // variable with no slice / mask). Allow `console.log("..." + t.slice(...))`
        // and other transformed forms.
        const rawTokenLog = /console\.(log|info|warn|error)\s*\(\s*t\s*[,)]/;
        expect(source).not.toMatch(rawTokenLog);
    });
    it("does not log a raw `token` / `accessToken` / `refreshToken` variable", () => {
        // Forbid `console.log(token)` etc. We deliberately allow words like
        // `token.slice(...)` or `token.length`.
        const badLogs = [
            /console\.\w+\(\s*token\s*[,)]/,
            /console\.\w+\(\s*accessToken\s*[,)]/,
            /console\.\w+\(\s*refreshToken\s*[,)]/,
            /console\.\w+\(\s*bearerToken\s*[,)]/,
            /console\.\w+\(\s*idToken\s*[,)]/,
        ];
        for (const re of badLogs) {
            expect(source).not.toMatch(re);
        }
    });
    it("portal snippet logs only previews, never full tokens", () => {
        var _a;
        // Locate the PORTAL_SNIPPET template literal block and scan its
        // body. The snippet runs inside the operator's portal.azure.com tab
        // so its console output is just as sensitive as ours.
        const snippetMatch = source.match(/const\s+PORTAL_SNIPPET\s*=\s*String\.raw`([\s\S]*?)`;/);
        expect(snippetMatch).not.toBeNull();
        const snippet = snippetMatch[1];
        // Any `forEach` loop over `dedup` must call `.slice(` on its arg.
        const forEachLines = (_a = snippet.match(/dedup\.forEach\([^)]*\)/g)) !== null && _a !== void 0 ? _a : [];
        for (const line of forEachLines) {
            // Lines that don't slice are only OK if they're side-effect free.
            // We're conservative — every dedup.forEach with console must slice.
            if (line.includes("console")) {
                expect(line).toMatch(/\.slice\(/);
            }
        }
    });
});
//# sourceMappingURL=token-importer-no-console-leak.spec.js.map