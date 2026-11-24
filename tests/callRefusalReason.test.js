const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  REFUSAL_REASON_FIELD_ID,
  REFUSAL_REASON_FIELD_CACHE_MS,
  CALL_REFUSAL_REASON_OPTIONS,
  CALL_REFUSAL_REASONS_FROM_CALL,
  readRefusalPrediction,
  planRefusalReasonWrite,
  createRefusalReasonWriter,
  isRefusalReasonWriteEnabled,
  getRefusalReasonWriter,
} = require("../dist/services/callRefusalReason");
const { createCallStageAmoClient } = require("../dist/services/callStageAmoClient");

const AMO_REASONS = [
  "Yosh filtri bo'yicha o'tmadi",
  "Uydigilari ruxsat bermadi",
  "Boshqasini tanladi",
  "Qiziqishi yo'qoldi",
  "Bunga mos keladigan kurs yo'q",
  "Xizmatlarimiz to'g'ri kelmadi",
  "Дубликат / тест",
  "Qimmat",
  "Bemaqsad",
  "Keyinroq o'qimoqchi",
  "Konsultatsiyadan keyin 3 martta NDZ",
  "Noto'g'ri raqam",
  "Bog'lanib bo'lmadi",
  "Bo'lib to'lashda rad etildi",
  "Boshqa sabab",
  "Filtr boyicha otmadi",
];

function selectField(reasons = AMO_REASONS) {
  return {
    id: REFUSAL_REASON_FIELD_ID,
    name: "Причина отказа",
    type: "select",
    enums: reasons.map((value, index) => ({ id: 900 + index, value, sort: index + 1 })),
  };
}

function lead({ statusId = 58160726, fieldValues = new Map() } = {}) {
  return {
    id: 42,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    pipelineId: 6909890,
    statusId,
    responsibleUserId: 7,
    name: "Lead",
    fieldValues,
  };
}

test("writes into field 1046167 and keeps the business's close-reason list verbatim", () => {
  assert.equal(REFUSAL_REASON_FIELD_ID, 1046167);
  assert.deepEqual(CALL_REFUSAL_REASON_OPTIONS.map((option) => option.reason), AMO_REASONS);
});

test("never offers the model reasons a single conversation cannot show", () => {
  for (const reason of ["Дубликат / тест", "Konsultatsiyadan keyin 3 martta NDZ", "Bog'lanib bo'lmadi"]) {
    assert.equal(CALL_REFUSAL_REASONS_FROM_CALL.includes(reason), false, reason);
  }
  assert.equal(CALL_REFUSAL_REASONS_FROM_CALL.length, AMO_REASONS.length - 3);
});

test("maps the model's answer onto an offered reason, quote marks and case ignored", () => {
  assert.deepEqual(readRefusalPrediction({ refusalLikely: false, refusalReason: "Qimmat" }), { kind: "none" });
  assert.deepEqual(
    readRefusalPrediction({ refusalLikely: true, refusalReason: "Qiziqishi yoqoldi" }),
    { kind: "reason", reason: "Qiziqishi yo'qoldi" },
  );
  assert.deepEqual(
    readRefusalPrediction({ refusalLikely: true, refusalReason: "  qimmat. " }),
    { kind: "reason", reason: "Qimmat" },
  );
  assert.deepEqual(
    readRefusalPrediction({ refusalLikely: true, refusalReason: "Keyinroq o‘qimoqchi" }),
    { kind: "reason", reason: "Keyinroq o'qimoqchi" },
  );
  // The two filter reasons stay distinct.
  assert.deepEqual(
    readRefusalPrediction({ refusalLikely: true, refusalReason: "Filtr boyicha otmadi" }),
    { kind: "reason", reason: "Filtr boyicha otmadi" },
  );
  assert.deepEqual(
    readRefusalPrediction({ refusalLikely: true, refusalReason: "Yosh filtri boyicha otmadi" }),
    { kind: "reason", reason: "Yosh filtri bo'yicha o'tmadi" },
  );
});

test("rejects invented, empty, and non-offered reasons instead of guessing", () => {
  assert.equal(readRefusalPrediction({ refusalLikely: true, refusalReason: "" }).kind, "unmatched");
  assert.equal(readRefusalPrediction({ refusalLikely: true, refusalReason: "Vaqti yoq" }).kind, "unmatched");
  assert.equal(readRefusalPrediction({ refusalLikely: true, refusalReason: "Дубликат / тест" }).kind, "unmatched");
});

test("plans an enum write for the select field and never creates an option", () => {
  const plan = planRefusalReasonWrite({ reason: "Qimmat", field: selectField(), lead: lead() });
  assert.deepEqual(plan, { kind: "write", value: { fieldId: 1046167, enumId: 907, value: "Qimmat" } });

  const missing = planRefusalReasonWrite({
    reason: "Qimmat",
    field: selectField(AMO_REASONS.filter((reason) => reason !== "Qimmat")),
    lead: lead(),
  });
  assert.deepEqual(missing, { kind: "skip", reason: "option_missing" });
});

test("leaves closed deals alone: there the field holds the manager's real reason", () => {
  for (const statusId of [142, 143]) {
    assert.deepEqual(
      planRefusalReasonWrite({ reason: "Qimmat", field: selectField(), lead: lead({ statusId }) }),
      { kind: "skip", reason: "lead_closed" },
    );
  }
});

test("skips a write when the same reason is already stored, and replaces a different one", () => {
  const same = lead({ fieldValues: new Map([[1046167, ["Qimmat"]]]) });
  assert.deepEqual(
    planRefusalReasonWrite({ reason: "Qimmat", field: selectField(), lead: same }),
    { kind: "skip", reason: "already_set" },
  );
  const other = lead({ fieldValues: new Map([[1046167, ["Bemaqsad"]]]) });
  assert.equal(planRefusalReasonWrite({ reason: "Qimmat", field: selectField(), lead: other }).kind, "write");
});

test("writes plain text into a text field and refuses unsupported field types", () => {
  const textField = { id: 1046167, name: "Причина", type: "text", enums: [] };
  assert.deepEqual(
    planRefusalReasonWrite({ reason: "Qimmat", field: textField, lead: lead() }),
    { kind: "write", value: { fieldId: 1046167, enumId: null, value: "Qimmat" } },
  );
  assert.deepEqual(
    planRefusalReasonWrite({ reason: "Qimmat", field: { ...textField, type: "date" }, lead: lead() }),
    { kind: "skip", reason: "unsupported_field_type" },
  );
});

function fakeAmo({ field = selectField(), current = lead(), writeOutcome } = {}) {
  const calls = [];
  return {
    calls,
    amo: {
      async getLeadCustomField(fieldId) {
        calls.push(["field", fieldId]);
        return field;
      },
      async readLead(leadId) {
        calls.push(["lead", leadId]);
        return current;
      },
      async writeLeadFields(input) {
        calls.push(["write", input]);
        return writeOutcome ?? { kind: "confirmed", lead: current };
      },
    },
  };
}

test("touches amoCRM only for a likely refusal from the deal's latest call", async () => {
  const { calls, amo } = fakeAmo();
  const write = createRefusalReasonWriter({ amo });
  const latest = async () => true;

  assert.deepEqual(
    await write({ dealId: 42, refusalLikely: false, refusalReason: "", isLatestCall: latest }),
    { kind: "no_refusal" },
  );
  assert.equal((await write({ dealId: 42, refusalLikely: true, refusalReason: "Vaqti yoq", isLatestCall: latest })).kind, "unmatched");
  assert.deepEqual(
    await write({ dealId: 42, refusalLikely: true, refusalReason: "Qimmat", isLatestCall: async () => false }),
    { kind: "not_latest_call" },
  );
  assert.deepEqual(calls, []);

  assert.deepEqual(
    await write({ dealId: 42, refusalLikely: true, refusalReason: "Qimmat", isLatestCall: latest }),
    { kind: "written", value: "Qimmat" },
  );
  assert.deepEqual(calls, [
    ["field", 1046167],
    ["lead", 42],
    ["write", { leadId: 42, values: [{ fieldId: 1046167, enumId: 907, value: "Qimmat" }] }],
  ]);
});

test("reads the field's options once per cache window", async () => {
  let clock = 1_000;
  const { calls, amo } = fakeAmo();
  const write = createRefusalReasonWriter({ amo, now: () => clock });
  const input = { dealId: 42, refusalLikely: true, refusalReason: "Qimmat", isLatestCall: async () => true };

  await write(input);
  await write(input);
  assert.equal(calls.filter(([kind]) => kind === "field").length, 1);
  clock += REFUSAL_REASON_FIELD_CACHE_MS + 1;
  await write(input);
  assert.equal(calls.filter(([kind]) => kind === "field").length, 2);
});

test("reports a rejected or unconfirmed write without claiming success", async () => {
  const input = { dealId: 42, refusalLikely: true, refusalReason: "Qimmat", isLatestCall: async () => true };
  const rejected = fakeAmo({ writeOutcome: { kind: "not_written", reason: "patch_rejected", lead: null } });
  assert.deepEqual(await createRefusalReasonWriter({ amo: rejected.amo })(input), { kind: "not_written", reason: "patch_rejected" });
  const uncertain = fakeAmo({ writeOutcome: { kind: "uncertain", error: { kind: "network", status: null, code: null, message: "x" } } });
  assert.deepEqual(await createRefusalReasonWriter({ amo: uncertain.amo })(input), { kind: "uncertain" });
});

test("is on by default and can be switched off by env", async () => {
  assert.equal(isRefusalReasonWriteEnabled({}), true);
  assert.equal(isRefusalReasonWriteEnabled({ CALL_REFUSAL_REASON_ENABLED: "true" }), true);
  for (const off of ["false", "0", "no", "OFF"]) {
    assert.equal(isRefusalReasonWriteEnabled({ CALL_REFUSAL_REASON_ENABLED: off }), false, off);
  }
  const credentials = { AMOCRM_BASE_URL: "https://tenant.amocrm.ru", AMOCRM_ACCESS_TOKEN: "token" };
  assert.equal(await getRefusalReasonWriter({ ...credentials, CALL_REFUSAL_REASON_ENABLED: "false" }), null);
  assert.equal(await getRefusalReasonWriter({}), null);
});

test("amoCRM client reads one lead field's type and options", async () => {
  const requests = [];
  const client = createCallStageAmoClient({
    baseUrl: "https://tenant.amocrm.ru",
    accessToken: "test-token",
    globalRateLimiter: { async waitForRequestSlot() {} },
    http: {
      async request(request) {
        requests.push(request);
        return {
          status: 200,
          data: { id: 1046167, name: "Причина отказа", type: "select", enums: [{ id: 5, value: "Qimmat", sort: 1 }] },
        };
      },
    },
  });

  assert.deepEqual(await client.getLeadCustomField(1046167), {
    id: 1046167,
    name: "Причина отказа",
    type: "select",
    enums: [{ id: 5, value: "Qimmat", sort: 1 }],
  });
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].url, "https://tenant.amocrm.ru/api/v4/leads/custom_fields/1046167");
});

test("call analysis asks for the refusal forecast and the worker writes it after the notes", () => {
  const analysis = fs.readFileSync(path.join(__dirname, "../src/services/aiAnalysis.ts"), "utf8");
  assert.match(analysis, /"refusalLikely": <true или false>/);
  assert.match(analysis, /"refusalReason": "<причина из списка или пустая строка>"/);
  assert.match(analysis, /\$\{REFUSAL_REASON_PROMPT_LIST\}/);
  // The manual JSON extractor reads clientPortrait up to the last quote, so it stays the last key.
  assert.match(analysis, /"refusalReason": [^\n]*\n\s*"clientPortrait"/);

  const worker = fs.readFileSync(path.join(__dirname, "../src/workers/callProcessor.ts"), "utf8");
  const notes = worker.indexOf('writeDealNote(dealId, recommendations, "рекомендации AI"');
  const refusal = worker.indexOf("await maybeWriteRefusalReason(callId, dealId, callTimes.endedAt, analysis)");
  assert.ok(notes > 0 && refusal > notes);
});
