/* eslint-env node */
/* eslint-disable no-console, @typescript-eslint/no-var-requires */

/**
 * Cross-browser shared MSAL cache.
 *
 * Why: each browser profile has its own localStorage, so the WebUI's
 * MSAL cache (which holds account records and refresh tokens) is
 * scoped per-browser. If you sign in from Chrome and reload from
 * Firefox, the Firefox session sees nothing. The dev-server holds a
 * single JSON blob that every browser hydrates from on load and pushes
 * back to on every cache mutation. After the first sign-in from any
 * browser, every other browser sees the same account list.
 *
 * Storage: a single JSON file under `web/dev-server/.shared-msal-cache.json`,
 * gitignored. Reads and writes are full-snapshot — no per-key API. The
 * client decides which keys to ship by filtering on prefix (`msal.`,
 * `azbm.`).
 *
 * Concurrency: last-write-wins. The dev-server is single-threaded so
 * writes are atomic per request, but two browsers writing at the same
 * time will see one overwrite the other. For the WebUI's account list
 * this is acceptable — the next read from each browser converges.
 *
 * Security: tokens land in the JSON file. This is a DEV-ONLY feature.
 * Don't ship it to a publicly-routed environment without auth on the
 * /api/auth/shared-cache route.
 */

const fs = require("fs");
const path = require("path");

const CACHE_PATH = path.join(__dirname, ".shared-msal-cache.json");
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB cap — MSAL tends to stay under 1 MiB even with many accounts

function readBody(req) {
    return new Promise((resolve, reject) => {
        let buf = "";
        req.on("data", (chunk) => {
            buf += chunk.toString();
            if (buf.length > MAX_BODY_BYTES) {
                reject(new Error("Body too large"));
            }
        });
        req.on("end", () => resolve(buf));
        req.on("error", reject);
    });
}

function readSnapshot() {
    try {
        if (!fs.existsSync(CACHE_PATH)) return {};
        const raw = fs.readFileSync(CACHE_PATH, "utf-8");
        if (!raw) return {};
        return JSON.parse(raw);
    } catch (err) {
        console.warn(
            "[shared-msal-cache] read failed — returning empty:",
            err && err.message,
        );
        return {};
    }
}

function writeSnapshot(snapshot) {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(snapshot), "utf-8");
}

function registerSharedMsalCache(devServer) {
    console.log(
        "[shared-msal-cache] endpoints registered at /api/auth/shared-cache (dev-only — tokens land on disk)",
    );

    // GET — full snapshot. Used by every browser on app load to seed
    // localStorage before MSAL initializes.
    devServer.app.get("/api/auth/shared-cache", (_req, res) => {
        try {
            res.json(readSnapshot());
        } catch (err) {
            res.status(500).json({
                error: (err && err.message) || "read_failed",
            });
        }
    });

    // PUT — replace snapshot. Client sends the entire intended state of
    // its localStorage subset (msal.* + azbm.*). Last-write-wins across
    // browsers; the WebUI debounces these so a burst of MSAL writes
    // collapses into a single PUT.
    devServer.app.put("/api/auth/shared-cache", async (req, res) => {
        let raw;
        try {
            raw = await readBody(req);
        } catch (err) {
            return res.status(413).json({
                error: (err && err.message) || "body_too_large",
            });
        }
        let parsed;
        try {
            parsed = raw ? JSON.parse(raw) : {};
        } catch {
            return res.status(400).json({ error: "invalid_json" });
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return res
                .status(400)
                .json({ error: "expected_object_at_top_level" });
        }
        // Defence in depth: only persist keys the WebUI's contract
        // promised. Anything else is silently dropped so a misbehaving
        // extension or stray test write can't smuggle arbitrary keys.
        // Two MSAL prefix shapes exist: `msal.<...>` for metadata and
        // `msal|<version>|<...>` for actual account/token records —
        // both must be allowed.
        const filtered = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof k !== "string" || typeof v !== "string") continue;
            if (
                k.startsWith("msal.") ||
                k.startsWith("msal|") ||
                k.startsWith("azbm.")
            ) {
                filtered[k] = v;
            }
        }
        try {
            writeSnapshot(filtered);
            res.json({ ok: true, keys: Object.keys(filtered).length });
        } catch (err) {
            res.status(500).json({
                error: (err && err.message) || "write_failed",
            });
        }
    });

    // DELETE — wipe the snapshot. Used by the WebUI's logout flow so a
    // sign-out from any browser propagates. Same auth-scope caveat as
    // PUT: dev-only.
    devServer.app.delete("/api/auth/shared-cache", (_req, res) => {
        try {
            if (fs.existsSync(CACHE_PATH)) {
                fs.unlinkSync(CACHE_PATH);
            }
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({
                error: (err && err.message) || "delete_failed",
            });
        }
    });
}

module.exports = { registerSharedMsalCache };
