const test = require("node:test");
const assert = require("node:assert/strict");

const {
  planFieldAutofill,
  buildFieldFillRequests,
  autofillKindForType,
  AUTOFILL_VALUE_MAX_LENGTH,
} = require("../dist/services/callStageFieldAutofill");

function field(overrides = {}) {
  return { id: 10, name: "Kurs", type: "text", enums: [], requiredStatuses: [], ...overrides };
}

function fieldsById(...fields) {
  return new Map(fields.map((item) => [item.id, item]));
}

test("classifies amoCRM field types into text, select, or unsupported", () => {
  for (const type of ["text", "textarea", "url", "numeric", "price", "monetary"]) {
    assert.equal(autofillKindForType(type), "text");
  }
  for (const type of ["select", "radiobutton", "multiselect"]) {
    assert.equal(autofillKindForType(type), "select");
  }
  assert.equal(autofillKindForType("SELECT"), "select");
  // A file, date, or unreadable type must never be guessed at.
  for (const type of ["date", "checkbox", "file", "birthday", "legal_entity", ""]) {
    assert.equal(autofillKindForType(type), null);
  }
});

test("gives the model each field's options so it can reuse one", () => {
  const requests = buildFieldFillRequests(
    [{ id: 10, name: "Kurs" }, { id: 11, name: "Jinsi" }],
    fieldsById(
      field({ id: 10, type: "text" }),
      field({ id: 11, name: "Jinsi", type: "select", enums: [{ id: 1, value: "Erkak", sort: 1 }, { id: 2, value: "Ayol", sort: 2 }] }),
    ),
  );

  assert.deepEqual(requests, [
    { id: 10, name: "Kurs", kind: "text" },
    { id: 11, name: "Jinsi", kind: "select", options: ["Erkak", "Ayol"] },
  ]);
});

test("never asks the model for a field whose value is a fixed business rule", () => {
  const requests = buildFieldFillRequests(
    [{ id: 12, name: "Sdelkani dubl bormi", requiredValue: "Yoq" }],
    fieldsById(field({ id: 12, type: "select", enums: [{ id: 3, value: "Yoq", sort: 1 }] })),
  );
  assert.deepEqual(requests, []);
});

test("writes model text into a text field and keeps the grounded flag", () => {
  const plan = planFieldAutofill({
    missingFields: [{ id: 10, name: "Kurs" }],
    fieldsById: fieldsById(field({ id: 10, type: "text" })),
    modelValues: [{ id: 10, value: "Uzum marketplace", grounded: true }],
  });

  assert.equal(plan.kind, "ready");
  assert.deepEqual(plan.entries, [{
    fieldId: 10,
    fieldName: "Kurs",
    kind: "text",
    value: "Uzum marketplace",
    enumId: null,
    needsNewOption: false,
    grounded: true,
  }]);
});

test("reuses an existing option and keeps amoCRM's own spelling", () => {
  const plan = planFieldAutofill({
    missingFields: [{ id: 11, name: "Jinsi" }],
    fieldsById: fieldsById(field({ id: 11, name: "Jinsi", type: "select", enums: [{ id: 2, value: "Ayol", sort: 1 }] })),
    // Different case and spacing must still match the existing option.
    modelValues: [{ id: 11, value: "  ayol  ", grounded: true }],
  });

  assert.equal(plan.kind, "ready");
  assert.deepEqual(plan.entries[0], {
    fieldId: 11,
    fieldName: "Jinsi",
    kind: "select",
    value: "Ayol",
    enumId: 2,
    needsNewOption: false,
    grounded: true,
  });
});

test("marks a select value for option creation when nothing matches", () => {
  const plan = planFieldAutofill({
    missingFields: [{ id: 11, name: "Region" }],
    fieldsById: fieldsById(field({ id: 11, name: "Region", type: "select", enums: [{ id: 2, value: "Toshkent", sort: 1 }] })),
    modelValues: [{ id: 11, value: "Samarqand", grounded: true }],
  });

  assert.equal(plan.kind, "ready");
  assert.equal(plan.entries[0].needsNewOption, true);
  assert.equal(plan.entries[0].enumId, null);
  assert.equal(plan.entries[0].value, "Samarqand");
});

test("carries an ungrounded value through so the admin log can flag it", () => {
  const plan = planFieldAutofill({
    missingFields: [{ id: 10, name: "Yoshi" }],
    fieldsById: fieldsById(field({ id: 10, name: "Yoshi", type: "numeric" })),
    modelValues: [{ id: 10, value: "30", grounded: false }],
  });

  assert.equal(plan.entries[0].grounded, false);
});

test("treats a missing grounded flag as an assumption, never as evidence", () => {
  const plan = planFieldAutofill({
    missingFields: [{ id: 10, name: "Yoshi" }],
    fieldsById: fieldsById(field({ id: 10, name: "Yoshi", type: "text" })),
    modelValues: [],
  });

  assert.equal(plan.kind, "incomplete");
  assert.deepEqual(plan.unfillable, [{ fieldId: 10, fieldName: "Yoshi", reason: "no_model_value" }]);
});

test("applies a fixed business value without consulting the model", () => {
  const plan = planFieldAutofill({
    missingFields: [{ id: 12, name: "Sdelkani dubl bormi", requiredValue: "Yoq" }],
    fieldsById: fieldsById(field({ id: 12, type: "select", enums: [{ id: 3, value: "Yoq", sort: 1 }] })),
    modelValues: [{ id: 12, value: "Ha", grounded: true }],
  });

  assert.equal(plan.kind, "ready");
  assert.deepEqual(plan.entries[0], {
    fieldId: 12,
    fieldName: "Sdelkani dubl bormi",
    kind: "select",
    value: "Yoq",
    enumId: 3,
    needsNewOption: false,
    grounded: true,
  });
});

test("refuses to invent the option a business fence depends on", () => {
  const plan = planFieldAutofill({
    missingFields: [{ id: 12, name: "Sdelkani dubl bormi", requiredValue: "Yoq" }],
    fieldsById: fieldsById(field({ id: 12, type: "select", enums: [{ id: 3, value: "Ha", sort: 1 }] })),
    modelValues: [],
  });

  assert.equal(plan.kind, "incomplete");
  assert.deepEqual(plan.unfillable, [
    { fieldId: 12, fieldName: "Sdelkani dubl bormi", reason: "required_value_option_missing" },
  ]);
});

test("reports unsupported and unknown fields instead of guessing", () => {
  const plan = planFieldAutofill({
    missingFields: [{ id: 10, name: "Tug'ilgan kun" }, { id: 99, name: "Yo'q maydon" }],
    fieldsById: fieldsById(field({ id: 10, name: "Tug'ilgan kun", type: "date" })),
    modelValues: [{ id: 10, value: "01.01.2000", grounded: true }, { id: 99, value: "x", grounded: true }],
  });

  assert.equal(plan.kind, "incomplete");
  assert.deepEqual(plan.unfillable, [
    { fieldId: 10, fieldName: "Tug'ilgan kun", reason: "unsupported_type" },
    { fieldId: 99, fieldName: "Yo'q maydon", reason: "unknown_field" },
  ]);
});

test("stays incomplete when even one blocking field cannot be filled", () => {
  const plan = planFieldAutofill({
    missingFields: [{ id: 10, name: "Kurs" }, { id: 13, name: "Sana" }],
    fieldsById: fieldsById(field({ id: 10, type: "text" }), field({ id: 13, name: "Sana", type: "date" })),
    modelValues: [{ id: 10, value: "Uzum", grounded: true }],
  });

  // A partial write would leave invented values behind and still not unblock.
  assert.equal(plan.kind, "incomplete");
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.unfillable.length, 1);
});

test("normalizes whitespace and caps an over-long model value", () => {
  const plan = planFieldAutofill({
    missingFields: [{ id: 10, name: "Maqsad" }],
    fieldsById: fieldsById(field({ id: 10, name: "Maqsad", type: "textarea" })),
    modelValues: [{ id: 10, value: `  ko'p\n\n  qatorli   matn ${"x".repeat(400)}  `, grounded: true }],
  });

  assert.equal(plan.entries[0].value.length, AUTOFILL_VALUE_MAX_LENGTH);
  assert.equal(plan.entries[0].value.startsWith("ko'p qatorli matn x"), true);
});

test("plans nothing when there is nothing blocking the move", () => {
  const plan = planFieldAutofill({ missingFields: [], fieldsById: new Map(), modelValues: [] });
  assert.deepEqual(plan, { kind: "ready", entries: [] });
});
