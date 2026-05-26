/**
 * Universal Audience Matrix page.
 *
 * What the operator sees
 * ----------------------
 * A grid where every imported refresh-token AND every signed-in MSAL account
 * occupies a row, and every well-known Azure resource audience (ARM, Graph,
 * Batch, Vault, Storage, Intune, Substrate, Monitor, Power BI, Yammer,
 * DevOps, Custom) occupies a column. Cells are:
 *
 *   `–`          not tried yet
 *   spinner      mint in flight (re-click to cancel)
 *   `✓ 58m`      mint succeeded; click to view claims / re-mint / vault-it
 *   `✕ AADSTS…`  mint rejected by AAD; hover for full error text
 *
 * Why
 * ---
 * Operators routinely need to confirm WHICH Azure surfaces an identity (or
 * a leaked RT they want to triage) can actually reach. Doing this manually
 * means clicking through Token Importer's FOCI panel once per audience per
 * principal — slow, error-prone, and produces 12 audit-log entries per
 * principal that are hard to correlate. The matrix collapses that workflow
 * into one click per cell (or one "Mint EVERYTHING" click) and keeps the
 * audit trail intact — every cell mint still emits `audience_matrix_mint`.
 *
 * Wiring constraints (per build spec)
 * -----------------------------------
 * - This page must NOT edit services / auth / store / page-router / sidebar
 *   / shared components / other pages. Recommendation for the orchestrator:
 *   register `"audience-matrix"` as PageKey and place a sidebar entry under
 *   Identity using the `LayoutGrid` icon (Wand2 and Grid3x3 are taken).
 * - All file additions live under
 *   `web/src/multi-region/components/audience-matrix/`.
 * - No new npm deps — concurrency, debounce, and date math are inline.
 *
 * Hardening notes
 * ---------------
 * - Token material NEVER touches the audit log. Every audit details object
 *   carries scope / audience / durationMs / row identifiers only — no
 *   `accessToken`, no `refresh_token`.
 * - Per-cell AbortController + generation token mean stale mints can't
 *   overwrite newer state when the operator re-clicks rapidly or unmounts
 *   the page mid-batch.
 * - Concurrency is capped at 5 in flight via `runWithConcurrency` from
 *   the helpers — keeps AAD throttling friendly and the UI responsive.
 * - "Include token material" in the JSON export defaults OFF, gated behind
 *   a checkbox the operator must consciously tick.
 */
import * as React from "react";
export declare const AudienceMatrixPage: React.FC;
//# sourceMappingURL=audience-matrix-page.d.ts.map