const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatDealDossier,
  canViewDealDossier,
  pipelineLabel,
  DEAL_DOSSIER_MAX_CALLS,
} = require("../dist/services/dealDossier");

function call(overrides = {}) {
  return {
    id: 1,
    managerId: 7,
    startedAt: new Date("2026-08-12T09:30:00.000Z"), // 14:30 Almaty
    durationSeconds: 512,
    managerName: "Aziza",
    overallScore: 72,
    weaknesses: [],
    clientRecommendations: [],
    managerRecommendations: [],
    recordUrl: null,
    ...overrides,
  };
}

function dossier(overrides = {}) {
  return {
    dealId: 12345,
    dealName: null,
    pipelineId: 6909890,
    statusId: 58160726,
    contactName: null,
    phones: [],
    calls: [],
    analyzedCalls: 0,
    avgScore: null,
    topMistakes: [],
    ...overrides,
  };
}

test("renders the deal header, mistakes, recommendations and call history", () => {
  const text = formatDealDossier(dossier({
    dealName: "Excel kursi",
    contactName: "Aziza",
    phones: ["998901234567"],
    calls: [call({
      weaknesses: ["Ehtiyoj ochilmadi"],
      clientRecommendations: ["Juma kuni qayta qo'ng'iroq qiling"],
      managerRecommendations: ["Keyingi qadamni kelishing"],
    })],
    analyzedCalls: 1,
    avgScore: 72,
    topMistakes: [{ mistake: "Ehtiyoj ochilmadi", count: 3 }, { mistake: "Narx aytilmadi", count: 1 }],
  }));

  assert.equal(text.startsWith("🗂 Bitim #12345\nExcel kursi\n👤 Aziza · 998901234567"), true);
  assert.equal(text.includes("📂 Voronka: UZUM · Bosqich: 58160726"), true);
  assert.equal(text.includes("🔗 https://qadamsales.amocrm.ru/leads/detail/12345"), true);
  assert.equal(text.includes("📞 Qo'ng'iroqlar: 1 · ⭐ O'rtacha ball: 72/100"), true);
  // A repeated mistake carries its count, a one-off does not.
  assert.equal(text.includes("• Ehtiyoj ochilmadi (3×)"), true);
  assert.equal(text.includes("• Narx aytilmadi\n"), true);
  assert.equal(text.includes("🤖 Mijoz bo'yicha keyingi qadamlar:\n• Juma kuni qayta qo'ng'iroq qiling"), true);
  assert.equal(text.includes("🤖 Menejerga tavsiyalar:\n• Keyingi qadamni kelishing"), true);
  assert.equal(text.includes("• 12.08 14:30 · 8d 32s · 72/100 · Aziza"), true);
});

test("takes recommendations from the most recent call that produced any", () => {
  const text = formatDealDossier(dossier({
    calls: [
      call({ id: 3, startedAt: new Date("2026-08-14T09:00:00.000Z"), clientRecommendations: [] }),
      call({ id: 2, startedAt: new Date("2026-08-13T09:00:00.000Z"), clientRecommendations: ["Yangi tavsiya"] }),
      call({ id: 1, startedAt: new Date("2026-08-12T09:00:00.000Z"), clientRecommendations: ["Eski tavsiya"] }),
    ],
  }));

  assert.equal(text.includes("Yangi tavsiya"), true);
  assert.equal(text.includes("Eski tavsiya"), false);
});

test("reports a deal that has no analyzed calls without inventing sections", () => {
  const text = formatDealDossier(dossier());

  assert.equal(text.includes("📞 Bu bitim bo'yicha tahlil qilingan qo'ng'iroq yo'q."), true);
  assert.equal(text.includes("Takrorlangan xatolar"), false);
  assert.equal(text.includes("O'rtacha ball"), false);
});

test("omits an average score when no call on the deal was scored", () => {
  const text = formatDealDossier(dossier({ calls: [call({ overallScore: null })] }));

  assert.equal(text.includes("📞 Qo'ng'iroqlar: 1"), true);
  assert.equal(text.includes("O'rtacha ball"), false);
  assert.equal(text.includes("tahlil yo'q"), true);
});

test("caps the call history and says how many calls were left out", () => {
  const calls = Array.from({ length: DEAL_DOSSIER_MAX_CALLS + 3 }, (_, index) => call({ id: index }));
  const text = formatDealDossier(dossier({ calls }));

  assert.equal(text.split("\n").filter((line) => line.startsWith("• 12.08")).length, DEAL_DOSSIER_MAX_CALLS);
  assert.equal(text.includes("… yana 3 ta qo'ng'iroq"), true);
});

test("labels known pipelines by name and unknown ones by ID", () => {
  assert.equal(pipelineLabel(6909890), "UZUM");
  assert.equal(pipelineLabel(9055778), "EXODE");
  assert.equal(pipelineLabel(11071910), "\u0412\u0438\u0434\u0435\u043e\u0447\u0430\u0442");
  assert.equal(pipelineLabel(8425422), "WB");
  assert.equal(pipelineLabel(9055770), "\u0424\u0435\u043d\u0438\u043a\u0441");
  assert.equal(pipelineLabel(10630306), "\u0411\u0443\u0445\u0433\u0430\u043b\u0442\u0435\u0440\u0438\u044f");
  assert.equal(pipelineLabel(999), "#999");
  assert.equal(pipelineLabel(null), "—");
});

test("lets admins and ROPs open any deal", () => {
  const foreignCalls = [{ managerId: 99 }];
  assert.equal(canViewDealDossier({ role: "ADMIN", managerId: null }, foreignCalls), true);
  assert.equal(canViewDealDossier({ role: "ROP", managerId: 5 }, foreignCalls), true);
  assert.equal(canViewDealDossier({ role: "ADMIN", managerId: null }, []), true);
});

test("limits a manager to deals carrying their own calls", () => {
  assert.equal(canViewDealDossier({ role: "MANAGER", managerId: 7 }, [{ managerId: 7 }]), true);
  assert.equal(canViewDealDossier({ role: "MANAGER", managerId: 7 }, [{ managerId: 99 }]), false);
  assert.equal(canViewDealDossier({ role: "MANAGER", managerId: 7 }, [{ managerId: null }]), false);
  assert.equal(canViewDealDossier({ role: "MANAGER", managerId: 7 }, []), false);
  assert.equal(canViewDealDossier({ role: "MANAGER", managerId: null }, [{ managerId: 7 }]), false);
});

test("limits a team lead to their own team's calls", () => {
  const viewer = { role: "TEAMLEAD", managerId: 3, teamManagerIds: [7, 8] };
  assert.equal(canViewDealDossier(viewer, [{ managerId: 8 }]), true);
  assert.equal(canViewDealDossier(viewer, [{ managerId: 3 }]), true);
  assert.equal(canViewDealDossier(viewer, [{ managerId: 99 }]), false);
  assert.equal(canViewDealDossier({ role: "TEAMLEAD", managerId: 3 }, [{ managerId: 8 }]), false);
});
