/**
 * Ambient type declaration for @azure/msal-browser/redirect-bridge subpath export.
 *
 * TypeScript (moduleResolution: "node") cannot resolve package.json "exports"
 * subpath fields, but webpack 5 can. This declaration lets TypeScript accept
 * the import while webpack bundles the correct CJS module at runtime.
 */
declare module "@azure/msal-browser/redirect-bridge" {
    /**
     * Reads the MSAL auth response from the current URL (hash or query string),
     * broadcasts it to the parent window via BroadcastChannel keyed to the
     * interaction ID, then calls window.close().
     *
     * Call this in the popup callback page instead of handleRedirectPromise().
     * The parent's loginPopup() is waiting on the BroadcastChannel and will
     * complete the token exchange using its own stored PKCE code verifier.
     */
    export function broadcastResponseToMainFrame(
        navigationClient?: unknown
    ): Promise<void>;
}
