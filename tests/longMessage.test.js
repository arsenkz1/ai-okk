const test = require("node:test");
const assert = require("node:assert/strict");

const { splitTelegramMessage, sendLongMessage, TELEGRAM_MESSAGE_LIMIT } = require("../dist/bot/longMessage");

test("leaves a message that fits in one piece alone", () => {
  assert.deepEqual(splitTelegramMessage("short"), ["short"]);
  assert.deepEqual(splitTelegramMessage(""), []);
  assert.deepEqual(splitTelegramMessage("x".repeat(TELEGRAM_MESSAGE_LIMIT)).length, 1);
});

test("splits on line boundaries so a value is never cut in half", () => {
  const line = "a".repeat(100);
  const chunks = splitTelegramMessage(Array.from({ length: 60 }, () => line).join("\n"), 250);

  assert.equal(chunks.length > 1, true);
  for (const chunk of chunks) {
    assert.equal(chunk.length <= 250, true);
    for (const chunkLine of chunk.split("\n")) assert.equal(chunkLine, line);
  }
});

test("cuts a single over-long line, since it has no boundary to use", () => {
  const chunks = splitTelegramMessage("b".repeat(250), 100);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 50]);
});

test("keeps every character across the split", () => {
  const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
  const chunks = splitTelegramMessage(text, 60);
  assert.equal(chunks.join("\n"), text);
});

test("sends one Telegram message per chunk", async () => {
  const sent = [];
  await sendLongMessage(
    { async sendMessage(chatId, text) { sent.push({ chatId, text }); } },
    42,
    Array.from({ length: 500 }, () => "x".repeat(50)).join("\n"),
  );

  assert.equal(sent.length > 1, true);
  assert.equal(sent.every((message) => message.chatId === 42), true);
  assert.equal(sent.every((message) => message.text.length <= TELEGRAM_MESSAGE_LIMIT), true);
});
