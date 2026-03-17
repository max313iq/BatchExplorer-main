# Codex TODO Prompt Pack — Multi-Region Zero-Node Pools (v1)

> Purpose: Provide **small, sequential Codex prompts** to implement:
> - Create pools with 0 nodes across all existing Batch accounts (region ≈ account location)
> - Gradually resize 0→1→2… until quota/failure or hard cap
> - Keep polling until all nodes are `idle`
> - If any node is “non-idle”, remediate per policy (delete/recreate by keeping target)
> - Single UI button to run + Activity progress + summary
>
> IMPORTANT: Run the prompts **one by one**. After each prompt, Codex must:
> 1) list changed files
> 2) summarize what’s done
> 3) stop (do not continue to next prompt unless asked)

---

## v1 Decision Log (locked constraints)

Codex must implement **exactly these v1 baseline rules** unless prompt says otherwise:

- Scope of “all regions”:
  - ✅ Option A (v1): operate on **all existing Batch Accounts only**
  - ❌ Option B (v1): do NOT auto-create new Batch Accounts

- Pool naming:
  - `bootstrap-{location}-{yyyyMMdd-HHmm}-{rand4}`

- Node type:
  - v1 uses **dedicated** nodes only (`targetDedicatedNodes`)
  - lowPriority is v2 only (ignore in v1)

- Pool template (v1):
  - VM image: Ubuntu LTS supported by the Batch account
  - VM size: `Standard_D2s_v3` (configurable)
  - Network: default account behavior (no custom VNET in v1)
  - StartTask: lightweight readiness check
  - NodeAgentSku: selected automatically to match chosen image

- Max target per account:
  - hard cap `maxTargetPerAccount = 20`
  - also stop on first quota/resize failure while recording last successful target

- Concurrency:
  - v1 baseline: sequential (concurrency=1)

- Timeouts:
  - provisioning timeout: 20 minutes per target
  - wait-for-idle timeout: 10 minutes
  - retry: 5 attempts with exponential backoff [2,4,8,16,32] seconds

- Running node policy:
  - never delete immediately
  - wait 3 consecutive polling cycles
  - if still running after that → mark `requires-manual-review`, skip deletion

- Cleanup:
  - default: keep pools
  - optional: `cleanupAfterRun=true` deletes bootstrap pools after run

- Feature flag:
  - `features.multiRegionPoolBootstrap`, default **false** in production

---

## Baseline Config Snapshot (v1)
Implement config storage in whatever config system the repo uses (environment/config service), but the effective values must match:

```yaml
features:
  multiRegionPoolBootstrap: false

scope:
  includeExistingBatchAccountsOnly: true
  autoCreateBatchAccountsPerRegion: false

pool:
  idPattern: "bootstrap-{location}-{yyyyMMdd-HHmm}-{rand4}"
  nodeType: dedicated
  vmSize: Standard_D2s_v3
  image: UbuntuLTS
  maxTargetPerAccount: 20

execution:
  concurrency: 1
  provisioningTimeoutMinutes: 20
  waitForIdleTimeoutMinutes: 10
  retryAttempts: 5
  retryBackoffSeconds: [2, 4, 8, 16, 32]

policy:
  runningNodeAction: manual-review-after-3-polls
  cleanupAfterRun: false
