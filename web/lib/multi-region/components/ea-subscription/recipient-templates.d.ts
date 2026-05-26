/**
 * RecipientTemplates — persisted, named snapshots of a recipient list
 * so the operator can re-load a common batch (e.g. "Customer A monthly
 * provisioning") without re-clicking the picker.
 *
 * The persisted form stores only `(tenantId, ownerObjectId)` pairs — no
 * display labels — because tenant users may be deactivated/renamed
 * between visits. Hydration relies on the existing recipientCatalog
 * lookup the parent already does.
 *
 * Persistence is per-key via `usePersistedState` so the page can
 * recover from a refresh. Cross-tab sync is intentionally OFF to avoid
 * surprising the operator mid-batch.
 */
import * as React from "react";
export interface RecipientTemplatePair {
    tenantId: string;
    ownerObjectId: string;
}
export interface RecipientTemplate {
    /** Stable id; UUID-ish base36 token generated on save. */
    id: string;
    name: string;
    pairs: RecipientTemplatePair[];
    createdAt: number;
    updatedAt: number;
}
interface RecipientTemplatesProps {
    /** Current recipient list — used as the "Save current" snapshot. */
    currentPairs: RecipientTemplatePair[];
    /** Called when the operator loads a template; the parent merges. */
    onLoad: (pairs: RecipientTemplatePair[], templateName: string) => void;
    /** Disabled (e.g. during submit). */
    disabled?: boolean;
}
export declare const RecipientTemplates: React.FC<RecipientTemplatesProps>;
export {};
//# sourceMappingURL=recipient-templates.d.ts.map