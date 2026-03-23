export interface ActionableError {
    message: string;
    suggestion: string;
}

export function getActionableErrorMessage(error: string): ActionableError {
    const lower = error.toLowerCase();

    if (lower.includes("401") || lower.includes("unauthorized")) {
        return {
            message: "Authentication failed",
            suggestion:
                "Your token may have expired. Run `az login` and retry.",
        };
    }
    if (lower.includes("403") || lower.includes("forbidden")) {
        return {
            message: "Access denied",
            suggestion:
                "You may not have permissions on this subscription. Check your Azure RBAC role.",
        };
    }
    if (lower.includes("429") || lower.includes("too many requests")) {
        return {
            message: "Rate limited by Azure",
            suggestion:
                "The scheduler will automatically retry with backoff. No action needed.",
        };
    }
    if (lower.includes("409") || lower.includes("conflict")) {
        return {
            message: "Resource conflict",
            suggestion:
                "The resource may already exist. Try importing existing accounts instead.",
        };
    }
    if (lower.includes("quotaexceeded") || lower.includes("quota exceeded")) {
        return {
            message: "Subscription quota exceeded",
            suggestion:
                "You've hit your subscription's resource limit. Submit a quota increase request first.",
        };
    }
    if (
        lower.includes("resourcegroupnotfound") ||
        lower.includes("resource group")
    ) {
        return {
            message: "Resource group not found",
            suggestion:
                "The resource group may have been deleted. Create accounts again to auto-create it.",
        };
    }
    if (lower.includes("support plan") || lower.includes("supportplan")) {
        return {
            message: "Support plan required",
            suggestion:
                "This subscription needs a paid support plan. Use a different subscription for quota tickets.",
        };
    }
    if (lower.includes("invalid") && lower.includes("email")) {
        return {
            message: "Invalid email address",
            suggestion: "Enter a valid email in the Contact Email field.",
        };
    }
    if (
        lower.includes("500") ||
        lower.includes("502") ||
        lower.includes("503") ||
        lower.includes("internal server")
    ) {
        return {
            message: "Azure service error",
            suggestion:
                "Transient Azure issue. The scheduler will auto-retry. If persistent, check Azure status page.",
        };
    }
    if (lower.includes("network") || lower.includes("fetch")) {
        return {
            message: "Network error",
            suggestion:
                "Check your internet connection and ensure Azure CLI is logged in.",
        };
    }

    return {
        message: error.length > 120 ? error.substring(0, 120) + "..." : error,
        suggestion: "Check the agent logs for more details.",
    };
}
