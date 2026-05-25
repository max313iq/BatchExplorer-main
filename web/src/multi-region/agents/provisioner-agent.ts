import {
  Agent,
  AgentContext,
  AgentResult,
  ProvisionerInput,
  noopAuditLogger,
} from "./agent-types";
import { ManagedAccount } from "../store/store-types";
import {
  createResourceGroup,
  createBatchAccount,
  ensureProvidersRegistered,
} from "../services/arm-service";
import { AzureRequestError } from "../services/types";
import { guardedFetch } from "../scheduling/request-governance";
import { taskRuntime } from "../store/task-runtime";
import { classifyAzureError } from "./error-classifier";
import { CancellationTracker } from "./_shared/cancellation";

function randomAlphanumeric(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function regionShort(region: string): string {
  return region
    .replace(/[^a-z0-9]/gi, "")
    .substring(0, 8)
    .toLowerCase();
}

function generateAccountName(region: string): string {
  const short = regionShort(region);
  const rand = randomAlphanumeric(4);
  const name = `batch${short}${rand}`;
  // Batch account names must be 3-24 chars, lowercase alphanumeric
  return name.substring(0, 24);
}

function generateResourceGroup(region: string): string {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .substring(0, 14);
  return `rg-batch-${region}-${ts}`;
}

/** Minimum delay between write operations (ms) to avoid throttling */
const WRITE_RATE_LIMIT_MS = 500;

/**
 * Resource providers that must be registered on a subscription before
 * Batch account creation can succeed. Microsoft.Batch is the obvious one;
 * Storage/Network/Compute are needed because Batch later spins up storage
 * accounts, VMSS, and (optionally) VNets under the user's subscription
 * during pool creation.
 */
const REQUIRED_PROVIDERS = [
  "Microsoft.Batch",
  "Microsoft.Storage",
  "Microsoft.Network",
  "Microsoft.Compute",
];

export class ProvisionerAgent implements Agent {
  readonly name = "provisioner" as const;
  private _cancelled = false;
  private readonly _cancellation = new CancellationTracker();

  constructor(private readonly _ctx: AgentContext) {}

  cancel(): void {
    this._cancelled = true;
    this._cancellation.abortAll();
  }

  private get _audit() {
    return this._ctx.auditLogger ?? noopAuditLogger;
  }

  async execute(params: Record<string, unknown>): Promise<AgentResult> {
    const input = params as unknown as ProvisionerInput;
    const { store, scheduler, armUrl } = this._ctx;
    // Per-call AbortController. Audit fix #8: do NOT reset
    // `_cancelled` on entry — that would silently squash a concurrent
    // caller's cancel signal.
    const callerSignal = (params as { signal?: AbortSignal }).signal;
    const { controller, signal } = this._cancellation.begin(callerSignal);
    const dryRun = Boolean(input.config?.dryRun);
    // Use the per-subscription token resolver when available so
    // operators with multiple signed-in AAD accounts can pick a sub
    // owned by any of them. Falls back to the generic provider for
    // single-account setups and legacy contexts.
    const getAccessToken: () => Promise<string> =
      this._ctx.getAccessTokenForSubscription
        ? () =>
            this._ctx.getAccessTokenForSubscription!(input.subscriptionId)
        : this._ctx.getAccessToken;

    try {

    store.setAgentStatus("provisioner", "running");
    store.addLog({
      agent: "provisioner",
      level: "info",
      message: `Starting account provisioning for ${input.regions.length} regions`,
    });

    // SAFETY: Validate that the subscription is enabled before creating accounts
    const subscriptionOk = await this._validateSubscription(
      input.subscriptionId,
      armUrl,
      getAccessToken,
    );
    if (!subscriptionOk.valid) {
      store.setAgentStatus("provisioner", "error");
      store.addLog({
        agent: "provisioner",
        level: "error",
        message: `Subscription ${input.subscriptionId} is not in a valid state: ${subscriptionOk.reason}. Aborting to prevent creating accounts that could be disabled.`,
      });
      return {
        status: "failed",
        summary: {
          total: input.regions.length,
          created: 0,
          failed: input.regions.length,
          failures: [
            {
              region: "*",
              error: `Subscription not valid: ${subscriptionOk.reason}`,
            },
          ],
        },
      };
    }

    // Auto-register required ARM resource providers on the subscription.
    // Without this, the first PUT /Microsoft.Batch/batchAccounts returns a
    // 409 MissingSubscriptionRegistration. Idempotent + cached per session.
    // In dry-run we skip the registration probe entirely — it's a write
    // (PUT /register), and the whole point of dry-run is no writes.
    try {
      if (dryRun) {
        store.addLog({
          agent: "provisioner",
          level: "info",
          message: `[dry-run] would ensure providers registered on ${input.subscriptionId}: ${REQUIRED_PROVIDERS.join(", ")}`,
        });
      } else {
        const token = await getAccessToken();
        const result = await ensureProvidersRegistered(
          input.subscriptionId,
          REQUIRED_PROVIDERS,
          token,
        );
        if (result.newlyRegistered.length > 0) {
          store.addLog({
            agent: "provisioner",
            level: "info",
            message: `Registered providers on subscription ${input.subscriptionId}: ${result.newlyRegistered.join(", ")}`,
          });
        }
      }
    } catch (e: any) {
      const msg =
        e instanceof AzureRequestError ? e.message : e?.message ?? String(e);
      store.setAgentStatus("provisioner", "error");
      store.addLog({
        agent: "provisioner",
        level: "error",
        message: `Required resource providers could not be registered on ${input.subscriptionId}: ${msg}. Ask a subscription Owner to run \`az provider register --namespace Microsoft.Batch\` (and Microsoft.Storage / Microsoft.Network / Microsoft.Compute).`,
      });
      return {
        status: "failed",
        summary: {
          total: input.regions.length,
          created: 0,
          failed: input.regions.length,
          failures: [
            {
              region: "*",
              error: `Provider registration failed: ${msg}`,
            },
          ],
        },
      };
    }

    let created = 0;
    let failed = 0;
    const failures: Array<{ region: string; error: string }> = [];
    let lastWriteTime = 0;

    // Sticky-task progress wiring. The orchestrator forwards the active
    // sticky task id via the payload so the provisioner can tick the
    // Task Manager directly — without this the create_accounts task
    // showed "running" forever with no progress bar even as regions
    // streamed in. The same flag also serves as the cooperative-cancel
    // channel (orchestrator.cancel() flips _cancelled, BUT a Cancel
    // click in the Task Manager goes through taskRuntime.requestCancel
    // — checked here on every iteration boundary).
    const stickyTaskId =
      typeof (params as Record<string, unknown>).stickyTaskId === "string"
        ? ((params as Record<string, unknown>).stickyTaskId as string)
        : undefined;
    if (stickyTaskId) {
      taskRuntime.tick(stickyTaskId, {
        total: input.regions.length,
        completed: 0,
        failed: 0,
        currentStep: "Preparing…",
      });
    }

    for (let regionIdx = 0; regionIdx < input.regions.length; regionIdx++) {
      const region = input.regions[regionIdx];
      // Cooperative cancel: respect EITHER the orchestrator-wide
      // _cancelled flag OR a per-task cancel from the Task Manager.
      const userCancelled = stickyTaskId
        ? taskRuntime.isCancelRequested(stickyTaskId)
        : false;
      if (this._cancelled || userCancelled || signal.aborted) break;
      // Cooperative pause — same iteration-boundary check as cancel,
      // but doesn't mark anything failed. The task record was already
      // flipped to "paused" by the operator's Pause click; we just stop
      // the loop and let execute()'s post-loop writeback see the paused
      // status and skip its own overwrite.
      const userPaused = stickyTaskId
        ? taskRuntime.isPauseRequested(stickyTaskId)
        : false;
      if (userPaused) {
        if (stickyTaskId) {
          taskRuntime.update(stickyTaskId, {
            currentStep: `Paused at region ${regionIdx + 1}/${input.regions.length}. Click Start to resume.`,
            status: "paused",
          });
        }
        break;
      }

      if (stickyTaskId) {
        taskRuntime.tick(stickyTaskId, {
          currentStep: `Region ${regionIdx + 1}/${input.regions.length}: ${region}`,
        });
      }

      // Skip regions that already have a created account for this subscription
      const existing = store
        .getState()
        .accounts.find(
          (a) =>
            a.region === region &&
            a.subscriptionId === input.subscriptionId &&
            a.provisioningState === "created",
        );
      if (existing) {
        store.addLog({
          agent: "provisioner",
          level: "warn",
          message: `Account already exists for ${region} (${existing.accountName}), skipping`,
        });
        // Skipped regions count as "completed" for the sticky-task progress
        // bar — they're done, just not by us. Without this the progress
        // bar would stick at 0/N when resume hits an already-completed run.
        if (stickyTaskId) {
          created++;
          taskRuntime.tick(stickyTaskId, { completed: created, failed });
        }
        continue;
      }

      // Rate limit writes: enforce minimum delay between create operations
      const now = Date.now();
      const elapsed = now - lastWriteTime;
      if (elapsed < WRITE_RATE_LIMIT_MS && lastWriteTime > 0) {
        await new Promise((r) => setTimeout(r, WRITE_RATE_LIMIT_MS - elapsed));
      }

      const accountName = generateAccountName(region);
      const resourceGroup = generateResourceGroup(region);
      const accountId = `/subscriptions/${input.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Batch/batchAccounts/${accountName}`;

      const account: ManagedAccount = {
        id: accountId,
        accountName,
        resourceGroup,
        subscriptionId: input.subscriptionId,
        region,
        provisioningState: "pending",
        createdAt: new Date().toISOString(),
        error: null,
      };
      store.addAccount(account);

      try {
        store.updateAccount(accountId, {
          provisioningState: "creating",
        });

        if (dryRun) {
          // Audit fix #20: dry-run skips the actual write but still
          // logs what would have been done. The store sees the
          // pre-flight "creating" → "created" transition so the UI
          // renders the row as if the create succeeded.
          store.addLog({
            agent: "provisioner",
            level: "info",
            message: `[dry-run] would create resource group ${resourceGroup} in ${region}`,
          });
          store.addLog({
            agent: "provisioner",
            level: "info",
            message: `[dry-run] would create Batch account ${accountName} in ${region}`,
          });
        } else {
          // Step 1: Create resource group
          await scheduler.run(input.subscriptionId, async () => {
            if (this._cancelled || signal.aborted) throw new Error("cancelled");
            const token = await getAccessToken();
            await createResourceGroup(
              input.subscriptionId,
              resourceGroup,
              region,
              token,
            );
          });
          store.addLog({
            agent: "provisioner",
            level: "info",
            message: `Resource group ${resourceGroup} created in ${region}`,
          });

          // Step 2: Create Batch account
          let result: unknown;
          await scheduler.run(input.subscriptionId, async () => {
            if (this._cancelled || signal.aborted) throw new Error("cancelled");
            const token = await getAccessToken();
            result = await createBatchAccount(
              input.subscriptionId,
              resourceGroup,
              accountName,
              region,
              token,
            );
          });

          lastWriteTime = Date.now();

          // Safety net: verify provisioning state from the returned resource
          const provisioningState = (
            result as {
              properties?: {
                provisioningState?: string;
                statusText?: string;
              };
            }
          )?.properties?.provisioningState;

          if (
            provisioningState === "Failed" ||
            provisioningState === "Canceled"
          ) {
            const statusText =
              (result as { properties?: { statusText?: string } })?.properties
                ?.statusText ?? "Unknown error";
            throw new Error(
              `Batch account provisioning ${provisioningState}: ${statusText}`,
            );
          }

          store.addLog({
            agent: "provisioner",
            level: "info",
            message: `Account ${accountName} provisioning state: ${provisioningState ?? "Succeeded"}`,
          });
        }

        store.updateAccount(accountId, {
          provisioningState: "created",
        });
        store.addLog({
          agent: "provisioner",
          level: "info",
          message: `${
            dryRun ? "[dry-run] would have created" : "Created"
          } account ${accountName} in ${region}`,
        });
        created++;
        this._audit.record({
          action: dryRun ? "account_create_dryrun" : "account_create",
          target: accountId,
          status: "success",
          details: {
            subscriptionId: input.subscriptionId,
            region,
            accountName,
            resourceGroup,
            dryRun,
          },
        });
        if (stickyTaskId) {
          taskRuntime.tick(stickyTaskId, { completed: created, failed });
        }
      } catch (error: any) {
        const errorMsg =
          error instanceof AzureRequestError
            ? error.message
            : error?.message ?? String(error);
        const classified = classifyAzureError(error);
        store.updateAccount(accountId, {
          provisioningState: "failed",
          error: errorMsg,
        });
        store.addLog({
          agent: "provisioner",
          level: "error",
          message: `Failed to create account in ${region} [${classified.kind}]: ${errorMsg}`,
        });
        failures.push({ region, error: errorMsg });
        failed++;
        lastWriteTime = Date.now();
        this._audit.record({
          action: "account_create",
          target: accountId,
          status: "failure",
          error: errorMsg,
          details: {
            subscriptionId: input.subscriptionId,
            region,
            accountName,
            resourceGroup,
            classification: classified.kind,
            dryRun,
          },
        });
        if (stickyTaskId) {
          taskRuntime.tick(stickyTaskId, { completed: created, failed });
        }
        // Audit fix #18: hard-stop on auth / subscription-blocked
        // failures — no point burning through the remaining regions.
        if (classified.shouldAbortRun) {
          store.addLog({
            agent: "provisioner",
            level: "error",
            message: `Aborting remaining regions: ${classified.kind} (${classified.reason})`,
          });
          break;
        }
      }
    }

    const status =
      failed === 0 ? "completed" : created === 0 ? "failed" : "partial";
    store.setAgentStatus(
      "provisioner",
      status === "failed" ? "error" : "completed",
    );
    store.addLog({
      agent: "provisioner",
      level: "info",
      message: `Provisioning complete: ${created} created, ${failed} failed out of ${input.regions.length}`,
    });

    return {
      status,
      summary: {
        total: input.regions.length,
        created,
        failed,
        failures,
        ...(dryRun ? { dryRun: true } : {}),
      },
    };
    } finally {
      this._cancellation.end(controller);
    }
  }

  /**
   * SAFETY: Validate that the subscription is in an active/enabled state.
   * Never create accounts under disabled/warned/deleted subscriptions
   * as they will be immediately disabled.
   */
  private async _validateSubscription(
    subscriptionId: string,
    armUrl: string,
    getAccessToken: () => Promise<string>,
  ): Promise<{ valid: boolean; reason?: string }> {
    try {
      const token = await getAccessToken();
      const url = `${armUrl}/subscriptions/${subscriptionId}?api-version=2022-12-01`;
      // Routed through guardedFetch so the subscription validation probe
      // contributes to the throttle-budget tracker AND benefits from
      // x-ms-client-request-id correlation. Previously a direct fetch()
      // hidden inside the provisioner — invisible to circuit breakers.
      const response = await guardedFetch(
        url,
        { headers: { Authorization: `Bearer ${token}` } },
        { subscriptionId, family: "arm" },
      );

      if (!response.ok) {
        return {
          valid: false,
          reason: `Cannot verify subscription: HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      const state = data?.subscriptionPolicies?.spendingLimit;
      const subscriptionState = (data?.state ?? "").toLowerCase();

      // Only allow Enabled subscriptions
      if (subscriptionState !== "enabled" && subscriptionState !== "") {
        return {
          valid: false,
          reason: `Subscription state is "${data?.state}" (expected "Enabled")`,
        };
      }

      // Warn if spending limit is on (pay-as-you-go with spending limit = risk of disable)
      if (state === "On") {
        this._ctx.store.addLog({
          agent: "provisioner",
          level: "warn",
          message: `Subscription ${subscriptionId} has spending limit ON — accounts may be disabled if limit is reached`,
        });
      }

      return { valid: true };
    } catch (error: any) {
      // If we cannot validate, proceed with caution but log a warning
      this._ctx.store.addLog({
        agent: "provisioner",
        level: "warn",
        message: `Could not validate subscription state: ${error?.message ?? error}. Proceeding with caution.`,
      });
      return { valid: true };
    }
  }
}
