/**
 * Device Code Sign-in dialog.
 *
 * Drives the two-step OAuth 2.0 Device Authorization Grant (RFC 8628) via
 * `auth/device-code-login`:
 *
 *   1. On mount → call startDeviceCodeFlow() to fetch a user_code +
 *      verification_uri. Show those in a large, copy-friendly layout so the
 *      operator can type the code on their phone (or another browser).
 *   2. As soon as we have the challenge → kick off pollDeviceCodeFlow() in
 *      the background. Render a poll-counter so the operator can see we're
 *      still waiting on them.
 *   3. On success → show "Signed in as <upn>" briefly, fire onComplete, and
 *      auto-dismiss.
 *   4. On failure / expiry → show a red error with a "Try again" button
 *      that restarts the flow from step 1.
 *   5. Cancel button (and Esc/X-close) at all times → aborts the in-flight
 *      poll via AbortController so we don't keep hammering AAD.
 *
 * Sensitive-data discipline: this component NEVER logs access_token,
 * refresh_token, id_token, device_code, or user_code. The user_code IS
 * displayed in the UI (that's its whole purpose — the operator types it
 * on another device) but no console / audit log writes it.
 */
import * as React from "react";
import { TokenResult } from "../../auth/device-code-login";
export interface DeviceCodeDialogProps {
    open: boolean;
    /** Called when the user closes the dialog OR the flow is cancelled. */
    onOpenChange: (open: boolean) => void;
    /**
     * AAD tenant authority for the device code request. Defaults to "common"
     * inside startDeviceCodeFlow so leaving this undefined is fine.
     */
    tenantId?: string;
    /** Public client ID. Defaults to Azure CLI (FOCI-eligible) when omitted. */
    clientId?: string;
    /**
     * Scopes to request. `offline_access` is needed to get back a refresh
     * token; without it the host can't redeem the RT later in the imported-
     * tokens vault.
     */
    scopes?: string[];
    /** Called once on a successful sign-in with the AAD token response. */
    onComplete: (result: TokenResult) => void;
}
export declare const DeviceCodeDialog: React.FC<DeviceCodeDialogProps>;
//# sourceMappingURL=device-code-dialog.d.ts.map