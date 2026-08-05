"use strict";

let catalog = [];

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function fetchGzipJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Catalogue request failed with ${response.status}.`);

  if (response.headers.get("content-encoding") === "gzip") {
    return response.json();
  }

  if (!("DecompressionStream" in self)) {
    throw new Error("This browser cannot open the compressed catalogue.");
  }

  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}

function searchableText(entry) {
  const terms = []
    .concat(entry.name || "")
    .concat(entry.code || "")
    .concat(entry.codeType || "")
    .concat(entry.terms || [])
    .concat(entry.aliases || []);
  return normalize(terms.join(" "));
}

function score(entry, query, tokens) {
  if (!query) return Number.POSITIVE_INFINITY;

  const code = entry._code;
  const name = entry._name;
  const preferredTerms = entry._preferredTerms;
  const text = entry._searchText;
  if (query === code) return 0;
  if (preferredTerms.includes(query)) return 0;
  if (query === name) return 1;
  if (code.startsWith(query)) return 2;
  if (name.startsWith(query)) return 3;
  if (tokens.length > 1 && tokens.every((token) => text.includes(token))) return 4;
  if (text.includes(query)) return 4;
  return Number.POSITIVE_INFINITY;
}

function publicEntry(entry) {
  const copy = {};
  Object.keys(entry).forEach((key) => {
    if (!key.startsWith("_")) copy[key] = entry[key];
  });
  return copy;
}

function compareMatches(a, b) {
  return a.score - b.score
    || Number(a.entry.local) - Number(b.entry.local)
    || (b.entry.providerCount || 0) - (a.entry.providerCount || 0)
    || String(a.entry.name).localeCompare(String(b.entry.name));
}

function topMatches(query, tokens, limit) {
  const matches = [];
  for (const entry of catalog) {
    const entryScore = score(entry, query, tokens);
    if (!Number.isFinite(entryScore)) continue;
    const candidate = { entry, score: entryScore };
    if (matches.length < limit) {
      matches.push(candidate);
      matches.sort(compareMatches);
      continue;
    }
    if (compareMatches(candidate, matches[matches.length - 1]) < 0) {
      matches[matches.length - 1] = candidate;
      matches.sort(compareMatches);
    }
  }
  return matches.map((match) => publicEntry(match.entry));
}

self.addEventListener("message", async (event) => {
  const message = event.data || {};

  if (message.type === "init") {
    try {
      const payload = await fetchGzipJson(message.url);
      const entries = Array.isArray(payload) ? payload : payload.items;
      if (!Array.isArray(entries)) throw new Error("The search catalogue has an invalid shape.");
      catalog = entries.map((entry) => Object.assign(entry, {
        _code: normalize(entry.code),
        _name: normalize(entry.name),
        _preferredTerms: [].concat(entry.terms || []).concat(entry.aliases || []).map(normalize),
        _searchText: searchableText(entry)
      }));
      self.postMessage({ type: "ready", count: catalog.length });
    } catch (error) {
      self.postMessage({ type: "error", message: error.message });
    }
    return;
  }

  if (message.type === "query") {
    const startedAt = performance.now();
    const query = normalize(message.query);
    const tokens = query.split(" ").filter(Boolean);
    const matches = topMatches(query, tokens, message.limit || 8);
    self.postMessage({
      type: "results",
      requestId: message.requestId,
      matches,
      durationMs: performance.now() - startedAt
    });
    return;
  }

  if (message.type === "find") {
    const entry = catalog.find((item) => item.id === message.id);
    self.postMessage({
      type: "found",
      requestId: message.requestId,
      entry: entry ? publicEntry(entry) : null
    });
  }
});
