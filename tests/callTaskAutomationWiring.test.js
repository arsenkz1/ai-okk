const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const worker = fs.readFileSync(path.join(__dirname, "../src/workers/callProcessor.ts"), "utf8");
const bot = fs.readFileSync(path.join(__dirname, "../src/bot/index.ts"), "utf8");

test("call worker starts operational analysis from the finished transcript in parallel and waits before acknowledging", () => {
  assert.match(worker, /const taskAutomationPromise = maybeRunCallTaskAutomation\(callId, transcriptText\);/);
  assert.match(worker, /const analysis = await analyzeCallWithGemini\(transcriptText,/);
  assert.match(worker, /callCreatedAt: call\.startedAt/);
  assert.match(worker, /await taskAutomationPromise;/);
});

test("Telegram bot registers durable call-task review callbacks", () => {
  assert.match(bot, /import \{ registerCallTaskReviewHandlers \} from "\.\/handlers\/callTaskReview";/);
  assert.match(bot, /registerCallTaskReviewHandlers\(bot\);/);
});
