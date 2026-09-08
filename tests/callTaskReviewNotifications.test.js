const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCallTaskProposalKeyboard,
  buildCallTaskProposalText,
  parseCallTaskReviewCallback,
  listCallTaskReviewerIds,
  isCallTaskReviewer,
} = require("../dist/bot/callTaskReviewNotifications");

const action = {
  id: "action-1",
  approvalToken: "AbCdEfGhIjKlMnOp",
  dealId: 123,
  taskText: "Klientga kurs dasturini yuborish",
  evidence: "Menejer dastur yuborishga kelishdi, lekin vaqt aytilmadi",
};

test("proposal notification shows only operational evidence and compact callback identifiers", () => {
  const text = buildCallTaskProposalText(action, "https://qadamsales.amocrm.ru");
  assert.match(text, /Сделка: #123/);
  assert.match(text, /Действие: Klientga kurs dasturini yuborish/);
  assert.match(text, /Основание:/);
  assert.doesNotMatch(text, /transcript/i);

  const keyboard = buildCallTaskProposalKeyboard(action.approvalToken);
  const callbacks = keyboard.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(callbacks, [
    "cta:AbCdEfGhIjKlMnOp:today_18",
    "cta:AbCdEfGhIjKlMnOp:tomorrow_10",
    "cta:AbCdEfGhIjKlMnOp:custom",
    "cta:AbCdEfGhIjKlMnOp:reject",
  ]);
  assert.equal(callbacks.every((value) => value.length <= 64), true);
});

test("only known signed-shape call-task callback payloads are accepted", () => {
  assert.deepEqual(parseCallTaskReviewCallback("cta:AbCdEfGhIjKlMnOp:today_18"), {
    approvalToken: "AbCdEfGhIjKlMnOp",
    command: "today_18",
  });
  assert.equal(parseCallTaskReviewCallback("cta:bad:today_18"), null);
  assert.equal(parseCallTaskReviewCallback("cta:AbCdEfGhIjKlMnOp:delete_everything"), null);
});

// A database that would have supplied extra recipients under the old rule.
const noisyDatabase = {
  botAdmin: {
    async findMany() { return [{ telegramUserId: "222" }, { telegramUserId: "333" }]; },
    async findUnique({ where }) {
      return ["222", "333"].includes(where.telegramUserId) ? { telegramUserId: where.telegramUserId } : null;
    },
  },
  telegramLink: {
    async findMany() { return [{ telegramUserId: "444" }]; },
    async findFirst() { return { telegramUserId: "444" }; },
  },
};

test("sends approval cards and test results to ADMIN_TELEGRAM_ID only", async () => {
  const previous = process.env.ADMIN_TELEGRAM_ID;
  process.env.ADMIN_TELEGRAM_ID = "111";
  try {
    // Other administrators and ROPs are no longer notified.
    assert.deepEqual(await listCallTaskReviewerIds(noisyDatabase), ["111"]);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_TELEGRAM_ID;
    else process.env.ADMIN_TELEGRAM_ID = previous;
  }
});

test("sends nothing rather than to everyone when no admin id is configured", async () => {
  const previous = process.env.ADMIN_TELEGRAM_ID;
  delete process.env.ADMIN_TELEGRAM_ID;
  try {
    assert.deepEqual(await listCallTaskReviewerIds(noisyDatabase), []);
  } finally {
    if (previous !== undefined) process.env.ADMIN_TELEGRAM_ID = previous;
  }
});

test("still lets an admin or ROP act on a card they were handed", async () => {
  const previous = process.env.ADMIN_TELEGRAM_ID;
  process.env.ADMIN_TELEGRAM_ID = "111";
  try {
    // Narrowing who is notified must not revoke anyone's right to approve.
    assert.equal(await isCallTaskReviewer("111", noisyDatabase), true);
    assert.equal(await isCallTaskReviewer("222", noisyDatabase), true);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_TELEGRAM_ID;
    else process.env.ADMIN_TELEGRAM_ID = previous;
  }
});
