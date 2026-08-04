# AI-derived amoCRM Task Automation Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** After a newly created lead's call has been transcribed, derive a safe next-step task proposal from the transcript and either create one amoCRM task plus note or request an administrator/ROP decision when timing is missing.

**Architecture:** Keep the existing coaching/scoring Gemini request unchanged. Add a separate Uzbek structured-action Gemini request that receives the already-persisted transcript and returns a validated `auto | review | none` decision. A durable action ledger and five durable test slots make queue retries and concurrent Telegram reviewer clicks safe; a dedicated guarded amoCRM task client does the fresh lead read → POST task → read-back sequence.

**Tech Stack:** Node.js, TypeScript, Prisma/PostgreSQL, BullMQ, Gemini, amoCRM v4 REST API, Telegram Bot API, `node:test`.

---

## Current gap vs requirements

- The call worker already transcribes a call, runs the scoring analysis, persists `CallAnalysis`, and writes a client-portrait note to amoCRM.
- There is no task-action prompt, no `POST /api/v4/tasks` client, no durable task/action audit, and no Telegram approval flow.
- `Deal` stores only pipeline/status/name locally, so current ownership and creation time must be read fresh from amoCRM before any mutation.
- Existing queue retries can replay a call; therefore a unique durable action keyed by `callId + actionKind` is mandatory.

## Source-backed requirements

1. Only process leads whose **amoCRM creation time is strictly after** a separately, durably initialized call-task activation boundary. Existing deals remain out of scope. Calls recorded before that boundary also remain out of scope.
2. Use a separate Gemini request over the transcript, not the existing coaching/scoring prompt.
3. Auto-create an amoCRM task only when the transcript proves both an explicit next action and an unambiguous date **and time**.
4. If the next action is explicit but timing is missing/ambiguous, persist a proposal and send it only to admins/active ROPs for approval.
5. Assign the current amoCRM lead owner; only if absent use the call manager's `amoUserId`; if neither exists, leave CRM unchanged.
6. After a confirmed task, add exactly one task-reason note to the lead. An ambiguous POST/read-back result is `uncertain` and must never be blindly retried. A timed-out task POST can be confirmed only when the bounded task-list read-back carries the deterministic `request_id`; a similar-looking manual task remains `uncertain`.
7. Testing mode uses real amoCRM tasks and notes, but is durably capped at exactly **five distinct eligible leads**. It is independent from normal-mode behavior and cannot be increased by environment value.
8. Testing mode reports each of its five analysis outcomes to reviewers so the operator can inspect the result.
9. No push, merge, deployment, production configuration change, or live amoCRM mutation is part of this implementation task.

## Requirements map

- [ ] Separate Uzbek action-analysis prompt and strict schema.
- [ ] New-lead activation boundary and disabled-by-default runtime configuration.
- [ ] Exact five-lead durable test capacity.
- [ ] Fresh read / owner fallback / task POST / read-back guarded client.
- [ ] Durable idempotency, reviewer CAS, and `uncertain` outcomes.
- [ ] Administrator + active ROP Telegram approval cards and custom Almaty date-time path.
- [ ] One confirmed CRM task reason-note, never after uncertain task creation.
- [ ] RED/GREEN unit regressions plus full build/test/migration parity checks.

## Definition of done

The feature is ready for a later test deployment only when all focused tests, the full suite, TypeScript build, Prisma validation, schema-to-migration diff, `git diff --check`, and independent spec/quality reviews pass. It remains disabled unless explicit runtime variables and a durable activation command are supplied. Production behavior is not claimed until an explicitly authorized deploy and an actual limited live test are completed.

## Safe activation and rollback reference

The implementation deliberately does **not** initialize itself at startup and has no default amoCRM write path. A later operator must apply the migration, then perform these separately auditable steps:

1. Run `AMOCRM_CALL_TASK_AUTOMATION_ACTIVATION_CONFIRM=initialize npm run call-task:activate`. This persists a single no-backfill boundary and the five immutable test slots.
2. Set `AMOCRM_CALL_TASK_AUTOMATION_ENABLED=true` and `AMOCRM_CALL_TASK_AUTOMATION_TESTING=true`.
3. Keep `AMOCRM_CALL_TASK_AUTOMATION_EXECUTION_MODE=dry_run` to inspect only analysis outcomes, or set it explicitly to `live` only for the intended five-lead real task/note test. It never defaults to `live`.
4. Review the five durable slot/action rows and the Telegram reviewer proposals. To stop future writes immediately, set `AMOCRM_CALL_TASK_AUTOMATION_ENABLED=false` and restart the service. Existing remote tasks are never rolled back automatically.
5. Only after a separate business decision may testing be changed to `false` for normal new-lead processing.

No migration, environment change, activation command, deploy, or amoCRM mutation was performed as part of this code implementation.

---

### Task 1: Add durable call-task action and five-slot schema

**Objective:** Store activation settings, one action per source call, and five test lead slots with DB-level uniqueness.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_call_task_automation/migration.sql`
- Test: `tests/callTaskAutomationSchema.test.js`

**Step 1: Write failing test**

Assert the schema/migration declares:
- unique `(callId, actionKind)` action identity;
- `approvalToken` unique;
- a `CallTaskAutomationTestSlot` relation with unique `dealId` and unique `actionId`;
- additive indexes for proposal and test-slot lookups;
- state checks allowing only `analyzing`, `proposed`, `creating_task`, `task_confirmed`, `creating_note`, `confirmed`, `rejected`, `skipped`, and `uncertain`.

**Step 2: Run test to verify failure**

Run: `npm run build && node --test tests/callTaskAutomationSchema.test.js`

Expected: FAIL because the schema and migration do not exist.

**Step 3: Add minimal schema and forward migration**

Create `CallTaskAutomationSetting`, `CallTaskAction`, and `CallTaskAutomationTestSlot`; add `Call.taskActions`. Use strings for workflow state, explicit SQL `CHECK`s, and no historical backfill.

**Step 4: Run focused test to verify pass**

Run: `npm run build && node --test tests/callTaskAutomationSchema.test.js`

Expected: PASS.

### Task 2: Implement policy, activation boundary, and fixed test-slot store

**Objective:** Make new-deal eligibility and five-lead capacity durable and retry-safe.

**Files:**
- Create: `src/services/callTaskAutomationStore.ts`
- Create: `src/services/callTaskAutomationPrismaPersistence.ts`
- Create: `src/services/callTaskAutomationActivation.ts`
- Create: `src/services/callTaskAutomationActivationRuntime.ts`
- Create: `src/scripts/initializeCallTaskAutomationActivation.ts`
- Modify: `package.json`
- Test: `tests/callTaskAutomationStore.test.js`
- Test: `tests/callTaskAutomationActivation.test.js`
- Test: `tests/callTaskAutomationPrismaPersistence.test.js`

**Step 1: Write failing tests**

Cover exact boundary initialization confirmation, lead creation strictly after the boundary, call-created-at boundary check, exact five-slot limit, same-deal dedupe, release only before any completed analysis, and test-slot uncertainty after an ambiguous remote mutation.

**Step 2: Run focused tests to verify failure**

Run: `npm run build && node --test tests/callTaskAutomationStore.test.js tests/callTaskAutomationActivation.test.js tests/callTaskAutomationPrismaPersistence.test.js`

Expected: FAIL because modules are missing.

**Step 3: Implement minimal durable store**

Expose a narrow persistence interface. Create a durable timestamp only with `AMOCRM_CALL_TASK_AUTOMATION_ACTIVATION_CONFIRM=initialize`; never infer one on first call. Fix `CALL_TASK_AUTOMATION_TEST_LIMIT = 5` in code and reject every other requested capacity. Use compare-and-set transitions, unique action identity, and serializable retry for slot reservation.

**Step 4: Run focused tests to verify pass**

Run the same focused command.

### Task 3: Add separate Uzbek action-analysis contract

**Objective:** Convert a transcript into a safe structured action proposal without changing coaching/scoring output.

**Files:**
- Modify: `src/services/aiAnalysis.ts`
- Test: `tests/callTaskActionAnalysis.test.js`

**Step 1: Write failing tests**

Test strict parsing for:
- explicit action + ISO deadline with time → `auto`;
- action with no time → `review`;
- refusal/vague statement → `none`;
- malformed JSON, invalid deadline, or untrusted transcript instruction → no actionable result.

**Step 2: Run focused test to verify failure**

Run: `npm run build && node --test tests/callTaskActionAnalysis.test.js`

Expected: FAIL because the parser/action contract is absent.

**Step 3: Implement minimal separate analyzer**

Use a dedicated Uzbek prompt via the existing Gemini request path. Include the current `Asia/Almaty` date-time, declare the transcript untrusted data, require JSON only, cap safe text/evidence lengths, and validate with Zod. Never invent a default date/time.

**Step 4: Run focused test to verify pass**

Run the same command.

### Task 4: Implement a guarded amoCRM task/note client

**Objective:** Isolate all external mutation semantics behind fresh reads and read-back confirmation.

**Files:**
- Create: `src/services/callTaskAmoClient.ts`
- Test: `tests/callTaskAmoClient.test.js`

**Step 1: Write failing tests**

Cover the official task route contract:
- fresh `GET /api/v4/leads/{id}` reads `created_at`, owner, and active state;
- task create is `POST /api/v4/tasks` with an array body containing `text`, Unix `complete_till`, `entity_id`, `entity_type: leads`, owner, task type, and deterministic `request_id`;
- individual `GET /api/v4/tasks/{id}` read-back confirms lead, owner, text, and deadline;
- 408/timeout/5xx/non-2xx/read-back failure returns sanitized `uncertain` and does not retry POST;
- task reason note is only attempted after task confirmation.

**Step 2: Run focused test to verify failure**

Run: `npm run build && node --test tests/callTaskAmoClient.test.js`

Expected: FAIL because the guarded client is absent.

**Step 3: Implement minimal client**

Validate amoCRM HTTPS origin before any Authorization header is sent. Use injected HTTP/clock/sleep for tests, bounded retry only for reads, no blind retry for POST, and no raw provider error propagation. Default standard amoCRM task type to `1` unless an explicit positive `AMOCRM_CALL_TASK_AUTOMATION_TASK_TYPE_ID` overrides it.

**Step 4: Run focused test to verify pass**

Run the same command.

### Task 5: Implement action orchestration and call-worker integration

**Objective:** Run the new analysis after transcript persistence, preserve the existing scoring flow, and create exactly one safe task/note/proposal.

**Files:**
- Create: `src/services/callTaskAutomation.ts`
- Modify: `src/workers/callProcessor.ts`
- Test: `tests/callTaskAutomation.test.js`

**Step 1: Write failing tests**

Test:
- disabled/no-boundary/old lead/pre-boundary call does not invoke task analysis or amoCRM mutation;
- fresh eligible lead receives the separate analysis;
- exact action+deadline creates one confirmed task then one note, with fresh owner fallback;
- action+missing time persists a proposal without task creation;
- no action persists a skipped result;
- duplicate worker delivery produces at most one task;
- ambiguous task or note outcome remains uncertain and is not retried;
- test mode has real task/note behavior but stops after five distinct eligible leads and reports test outcomes.

**Step 2: Run focused test to verify failure**

Run: `npm run build && node --test tests/callTaskAutomation.test.js`

Expected: FAIL because the orchestration path is absent.

**Step 3: Implement minimal orchestration**

Start the new action analysis only after a valid transcript and a fresh eligible lead check; run it independently from coaching score persistence. In normal mode process one action per eligible call. In test mode atomically reserve one of the five distinct lead slots before analysis, confirm the slot after a durable analysis outcome, and hold it uncertain after uncertain external mutation. Do not let task automation failure prevent the existing coaching analysis from completing.

**Step 4: Run focused test to verify pass**

Run the same command.

### Task 6: Add Telegram review cards and approved deadline creation

**Objective:** Let only admins/active ROPs approve a time-missing proposal safely.

**Files:**
- Create: `src/services/callTaskAutomationTelegram.ts`
- Create: `src/bot/handlers/callTaskAutomation.ts`
- Modify: `src/bot/index.ts`
- Test: `tests/callTaskAutomationTelegram.test.js`

**Step 1: Write failing tests**

Test reviewer identity resolution, unauthorized callback rejection, atomic `proposed → creating_task` claim for concurrent clicks, preset deadline conversion in `Asia/Almaty`, strict `/tasktime <token> YYYY-MM-DD HH:MM` parsing, rejection, and expired/already-completed card behavior.

**Step 2: Run focused test to verify failure**

Run: `npm run build && node --test tests/callTaskAutomationTelegram.test.js`

Expected: FAIL because handler/notifier modules are absent.

**Step 3: Implement minimal approval flow**

Send cards only to `BotAdmin`, `ADMIN_TELEGRAM_ID`, and active linked `ROP` managers. Use a short durable approval token in callback data, server-side authorization, one CAS winner, `Today 18:00`, `Tomorrow 10:00`, custom Almaty date-time, and reject actions. Reuse the same guarded task executor after approval.

**Step 4: Run focused test to verify pass**

Run the same command.

### Task 7: Wire runtime configuration and document safe activation

**Objective:** Keep the feature disabled by default and make test mode explicit/reversible.

**Files:**
- Modify: `src/index.ts`
- Modify: `.env.example` if present
- Test: `tests/callTaskAutomationRuntime.test.js`

**Step 1: Write failing tests**

Cover disabled default; exact `true|false` parsing for `AMOCRM_CALL_TASK_AUTOMATION_ENABLED` and `AMOCRM_CALL_TASK_AUTOMATION_TESTING`; activation initializer only with exact confirmation; no automatic backfill/boundary initialization; and test mode flags passed to the action service.

**Step 2: Run focused test to verify failure**

Run: `npm run build && node --test tests/callTaskAutomationRuntime.test.js`

Expected: FAIL because runtime configuration does not exist.

**Step 3: Implement minimal runtime wiring**

Initialize only on explicit activation confirmation. Add `npm run call-task-automation:activate`. Keep all feature flags absent/disabled by default and do not change deployed environment variables.

**Step 4: Run focused test to verify pass**

Run the same command.

### Task 8: Complete reviews and final local verification

**Objective:** Prove the exact final snapshot and preserve a clean, reviewable branch.

**Files:** All changed feature files and tests.

**Step 1: Run full local verification**

Run:

```bash
npm test
npx prisma validate
npx prisma migrate diff --from-schema /tmp/ai-okk-schema-before.prisma --to-schema prisma/schema.prisma --script
git diff --check
git status --short
```

**Step 2: Run spec-compliance review**

Dispatch a fresh reviewer against the frozen final diff. Fix every blocker and repeat review until PASS.

**Step 3: Run code-quality/security review**

Only after spec PASS, dispatch a fresh reviewer for concurrency, credential safety, retry semantics, and test coverage. Fix every important issue and repeat both reviews against the changed snapshot.

**Step 4: Commit only the verified feature**

Use an explicit file allowlist. Do not push, open a PR, merge, deploy, activate configuration, or execute live amoCRM calls.
