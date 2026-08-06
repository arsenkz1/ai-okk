const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPrismaCallStageAutomationLedgerPersistence,
} = require("../dist/services/callStageAutomationPrismaPersistence");

function actionRecord() {
  return {
    id: "stage-action-1",
    callId: 101,
    dealId: 202,
    testMode: true,
    status: "moving",
    decision: "move",
    target: "qualified",
    evidence: "Клиент подтвердил квалификацию.",
    checkedFields: null,
    missingFields: null,
    amoNoteId: null,
    failureReason: null,
    analysisLeaseToken: null,
    analysisLeaseExpiresAt: null,
    analysisLeaseGeneration: 1,
    mutationLeaseToken: "move-lease",
    createdAt: new Date("2026-08-06T06:00:00.000Z"),
    updatedAt: new Date("2026-08-06T06:00:00.000Z"),
  };
}

test("confirms a history-fence action and its reserved slot inside one serializable transaction", async () => {
  const now = new Date("2026-08-06T06:45:00.000Z");
  let action = actionRecord();
  let slot = { slotNumber: 4, state: "reserved", actionId: action.id, confirmedAt: null, leaseExpiresAt: new Date("2026-08-06T06:50:00.000Z") };
  let transactionCalls = 0;
  const database = {
    async $transaction(operation, options) {
      transactionCalls += 1;
      assert.equal(options.isolationLevel, "Serializable");
      return operation(database);
    },
    callStageAction: {
      async updateMany({ where, data }) {
        assert.deepEqual(where, { id: action.id, status: "moving", mutationLeaseToken: "move-lease" });
        action = { ...action, ...data, updatedAt: now };
        return { count: 1 };
      },
      async findUnique({ where }) {
        assert.equal(where.id, action.id);
        return action;
      },
    },
    callStageAutomationTestSlot: {
      async updateMany({ where, data }) {
        assert.deepEqual(where, { state: "reserved", actionId: action.id });
        slot = { ...slot, ...data };
        return { count: 1 };
      },
    },
  };

  const persistence = createPrismaCallStageAutomationLedgerPersistence(database);
  const confirmed = await persistence.markMoveConfirmed(
    action.id,
    "move-lease",
    ["Поле заполнено"],
    99,
    now,
    true,
  );

  assert.equal(transactionCalls, 1);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.amoNoteId, 99);
  assert.equal(slot.state, "confirmed");
  assert.equal(slot.confirmedAt, now);
  assert.equal(slot.leaseExpiresAt, null);
});
