# Inactivity Stage Priority Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** When several leads have reached the 72-hour inactivity deadline, move them to the trainee funnel in this business priority: **ОЖОП → Квалифицирован → Взято в работу**.

**Architecture:** Preserve all existing eligibility, 72-hour, fresh amoCRM read/history, lease, daily-capacity, and mutation-fence safeguards. Change only the selection order of already-due `watching` records. The worker will ask the store for each ordered group in turn, filling its existing maximum of five records per minute; within the same group the existing stable order remains oldest `dueAt`, then lowest `leadId`.

**Tech Stack:** TypeScript, Prisma, Node `node:test`, Railway source deployment.

---

## Current gap vs requested behavior

- Current `LeadInactivityPrismaPersistence.listDueWatchLeadIds` orders all due watches only by `dueAt ASC, leadId ASC`.
- The one-minute worker consumes the first five IDs, so a lower-priority stage can use the daily capacity before an eligible ОЖОП watch.
- The live policy contains exact source pairs in UZUM (`6909890`) and EXODE (`9055778`).
- No changes to source-stage eligibility or existing deadlines are required.

## Requirements map

- [ ] Priority group 1: ОЖОП in both UZUM and EXODE.
- [ ] Priority group 2: Квалифицирован in both UZUM and EXODE.
- [ ] Priority group 3: Взято в работу in both UZUM and EXODE.
- [ ] Inside each group, keep oldest due record first and deterministic `leadId` tie-break.
- [ ] Worker fills the existing five-per-minute cap across groups: lower group is requested only after higher group has no more due rows or has filled fewer than five.
- [ ] Fresh-read, history, stage validation, movement cap, leases, and idempotency remain unchanged.
- [ ] No schema migration and no rewriting/resetting persisted watches.

## Definition of done

- A RED test proves old global chronological selection would not meet the stage-priority requirement.
- Tests prove OZHOP fills capacity before qualified/taken records, qualified is next, and taken is last.
- Persistence forwards exact stage-pair filters and preserves ordering inside a priority group.
- TypeScript build and full test suite pass.
- Independent spec and quality review pass.
- Production deploy is verified at the intended source SHA; a read-only production check proves health and unchanged source-stage/watch safety state.

---

### Task 1: Specify ordered stage groups in the shared policy

**Objective:** Define one reusable source of truth for the requested business ordering without broadening allowed stages.

**Files:**
- Modify: `src/services/leadInactivityPolicy.ts`
- Test: `tests/leadInactivityPolicy.test.js`

**Step 1: Write failing test**

Assert the exported priority groups have exact pair ordering:

```js
assert.deepEqual(INACTIVITY_STAGE_PRIORITY_GROUPS, [
  [{ pipelineId: 6909890, statusId: 58160902 }, { pipelineId: 9055778, statusId: 72919958 }],
  [{ pipelineId: 6909890, statusId: 58160726 }, { pipelineId: 9055778, statusId: 72917586 }],
  [{ pipelineId: 6909890, statusId: 58160718 }, { pipelineId: 9055778, statusId: 72917582 }],
]);
```

**Step 2: Verify RED**

Run: `npm run build && node --test tests/leadInactivityPolicy.test.js`

Expected: FAIL because the new constant is not exported.

**Step 3: Implement minimal policy constant**

Add an immutable priority-group constant. Keep `ALLOWED_INACTIVITY_SOURCE_STAGES` as the six same pairs, derived from the group list or otherwise checked against it.

**Step 4: Verify GREEN**

Run: `npm run build && node --test tests/leadInactivityPolicy.test.js`

Expected: PASS.

### Task 2: Let the store request due watches for a stage group

**Objective:** Keep DB selection bounded and deterministic while allowing the worker to query exactly one priority group at a time.

**Files:**
- Modify: `src/services/leadInactivityStore.ts`
- Modify: `src/services/leadInactivityPrismaPersistence.ts`
- Test: `tests/leadInactivityPrismaPersistence.test.js`
- Test: `tests/leadInactivityStore.test.js`

**Step 1: Write failing tests**

Assert that a stage-pair filter is forwarded to Prisma as an exact `OR` filter together with `state='watching'` and `dueAt <= now`, and that the existing `dueAt ASC, leadId ASC` ordering remains. Also assert the store forwards the optional filter without changing default behavior.

**Step 2: Verify RED**

Run: `npm run build && node --test tests/leadInactivityPrismaPersistence.test.js tests/leadInactivityStore.test.js`

Expected: FAIL because `listDueWatchLeadIds` accepts only `(now, limit)`.

**Step 3: Implement minimal optional pair filter**

Add a typed optional `readonly` stage-pair parameter at persistence and store boundaries. It must be an exact `(pipelineId, statusId)` disjunction, not a pipeline-only filter. Leave calls that omit it behaviorally unchanged.

**Step 4: Verify GREEN**

Run: `npm run build && node --test tests/leadInactivityPrismaPersistence.test.js tests/leadInactivityStore.test.js`

Expected: PASS.

### Task 3: Select due work in priority order

**Objective:** Fill each worker pass from OZHOP, then qualified, then taken-in-work, without changing movement safety rules.

**Files:**
- Modify: `src/workers/leadInactivityWorker.ts`
- Test: `tests/leadInactivityWorker.test.js`

**Step 1: Write failing test**

Create due watches from all three groups where lower-priority watches are older. Assert that a five-record pass asks groups in OZHOP → qualified → taken order and claims only the highest-priority available records until capacity is filled. Add a second test proving qualified/taken are used only when prior groups do not fill capacity.

**Step 2: Verify RED**

Run: `npm run build && node --test tests/leadInactivityWorker.test.js`

Expected: FAIL because the current worker makes one global chronological query.

**Step 3: Implement minimal selection helper**

Before claims, query `INACTIVITY_STAGE_PRIORITY_GROUPS` sequentially with the remaining per-pass capacity. Do not sort in memory across arbitrary watches and do not alter claim, fresh-read, history, daily-capacity, PATCH, or audit logic.

**Step 4: Verify GREEN**

Run: `npm run build && node --test tests/leadInactivityWorker.test.js`

Expected: PASS.

### Task 4: Integration verification and release

**Objective:** Verify the complete change before source deployment.

**Files:**
- Verify: changed source/tests and this plan

**Step 1:** Run `npm run build`.

**Step 2:** Run `npm test`.

**Step 3:** Run `git diff --check` and inspect scoped diff.

**Step 4:** Obtain independent spec-compliance review, then independent quality review; remediate every blocker and repeat the affected review.

**Step 5:** Commit the verified implementation. Push to `master` and wait for Railway source deployment only after checks/review pass.

**Step 6:** Verify active Railway deployment SHA/status, `/health`, and read-only stage-group/watch/audit aggregates. Do not reset existing timers or force customer movements merely to demonstrate the new priority.
