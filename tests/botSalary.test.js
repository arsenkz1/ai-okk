const test = require("node:test");
const assert = require("node:assert/strict");

require("../dist/bot/actions");
const fakeRegistrar = { onText: () => {}, on: () => {} };
require("../dist/bot/handlers/performance").registerPerformanceHandlers(fakeRegistrar);
require("../dist/bot/handlers/adminRoles").registerAdminRoleHandlers(fakeRegistrar);
require("../dist/bot/handlers/rop").registerRopHandlers(fakeRegistrar);
require("../dist/bot/handlers/teamlead").registerTeamLeadHandlers(fakeRegistrar);
require("../dist/bot/handlers/callTaskReview").registerCallTaskReviewHandlers(fakeRegistrar);

const registry = require("../dist/bot/actions/registry");
const salary = require("../dist/bot/actions/salary");
const inputs = require("../dist/bot/inputHandlers");
const pendingModule = require("../dist/bot/pendingInput");
const { sectionKeyboard } = require("../dist/bot/keyboards/menuCallbacks");
const { rolesOf } = require("../dist/bot/access");

const access = (isAdmin, manager) => ({ telegramUserId: "7", isAdmin, manager, roles: rolesOf(isAdmin, manager) });
const active = (role) => ({ role, isActive: true, id: 7, teamId: 3 });

const rows = new Map();
const pending = pendingModule.createPendingInputService({
  async get(key) { return rows.get(key) ?? null; }, async set(key, value) { rows.set(key, value); }, async del(key) { rows.delete(key); },
}, () => 1_000_000);

function fakeBot() {
  const sent = [];
  return { sent, bot: { sendMessage: async (chatId, text, options) => { sent.push({ text, options }); } } };
}
const msgOf = (text) => ({ chat: { id: 5 }, from: { id: 7 }, text });

test("the calculator is offered to sales managers and administrators; leads and ROPs are told why", async () => {
  const reports = registry.SECTIONS.find((s) => s.id === "reports");
  const has = async (a) => (await sectionKeyboard(a, reports, 7)).inline_keyboard.flat().some((b) => b.callback_data === "m:salary");
  assert.equal(await has(access(false, active("MANAGER"))), true);
  assert.equal(await has(access(true, null)), true);
  assert.equal(await has(access(true, active("ROP"))), true, "an admin keeps the simulator whatever their link says");
  assert.equal(await has(access(false, active("TEAMLEAD"))), false);
  assert.equal(await has(access(false, active("ROP"))), false);

  const { sent, bot } = fakeBot();
  await registry.getAction("salary").run({ bot, chatId: 5, userId: 7, telegramUserId: "7", access: access(false, active("ROP")), args: [], source: "command", pending });
  assert.equal(sent.at(-1).text, salary.CALCULATOR_FOR_MANAGERS_TEXT);

  // An administrator never reads a stored rate: the simulator asks for one.
  let rateReads = 0;
  salary.configureSalary({ getRate: async () => { rateReads += 1; return 2500000; } });
  const admin = fakeBot();
  await registry.getAction("salary").run({ bot: admin.bot, chatId: 5, userId: 9, telegramUserId: "9", access: access(true, null), args: [], source: "button", pending });
  assert.equal(admin.sent.at(-1).text, salary.RATE_SELF_PROMPT);
  assert.equal(rateReads, 0);
  await pending.cancel(9);
});

test("with a stored rate the chain starts at the days; without one the manager types a rate first", async () => {
  const run = async (rate, args = []) => {
    salary.configureSalary({ getRate: async () => rate });
    const { sent, bot } = fakeBot();
    await registry.getAction("salary").run({ bot, chatId: 5, userId: 7, telegramUserId: "7", access: access(false, active("MANAGER")), args, source: "callback", pending });
    return sent;
  };
  assert.equal((await run(2500000)).at(-1).text, salary.DAYS_PROMPT);
  assert.deepEqual((await pending.lookup(7)).input.payload, { rate: 2500000, storedRate: true });

  const sent = await run(null);
  assert.equal(sent.at(-1).text, salary.RATE_SELF_PROMPT);
  assert.equal((await pending.lookup(7)).input.kind, "salary_rate");
  const { sent: typedSent, bot } = fakeBot();
  await inputs.handlePendingInput(bot, msgOf("abc"), await pending.lookup(7), pending);
  assert.equal(typedSent.at(-1).text, salary.RATE_SELF_ERROR_TEXT);
  await inputs.handlePendingInput(bot, msgOf("3 000 000"), await pending.lookup(7), pending);
  assert.equal(typedSent.at(-1).text, salary.DAYS_PROMPT);
  assert.deepEqual((await pending.lookup(7)).input.payload, { rate: 3000000, storedRate: false });
  await pending.cancel(7);
});

test("'another fact' re-asks only the fact with the packed rate, days and plan", async () => {
  salary.configureSalary({ getRate: async () => 2500000 });
  const { sent, bot } = fakeBot();
  await registry.getAction("salary").run({ bot, chatId: 5, userId: 7, telegramUserId: "7", access: access(false, active("MANAGER")), args: registry.getAction("salary").decodeArg("2500000_4_30000000"), source: "callback", pending });
  assert.equal(sent.at(-1).text, salary.FACT_PROMPT);
  assert.deepEqual((await pending.lookup(7)).input.payload, { rate: 2500000, days: 4, plan: 30000000, storedRate: true });
  await pending.cancel(7);
});

test("three typed answers lead to the sheet's figure; wrong answers keep the question open", async () => {
  const { sent, bot } = fakeBot();
  // Start the chain the way the action does once the rate is known.
  await pending.expect(7, "salary_days", { rate: 2500000, storedRate: true });
  const typed = async (text) => inputs.handlePendingInput(bot, msgOf(text), await pending.lookup(7), pending);

  await typed("40");
  assert.equal(sent.at(-1).text, salary.DAYS_ERROR_TEXT);
  await typed("4");
  assert.equal(sent.at(-1).text, salary.PLAN_PROMPT);
  assert.equal((await pending.lookup(7)).input.kind, "salary_plan");

  await typed("ko'p");
  assert.equal(sent.at(-1).text, salary.PLAN_ERROR_TEXT);
  await typed("30 000 000");
  assert.equal(sent.at(-1).text, salary.FACT_PROMPT);

  await typed("-5");
  assert.equal(sent.at(-1).text, salary.FACT_ERROR_TEXT);
  await typed("25041000");
  const result = sent.at(-1);
  assert.equal(result.options.parse_mode, "HTML");
  assert.ok(result.text.includes("<b>Jami: 1 136 000</b>"), result.text);
  assert.ok(result.text.includes("Fakt: 25 041 000 (83%)"));
  assert.ok(result.text.includes("Bonus: 3% = 751 230"));
  assert.ok(result.text.includes("Stavka: 2 500 000 (saqlangan)"));
  assert.deepEqual(result.options.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["m:salary:2500000_4_30000000", "m:salary"]);
  assert.deepEqual(await pending.lookup(7), { state: "none" });
});

test("a zero fact is accepted and gives the base salary only", async () => {
  const { sent, bot } = fakeBot();
  await pending.expect(8, "salary_fact", { rate: 2500000, days: 1, plan: 15000000, storedRate: false });
  await inputs.handlePendingInput(bot, { chat: { id: 5 }, from: { id: 8 }, text: "0" }, await pending.lookup(8), pending);
  assert.ok(sent.at(-1).text.includes("<b>Jami: 58 000</b>"));
  assert.ok(sent.at(-1).text.includes("Bonus: 0% = 0"));
  assert.ok(sent.at(-1).text.includes("(siz kiritgan)"));
});

test("the rate commands exist for admins and team leads with the right scope", () => {
  const setRate = registry.getAction("set_rate");
  const teamRate = registry.getAction("team_rate");
  assert.deepEqual(setRate.roles, ["admin"]);
  assert.deepEqual(teamRate.roles, ["teamlead"]);
  assert.deepEqual(setRate.command.pattern.exec("/set_rate 12695650 2 500 000").slice(1), ["12695650", "2 500 000"]);
  assert.deepEqual(teamRate.command.pattern.exec("/team_rate 12695650 2500000").slice(1), ["12695650", "2500000"]);
  assert.equal(typeof setRate.collect, "function");
  assert.equal(typeof teamRate.collect, "function");
  assert.equal(inputs.hasInputHandler("rate_amount"), true);
});

test("parsers: worked days are 1–31 integers, the fact may be zero", () => {
  assert.deepEqual(["1", " 31 ", "0", "32", "4.5", "abc"].map(salary.parseWorkedDays), [1, 31, null, null, null, null]);
  assert.deepEqual(["0", "25 041 000", "25'041'000", "-1", "x"].map(salary.parseFactAmount), [0, 25041000, 25041000, null, null]);
});
