import { getEnvironment } from "../environment";
import { LocalizedStrings } from "./localized-strings";
import { Localizer } from "./localizer";

// Accept any string here. The narrow `Extract<keyof LocalizedStrings, string>`
// type evaluated to `never` in this build environment because LocalizedStrings
// is intentionally augmented from multiple workspace packages — narrowing made
// every translate(...) call unbuildable. Keeping the signature wide preserves
// runtime behavior; the auto-generated resources file still drives type
// completeness for callers who use `keyof LocalizedStrings` directly.
export function translate(message: string): string {
    return getLocalizer().translate(message as keyof LocalizedStrings);
}

export function getLocalizer(): Localizer {
    return getEnvironment().getLocalizer();
}
