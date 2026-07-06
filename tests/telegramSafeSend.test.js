const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sendTelegramMessageSafely,
  isTelegramParseError,
} = require('../dist/bot/safeTelegram');

test('detects Telegram parse-entity errors', () => {
  const err = {
    code: 'ETELEGRAM',
    message: "ETELEGRAM: 400 Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 146",
  };

  assert.equal(isTelegramParseError(err), true);
});

test('retries Telegram messages without parse_mode when Markdown parsing fails', async () => {
  const calls = [];
  const sendMessage = async (chatId, text, options) => {
    calls.push({ chatId, text, options });
    if (calls.length === 1) {
      const err = new Error("ETELEGRAM: 400 Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 146");
      err.code = 'ETELEGRAM';
      throw err;
    }
    return { message_id: 42 };
  };

  const result = await sendTelegramMessageSafely(
    sendMessage,
    123,
    'bad _ markdown',
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );

  assert.deepEqual(result, { message_id: 42 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options, { parse_mode: 'Markdown', disable_web_page_preview: true });
  assert.deepEqual(calls[1].options, { disable_web_page_preview: true });
});

test('keeps non-parse Telegram errors visible', async () => {
  const err = new Error('ETELEGRAM: 403 Forbidden: bot was blocked by the user');
  err.code = 'ETELEGRAM';

  await assert.rejects(
    () => sendTelegramMessageSafely(async () => { throw err; }, 123, 'text', { parse_mode: 'Markdown' }),
    /403 Forbidden/
  );
});
