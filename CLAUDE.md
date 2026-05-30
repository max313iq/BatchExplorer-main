# Project rules

## HARD RULE — Professional/advanced code only; build the base first, then elevate it

This is a **professional, advanced project**. There is **NO place for
simple / toy / placeholder / "good-enough" code** as a *final* state.
Every change I ship — and every change a sub-agent ships — must land at
production-grade, advanced quality. "It compiles and runs" is the *floor*,
never the deliverable.

### The two-phase method (mandatory, in this order)

1. **Phase 1 — Base build (think simple first).** Get a *correct, minimal,
   working* base in place: the most straightforward implementation that
   compiles, runs, and actually does the thing. Prove the mechanism end to
   end before decorating it. Do NOT gold-plate or abstract prematurely here
   — a clear, correct skeleton is the goal of this phase.
2. **Phase 2 — Elevate (make it advanced).** Then deliberately raise that
   same code to the project's professional bar **before** calling the task
   done. Phase 1 is scaffolding; shipping it as-is is a rule violation.
   **Done ≠ "it works." Done = Phase 2 complete.**

### What "advanced / professional" means here (Phase 2 checklist)

- Full error handling and explicit edge-case coverage (empty/null, 4xx/5xx,
  partial failure, concurrency, abort/cancel, throttling/retry).
- Precise, non-`any` types; exhaustive unions; no silent casts.
- Idempotency and safe re-entry where the operation can repeat.
- Observability: audit-log entries, meaningful messages, no `console.log`
  debris and no leftover `TODO`/`FIXME`/placeholder branches.
- Security posture appropriate to the surface (no secret leakage, least
  privilege, validated inputs).
- Accessibility + UX polish for any UI (labels, keyboard, states, a11y).
- Performance: no needless N+1 calls, no unbounded loops, batch where the
  platform expects it.
- Consistency: mirror the established patterns/components/services already
  in the codebase rather than inventing a parallel one.
- Verification: `tsc --noEmit` clean, relevant tests added/passing.

### How to reach "advanced" — use the research corpus

Per the **Primary research resource** rules below, when elevating code find
the closest cataloged reference (via the `build-from-inventory` `kb.mjs`
driver / the corpus), study its *source*, and mirror the technique. Don't
re-derive an advanced approach from memory when a vetted one exists.

### Propagation

Sub-agents inherit this rule verbatim (see *Sub-agent context propagation*).
A sub-agent that stops at Phase 1 has not finished its task. State this in
every dispatch prompt: *"deliver Phase-2 advanced quality, not a simple
first pass."*

---

## Dependency policy — installs ALLOWED for testing / building / verification

The directory name `AzureBatchManager-source-only-no-deps-20260525\` is
**historical** — it reflects how the source arrived (no `node_modules\`
pre-populated). It is no longer a hard rule.

**Installs are allowed** when needed for the task at hand:
- `npm install` / `npm ci` to populate `node_modules\` so `tsc`, `jest`,
  `webpack`, `eslint` can run against the project's *already-declared*
  dependencies.
- Running `tsc --noEmit`, `jest`, `npm run build`, `npm run test`,
  `npm run lint` (anything declared in `package.json scripts`).
- Re-running `npm install` after adding a genuinely-needed declared
  dependency for the user's current task.

**Still discouraged** (announce + justify first, don't do drive-by):
- Adding a brand-new top-level npm dependency that isn't already part of
  the project's declared set — unless the user's current task says
  "add X package."
- Network fetches of models / weights / non-npm binaries (HuggingFace,
  Ollama pulls, etc.) — these aren't part of normal npm install flow
  and should be opt-in per task.

**Editing IS a freedom — full access to improve and modernize.**
(Updated 2026-05-27 by user instruction, superseding the prior
per-task/per-instruction edit-scope restriction.)

- I have **blanket permission** to edit, refactor, and improve any
  source file in this project, and to upgrade code to a more
  advanced / modern version, even when not asked line-by-line.
- Proactive improvements are allowed: refactors, "improve while
  I'm here," adding imports of already-declared packages,
  reformatting, renaming, dead-code removal, and comment clean-up
  are all permitted without a narrow per-line instruction.
- When writing or improving code, use the `build-from-inventory`
  `kb.mjs` driver as the coding research/reference resource (find
  the closest cataloged tool → study its source → mirror the
  technique). See the kb.mjs research-resource memory.
- Judgment still applies: keep changes coherent and correct, prefer
  editing existing files over new ones, and still confirm before
  hard-to-reverse or shared-state actions (pushes, deletes, deps
  that aren't already declared — see the dependency policy above).
- Sub-agents inherit this same full-access posture; their prompts
  may authorize improving the assigned files, not just a single
  literal change.

---

# Git workflow — commit directly to `main`

## HARD RULE — commit to `main`, never branch first

This is my personal repo and I want a single linear history. When asked to
commit, **commit directly to the `main` branch**. This explicitly overrides
the agent's default "if on the default branch, branch first" behavior:

- **Do NOT** create a `session/*`, `feature/*`, or any other work branch
  before committing. Stay on `main` and commit there.
- If a prior task already moved HEAD onto a side branch, switch back to
  `main` (fast-forward / merge the side branch in) before committing new
  work, so the history converges on `main`.
- This applies to sub-agents too: any agent that commits on this repo
  commits to `main`.

### Commit vs. push — the safety split still holds

- **Committing** to `main` is local and reversible, so do it freely when
  asked (per this rule, with no branch-first prompt).
- **Pushing** to a remote (`origin`, GitHub, etc.) is shared state and
  hard to reverse — still **confirm before pushing**, even to `main`.
  Pushing is NOT implied by "commit"; only push when explicitly asked.
- Never `push --force` to `main` without an explicit, specific request.

### Commit message + attribution (unchanged)

Messages stay descriptive and end with the standard co-author trailer:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

### Propagation

Sub-agents inherit this rule verbatim (see *Sub-agent context
propagation*). State it in every dispatch prompt that may commit:
*"commit to `main`; do not create a work branch."*

---

## Source-of-truth: ALWAYS work with the direct source code

- Edit files **in place** at their absolute paths under `C:\Users\NEXO\Desktop\AzureBatchManager-source-20260513-195617\`.
- **Do NOT** use `isolation: "worktree"` when dispatching agents on this project.
  - `git worktree add` only sees committed (`HEAD`) state — uncommitted
    additions and brand-new untracked files (e.g. pages I create mid-session
    that haven't been git-added yet) are invisible to the worktree. Agents
    then report "file not found" or rebuild against stale state, producing
    diffs that can't be cleanly merged.
- For ALL multi-agent dispatch on this repo: dispatch agents **without**
  `isolation`, so they edit the live working tree directly. Per-page agents
  are still safe in parallel because each one targets a disjoint page file.
- Service / auth / store layer edits stay constrained per-agent (the
  per-page prompts already enforce "edit only your assigned page file").
- Worktree mode is acceptable ONLY for read-only audits where the agent
  produces a report and no patch needs merging.

## Why this rule exists

During the 2026-05-20 page-improvement loop, ~9 pages I had created in the
session but not committed were invisible to worktree-mode agents — they
all returned "file not found" and had to be redispatched. The worktree-mode
agents that DID see their files produced patches against the stale committed
base, requiring per-file 3-way `git merge-file --ours` to reconcile against
the live main-tree changes from earlier merged agents. Direct in-place edits
sidestep both problems.

---

# Sub-agent model and effort

## HARD RULE — Every sub-agent is Opus 4.7 (1M context), max effort, fast posture

Every `Agent` tool call I make MUST set:

- **`model: "opus"`** — selects the current Opus tier the platform serves
  (Opus 4.7 with 1M context per the runtime footer). Never `sonnet`,
  never `haiku`, never omit (omitting inherits the parent model, which
  is not guaranteed to be Opus).
- **`subagent_type: "claude"`** (or a specifically named role) — the
  default `claude` catch-all is Opus-capable. Do NOT use lighter agent
  types (`Explore`, `general-purpose`) for code-writing work that needs
  full capability.

## Effort and pace — set via prompt, not tool params

The `Agent` tool has no `effort`, `thinking`, `extended_thinking`,
`speed`, or `mode` parameter. "Max effort" and "fast mode" cannot be
configured at the tool layer. They must be communicated through the
prompt body:

- **For max effort:** every dispatched-agent prompt must include the
  line *"Think carefully. Take the time you need. Verify your work
  before reporting done."* — placed near the top of the prompt, above
  the task.
- **For fast posture (delivery-focused, not exploratory):** include
  *"Do not over-explore. Read only what the task requires. Do not
  speculate about future requirements. Report when the assigned task
  is complete."* — paired with the max-effort line.

The two are not contradictory when paired: think deeply about the
assigned scope; do not balloon the scope.

## What this rule does NOT cover

- I cannot pin a specific Opus minor version (`4.7` vs `4.8` etc.) —
  the platform routes `opus` to its current Opus tier.
- I cannot guarantee 1M context — that is a platform-served capability
  of the current Opus tier and may change without notice.
- I cannot enable extended-thinking from the `Agent` tool; if the
  platform-level extended-thinking is a session setting elsewhere
  (e.g. via `/config`), the user controls that, not me.

If a future `Agent` tool schema exposes an effort or thinking knob,
this rule must be updated to set it explicitly in addition to the
prompt-level wording.

---

# Sub-agent context propagation

## Every sub-agent inherits the full session settings

When dispatching a sub-agent via the `Agent` tool (any `subagent_type`,
including the default `claude`, `Explore`, `Plan`, `general-purpose`,
or any custom role), the sub-agent starts in a fresh context with no
memory of this conversation. It **must** be given the same settings
this session is running under, or it will violate the rules above
(use worktree mode, edit the wrong paths, skip the research corpus,
re-derive techniques from memory, etc.).

### Required propagation rules

1. **Inherit this CLAUDE.md.** Every sub-agent prompt must either
   include the relevant rules from this file verbatim, or instruct
   the sub-agent to `Read C:\Users\baimgprodsesa1\Desktop\AzureBatchManager-source-only-no-deps-20260525\CLAUDE.md`
   as its first action.
2. **Inherit nested `.md` rules too ("sub md").** If the work touches
   a subdirectory that has its own `CLAUDE.md`, `AGENTS.md`,
   `.cursor*.md`, `.claude\*.md`, `plan.md`, `rules.md`, or any other
   session-scoped `.md` settings file, list those paths in the prompt
   and require the sub-agent to Read them before editing. Do not
   summarize — the sub-agent must see the actual file content.
3. **Propagate transitively.** If a sub-agent spawns its own
   sub-agent, the same propagation rules apply. State this
   explicitly in the parent prompt: *"any agent you dispatch must
   also receive these settings."*
4. **No worktree isolation (reinforced).** Per the source-of-truth
   rule above: `isolation: "worktree"` is forbidden for any sub-agent
   that writes code on this project. Worktree mode is allowed only
   for read-only audit agents.
5. **Research-corpus rule inherited.** Every sub-agent that does
   research, lookup, or "how does X work" reasoning must follow the
   `New folder\` rules below (read corpus first, source > README,
   cite corpus paths, do not edit the corpus). Include a one-line
   pointer in the prompt: *"Research resource: see CLAUDE.md
   `Primary research resource` section."*
6. **Sub-agent role identity.** When a sub-agent is created with a
   specific role (e.g. "page-improver", "azure-bypass-researcher",
   "auth-flow-auditor"), name the role in the prompt and bind it to
   the relevant playbook(s) from the curated index, e.g.
   *"Role: azure-bypass-researcher. Authoritative reference:
   `_AZURE_BYPASS_PLAYBOOK.md` and the docs it links."*

### Prompt skeleton for every dispatched sub-agent

```
Role: <role-name>

Session settings you MUST follow:
  - Read first: C:\Users\baimgprodsesa1\Desktop\AzureBatchManager-source-only-no-deps-20260525\CLAUDE.md
  - Nested rules to also Read:
      <list every applicable sub-CLAUDE.md / AGENTS.md / *.md rules file by absolute path>
  - Research corpus: C:\Users\baimgprodsesa1\Desktop\New folder\
      Follow the "Primary research resource" rules in CLAUDE.md.
      Authoritative playbook(s) for this task: <list from curated index>
  - No worktree isolation. Edit the live working tree in place.
  - Any sub-agent you spawn must receive these same settings.

Task: <the actual task>
```

### Why this rule exists

Sub-agents dispatched without the session's `.md` settings have
repeatedly: re-derived Azure techniques from training data instead of
reading the corpus; ignored the no-worktree rule; written to wrong
paths; and dropped role-specific constraints that only existed in
parent-session memory. Propagating the settings — including every
nested `.md` ("sub md") — is the only reliable fix.

---

# Primary research resource

## `C:\Users\baimgprodsesa1\Desktop\New folder` is the master research corpus

Whenever a task requires research, prior-art lookup, technique reference,
tool comparison, protocol/wire-level detail, or "how does X work" answers
in the Azure / Entra ID / cloud-security / offensive-tooling space, the
authoritative source is the cloned offensive-tooling corpus at:

```
C:\Users\baimgprodsesa1\Desktop\New folder\
```

### Research rules

1. **Read it first, web second.** Before WebSearch / WebFetch for any
   technique in this domain, search the corpus. The source code there is
   the ground truth — public blog posts paraphrase it.
2. **Source code beats README.** READMEs describe intent; the `.ps1` /
   `.py` / `.cs` / `.go` files describe what actually happens on the wire.
   When answering "how does this tool work", read the implementation, not
   just the README.
3. **Prefer corpus citations over re-derivation.** When explaining a
   technique, cite the specific file in the corpus (e.g.
   `dirkjanm\ROADtools\roadlib\auth.py:142`) rather than re-explaining
   from memory.
4. **The curated `_*.md` playbooks at the corpus root are authoritative.**
   They are my own synthesis across the whole corpus. If a playbook and a
   tool README disagree, the playbook wins (it reflects the cross-tool
   understanding).
5. **Index, then Read on demand.** Do not preemptively read all 6,859
   `.md` files — use the index below to locate the right repo, then Read
   the specific file(s) needed.
6. **Treat the corpus as read-only reference.** Never edit / delete /
   reorganize files inside `New folder\`. It is research material, not
   project source.

## Curated playbook index (corpus root, `_*.md`)

These 15 files at `C:\Users\baimgprodsesa1\Desktop\New folder\` are my
own cross-tool synthesis. Read the master playbook first when planning
any Azure / Entra ID operation.

| File | Scope | Use when |
|------|-------|----------|
| `_AZURE_BYPASS_PLAYBOOK.md` | Master entry point — links to every other doc | First read, always |
| `_AZURE_LOGIN_METHODS.md`   | Programmer's reference: how every Entra auth flow works on the wire | Protocol-level grounding |
| `_bypass_login.md`          | CA / MFA / device-state / legacy-auth bypass | Authenticating as a user |
| `_bypass_tenant_switch.md`  | Multi-tenant tokens, guest abuse, WIF, Lighthouse, AAD Connect, sovereign clouds | Pivoting between tenants |
| `_bypass_role_grant.md`     | Directory roles, Azure RBAC, app-role chains, group abuse, consent | Privilege escalation |
| `_bypass_staged_pim.md`     | PIM eligibility / activation / group-PIM / time-bound | Stealth persistence + on-demand admin |
| `_bypass_mixed_chains.md`   | 12 end-to-end kill chains composing all primitives | Planning an operation |
| `_bypass_modify_delete.md`  | MFA / password / tenant / user / quota state-changing ops | Modifying or destroying state |
| `_ea_subscription_cross_tenant.md` | EA enrollment & cross-tenant subscription abuse | Billing / subscription pivots |
| `_analysis_aadinternals.md` | Gerenios AADInternals deep-dive | Golden SAML, Kerberos, PRT wire-level |
| `_analysis_dirkjanm.md`     | ROADtools / FOCI / PRT / PKINIT | Modern protocol attacks |
| `_analysis_dafthack.md`     | GraphRunner / MFASweep / TeamFiltration | Operator-grade Graph abuse |
| `_analysis_netspi.md`       | MicroBurst / IMDS variants / RunAs cert / App Service | Cloud resource-plane attacks |
| `_analysis_specterops.md`   | AzureHound / EntraSSOHound | Enumeration tooling |
| `_analysis_defender_view.md`| Azucar / ScoutSuite / Prowler | Defender perspective; legitimate auth surface |

Supporting top-level files (not playbooks but research metadata):
`_clone_all.ps1`, `_clone_progress.log`, `_clone_results.json`,
`_clone_tasks.json`, `_repo_filtered.json`, `_repo_lists.json`,
`_prowler_clone.log`.

## Source-code repository index

Eight org folders containing 6,859 `.md` files (plus the actual source
code in `.ps1`, `.py`, `.cs`, `.go`, `.js`, `.ts`, etc.). When a task
mentions any of the tool names below, the source lives here — read it
directly rather than searching the web.

### `Gerenios\` — 4 .md files / 3 repos
Author of AADInternals (the canonical Entra/AAD offensive PowerShell module).
- `AADInternals` — main module: Golden SAML, Kerberos KDS, PRT extraction, sync-account abuse
- `AADInternals-Endpoints` — endpoint extension module
- `Authenticator` — MS Authenticator app research

### `dirkjanm\` — 5,887 .md files / 16 repos
Dirk-jan Mollema's modern Entra protocol attack research.
- `ROADtools` — ROADrecon, ROADtx, roadlib — modern Azure AD auth toolkit
- `ROADtoken` — PRT cookie acquisition
- `AADInternals-Endpoints` — fork
- `BloodHound-AzureAD` — early Azure BloodHound prototype
- `DeviceToken` — device code / device-token primitives
- `PKINITtools` — Kerberos PKINIT abuse (cert → TGT)
- `krbrelayx` — Kerberos relaying
- `family-of-client-ids-research` — FOCI research
- `adconnectdump` — AAD Connect credential extraction
- `PrivExchange`, `odat`, `scepreq`, `roadtools_hybrid`, `selenium-wire-roadtx`, `entrascopes.com`, `microsoft-graph-docs`

### `dafthack\` — 303 .md files / 25 repos
Beau Bullock / Black Hills offensive tooling — operator-grade.
- `GraphRunner` — post-auth Graph abuse framework
- `MFASweep` — MFA enumeration across M365 endpoints
- `MSOLSpray` — Entra password spray
- `TeamFiltration` — full M365 account-takeover toolkit
- `MailSniper` — Exchange/M365 mailbox abuse
- `DomainPasswordSpray`, `Check-LocalAdminHash`, `HostRecon`
- `azure-ad-first-party-apps-permissions` — FOCI / first-party app ref
- `AzureADJoinedMachinePTC`, `m365_groups_enum`, `msportals.io`
- `Covenant`, `Empire`, `fireprox`, `cloud_enum`, `cloudgoat`
- `CloudPentestCheatsheets`, `ip2provider`, `lab_scripts`
- `pentest-machine`, `PowerMeta`, `PurpleCloud`, `zphisher`
- `blocksec-incidents`

### `NetSPI\` — 60 .md files / 31 repos
NetSPI cloud-resource-plane offensive tooling.
- `MicroBurst` — Azure resource-plane offensive PowerShell (IMDS variants, RunAs cert extraction, App Service abuse)
- `PowerUpSQL`, `MSSQLHound`, `SQLC2` — SQL Server offensive
- `PowerHuntShares`, `Snaffler` — credential discovery on shares
- `gcpwn` — GCP equivalent of MicroBurst
- `OCInferno`, `OCISigner`, `oci-lexer-parser` — Oracle Cloud
- `FuncoPop`, `ForceHound`, `PXEThief`, `ESC`
- `Burp-Extensions`, `BurpExtractor`, `httpillage`, `HTTPScrapers`
- `JavaSerialKiller`, `JavaUnserializeExploits`, `ysoserial`
- `BOF-PE`, `caldera`, `crossdomainscanner`, `CVE-2025-4660`
- `NetSIP`, `ruby-saml`, `ruler`, `tokenizer`
- `Strathweb.AspNetCore.AzureBlobFileProvider`, `brigade-security-scripts`

### `SpecterOps\` — 124 .md files / 14 repos
SpecterOps enumeration & graph tooling.
- `AzureHound` — Azure BloodHound collector (Go)
- `EntraSSSOHound` — Entra SSO collector
- `bloodhound-scim-extension` — SCIM enumeration
- `MSSQLHound`, `JamfHound`, `ConfigManBearPig`, `Janus`
- `Nemesis` — post-exploitation data pipeline
- `CredentialShuffle`, `DeepPass2`, `ghost_scout`
- `at-ps`, `TierZeroTable`, `og-docs-automation`

### `nccgroup\` — 184 .md files / 77 repos
NCC Group research arsenal (broadest, also includes non-cloud).
- Cloud: `ScoutSuite`, `azucar`, `sadcloud`, `PMapper`, `cowcloud`, `G-Scout`, `cloud_ip_ranges`, `opinel`, `AWS-recipes`, `GOATCasino`
- Kubernetes / container: `kubetcd`, `go-pillage-registries`, `dapr`, `house`
- Windows: `nccfsas` (SharpZeroLogon, Sigwhatever, Squeak, bof-vs-template, oab-parse, spoolsystem), `Berserko`, `redsnarf`, `WinShareEnum`, `WindowsDACLEnumProject`, `WindowsFirewallHookDriverEnumeration`, `WindowsMemPageDelta`, `Winstrument`, `SCOMDecrypt`, `WMIcmd`, `Change-Lockscreen`
- Exploit mitigations: `exploit_mitigations` (android/arm/chrome/dotnet/edge/firefox/freebsd/glibc/iphone/linux/office/openbsd/solaris/windows)
- Crypto: `cryptopals-py`, `featherduster`, `pairing`, `pasta-curves`, `formal_np1sec`, `HTTPSignatures`, `saml-idp`
- Web / HTTP: `ABPTTS`, `AutoRepeater`, `BurpSuiteHTTPSmuggler`, `CrossSiteContentHijacking`, `requests-racer`, `chuckle`, `http-mcp-bridge`, `Carnivore`, `WebFEET`
- Detection / forensics: `DetectWindowsCopyOnWriteForAPI`, `Cartographer`, `ImpossibleTravelLogAnalysis`, `SteppingStones`, `mimikatz-detector-busylight`
- Network / misc: `phantap`, `UPnP-Pentest-Toolkit`, `cisco-SNMP-enumeration`, `ssh_user_enum`, `jmxbf`, `nlahoney`, `nlist`, `listips`, `singularity`, `OutlookLeakTest`, `cachegrab`, `shocker`, `pybeacon`, `demiguise`, `Fenrir`, `fat-finger`, `GTFOBLookup`, `ConMachi`, `call_map`, `joern`, `VulnerableDotNetHTTPRemoting`, `proxmark3-amiimicyou`, `thingernet-graph`, `threat-modeling-templates`, `The_Automotive_Threat_Modeling_Template`, `xendbg`, `zipdefrag`, `manim-cranim`, `matt.net`, `CVE-2017-8759`

### `prowler-cloud\` — 282 .md files / 6 repos
Cloud security posture / defender tooling.
- `prowler` — multi-cloud security assessment (AWS, Azure, GCP, K8s, M365)
- `prowler-studio`, `prowler-permissions-templates-public`
- `cartography` — Lyft's graph-based asset inventory
- `py-iam-expand`, `py-ocsf-models`

### Total: 6,859 `.md` files across 172 repos, plus all source files.

### Quick-find pattern

```
# Find a tool by name across the corpus:
Glob: C:\Users\baimgprodsesa1\Desktop\New folder\**\<ToolName>*

# Find a technique across the corpus (e.g. PRT cookie):
Grep "primary refresh token" path="C:\Users\baimgprodsesa1\Desktop\New folder"

# Locate which playbook covers a topic:
Read C:\Users\baimgprodsesa1\Desktop\New folder\_AZURE_BYPASS_PLAYBOOK.md
```
