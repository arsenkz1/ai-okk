const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCallTaskProposalKeyboard,
  buildCallTaskProposalText,
  parseCallTaskReviewCallback,
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
