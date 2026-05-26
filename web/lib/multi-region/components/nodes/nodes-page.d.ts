/**
 * Nodes page — multi-region compute-node browser with bulk reboot/reimage/
 * delete/recreate, faceted filters synced to the URL, and DataTable rendering.
 *
 * Security / pivot-risk context (operator awareness, not enforcement here):
 *   Every running compute node holds a managed-identity (MSI) token reachable
 *   via the local IMDS endpoint (`http://169.254.169.254/metadata/identity/
 *   oauth2/token?api-version=2018-02-01&resource=…` for VM-backed pools).
 *   Anything that achieves arbitrary code execution INSIDE a node — a
 *   poisoned start-task script, a job that runs untrusted user code, an
 *   image pulled from a compromised registry — can mint an ARM/Graph token
 *   for whatever scope the pool's identity holds and pivot from there. See
 *   `C:\Users\baimgprodsesa1\Desktop\New folder\_analysis_netspi.md` §I
 *   (per-service IMDS variant matrix) and §II (post-token enumeration)
 *   plus `_AZURE_BYPASS_PLAYBOOK.md` Top-30 #7 (IMDS theft). The two
 *   defender hooks surfaced here:
 *     1. Forensic-export button — captures stuck + error-state node state
 *        BEFORE the operator reimages/deletes and erases service-side
 *        evidence. starttaskfailed nodes in particular are the common
 *        "init script crashed mid-payload" footprint.
 *     2. Connect dialog — uses a STABLE temp-user name + 24h auto-
 *        expiring credential rather than per-click usernames that
 *        accumulate up to the ~20-user cap. The audit-log entry on
 *        every Connect captures who minted credentials for which node.
 */
import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
export interface NodesPageProps {
    orchestrator: OrchestratorAgent;
}
export declare const NodesPage: React.FC<NodesPageProps>;
//# sourceMappingURL=nodes-page.d.ts.map