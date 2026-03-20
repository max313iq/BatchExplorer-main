const { app, BrowserWindow, Menu, shell, protocol, net } = require("electron");
const path = require("path");
const url = require("url");

const APP_DIR = path.join(__dirname, "app");

protocol.registerSchemesAsPrivileged([
    {
        scheme: "batchapp",
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
        },
    },
]);

let mainWindow;

app.whenReady().then(() => {
    protocol.handle("batchapp", (request) => {
        const reqUrl = new URL(request.url);
        let reqPath = decodeURIComponent(reqUrl.pathname);

        if (reqPath === "/" || reqPath === "") {
            reqPath = "/index.html";
        }

        const filePath = path.join(APP_DIR, reqPath);
        return net.fetch(url.pathToFileURL(filePath).toString());
    });

    createWindow();
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        title: "BatchExplorer Full Auto",
        icon: path.join(__dirname, "resources", "icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
        },
        autoHideMenuBar: false,
        backgroundColor: "#1b2631",
    });

    mainWindow.loadURL("batchapp://app/index.html");

    const menuTemplate = [
        {
            label: "File",
            submenu: [
                {
                    label: "Full Auto Dashboard",
                    accelerator: "CmdOrCtrl+D",
                    click: () => {
                        mainWindow.loadURL("batchapp://app/index.html");
                    },
                },
                { type: "separator" },
                { role: "quit" },
            ],
        },
        {
            label: "View",
            submenu: [
                { role: "reload" },
                { role: "forceReload" },
                { role: "toggleDevTools" },
                { type: "separator" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" },
            ],
        },
        {
            label: "Help",
            submenu: [
                {
                    label: "Azure Batch Documentation",
                    click: () => {
                        shell.openExternal(
                            "https://learn.microsoft.com/azure/batch/"
                        );
                    },
                },
                {
                    label: "About",
                    click: () => {
                        const { dialog } = require("electron");
                        dialog.showMessageBox(mainWindow, {
                            type: "info",
                            title: "About BatchExplorer Full Auto",
                            message: "BatchExplorer Full Auto v1.0.0",
                            detail:
                                "Bulk-create up to 5,000 pools and nodes in Azure Batch.\n\n" +
                                "Built on the BatchExplorer codebase.",
                        });
                    },
                },
            ],
        },
    ];

    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

app.on("window-all-closed", () => {
    app.quit();
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
