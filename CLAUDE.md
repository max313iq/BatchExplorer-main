# Project rules

## HARD RULE — No installs, no outside packages, no models, no network fetches without explicit permission

This repository is **source-only, no dependencies installed**. The
directory name itself encodes this:
`AzureBatchManager-source-only-no-deps-20260525\`. There is no
`node_modules\`, no virtualenv, no installed runtime — only the
WebUI source code.

**Forbidden actions (until I explicitly say otherwise, per task):**

- `npm install`, `npm i`, `npm ci`, `npm add`, `npm update`,
  `npm exec`, `npx <anything>`, `yarn`, `yarn add`, `pnpm`,
  `pnpm install`, `pnpm add`, `bun install`, `bun add`.
- `pip install`, `pip3 install`, `python -m pip install`,
  `poetry add`, `uv add`, `uv pip install`, `conda install`,
  `mamba install`, `apt install`, `apt-get install`,
  `choco install`, `winget install`, `scoop install`,
  `brew install`.
- `cargo add`, `cargo install`, `go get`, `go install`,
  `dotnet add package`, `dotnet tool install`,
  `gem install`, `bundle install`,
  `nuget install`, `Install-Package`, `Install-Module`,
  `docker pull`, `docker run` of an uncached image.
- Downloading or fetching models / weights / checkpoints from
  HuggingFace, Ollama (`ollama pull`, `ollama run` of a not-yet-pulled
  model), OpenAI, Anthropic, Replicate, civitai, gguf mirrors, etc.
- Any tool or CLI invocation whose **side effect** is to fetch and
  install a remote package, model, container, or binary into the
  system (this includes auto-install on first run, e.g. `tsc` if it
  triggers package resolution).
- Modifying `package.json`, `package-lock.json`, `pnpm-lock.yaml`,
  `yarn.lock`, `requirements.txt`, `pyproject.toml`,
  `poetry.lock`, `Cargo.toml`, `go.mod`, `*.csproj`, `Gemfile`, or
  any lockfile in a way that adds a new dependency. Editing the
  source code to *use* a package that isn't already declared is
  also forbidden — if the import resolves only through a new
  install, do not write it.

**Allowed (read-only by default — NO free editing):**

- Reading existing `package.json` / lockfiles to learn what is
  already declared.
- Running read-only or analysis commands that do not install
  anything (`npm ls`, `npm view`, `tsc --noEmit` only if the
  toolchain is already present on PATH and does not trigger
  install).
- Static analysis: Read, Glob, Grep over the source.

**Editing is NOT a freedom — it is per-task and per-instruction.**

- I do **not** have blanket permission to edit source files just
  because a package is declared in `package.json`. Declared-but-
  uninstalled packages are usable in code I write **only when the
  user has asked for that specific change**.
- No proactive refactors. No "improve while I'm here." No
  drive-by import additions, even if the imported package is
  declared. No reformatting, no renaming, no dead-code removal,
  no comment clean-up unless the current task explicitly says so.
- Every edited line must trace directly to a user instruction in
  the current task. If a tempting improvement is adjacent, mention
  it — do not do it.
- Sub-agents inherit the same no-freedom constraint: their prompts
  must scope edits to the exact files and exact change requested.

**Sub-agents inherit this rule.** Every dispatched agent must be
told: *"You may not install, fetch, pull, or add any package,
model, image, or binary. This is a source-only repo. If a task
seems to require a new dependency, stop and report — do not
install."*

**If a task truly needs a new package or model:** stop, explain
what is needed, why, and the alternatives — then wait for me to
explicitly approve. Never install first and ask later.

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
