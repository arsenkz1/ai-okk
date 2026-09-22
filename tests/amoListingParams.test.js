const test = require("node:test");
const assert = require("node:assert/strict");

const {
  leadStatusChangesIntoParams,
  leadsByIdsParams,
  leadsClosedInRangeParams,
  pipelineStageRefs,
  toLeadFact,
  toLeadStatusChange,
} = require("../dist/services/amoListingParams");

const range = { from: new Date("2026-09-20T19:00:00Z"), to: new Date("2026-09-21T19:00:00Z") };
const FROM = String(Math.floor(range.from.getTime() / 1000));
const TO = String(Math.floor(range.to.getTime() / 1000));

test("closed_at range is sent as unix seconds under the documented filter names", () => {
  const params = leadsClosedInRangeParams(range);
  assert.equal(params.get("filter[closed_at][from]"), FROM);
  assert.equal(params.get("filter[closed_at][to]"), TO);
});

test("stage-change events are filtered by type, range and every target stage", () => {
  const params = leadStatusChangesIntoParams(
    [{ pipelineId: 9055770, statusId: 72917546 }, { pipelineId: 9055770, statusId: 142 }],
    range,
  );
  assert.equal(params.get("filter[entity]"), "lead");
  assert.equal(params.get("filter[type]"), "lead_status_changed");
  assert.equal(params.get("filter[created_at][from]"), FROM);
  assert.equal(params.get("filter[created_at][to]"), TO);
  assert.equal(params.get("filter[value_after][leads_statuses][0][pipeline_id]"), "9055770");
  assert.equal(params.get("filter[value_after][leads_statuses][0][status_id]"), "72917546");
  assert.equal(params.get("filter[value_after][leads_statuses][1][status_id]"), "142");
});

test("ids are repeated under one array key", () => {
  assert.deepEqual(leadsByIdsParams([5, 7]).getAll("filter[id][]"), ["5", "7"]);
});

test("a lead row becomes a fact with dates and a nullable close", () => {
  const fact = toLeadFact({
    id: "26199367", name: "Test", pipeline_id: 6909890, status_id: 142, price: 1500000,
    responsible_user_id: 12695650, updated_at: 1790400000, closed_at: 1790400100,
  });
  assert.equal(fact.id, 26199367);
  assert.equal(fact.responsibleUserId, 12695650);
  assert.equal(fact.closedAt.getTime(), 1790400100 * 1000);
  assert.equal(toLeadFact({ id: 1, pipeline_id: 2, status_id: 3, updated_at: 1, closed_at: 0 }).closedAt, null);
  assert.equal(toLeadFact({ id: "x" }), null);
});

test("a status-change event keeps the previous and the new stage", () => {
  const event = toLeadStatusChange({
    entity_id: 42, created_at: 1790400000,
    value_before: [{ lead_status: { id: 58160902, pipeline_id: 6909890 } }],
    value_after: [{ lead_status: { id: 72917546, pipeline_id: 9055770 } }],
  });
  assert.deepEqual(event.before, { pipelineId: 6909890, statusId: 58160902 });
  assert.deepEqual(event.after, { pipelineId: 9055770, statusId: 72917546 });
  assert.equal(toLeadStatusChange({ entity_id: 42, created_at: 1 }).before, null);
  assert.equal(toLeadStatusChange({ created_at: 1 }), null);
});

test("pipeline payload yields one stage ref per status", () => {
  const refs = pipelineStageRefs({ id: 9055770, _embedded: { statuses: [{ id: 72917546 }, { id: 142 }, { id: "bad" }] } });
  assert.deepEqual(refs, [{ pipelineId: 9055770, statusId: 72917546 }, { pipelineId: 9055770, statusId: 142 }]);
  assert.deepEqual(pipelineStageRefs(null), []);
});
