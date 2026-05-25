/**
 * Eagerly imports every page-enhancer trio so the /agents dashboard can list
 * them without each page having to be mounted first.
 */
import { GENERIC_TRIOS } from "./generic-trios";
import type { PageEnhancerTrio } from "./types";
import { userCreatorTrio } from "./user-creator";
import type { PageKey } from "../../components/shared/sidebar-nav";

/**
 * Hand-authored trios take precedence; generic ones fill the rest.
 */
const HANDCRAFTED: readonly PageEnhancerTrio[] = [userCreatorTrio];

const handcraftedKeys = new Set<PageKey>(HANDCRAFTED.map((t) => t.pageKey));

export const ALL_TRIOS: readonly PageEnhancerTrio[] = [
  ...HANDCRAFTED,
  ...GENERIC_TRIOS.filter((t) => !handcraftedKeys.has(t.pageKey)),
];

export const TRIO_BY_PAGE: Record<PageKey, PageEnhancerTrio> = ALL_TRIOS.reduce(
  (acc, trio) => {
    acc[trio.pageKey] = trio;
    return acc;
  },
  {} as Record<PageKey, PageEnhancerTrio>,
);
