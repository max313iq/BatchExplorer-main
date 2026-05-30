/* eslint-env node */
/* eslint-disable no-console, @typescript-eslint/no-var-requires */

const path = require("path");

/**
 * /api/portal/auto-login — launches a headed Chromium via playwright-core,
 * navigates to login.microsoftonline.com with the right OAuth2 params for
 * either Azure portal or this WebUI, fills email + password, optionally
 * walks the "must change password" form, and detaches the browser so the
 * user takes over the session.
 *
 * Request body:
 *   {
 *     upn: string,                 // user@tenant.example.com
 *     password: string,            // current / initial password
 *     tenantId: string,            // destination tenant GUID or domain
 *     mustChangePassword: boolean, // whether AAD will force a reset on first sign-in
 *     newPassword?: string,        // when mustChangePassword: the password
 *                                  //   to set in the change-password form. If
 *                                  //   omitted, Playwright stops at the form
 *                                  //   so the user can type one manually.
 *     target?: "portal" | "webui", // default "portal" — controls which
 *                                  //   client_id + redirect_uri pair the
 *                                  //   OAuth flow uses. "webui" lands the
 *                                  //   browser inside this app's session.
 *     webuiUrl?: string,           // when target === "webui", the redirect
 *                                  //   URI; defaults to http://localhost:9000/
 *   }
 *
 * The endpoint NEVER logs the password (current or new). The Set-Cookie /
 * token responses from Azure AD are not captured server-side; the popup is
 * the user's browsing session and runs under their control.
 *
 * playwright-core is a devDependency; the Chromium binary is downloaded
 * lazily on first use via `npx playwright install chromium`. If the binary
 * is missing the endpoint returns a clear actionable error instead of
 * crashing.
 */

const PORTAL_URL = "https://portal.azure.com";
// Azure portal's first-party SPA app id. Accepts portal.azure.com/signin/index/
// as a redirect URI.
const PORTAL_CLIENT_ID = "c44b4083-3bb0-49c1-b47d-974e53cbdf3c";
// Azure CLI public client app id. Accepts http://localhost:<any-port>/ as a
// redirect URI per Microsoft's docs — that's what makes it usable for our
// local-dev WebUI sign-in path without a separate app registration.
const WEBUI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const DEFAULT_WEBUI_URL = "http://localhost:9000/";

// --- Tuning constants -----------------------------------------------------
// Bounded ceiling (ms) for an AAD email/password field to appear. The common
// case is served instantly by the already-present fast scan in findInAnyFrame;
// this ceiling only applies on the slow path (slow tenants / fields still
// rendering), replacing the previous guaranteed 30s sequential waits.
const FIELD_WAIT_MS = 12_000;
// Ceiling (ms) for the forced change-password form to render after the Sign in
// click. Kept generous because AAD navigates between distinct pages here.
const CHANGE_PW_WAIT_MS = 15_000;
// Poll cadence (ms) while re-scanning frames for a not-yet-rendered field.
// Lowered from 150 → 40: the field-finder already does an instant first
// sweep, so this only governs the slow path; a tighter cadence shaves
// perceived latency when AAD renders the field a beat after navigation.
const FRAME_POLL_MS = 40;
// Submit-button readiness polling. AAD enables the Sign-in / Submit button via
// client-side validation a few tens of ms after the field is filled. We poll
// at this cadence and click the instant it's ready, replacing the old blind
// ~400ms settle delay before every submit click. The ceiling is a safety net:
// on timeout the caller still proceeds to a best-effort click (old behaviour),
// so a slow tenant degrades to "click anyway" rather than stalling.
const SUBMIT_READY_POLL_MS = 35;
const SUBMIT_READY_CEILING_MS = 2500;

/**
 * Resolve as soon as a clickable submit-style button exists in `frame`, or
 * when `ceilingMs` elapses — whichever comes first. This is an OPTIMIZATION,
 * not a gate: every caller proceeds to its existing click afterwards, so a
 * timeout simply falls through to a best-effort click (the previous
 * behaviour) instead of stalling. Returns true if an enabled button was seen.
 *
 * Replaces the fixed `page.waitForTimeout(400)` settle delays that previously
 * ran before each submit click — those paid 400ms unconditionally even when
 * the button was already enabled, which is the bulk of the "slow to submit the
 * password" latency.
 */
async function waitForEnabledSubmit(
    page,
    frame,
    ceilingMs = SUBMIT_READY_CEILING_MS,
) {
    const start = Date.now();
    for (;;) {
        const ready = await frame
            .evaluate(() => {
                const isClickable = (el) =>
                    el &&
                    !el.disabled &&
                    !el.hasAttribute("aria-disabled") &&
                    el.offsetParent !== null;
                const sels = [
                    "input#idSIButton9",
                    "button#idSIButton9",
                    'input[type="submit"]',
                    'button[type="submit"]',
                ];
                return sels.some((s) =>
                    Array.from(document.querySelectorAll(s)).some(isClickable),
                );
            })
            .catch(() => false);
        if (ready) return true;
        if (Date.now() - start >= ceilingMs) return false;
        await page.waitForTimeout(SUBMIT_READY_POLL_MS);
    }
}

function maskPassword(s) {
    if (typeof s !== "string" || s.length === 0) return "***";
    if (s.length <= 4) return "***";
    return `${s.slice(0, 1)}***${s.slice(-1)} (len=${s.length})`;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let buf = "";
        req.on("data", (chunk) => {
            buf += chunk.toString();
            // Defensive cap to avoid OOM from a runaway client.
            if (buf.length > 16 * 1024) {
                reject(new Error("Body too large"));
            }
        });
        req.on("end", () => {
            try {
                resolve(buf ? JSON.parse(buf) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });
}

async function loadPlaywright() {
    try {
        // Lazy require — only fails if playwright-core devDep is missing.
        const mod = require("playwright-core");
        return mod;
    } catch (err) {
        const e = new Error(
            "playwright-core is not installed. Run: npm install --save-dev playwright-core && npx playwright install chromium"
        );
        e.cause = err;
        e.code = "PLAYWRIGHT_MISSING";
        throw e;
    }
}

function buildLoginUrl({ tenant, target, upn, webuiUrl }) {
    const isWebui = target === "webui";
    const clientId = isWebui ? WEBUI_CLIENT_ID : PORTAL_CLIENT_ID;
    const redirectUri = isWebui
        ? webuiUrl || DEFAULT_WEBUI_URL
        : PORTAL_URL + "/signin/index/";
    const scope = isWebui
        ? "openid profile offline_access https://management.azure.com/.default"
        : "openid profile offline_access";
    return (
        `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize` +
        `?client_id=${clientId}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_mode=query` +
        `&scope=${encodeURIComponent(scope)}` +
        `&prompt=login` +
        `&login_hint=${encodeURIComponent(upn)}`
    );
}

/**
 * Walk AAD's email → password → (optional change-password) → KMSI flow on
 * `target` (a Playwright Page — main tab OR popup). Throws on unrecoverable
 * step failures so the caller can decide whether to surface partial-fill
 * to the client. The browser is NOT closed; the caller leaves it open so
 * the operator can recover manually if a step failed.
 *
 * Used by both:
 *   - autoLoginViaOAuthUrl (target=portal): runs on the main tab after the
 *     dev-server-built OAuth URL navigates to login.microsoftonline.com.
 *   - autoLoginViaMsalPopup (target=webui): runs on the popup window that
 *     MSAL.loginPopup opens when called from the WebUI inside a persistent
 *     Chromium. The popup is on login.microsoftonline.com just like the
 *     OAuth-URL flow, so the same selectors and steps apply.
 */
async function fillAadLoginForm(
    page,
    { upn, password, mustChangePassword, newPassword },
) {
    // Tracks whether the change-password form was successfully submitted.
    // The caller uses this to update the credential vault even if MSAL
    // doesn't return a token (e.g. broadcast lost, popup timeout): once
    // AAD has accepted the new password, the OLD temp password no longer
    // works, so the vault MUST be updated to the new password regardless
    // of whether the WebUI session-add completed. Otherwise the next
    // sign-in attempt for that account would fail with "wrong password".
    const formResult = { passwordRotated: false };
    // Frame-aware finder: walks every frame on the page and returns the
    // first visible element matching `selector`. Handles main + iframes
    // (signup.live.com, tenant-branded shells, etc.).
    const findInAnyFrame = async (selector, timeoutMs = FIELD_WAIT_MS) => {
        // Single immediate sweep across every frame BEFORE entering the timed
        // poll loop, so an already-rendered field resolves with zero wait.
        const sweep = async () => {
            for (const frame of page.frames()) {
                let handles = [];
                try {
                    handles = await frame.$$(selector);
                } catch {
                    continue;
                }
                for (const h of handles) {
                    let visible = false;
                    try {
                        visible = await h.isVisible();
                    } catch {
                        visible = false;
                    }
                    if (visible) return { frame, handle: h };
                }
            }
            return null;
        };
        const fast = await sweep();
        if (fast) return fast;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            await page.waitForTimeout(FRAME_POLL_MS);
            const found = await sweep();
            if (found) return found;
        }
        return null;
    };

    // Synthetic-event-aware fill — AAD's React listeners track input/change/
    // blur with bubbles=true; plain .fill() can miss them on some pages.
    const fillField = async (handle, value) => {
        try {
            await handle.click({ delay: 25 });
        } catch {
            /* click is best-effort focus */
        }
        await handle.fill(value);
        await handle
            .evaluate((el, v) => {
                if (el.value !== v) el.value = v;
                el.dispatchEvent(
                    new Event("input", { bubbles: true, cancelable: true }),
                );
                el.dispatchEvent(
                    new Event("change", { bubbles: true, cancelable: true }),
                );
                el.dispatchEvent(new Event("blur", { bubbles: true }));
            }, value)
            .catch(() => {
                /* events are nice-to-have */
            });
    };

    const clickPrimary = async (frame, labels) => {
        return frame.evaluate((wantedLabels) => {
            const isClickable = (el) =>
                el &&
                !el.disabled &&
                !el.hasAttribute("aria-disabled") &&
                el.offsetParent !== null;
            const sels = [
                "input#idSIButton9",
                "button#idSIButton9",
                'input[type="submit"]',
                'button[type="submit"]',
            ];
            for (const s of sels) {
                const els = Array.from(document.querySelectorAll(s));
                for (const el of els) {
                    if (isClickable(el)) {
                        el.click();
                        return {
                            ok: true,
                            via: s,
                            text: (el.value || el.textContent || "")
                                .trim()
                                .slice(0, 40),
                        };
                    }
                }
            }
            const all = Array.from(
                document.querySelectorAll(
                    'button, input[type="submit"], input[type="button"], [role="button"]',
                ),
            );
            for (const el of all) {
                const t = (el.value || el.textContent || "")
                    .trim()
                    .toLowerCase();
                if (
                    isClickable(el) &&
                    wantedLabels.some(
                        (l) => t === l || (t.length < 30 && t.includes(l)),
                    )
                ) {
                    el.click();
                    return {
                        ok: true,
                        via: "text-match",
                        text: t.slice(0, 40),
                    };
                }
            }
            return { ok: false };
        }, labels);
    };

    // ---- Email ------------------------------------------------------------
    const emailSel =
        'input[type="email"], input[name="loginfmt"], input#i0116, input[autocomplete="username"]';
    const emailFound = await findInAnyFrame(emailSel, FIELD_WAIT_MS);
    if (!emailFound) {
        throw new Error(
            "email input not found within 30s (no visible email field in any frame)",
        );
    }
    await fillField(emailFound.handle, upn);
    const emailNext = await clickPrimary(emailFound.frame, [
        "next",
        "sign in",
        "submit",
    ]);
    if (!emailNext.ok) {
        throw new Error("email Next button not clickable");
    }
    console.log(
        `[portal-auto-login] email submitted for upn=${upn} via ${emailNext.via}`,
    );

    // ---- Password ---------------------------------------------------------
    const pwdSel =
        'input[type="password"], input[name="passwd"], input#i0118, input[autocomplete="current-password"]';
    const pwdFound = await findInAnyFrame(pwdSel, FIELD_WAIT_MS);
    if (!pwdFound) {
        throw new Error(
            "password input not found within 30s (no visible password field in any frame)",
        );
    }
    await fillField(pwdFound.handle, password);
    // Click the instant AAD enables the Sign-in button (typically <50ms)
    // instead of a blind 400ms wait. Falls through to a best-effort click on
    // the rare slow-tenant timeout.
    await waitForEnabledSubmit(page, pwdFound.frame);
    const pwdNext = await clickPrimary(pwdFound.frame, [
        "sign in",
        "submit",
        "next",
    ]);
    if (!pwdNext.ok) {
        throw new Error("password Sign in button not clickable");
    }
    console.log(
        `[portal-auto-login] password submitted for upn=${upn} via ${pwdNext.via}`,
    );

    // ---- Change-password (if forced) -------------------------------------
    if (mustChangePassword) {
        console.log(
            `[portal-auto-login] CHANGE-PASSWORD FLOW for upn=${upn}`,
        );
        try {
            await page
                .waitForLoadState("domcontentloaded", { timeout: 10_000 })
                .catch(() => {});

            const PWD_SELECTORS = [
                'input[type="password"]',
                'input[autocomplete="current-password"]',
                'input[autocomplete="new-password"]',
                'input[name="currentPassword"]',
                'input[name="newPassword"]',
                'input[name="confirmNewPassword"]',
                'input[name="OldPassword"]',
                'input[name="NewPassword"]',
                'input[name="ConfirmNewPassword"]',
                'input[name="Pwd0"]',
                'input[name="Pwd1"]',
                'input[name="Pwd2"]',
            ].join(", ");

            const findInputsAcrossFrames = async () => {
                const start = Date.now();
                while (Date.now() - start < CHANGE_PW_WAIT_MS) {
                    for (const frame of page.frames()) {
                        let handles = [];
                        try {
                            handles = await frame.$$(PWD_SELECTORS);
                        } catch {
                            continue;
                        }
                        const seen = new Set();
                        const visible = [];
                        for (const h of handles) {
                            let isVisible = false;
                            try {
                                isVisible = await h.isVisible();
                            } catch {
                                isVisible = false;
                            }
                            if (!isVisible) continue;
                            let id;
                            try {
                                id = await h.evaluate(
                                    (el) =>
                                        (el.id || "") +
                                        "|" +
                                        (el.name || "") +
                                        "|" +
                                        (el.outerHTML || "").slice(0, 80),
                                );
                            } catch {
                                continue;
                            }
                            if (seen.has(id)) continue;
                            seen.add(id);
                            visible.push(h);
                        }
                        if (visible.length >= 3) {
                            return { frame, inputs: visible.slice(0, 3) };
                        }
                    }
                    await page.waitForTimeout(FRAME_POLL_MS);
                }
                return null;
            };

            const found = await findInputsAcrossFrames();
            if (!found) {
                throw new Error(
                    "change-password page not detected within 30s",
                );
            }

            if (typeof newPassword !== "string" || newPassword.length < 8) {
                console.log(
                    `[portal-auto-login] change-password form reached but no newPassword provided — leaving for user`,
                );
            } else {
                await fillField(found.inputs[0], password);
                await fillField(found.inputs[1], newPassword);
                await fillField(found.inputs[2], newPassword);
                console.log(
                    `[portal-auto-login] filled all 3 password fields by position`,
                );
                await waitForEnabledSubmit(page, found.frame);

                const submitInfo = await found.frame.evaluate(() => {
                    const sels = [
                        "input#idSIButton9",
                        "button#idSIButton9",
                        'input[type="submit"]',
                        'button[type="submit"]',
                        'input[value="Sign in"]',
                        'input[value="Submit"]',
                        'button[data-report-event="Signin_Submit"]',
                    ];
                    const isClickable = (el) =>
                        el &&
                        !el.disabled &&
                        !el.hasAttribute("aria-disabled") &&
                        el.offsetParent !== null;
                    for (const s of sels) {
                        const els = Array.from(
                            document.querySelectorAll(s),
                        );
                        for (const el of els) {
                            if (isClickable(el)) {
                                el.click();
                                return {
                                    ok: true,
                                    via: s,
                                    text: (
                                        el.value ||
                                        el.textContent ||
                                        ""
                                    )
                                        .trim()
                                        .slice(0, 40),
                                };
                            }
                        }
                    }
                    const all = Array.from(
                        document.querySelectorAll(
                            'button, input[type="submit"], input[type="button"], [role="button"]',
                        ),
                    );
                    const labels = [
                        "sign in",
                        "submit",
                        "update",
                        "update password",
                        "save",
                        "change password",
                        "next",
                    ];
                    for (const el of all) {
                        const t = (el.value || el.textContent || "")
                            .trim()
                            .toLowerCase();
                        if (
                            isClickable(el) &&
                            labels.some(
                                (l) =>
                                    t === l ||
                                    (t.length < 30 && t.includes(l)),
                            )
                        ) {
                            el.click();
                            return {
                                ok: true,
                                via: "text-match",
                                text: t.slice(0, 40),
                            };
                        }
                    }
                    return { ok: false };
                });

                if (!submitInfo.ok) {
                    throw new Error(
                        "no visible/enabled submit button found after fill",
                    );
                }
                console.log(
                    `[portal-auto-login] change-password submitted via ${submitInfo.via}`,
                );
                // AAD has accepted the new password — flag this for the
                // caller so the vault gets updated even if MSAL never
                // returns tokens.
                formResult.passwordRotated = true;

                await dismissKmsiIfPresent(page);
            }
        } catch (e) {
            console.warn(
                "[portal-auto-login] change-password fill failed:",
                (e && e.message) || e,
            );
        }
    } else {
        await dismissKmsiIfPresent(page);
    }
    return formResult;
}

/**
 * Drive AAD sign-in for `target=webui` by:
 *   1. Launching a PERSISTENT Chromium profile so saved accounts (and AAD
 *      cookies) accumulate across sign-ins.
 *   2. Navigating to the WebUI itself (localhost:9000).
 *   3. Calling window.__azbm.autoSignIn(upn, tenantId) inside the page,
 *      which runs MSAL.loginPopup with loginHint+prompt=login.
 *   4. Catching the popup window event and auto-filling the AAD form
 *      using the same logic as the OAuth-URL flow.
 *   5. Awaiting MSAL's loginPopup promise — when it resolves the popup
 *      has closed, the auth code has been exchanged with MSAL's PKCE
 *      verifier, and the new account is in MSAL's cache.
 *   6. Navigating the main page to /azure-accounts so the operator
 *      visually confirms the new account was added.
 *
 * This is the only way to satisfy "auto-fill the password" AND "land the
 * new account on the Azure Accounts page" simultaneously: MSAL has to
 * initiate the OAuth request (so it owns the verifier), and Playwright
 * has to drive the browser (so it can fill the popup).
 */
// Module-level singleton: launchPersistentContext can only be called once
// per profile dir at a time (the second call would error out trying to lock
// the user-data-dir). The bulk runner fires N concurrent /api/portal/auto-
// login calls, so we share one persistent Chromium across them and give
// each call its own tab. Saved-account state stays consistent because all
// tabs see the same localStorage.
let _persistentContext = null;
let _persistentContextLock = null;

async function getOrLaunchPersistentContext(playwright, profileDir) {
    if (_persistentContext) return _persistentContext;
    if (_persistentContextLock) return _persistentContextLock;

    _persistentContextLock = (async () => {
        const launchStrategies = [
            {
                name: "system Chrome",
                opts: {
                    channel: "chrome",
                    headless: false,
                    viewport: null,
                    args: ["--start-maximized"],
                },
            },
            {
                name: "system Edge",
                opts: {
                    channel: "msedge",
                    headless: false,
                    viewport: null,
                    args: ["--start-maximized"],
                },
            },
            {
                name: "bundled Chromium",
                opts: {
                    headless: false,
                    viewport: null,
                    args: ["--start-maximized"],
                },
            },
        ];
        const launchErrors = [];
        for (const strat of launchStrategies) {
            try {
                const ctx = await playwright.chromium.launchPersistentContext(
                    profileDir,
                    strat.opts,
                );
                console.log(
                    `[portal-auto-login] webui: launched persistent context via ${strat.name} (profile=${profileDir})`,
                );
                ctx.on("close", () => {
                    if (_persistentContext === ctx) {
                        _persistentContext = null;
                    }
                });
                _persistentContext = ctx;
                return ctx;
            } catch (err) {
                launchErrors.push(
                    `${strat.name}: ${(err && err.message) || err}`,
                );
            }
        }
        const msg = launchErrors.join(" | ");
        const e = new Error(`Could not launch any browser: ${msg}`);
        e.code = "BROWSER_LAUNCH_FAILED";
        throw e;
    })();

    try {
        return await _persistentContextLock;
    } finally {
        _persistentContextLock = null;
    }
}

async function autoLoginViaMsalPopup({
    upn,
    password,
    tenantId,
    mustChangePassword,
    newPassword,
    webuiUrl,
}) {
    const playwright = await loadPlaywright();
    const result = { ok: false, phase: "init", target: "webui" };

    // Persistent profile dir — keeps localStorage (MSAL accounts) and
    // login.microsoftonline.com cookies between launches.
    const profileDir = path.join(__dirname, ".playwright-profile-webui");

    let context;
    try {
        context = await getOrLaunchPersistentContext(playwright, profileDir);
    } catch (err) {
        result.error = err.message;
        result.phase = "launch_failed";
        throw err;
    }

    try {
        // Always open a fresh tab for this call so concurrent bulk-runner
        // requests don't fight over the same page.
        const page = await context.newPage();
        const target = webuiUrl || DEFAULT_WEBUI_URL;
        await page.goto(target, { waitUntil: "domcontentloaded" });
        result.phase = "navigated";

        // Wait for the WebUI's MSAL hook to be available.
        await page.waitForFunction(
            () => typeof window.__azbm?.autoSignIn === "function",
            null,
            { timeout: 30_000 },
        );
        result.phase = "msal_ready";

        // Set up the popup listener BEFORE triggering autoSignIn, otherwise
        // the popup may fire before we're listening. page.waitForEvent is
        // tab-scoped, so concurrent bulk-runner tabs each catch their own
        // popup (context-scoped would race for the first arrival).
        const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });

        // Fire autoSignIn — returns a promise that resolves AFTER the popup
        // closes and MSAL has cached the new tokens. Don't await it yet;
        // we need to fill the popup first.
        //
        // page.evaluate only accepts a single argument — additional args get
        // dropped with "Too many arguments" — so wrap upn+tenantId in one
        // object before crossing the page boundary.
        const signInResultPromise = page.evaluate(
            ({ upn: u, tenantId: t }) =>
                window.__azbm.autoSignIn(u, t).catch((err) => ({
                    ok: false,
                    error: err && err.message ? err.message : String(err),
                })),
            { upn, tenantId },
        );

        // Race: either the popup appears (good — we fill it) or the
        // signIn promise rejects (e.g. popup blocked).
        const popup = await Promise.race([
            popupPromise,
            signInResultPromise.then(() => null),
        ]);
        if (!popup) {
            // signInResultPromise resolved before the popup event — usually
            // means a synchronous failure (popup blocked / MSAL error).
            const r = await signInResultPromise;
            result.error = r.error || "popup never opened";
            result.phase = "popup_blocked";
            return result;
        }
        result.phase = "popup_opened";

        // Pipe popup's console + URL changes to the dev-server log so we
        // can see whether isMsalPopupCallback fires and broadcastResponse
        // succeeds without having to open DevTools.
        popup.on("console", (msg) => {
            const text = msg.text();
            if (
                text.includes("[MSAL") ||
                text.includes("__azbm") ||
                text.includes("broadcast") ||
                text.includes("[BC]")
            ) {
                console.log(`[portal-auto-login] webui-popup-console: ${text}`);
            }
        });
        popup.on("framenavigated", (frame) => {
            if (frame === popup.mainFrame()) {
                console.log(
                    `[portal-auto-login] webui-popup nav → ${frame.url()}`,
                );
            }
        });
        popup.on("close", () => {
            console.log(`[portal-auto-login] webui-popup closed`);
        });
        page.on("console", (msg) => {
            const text = msg.text();
            if (
                text.includes("[MSAL") ||
                text.includes("__azbm") ||
                text.includes("[BC]")
            ) {
                console.log(`[portal-auto-login] webui-main-console: ${text}`);
            }
        });

        // Fill the popup with email + password (and walk change-password if
        // mustChangePassword is set). Mirrors the OAuth-URL flow.
        try {
            const formResult = await fillAadLoginForm(popup, {
                upn,
                password,
                mustChangePassword,
                newPassword,
            });
            if (formResult && formResult.passwordRotated) {
                result.passwordRotated = true;
            }
        } catch (fillErr) {
            console.warn(
                "[portal-auto-login] webui popup form-fill failed:",
                fillErr && fillErr.message,
            );
            result.error = (fillErr && fillErr.message) || String(fillErr);
            // Don't return yet — give MSAL a chance to bubble its error
            // through signInResultPromise; the popup might still close
            // (e.g. user finishes manually).
        }

        // Wait for MSAL's popup promise to settle. This resolves when the
        // popup closes after AAD redirect → MSAL exchanges code → caches
        // tokens. Cap at 90s in case the operator is interacting manually.
        let signInResult;
        try {
            signInResult = await Promise.race([
                signInResultPromise,
                new Promise((_, rej) =>
                    setTimeout(
                        () =>
                            rej(
                                new Error(
                                    "MSAL loginPopup did not resolve within 90s",
                                ),
                            ),
                        90_000,
                    ),
                ),
            ]);
        } catch (waitErr) {
            result.error = waitErr.message;
            result.phase = "msal_timeout";
            return result;
        }

        console.log(
            `[portal-auto-login] webui: signInResult=${JSON.stringify(signInResult)}`,
        );
        if (signInResult && signInResult.ok) {
            result.ok = true;
            result.phase = "ok";
            result.username = signInResult.username;
            console.log(
                `[portal-auto-login] webui: phase=ok username=${signInResult.username}`,
            );
            // Note: the WebUI's window.__azbm.autoSignIn schedules a
            // location.hash + reload AFTER returning success, so the
            // operator lands on the Azure Accounts page with the new
            // account loaded — no dev-server navigation needed here.
        } else {
            result.error =
                (signInResult && signInResult.error) || "MSAL popup rejected";
            result.phase = "msal_rejected";
            console.log(
                `[portal-auto-login] webui: phase=msal_rejected error=${result.error}`,
            );
        }
        return result;
    } catch (err) {
        console.warn(
            "[portal-auto-login] webui flow failed:",
            err && err.message,
        );
        result.error = (err && err.message) || String(err);
        return result;
    }
    // Note: we deliberately do NOT close `context` — the persistent
    // Chromium stays open as the operator's WebUI session. Closing would
    // discard their just-signed-in MSAL state for the rest of this
    // session (the localStorage IS persisted to disk, so a relaunch would
    // restore it, but leaving the window open preserves their tabs/scroll
    // position and matches the original Playwright UX).
}

async function autoLogin({
    upn,
    password,
    tenantId,
    mustChangePassword,
    newPassword,
    target,
    webuiUrl,
}) {
    const playwright = await loadPlaywright();
    let browser;
    /**
     * Try launch strategies in order until one works:
     *   1. system Chrome  (channel: "chrome")   — uses the user's installed
     *      Chrome and avoids the SxS / VC++ runtime DLL issues that hit
     *      Playwright's bundled Chromium on some Windows installs.
     *   2. system Edge    (channel: "msedge")    — bundled with every Win10/11.
     *   3. bundled Chromium — last resort; needs the VC++ Redistributable.
     */
    const launchStrategies = [
        {
            name: "system Chrome",
            opts: {
                channel: "chrome",
                headless: false,
                args: ["--start-maximized"],
            },
        },
        {
            name: "system Edge",
            opts: {
                channel: "msedge",
                headless: false,
                args: ["--start-maximized"],
            },
        },
        {
            name: "bundled Chromium",
            opts: { headless: false, args: ["--start-maximized"] },
        },
    ];
    const launchErrors = [];
    for (const strat of launchStrategies) {
        try {
            browser = await playwright.chromium.launch(strat.opts);
            console.log(
                `[portal-auto-login] launched via ${strat.name}`
            );
            break;
        } catch (err) {
            launchErrors.push(
                `${strat.name}: ${(err && err.message) || err}`
            );
        }
    }
    if (!browser) {
        const msg = launchErrors.join(" | ");
        console.error("[portal-auto-login] all launch strategies failed:", msg);
        if (msg.includes("Executable doesn't exist")) {
            const e = new Error(
                "No browser available. Install Chrome or Edge, or run: npx playwright install chromium"
            );
            e.code = "CHROMIUM_MISSING";
            throw e;
        }
        if (msg.includes("side-by-side") || msg.includes("0xc0150002")) {
            const e = new Error(
                "Bundled Chromium needs the Microsoft Visual C++ Redistributable. Easiest fix: install Chrome from https://www.google.com/chrome/ and retry — the endpoint auto-picks system Chrome first."
            );
            e.code = "VCREDIST_MISSING";
            throw e;
        }
        const e = new Error(`Could not launch any browser: ${msg}`);
        e.code = "BROWSER_LAUNCH_FAILED";
        throw e;
    }

    const context = await browser.newContext({
        viewport: null,
    });
    const page = await context.newPage();

    const tenant =
        tenantId && /^[a-zA-Z0-9-.]+$/.test(tenantId) ? tenantId : "common";
    const loginUrl = buildLoginUrl({ tenant, target, upn, webuiUrl });
    // Tag every flow with its resolved target so the operator can confirm in
    // the dev-server log that webui-meant clicks are not silently falling
    // back to portal.
    console.log(
        `[portal-auto-login] target=${target || "(unset → portal)"} navigating upn=${upn}`,
    );

    // Track which phase succeeded so the route can return a meaningful
    // result. The client's vault-update logic depends on this — the bulk
    // runner only persists `newPassword` to the vault if `phase === "ok"`,
    // i.e. the change-password form was actually submitted to AAD. A bare
    // `launched` (browser opened but form-fill failed) must NOT update the
    // vault, otherwise we'd write a password that AAD never accepted and
    // every subsequent sign-in for that user would fail with "wrong
    // password".
    const result = { ok: false, phase: "init", target, loginUrl };

    try {
        await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
        result.phase = "navigated";

        // ---- Helpers ------------------------------------------------------
        //
        // Frame-aware finder: walks every frame on the page and returns the
        // first visible element matching `selector` (combined CSS selector
        // string). Returns null on timeout. Used for email + password
        // screens where AAD's flow can be in the main frame OR in a
        // signup.live.com / tenant-branded iframe.
        const findInAnyFrame = async (selector, timeoutMs = FIELD_WAIT_MS) => {
            // Single immediate sweep across every frame BEFORE entering the timed
            // poll loop, so an already-rendered field resolves with zero wait.
            const sweep = async () => {
                for (const frame of page.frames()) {
                    let handles = [];
                    try {
                        handles = await frame.$$(selector);
                    } catch {
                        continue;
                    }
                    for (const h of handles) {
                        let visible = false;
                        try {
                            visible = await h.isVisible();
                        } catch {
                            visible = false;
                        }
                        if (visible) return { frame, handle: h };
                    }
                }
                return null;
            };
            const fast = await sweep();
            if (fast) return fast;
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                await page.waitForTimeout(FRAME_POLL_MS);
                const found = await sweep();
                if (found) return found;
            }
            return null;
        };

        // Synthetic-event-aware fill. AAD's React-style listeners track
        // input/change/blur with bubbles=true; plain .fill() can miss them
        // on some pages (the value lands in the DOM but validation never
        // re-runs and the submit button stays disabled). After fill we
        // also dispatch the events explicitly via evaluate().
        const fillField = async (handle, value) => {
            try {
                await handle.click({ delay: 25 });
            } catch {
                /* click is best-effort focus */
            }
            await handle.fill(value);
            await handle
                .evaluate((el, v) => {
                    if (el.value !== v) el.value = v;
                    el.dispatchEvent(
                        new Event("input", {
                            bubbles: true,
                            cancelable: true,
                        }),
                    );
                    el.dispatchEvent(
                        new Event("change", {
                            bubbles: true,
                            cancelable: true,
                        }),
                    );
                    el.dispatchEvent(new Event("blur", { bubbles: true }));
                }, value)
                .catch(() => {
                    /* events are nice-to-have */
                });
        };

        // Click a primary action button in `frame`. Tries id/type/value
        // selectors first, then falls back to text-content matching for
        // localized / branded variants.
        const clickPrimary = async (frame, labels) => {
            return frame.evaluate((wantedLabels) => {
                const isClickable = (el) =>
                    el &&
                    !el.disabled &&
                    !el.hasAttribute("aria-disabled") &&
                    el.offsetParent !== null;
                const sels = [
                    "input#idSIButton9",
                    "button#idSIButton9",
                    'input[type="submit"]',
                    'button[type="submit"]',
                ];
                for (const s of sels) {
                    const els = Array.from(document.querySelectorAll(s));
                    for (const el of els) {
                        if (isClickable(el)) {
                            el.click();
                            return {
                                ok: true,
                                via: s,
                                text: (el.value || el.textContent || "")
                                    .trim()
                                    .slice(0, 40),
                            };
                        }
                    }
                }
                // Text-content fallback. Match against the supplied label
                // list (lowercased) so localized "Iniciar sesión" / "Anmelden"
                // etc. still work if the operator passes those strings.
                const all = Array.from(
                    document.querySelectorAll(
                        'button, input[type="submit"], input[type="button"], [role="button"]',
                    ),
                );
                for (const el of all) {
                    const t = (el.value || el.textContent || "")
                        .trim()
                        .toLowerCase();
                    if (
                        isClickable(el) &&
                        wantedLabels.some(
                            (l) => t === l || (t.length < 30 && t.includes(l)),
                        )
                    ) {
                        el.click();
                        return {
                            ok: true,
                            via: "text-match",
                            text: t.slice(0, 40),
                        };
                    }
                }
                return { ok: false };
            }, labels);
        };

        // ---- Email screen -------------------------------------------------
        const emailSel =
            'input[type="email"], input[name="loginfmt"], input#i0116, input[autocomplete="username"]';
        const emailFound = await findInAnyFrame(emailSel, FIELD_WAIT_MS);
        if (!emailFound) {
            throw new Error(
                "email input not found within 30s (no visible email field in any frame)",
            );
        }
        // login_hint usually pre-fills it; force-fill in case it didn't.
        await fillField(emailFound.handle, upn);
        const emailNext = await clickPrimary(emailFound.frame, [
            "next",
            "sign in",
            "submit",
        ]);
        if (!emailNext.ok) {
            throw new Error("email Next button not clickable");
        }
        console.log(
            `[portal-auto-login] email submitted for upn=${upn} via ${emailNext.via}`,
        );

        // ---- Password screen ----------------------------------------------
        const pwdSel =
            'input[type="password"], input[name="passwd"], input#i0118, input[autocomplete="current-password"]';
        const pwdFound = await findInAnyFrame(pwdSel, FIELD_WAIT_MS);
        if (!pwdFound) {
            throw new Error(
                "password input not found within 30s (no visible password field in any frame)",
            );
        }
        await fillField(pwdFound.handle, password);
        // Click the moment AAD enables the Sign-in button (typically <50ms)
        // rather than a blind 400ms settle — this is the main "slow to submit
        // the password" delay. Degrades to a best-effort click on timeout.
        await waitForEnabledSubmit(page, pwdFound.frame);
        const pwdNext = await clickPrimary(pwdFound.frame, [
            "sign in",
            "submit",
            "next",
        ]);
        if (!pwdNext.ok) {
            throw new Error("password Sign in button not clickable");
        }
        console.log(
            `[portal-auto-login] password submitted for upn=${upn} via ${pwdNext.via}`,
        );

        if (mustChangePassword) {
            // AAD's "Update your password" page uses different input
            // attribute names depending on the variant:
            //   - First-time-signin flow:    OldPassword / NewPassword / ConfirmNewPassword
            //   - Password-expired flow:     currentPassword / newPassword / confirmNewPassword
            //   - Older live.com-style:      Pwd0 / Pwd1 / Pwd2
            //   - Some tenants:              Password / NewPassword / RePassword
            // None of those are stable across tenant configurations or
            // portal versions. What IS stable: the page renders exactly
            // three <input type="password"> elements in this order:
            //   [0] current password   [1] new password   [2] confirm new password
            // So we ignore name attributes entirely and fill by position.
            //
            // Two scenarios:
            //   a) newPassword provided  → fill all three inputs and submit.
            //   b) newPassword absent    → wait for the form to appear and
            //      detach so the user types one manually.
            console.log(
                `[portal-auto-login] CHANGE-PASSWORD FLOW v4 (frame-aware, evaluate-fill) for upn=${upn}`
            );
            try {
                // Give AAD time to navigate to the change-password page
                // after the Sign in click.
                await page
                    .waitForLoadState("domcontentloaded", { timeout: 10_000 })
                    .catch(() => {
                        /* may already have loaded */
                    });

                // Find at least three visible password inputs in ANY frame
                // (main + iframes — AAD's password-reset is sometimes
                // iframed under signup.live.com). Combines multiple
                // selectors so flows that don't use type=password (e.g.
                // custom Web Components) still match.
                const findInputsAcrossFrames = async () => {
                    const PWD_SELECTORS = [
                        'input[type="password"]',
                        'input[autocomplete="current-password"]',
                        'input[autocomplete="new-password"]',
                        'input[name="currentPassword"]',
                        'input[name="newPassword"]',
                        'input[name="confirmNewPassword"]',
                        'input[name="OldPassword"]',
                        'input[name="NewPassword"]',
                        'input[name="ConfirmNewPassword"]',
                        'input[name="Pwd0"]',
                        'input[name="Pwd1"]',
                        'input[name="Pwd2"]',
                    ].join(", ");
                    const start = Date.now();
                    while (Date.now() - start < CHANGE_PW_WAIT_MS) {
                        for (const frame of page.frames()) {
                            let handles = [];
                            try {
                                handles = await frame.$$(PWD_SELECTORS);
                            } catch {
                                continue;
                            }
                            // Filter to visible + dedupe (same node may be
                            // matched by several selectors).
                            const seen = new Set();
                            const visible = [];
                            for (const h of handles) {
                                let isVisible = false;
                                try {
                                    isVisible = await h.isVisible();
                                } catch {
                                    isVisible = false;
                                }
                                if (!isVisible) continue;
                                let id;
                                try {
                                    id = await h.evaluate(
                                        (el) =>
                                            (el.id || "") +
                                            "|" +
                                            (el.name || "") +
                                            "|" +
                                            (el.outerHTML || "").slice(0, 80),
                                    );
                                } catch {
                                    continue;
                                }
                                if (seen.has(id)) continue;
                                seen.add(id);
                                visible.push(h);
                            }
                            if (visible.length >= 3) {
                                console.log(
                                    `[portal-auto-login] found ${visible.length} password inputs in frame=${
                                        frame === page.mainFrame()
                                            ? "(main)"
                                            : frame.url() || "(unnamed)"
                                    }`,
                                );
                                return { frame, inputs: visible.slice(0, 3) };
                            }
                        }
                        await page.waitForTimeout(FRAME_POLL_MS);
                    }
                    return null;
                };

                const found = await findInputsAcrossFrames();
                if (!found) {
                    throw new Error(
                        "change-password page not detected within 30s (no visible password inputs found in any frame)",
                    );
                }

                if (
                    typeof newPassword !== "string" ||
                    newPassword.length < 8
                ) {
                    console.log(
                        `[portal-auto-login] change-password form reached but no newPassword provided — leaving for user`,
                    );
                } else {
                    // Fill by position [0]=current, [1]=new, [2]=confirm.
                    // Use evaluate to set value AND dispatch input/change
                    // events with bubbles so AAD's React-style listeners
                    // see them. Plain .fill() can miss React's synthetic
                    // event tracking on some pages.
                    const fillField = async (handle, value) => {
                        await handle.click({ delay: 25 }).catch(() => {});
                        await handle.fill(value);
                        await handle
                            .evaluate((el, v) => {
                                if (el.value !== v) el.value = v;
                                el.dispatchEvent(
                                    new Event("input", {
                                        bubbles: true,
                                        cancelable: true,
                                    }),
                                );
                                el.dispatchEvent(
                                    new Event("change", {
                                        bubbles: true,
                                        cancelable: true,
                                    }),
                                );
                                el.dispatchEvent(
                                    new Event("blur", { bubbles: true }),
                                );
                            }, value)
                            .catch(() => {
                                /* event dispatch is a nice-to-have */
                            });
                    };

                    await fillField(found.inputs[0], password);
                    await fillField(found.inputs[1], newPassword);
                    await fillField(found.inputs[2], newPassword);
                    console.log(
                        `[portal-auto-login] filled all 3 password fields by position`,
                    );

                    // Click submit the instant AAD enables it (smart-wait),
                    // instead of a blind fixed delay.
                    await waitForEnabledSubmit(page, found.frame);

                    // Click submit — search the same frame as the inputs,
                    // try multiple candidates including text-based.
                    const submitInfo = await found.frame.evaluate(() => {
                        const sels = [
                            "input#idSIButton9",
                            "button#idSIButton9",
                            'input[type="submit"]',
                            'button[type="submit"]',
                            'input[value="Sign in"]',
                            'input[value="Submit"]',
                            'button[data-report-event="Signin_Submit"]',
                        ];
                        const isClickable = (el) =>
                            el &&
                            !el.disabled &&
                            !el.hasAttribute("aria-disabled") &&
                            el.offsetParent !== null;
                        for (const s of sels) {
                            const els = Array.from(
                                document.querySelectorAll(s),
                            );
                            for (const el of els) {
                                if (isClickable(el)) {
                                    el.click();
                                    return {
                                        ok: true,
                                        via: s,
                                        text: (
                                            el.value ||
                                            el.textContent ||
                                            ""
                                        )
                                            .trim()
                                            .slice(0, 40),
                                    };
                                }
                            }
                        }
                        // Fallback: any button-ish element whose visible
                        // label is Sign in / Submit / Update / Save.
                        const all = Array.from(
                            document.querySelectorAll(
                                'button, input[type="submit"], input[type="button"], [role="button"]',
                            ),
                        );
                        const labels = [
                            "sign in",
                            "submit",
                            "update",
                            "update password",
                            "save",
                            "change password",
                            "next",
                        ];
                        for (const el of all) {
                            const t = (el.value || el.textContent || "")
                                .trim()
                                .toLowerCase();
                            if (
                                isClickable(el) &&
                                labels.some(
                                    (l) =>
                                        t === l ||
                                        (t.length < 30 && t.includes(l)),
                                )
                            ) {
                                el.click();
                                return {
                                    ok: true,
                                    via: "text-match",
                                    text: t.slice(0, 40),
                                };
                            }
                        }
                        return { ok: false };
                    });

                    if (!submitInfo.ok) {
                        throw new Error(
                            "no visible/enabled submit button found after fill (form may still be validating)",
                        );
                    }
                    console.log(
                        `[portal-auto-login] change-password submitted for upn=${upn} via ${submitInfo.via} (label="${submitInfo.text}")`,
                    );
                    // AAD has accepted the new password — flag this so the
                    // client updates the vault even if the rest of the
                    // flow fails. Without this the vault keeps the old
                    // temp password and every subsequent sign-in for this
                    // account fails with "wrong password".
                    result.passwordRotated = true;

                    // Auto-dismiss the "Stay signed in?" prompt.
                    await dismissKmsiIfPresent(page);
                }
            } catch (e) {
                console.warn(
                    "[portal-auto-login] change-password fill failed:",
                    (e && e.message) || e,
                );
                // Leave the browser open; the user can finish manually.
            }
        } else {
            // Even on the happy path, AAD typically shows the KMSI prompt
            // after a successful sign-in. Auto-click "Yes" so the
            // operator's session is durable and the redirect to the WebUI
            // / portal happens immediately.
            await dismissKmsiIfPresent(page);
        }

        // Detach: do NOT close browser/context — the user takes over.
        result.ok = true;
        result.phase = "ok";
    } catch (err) {
        console.warn(
            "[portal-auto-login] partial fill — leaving browser open for the user to complete:",
            err && err.message
        );
        result.error = (err && err.message) || String(err);
        // Leave browser open; the user can recover manually.
    }
    return result;
}

/**
 * AAD's "Stay signed in?" (KMSI) page has primary button id `idSIButton9`
 * (Yes) and secondary `idBtn_Back` (No). We click Yes so the user lands
 * on the actual destination page (portal or WebUI) without an extra prompt.
 * If the page never appears, swallow the timeout and continue.
 */
async function dismissKmsiIfPresent(page) {
    try {
        await page.waitForSelector(
            'input#idSIButton9, input[type="submit"][value="Yes"]',
            { timeout: 12_000 }
        );
        // Make sure we're actually on the KMSI page (heading text "Stay
        // signed in?") — the same id is reused across AAD pages, so a
        // text-anchor check avoids accidentally clicking through a
        // different prompt.
        const looksLikeKmsi = await page
            .locator('text=/Stay signed in/i')
            .first()
            .isVisible()
            .catch(() => false);
        if (looksLikeKmsi) {
            await page.click('input#idSIButton9');
            console.log("[portal-auto-login] dismissed KMSI prompt");
        }
    } catch {
        /* No KMSI page in this flow — ignore. */
    }
}

/**
 * Fire-and-forget pre-warm of the shared persistent Chromium context so the
 * FIRST operator webui auto-login does not pay the ~1-2s browser cold-start.
 * (The portal flow launches a throwaway browser per call, so there is nothing
 * durable to warm there.)
 *
 * Strictly best-effort and NEVER throws:
 *   - If playwright-core is not installed, loadPlaywright() rejects and we
 *     swallow it so the dev-server still boots.
 *   - If no browser channel can launch, getOrLaunchPersistentContext()
 *     rejects and is swallowed; a real login surfaces the genuine error.
 *
 * @returns {void}
 */
function prewarmPersistentContext() {
    Promise.resolve()
        .then(async () => {
            const playwright = await loadPlaywright();
            const profileDir = path.join(
                __dirname,
                ".playwright-profile-webui",
            );
            await getOrLaunchPersistentContext(playwright, profileDir);
            console.log(
                "[portal-auto-login] pre-warmed persistent Chromium context",
            );
        })
        .catch((err) => {
            // Best-effort only: missing playwright-core or no launchable
            // browser must not crash the dev-server. A real login retries.
            console.log(
                "[portal-auto-login] pre-warm skipped:",
                (err && err.message) || err,
            );
        });
}

function registerPortalAutoLogin(devServer) {
    // One-shot startup banner so the operator can confirm a freshly-restarted
    // dev-server is actually running this code. If the banner is missing
    // from the restart logs, the old endpoint is still live.
    console.log(
        "[portal-auto-login] endpoint registered — auto-fill v4 (email + password + change-password all frame-aware, evaluate-dispatched)"
    );
    // Warm the shared persistent Chromium so the first login skips cold-start.
    // Guarded + swallowed so a box without playwright-core still boots.
    prewarmPersistentContext();
    devServer.app.post("/api/portal/auto-login", async (req, res) => {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            return res.status(400).json({
                status: "error",
                message: "Invalid JSON body",
                details: err.message,
            });
        }
        const {
            upn,
            password,
            tenantId,
            mustChangePassword,
            newPassword,
            target,
            webuiUrl,
        } = body || {};
        if (
            typeof upn !== "string" ||
            !upn.includes("@") ||
            typeof password !== "string" ||
            password.length < 4
        ) {
            return res.status(400).json({
                status: "error",
                message:
                    "Body must contain { upn: string (email), password: string }.",
            });
        }
        const targetNormalized = target === "webui" ? "webui" : "portal";
        // Whether a rotation was ASKED for (independent of whether AAD's
        // change-password form actually appeared). Surfaced on every response
        // so the client resolves its none/confirmed/unknown vault outcome.
        const rotationRequested = !!(
            mustChangePassword &&
            typeof newPassword === "string" &&
            newPassword.length >= 8
        );
        console.log(
            `[portal-auto-login] launching for upn=${upn} tenant=${
                tenantId || "common"
            } pwd=${maskPassword(
                password
            )} mustChange=${!!mustChangePassword} newPwd=${
                typeof newPassword === "string" && newPassword.length >= 8
                    ? "<provided>"
                    : "<absent>"
            } target=${targetNormalized}`
        );
        try {
            // Await the entire flow — browser launch → navigation → email
            // → password → (optional change-password) → KMSI dismiss.
            // autoLogin returns a result object whose `ok` is only true if
            // the change-password form actually submitted (or the happy
            // path completed without a forced reset). The client's
            // vault-update logic depends on this: writing `newPassword` to
            // the vault before AAD has actually accepted it would leave
            // the user with a password that AAD never knows about.
            //
            // Awaiting through the full flow also bounds the bulk runner's
            // worker pool — each /api/portal/auto-login response takes the
            // real wall-clock time of the sign-in (~10–30 s), so threads=N
            // means at most N concurrent flows. Without this gate the
            // route would return in milliseconds and N workers would
            // dispatch before any browser launched.
            // target=webui: drive MSAL inside a persistent Chromium so the
            // new account lands on the Azure Accounts page (and saved
            // accounts accumulate across sign-ins).
            // target=portal: keep the OAuth-URL approach because portal
            // doesn't go through the WebUI's MSAL — it just opens a portal
            // session in a separate Chromium for inspection.
            const result =
                targetNormalized === "webui"
                    ? await autoLoginViaMsalPopup({
                          upn,
                          password,
                          tenantId,
                          mustChangePassword,
                          newPassword,
                          webuiUrl,
                      })
                    : await autoLogin({
                          upn,
                          password,
                          tenantId,
                          mustChangePassword,
                          newPassword,
                          target: targetNormalized,
                          webuiUrl,
                      });
            if (result.ok) {
                return res.json({
                    status: "ok",
                    phase: result.phase,
                    target: targetNormalized,
                    passwordRotated: !!result.passwordRotated,
                    rotationRequested,
                });
            }
            // Even when the overall flow didn't complete, the
            // change-password form may already have been submitted —
            // surface that so the client can update the vault. Keep
            // status=partial so the client knows MSAL didn't add the
            // session, but the rotated flag prevents stale-password
            // failures on subsequent sign-ins.
            return res.status(502).json({
                status: "partial",
                phase: result.phase,
                target: targetNormalized,
                passwordRotated: !!result.passwordRotated,
                rotationRequested,
                message:
                    result.error ||
                    "Form-fill did not complete. Browser left open for manual recovery.",
            });
        } catch (err) {
            console.error(
                "[portal-auto-login] launch failed:",
                err && err.message
            );
            const code = err && err.code;
            if (code === "PLAYWRIGHT_MISSING" || code === "CHROMIUM_MISSING") {
                return res.status(503).json({
                    status: "error",
                    code,
                    message: err.message,
                    rotationRequested,
                });
            }
            return res.status(500).json({
                status: "error",
                message: err.message || "Unknown error",
                rotationRequested,
            });
        }
    });
}

module.exports = { registerPortalAutoLogin };
