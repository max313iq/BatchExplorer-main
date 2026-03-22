const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("batchExplorerAuto", {
    platform: process.platform,
    version: "1.0.0",
});
