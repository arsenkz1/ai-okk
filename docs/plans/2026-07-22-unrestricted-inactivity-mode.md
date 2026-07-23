# Unrestricted 72-hour Inactivity Mode Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Safely replace the five-slot test mode with unrestricted inactivity movement after 72 hours, while establishing a one-time 72-hour baseline for every currently eligible source-stage lead.

**Architecture:** Keep `TESTING_LEADS_MOVEMENT=true` as the existing capacity-limited test path. Make `false` an explicit unrestricted production path that requires exactly 72 hours: the worker retains claims, fresh amoCRM reads, durable audits, final pre-PATCH stage fencing, and admin notification, but bypasses all test-slot operations. A guarded one-time baseline command first supports a no-write dry run, then atomically claims a single durable run before listing or enrolling any lead. Its completion marker is bound to that run and keeps the unrestricted worker blocked until all rows are enrolled; a completed run is a no-op on repeat, while a partial run remains blocked for manual investigation. Every enrolled lead uses the same timestamp plus 72 hours as its first deadline.

**Tech Stack:** TypeScript, Node test runner, Prisma/PostgreSQL, amoCRM v4 API, Railway.

## Current gap

- The current runtime throws if `TESTING_LEADS_MOVEMENT` is not exactly `true`, so simply disabling it would stop the worker.
- The worker always reserves/consumes `LeadInactivityTestSlot` capacity.
- Event intake deliberately excludes leads created before the original activation boundary; a controlled backfill must bypass that rule without weakening normal webhook safety.
- Changing the delay environment variable does not rewrite existing persisted `dueAt` rows.

## Requirements map

- [x] Preserve the six-stage UZUM/EXODE allowlist and final amoCRM stage check.
- [x] Preserve fresh amoCRM history validation before every movement.
- [x] Preserve all-admin notification only after a durable confirmed movement.
- [x] Allow an explicit `TESTING_LEADS_MOVEMENT=false` production worker mode with no slots/cap and strict 72-hour configuration.
- [x] Add a durable baseline-completion gate before any unrestricted worker pass.
- [x] Set the production-mode delay contract to 72 hours.
- [x] Provide a no-write dry run and a confirmed baseline for all currently eligible leads at rollout time.
- [x] Keep a restart/retry of the baseline idempotent.

## Tasks

### Task 1: Test explicit operating-mode parsing and runtime wiring

**Files:**
- Modify: `tests/leadInactivityWorkerRuntime.test.js`
- Modify: `src/services/leadInactivityWorkerRuntime.ts`

1. Add RED tests: explicit `true` starts testing mode, explicit `false` starts unrestricted mode, missing/malformed setting fails closed.
2. Run the focused test and observe failure.
3. Add one mode parser and pass its boolean into the production worker constructor.
4. Re-run the focused test green.

### Task 2: Test unrestricted worker movements without slot APIs

**Files:**
- Modify: `tests/leadInactivityWorker.test.js`
- Modify: `src/workers/leadInactivityWorker.ts`

1. Add RED tests proving an unrestricted confirmed move does not call slot creation/reservation/confirmation/release, persists a confirmed audit with null slot, and sends a non-test notification.
2. Add RED tests proving an uncertain unrestricted move does not make any testing capacity reusable.
3. Run focused worker tests and observe RED.
4. Add `testingMode` to the worker options, defaulting to test behavior for compatibility; branch only the capacity lifecycle and notification copy.
5. Re-run focused tests green.

### Task 3: Test controlled, idempotent production baseline storage

**Files:**
- Modify: `tests/leadInactivityStore.test.js`
- Modify: `src/services/leadInactivityStore.ts`

1. Add RED tests proving baseline can enroll a lead created before the normal activation boundary, sets `lastActivityAt=baselineAt` and `dueAt=baselineAt+72h`, and does not replace a newer real activity watch.
2. Add RED test proving the baseline timestamp is created once and reused on retry.
3. Run the focused store tests and observe RED.
4. Implement explicit production-baseline methods; preserve normal webhook boundary logic unchanged.
5. Re-run focused store tests green.

### Task 4: Test and implement paginated amoCRM allowed-stage discovery

**Files:**
- Modify: `tests/leadInactivityAmoClient.test.js`
- Modify: `src/services/leadInactivityAmoClient.ts`

1. Add RED tests for six allowed `(pipeline,status)` filters, normalization, pagination, deduplication, and rejection of an API response outside the allowlist.
2. Run the focused client tests and observe RED.
3. Implement safe rate-limited GET pagination using the existing amoCRM client request path.
4. Re-run focused client tests green.

### Task 5: Add the guarded baseline command

**Files:**
- Create: `src/services/leadInactivityProductionBaseline.ts`
- Create: `src/scripts/baselineLeadInactivityEligibleLeads.ts`
- Modify: `package.json`
- Create/modify tests for the production-baseline service

1. Add RED tests for refusal unless the exact baseline confirmation, unrestricted mode, and worker-disabled guard are present.
2. Add RED test that uses one durable timestamp and records every returned eligible lead through the explicit baseline store operation.
3. Implement the orchestrator and script; print counts/timestamps only, never credentials or contact data.
4. Run focused tests green.

### Task 6: Full verification and safe production rollout

1. Run `npm run build`, targeted tests, `npm test`, and `git diff --check`.
2. Independently review the diff for policy bypasses, slot/cap regressions, and baseline idempotency.
3. Commit and push only the reviewed change.
4. In the current deployment, set `AMOCRM_INACTIVITY_WORKER_ENABLED=false` and verify that no movement pass runs.
5. Deploy the reviewed code while the worker is still disabled, then set `AMOCRM_INACTIVITY_DELAY_HOURS=72` and `TESTING_LEADS_MOVEMENT=false` (worker remains disabled).
6. Verify health/config and run `lead-inactivity:baseline` in its default no-write dry-run mode; inspect only the discovered count and source-stage scope.
7. Run the confirmed baseline once with `LEAD_INACTIVITY_PRODUCTION_BASELINE_DRY_RUN=false` and the exact confirmation; read back the durable completion marker and sampled `dueAt = baseline + 72h` values.
8. Re-enable the worker, restart/deploy, verify health/config/logs, then confirm no eligible baseline watch is due before the 72-hour window.

## Definition of done

- Production worker runs with `TESTING_LEADS_MOVEMENT=false` and no test-slot dependency.
- New qualifying activity and every baselined eligible lead receive an individual 72-hour deadline.
- No pre-existing eligible lead moves immediately at rollout.
- The six-stage filter, fresh-history guard, durable audit, final PATCH fence, and post-confirmation admin notification remain active.
- Build, focused tests, full tests, diff check, code review, push, deploy, baseline read-back, health, and runtime configuration are all verified.
