export interface ActionableError {
    message: string;
    suggestion: string;
}

export interface BatchApiError {
    code: string;
    message: string;
    statusCode?: number;
    retryable: boolean;
}

export type ErrorClassification =
    | "AuthenticationFailed"
    | "QuotaExceeded"
    | "InsufficientCapacity"
    | "PoolExists"
    | "Retryable"
    | "Unknown";

export function classifyError(
    error: string,
    statusCode?: number
): ErrorClassification {
    const lower = error.toLowerCase();

    if (
        lower.includes("authenticationfailed") ||
        lower.includes("unauthorized") ||
        lower.includes("invalid token") ||
        statusCode === 401
    ) {
        return "AuthenticationFailed";
    }

    if (
        lower.includes("quotaexceeded") ||
        lower.includes("quota exceeded") ||
        lower.includes("exceeded the quota")
    ) {
        return "QuotaExceeded";
    }

    if (
        lower.includes("insufficientcapacity") ||
        lower.includes("insufficient capacity") ||
        lower.includes("allocationfailed") ||
        lower.includes("allocation failed") ||
        lower.includes("not enough capacity")
    ) {
        return "InsufficientCapacity";
    }

    if (
        lower.includes("poolexists") ||
        lower.includes("pool already exists") ||
        (lower.includes("conflict") && lower.includes("pool"))
    ) {
        return "PoolExists";
    }

    if (
        statusCode === 429 ||
        lower.includes("429") ||
        lower.includes("too many requests") ||
        (statusCode !== undefined && statusCode >= 500) ||
        lower.includes("500") ||
        lower.includes("502") ||
        lower.includes("503") ||
        lower.includes("504") ||
        lower.includes("internal server")
    ) {
        return "Retryable";
    }

    return "Unknown";
}

export function getActionableErrorMessage(
    error: string,
    statusCode?: number
): ActionableError {
    const classification = classifyError(error, statusCode);

    switch (classification) {
        case "AuthenticationFailed":
            return {
                message: "Authentication failed",
                suggestion:
                    "Re-run `az login` to refresh your credentials and retry.",
            };
        case "QuotaExceeded":
            return {
                message: "Quota exceeded",
                suggestion:
                    "Request a quota increase in the Azure portal or via the Quota Requests page.",
            };
        case "InsufficientCapacity":
            return {
                message: "Insufficient capacity in region",
                suggestion:
                    "Try a different VM size or region. Check Azure capacity status.",
            };
        case "PoolExists":
            return {
                message: "Pool already exists",
                suggestion:
                    "Choose a different pool ID or delete the existing pool first.",
            };
        case "Retryable":
            return {
                message: "Retryable error",
                suggestion:
                    "Retryable error: the scheduler will automatically retry with backoff. No action needed.",
            };
    }

    // Fall through to existing detailed matching for Unknown classification
    const errLower = error.toLowerCase();

    if (errLower.includes("401") || errLower.includes("unauthorized")) {
        return {
            message: "Authentication failed",
            suggestion:
                "Your token may have expired. Run `az login` and retry.",
        };
    }
    if (errLower.includes("403") || errLower.includes("forbidden")) {
        return {
            message: "Access denied",
            suggestion:
                "You may not have permissions on this subscription. Check your Azure RBAC role.",
        };
    }
    if (errLower.includes("429") || errLower.includes("too many requests")) {
        return {
            message: "Rate limited by Azure",
            suggestion:
                "The scheduler will automatically retry with backoff. No action needed.",
        };
    }
    if (errLower.includes("409") || errLower.includes("conflict")) {
        return {
            message: "Resource conflict",
            suggestion:
                "The resource may already exist. Try importing existing accounts instead.",
        };
    }
    if (
        errLower.includes("quotaexceeded") ||
        errLower.includes("quota exceeded")
    ) {
        return {
            message: "Subscription quota exceeded",
            suggestion:
                "You've hit your subscription's resource limit. Submit a quota increase request first.",
        };
    }
    if (
        errLower.includes("resourcegroupnotfound") ||
        errLower.includes("resource group")
    ) {
        return {
            message: "Resource group not found",
            suggestion:
                "The resource group may have been deleted. Create accounts again to auto-create it.",
        };
    }
    if (errLower.includes("support plan") || errLower.includes("supportplan")) {
        return {
            message: "Support plan required",
            suggestion:
                "This subscription needs a paid support plan. Use a different subscription for quota tickets.",
        };
    }
    if (errLower.includes("invalid") && errLower.includes("email")) {
        return {
            message: "Invalid email address",
            suggestion: "Enter a valid email in the Contact Email field.",
        };
    }
    if (
        errLower.includes("500") ||
        errLower.includes("502") ||
        errLower.includes("503") ||
        errLower.includes("internal server")
    ) {
        return {
            message: "Azure service error",
            suggestion:
                "Transient Azure issue. The scheduler will auto-retry. If persistent, check Azure status page.",
        };
    }
    if (errLower.includes("network") || errLower.includes("fetch")) {
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
