/* eslint-env node */
/* eslint-disable no-console, @typescript-eslint/no-var-requires */

const path = require("path");

const HtmlWebpackPlugin = require("html-webpack-plugin");
const TSConfigPathsWebpackPlugin = require("tsconfig-paths-webpack-plugin");
const BundleAnalyzerWebpackPlugin =
    require("webpack-bundle-analyzer").BundleAnalyzerPlugin;
const MonacoWebpackPlugin = require("monaco-editor-webpack-plugin");
const webpack = require("webpack");
const { EsbuildPlugin } = require("esbuild-loader");
const { execSync } = require("child_process");
const {
    registerPortalAutoLogin,
} = require("./dev-server/portal-auto-login");
const {
    registerSharedMsalCache,
} = require("./dev-server/shared-msal-cache");
const {
    registerNodeConnectLauncher,
} = require("./dev-server/node-connect-launcher");
const { registerDiskCache } = require("./dev-server/disk-cache");

const MODE_DEV = "development";
const MODE_PROD = "production";

/**
 * Build a bundle which can be imported into a regular web page and used without
 * any external dependencies.
 */
module.exports = (env) => {
    if (!env) {
        env = {};
    }

    // Contain all options for the build
    const OPTS = {
        TEST_MODE: env.test === true,
        DEV_MODE: env.dev === true,
        ANALYZE_MODE: env.analyze === true,
        WATCH_MODE: env.watch === true,
        LAUNCH_BROWSER: env.launch === true,
    };

    console.log("Webpack Configuration Options: ", OPTS);

    const webpackPlugins = [];

    webpackPlugins.push(
        new HtmlWebpackPlugin({
            template: "dev-server/index.html",
            inject: "head",
            scriptLoading: "module",
        })
    );

    webpackPlugins.push(
        new webpack.DefinePlugin({
            ENV: JSON.stringify({
                MODE: OPTS.DEV_MODE ? "dev" : "prod",
            }),
        })
    );

    webpackPlugins.push(
        new MonacoWebpackPlugin({
            languages: ["json"],
            filename: "[name].monaco-worker.js",
        })
    );

    if (OPTS.ANALYZE_MODE === true) {
        // Get stats on the final webpack bundle
        webpackPlugins.push(new BundleAnalyzerWebpackPlugin());
    }

    return {
        mode: OPTS.DEV_MODE ? MODE_DEV : MODE_PROD,
        target: "web",
        devtool: OPTS.DEV_MODE ? "inline-source-map" : undefined,
        watch: OPTS.WATCH_MODE ? true : undefined,

        output: {
            path: path.join(__dirname, "lib-umd"),
            filename: "batchexplorer.js",
            library: "batchexplorer",
            libraryTarget: "umd",
        },

        devServer: {
            open: OPTS.LAUNCH_BROWSER ? true : false,
            host: "0.0.0.0",
            allowedHosts: "all",
            hot: true,
            // liveReload ON so a rejected HMR update falls back to a clean
            // full reload instead of running stale code. No file in src/
            // calls module.hot.accept(...), so most edits rejection-propagate
            // up to index.tsx; with liveReload off, the bundle in the browser
            // would drift from disk silently. Long-running orchestrator
            // workflows already model interruption via TaskRecord status
            // "interrupted", so a reload during a long batch is recoverable
            // from the Task Manager panel. ErrorBoundary also auto-reloads
            // on React hook-count-mismatch errors as a last line of defense
            // (see shared/error-boundary.tsx).
            liveReload: true,
            client: {
                overlay: {
                    errors: true,
                    warnings: false,
                    runtimeErrors: false,
                },
            },
            static: [
                {
                    directory: "dev-server",
                    // Don't watch dev-server/ for live-reload. The shared
                    // MSAL cache file (.shared-msal-cache.json) and the
                    // Playwright persistent profile both write under
                    // this dir while the page is open; with watch=true
                    // every cache PUT cascades into a page reload, which
                    // re-triggers PUTs — an infinite refresh loop.
                    watch: false,
                },
                {
                    directory: "resources",
                    publicPath: "/resources",
                },
            ],
            historyApiFallback: true,
            port: 9000,
            setupMiddlewares: (middlewares, devServer) => {
                // Resolve az CLI path — may not be in PATH for child processes on Windows
                const azCmd = (() => {
                    const candidates = [
                        "az",
                        "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd",
                        "C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd",
                    ];
                    for (const c of candidates) {
                        try {
                            execSync(`"${c}" --version`, {
                                encoding: "utf-8",
                                timeout: 10000,
                                stdio: "pipe",
                            });
                            console.log("[az-proxy] Using az CLI at:", c);
                            return `"${c}"`;
                        } catch {
                            /* try next */
                        }
                    }
                    console.warn(
                        "[az-proxy] az CLI not found, token requests will fail"
                    );
                    return "az";
                })();

                devServer.app.get("/api/token", (req, res) => {
                    try {
                        const resource =
                            req.query.resource ||
                            "https://management.azure.com";
                        const result = execSync(
                            `${azCmd} account get-access-token --resource ${resource} --output json`,
                            { encoding: "utf-8", timeout: 15000 }
                        );
                        const parsed = JSON.parse(result);
                        res.json({
                            accessToken: parsed.accessToken,
                            expiresOn: parsed.expiresOn,
                            subscription: parsed.subscription,
                            tenant: parsed.tenant,
                        });
                    } catch (err) {
                        console.error(
                            "Failed to get Azure token:",
                            err.message
                        );
                        res.status(500).json({
                            error: "Failed to get Azure CLI token. Run 'az login' first.",
                            details: err.stderr || err.message,
                        });
                    }
                });

                // Batch data-plane token (for pool creation)
                devServer.app.get("/api/token/batch", (req, res) => {
                    try {
                        const result = execSync(
                            `${azCmd} account get-access-token --resource https://batch.core.windows.net --output json`,
                            { encoding: "utf-8", timeout: 15000 }
                        );
                        const parsed = JSON.parse(result);
                        res.json({
                            accessToken: parsed.accessToken,
                            expiresOn: parsed.expiresOn,
                            subscription: parsed.subscription,
                            tenant: parsed.tenant,
                        });
                    } catch (err) {
                        console.error(
                            "Failed to get Batch token:",
                            err.message
                        );
                        res.status(500).json({
                            error: "Failed to get Batch data-plane token. Run 'az login' first.",
                            details: err.stderr || err.message,
                        });
                    }
                });

                // Login status check
                devServer.app.get("/api/auth/status", (req, res) => {
                    try {
                        execSync(`${azCmd} account show --output json`, {
                            encoding: "utf-8",
                            timeout: 10000,
                            stdio: "pipe",
                        });
                        res.json({ loggedIn: true });
                    } catch {
                        res.json({ loggedIn: false });
                    }
                });

                devServer.app.get("/api/subscriptions", (req, res) => {
                    try {
                        const result = execSync(
                            `${azCmd} account list --output json`,
                            { encoding: "utf-8", timeout: 15000 }
                        );
                        const subs = JSON.parse(result).map((s) => ({
                            subscriptionId: s.id,
                            displayName: s.name,
                            isDefault: s.isDefault,
                            state: s.state,
                            tenantId: s.tenantId,
                        }));
                        res.json(subs);
                    } catch (err) {
                        console.error(
                            "Failed to list subscriptions:",
                            err.message
                        );
                        res.status(500).json({
                            error: "Failed to list subscriptions. Run 'az login' first.",
                        });
                    }
                });

                // MSAL token exchange proxy — Azure CLI client ID is a public app;
                // Azure AD does NOT return CORS headers for direct browser POSTs
                // to its token endpoint.  Route through Node.js server-side.
                devServer.app.post("/api/auth/proxy-token", (req, res) => {
                    const targetUrl = req.headers["x-proxy-target"];
                    if (
                        !targetUrl ||
                        !targetUrl.startsWith(
                            "https://login.microsoftonline.com"
                        )
                    ) {
                        return res
                            .status(400)
                            .json({ error: "Invalid proxy target" });
                    }
                    let body = "";
                    req.on("data", (chunk) => {
                        body += chunk.toString();
                    });
                    req.on("end", () => {
                        const forwardHeaders = {
                            "content-type":
                                req.headers["content-type"] ||
                                "application/x-www-form-urlencoded",
                        };
                        for (const h of [
                            "client-request-id",
                            "x-client-sku",
                            "x-client-ver",
                            "x-client-os",
                            "x-client-cpu",
                            "x-ms-lib-capability",
                        ]) {
                            if (req.headers[h])
                                forwardHeaders[h] = req.headers[h];
                        }
                        fetch(targetUrl, {
                            method: "POST",
                            headers: forwardHeaders,
                            body,
                        })
                            .then(async (r) => {
                                const data = await r.json();
                                res.status(r.status).json(data);
                            })
                            .catch((err) => {
                                console.error(
                                    "[auth-proxy] error:",
                                    err.message
                                );
                                res.status(502).json({ error: err.message });
                            });
                    });
                });

                // Auto-portal-login endpoint — pops a real Chromium window
                // pre-filled with credentials provisioned by this app.
                // See dev-server/portal-auto-login.js for details.
                registerPortalAutoLogin(devServer);

                // Cross-browser shared MSAL cache. Holds a single JSON
                // snapshot of msal.* + azbm.* localStorage keys so every
                // browser profile sees the same logged-in accounts.
                // See dev-server/shared-msal-cache.js for details.
                registerSharedMsalCache(devServer);

                // Server-side SSH/RDP launcher for the Nodes-page
                // Connect feature. Spawns the local client (ssh, mstsc)
                // in a new window after the dialog has the IP+port.
                // See dev-server/node-connect-launcher.js for details.
                registerNodeConnectLauncher(devServer);

                // Project-file disk cache. Stores arbitrary JSON blobs
                // by key — used by the VM-catalog cache to persist
                // ~10 MB Microsoft.Compute/skus snapshots between
                // browser restarts. See dev-server/disk-cache.js.
                registerDiskCache(devServer);

                return middlewares;
            },
            compress: true,
            headers: {
                Connection: "keep-alive",
            },
        },

        entry: "./src/index.tsx",

        resolve: {
            extensions: [".ts", ".tsx", ".js"],
            // Force a single React copy (the migrated web/ requires React 18,
            // monorepo root pins React 17). Prefer web/node_modules/react first.
            alias: {
                react: path.resolve(__dirname, "node_modules/react"),
                "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
            },
            plugins: [
                new TSConfigPathsWebpackPlugin({
                    extensions: [".tsx", ".ts", ".js"],
                    logLevel: "info",
                    logInfoToStdOut: true,
                    configFile: path.join(
                        __dirname,
                        "config",
                        "tsconfig.build.json"
                    ),
                }),
            ],
        },

        module: {
            rules: [
                {
                    // Radix UI ships ESM (.mjs) files that import 'react/jsx-runtime'
                    // without the .js extension. Webpack 5 ESM strict resolution
                    // rejects that. Disable fullySpecified for js/mjs in node_modules.
                    test: /\.m?js$/,
                    resolve: { fullySpecified: false },
                },
                {
                    test: /\.tsx?$/,
                    loader: "esbuild-loader",
                    include: [path.resolve(__dirname, "src")],
                    options: {
                        loader: "tsx",
                        target: "es2020",
                    },
                },
                {
                    test: /\.css$/,
                    use: ["style-loader", "css-loader", "postcss-loader"],
                },
                {
                    test: /\.ttf$/,
                    use: ["file-loader"],
                },
                {
                    test: /\.js$/,
                    include: path.resolve(__dirname, "../packages"),
                    enforce: "pre",
                    use: ["source-map-loader"],
                },
            ],
        },

        plugins: webpackPlugins,

        resolveLoader: {
            modules: ["node_modules"],
        },

        optimization: {
            minimizer: OPTS.DEV_MODE
                ? []
                : [
                      new EsbuildPlugin({
                          target: "es2020",
                      }),
                  ],
        },
        watchOptions: {
            ignored: [
                "**/packages/**/src",
                "**/node_modules",
                // Belt-and-braces: even with the static dir's watch:false
                // above, leave nothing for webpack's module watcher to
                // pick up under dev-server/.
                "**/dev-server/.shared-msal-cache.json",
                "**/dev-server/.playwright-profile-webui/**",
            ],
        },
    };
};
