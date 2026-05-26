/**
 * Eagerly imports every page-enhancer trio so the /agents dashboard can list
 * them without each page having to be mounted first.
 */
import { GENERIC_TRIOS } from "./generic-trios";
import { userCreatorTrio } from "./user-creator";
/**
 * Hand-authored trios take precedence; generic ones fill the rest.
 */
const HANDCRAFTED = [userCreatorTrio];
const handcraftedKeys = new Set(HANDCRAFTED.map((t) => t.pageKey));
export const ALL_TRIOS = [
    ...HANDCRAFTED,
    ...GENERIC_TRIOS.filter((t) => !handcraftedKeys.has(t.pageKey)),
];
export const TRIO_BY_PAGE = ALL_TRIOS.reduce((acc, trio) => {
    acc[trio.pageKey] = trio;
    return acc;
}, {});
//# sourceMappingURL=trios.js.map