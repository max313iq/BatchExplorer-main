/**
 * Pure helpers for the Storage & Key Vault Security Audit page.
 *
 * Why a helpers module: the page component drives the UI (subscription
 * picker, filters, tables, exports) and dispatches network calls. The
 * actual *interpretation* — "is THIS storage-account config a finding?
 * how severe? what does the operator fix?" — is pure logic that we
 * want to keep typecheckable and unit-test-friendly without dragging
 * React state in.
 *
 * Defensive lineage (MicroBurst inspiration):
 *   - Storage:  Invoke-EnumerateAzureBlobs / public-access analysis
 *               -> here we audit the OWNED storage accounts' public-
 *                  access flag instead of attacking unknown ones.
 *   - KeyVault: Get-AzKeyVaults (config audit) -> we report soft-
 *               delete / purge-protection / RBAC / network defaults.
 *
 * Output: a flat list of `Finding` rows the page renders. Each row
 * carries enough metadata for the table cells (icon + name + RG +
 * region), the severity badge, the two tooltips ("why it matters" +
 * "remediation"), the copy-id action, and the Portal deep-link.
 */
export const SEVERITY_WEIGHT = {
    critical: 4,
    high: 3,
    medium: 2,
    info: 1,
    none: 0,
};
export const SEVERITY_LABEL = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    info: "Info",
    none: "None",
};
/** Badge variant the UI maps each severity to. Keeps the color
 *  vocabulary in one place so a tone tweak is a single edit. */
export const SEVERITY_BADGE_VARIANT = {
    critical: "destructive",
    high: "warning",
    medium: "info",
    info: "outline",
    none: "secondary",
};
export function parseArmId(armId) {
    // /subscriptions/{sub}/resourceGroups/{rg}/providers/{ns}/{type}/{name}
    const parts = armId.split("/").filter(Boolean);
    const find = (key) => {
        const i = parts.findIndex((p) => p.toLowerCase() === key.toLowerCase());
        return i >= 0 && i + 1 < parts.length ? parts[i + 1] : "";
    };
    const provIdx = parts.findIndex((p) => p.toLowerCase() === "providers");
    const providerNamespace = provIdx >= 0 && provIdx + 1 < parts.length ? parts[provIdx + 1] : "";
    const resourceType = provIdx >= 0 && provIdx + 2 < parts.length ? parts[provIdx + 2] : "";
    const resourceName = provIdx >= 0 && provIdx + 3 < parts.length ? parts[provIdx + 3] : "";
    return {
        subscriptionId: find("subscriptions"),
        resourceGroup: find("resourceGroups"),
        providerNamespace,
        resourceType,
        resourceName,
    };
}
/**
 * Build the Azure Portal deep-link URL for an ARM resource id. The
 * portal's `#@/resource/...` fragment is stable across tenants — the
 * user lands on the resource blade and the portal handles the tenant
 * switch if they're signed into multiple directories.
 */
export function portalUrlFor(armId) {
    // Encode each segment individually so slashes inside the id survive
    // the path part, while reserved chars are still escaped.
    const encoded = armId
        .split("/")
        .map((s) => encodeURIComponent(s))
        .join("/");
    return `https://portal.azure.com/#@/resource${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}
function makeFinding(ctx, resourceType, rule) {
    return {
        id: `${ctx.resourceId}::${rule.ruleId}`,
        resourceType,
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        resourceGroup: ctx.resourceGroup,
        region: ctx.region,
        subscriptionId: ctx.subscriptionId,
        subscriptionName: ctx.subscriptionName,
        ruleId: rule.ruleId,
        title: rule.title,
        description: rule.description,
        whyItMatters: rule.whyItMatters,
        remediation: rule.remediation,
        severity: rule.severity,
    };
}
// ----------------------------------------------------------------------
// Storage-account rules
// ----------------------------------------------------------------------
/**
 * Apply every storage-account rule to a single account. Returns the
 * findings list (possibly empty if the account is well-configured).
 *
 * Rule decisions deliberately mirror the criteria in MicroBurst's
 * blob-enum + public-access modules — but flipped: instead of
 * *finding* publicly-accessible storage to attack, we *flag* the
 * operator's own accounts that an attacker would notice.
 */
export function evaluateStorageAccount(sa, subscriptionName) {
    var _a, _b, _c;
    const out = [];
    const parsed = parseArmId(sa.id);
    const ctx = {
        resourceId: sa.id,
        resourceName: sa.name,
        resourceGroup: parsed.resourceGroup,
        region: sa.location,
        subscriptionId: parsed.subscriptionId,
        subscriptionName,
    };
    const props = (_a = sa.properties) !== null && _a !== void 0 ? _a : {};
    const acls = (_b = props.networkAcls) !== null && _b !== void 0 ? _b : {};
    const defaultAction = ((_c = acls.defaultAction) !== null && _c !== void 0 ? _c : "").toLowerCase();
    const ipRules = Array.isArray(acls.ipRules) ? acls.ipRules : [];
    const vnetRules = Array.isArray(acls.virtualNetworkRules)
        ? acls.virtualNetworkRules
        : [];
    // 🔴 Critical: public-access flag ON + firewall set to allow-all.
    // Worst combination: any unauthenticated request can hit any blob
    // container the account owns, because nothing's gating the network.
    if (props.allowBlobPublicAccess === true &&
        defaultAction === "allow") {
        out.push(makeFinding(ctx, "storage", {
            ruleId: "storage.publicly-accessible",
            title: "Publicly accessible blob storage",
            description: "Public blob access is permitted AND the network firewall defaults to Allow.",
            whyItMatters: "Anonymous internet readers can enumerate and download any blob container marked Public/Blob/Container. MicroBurst's Invoke-EnumerateAzureBlobs walks exactly this surface — every account that matches this pattern is one container-misconfigure away from a public data leak.",
            remediation: 'Disable account-level public blob access: az storage account update -n ' +
                sa.name +
                ' -g ' +
                parsed.resourceGroup +
                ' --allow-blob-public-access false ; then set network default action to Deny and add VNet/IP rules for the workloads that need access.',
            severity: "critical",
        }));
    }
    else if (props.allowBlobPublicAccess === true) {
        // 🟠 High: flag still permits container-level public exposure even
        // if the network firewall is locked down — a future operator
        // setting a container to Public would not be blocked by the account
        // policy.
        out.push(makeFinding(ctx, "storage", {
            ruleId: "storage.allow-public-access",
            title: "Blob public access permitted at account level",
            description: "allowBlobPublicAccess=true — a container can be flipped Public without re-checking firewall.",
            whyItMatters: "Defense in depth: the account-level flag should explicitly block public blob access so a per-container slip (someone setting a container to PublicAccess=Container) is contained. Microsoft's storage hardening baseline (Azure Security Benchmark v3 / NIST 800-53 AC-6) calls this out as a required deny.",
            remediation: "az storage account update -n " +
                sa.name +
                " -g " +
                parsed.resourceGroup +
                " --allow-blob-public-access false",
            severity: "high",
        }));
    }
    // 🟠 High: HTTPS-only off — secrets/SAS tokens traverse cleartext.
    if (props.supportsHttpsTrafficOnly === false) {
        out.push(makeFinding(ctx, "storage", {
            ruleId: "storage.http-allowed",
            title: "HTTP traffic allowed (HTTPS not enforced)",
            description: "supportsHttpsTrafficOnly=false — SAS tokens and account keys can leak over plaintext.",
            whyItMatters: "Without HTTPS-only enforcement, a misconfigured client (or an attacker on the same path) can downgrade the request to HTTP. Both the storage SAS query string AND the shared-access key end up in cleartext — these are bearer credentials, so a single capture is full compromise.",
            remediation: "az storage account update -n " +
                sa.name +
                " -g " +
                parsed.resourceGroup +
                " --https-only true",
            severity: "high",
        }));
    }
    // 🟡 Medium: deprecated TLS 1.0/1.1.
    if (props.minimumTlsVersion === "TLS1_0" ||
        props.minimumTlsVersion === "TLS1_1") {
        out.push(makeFinding(ctx, "storage", {
            ruleId: "storage.deprecated-tls",
            title: "Deprecated TLS version permitted",
            description: `minimumTlsVersion=${props.minimumTlsVersion} — vulnerable to known TLS downgrade attacks.`,
            whyItMatters: "TLS 1.0/1.1 are deprecated by the IETF (RFC 8996), PCI-DSS, and Microsoft's own retirement policy. Leaving them enabled lets a MITM force a downgrade and exploit BEAST / POODLE / Lucky13. No modern client requires < TLS 1.2.",
            remediation: "az storage account update -n " +
                sa.name +
                " -g " +
                parsed.resourceGroup +
                " --min-tls-version TLS1_2",
            severity: "medium",
        }));
    }
    // 🟡 Medium: shared-key auth not preferred AND not blocked. The
    // exact field combination that flags is `defaultToOAuthAuthentication
    // !== true` AND `allowSharedKeyAccess !== false`. If shared-key has
    // been explicitly disabled (false), the OAuth-default flag becomes
    // moot — there's no shared key left to use.
    const oauthDefault = props.defaultToOAuthAuthentication === true;
    const sharedKeyBlocked = props.allowSharedKeyAccess === false;
    if (!oauthDefault && !sharedKeyBlocked) {
        out.push(makeFinding(ctx, "storage", {
            ruleId: "storage.shared-key-default",
            title: "Shared-key auth is the default (no AAD preference)",
            description: "defaultToOAuthAuthentication is not true and allowSharedKeyAccess is not false — clients fall back to account keys.",
            whyItMatters: "Account keys are bearer credentials with full control of the storage account. They can't be audited per-user, can't be MFA-protected, and rotation is painful. Preferring AAD/OAuth means every access ties back to a real principal in the audit log.",
            remediation: "Set defaultToOAuthAuthentication=true and, if your workloads support it, set allowSharedKeyAccess=false. az storage account update -n " +
                sa.name +
                " -g " +
                parsed.resourceGroup +
                " --default-share-permission StorageFileDataSmbShareReader (and use Storage Blob Data * roles).",
            severity: "medium",
        }));
    }
    // 🟢 Info: open network ACLs with no IP/VNet rules. Allowed = Allow
    // is the Azure default but it's worth flagging so the operator
    // knows nothing's gating IP-level access.
    if (defaultAction === "allow" &&
        ipRules.length === 0 &&
        vnetRules.length === 0) {
        out.push(makeFinding(ctx, "storage", {
            ruleId: "storage.no-network-restrictions",
            title: "No network restrictions configured",
            description: "networkAcls.defaultAction=Allow with no IP or VNet rules — reachable from any IP.",
            whyItMatters: "Even with HTTPS + AAD, an attacker who lands an account key (e.g. via a leaked DevOps variable) can hit the account from anywhere on the public internet. Tying access to a known IP range / VNet shrinks the credential's blast radius.",
            remediation: "az storage account network-rule add for each trusted source, then az storage account update --default-action Deny.",
            severity: "info",
        }));
    }
    return out;
}
// ----------------------------------------------------------------------
// Key Vault rules
// ----------------------------------------------------------------------
/**
 * Apply every Key Vault rule to a single vault. Mirrors the spirit of
 * MicroBurst's Get-AzKeyVaults audit module — soft-delete / purge-
 * protection / RBAC / wildcard policies are the recurring findings
 * that NetSPI's blog calls out as the highest-value misconfigurations
 * for both attackers and defenders.
 */
export function evaluateKeyVault(kv, subscriptionName) {
    var _a, _b, _c, _d, _e, _f;
    const out = [];
    const parsed = parseArmId(kv.id);
    const ctx = {
        resourceId: kv.id,
        resourceName: kv.name,
        resourceGroup: parsed.resourceGroup,
        region: kv.location,
        subscriptionId: parsed.subscriptionId,
        subscriptionName,
    };
    const props = (_a = kv.properties) !== null && _a !== void 0 ? _a : {};
    const acls = (_b = props.networkAcls) !== null && _b !== void 0 ? _b : {};
    const defaultAction = ((_c = acls.defaultAction) !== null && _c !== void 0 ? _c : "").toLowerCase();
    const accessPolicies = (_d = props.accessPolicies) !== null && _d !== void 0 ? _d : [];
    // 🔴 Critical: purge protection OFF. Without it, a soft-deleted vault
    // (or secret) can be hard-deleted before the retention window — an
    // attacker with Contributor can wipe vault contents irrecoverably.
    if (props.enablePurgeProtection !== true) {
        out.push(makeFinding(ctx, "keyvault", {
            ruleId: "keyvault.no-purge-protection",
            title: "Purge protection disabled",
            description: "enablePurgeProtection is not true — vault contents can be hard-deleted before the retention window.",
            whyItMatters: "Without purge protection an attacker (or a panicked admin) can soft-delete then immediately purge keys/secrets/certificates, bypassing the retention window. Recovery from backup may not be possible if the vault held a CMK that wrapped a Storage / SQL encryption key — those resources become unreadable.",
            remediation: "az keyvault update -n " +
                kv.name +
                " -g " +
                parsed.resourceGroup +
                " --enable-purge-protection true (irreversible — plan it).",
            severity: "critical",
        }));
    }
    // 🟠 High: soft-delete OFF (legacy vaults — new vaults can't disable
    // it, but pre-2020 ones can still be in this state).
    if (props.enableSoftDelete !== true) {
        out.push(makeFinding(ctx, "keyvault", {
            ruleId: "keyvault.no-soft-delete",
            title: "Soft delete disabled",
            description: "enableSoftDelete is not true — deletes are immediate with no recovery window.",
            whyItMatters: "Soft delete is the only undo button for accidental or malicious secret/key deletion. Without it, a single bad pipeline run that wipes the vault is unrecoverable. Microsoft made soft-delete mandatory on new vaults in 2020 — pre-2020 vaults must be upgraded explicitly.",
            remediation: "az keyvault update -n " +
                kv.name +
                " -g " +
                parsed.resourceGroup +
                " --enable-soft-delete true",
            severity: "high",
        }));
    }
    // 🟠 High: public network access ON + network ACL default Allow.
    const publicNetworkAccessOn = ((_e = props.publicNetworkAccess) !== null && _e !== void 0 ? _e : "").toLowerCase() === "enabled";
    if (publicNetworkAccessOn && defaultAction === "allow") {
        out.push(makeFinding(ctx, "keyvault", {
            ruleId: "keyvault.publicly-reachable",
            title: "Vault reachable from the public internet",
            description: "publicNetworkAccess=Enabled and networkAcls.defaultAction=Allow — reachable from any IP.",
            whyItMatters: "A leaked credential, OAuth token, or SAS that grants the vault data-plane role can be used from anywhere on the public internet. Locking the vault to private endpoints or a small VNet/IP allowlist drops the credential's usable blast radius.",
            remediation: 'az keyvault update -n ' +
                kv.name +
                ' -g ' +
                parsed.resourceGroup +
                ' --public-network-access Disabled (or set --default-action Deny and add --ip-address/--subnet rules).',
            severity: "high",
        }));
    }
    // 🟡 Medium: legacy access-policies mode (not RBAC).
    if (props.enableRbacAuthorization !== true) {
        out.push(makeFinding(ctx, "keyvault", {
            ruleId: "keyvault.legacy-access-policies",
            title: "Legacy access policies (not RBAC)",
            description: "enableRbacAuthorization is not true — vault uses access-policies, which Microsoft is deprecating.",
            whyItMatters: "Access policies live on the vault resource itself, can't be audited or assigned at scale via Azure Policy/Bicep, and don't compose with PIM/Conditional Access. RBAC mode uses standard Azure role assignments — same tooling, same audit trail as every other Azure resource.",
            remediation: "Migrate to RBAC: az keyvault update -n " +
                kv.name +
                " -g " +
                parsed.resourceGroup +
                " --enable-rbac-authorization true ; then assign Key Vault Secrets User / Key Vault Crypto User roles to your principals.",
            severity: "medium",
        }));
    }
    // 🟡 Medium: retention < 30 days. The default is 90; lowering it
    // shortens the recovery window for soft-deleted items.
    if (typeof props.softDeleteRetentionInDays === "number" &&
        props.softDeleteRetentionInDays < 30) {
        out.push(makeFinding(ctx, "keyvault", {
            ruleId: "keyvault.short-retention",
            title: "Soft-delete retention below 30 days",
            description: `softDeleteRetentionInDays=${props.softDeleteRetentionInDays} — recovery window is too short.`,
            whyItMatters: "A short retention window means an accidental delete that goes unnoticed for a weekend (or a long deploy freeze) becomes unrecoverable. Microsoft's default is 90 days for a reason — recovery operations rarely happen the same day.",
            remediation: "Retention is immutable on most vaults — recreate the vault with --retention-days 90.",
            severity: "medium",
        }));
    }
    // 🟢 Info: large access-policies array — operational risk of stale
    // principals. Threshold of 10 matches NetSPI's "review needed"
    // recommendation in the Get-AzKeyVaults output.
    if (accessPolicies.length > 10) {
        out.push(makeFinding(ctx, "keyvault", {
            ruleId: "keyvault.many-access-policies",
            title: `Many access policies (${accessPolicies.length} entries)`,
            description: "More than 10 access-policy entries — review for stale principals (left-the-company, deleted-SPN).",
            whyItMatters: "Access policies don't auto-clean when the principal is deleted in AAD — the entry stays as a dangling objectId. A new AAD principal that gets the same objectId (rare but possible) would inherit access. Wide policy sets are also a signal that the team should migrate to RBAC for proper auditability.",
            remediation: "Audit each policy entry — `az keyvault show -n " +
                kv.name +
                "` then remove unknown / deleted principals via `az keyvault delete-policy`.",
            severity: "info",
        }));
    }
    // 🟢 Info: wildcard permission set. Treat `["all"]` (or `["*"]`)
    // on any permission family as a finding worth surfacing — most
    // workloads need a narrow slice (e.g. get/list secrets only).
    const wildcardPolicy = accessPolicies.find((p) => {
        var _a;
        const perms = (_a = p.permissions) !== null && _a !== void 0 ? _a : {};
        const fams = [
            perms.keys,
            perms.secrets,
            perms.certificates,
            perms.storage,
        ];
        return fams.some((arr) => Array.isArray(arr) &&
            arr.some((perm) => perm.toLowerCase() === "all" || perm === "*"));
    });
    if (wildcardPolicy) {
        out.push(makeFinding(ctx, "keyvault", {
            ruleId: "keyvault.wildcard-policy",
            title: "Access policy with wildcard permissions",
            description: `At least one access policy grants ["all"] / ["*"] on keys, secrets, certs, or storage (objectId ${(_f = wildcardPolicy.objectId) !== null && _f !== void 0 ? _f : "unknown"}).`,
            whyItMatters: 'A wildcard permission set grants every operation in the family — including destructive ones (purge, backup-restore, regenerate). Most workloads only need a narrow slice (e.g. "get + list" on secrets). Wildcard is the Key Vault equivalent of "Contributor on /" — almost never the right scope.',
            remediation: "Replace wildcard with the explicit set the workload needs. Example for a secrets reader: --secret-permissions get list (drop set/delete/purge/recover/backup/restore).",
            severity: "info",
        }));
    }
    return out;
}
export function summarizeFindings(findings, scanned) {
    let critical = 0;
    let high = 0;
    let medium = 0;
    let info = 0;
    for (const f of findings) {
        if (f.severity === "critical")
            critical++;
        else if (f.severity === "high")
            high++;
        else if (f.severity === "medium")
            medium++;
        else if (f.severity === "info")
            info++;
    }
    return {
        total: findings.length,
        critical,
        high,
        medium,
        info,
        storageScanned: scanned.storage,
        vaultsScanned: scanned.vaults,
    };
}
/**
 * Default sort: severity descending then name ascending. Stable
 * comparator so successive sorts keep the within-severity order
 * predictable.
 */
export function compareFindings(a, b) {
    const w = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (w !== 0)
        return w;
    return a.resourceName.localeCompare(b.resourceName);
}
/** Severity bucket counts including ones with 0 — used by chip UI. */
export function countBySeverity(findings) {
    const acc = {
        critical: 0,
        high: 0,
        medium: 0,
        info: 0,
        none: 0,
    };
    for (const f of findings)
        acc[f.severity] += 1;
    return acc;
}
export function countByResourceType(findings) {
    const acc = {
        storage: 0,
        keyvault: 0,
        "diagnostic-setting": 0,
        subscription: 0,
        "storage-container": 0,
        "resource-group": 0,
    };
    for (const f of findings)
        acc[f.resourceType] += 1;
    return acc;
}
//# sourceMappingURL=security-audit-helpers.js.map