const test = require("node:test");
const assert = require("node:assert/strict");

const { formatManagerDisplayName } = require("../dist/services/managerDisplayName");

test("strips the extension and the pbx marker from a real account name", () => {
  assert.equal(formatManagerDisplayName("Муслима 101 pbx"), "Муслима");
  assert.equal(formatManagerDisplayName("Шохиста 115 pbx"), "Шохиста");
  assert.equal(formatManagerDisplayName("Sarvinoz AI 128 pbx"), "Sarvinoz AI");
  assert.equal(formatManagerDisplayName("Ислом 106"), "Ислом");
  assert.equal(formatManagerDisplayName("Дильнавоз 112"), "Дильнавоз");
});

test("removes the punctuation a stripped token leaves behind", () => {
  assert.equal(formatManagerDisplayName("Кувонч. 111 pbx"), "Кувонч");
  assert.equal(formatManagerDisplayName("Mirvohid Team. 120 pbx"), "Mirvohid Team");
  assert.equal(formatManagerDisplayName("Отабек РОП. 121 pbx"), "Отабек РОП");
});

test("leaves a clean name untouched", () => {
  assert.equal(formatManagerDisplayName("Сардор РОП"), "Сардор РОП");
  assert.equal(formatManagerDisplayName("Махмуджон"), "Махмуджон");
  assert.equal(formatManagerDisplayName("Qadam Hr"), "Qadam Hr");
  assert.equal(formatManagerDisplayName("  Ирода  "), "Ирода");
});

test("only strips trailing tokens, never a digit inside the name", () => {
  // The 2 distinguishes two people and must survive.
  assert.equal(formatManagerDisplayName("Ali 2 Team"), "Ali 2 Team");
  assert.equal(formatManagerDisplayName("Ali Team 130 pbx"), "Ali Team");
});

test("never reduces a name to nothing or to a bare number", () => {
  assert.equal(formatManagerDisplayName("101"), "101");
  assert.equal(formatManagerDisplayName("pbx"), "pbx");
  assert.equal(formatManagerDisplayName("101 pbx"), "101");
  assert.equal(formatManagerDisplayName(""), "");
  assert.equal(formatManagerDisplayName("   "), "");
});

test("strips a marker glued to the extension in one token", () => {
  assert.equal(formatManagerDisplayName("Асқарбек пбх-134"), "Асқарбек");
  assert.equal(formatManagerDisplayName("Сарвиноз. 100pbx"), "Сарвиноз");
  assert.equal(formatManagerDisplayName("Firdavs 134pbx"), "Firdavs");
  assert.equal(formatManagerDisplayName("Nodir pbx 120"), "Nodir");
});

test("collapses stray whitespace", () => {
  assert.equal(formatManagerDisplayName("Ali   Team   130   pbx"), "Ali Team");
});
