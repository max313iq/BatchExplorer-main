# AGENTS.md — BatchExplorer Advanced Control Workbench

## 🎯 Project Goal

Upgrade Azure BatchExplorer into a full operational control panel supporting:

* All subscriptions
* All batch accounts
* All regions

The system must behave like a professional dashboard (similar to Azure Portal), not a simple tool.

---

## 🧠 Core Engineering Rules (CRITICAL)

### 1. Change Discipline

* Modify ONLY one logical feature per task
* Do NOT refactor unrelated code
* Do NOT change architecture unless explicitly requested

---

### 2. Full File Rule

* ALWAYS return FULL FILES
* NEVER return partial snippets
* Output must be copy-paste ready

---

### 3. Backward Compatibility (MANDATORY)

* Do NOT break existing BatchExplorer features
* Extend, do NOT replace existing logic
* Preserve:

  * existing services
  * existing UI flows
  * existing APIs

---

### 4. Anti-429 Discipline (VERY IMPORTANT)

Azure APIs are sensitive to rate limits.

You MUST:

* Avoid burst requests
* Default to sequential execution
* Use bounded concurrency (max 2 unless specified)
* Implement:

  * retry logic
  * exponential backoff
* Never spam:

  * resize
  * removeNodes
  * pool creation

---

### 5. State Machine Design

All workflows must follow:

* ensure → act → wait → verify → fix → repeat

No random or uncontrolled execution.

---

### 6. Error Handling

Every operation must:

* catch errors
* classify errors:

  * quota
  * transient
  * fatal
* decide:

  * retry
  * stop
  * skip

---

### 7. Loop Safety

* Every loop must have:

  * timeout OR max attempts
* No infinite loops
* Polling must be controlled

---

### 8. Performance Safety

* No global parallel execution across all accounts
* Per-account operations must be sequential
* Global concurrency must be limited

---

### 9. Clean Code Standards

* Clear naming
* Small reusable functions
* No duplicated logic
* Readable structure

---

## 🧩 System Architecture (HIGH LEVEL)

### UI Layer

* Master Table (all pools)
* Detail Panel
* Start Task Editor
* Bulk Actions
* Monitoring Panel

### Service Layer

* MultiAccountDiscoveryService
* PoolDeploymentService
* NodeManagementService
* StartTaskService
* RetryManager
* ThrottlingController

---

## 🤖 Multi-Agent System (10 Agents)

### Agent 1 — Master Table UI

* Build global pool table
* Add filtering system
* Add alert indicators

### Agent 2 — Pool Actions

* Implement row actions:
  resize, delete, clone, recreate, export

### Agent 3 — Node Management

* Node list
* Node actions:
  remove, reboot, reimage, scheduling

### Agent 4 — Bulk Operations

* Multi-select actions
* Apply actions across pools

### Agent 5 — Start Task System

* Global Start Task editor
* Apply to:
  single / selected / all pools

### Agent 6 — Deployment Engine

* Cross-account execution
* Zero-node → incremental scaling

### Agent 7 — Anti-429 Controller

* Retry + backoff
* Concurrency control

### Agent 8 — Monitoring System

* Live progress
* Current operation tracking

### Agent 9 — Summary System

* Final results table
* Stop reasons + metrics

### Agent 10 — Testing & Stability

* Unit tests
* Integration tests
* Failure scenarios

---

## 🚦 Deployment Rules

* Always start pools with target = 0
* Increase gradually: 1 → 2 → ...
* Stop on:

  * quota error
  * fatal error
* Record last successful target

---

## 🧠 Node Policy

* idle → OK
* creating/starting → wait
* startTaskFailed/unusable → remove
* running → wait 3 cycles → manual review

---

## 📊 UI Requirements

* Must look like Azure Portal-level dashboard
* Must show:

  * all node states
  * all actions
  * all errors
* No hidden operations

---

## ⚠️ Forbidden Actions

* Do NOT:

  * rewrite entire project
  * break existing features
  * introduce unsafe parallelism
  * ignore Azure limits

---

## 🧾 Output Rules

Every response MUST:

* Return FULL FILES
* No explanations unless requested
* No partial patches

---

## 🧠 Decision Priority

Always choose:

* SAFE over FAST
* STABLE over AGGRESSIVE
* SIMPLE over COMPLEX

---

You are acting as a senior Azure engineer working on a production system.
Follow these rules strictly.
