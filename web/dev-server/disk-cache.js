/* eslint-env node */
/* eslint-disable no-console, @typescript-eslint/no-var-requires */

/**
 * Project-file disk cache.
 *
 * Stores arbitrary string blobs under a key, persistent across browser
 * restarts and shared across every browser hitting this dev-server.
 * Used by the VM-catalog cache so the next page load doesn't have to
 * re-fetch ~10 MB of Microsoft.Compute/skus from ARM — the previous
 * snapshot lives on disk and ships in one round-trip.
 *
 * File layout: one JSON file per cache key under
 *   `web/dev-server/.disk-cache/<sanitized-key>.json`
 *
 * Each value is wrapped as `{ ts, expiresAt, payload }` so callers can
 * implement TTLs.
 *
 * Security: dev-only. The endpoints accept arbitrary string payloads
 * with no auth — exposing them on a public network would let any
 * client fill your disk.
 */

const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.join(__dirname, ".disk-cache");
const MAX_KEY_LEN = 128;
const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MiB — VM catalog is ~10 MiB

// Restrict keys to a safe alphabet so a malicious caller can't escape
// into other directories. The leading regex prevents `..` and slashes.
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

function ensureDir() {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch {
        /* parent existence is sufficient */
    }
}

function keyPath(key) {
    return path.join(CACHE_DIR, `${key}.json`);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let buf = "";
        req.on("data", (c) => {
            buf += c.toString();
            if (buf.length > MAX_BODY_BYTES) reject(new Error("Body too large"));
        });
        req.on("end", () => resolve(buf));
        req.on("error", reject);
    });
}

function validKey(k) {
    return typeof k === "string" && k.length > 0 && k.length <= MAX_KEY_LEN && SAFE_KEY.test(k);
}

function registerDiskCache(devServer) {
    ensureDir();
    console.log(
        "[disk-cache] endpoints registered at /api/cache/disk/:key (dev-only — arbitrary blobs land on disk)",
    );

    devServer.app.get("/api/cache/disk/:key", (req, res) => {
        const key = req.params.key;
        if (!validKey(key)) {
            return res.status(400).json({ ok: false, error: "invalid_key" });
        }
        try {
            const file = keyPath(key);
            if (!fs.existsSync(file)) {
                return res.status(404).json({ ok: false, error: "not_found" });
            }
            const raw = fs.readFileSync(file, "utf-8");
            res.type("application/json").send(raw);
        } catch (err) {
            res.status(500).json({
                ok: false,
                error: (err && err.message) || "read_failed",
            });
        }
    });

    devServer.app.put("/api/cache/disk/:key", async (req, res) => {
        const key = req.params.key;
        if (!validKey(key)) {
            return res.status(400).json({ ok: false, error: "invalid_key" });
        }
        let body;
        try {
            body = await readBody(req);
        } catch (err) {
            return res
                .status(413)
                .json({ ok: false, error: (err && err.message) || "body_too_large" });
        }
        // Validate the body parses as JSON so we don't accept garbage
        // that would break the GET path's `.type("application/json")`.
        // We don't need the parsed value — just the validation.
        try {
            JSON.parse(body);
        } catch {
            return res.status(400).json({ ok: false, error: "invalid_json" });
        }
        try {
            ensureDir();
            fs.writeFileSync(keyPath(key), body, "utf-8");
            res.json({ ok: true, bytes: body.length });
        } catch (err) {
            res.status(500).json({
                ok: false,
                error: (err && err.message) || "write_failed",
            });
        }
    });

    devServer.app.delete("/api/cache/disk/:key", (req, res) => {
        const key = req.params.key;
        if (!validKey(key)) {
            return res.status(400).json({ ok: false, error: "invalid_key" });
        }
        try {
            const file = keyPath(key);
            if (fs.existsSync(file)) fs.unlinkSync(file);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({
                ok: false,
                error: (err && err.message) || "delete_failed",
            });
        }
    });

    // Convenience: list the keys currently on disk. Useful for cache
    // diagnostics from the UI ("how many catalog snapshots do I have?").
    devServer.app.get("/api/cache/disk", (_req, res) => {
        try {
            ensureDir();
            const files = fs
                .readdirSync(CACHE_DIR)
                .filter((f) => f.endsWith(".json"))
                .map((f) => {
                    const key = f.replace(/\.json$/, "");
                    const stat = fs.statSync(keyPath(key));
                    return {
                        key,
                        bytes: stat.size,
                        mtime: stat.mtime.toISOString(),
                    };
                });
            res.json({ ok: true, keys: files });
        } catch (err) {
            res.status(500).json({
                ok: false,
                error: (err && err.message) || "list_failed",
            });
        }
    });
}

module.exports = { registerDiskCache };
