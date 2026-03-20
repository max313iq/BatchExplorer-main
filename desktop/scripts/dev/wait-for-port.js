"use strict";

const net = require("net");

const port = Number(process.argv[2] || 3178);
const timeoutMs = Number(process.argv[3] || 120000);
const intervalMs = 1000;
const host = "127.0.0.1";
const startedAt = Date.now();

function canConnect() {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => {
            socket.destroy();
            resolve(false);
        });
    });
}

async function waitForPort() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const ready = await canConnect();
        if (ready) {
            // Keep output minimal; this script is only a readiness gate.
            process.stdout.write(`[wait-for-port] ${host}:${port} is ready.\n`);
            process.exit(0);
        }

        if (Date.now() - startedAt >= timeoutMs) {
            process.stderr.write(
                `[wait-for-port] Timed out after ${timeoutMs}ms waiting for ${host}:${port}.\n`,
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
