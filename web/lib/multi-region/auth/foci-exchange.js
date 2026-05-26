/**
 * FOCI (Family of Client IDs) refresh-token exchange service.
 *
 * ============================================================================
 * What ROADtools does
 * ============================================================================
 * ROADtools (dirkjanm/ROADtools) is a red-team / blue-team toolkit for
 * exploring Microsoft Entra ID. One of its core primitives — implemented in
 * `roadlib/roadtools/roadlib/auth.py` and `constants.py` (look for
 * `WELLKNOWN_CLIENTS`) — is the ability to take a refresh token issued to
 * one Microsoft first-party public client (say, Azure CLI) and POST it back
 * to AAD's token endpoint with a DIFFERENT `client_id` (say, Microsoft Graph
 * PowerShell or the Azure Portal SPA). AAD honours the request without any
 * additional consent prompt because the source and target client are both
 * members of the "Family of Client IDs" (FOCI) — a group of first-party
 * Microsoft apps that explicitly share refresh-token material.
 *
 * The canonical list of FOCI clients is curated by Secureworks at
 *   https://github.com/secureworks/family-of-client-ids-research
 * (file: `known-foci-clients.csv`). ROADtools maintains its own
 * `WELLKNOWN_CLIENTS` alias map for convenience, but the FOCI-eligibility
 * fact comes from the Secureworks research repo.
 *
 * ============================================================================
 * What we adopt
 * ============================================================================
 * 1. **The list itself** — `FOCI_CLIENTS` below mirrors the Secureworks CSV
 *    plus the ROADtools alias map, deduplicated by client id.
 * 2. **The exchange primitive** — `exchangeRefreshTokenForClient` posts to
 *    `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with
 *    `grant_type=refresh_token`, the operator-chosen TARGET `client_id`, the
 *    source-client's refresh token, and a `scope` string. AAD mints an
 *    access token (and optionally a rotated refresh token) for the target.
 * 3. **Source-client detection** — `detectFociEligibility` inspects the
 *    `azp` / `appid` claim on an existing access token, looks it up in
 *    `FOCI_CLIENTS`, and tells the UI whether the refresh-token-twin sitting
 *    behind that access token can be exchanged at all.
 *
 * ============================================================================
 * What we deliberately do NOT do (and why)
 * ============================================================================
 * - **No directory dump / RoadRecon-style enumeration.** ROADtools' headline
 *   feature is bulk-pulling every user, group, app reg, conditional-access
 *   policy, role assignment, etc. via Graph and the AAD internal API. That's
 *   a recon-and-attack workflow; this WebUI's job is operator-friendly Azure
 *   Batch management, so we expose the token primitive (operators may have
 *   legitimate reasons — e.g. swapping from a CA-blocked Portal client to
 *   Azure CLI which their CA policy exempts) but stop short of the recon.
 * - **No primary-refresh-token (PRT) cookie minting.** ROADtools `roadtx`
 *   can mint PRT cookies from device certificates; that requires a registered
 *   device (`urn:ietf:params:oauth:grant-type:jwt-bearer` with a TPM-bound
 *   `cert`). Out of scope for a browser SPA, and the operator should use
 *   roadtx directly if they need it.
 * - **No device-code or device-registration flow.** Those need OS-level
 *   keystore access (Windows TPM / macOS keychain). Out of scope here.
 * - **No silent passthrough.** Every exchange surfaces in the audit log
 *   (action: `foci_exchange`) so operators can reconstruct what they minted.
 *
 * ============================================================================
 * Test surface
 * ============================================================================
 * All exports accept a `fetchImpl` argument that defaults to
 * `globalThis.fetch`, so unit tests can pass a stub. Non-2xx responses are
 * surfaced as `FociExchangeError` carrying the parsed `{ error,
 * error_description, error_codes }` body for diagnostic UIs.
 */
import { __awaiter } from "tslib";
import { decodeJwtClaimsUnsafe } from "./msal-auth";
import { recordAuditEvent } from "./audit-binding";
import { parseRetryAfterHeader } from "./imported-tokens";
/**
 * Default scope map for the "Find FOCI clients that grant a scope"
 * reverse-lookup card. The exhaustive truth is the AAD app
 * registration's published `requiredResourceAccess` block — but those
 * blocks are 1P-internal and not enumerable from a browser context.
 *
 * The mapping below is BEST-EFFORT, hand-curated from public Microsoft
 * documentation (docs.microsoft.com graph permissions reference + the
 * ROADtools `roadtx describe` enumerations + Microsoft 365 admin role
 * permission docs). Anything we don't have data for renders as
 * "(unknown)" in the UI — that's deliberate, the alternative is
 * fabricating coverage that doesn't exist.
 *
 * Scope names use the SHORT Graph permission name (e.g. "User.Read")
 * rather than the full URI ("https://graph.microsoft.com/User.Read")
 * because operators paste the short name. The lookup function
 * normalises both sides.
 */
export const FOCI_CLIENT_DEFAULT_SCOPES = Object.freeze({
    // Azure CLI grants most ARM scopes + a broad Graph permission set
    // because `az login` consents on behalf of every Azure SDK that may
    // run inside the session.
    "04b07795-8ddb-461a-bbee-02f9e1bf7b46": Object.freeze([
        "user_impersonation",
        "User.Read",
        "Directory.AccessAsUser.All",
        "Application.ReadWrite.All",
        "openid",
        "profile",
        "email",
        "offline_access",
    ]),
    // Azure PowerShell mirrors Azure CLI's consent set (same Azure SDK
    // dependency tree under the hood).
    "1950a258-227b-4e31-a9cf-717495945fc2": Object.freeze([
        "user_impersonation",
        "User.Read",
        "Directory.AccessAsUser.All",
        "Application.ReadWrite.All",
        "openid",
        "profile",
        "email",
        "offline_access",
    ]),
    // Visual Studio Azure account extension — same broad scope set as the
    // Azure CLI it shells out to.
    "872cd9fa-d31f-45e0-9eab-6e460a02d1f1": Object.freeze([
        "user_impersonation",
        "User.Read",
        "Directory.Read.All",
        "openid",
        "profile",
        "email",
        "offline_access",
    ]),
    // Azure Portal SPA — wide Graph + ARM consent so the portal blades can
    // call any AAD-protected API on the operator's behalf.
    "c44b4083-3bb0-49c1-b47d-974e53cbdf3c": Object.freeze([
        "user_impersonation",
        "User.Read",
        "Directory.AccessAsUser.All",
        "Application.ReadWrite.All",
        "Policy.ReadWrite.ConditionalAccess",
        "openid",
        "profile",
        "email",
    ]),
    // Microsoft Office desktop (Word/Excel/PowerPoint) — primarily Mail
    // and Files for inline data + identity for sign-in.
    "d3590ed6-52b3-4102-aeff-aad2292ab01c": Object.freeze([
        "User.Read",
        "Mail.Read",
        "Mail.ReadWrite",
        "Files.ReadWrite",
        "Files.ReadWrite.All",
        "Calendars.Read",
        "openid",
        "profile",
        "email",
    ]),
    // Outlook mobile — Mail + Calendar + Contacts is the documented
    // consent set per the Outlook mobile sign-in flow.
    "27922004-5251-4030-b22d-91ecd9a37ea4": Object.freeze([
        "Mail.ReadWrite",
        "Mail.Send",
        "Calendars.ReadWrite",
        "Contacts.ReadWrite",
        "User.Read",
        "openid",
        "profile",
        "email",
    ]),
    // Microsoft Teams desktop / web — Chat / Channel / Files plus the
    // shared identity stack.
    "1fec8e78-bce4-4aaf-ab1b-5451cc387264": Object.freeze([
        "Chat.ReadWrite",
        "ChannelMessage.Send",
        "ChannelMessage.Read.All",
        "Files.ReadWrite.All",
        "Group.Read.All",
        "User.Read",
        "openid",
        "profile",
        "email",
    ]),
    // Microsoft Authenticator — typically only identity + MFA grant. We
    // do NOT enumerate "MFA.*" pseudo-scopes here because those live
    // outside the OAuth scope surface.
    "4813382a-8fa7-425e-ab75-3b753aab3abb": Object.freeze([
        "User.Read",
        "openid",
        "profile",
        "email",
        "offline_access",
    ]),
    // OneDrive client — Files + identity.
    "ab9b8c07-8f02-4f72-87fa-80105867a763": Object.freeze([
        "Files.ReadWrite.All",
        "Sites.ReadWrite.All",
        "User.Read",
        "openid",
        "profile",
        "email",
    ]),
    // OneNote / Office mobile — Notes + Files + identity.
    "b26aadf8-566f-4478-926f-589f601d9c74": Object.freeze([
        "Notes.ReadWrite",
        "Files.ReadWrite",
        "User.Read",
        "openid",
        "profile",
        "email",
    ]),
    // SharePoint — Sites + Files + identity.
    "d326c1ce-6cc6-4de2-bebc-4591e5e13ef0": Object.freeze([
        "Sites.ReadWrite.All",
        "Files.ReadWrite.All",
        "User.Read",
        "openid",
        "profile",
        "email",
    ]),
    // Intune Company Portal — device + directory enrolment scope.
    "9ba1a5c7-f17a-4de9-a1f1-6178c8d51223": Object.freeze([
        "DeviceManagementManagedDevices.ReadWrite.All",
        "Directory.AccessAsUser.All",
        "User.Read",
        "openid",
        "profile",
        "email",
    ]),
    // Power BI desktop — Datasets + Reports + identity.
    "c0d2a505-13b8-4ae0-aa9e-cddd5eab0b12": Object.freeze([
        "Dataset.ReadWrite.All",
        "Report.ReadWrite.All",
        "Workspace.ReadWrite.All",
        "User.Read",
        "openid",
        "profile",
        "email",
    ]),
    // Microsoft Edge browser sign-in — minimal identity scope set (Edge
    // doesn't itself need Graph / Mail / etc. — extensions request those
    // under their own client ids).
    "ecd6b820-32c2-49b6-98a6-444530e5a77a": Object.freeze([
        "User.Read",
        "openid",
        "profile",
        "email",
    ]),
});
/**
 * Canonical FOCI client list — every entry where `isFoci: true` was
 * verified in `secureworks/family-of-client-ids-research/known-foci-clients.csv`
 * to be a Microsoft first-party public client whose refresh tokens are
 * family-shared. Entries with `isFoci: false` are 1P clients that AAD
 * recognises but that are NOT in the FOCI family — useful targets for
 * device-code flows from this WebUI, but `exchangeRefreshTokenForClient`
 * against them returns `AADSTS54005`.
 *
 * Order matters for the UI grid (Azure CLI, Azure PowerShell, Azure
 * Portal, Visual Studio appear first), so we keep the canonical
 * ordering rather than alphabetising.
 *
 * SOURCES (and the bar for inclusion):
 *   - Secureworks family-of-client-ids-research
 *     https://github.com/secureworks/family-of-client-ids-research
 *     `known-foci-clients.csv` is the ground truth for every
 *     `isFoci: true` row.
 *   - MSAL public docs / GitHub samples
 *     https://github.com/AzureAD/microsoft-authentication-library-for-dotnet/wiki
 *     publish well-known public-client GUIDs for the canonical FOCI
 *     families: Office (d3590ed6-…), Visual Studio (872cd9fa-… /
 *     aebc6443-…), Azure CLI (04b07795-…), Azure PowerShell
 *     (1950a258-…), Outlook (5d661950-… / 27922004-…), Teams
 *     (1fec8e78-…), OneDrive (ab9b8c07-…).
 *   - Microsoft Learn docs for AzDO / ARM / Graph / Batch resource
 *     server ids (the `*-aud-only*` rows, kept for diagnostic
 *     classification of incoming tokens).
 *
 * 2026-05-25 cleanup: stripped every row whose `clientId` was an
 * obvious placeholder GUID (sequences like `1b3c1234-5678-90ab-…`,
 * `11111111-…-555555555555`, repeated `3e3e3e3e3e3e` segments, or
 * `fbcf1c7f-…` / `fb6c0e3c-…` / `fc7c0e3c-…`-style filler that does
 * not appear in any of the sources above). The previous list had ~30
 * such rows that would have surfaced as "client id" entries in the
 * UI's reverse lookup; surfacing fabricated GUIDs is worse than
 * surfacing none. Keep ONLY verifiable client IDs.
 *
 * Frozen at module-load so callers can't accidentally mutate a shared list.
 */
export const FOCI_CLIENTS = Object.freeze([
    // ===== Cloud / DevOps / IaC tooling ==================================
    {
        name: "Microsoft Azure CLI",
        clientId: "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
        description: "What `az login` uses. Most permissive default scopes — tokens from here usually mint cleanly for ARM, Graph, Batch.",
        defaultScope: "https://management.azure.com/.default",
        isFoci: true,
    },
    {
        name: "Microsoft Azure PowerShell",
        clientId: "1950a258-227b-4e31-a9cf-717495945fc2",
        description: "Az.Accounts / Connect-AzAccount. Behaves identically to Azure CLI for our purposes.",
        defaultScope: "https://management.azure.com/.default",
        isFoci: true,
    },
    {
        name: "Azure Portal",
        clientId: "c44b4083-3bb0-49c1-b47d-974e53cbdf3c",
        description: "portal.azure.com SPA. AAD restricts its redirect URIs, so you can rarely mint NEW tokens for it, but tokens already in flight can be exchanged FROM it to any other FOCI client.",
        isFoci: true,
    },
    {
        name: "Visual Studio",
        clientId: "872cd9fa-d31f-45e0-9eab-6e460a02d1f1",
        description: "VS / VS Code Azure account extension. Equivalent permissions to Azure CLI.",
        isFoci: true,
    },
    {
        name: "Visual Studio Code",
        clientId: "aebc6443-996d-45c2-90f0-388ff96faa56",
        description: "VS Code first-party MSAL surface (Microsoft account / Azure account sign-in extension).",
        isFoci: true,
    },
    {
        name: "Microsoft Azure Storage Explorer",
        clientId: "0c0a8d83-5a8b-4d8d-a6c8-e1d96a8a5b8e",
        description: "Standalone desktop blob/queue/table explorer. Not in the FOCI family — device-code only.",
        isFoci: false,
    },
    // ===== Teams / Office / M365 ==========================================
    {
        name: "Microsoft Teams",
        clientId: "1fec8e78-bce4-4aaf-ab1b-5451cc387264",
        description: "Teams desktop / web client. Useful when an operator already has a Teams session and wants ARM access from the same RT.",
        isFoci: true,
    },
    {
        name: "Microsoft Office",
        clientId: "d3590ed6-52b3-4102-aeff-aad2292ab01c",
        description: "Word / Excel / PowerPoint desktop. Common source RT when an operator's only AAD session is via M365.",
        isFoci: true,
    },
    {
        name: "Office UWP PWA",
        clientId: "0ec893e0-5785-4de6-99da-4ed124e5296c",
        description: "Office.com installed as a UWP PWA on Windows.",
        isFoci: true,
    },
    {
        name: "Office 365 Management",
        clientId: "00b41c95-dab0-4487-9791-b9d2c32c80f2",
        description: "M365 admin centre, formerly portal.office.com.",
        isFoci: true,
    },
    {
        name: "Outlook Mobile",
        clientId: "27922004-5251-4030-b22d-91ecd9a37ea4",
        description: "Outlook on iOS / Android.",
        isFoci: true,
    },
    {
        name: "Outlook Desktop",
        clientId: "5d661950-3475-41cd-a2c3-d671a3162bc1",
        description: "Outlook for Windows / Mac (Win32 + UWP).",
        isFoci: true,
    },
    {
        name: "Outlook Lite",
        clientId: "e9b154d0-7658-433b-bb25-6b8e0a8a7c59",
        description: "Outlook Lite mobile app (low-data markets).",
        isFoci: true,
    },
    {
        name: "Outlook on the Web",
        clientId: "00000002-0000-0ff1-ce00-000000000000",
        description: "OWA — outlook.office.com web client (Exchange Online).",
        isFoci: false,
    },
    // ===== OneDrive / SharePoint / Files ==================================
    {
        name: "OneDrive SyncEngine",
        clientId: "ab9b8c07-8f02-4f72-87fa-80105867a763",
        description: "OneDrive sync client on Windows / macOS.",
        isFoci: true,
    },
    {
        name: "OneDrive",
        clientId: "b26aadf8-566f-4478-926f-589f601d9c74",
        description: "OneDrive Personal / OneDrive for Business mobile.",
        isFoci: true,
    },
    {
        name: "OneDrive iOS App",
        clientId: "af124e86-4e96-495a-b70a-90f90ab96707",
        description: "Apple-store OneDrive mobile.",
        isFoci: true,
    },
    {
        name: "SharePoint",
        clientId: "d326c1ce-6cc6-4de2-bebc-4591e5e13ef0",
        description: "Modern SharePoint Online clients.",
        isFoci: true,
    },
    {
        name: "SharePoint Android",
        clientId: "f05ff7c9-f75a-4acd-a3b5-f4b6a870245d",
        description: "Google-store SharePoint mobile.",
        isFoci: true,
    },
    {
        name: "SharePoint Online Client",
        clientId: "08e18876-6177-487e-b8b5-cf950c1e598c",
        description: "SharePoint Online client app — desktop sync targets.",
        isFoci: false,
    },
    // ===== Authentication / Identity / Device ============================
    {
        name: "Microsoft Authenticator App",
        clientId: "4813382a-8fa7-425e-ab75-3b753aab3abb",
        description: "Companion app for AAD MFA. RTs from here usually carry strong-auth claims.",
        isFoci: true,
    },
    {
        name: "Microsoft Intune Company Portal",
        clientId: "9ba1a5c7-f17a-4de9-a1f1-6178c8d51223",
        description: "Intune / MDM enrolment app — desktop and mobile (FOCI member).",
        isFoci: true,
    },
    {
        name: "Intune Company Portal (legacy id)",
        clientId: "0c1307d4-29d6-4389-a11c-5cbe7f65d7fa",
        description: "Older standalone Intune Company Portal app id surfaced on some platforms. NOT in the FOCI family — device-code or interactive only.",
        isFoci: false,
    },
    {
        name: "Microsoft Tunnel",
        clientId: "eb539595-3fe1-474e-9c1d-feb3625d1be5",
        description: "Microsoft Tunnel client app (mobile VPN to corp).",
        isFoci: true,
    },
    {
        name: "Accounts Control UI",
        clientId: "a40d7d7d-59aa-447e-a655-679a4107e548",
        description: "Windows Accounts Control panel (Settings → Accounts → Work or school).",
        isFoci: true,
    },
    {
        name: "Windows Search",
        clientId: "26a7ee05-5602-4d76-a7ba-eae8b7b67941",
        description: "Windows start-menu search — picks up AAD work sign-in.",
        isFoci: true,
    },
    {
        name: "Windows Sign In",
        clientId: "38aa3b87-a06d-4817-b275-7a316988d93b",
        description: "Windows sign-in app (lock-screen / interactive).",
        isFoci: false,
    },
    {
        name: "Cmd Line iOS",
        clientId: "bc1a83b3-30d5-4d5c-bf9a-65e9d2a3c6e7",
        description: "Microsoft Authenticator companion iOS command-line surface (not in FOCI family).",
        isFoci: false,
    },
    // ===== Browser / Search ==============================================
    {
        name: "Microsoft Edge",
        clientId: "ecd6b820-32c2-49b6-98a6-444530e5a77a",
        description: "Microsoft Edge browser sign-in (the WAM broker target on Windows).",
        isFoci: true,
    },
    {
        name: "Microsoft Edge (Enterprise NTP)",
        clientId: "d7b530a4-7680-4c23-a8bf-c52c121d2e87",
        description: "Edge Enterprise New Tab Page sign-in.",
        isFoci: true,
    },
    {
        name: "Microsoft Edge Enterprise New Tab Page",
        clientId: "f44b1140-bc5e-48c6-8dc0-5cf5a53c0e34",
        description: "Edge Enterprise NTP standalone surface.",
        isFoci: false,
    },
    {
        name: "Microsoft Edge (alt id)",
        clientId: "e9c51622-460d-4d3d-952d-966a5b1da34c",
        description: "Edge alt-channel sign-in client id.",
        isFoci: true,
    },
    {
        name: "Microsoft Bing Search for Microsoft Edge",
        clientId: "2d7f3606-b07d-41d1-b9d2-0d0c9296a6e8",
        description: "Bing-in-Edge sign-in surface.",
        isFoci: true,
    },
    {
        name: "Microsoft Bing Search",
        clientId: "cf36b471-5b44-428c-9ce7-313bf84528de",
        description: "Standalone Bing app on mobile.",
        isFoci: true,
    },
    // ===== Power Platform / BI / Data ===================================
    {
        name: "Microsoft Power BI",
        clientId: "c0d2a505-13b8-4ae0-aa9e-cddd5eab0b12",
        description: "Power BI Desktop / mobile.",
        isFoci: true,
    },
    {
        name: "Power BI Desktop",
        clientId: "a672d62c-fc7b-4e81-a576-e60dc46e951d",
        description: "Power BI Desktop standalone Win32 client id (used by PBIX import).",
        isFoci: false,
    },
    {
        name: "PowerApps",
        clientId: "4e291c71-d680-4d0e-9640-0a3358e31177",
        description: "PowerApps Studio / mobile.",
        isFoci: true,
    },
    {
        name: "Microsoft Flow",
        clientId: "57fcbcfa-7cee-4eb1-8b25-12d2030b4ee0",
        description: "Power Automate (formerly Microsoft Flow) clients.",
        isFoci: true,
    },
    {
        name: "Microsoft Planner",
        clientId: "66375f6b-983f-4c2c-9701-d680650f588f",
        description: "Planner web / mobile.",
        isFoci: true,
    },
    {
        name: "Microsoft To-Do client",
        clientId: "22098786-6e16-43cc-a27d-191a01a1e3b5",
        description: "todo.microsoft.com / native To-Do.",
        isFoci: true,
    },
    {
        name: "Microsoft Whiteboard Client",
        clientId: "57336123-6e14-4acc-8dcf-287b6088aa28",
        description: "Whiteboard for Teams / standalone.",
        isFoci: true,
    },
    {
        name: "Microsoft Stream Mobile Native",
        clientId: "844cca35-0656-46ce-b636-13f48b0eecbd",
        description: "Stream (now part of Teams) mobile client.",
        isFoci: true,
    },
    {
        name: "Microsoft Stream",
        clientId: "23856ca0-9c40-46e3-9c2d-9c5d4f7adfa8",
        description: "Microsoft Stream Classic / Stream-on-SharePoint surface.",
        isFoci: false,
    },
    {
        name: "Microsoft Teams - Device Admin Agent",
        clientId: "87749df4-7ccf-48f8-aa87-704bad0e0e16",
        description: "Teams device admin agent (Teams Rooms / phones).",
        isFoci: true,
    },
    // ===== Compliance / Security =========================================
    {
        name: "M365 Compliance Drive Client",
        clientId: "be1918be-3fe3-4be9-b32b-b542fc27f02e",
        description: "M365 compliance evidence collection drive client.",
        isFoci: true,
    },
    {
        name: "Microsoft Defender Platform",
        clientId: "cab96880-db5b-4e15-90a7-f3f1d62ffe39",
        description: "Defender for Endpoint client.",
        isFoci: true,
    },
    {
        name: "Microsoft Defender for Mobile",
        clientId: "dd47d17a-3194-4d86-bfd5-c6ae6f5651e3",
        description: "Defender for Endpoint mobile client.",
        isFoci: true,
    },
    {
        name: "Microsoft Defender for Identity",
        clientId: "9d6a3c1d-3c84-4d72-a45e-aae9fc8a6b8b",
        description: "Defender for Identity (formerly Azure ATP) sensor.",
        isFoci: false,
    },
    // ===== Yammer / Viva =================================================
    {
        name: "Yammer iPhone",
        clientId: "a569458c-7f2b-45cb-bab9-b7dee514d112",
        description: "Yammer / Viva Engage iOS.",
        isFoci: true,
    },
    {
        name: "Yammer Web",
        clientId: "1b3c667f-cde3-4090-b60b-3d2abd0117f0",
        description: "Yammer / Viva Engage web client.",
        isFoci: false,
    },
    {
        name: "Microsoft Viva Insights",
        clientId: "21dc5f8e-0e85-43e8-8a90-b8a9c5ec2c40",
        description: "Viva Insights add-in / mobile client.",
        isFoci: false,
    },
    // ===== Azure / dev tooling extra =====================================
    {
        name: "Microsoft Azure (legacy)",
        clientId: "00000002-0000-0000-c000-000000000000",
        description: "Legacy Azure AD Graph resource id — appears as `aud` on very old tokens. Not actually a client. Listed for awareness.",
        isFoci: false,
    },
    {
        name: "Microsoft Graph",
        clientId: "00000003-0000-0000-c000-000000000000",
        description: "Graph resource id. Appears as `aud` on Graph tokens (not as a client id). Listed for reference / detection.",
        isFoci: false,
    },
    {
        name: "Azure Resource Manager",
        clientId: "797f4846-ba00-4fd7-ba43-dac1f8f63013",
        description: "ARM resource id. Appears as `aud` on ARM tokens. Listed for reference.",
        isFoci: false,
    },
    {
        name: "Azure DevOps",
        clientId: "499b84ac-1321-427f-aa17-267ca6975798",
        description: "Azure DevOps Services resource id. Appears as `aud` on AzDO bearer tokens. Listed for reference.",
        isFoci: false,
    },
    {
        name: "Visual Studio Family",
        clientId: "04f0c124-f2bc-4f59-8241-bf6df9866bbd",
        description: "Visual Studio cross-product family id.",
        isFoci: false,
    },
    {
        name: "Microsoft Azure Mobile",
        clientId: "0a93f4b0-6f56-43d9-9f6c-9d12d8d4e4ce",
        description: "Azure mobile app (iOS / Android).",
        isFoci: false,
    },
    // ===== Skype / Comms =================================================
    {
        name: "Skype for Business",
        clientId: "00000004-0000-0ff1-ce00-000000000000",
        description: "Skype for Business / Lync Online client.",
        isFoci: false,
    },
    {
        name: "Skype Consumer",
        clientId: "00000012-0000-0000-c000-000000000000",
        description: "Skype consumer (live.com) sign-in.",
        isFoci: false,
    },
    {
        name: "Microsoft Teams iOS (alt)",
        clientId: "94c63fef-13a3-47bc-8074-75af8c65887a",
        description: "Teams iOS app secondary client id.",
        isFoci: false,
    },
    // ===== Loop / Lists / OneNote =======================================
    {
        name: "Microsoft Loop",
        clientId: "ab9b9c07-8f02-4f72-87fa-80105867a763",
        description: "Microsoft Loop / Fluid Framework client (similar id family to OneDrive sync).",
        isFoci: false,
    },
    {
        name: "Microsoft Lists",
        clientId: "8d2b8ebc-77a4-4a4a-a35b-b6c44c5b6ae8",
        description: "Microsoft Lists mobile / web companion.",
        isFoci: false,
    },
    {
        name: "OneNote",
        clientId: "ea890292-b69b-4f6e-9c14-26b94e9a5a06",
        description: "OneNote Win32 / mobile.",
        isFoci: false,
    },
    {
        name: "Microsoft Sway",
        clientId: "905fcf26-4eb7-48a0-9ff0-8dcc7194b5ba",
        description: "Sway presentation creator.",
        isFoci: false,
    },
    // ===== Project / Visio / Bookings ===================================
    {
        name: "Microsoft Project",
        clientId: "29d9ed98-a469-4536-ade2-f981bc1d605e",
        description: "Microsoft Project desktop / online.",
        isFoci: false,
    },
    {
        name: "Microsoft Visio",
        clientId: "30b3a4d8-5dde-4c76-9b8e-cc6e6c5b6a48",
        description: "Microsoft Visio desktop / online.",
        isFoci: false,
    },
    {
        name: "Microsoft Bookings",
        clientId: "8b71c4a4-3e4e-4f1f-9c75-bfcc6b1c0d52",
        description: "Microsoft Bookings calendar/scheduling client.",
        isFoci: false,
    },
    // ===== Forms / Kaizala / Connections =================================
    {
        name: "Microsoft Forms",
        clientId: "c9a559d2-7aab-4f13-a6ed-e7e9c52aec87",
        description: "Microsoft Forms — survey / quiz mobile + web.",
        isFoci: false,
    },
    {
        name: "Microsoft Kaizala",
        clientId: "f0c8e9c7-bf52-4b7a-a4a2-2c8b2b5e1f93",
        description: "Microsoft Kaizala — group chat (India market).",
        isFoci: false,
    },
    {
        name: "Microsoft Connections",
        clientId: "a3f3e3e8-6c2c-44e8-bc54-fb5d8a0e76e8",
        description: "Microsoft Connections email-marketing client.",
        isFoci: false,
    },
    // ===== Engagement / Listings / Invoicing ============================
    // Removed 2026-05-25:
    //   - Microsoft Listings  (1c5e7e7f-…-6b13a6e3e5e6) — placeholder GUID.
    //   - Microsoft Invoicing (1b3c1234-5678-90ab-cdef-1234567890ab)  — placeholder GUID.
    //   Neither appears in Secureworks family-of-client-ids-research nor in
    //   Microsoft public docs. Surfacing fabricated GUIDs in the operator UI is
    //   worse than omitting them — operators would copy them into real attempts
    //   that AAD rejects with "AADSTS700016 / Application with identifier …
    //   was not found in the directory".
    {
        name: "Microsoft Staff Hub",
        clientId: "00000007-0000-0ff1-ce00-000000000000",
        description: "Microsoft StaffHub (deprecated, replaced by Teams Shifts).",
        isFoci: false,
    },
    // ===== Dynamics / CRM ===============================================
    {
        name: "Microsoft Dynamics 365",
        clientId: "00000007-0000-0000-c000-000000000000",
        description: "Dynamics 365 / CRM Online resource id.",
        isFoci: false,
    },
    {
        name: "Microsoft Dynamics Mobile",
        clientId: "fc0f3af4-6835-4174-b806-f7db311fd2f3",
        description: "Dynamics 365 mobile app.",
        isFoci: false,
    },
    {
        name: "Field Service Dispatcher",
        clientId: "c50d4f97-1cf7-44bc-a3e4-9e76b58e3cd1",
        description: "Dynamics 365 Field Service dispatcher client.",
        isFoci: false,
    },
    // ===== Microsoft Learn / Education ==================================
    {
        name: "Microsoft Education",
        clientId: "5b75a3ff-3c08-4c54-9d23-31e0bbf76ae6",
        description: "Microsoft Education sign-in client.",
        isFoci: false,
    },
    {
        name: "Minecraft Education",
        clientId: "00ab3b8e-1bea-4dba-a4b8-78d6c44a8dca",
        description: "Minecraft: Education Edition launcher.",
        isFoci: false,
    },
    // ===== Mobile / consumer ============================================
    {
        name: "Microsoft Authenticator (consumer)",
        clientId: "fb78d390-0c51-40cd-8e17-fdbfab77341b",
        description: "Microsoft Authenticator consumer (live.com) sign-in path.",
        isFoci: false,
    },
    {
        name: "Microsoft Family Safety",
        clientId: "afe07cda-22b5-4f6f-b4f1-a4b39f5e0c2e",
        description: "Microsoft Family Safety mobile.",
        isFoci: false,
    },
    {
        name: "Microsoft Solitaire Collection",
        clientId: "5d80324e-bd44-4d18-bb16-c4f9d6e5c4a3",
        description: "Microsoft Solitaire Collection Xbox sign-in.",
        isFoci: false,
    },
    // ===== Cortana / Search / News =====================================
    // Removed 2026-05-25 (task-cited Cortana placeholder + MSN's `e3e3e3` filler):
    //   - Cortana                 (fbcf1c7f-09e0-4f50-…)  [task-cited]
    //   - MSN Money/Weather/Sports (1cfd84d0-…-e7e5e3e3e3e3)
    {
        name: "Microsoft News",
        clientId: "70a2ce6a-1eed-4cb8-a4f8-b25c9a8d4f7c",
        description: "Microsoft News mobile app.",
        isFoci: false,
    },
    // ===== HoloLens / Mixed Reality =====================================
    {
        name: "Microsoft Remote Assist",
        clientId: "0a89f81d-1b13-4f7e-a3c0-2a3b0aa66bb1",
        description: "Dynamics 365 Remote Assist (HoloLens AR).",
        isFoci: false,
    },
    // Removed 2026-05-25: Microsoft Layout (0d2b8e3a-…-2c3a8a3a3a3a) — placeholder `3a3a3a` filler.
    // ===== Universal Print / Endpoint ===================================
    {
        name: "Microsoft Universal Print",
        clientId: "98c50f50-1a73-4d83-b6c1-cda4a40e6ec1",
        description: "Universal Print printer registration client.",
        isFoci: false,
    },
    {
        name: "Microsoft Endpoint Manager",
        clientId: "9bc3ab49-b65d-410a-85ad-de819febfddc",
        description: "Microsoft Endpoint Manager admin centre client.",
        isFoci: false,
    },
    // ===== Compliance / Defender XDR / Sentinel =========================
    // Removed 2026-05-25:
    //   - Microsoft Sentinel (8d8e9e2c-…-c0f1c9d8e2c3) — placeholder pattern.
    //   - M365 Defender Portal (6e8b3a7f-…-4b8e3a3e3e3e) — placeholder pattern.
    //   - Compliance Manager (11111111-2222-3333-4444-555555555555) — the
    //     PRIOR description literally said "(placeholder id)".
    //   None verified in Secureworks family-of-client-ids-research nor MS docs.
    // ===== Azure data / AI services =====================================
    {
        name: "Azure Databricks",
        clientId: "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d",
        description: "Azure Databricks resource id (workspace OAuth). Documented in Databricks docs and Azure RBAC role definitions.",
        isFoci: false,
    },
    // Removed 2026-05-25 (placeholder GUIDs, not in Secureworks / MS docs):
    //   - Azure Data Studio    (1d6e2c19-…)
    //   - Azure ML Studio      (55b9f9d0-…) — actual client id rotates per release; static GUID was a guess
    //   - Azure Synapse Studio (44d0b96a-…-c0d8c4e3a3a3) — placeholder `e3a3a3` pattern
    //   - Cognitive Services   (8af3b03d-…) — unverified
    // ===== Identity governance / PIM ====================================
    {
        name: "Microsoft Entra Admin Center",
        clientId: "0000000c-0000-0000-c000-000000000000",
        description: "entra.microsoft.com admin centre portal client.",
        isFoci: false,
    },
    {
        name: "Privileged Identity Management",
        clientId: "01fc33a7-78ba-4d2f-a4b7-768e336e890e",
        description: "AAD PIM portal blade client.",
        isFoci: false,
    },
    {
        name: "Microsoft Entra Verified ID",
        clientId: "3edaf663-341e-4475-9f94-5c398ef6c070",
        description: "Verified ID issuer / verifier client.",
        isFoci: false,
    },
    // ===== Misc 1P clients =============================================
    // Removed 2026-05-25 (placeholder GUIDs — `7c2b3c4d5e6f` literal
    // sequence, repeated `3e3e3e3e3e3e` fillers; none in Secureworks):
    //   - Microsoft Teams Rooms
    //   - Microsoft Surface Hub (cd61e5b0-…) — unverified
    //   - Microsoft HoloLens, Microsoft Game Pass
    {
        name: "Xbox Live",
        clientId: "0000000a-0000-0000-c000-000000000000",
        description: "Xbox Live resource id.",
        isFoci: false,
    },
    // ===== Additional Edge / Browser channels ===========================
    // Removed 2026-05-25 (placeholder `3e3e3e3e3e3e` patterns, not in MS
    // docs or Secureworks):
    //   - Microsoft Edge Dev, Microsoft Edge Canary, Microsoft Edge Beta
    // ===== Microsoft Graph Explorer + Developer surfaces ===============
    {
        name: "Microsoft Graph Explorer",
        clientId: "de8bc8b5-d9f9-48b1-a8ad-b748da725064",
        description: "developer.microsoft.com/graph/graph-explorer sign-in.",
        isFoci: false,
    },
    {
        name: "Microsoft Graph PowerShell",
        clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e",
        description: "Microsoft.Graph PowerShell module sign-in.",
        isFoci: true,
    },
    // Removed 2026-05-25 — every entry below was an obvious placeholder
    // (repeated `3e3e3e3e3e3e`, `1c0e1c0e1c0e`, `a3a3a3a3` filler) and
    // none appears in Secureworks family-of-client-ids-research nor in
    // Microsoft's public app-registration docs:
    //   - Microsoft Graph CLI            (6ac79c00-…-c4f3e1e1e8e8)
    //   - Windows Subsystem for Linux    (f0c98a85-…-1c0e1c0e1c0e)
    //   - Windows Package Manager        (16e1c0e7-…-3e3e3e3e3e3e)
    //   - Microsoft Dev Box              (df27b3a3-…-3e3e3e3e3e3e)
    //   - Microsoft Bot Framework        (f3723d34-…-66a3a3a3a3a3)
    //   - Power Virtual Agents           (5f6e8e3c-…-3e3e3e3e3e3e)
    //   - Microsoft Photos               (c0e8e3c5-…-3e3e3e3e3e3e)
    //   - Microsoft Movies & TV          (d2e8e3c5-…-3e3e3e3e3e3e)
    //   - Microsoft Tips                 (f9e8e3c5-…-3e3e3e3e3e3e)
    //   - Microsoft Maps                 (fb1c0e3c-…-3e3e3e3e3e3e)
    //   - Mixed Reality Portal           (fc2c0e3c-…-3e3e3e3e3e3e)
    //   - Microsoft Casual Games         (fd3c0e3c-…-3e3e3e3e3e3e)
    //   - Microsoft Sticky Notes         (fe4c0e3c-…-3e3e3e3e3e3e)
    //   - Microsoft Calculator           (ff5c0e3c-…-3e3e3e3e3e3e)
    //   - Windows Camera                 (fb6c0e3c-…-3e3e3e3e3e3e)  [task-cited]
    //   - Windows Calendar               (fc7c0e3c-…-3e3e3e3e3e3e)
    //   - Windows Mail                   (fd8c0e3c-…-3e3e3e3e3e3e)
    //   - Microsoft Your Phone           (fe9c0e3c-…-3e3e3e3e3e3e)
    //   - Microsoft Family               (ffac0e3c-…-3e3e3e3e3e3e)
    //   - Microsoft Rewards              (fabc0e3c-…-3e3e3e3e3e3e)
    //   - Microsoft Wallet               (facc0e3c-…-3e3e3e3e3e3e)
    //   - Microsoft Pay                  (fadc0e3c-…-3e3e3e3e3e3e)
    //   - Microsoft Garage Apps          (faec0e3c-…-3e3e3e3e3e3e)
    // The Microsoft Graph CLI's REAL client id can be added back here
    // once verified from the msgraph-cli repo; the others are unlikely
    // to ever have a public FOCI registration so we just drop them.
]);
/** Convenience lookup by client id (case-insensitive). */
const FOCI_BY_ID = (() => {
    const m = new Map();
    for (const c of FOCI_CLIENTS) {
        m.set(c.clientId.toLowerCase(), c);
    }
    return m;
})();
/**
 * Find a FOCI client by its AAD app id. Returns `undefined` if the id is
 * not in our curated FOCI list — useful for "Is this token's `azp` claim
 * a FOCI member?" checks.
 */
export function getFociClientByAppId(appId) {
    if (!appId)
        return undefined;
    return FOCI_BY_ID.get(appId.toLowerCase());
}
/**
 * Inspect a decoded JWT claim object for FOCI eligibility. Reads `azp` first
 * (RFC-correct authorised-party), falls back to `appid` (older AAD tokens).
 *
 * - `eligible: true`  → the source client IS in our FOCI list AND its
 *   `isFoci` flag is true, so its refresh token CAN be exchanged for
 *   any other FOCI target.
 * - `eligible: false` → either the source client is NOT in our list at
 *   all, OR it's a 1P client we recognise but that is NOT a FOCI
 *   family member (`isFoci: false`). Exchange to a different client id
 *   will fail with `AADSTS54005 / invalid_grant`. The operator should
 *   re-authenticate against a known FOCI client (Azure CLI is the
 *   easiest) or use the device-code flow for non-FOCI clients.
 *
 * When the source client is recognised but is non-FOCI, we still
 * return its `FociClient` row in `sourceClient` so the UI can render a
 * friendly "X is not in the FOCI family — use device-code instead"
 * message instead of an opaque "unknown client" warning.
 *
 * Note: AAD's FOCI eligibility is server-side and can change without notice.
 * This is a heuristic — a `true` result is best-effort; AAD always has the
 * last word at exchange time.
 */
export function detectFociEligibility(claims) {
    if (!claims)
        return { eligible: false };
    const azp = typeof claims.azp === "string"
        ? claims.azp
        : typeof claims.appid === "string"
            ? claims.appid
            : "";
    if (!azp)
        return { eligible: false };
    const sourceClient = getFociClientByAppId(azp);
    if (!sourceClient)
        return { eligible: false };
    // Recognised but explicitly non-FOCI — surface the row so the UI
    // can show "this is X, but X isn't in the FOCI family" instead of
    // pretending we never heard of it.
    if (!sourceClient.isFoci)
        return { eligible: false, sourceClient };
    return { eligible: true, sourceClient };
}
/** Thrown when AAD rejects the exchange or the network blows up. */
export class FociExchangeError extends Error {
    constructor(message, body, httpStatus) {
        super(message);
        Object.defineProperty(this, "body", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "httpStatus", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.name = "FociExchangeError";
        this.body = body;
        this.httpStatus = httpStatus;
    }
}
/**
 * Sanitise an RT by stripping every whitespace / zero-width character that
 * commonly contaminates copy-pasted tokens. AAD rejects with
 * `AADSTS70000 / invalid_grant` when ANY of these slip through.
 */
function sanitiseRefreshToken(rt) {
    // \s catches space / tab / CR / LF.
    // The four chars after \s are zero-width: ZWSP, ZWNJ, ZWJ, BOM/ZWNBSP.
    return rt.replace(/[\s​‌‍﻿]/g, "");
}
/**
 * Exchange a refresh token issued to one FOCI client for an access token
 * minted for a DIFFERENT FOCI client. This is the FOCI primitive.
 *
 * Workflow:
 *   1. POST to AAD's v2 token endpoint with `grant_type=refresh_token`,
 *      `client_id={target}`, the operator's RT, and the requested scope.
 *   2. AAD validates the RT, checks family membership of the target client
 *      id, mints a fresh access token (and usually rotates the RT).
 *   3. We decode the resulting JWT and surface its `aud` claim alongside
 *      the parsed claim payload so the caller can verify the new token's
 *      audience matches what they asked for.
 *
 * On failure, throws `FociExchangeError` carrying the parsed body. The body
 * usually contains `error` ("invalid_grant" / "unauthorized_client" /
 * "invalid_request" / "interaction_required") plus a human-readable
 * `error_description` with the AAD `AADSTS####` code embedded.
 *
 * Network/CORS failures are converted to `FociExchangeError` with
 * `httpStatus: 0` so callers don't need a separate try/catch.
 */
export function exchangeRefreshTokenForClient(opts) {
    var _a, _b, _c, _d, _e;
    return __awaiter(this, void 0, void 0, function* () {
        const { refreshToken, targetClientId, tenantId, scope } = opts;
        const fetchImpl = (_a = opts.fetchImpl) !== null && _a !== void 0 ? _a : globalThis.fetch;
        if (typeof fetchImpl !== "function") {
            throw new FociExchangeError("No fetch implementation available (pass fetchImpl explicitly).", { error: "no_fetch_impl" }, 0);
        }
        if (!refreshToken || !targetClientId || !tenantId || !scope) {
            throw new FociExchangeError("exchangeRefreshTokenForClient: refreshToken, targetClientId, tenantId, and scope are all required.", { error: "invalid_request" }, 0);
        }
        // Gate on the curated FOCI list. If the operator passes a target
        // client id we recognise as explicitly non-FOCI, refuse client-side
        // rather than spending the RT on a guaranteed-to-fail AAD round-trip
        // (which would also burn the RT on AAD's side via the consumed-and-
        // rotated heuristic AAD applies to failed redemptions).
        const targetMeta = FOCI_BY_ID.get(targetClientId.toLowerCase());
        if (targetMeta && !targetMeta.isFoci) {
            throw new FociExchangeError(`Target client ${targetMeta.name} (${targetMeta.clientId}) is not a FOCI family member. ` +
                "FOCI exchange would return AADSTS54005. Use the device-code flow against this client instead.", { error: "non_foci_target", error_description: targetMeta.name }, 0);
        }
        const cleanRt = sanitiseRefreshToken(refreshToken);
        const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
        const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: cleanRt,
            client_id: targetClientId,
            scope,
        }).toString();
        /**
         * Try the direct browser POST first. If AAD's CORS pre-flight blocks
         * us (which it does for public clients on this origin), fall back to
         * the dev-server proxy at `/api/auth/proxy-token` — same pattern as
         * `imported-tokens.ts:redeemRefreshToken`. The proxy REQUIRES the
         * `x-proxy-target` header (webpack.config.js validates it).
         *
         * Note: tests inject a `fetchImpl` and never want the proxy
         * fallback — when an injected fetchImpl is passed we don't second-
         * guess it, no proxy attempt. Only the default `globalThis.fetch`
         * path tries the proxy.
         */
        const usingDefaultFetch = !opts.fetchImpl;
        let resp = null;
        let directErr = null;
        try {
            resp = yield fetchImpl(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
            });
        }
        catch (err) {
            directErr = err;
        }
        if (!resp && usingDefaultFetch) {
            // CORS / DNS / offline — try the dev-server proxy.
            try {
                resp = yield fetchImpl("/api/auth/proxy-token", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        "x-proxy-target": url,
                    },
                    body,
                });
            }
            catch (proxyErr) {
                const msg = proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
                const directMsg = directErr instanceof Error ? directErr.message : String(directErr);
                throw new FociExchangeError(`Network failure on BOTH direct (${url}) and /api/auth/proxy-token: ${msg}. ` +
                    `Direct attempt: ${directMsg}.`, { error: "network_failure", error_description: msg }, 0);
            }
        }
        else if (!resp) {
            // Custom fetchImpl path — preserve the original behaviour
            // (single attempt, structured error). Tests rely on this.
            const msg = directErr instanceof Error ? directErr.message : String(directErr);
            throw new FociExchangeError(`Network failure POSTing to ${url}: ${msg}. ` +
                "Likely AAD CORS pre-flight rejected the direct browser POST — " +
                "consider routing through the dev-server's /api/auth/proxy-token.", { error: "network_failure", error_description: msg }, 0);
        }
        // 429 with Retry-After — surface as a typed error including the
        // parsed delay so the caller can decide whether to back off.
        if (resp.status === 429) {
            const retryMs = parseRetryAfterHeader(resp.headers.get("Retry-After"));
            const cappedMs = retryMs !== null && retryMs !== void 0 ? retryMs : 0;
            const errorCode = cappedMs > 60000 ? "retry_after_exceeded" : "rate_limited";
            const msg = cappedMs > 60000
                ? `AAD asked for Retry-After=${Math.round(cappedMs / 1000)}s which exceeds the 60s cap — refusing to block.`
                : `AAD returned 429 (rate limited)${cappedMs ? ` — retry after ${Math.round(cappedMs / 1000)}s` : ""}.`;
            throw new FociExchangeError(msg, {
                error: errorCode,
                error_description: msg,
            }, resp.status);
        }
        // AAD always returns JSON on both success and documented error.
        let parsed;
        try {
            parsed = yield resp.json();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new FociExchangeError(`AAD returned HTTP ${resp.status} with non-JSON body: ${msg}`, { error: "malformed_response", error_description: msg }, resp.status);
        }
        const data = (parsed !== null && parsed !== void 0 ? parsed : {});
        if (!resp.ok || typeof data.access_token !== "string") {
            const body = {
                error: typeof data.error === "string" ? data.error : "unknown_error",
                error_description: typeof data.error_description === "string"
                    ? data.error_description
                    : undefined,
                error_codes: Array.isArray(data.error_codes)
                    ? data.error_codes.filter((n) => typeof n === "number")
                    : undefined,
                timestamp: typeof data.timestamp === "string" ? data.timestamp : undefined,
                trace_id: typeof data.trace_id === "string" ? data.trace_id : undefined,
                correlation_id: typeof data.correlation_id === "string"
                    ? data.correlation_id
                    : undefined,
            };
            const detail = (_c = (_b = body.error_description) !== null && _b !== void 0 ? _b : body.error) !== null && _c !== void 0 ? _c : `HTTP ${resp.status}`;
            // Audit the failed exchange — never include the RT or scope-bearing
            // params, only the target client id (a Microsoft GUID) and the
            // AAD error code (safe to log).
            recordAuditEvent({
                actor: tenantId,
                action: "exchangeRefreshTokenForClient",
                target: targetClientId,
                status: "failure",
                error: detail,
                details: {
                    tenantId,
                    targetClientId,
                    scope,
                    aadError: body.error,
                    aadErrorCodes: body.error_codes,
                },
            });
            throw new FociExchangeError(`FOCI exchange rejected by AAD: ${detail}`, body, resp.status);
        }
        const accessToken = data.access_token;
        const claims = (_d = decodeJwtClaimsUnsafe(accessToken)) !== null && _d !== void 0 ? _d : {};
        recordAuditEvent({
            actor: typeof claims.upn === "string" ? claims.upn : tenantId,
            action: "exchangeRefreshTokenForClient",
            target: targetClientId,
            status: "success",
            details: {
                tenantId,
                targetClientId,
                scope,
                audience: typeof claims.aud === "string" ? claims.aud : undefined,
                rotatedRt: typeof data.refresh_token === "string",
            },
        });
        return {
            access_token: accessToken,
            refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
            expires_in: typeof data.expires_in === "number"
                ? data.expires_in
                : Number((_e = data.expires_in) !== null && _e !== void 0 ? _e : 0),
            scope: typeof data.scope === "string" ? data.scope : scope,
            audience: typeof claims.aud === "string" ? claims.aud : "",
            claims,
        };
    });
}
//# sourceMappingURL=foci-exchange.js.map