/**
 * User Creator page — provisions Microsoft Entra ID (Azure AD) users in a
 * tenant where the signed-in account holds a User Administrator role.
 * Includes real-time UPN availability probing, AD attribute presets, and
 * zod-backed inline validation. Does NOT manage subscription role
 * assignments — that lives in the Account Provisioning page.
 */
import * as React from "react";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { type PageKey } from "../shared/sidebar-nav";
export interface QuickUserPayload {
    prefix: string;
    upn: string;
    displayName: string;
    givenName: string;
    surname: string;
    password: string;
    jobTitle: string;
    department: string;
    usageLocation: string;
    forceChange: boolean;
    accountEnabled: boolean;
}
export interface UserCreatorPageProps {
    orchestrator?: OrchestratorAgent;
    onNavigate?: (k: PageKey) => void;
}
export declare const UserCreatorPage: React.FC<UserCreatorPageProps>;
//# sourceMappingURL=user-creator-page.d.ts.map