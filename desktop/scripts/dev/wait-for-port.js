"use strict";

const net = require("net");

const port = Number(process.argv[2] || 3178);
const timeoutMs = Number(process.argv[3] || 120000);
const intervalMs = 1000;
const hosts = (process.argv[4] || "localhost,127.0.0.1,::1")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const startedAt = Date.now();

function canConnect(host) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        socket.once("connect", () => {
            socket.destroy();
            resolve({ ready: true, host });
        });
        socket.once("error", () => {
            socket.destroy();
            resolve({ ready: false, host });
        });
    });
}

async function canConnectAnyHost() {
    for (const host of hosts) {
        const result = await canConnect(host);
        if (result.ready) {
            return result;
        }
    }
    return { ready: false, host: hosts[0] || "localhost" };
}

async function waitForPort() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const result = await canConnectAnyHost();
        if (result.ready) {
            // Keep output minimal; this script is only a readiness gate.
            process.stdout.write(`[wait-for-port] ${result.host}:${port} is ready.\n`);
            process.exit(0);
        }

        if (Date.now() - startedAt >= timeoutMs) {
            process.stderr.write(
                `[wait-for-port] Timed out after ${timeoutMs}ms waiting for any of [${hosts.join(", ")}]:${port}.\n`,
            );
            process.exit(1);
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

waitForPort().catch((error) => {
    process.stderr.write(`[wait-for-port] Unexpected failure: ${error && error.message || error}\n`);
    process.exit(1);
});
