export interface LiveCatalogAvailability {
    available: boolean;
    count: number;
    scope: "gpu" | "all" | "none";
}
export declare function useLiveCatalogAvailable(subscriptionId: string | undefined): LiveCatalogAvailability;
//# sourceMappingURL=use-live-catalog-available.d.ts.map