# Pool Control Workbench

## Permissions

- Minimum data-plane permission per Batch account: `Azure Batch Data Contributor` or higher.
- Discovery of subscriptions and Batch accounts uses ARM APIs and can require additional read permissions based on organization policy.
- Workbench actions are executed against existing Batch accounts only; account creation is out of scope.

## Data-Plane APIs Used

- `GET /supportedimages`
- `GET /pools`
- `POST /pools/{id}/resize`
- `POST /pools/{id}/stopresize`
- `GET /pools/{id}/nodes`
- `POST /pools/{id}/removenodes`
- Node actions:
  - `POST /pools/{id}/nodes/{nodeId}/reboot`
  - `POST /pools/{id}/nodes/{nodeId}/reimage`
  - `POST /pools/{id}/nodes/{nodeId}/enablescheduling`
  - `POST /pools/{id}/nodes/{nodeId}/disablescheduling`

## Feature Flags

- `features.poolControlWorkbench` controls whether the Workbench entry points are visible and active.
- `features.multiRegionPoolBootstrap` gates multi-region bootstrap behavior.
- Both flags default to `false` for backward compatibility; existing pool flows remain unchanged when disabled.

## Rollout Notes

- Start with `poolControlWorkbench` disabled in production and enable in test environments first.
- Validate expected RBAC coverage across subscriptions before enabling for broad tenant use.
- Roll out to a small operator subset, monitor throttling/error rates, then expand gradually.
- Keep `multiRegionPoolBootstrap` disabled until orchestration validation completes in target regions.

## Anti-429 Discipline

- Scheduler defaults to sequential execution with bounded, config-driven concurrency.
- Add pacing delay between scheduled requests to avoid burst traffic.
- Honor `Retry-After` when present; otherwise apply bounded exponential backoff with jitter.
- Retry only throttling/transient failures; do not retry fatal validation/permission failures blindly.
- Avoid uncontrolled fan-out (`Promise.all`) across subscriptions/accounts/regions.
- Discovery must avoid eager node enumeration and load node lists only when the UI explicitly requests details.
