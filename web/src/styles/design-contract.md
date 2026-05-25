# Design Contract — Azure Batch Manager Web UI

**Status:** Ratified — Tier 0 of the enterprise-transformation effort.
**Audience:** Every agent that edits any `.ts` / `.tsx` / `.css` / `.json` file
under this project. Read this BEFORE making any change.
**Authority:** This document is the source of truth for cross-cutting design
patterns. If any pattern below conflicts with code you find, the code is wrong
and you fix the code. If you genuinely need to deviate, document the deviation
in the file's purpose-comment header AND ping the orchestrator (i.e., flag it
in your output so it can be reconciled).

---

## 1. Module-level rules

### 1.1 File header
Every `.ts` / `.tsx` source file starts with a 1–3 line purpose comment:

```ts
/**
 * One sentence: what this file is for.
 * (Optional second line: what it specifically does NOT do.)
 */
```

Test files (`*.test.ts(x)`) skip the header (their purpose is implicit).

### 1.2 Imports

- **Absolute imports** via the `@/` alias for anything outside the current
  domain folder:
  ```ts
  import { Button } from "@/components/ui/button";
  import { cn } from "@/lib/utils";
  ```
- **Relative imports** for siblings in the same domain folder:
  ```ts
  import { OrchestratorAgent } from "../../agents/orchestrator-agent";
  import { useMultiRegionState } from "../../store/store-context";
  ```
- Group imports: 1) external (`react`, `lucide-react`), 2) `@/...` aliases,
  3) relative. Blank line between groups.
- No barrel imports for icons. Import each `lucide-react` icon by name.

### 1.3 Exports
- Named exports for components, hooks, types, and utilities. No default exports
  except for the root `src/index.tsx` mount.
- Component file → exports a `<FileNamePascal>` component matching the file
  name. Example: `account-info-page.tsx` → `export const AccountInfoPage`.
- Type-only exports use `export type` so erasable-only-imports works.

### 1.4 React component shape
```tsx
export interface MyComponentProps { ... }

export const MyComponent: React.FC<MyComponentProps> = ({ ... }) => {
  // hooks first, ordered: useState/useReducer → useMemo/useCallback → useEffect
  // helper consts/derived state next
  // event handlers last
  return ( ... );
};
```
- Always type props with an interface, even when empty (`interface FooProps {}`).
- Always pass `aria-label` to interactive primitives without visible text
  (icon-only buttons).
- Always provide a `key` for items in mapped lists; never `key={i}` when a
  stable id is available.

### 1.5 Hooks
- Custom hooks live in `src/multi-region/hooks/use-*.ts` and start with `use`.
- Hooks return either an object (≥3 fields) or a tuple (≤2 fields).
- Side-effect hooks (`useEffect`) declare their cancellation strategy
  (cleanup return, AbortController, `cancelled` flag).

### 1.6 Errors
- Service layer throws **typed errors** from `multi-region/services/types.ts`:
  `AuthError`, `RateLimitError`, `NotFoundError`, `TransientError`,
  `PermissionError`, `ValidationError`. Wrap unknown errors in
  `wrapUnknown(e: unknown): TypedError`.
- UI components catch typed errors and surface them via `<ErrorState />` for
  in-place errors or `addNotification({ type: "error", message })` for
  transient errors.
- Never write `catch {}` (silent swallow). If truly recoverable, write
  `catch { /* reason */ }` with a one-line reason.

### 1.7 Async cancellation
- Long-running React effects use `let cancelled = false` + cleanup that flips
  it, OR an `AbortController` passed into services.
- The orchestrator's actions accept `signal?: AbortSignal` and propagate.

---

## 2. Visual rules

### 2.1 Spacing scale
**Allowed:** `0`, `0.5`, `1`, `1.5`, `2`, `2.5`, `3`, `3.5`, `4`, `5`, `6`, `8`,
`10`, `12`, `16`, `20`, `24`, `32` (Tailwind defaults).
**Disallowed:** arbitrary spacing values (`p-[7px]`, `gap-[13px]`).
**Defaults by context:**
- Page wrapper: `flex flex-col gap-4 py-4` (vertical rhythm)
- Page horizontal: provided by `<main>` parent (`px-4`); pages don't add their
  own `px-*` to the outer wrapper.
- Card padding: `p-4` (default) or `p-5` (emphasized stat cards) or
  `px-4 py-3` (compact strips).
- Inline gap between buttons / chips: `gap-2`.
- Form field row: `gap-3`.

### 2.2 Page wrapper
Every page's root JSX:
```tsx
return (
  <ErrorBoundary>
    <div className="flex flex-col gap-4 py-4">
      <PageHeader title="..." description="...">
        {/* actions: buttons, search */}
      </PageHeader>
      {/* page content */}
    </div>
  </ErrorBoundary>
);
```
The `<ErrorBoundary>` wrap is provided by the route — pages don't add their
own outer ErrorBoundary unless they have inner sections that need isolation.

### 2.3 Tone tokens (the only five)

`primary | info | success | warning | destructive`

Each tone has paired Tailwind classes already defined in `tailwind.config.js`:

| Use | Class form |
|---|---|
| Foreground text | `text-{tone}` |
| Background fill | `bg-{tone}` |
| Subtle background fill (15% alpha) | `bg-{tone}/15` |
| Border | `border-{tone}` |
| Top accent stripe | `border-t-{tone}` |
| Hover ring | `hover:ring-{tone}/40` |

Never hard-code hex / RGB / HSL in components. Never introduce a 6th tone.

### 2.4 Color of dynamic state
- Counts/numbers in the foreground tone of their domain:
  `text-success` for healthy, `text-destructive` for failed,
  `text-warning` for in-progress / used, `text-info` for total,
  `text-muted-foreground` for neutral.
- Always pair with `tabular-nums` for numeric columns / counters.

### 2.5 Card baseline
```tsx
<Card className="border border-border bg-card p-4">
```
Variants:
- Stat card with tone accent: add `border-t-4 border-t-{tone}` to base.
- Hover-lift card (clickable): `transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md`.

### 2.6 Typography scale (allowed Tailwind sizes)
- Page title: `text-2xl font-semibold tracking-tight`
- Section / card heading: `text-base font-semibold`
- Body: default (`text-sm`)
- Subdued / hints: `text-xs text-muted-foreground`
- Micro-caption / metadata: `text-2xs text-muted-foreground/70 tabular-nums`
- Mono (IDs, hashes, sizes): `font-mono text-2xs` or `text-xs`

### 2.7 Density
The `<html>` element carries a `density-comfortable` or `density-compact`
class (toggleable). Tailwind reads CSS variables:
- Comfortable: row height 36–40 px, padding `py-2`.
- Compact: row height 28–32 px, padding `py-1`.
The `<DataTable>` primitive consumes these via CSS variables; pages do not
hardcode row heights.

### 2.8 Motion
- Default transition: `transition-colors duration-150` for interactive states.
- Card lift: `transition-all duration-200 ease-out`.
- Skeletons / spinners: `animate-pulse` / `animate-spin`.
- Always wrap motion in `motion-reduce:transform-none motion-reduce:transition-none`
  (or use the `motion-safe:` variant).
- No bespoke `@keyframes` outside `tailwind.config.js`.

### 2.9 Focus ring
Interactive elements that don't already use a Radix primitive's built-in ring
must include:
```
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background
```

### 2.10 Light-mode parity
Every Tailwind utility used must have a working light-mode counterpart in
`tailwind.css`. Don't use `dark:` overrides for foundation colors — the token
system flips via the `.light` class on `<html>`. Use `dark:`/`light:` only for
exceptional accent overrides.

---

## 3. State patterns

### 3.1 Empty state
Use the canonical `<EmptyState>` from `@/components/shared/empty-state`:
```tsx
<EmptyState
  icon={SomeIcon}
  title="No accounts yet"
  description="Sign in to load accounts from your Azure subscriptions."
  action={
    <Button onClick={...}>Sign in</Button>
  }
/>
```
No bespoke "no items" text blocks. No lone `<p>No data.</p>`.

### 3.2 Loading state
- Initial whole-region load: `<SkeletonLoader variant="..." />`
  (variants: `stat-bar`, `table`, `card-grid`, `details`, `text-block`).
- Inline / overlay loading on an existing region: `<Loader2 className="h-4 w-4 animate-spin" />` with `aria-label`.
- Mutation buttons: disable + show inline spinner; don't overlay the page.

### 3.3 Error state
```tsx
<ErrorState
  message="Failed to load pools."
  detail={error.message}
  onRetry={() => retry()}
/>
```
For card-level errors that fit into a stat card, use the `error` prop on
`<StatCard>` (Overview pattern) — don't wrap in a separate ErrorState.

### 3.4 Confirmation dialogs
**Banned:** `window.confirm`, `window.alert`, `window.prompt`.
**Use:** `<ConfirmationDialog>` from
`@/components/shared/confirmation-dialog`:
```tsx
<ConfirmationDialog
  open={confirmOpen}
  onOpenChange={setConfirmOpen}
  title="Delete pool?"
  description="This permanently deletes pool 'foo' in 'eastus'. Cannot be undone."
  confirmLabel="Delete pool"
  destructive
  onConfirm={async () => { ... }}
/>
```

### 3.5 Toast notifications
- Success toasts via `store.addNotification({ type: "success", message })`.
- Error toasts only for transient/network errors. Validation errors stay
  inline near the offending field.
- Toast text: imperative + past-tense ("Pool created", "Failed to save").

### 3.6 Forms
- Multi-field forms use `react-hook-form` + `zod`:
  ```tsx
  const form = useForm<FormSchema>({ resolver: zodResolver(schema) });
  ```
- Inline single-input search/filter stays plain useState.
- Validation errors are shown via `<FormMessage>` adjacent to the field
  (or aria-describedby + visible help text).
- Submit button: disabled until form is dirty + valid (or shows inline spinner
  during submit).

### 3.7 Stepper workflows
For complex creation flows (pool-creation, account-provisioning):
```
[Configure] -> [Preflight] -> [Review] -> [Submit] -> [Result]
```
Stepper UI uses `<Tabs>` primitive in `orientation="horizontal"` with disabled
forward steps until prior step is valid. URL reflects current step
(`?step=preflight`).

---

## 4. Routing

### 4.1 Routes (canonical)
| Path | Page |
|---|---|
| `/` | redirect to `/azure-accounts` |
| `/azure-accounts` | AzureAccountsPage |
| `/overview` | OverviewPage |
| `/accounts` | AccountProvisioningPage |
| `/accounts/:accountId` | AccountInfoPage (deep link to single account) |
| `/account-info` | AccountInfoPage (no account selected — list view) |
| `/account-info/:accountId` | AccountInfoPage (specific) |
| `/pools` | PoolCreationPage |
| `/pools/:poolId` | PoolInfoPage (deep link) |
| `/pool-defaults` | PoolDefaultsPage |
| `/pool-info` | PoolInfoPage (list view) |
| `/pool-info/:poolId` | PoolInfoPage (specific) |
| `/nodes` | NodesPage |
| `/unused-quota` | UnusedQuotaPage |
| `/monitoring` | MonitoringPage |
| `/gpu-calculator` | GpuCalculatorPage |
| `/audit-log` | AuditLogPage |
| `/tenant-users` | TenantUsersPage |
| `/user-creator` | UserCreatorPage |
| `/ea-subscription` | EaSubscriptionPage |
| `*` | redirect to `/azure-accounts` |

### 4.2 Hotkey ordering
Alt+1..9 maps to the FIRST 9 routes in the order:
1. /azure-accounts
2. /overview
3. /accounts
4. /pools
5. /pool-defaults
6. /pool-info
7. /account-info
8. /unused-quota
9. /monitoring

The remainder are sidebar-click + Cmd-K only.

### 4.3 Deep link filters (URL state)
Filterable pages sync filter state to URL via `useUrlState`:
```ts
const [filters, setFilters] = useUrlState({
  region: "",
  state: "",
  poolId: "",
});
```
Means the URL reflects the filter (`?region=eastus&state=running`) and a
refresh / share-link preserves it. Empty values are stripped from the URL.

---

## 5. Tables (`<DataTable>`)

The shared `<DataTable>` (upgraded from `enhanced-table.tsx`) is the only
component used for multi-row tabular data. Static layout tables can still use
the raw shadcn `<Table>` primitive.

DataTable contract:
- Sortable columns: click header to sort; sort indicator (lucide ChevronUp/Down);
  sort state persists in `store.userPreferences.tableSorts[tableId]`.
- Sticky header on overflow.
- Density-aware row heights (reads CSS vars from §2.7).
- Column visibility menu (DropdownMenu of toggles) accessible via a header
  icon button.
- CSV export button in the header right (uses the `csv-export` helper in
  `lib/utils.ts`).
- Virtualization: enabled automatically when rows.length > 500
  (uses `react-virtual`).
- Row selection (optional): controlled via `selection` + `onSelectionChange`.
- Keyboard nav: arrow up/down navigates rows; Space toggles selection;
  Enter triggers `onRowActivate`.

Required props:
```ts
interface DataTableProps<T> {
  tableId: string;            // used for persisted sort + column-visibility
  rows: T[];
  columns: DataTableColumn<T>[];
  rowKey: (row: T) => string;
  empty?: React.ReactNode;    // EmptyState component
  loading?: boolean;
  selection?: Set<string>;
  onSelectionChange?: (next: Set<string>) => void;
  onRowActivate?: (row: T) => void;
}
```

---

## 6. Accessibility

- Every interactive icon-only element has `aria-label`.
- Every region with semantic meaning has `role="region" aria-label`.
- Skip-to-content link is rendered in the shell (already exists).
- Focus trap is mandatory for `<Dialog>`, `<Sheet>`, `<ConfirmationDialog>`,
  `<Command>` palettes.
- Reduced-motion: every transition wraps `motion-reduce:` per §2.8.
- Tab order: keyboard-only navigation reaches every interactive element in
  visual order.
- Color contrast: AA minimum on all text/background pairs, including light
  mode (close MIGRATION_REPORT follow-up #2).
- Live regions: progress and refresh status use `aria-live="polite"`;
  errors/blocking conditions use `aria-live="assertive"`.

---

## 7. Performance

- Memoize derived data with `useMemo` when computing from arrays > 20 items.
- Memoize callbacks with `useCallback` only when passed to memoized
  components or hook deps.
- `React.memo` for components that re-render frequently with stable props
  (sidebar nav items, table rows, badges in lists).
- Virtualize lists > 500 rows (see §5).
- Debounce search inputs at 200 ms (use a small debounce helper in
  `lib/utils.ts`).
- Code-split routes via `React.lazy` (in `page-router.tsx`); show
  `<SkeletonLoader>` during chunk load.

---

## 8. Audit log + telemetry

- Audit log entries: `auditLog` API stays the same external shape
  (`getEntries`, `onChange`, `clear`, `record`) but internally is backed by
  the store slice. No more module-level singleton state.
- Every destructive action (create / update / delete pool, account, user,
  password reset) records an audit entry via `auditLog.record(...)`.
- Telemetry: out of scope for this transformation. Do NOT add a Telemetry
  interface, App Insights wiring, or any analytics SDK.

---

## 9. Tests

- Test files live in `__tests__/` adjacent to the file under test.
  Naming: `{file-under-test}.test.ts(x)`.
- Use `@testing-library/react` for component tests; never reach into
  internals (no `instance.someMethod()`).
- Mocks for services live in `multi-region/services/__mocks__/*.ts` —
  jest auto-discovers them.
- Page smoke tests (in `multi-region/components/__tests__/page-render.test.tsx`)
  render every page under a mocked store + mocked orchestrator and assert no
  thrown errors + the page heading text appears.
- Coverage target: ≥60% line coverage on
  `multi-region/{services,store,agents,hooks,scheduling}`. UI components
  beyond the smoke test are nice-to-have.

---

## 10. Forbidden patterns (quick reference)

- ❌ `window.confirm`, `window.alert`, `window.prompt`
- ❌ Direct `localStorage.getItem/setItem` (use `usePersistedState` or store)
- ❌ Direct `sessionStorage.getItem/setItem` (use store or URL state)
- ❌ Module-level mutable state (`let _foo = ...; export function setFoo(...)`)
- ❌ `<div>`-based buttons (`onClick={...}` on a div). Use `<button>` or `<Button>`.
- ❌ Inline hex / RGB colors (`color: "#aabbcc"`)
- ❌ Arbitrary Tailwind values for spacing or color (`p-[7px]`, `text-[#abcdef]`)
- ❌ `any` types (use `unknown` + narrow, or define a proper type)
- ❌ Default exports (except `src/index.tsx`)
- ❌ `console.log` in committed code (use `error-helpers.ts` or audit log)
- ❌ Silent error swallowing — every `catch` either re-throws, surfaces UI,
  or has a one-line `/* reason */` comment
- ❌ `useEffect` without a cleanup or cancellation strategy when the effect
  starts a long-running operation
- ❌ Adding new dependencies without checking package.json — flag in your
  output if a new dep is required
