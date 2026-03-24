import { Injectable, OnDestroy } from "@angular/core";
import { BehaviorSubject, Observable, Subject } from "rxjs";
import { filter, take, takeUntil } from "rxjs/operators";

import { AuthService } from "app/services/aad";
import { SubscriptionService } from "app/services/subscription";

import {
    MultiRegionStore,
    OrchestratorAgent,
    RequestScheduler,
} from "multi-region";
import type { AgentContext, AgentResult } from "multi-region";
import type {
    ManagedAccount,
    PoolInfo,
    AccountInfo,
    ManagedNode,
    Activity,
    AgentLogEntry,
    MultiRegionState,
    Subscription,
} from "multi-region";

const ARM_URL = "https://management.azure.com";

@Injectable({ providedIn: "root" })
export class MultiRegionService implements OnDestroy {
    // --- Public Observables (store projections) ---

    public readonly accounts$: Observable<ManagedAccount[]>;
    public readonly poolInfos$: Observable<PoolInfo[]>;
    public readonly accountInfos$: Observable<AccountInfo[]>;
    public readonly nodes$: Observable<ManagedNode[]>;
    public readonly activities$: Observable<Activity[]>;
    public readonly agentLogs$: Observable<AgentLogEntry[]>;

    // --- Internals ---

    private readonly _store: MultiRegionStore;
    private readonly _destroy = new Subject<void>();
    private _orchestrator: OrchestratorAgent | null = null;
    private _unsubscribeStore: (() => void) | null = null;
    private _tenantId: string | null = null;

    private readonly _accounts$ = new BehaviorSubject<ManagedAccount[]>([]);
    private readonly _poolInfos$ = new BehaviorSubject<PoolInfo[]>([]);
    private readonly _accountInfos$ = new BehaviorSubject<AccountInfo[]>([]);
    private readonly _nodes$ = new BehaviorSubject<ManagedNode[]>([]);
    private readonly _activities$ = new BehaviorSubject<Activity[]>([]);
    private readonly _agentLogs$ = new BehaviorSubject<AgentLogEntry[]>([]);

    constructor(
        private authService: AuthService,
        private subscriptionService: SubscriptionService
    ) {
        this.accounts$ = this._accounts$.asObservable();
        this.poolInfos$ = this._poolInfos$.asObservable();
        this.accountInfos$ = this._accountInfos$.asObservable();
        this.nodes$ = this._nodes$.asObservable();
        this.activities$ = this._activities$.asObservable();
        this.agentLogs$ = this._agentLogs$.asObservable();

        // Create the store
        this._store = new MultiRegionStore();

        // Push store changes into BehaviorSubjects
        this._unsubscribeStore = this._store.onChange(() => {
            this._syncFromStore(this._store.getState());
        });

        // Resolve tenantId and bootstrap on init
        this._initialize();
    }

    public ngOnDestroy(): void {
        this._destroy.next();
        this._destroy.complete();
        if (this._orchestrator) {
            this._orchestrator.cancel();
            this._orchestrator = null;
        }
        if (this._unsubscribeStore) {
            this._unsubscribeStore();
            this._unsubscribeStore = null;
        }
    }

    /** Returns the underlying store for advanced usage. */
    public get store(): MultiRegionStore {
        return this._store;
    }

    // ---------------------------------------------------------------
    // Public actions — delegates to OrchestratorAgent.execute()
    // ---------------------------------------------------------------

    public async discoverAccounts(): Promise<AgentResult> {
        return this._dispatch("discover_accounts", {});
    }

    public async refreshPoolInfo(): Promise<AgentResult> {
        return this._dispatch("refresh_pool_info", {});
    }

    public async refreshAccountInfo(): Promise<AgentResult> {
        return this._dispatch("refresh_account_info", {});
    }

    public async refreshNodes(): Promise<AgentResult> {
        return this._dispatch("list_nodes", {});
    }

    public async resizePool(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        return this._dispatch("resize_pool", payload);
    }

    public async updateStartTask(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        return this._dispatch("update_start_task", payload);
    }

    public async deleteNodes(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        return this._dispatch("delete_nodes", payload);
    }

    public async recoverPreempted(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        return this._dispatch("recover_preempted", payload);
    }

    public async createPoolsSmart(
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        return this._dispatch("create_pools_smart", payload);
    }

    public async detectUnusedQuota(): Promise<AgentResult> {
        return this._dispatch("detect_unused_quota", {});
    }

    // ---------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------

    private async _initialize(): Promise<void> {
        try {
            // Wait for the current user to resolve so we can read tenantId
            const user = await this.authService.currentUser
                .pipe(
                    filter((u) => u != null && u.tid != null),
                    take(1),
                    takeUntil(this._destroy)
                )
                .toPromise();

            this._tenantId = user?.tid ?? null;

            // Build the orchestrator now that we have tenantId
            this._orchestrator = this._createOrchestrator();

            // Load subscriptions into the store
            await this._loadSubscriptions();
        } catch {
            // Service may be destroyed before initialization completes
        }
    }

    private _createOrchestrator(): OrchestratorAgent {
        const scheduler = new RequestScheduler({
            concurrency: 1,
            delayMs: 250,
            retryAttempts: 5,
            retryBackoffSeconds: [2, 4, 8, 16, 32],
            jitterPct: 0.2,
        });

        const ctx: AgentContext = {
            store: this._store,
            scheduler,
            armUrl: ARM_URL,
            getAccessToken: () => this._getAccessToken(),
            getBatchAccessToken: () => this._getBatchAccessToken(),
        };

        return new OrchestratorAgent(ctx);
    }

    private async _getAccessToken(): Promise<string> {
        const tenantId = this._tenantId;
        if (!tenantId) {
            throw new Error("MultiRegionService: tenantId not resolved yet.");
        }
        const token = await this.authService.getAccessToken(tenantId, null);
        return token.accessToken;
    }

    private async _getBatchAccessToken(): Promise<string> {
        const tenantId = this._tenantId;
        if (!tenantId) {
            throw new Error("MultiRegionService: tenantId not resolved yet.");
        }
        const token = await this.authService.getAccessToken(tenantId, "batch");
        return token.accessToken;
    }

    private async _loadSubscriptions(): Promise<void> {
        const subs = await this.subscriptionService.subscriptions
            .pipe(
                filter((list) => list != null && list.size > 0),
                take(1),
                takeUntil(this._destroy)
            )
            .toPromise();

        if (!subs) {
            return;
        }

        const mapped: Subscription[] = subs.toArray().map((s) => ({
            subscriptionId: s.subscriptionId,
            displayName: s.displayName,
        }));
        this._store.setSubscriptions(mapped);
    }

    private async _dispatch(
        action: string,
        payload: Record<string, unknown>
    ): Promise<AgentResult> {
        if (!this._orchestrator) {
            throw new Error(
                "MultiRegionService: orchestrator not initialized. " +
                    "Ensure the current user is authenticated before calling actions."
            );
        }
        return this._orchestrator.execute({ action, payload });
    }

    /** Project store state into the BehaviorSubjects. */
    private _syncFromStore(state: MultiRegionState): void {
        this._accounts$.next(state.accounts);
        this._poolInfos$.next(state.poolInfos);
        this._accountInfos$.next(state.accountInfos);
        this._nodes$.next(state.nodes);
        this._activities$.next(state.activities);
        this._agentLogs$.next(state.agentLogs);
    }
}
