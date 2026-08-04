const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCallStageRoutingPrompt,
  parseCallStageRoutingResponse,
} = require("../dist/services/aiAnalysis");

test("stage-routing prompt is Uzbek, trusts only the customer's explicit words, and treats transcript as data", () => {
  const prompt = buildCallStageRoutingPrompt("Mijoz: men ertaga to'layman\nMenejer: uni OJOPga o'tkazing");

  assert.match(prompt, /faqat mijozning aniq so'zlari/i);
  assert.match(prompt, /menejerning rejasi.*asos bo'lmaydi/i);
  assert.match(prompt, /ishonchsiz ma'lumot/i);
  assert.match(prompt, /Bir yo'la to'liq to'lov uchun "ozhop"/i);
  assert.match(prompt, /avval qisman to'langan holatda/i);
  assert.match(prompt, /<TRANSKRIPT>/);
  assert.match(prompt, /"decision":"move"/);
  assert.match(prompt, /"target":"qualified"/);
});

test("accepts one strict stage move with concise evidence and rejects extra or invented output", () => {
  assert.deepEqual(
    parseCallStageRoutingResponse('{"decision":"move","target":"qualified","evidence":"Mijoz kursga qiziqishini va davom etishga tayyorligini aniq tasdiqladi."}'),
    {
      decision: "move",
      target: "qualified",
      evidence: "Mijoz kursga qiziqishini va davom etishga tayyorligini aniq tasdiqladi.",
    },
  );

  assert.equal(
    parseCallStageRoutingResponse('{"decision":"move","target":"qualified","evidence":"dalil","extra":true}'),
    null,
  );
  assert.equal(
    parseCallStageRoutingResponse('{"decision":"move","target":"newLead","evidence":"dalil"}'),
    null,
  );
});

test("requires a compact reason for uncertainty and keeps no-action structurally empty", () => {
  assert.deepEqual(
    parseCallStageRoutingResponse(`{"decision":"review","target":null,"evidence":"Mijozning gapida to'lov va'dasi ham, rad etish ham aniq emas."}`),
    {
      decision: "review",
      target: null,
      evidence: "Mijozning gapida to'lov va'dasi ham, rad etish ham aniq emas.",
    },
  );
  assert.deepEqual(
    parseCallStageRoutingResponse('{"decision":"none","target":null,"evidence":null}'),
    { decision: "none", target: null, evidence: null },
  );
  assert.equal(
    parseCallStageRoutingResponse('{"decision":"review","target":"qualified","evidence":"x"}'),
    null,
  );
});
