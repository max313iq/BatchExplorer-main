import { __awaiter } from "tslib";
/**
 * "Copy email" — after a user-create / password-reset, the post-action
 * button just copies the new account's email (UPN) to the clipboard.
 * No MSAL popup, no password copy, nothing fancy. The user pastes the
 * email wherever they want to sign in (Azure portal in a private window,
 * the Web UI's normal Sign-in button, etc.) and types the password
 * themselves.
 *
 * Earlier versions of this component pre-filled the MSAL popup with
 * `loginHint: upn` and copied the password to the clipboard, which the
 * operator explicitly did not want — the only thing that should leave
 * this app is the email string.
 */
import * as React from "react";
import { Copy, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionStore } from "../../store/store-context";
export const PortalLoginButton = ({ upn, size = "sm", variant = "default", label = "Copy email", className, }) => {
    const store = useMultiRegionStore();
    const [busy, setBusy] = React.useState(false);
    const [copied, setCopied] = React.useState(false);
    const handleClick = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        setBusy(true);
        try {
            let ok = false;
            try {
                yield navigator.clipboard.writeText(upn);
                ok = true;
            }
            catch (_a) {
                // Clipboard API can fail in non-secure contexts (HTTP origins,
                // iframes without `clipboard-write` permission). Fall back to the
                // execCommand path — works on http://localhost during dev.
                try {
                    const ta = document.createElement("textarea");
                    ta.value = upn;
                    ta.style.position = "fixed";
                    ta.style.opacity = "0";
                    document.body.appendChild(ta);
                    ta.select();
                    ok = document.execCommand("copy");
                    document.body.removeChild(ta);
                }
                catch (_b) {
                    ok = false;
                }
            }
            if (ok) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
                store.addNotification({
                    type: "success",
                    message: `Email ${upn} copied to clipboard.`,
                });
                auditLog.record({
                    actor: upn,
                    action: "copy_email",
                    target: upn,
                    status: "success",
                });
            }
            else {
                store.addNotification({
                    type: "error",
                    message: `Could not copy email — clipboard permission denied. Email: ${upn}`,
                });
                auditLog.record({
                    actor: upn,
                    action: "copy_email",
                    target: upn,
                    status: "failure",
                    error: "clipboard-denied",
                });
            }
        }
        finally {
            setBusy(false);
        }
    }), [upn, store]);
    const Icon = busy ? Loader2 : copied ? Check : Copy;
    return (React.createElement(Button, { type: "button", variant: variant, size: size, onClick: handleClick, disabled: busy, className: cn(className), "aria-label": label, title: `${label} — ${upn}` },
        React.createElement(Icon, { className: busy ? "animate-spin" : undefined }),
        copied ? "Copied" : label));
};
//# sourceMappingURL=portal-login-button.js.map