const test = require("node:test");
const assert = require("node:assert/strict");
const data = require("../data.js");

function procedure(id) {
  return data.procedures.find((item) => item.id === id);
}

function rate(procedureId, providerId, type = "gross") {
  return procedure(procedureId)[type].find((item) => item.provider === providerId);
}

test("the demo contains five procedures and all 14 state-report hospitals", () => {
  assert.equal(data.procedures.length, 5);
  assert.equal(Object.values(data.providers).filter((provider) => provider.type === "hospital").length, 14);
  data.procedures.forEach((item) => assert.equal(item.gross.length, 14));
});

test("each statewide procedure has one row per hospital", () => {
  data.procedures.forEach((item) => {
    const ids = item.gross.map((entry) => entry.provider);
    assert.equal(new Set(ids).size, 14, `${item.id} contains a duplicate provider`);
    ids.forEach((id) => assert.equal(data.providers[id].type, "hospital"));
    assert.equal(ids.includes("gmsc"), false, "surgery-center prices must stay outside statewide rankings");
  });
});

test("verified benchmark amounts match their primary reports", () => {
  assert.equal(rate("colonoscopy", "uvmmc").amount, 4747);
  assert.equal(rate("colonoscopy", "gifford").amount, 730);
  assert.equal(rate("mammogram", "northwestern").amount, 472);
  assert.equal(rate("mri-knee", "springfield").amount, 2354);
  assert.equal(rate("ct-abdomen-pelvis", "copley").amount, 2810);
  assert.equal(rate("carpal-tunnel", "nvrh").amount, 44401);
});

test("cash prices remain a separate discounted-price dataset", () => {
  assert.equal(rate("colonoscopy", "northwestern", "cash").amount, 1015.32);
  assert.equal(rate("mammogram", "uvmmc", "cash").amount, 777);
  assert.equal(rate("mri-knee", "cvmc", "cash").amount, 3520.8);
  assert.equal(rate("ct-abdomen-pelvis", "porter", "cash").amount, 3519);
  assert.equal(procedure("carpal-tunnel").cash.length, 0);
});

test("every published amount is positive and every source uses HTTPS", () => {
  data.procedures.forEach((item) => {
    assert.match(item.grossSource.url, /^https:\/\//);
    item.gross.forEach((entry) => {
      if (entry.amount !== null) assert.ok(entry.amount > 0);
      if (entry.partialAmount) assert.ok(entry.partialAmount > 0);
    });
    item.cash.forEach((entry) => {
      assert.ok(entry.amount > 0);
      assert.match(entry.source.url, /^https:\/\//);
    });
    item.other.forEach((entry) => {
      assert.ok(entry.amount > 0);
      assert.match(entry.source.url, /^https:\/\//);
    });
  });
});
