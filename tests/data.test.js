const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const CATALOG_DIR = path.join(ROOT, "catalog");
const SHARD_DIR = path.join(CATALOG_DIR, "shards");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function readGzipText(filePath) {
  return zlib.gunzipSync(fs.readFileSync(filePath)).toString("utf8");
}

function assertPlainObject(value, context) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${context} must be an object`);
}

function assertNonemptyString(value, context) {
  assert.equal(typeof value, "string", `${context} must be a string`);
  assert.ok(value.trim(), `${context} must not be empty`);
}

function assertNonnegativeNumber(value, context) {
  assert.equal(typeof value, "number", `${context} must be a number`);
  assert.ok(Number.isFinite(value), `${context} must be finite`);
  assert.ok(value >= 0, `${context} must not be negative`);
}

function normalizedKey(key) {
  return key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

function assertNoPayerOrPlanKeys(value, context) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPayerOrPlanKeys(item, `${context}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;

  Object.entries(value).forEach(([key, child]) => {
    const keyName = normalizedKey(key);
    assert.doesNotMatch(
      keyName,
      /(^|_)(payers?|plans?)(_|$)/,
      `${context} publishes the forbidden field ${key}`,
    );
    assertNoPayerOrPlanKeys(child, `${context}.${key}`);
  });
}

const config = readJson("config/providers.json");
const manifest = readJson("catalog/manifest.json");
const searchPath = path.join(CATALOG_DIR, manifest.artifacts.search.path);
const searchText = readGzipText(searchPath);
const searchItems = JSON.parse(searchText);
const shardFiles = fs.readdirSync(SHARD_DIR).filter((name) => name.endsWith(".json.gz")).sort();

const commercialPayerNamePattern = /\b(?:aetna|cigna|humana|kaiser\s+permanente|mvp\s+health\s*care|harvard\s+pilgrim|tufts\s+health\s+plan|united\s*health\s*care|anthem\s+(?:health|insurance|blue\s*cross|ppo|hmo|pos|epo|plan|network|commercial))\b|blue\s*cross|bluecross|\bbcbs\b/i;
const forbiddenBrandPattern = /blue\s*cross|bluecross|\bbcbs\b/i;
const allowedSearchKeys = new Set(["id", "name", "code", "codeType", "providerCount", "shard", "local", "providerId", "terms"]);
const allowedGroupKeys = new Set(["id", "name", "code", "codeType", "local", "providerId", "variants"]);
const allowedVariantKeys = new Set([
  "providerId",
  "description",
  "codes",
  "prices",
  "sourceRow",
  "sourceRows",
  "setting",
  "billingClass",
  "modifiers",
  "drug",
  "sourcePage",
]);
const allowedPriceKeys = new Set([
  "gross",
  "grossValues",
  "cash",
  "cashValues",
  "supplementalValues",
  "deidentifiedMin",
  "deidentifiedMax",
  "negotiatedMin",
  "negotiatedMax",
  "negotiatedCount",
]);

const searchByShard = new Map();
for (const item of searchItems) {
  const entries = searchByShard.get(item.shard) || [];
  entries.push(item);
  searchByShard.set(item.shard, entries);
}

let catalogAuditPromise;

function auditShards() {
  if (catalogAuditPromise) return catalogAuditPromise;

  catalogAuditPromise = Promise.resolve().then(() => {
    const manifestProviderIds = new Set(manifest.providers.map((provider) => provider.id));
    let compressedBytes = 0;
    let groupCount = 0;
    let groupVariantLinks = 0;
    let largestBytes = 0;

    for (const filename of shardFiles) {
      const shard = filename.slice(0, 2);
      assert.match(filename, /^[0-9a-f]{2}\.json\.gz$/, `unexpected shard filename ${filename}`);

      const filePath = path.join(SHARD_DIR, filename);
      const bytes = fs.statSync(filePath).size;
      compressedBytes += bytes;
      largestBytes = Math.max(largestBytes, bytes);

      const text = readGzipText(filePath);
      assert.doesNotMatch(text, commercialPayerNamePattern, `${filename} contains a commercial payer name`);

      const groups = JSON.parse(text);
      assertPlainObject(groups, filename);
      const expectedItems = searchByShard.get(shard) || [];
      const expectedById = new Map(expectedItems.map((item) => [item.id, item]));
      assert.equal(Object.keys(groups).length, expectedItems.length, `${filename} group count differs from search index`);

      for (const item of expectedItems) {
        assert.ok(Object.hasOwn(groups, item.id), `${item.id} is missing from ${filename}`);
      }

      for (const [groupId, group] of Object.entries(groups)) {
        groupCount += 1;
        assertPlainObject(group, groupId);
        Object.keys(group).forEach((key) => assert.ok(allowedGroupKeys.has(key), `${groupId} publishes unexpected field ${key}`));
        assert.equal(group.id, groupId, `${groupId} repeats a different id`);
        assertNonemptyString(group.name, `${groupId}.name`);
        assert.equal(typeof group.code, "string", `${groupId}.code must be a string`);
        assertNonemptyString(group.codeType, `${groupId}.codeType`);
        assert.equal(typeof group.local, "boolean", `${groupId}.local must be boolean`);
        assert.ok(Array.isArray(group.variants) && group.variants.length > 0, `${groupId} needs variants`);

        const searchItem = expectedById.get(groupId);
        assert.ok(searchItem, `${groupId} is missing from the search index`);
        assert.equal(searchItem.name, group.name, `${groupId} name differs between search and shard`);
        assert.equal(searchItem.code, group.code, `${groupId} code differs between search and shard`);
        assert.equal(searchItem.codeType, group.codeType, `${groupId} code type differs between search and shard`);
        assert.equal(searchItem.local, group.local, `${groupId} local flag differs between search and shard`);

        const providerIds = new Set();
        for (const [variantIndex, variant] of group.variants.entries()) {
          const context = `${groupId}.variants[${variantIndex}]`;
          groupVariantLinks += 1;
          assertPlainObject(variant, context);
          Object.keys(variant).forEach((key) => assert.ok(allowedVariantKeys.has(key), `${context} publishes unexpected field ${key}`));
          assertNonemptyString(variant.providerId, `${context}.providerId`);
          assert.ok(manifestProviderIds.has(variant.providerId), `${context} names an unknown provider`);
          providerIds.add(variant.providerId);
          assertNonemptyString(variant.description, `${context}.description`);
          assert.ok(Array.isArray(variant.codes), `${context}.codes must be an array`);
          variant.codes.forEach((code, codeIndex) => {
            assertPlainObject(code, `${context}.codes[${codeIndex}]`);
            assertNonemptyString(code.type, `${context}.codes[${codeIndex}].type`);
            assertNonemptyString(code.code, `${context}.codes[${codeIndex}].code`);
          });
          assertPlainObject(variant.prices, `${context}.prices`);
          assert.ok(Object.keys(variant.prices).length > 0, `${context}.prices must not be empty`);

          for (const [priceType, priceValue] of Object.entries(variant.prices)) {
            assert.ok(allowedPriceKeys.has(priceType), `${context}.prices publishes unexpected field ${priceType}`);
            if (priceType.endsWith("Values")) {
              assert.ok(Array.isArray(priceValue) && priceValue.length > 0, `${context}.prices.${priceType} must be a nonempty array`);
              priceValue.forEach((entry, priceIndex) => {
                assertPlainObject(entry, `${context}.prices.${priceType}[${priceIndex}]`);
                assertNonnegativeNumber(entry.amount, `${context}.prices.${priceType}[${priceIndex}].amount`);
                assertNonemptyString(entry.label, `${context}.prices.${priceType}[${priceIndex}].label`);
              });
            } else {
              assertNonnegativeNumber(priceValue, `${context}.prices.${priceType}`);
            }
          }

          assertNoPayerOrPlanKeys(variant, context);
        }

        assert.equal(searchItem.providerCount, providerIds.size, `${groupId} provider count differs from its variants`);
        if (group.local) {
          assertNonemptyString(group.providerId, `${groupId}.providerId`);
          assert.equal(searchItem.providerId, group.providerId, `${groupId} provider differs between search and shard`);
          assert.deepEqual([...providerIds], [group.providerId], `${groupId} combines a provider-specific code across providers`);
        } else {
          assert.equal(group.providerId, undefined, `${groupId} must not bind a standard code to one provider`);
        }
      }
    }

    return { compressedBytes, groupCount, groupVariantLinks, largestBytes };
  });

  return catalogAuditPromise;
}

test("provider configuration is unique and its coverage totals are internally consistent", () => {
  assertPlainObject(config, "provider configuration");
  assertNonemptyString(config.manifestVersion, "manifestVersion");
  assert.match(config.lastVerified, /^\d{4}-\d{2}-\d{2}$/, "lastVerified must use YYYY-MM-DD");
  assert.ok(Array.isArray(config.providers) && config.providers.length > 0, "providers must be a nonempty array");

  const uniqueValues = (field) => config.providers.map((provider) => provider[field]).filter(Boolean);
  for (const field of ["id", "name", "ccn", "ein", "npi"]) {
    const values = uniqueValues(field).map((value) => String(value).toLowerCase());
    assert.equal(new Set(values).size, values.length, `provider ${field} values must be unique`);
  }

  config.providers.forEach((provider, index) => {
    const context = `providers[${index}]`;
    assert.match(provider.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${context}.id must use lowercase kebab case`);
    assertNonemptyString(provider.name, `${context}.name`);
    assertNonemptyString(provider.scopeClass, `${context}.scopeClass`);
    assertNonemptyString(provider.coverageScope, `${context}.coverageScope`);
    assert.equal(typeof provider.required, "boolean", `${context}.required must be boolean`);
    assertNonemptyString(provider.availability, `${context}.availability`);
    assert.match(provider.officialPageUrl, /^https:\/\//, `${context}.officialPageUrl must use HTTPS`);
  });

  const required = config.providers.filter((provider) => provider.required);
  const vermontHospitals = config.providers.filter(
    (provider) => provider.state === "VT" && provider.scopeClass.endsWith("_hospital"),
  );
  const regionalHospitals = config.providers.filter((provider) => provider.coverageScope === "regional");
  const optionalNonhospital = config.providers.filter(
    (provider) => !provider.required && !provider.scopeClass.endsWith("_hospital"),
  );

  assert.equal(config.coverage.requiredProviders, required.length);
  assert.equal(config.coverage.vermontHospitals, vermontHospitals.length);
  assert.equal(config.coverage.regionalHospitals, regionalHospitals.length);
  assert.equal(config.coverage.optionalNonhospitalProviders, optionalNonhospital.length);
});

test("manifest and search index use the generated catalogue schema", () => {
  assertPlainObject(manifest, "catalog manifest");
  assert.match(manifest.schemaVersion, /^\d+\.\d+\.\d+$/, "catalog schemaVersion must use semantic versioning");
  assert.ok(Number.isFinite(Date.parse(manifest.generatedAt)), "generatedAt must be an ISO date-time");
  assert.equal(manifest.sourceManifestVersion, config.manifestVersion);
  assert.equal(manifest.sourceLastVerified, config.lastVerified);
  assert.equal(manifest.coverage.configuredProviders, config.providers.length);
  assert.equal(manifest.coverage.failedProviders, 0, "published catalogue must not contain failed providers");

  const configuredIds = config.providers.map((provider) => provider.id).sort();
  const manifestIds = manifest.providers.map((provider) => provider.id).sort();
  assert.deepEqual(manifestIds, configuredIds, "manifest must account for every configured provider exactly once");
  assert.equal(new Set(manifestIds).size, manifestIds.length, "manifest provider ids must be unique");

  const statusCounts = manifest.providers.reduce((counts, provider) => {
    counts[provider.status] = (counts[provider.status] || 0) + 1;
    return counts;
  }, {});
  assert.equal(manifest.coverage.ingestedProviders, statusCounts.ingested || 0);
  assert.equal(manifest.coverage.unavailableProviders, statusCounts.unavailable || 0);
  assert.equal(manifest.coverage.unsupportedProviders, statusCounts.unsupported || 0);
  assert.equal(manifest.coverage.failedProviders, statusCounts.error || 0);

  assert.ok(Array.isArray(searchItems) && searchItems.length > 0, "search index must be a nonempty array");
  assert.equal(manifest.counts.searchItems, searchItems.length);
  assert.equal(manifest.counts.standardItems + manifest.counts.localItems, searchItems.length);
  assert.equal(manifest.artifacts.search.bytes, fs.statSync(searchPath).size);

  const ids = new Set();
  searchItems.forEach((item, index) => {
    const context = `search[${index}]`;
    Object.keys(item).forEach((key) => assert.ok(allowedSearchKeys.has(key), `${context} publishes unexpected field ${key}`));
    assertNonemptyString(item.id, `${context}.id`);
    assert.ok(!ids.has(item.id), `${context}.id duplicates ${item.id}`);
    ids.add(item.id);
    assertNonemptyString(item.name, `${context}.name`);
    assert.equal(typeof item.code, "string", `${context}.code must be a string`);
    assertNonemptyString(item.codeType, `${context}.codeType`);
    assert.ok(Number.isInteger(item.providerCount) && item.providerCount > 0, `${context}.providerCount must be positive`);
    assert.match(item.shard, /^[0-9a-f]{2}$/, `${context}.shard must be two hexadecimal characters`);
    assert.equal(typeof item.local, "boolean", `${context}.local must be boolean`);
    if (item.local) assertNonemptyString(item.providerId, `${context}.providerId`);
    if (item.terms !== undefined) {
      assert.ok(Array.isArray(item.terms), `${context}.terms must be an array`);
      item.terms.forEach((term, termIndex) => assertNonemptyString(term, `${context}.terms[${termIndex}]`));
    }
  });
});

test("every gzip shard parses and matches its manifest totals", async () => {
  const audit = await auditShards();
  assert.equal(manifest.artifacts.shards.count, shardFiles.length);
  assert.equal(manifest.artifacts.shards.groups, audit.groupCount);
  assert.equal(manifest.counts.searchItems, audit.groupCount);
  assert.equal(manifest.counts.groupVariantLinks, audit.groupVariantLinks);
  assert.equal(manifest.artifacts.shards.bytes, audit.compressedBytes);
  assert.equal(manifest.artifacts.shards.largestBytes, audit.largestBytes);
  assert.ok(audit.largestBytes <= manifest.artifacts.shards.maximumAllowedBytes, "largest shard exceeds the configured size limit");
});

test("every search item resolves to the declared shard", async () => {
  await auditShards();
  const shardNames = new Set(shardFiles.map((name) => name.slice(0, 2)));
  searchItems.forEach((item) => assert.ok(shardNames.has(item.shard), `${item.id} refers to missing shard ${item.shard}`));
});

test("published catalogue omits payer and plan identities", async () => {
  assert.doesNotMatch(searchText, commercialPayerNamePattern, "search index contains a commercial payer name");
  assertNoPayerOrPlanKeys(manifest, "manifest");
  assertNoPayerOrPlanKeys(searchItems, "search");
  await auditShards();
});

test("shipped interface and catalogue omit the forbidden Vermont brand name", async () => {
  const interfaceFiles = ["index.html", "app.js", "access-gate.js", "search-worker.js", "styles.css"];
  for (const relativePath of interfaceFiles) {
    const text = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    assert.doesNotMatch(text, forbiddenBrandPattern, `${relativePath} contains the forbidden brand name`);
  }

  assert.doesNotMatch(JSON.stringify(manifest), forbiddenBrandPattern, "manifest contains the forbidden brand name");
  assert.doesNotMatch(searchText, forbiddenBrandPattern, "search index contains the forbidden brand name");
  await auditShards();
});
