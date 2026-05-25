/* eslint-env node */
/* eslint-disable no-console, @typescript-eslint/no-var-requires */

/**
 * Server-side launcher for SSH/RDP to a Batch compute node.
 *
 * The WebUI runs in a browser and can't open a terminal or RDP client
 * on its own. After the Connect dialog has finished provisioning the
 * temp user + grabbed the remote-login settings, it POSTs here and the
 * dev-server (running on the operator's machine) spawns the actual
 * client in a new window.
 *
 * Windows:
 *   ssh  → `cmd.exe /c start "" cmd.exe /k ssh user@ip -p port`
 *   rdp  → `cmd.exe /c start "" mstsc /v:ip:port`
 *
 * macOS:
 *   ssh  → `open -a Terminal "ssh://user@ip:port"` (best-effort; falls
 *           back to writing a small .command file the user double-clicks)
 *   rdp  → `open "rdp://full address=s:ip:port"` (requires Microsoft
 *           Remote Desktop installed)
 *
 * Linux:
 *   ssh  → `x-terminal-emulator -e ssh user@ip -p port` (DE-specific;
 *           may not work on minimal installs — the dialog still shows
 *           the command so the operator can paste it manually).
 *   rdp  → `xfreerdp /v:ip:port /u:user` (requires xfreerdp).
 *
 * Security: the endpoint NEVER logs the password and never echoes it
 * via the command line. SSH/RDP don't take a password on the CLI
 * anyway — the operator pastes it from the clipboard once prompted.
 */

const { spawn } = require("child_process");
const os = require("os");

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let buf = "";
        req.on("data", (c) => {
            buf += c.toString();
            if (buf.length > 16 * 1024) reject(new Error("Body too large"));
        });
        req.on("end", () => {
            try {
                resolve(buf ? JSON.parse(buf) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

// Strict allowlist on inputs that end up in shell args. Hostnames/IPs
// must be ASCII letters/digits/dots/colons (IPv6) only; ports are
// 1-65535; usernames are ASCII identifiers. Reject anything else so a
// malicious caller can't inject shell metacharacters.
function validHost(s) {
    return (
        typeof s === "string" &&
        s.length > 0 &&
        s.length < 256 &&
        /^[A-Za-z0-9.:_-]+$/.test(s)
    );
}
function validPort(n) {
    return Number.isInteger(n) && n > 0 && n < 65536;
}
function validUser(s) {
    return (
        typeof s === "string" &&
        s.length > 0 &&
        s.length < 64 &&
        /^[A-Za-z0-9._-]+$/.test(s)
    );
}

function launchOnPlatform({ command, user, ip, port }) {
    const platform = os.platform();
    if (command === "ssh") {
        if (platform === "win32") {
            // `start ""` keeps the new window open after ssh exits so the
            // operator can see error output if SSH fails. The empty
            // second arg is the window title (required by `start`).
            return spawn(
                "cmd.exe",
                [
                    "/c",
                    "start",
                    "",
                    "cmd.exe",
                    "/k",
                    "ssh",
                    `${user}@${ip}`,
                    "-p",
                    String(port),
                ],
                { detached: true, stdio: "ignore" },
            );
        }
        if (platform === "darwin") {
            // ssh:// is handled by Terminal.app on most macOS installs.
            return spawn(
                "open",
                ["-a", "Terminal", `ssh://${user}@${ip}:${port}`],
                { detached: true, stdio: "ignore" },
            );
        }
        // Linux best-effort.
        return spawn(
            "x-terminal-emulator",
            ["-e", "ssh", `${user}@${ip}`, "-p", String(port)],
            { detached: true, stdio: "ignore" },
        );
    }
    if (command === "rdp") {
        if (platform === "win32") {
            return spawn(
                "cmd.exe",
                ["/c", "start", "", "mstsc", `/v:${ip}:${port}`],
                { detached: true, stdio: "ignore" },
            );
        }
        if (platform === "darwin") {
            return spawn(
                "open",
                [`rdp://full%20address=s:${ip}:${port}`],
                { detached: true, stdio: "ignore" },
            );
        }
        return spawn("xfreerdp", [`/v:${ip}:${port}`, `/u:${user}`], {
            detached: true,
            stdio: "ignore",
        });
    }
    throw new Error(`unsupported command: ${command}`);
}

function registerNodeConnectLauncher(devServer) {
    console.log(
        "[node-connect-launcher] endpoint registered at /api/connect/launch (dev-only — spawns local SSH/RDP client)",
    );
    devServer.app.post("/api/connect/launch", async (req, res) => {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            return res
                .status(400)
                .json({ ok: false, error: "invalid_body: " + err.message });
        }
        const { command, user, ip, port } = body || {};
        if (command !== "ssh" && command !== "rdp") {
            return res
                .status(400)
                .json({ ok: false, error: "command must be 'ssh' or 'rdp'" });
        }
        if (!validUser(user)) {
            return res.status(400).json({ ok: false, error: "invalid_user" });
        }
        if (!validHost(ip)) {
            return res.status(400).json({ ok: false, error: "invalid_ip" });
        }
        if (!validPort(Number(port))) {
            return res.status(400).json({ ok: false, error: "invalid_port" });
        }
        try {
            const child = launchOnPlatform({
                command,
                user,
                ip,
                port: Number(port),
            });
            // Detach so the dev-server can keep running independently
            // when ssh/RDP exits. ignore() prevents zombie pipes.
            child.unref();
            console.log(
                `[node-connect-launcher] launched ${command} → ${user}@${ip}:${port} on ${os.platform()}`,
            );
            res.json({ ok: true, platform: os.platform() });
        } catch (err) {
            console.error(
                "[node-connect-launcher] launch failed:",
                err && err.message,
            );
            res.status(500).json({
                ok: false,
                error: (err && err.message) || "spawn_failed",
            });
        }
    });
}

module.exports = { registerNodeConnectLauncher };
