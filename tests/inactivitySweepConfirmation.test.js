const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createSweepConfirmationService,
  parseSweepCallback,
  buildSweepCallback,
  buildSweepKeyboard,
  formatSweepProposal,
  formatSweepDecision,
  SWEEP_CONFIRMATION_TTL_MS,
} = require("../dist/services/inactivitySweepConfirmation");

const now = new Date("2026-09-16T05:00:00.000Z");
// 5 days idle: inside the 3–7 day sweep band.
const idle = (id) => ({ id, createdAt: now, updatedAt: new Date(now.getTime() - 120 * 3600 * 1000), pipelineId: 6909890, statusId: 58160726, responsibleUserId: 1, name: null });

function service(overrides = {}) {
  const moved = [];
  let clock = now;
  const svc = createSweepConfirmationService({
    listEligibleLeads: async () => [idle(1), idle(2)],
    moveLeadToTarget: async (leadId) => { moved.push(leadId); return { kind: "confirmed", lead: {} }; },
    now: () => clock,
    randomToken: () => "tok_ABCDEFGHIJKLMNOP",
    ...overrides,
  });
  return { svc, moved, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

test("proposes a sweep with the frozen candidate list and a token", async () => {
  const { svc } = service();
  const started = await svc.start("111");
  assert.equal(started.kind, "pending");
  assert.equal(started.pending.candidates.length, 2);
  assert.equal(started.pending.requestedBy, "111");
  assert.equal(started.scanned, 2);
});

test("says so when nothing is idle instead of offering an empty sweep", async () => {
  const { svc } = service({ listEligibleLeads: async () => [] });
  assert.deepEqual(await svc.start("111"), { kind: "nothing_to_move", scanned: 0 });
});

test("yes from the requester moves the candidates exactly once", async () => {
  const { svc, moved } = service();
  const { pending } = await svc.start("111");

  const first = await svc.decide(pending.token, "yes", "111");
  assert.equal(first.kind, "swept");
  assert.equal(first.result.moved, 2);
  assert.deepEqual(moved, [1, 2]);

  // A double tap or retried callback must not run it again.
  assert.deepEqual(await svc.decide(pending.token, "yes", "111"), { kind: "unknown" });
  assert.deepEqual(moved, [1, 2]);
});

test("no spends the token without moving anything", async () => {
  const { svc, moved } = service();
  const { pending } = await svc.start("111");
  assert.deepEqual(await svc.decide(pending.token, "no", "111"), { kind: "declined", candidates: 2 });
  assert.deepEqual(moved, []);
  assert.deepEqual(await svc.decide(pending.token, "yes", "111"), { kind: "unknown" });
});

test("only the operator who asked may answer, and the token survives a wrong click", async () => {
  const { svc, moved } = service();
  const { pending } = await svc.start("111");
  assert.deepEqual(await svc.decide(pending.token, "yes", "222"), { kind: "wrong_user" });
  assert.deepEqual(moved, []);
  // The rightful operator can still confirm afterwards.
  assert.equal((await svc.decide(pending.token, "yes", "111")).kind, "swept");
});

test("a proposal expires after ten minutes", async () => {
  const { svc, moved, advance } = service();
  const { pending } = await svc.start("111");
  advance(SWEEP_CONFIRMATION_TTL_MS + 1);
  assert.deepEqual(await svc.decide(pending.token, "yes", "111"), { kind: "expired" });
  assert.deepEqual(moved, []);
});

test("the candidate list is frozen at proposal time", async () => {
  let leads = [idle(1)];
  const { svc, moved } = service({ listEligibleLeads: async () => leads });
  const { pending } = await svc.start("111");
  leads = [idle(1), idle(2), idle(3)];  // amoCRM changed after the operator saw "1"
  await svc.decide(pending.token, "yes", "111");
  assert.deepEqual(moved, [1], "what was confirmed is what moved");
});

test("callback data round-trips and rejects anything else", () => {
  const data = buildSweepCallback("tok_ABCDEFGHIJKLMNOP", "yes");
  assert.deepEqual(parseSweepCallback(data), { token: "tok_ABCDEFGHIJKLMNOP", decision: "yes" });
  assert.equal(parseSweepCallback("cta:tok_ABCDEFGHIJKLMNOP:yes"), null);
  assert.equal(parseSweepCallback("phx:short:yes"), null);
  assert.equal(parseSweepCallback("phx:tok_ABCDEFGHIJKLMNOP:maybe"), null);
  assert.equal(parseSweepCallback(undefined), null);
  assert.equal(buildSweepKeyboard("tok_ABCDEFGHIJKLMNOP").inline_keyboard[0].length, 2);
});

test("the proposal names the count per pipeline and who may answer", () => {
  const text = formatSweepProposal({
    token: "t", requestedBy: "111", createdAt: now,
    candidates: [
      { leadId: 1, pipelineId: 6909890, statusId: 1, lastTouchedAt: now },
      { leadId: 2, pipelineId: 9055778, statusId: 1, lastTouchedAt: now },
      { leadId: 3, pipelineId: 6909890, statusId: 1, lastTouchedAt: now },
    ],
  }, 40);
  assert.equal(text.includes("Найдено лидов без касаний 3 дня и дольше: 3"), true);
  assert.equal(text.includes("7 дней"), false, "there is no upper bound any more");
  assert.equal(text.includes("перепроверяется по истории"), true);
  assert.equal(text.includes("• UZUM: 2"), true);
  assert.equal(text.includes("• EXODE: 1"), true);
  assert.equal(text.includes("только тот, кто отправил команду"), true);
  // The deals are named so they can be inspected before anything moves.
  assert.equal(text.includes("#1 — 0.0 · UZUM"), true);
  assert.equal(text.includes("/inactivity_lead <ID>"), true);
});

test("a long list is capped in the card and says how many were left out", () => {
  const candidates = Array.from({ length: 20 }, (_, i) => ({ leadId: i + 1, pipelineId: 6909890, statusId: 1, lastTouchedAt: now }));
  const text = formatSweepProposal({ token: "t", requestedBy: "1", createdAt: now, candidates }, 100);
  assert.equal(text.split("\n").filter((line) => line.startsWith("#")).length, 15);
  assert.equal(text.includes("… и ещё 5"), true);
});

test("the outcome message accounts for every candidate", () => {
  const text = formatSweepDecision({
    kind: "swept", candidates: 10,
    result: { moved: 6, notMoved: 1, uncertain: 1, skippedRecentTouch: 2, guardFailed: 0, movedCandidates: [], stoppedAt: { index: 8, reason: "uncertain" } },
  });
  assert.equal(text.includes("было касание за последние 3 дня: 2"), true);
  assert.equal(text.includes("ежедневная сверка в 22:00"), true);
  assert.equal(text.includes("6 из 10"), true);
  assert.equal(text.includes("лид изменился"), true);
  assert.equal(text.includes("не обработано: 2"), true);
  assert.equal(text.includes("без суточного лимита"), true);
  assert.equal(formatSweepDecision({ kind: "wrong_user" }).includes("только тот"), true);
  const declined = formatSweepDecision({ kind: "declined", candidates: 4 });
  assert.equal(declined.includes("4 лидов не тронуты"), true);
  // "No" is not a reprieve: the nightly sweep takes them anyway, and says so.
  assert.equal(declined.includes("сверка в 22:00 — она перенесёт их сама"), true);
});
