const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const worker = fs.readFileSync(path.join(__dirname, "../src/workers/callProcessor.ts"), "utf8");

test("call worker invokes the independent UZUM stage router only after a finished transcript and waits before ack", () => {
  assert.match(worker, /import \{ runCallStageAutomation \} from "\.\.\/services\/callStageAutomation";/);
  assert.match(worker, /import \{ getCallStageAutomationRuntime \} from "\.\.\/services\/callStageAutomationRuntime";/);
  assert.match(worker, /async function maybeRunCallStageAutomation\(callId: number, transcript: string\)/);
  assert.match(worker, /const stageAutomationPromise = maybeRunCallStageAutomation\(callId, transcriptText\);/);
  assert.match(worker, /callEndedAt: call\.endedAt/);
  assert.match(worker, /await taskAutomationPromise;/);
  assert.match(worker, /await stageAutomationPromise;/);
});

test("stage-router failures are contained and cannot retry-storm the completed-call worker", () => {
  const functionBlock = worker.match(/async function maybeRunCallStageAutomation[\s\S]*?\n}\n\nasync function processCallJob/);
  assert.ok(functionBlock, "stage automation helper should be isolated before processCallJob");
  assert.match(functionBlock[0], /try \{/);
  assert.match(functionBlock[0], /catch \(error\)/);
  assert.match(functionBlock[0], /\[CallStageAutomation\] Call stage processing failed/);
});
