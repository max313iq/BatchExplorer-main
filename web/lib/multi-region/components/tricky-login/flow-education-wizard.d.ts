/**
 * Flow-education wizard — "Why are you using this flow?" dialog.
 *
 * Pure educational surface. Triggered from the method-picker card; opens
 * a dialog showing one entry per flow with:
 *   - What it does (operator-facing)
 *   - When to use it
 *   - Defensive vs offensive framing
 *   - Wire-shape headline (mitmproxy-eye-view)
 *   - Corpus playbook + source reference
 *
 * NO side effects beyond a local "current entry" selector. NO mint. NO
 * token material exposed (the wizard is metadata-only by construction —
 * the FLOW_EDUCATION data lives in corpus-advisories.ts and is static).
 */
import * as React from "react";
import { X } from "lucide-react";
import type { TrickyLoginMethod } from "./tricky-login-helpers";
export interface FlowEducationWizardProps {
    /** Whether the dialog is open. */
    open: boolean;
    /** Open/close callback (mirrors Radix Dialog onOpenChange). */
    onOpenChange: (next: boolean) => void;
    /**
     * Optional initial method to land on. If absent, lands on Auto.
     * Operators usually open the wizard pointed at the currently-selected
     * method, so we default to whatever the page passes in.
     */
    initialMethod?: TrickyLoginMethod;
}
/**
 * Tabbed wizard dialog. Each tab is one of the three flows; the body
 * renders the entry's static fields and the corpus citation. Keyboard:
 * Esc closes (Radix default), Left/Right arrows step entries.
 */
export declare const FlowEducationWizard: React.FC<FlowEducationWizardProps>;
export { X as WizardCloseIcon };
//# sourceMappingURL=flow-education-wizard.d.ts.map