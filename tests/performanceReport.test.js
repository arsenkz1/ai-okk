const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatMoney,
  formatTalkTime,
  planPercent,
  formatCallSection,
  formatRevenueSection,
  formatPlanSection,
  formatManagerPerformance,
  formatTeamPerformance,
  aggregateTeamPerformance,
  emptyCallVolumeSection,
  emptyRevenueSection,
} = require("../dist/services/performanceReport");

function calls(overrides = {}) {
  return { ...emptyCallVolumeSection(), total: 40, connected: 25, missed: 15, talkSeconds: 7200, analyzed: 4, avgScore: 72, ...overrides };
}

function revenue(overrides = {}) {
  return { ...emptyRevenueSection(), wonCount: 2, wonAmount: 12500000, partialCount: 1, partialAmount: 1800000, ...overrides };
}

test("groups money digits so large sums stay readable", () => {
  assert.equal(formatMoney(0), "0");
  assert.equal(formatMoney(1000), "1 000");
  assert.equal(formatMoney(12500000), "12 500 000");
  assert.equal(formatMoney(999), "999");
});

test("formats talk time with hours only when there are hours", () => {
  assert.equal(formatTalkTime(0), "0d");
  assert.equal(formatTalkTime(900), "15d");
  assert.equal(formatTalkTime(7200), "2s 0d");
  assert.equal(formatTalkTime(7860), "2s 11d");
});

test("reports call volume with the connected/missed split", () => {
  const lines = formatCallSection(calls());
  assert.equal(lines[0], "📞 Qo'ng'iroqlar: 40 (dozvon: 25 · nedozvon: 15)");
  assert.equal(lines[1], "⏱ Suhbat vaqti: 2s 0d");
  assert.equal(lines[2], "⭐ O'rtacha ball: 72/100 (4 ta tahlil)");
  assert.equal(lines.length, 3);
});

test("says plainly when nothing was analyzed rather than showing a zero score", () => {
  const lines = formatCallSection(calls({ analyzed: 0, avgScore: null }));
  assert.equal(lines[2], "⭐ O'rtacha ball: tahlil qilingan qo'ng'iroq yo'q");
});

test("warns when the history page cap may have hidden part of the day", () => {
  const lines = formatCallSection(calls({ possiblyTruncated: true }));
  assert.equal(lines.at(-1), "⚠️ Qo'ng'iroqlar soni to'liq bo'lmasligi mumkin (tarix limiti).");
});

test("reports won and part-paid revenue as separate lines", () => {
  const lines = formatRevenueSection(revenue());
  assert.deepEqual(lines, [
    "💰 Tushumlar:",
    "• Muvaffaqiyatli: 2 ta · 12 500 000",
    "• Qisman to'langan: 1 ta · 1 800 000",
  ]);
});

test("never hides that some payments have no resolved amount", () => {
  const lines = formatRevenueSection(revenue({ unknownAmountCount: 2 }));
  assert.equal(lines.at(-1), "⚠️ Summasi aniqlanmagan bitimlar: 2 ta");
});

test("shows plan progress and what is left", () => {
  assert.deepEqual(formatPlanSection({ target: 50000000, achieved: 32000000 }), [
    "🎯 Oylik reja: 50 000 000",
    "✅ Bajarildi: 32 000 000 (64%)",
    "📉 Qoldi: 18 000 000",
  ]);
});

test("celebrates an exceeded plan instead of printing a negative remainder", () => {
  const lines = formatPlanSection({ target: 50000000, achieved: 62000000 });
  assert.equal(lines[1], "✅ Bajarildi: 62 000 000 (124%)");
  assert.equal(lines[2], "🎉 Reja bajarildi! Ortiqcha: 12 000 000");
});

test("states that no plan is set rather than dividing by zero", () => {
  assert.deepEqual(formatPlanSection(null), ["🎯 Oylik reja: belgilanmagan"]);
  assert.deepEqual(formatPlanSection({ target: 0, achieved: 100 }), ["🎯 Oylik reja: belgilanmagan"]);
  assert.equal(planPercent(null), null);
  assert.equal(planPercent({ target: 0, achieved: 100 }), null);
  assert.equal(planPercent({ target: 200, achieved: 50 }), 25);
});

test("builds a manager report with every section present", () => {
  const text = formatManagerPerformance(
    { managerName: "Aziza", calls: calls(), revenue: revenue(), plan: { target: 50000000, achieved: 32000000 } },
    "Kecha (12.08)",
  );

  assert.equal(text.startsWith("📊 Kecha (12.08) — Aziza"), true);
  assert.equal(text.includes("📞 Qo'ng'iroqlar: 40 (dozvon: 25 · nedozvon: 15)"), true);
  assert.equal(text.includes("• Muvaffaqiyatli: 2 ta · 12 500 000"), true);
  assert.equal(text.includes("📉 Qoldi: 18 000 000"), true);
});

test("weights the team score by call count, not by manager count", () => {
  const team = aggregateTeamPerformance("Jamoa", "Kecha", [
    { managerName: "A", calls: calls({ analyzed: 9, avgScore: 90 }), revenue: emptyRevenueSection(), plan: null },
    { managerName: "B", calls: calls({ analyzed: 1, avgScore: 50 }), revenue: emptyRevenueSection(), plan: null },
  ]);

  // A simple mean would be 70; weighting by analyzed calls gives 86.
  assert.equal(team.calls.avgScore, 86);
  assert.equal(team.calls.analyzed, 10);
  assert.equal(team.calls.total, 80);
});

test("sums team revenue and plan across members", () => {
  const team = aggregateTeamPerformance("Jamoa", "Kecha", [
    { managerName: "A", calls: calls(), revenue: revenue(), plan: { target: 30000000, achieved: 10000000 } },
    { managerName: "B", calls: calls(), revenue: revenue({ wonAmount: 500000, unknownAmountCount: 1 }), plan: { target: 20000000, achieved: 5000000 } },
  ]);

  assert.equal(team.revenue.wonAmount, 13000000);
  assert.equal(team.revenue.wonCount, 4);
  assert.equal(team.revenue.unknownAmountCount, 1);
  assert.deepEqual(team.plan, { target: 50000000, achieved: 15000000 });
});

test("leaves the team plan unset when no member has one", () => {
  const team = aggregateTeamPerformance("Jamoa", "Kecha", [
    { managerName: "A", calls: calls(), revenue: revenue(), plan: null },
  ]);
  assert.equal(team.plan, null);
  assert.equal(formatTeamPerformance(team).includes("🎯 Oylik reja: belgilanmagan"), true);
});

test("propagates a truncation warning from any member to the team", () => {
  const team = aggregateTeamPerformance("Jamoa", "Kecha", [
    { managerName: "A", calls: calls(), revenue: revenue(), plan: null },
    { managerName: "B", calls: calls({ possiblyTruncated: true }), revenue: revenue(), plan: null },
  ]);
  assert.equal(team.calls.possiblyTruncated, true);
});

test("lists team members by revenue, strongest first", () => {
  const text = formatTeamPerformance(aggregateTeamPerformance("Jamoa", "Kecha", [
    { managerName: "Past", calls: calls(), revenue: revenue({ wonAmount: 1000000 }), plan: null },
    { managerName: "Yuqori", calls: calls(), revenue: revenue({ wonAmount: 9000000 }), plan: { target: 10000000, achieved: 9000000 } },
  ]));

  const memberLines = text.split("\n").filter((line) => line.startsWith("• Past") || line.startsWith("• Yuqori"));
  assert.equal(memberLines[0].startsWith("• Yuqori"), true);
  assert.equal(memberLines[0].includes("reja 90%"), true);
  assert.equal(memberLines[1].startsWith("• Past"), true);
  assert.equal(memberLines[1].includes("reja"), false);
});

test("renders an empty team without inventing members", () => {
  const text = formatTeamPerformance(aggregateTeamPerformance("Jamoa", "Kecha", []));
  assert.equal(text.includes("👤 Menejerlar:"), false);
  assert.equal(text.includes("📞 Qo'ng'iroqlar: 0 (dozvon: 0 · nedozvon: 0)"), true);
});
