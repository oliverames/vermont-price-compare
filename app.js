(function () {
  "use strict";

  document.documentElement.classList.add("js");

  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const integer = new Intl.NumberFormat("en-US");
  const date = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  });

  const elements = {
    form: document.querySelector("#search-form"),
    search: document.querySelector("#procedure-search"),
    suggestions: document.querySelector("#search-suggestions"),
    searchError: document.querySelector("#search-error"),
    catalogStatus: document.querySelector("#catalog-status"),
    results: document.querySelector("#results"),
    resultsTitle: document.querySelector("#results-title"),
    meta: document.querySelector("#procedure-meta"),
    summary: document.querySelector("#results-summary"),
    controls: document.querySelector("#result-controls"),
    serviceVariant: document.querySelector("#service-variant"),
    priceType: document.querySelector("#price-type"),
    sortOrder: document.querySelector("#sort-order"),
    notice: document.querySelector("#comparison-notice"),
    empty: document.querySelector("#results-empty"),
    comparisonGroup: document.querySelector("#comparison-group"),
    comparisonDescription: document.querySelector("#comparison-description"),
    comparable: document.querySelector("#comparable-results"),
    coverageSummary: document.querySelector("#coverage-summary"),
    coverageStats: document.querySelector("#coverage-stats"),
    coverageResults: document.querySelector("#coverage-results"),
    datasetDate: document.querySelector("#dataset-date"),
    menuButton: document.querySelector(".menu-toggle"),
    navigation: document.querySelector("#primary-navigation")
  };

  const state = {
    manifest: null,
    providers: new Map(),
    currentEntry: null,
    currentItem: null,
    variantKey: "",
    priceType: "cash",
    sortOrder: "low",
    activeSuggestion: -1,
    suggestions: [],
    requestId: 0,
    pendingSelection: false,
    workerReady: false
  };

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function asNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatMoney(value) {
    return money.format(value);
  }

  function formatRange(low, high) {
    if (low === null || high === null) return "Not published";
    return low === high ? formatMoney(low) : `${formatMoney(low)}–${formatMoney(high)}`;
  }

  function titleCase(value) {
    return String(value || "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatDate(value) {
    if (!value) return "Not stated";
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(parsed.valueOf()) ? value : date.format(parsed);
  }

  async function fetchGzipJson(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Data request failed with ${response.status}.`);
    if (response.headers.get("content-encoding") === "gzip") return response.json();
    if (!("DecompressionStream" in window)) {
      throw new Error("This browser cannot open the compressed price file.");
    }
    const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).json();
  }

  function updateUrl(entry) {
    const url = new URL(window.location.href);
    url.searchParams.set("procedure", entry.id);
    url.hash = "";
    window.history.replaceState({}, "", url);
  }

  function providerFor(id) {
    return state.providers.get(id) || { id, name: titleCase(id), town: "", state: "" };
  }

  function closeSuggestions() {
    elements.suggestions.hidden = true;
    elements.suggestions.replaceChildren();
    elements.search.setAttribute("aria-expanded", "false");
    elements.search.removeAttribute("aria-activedescendant");
    state.activeSuggestion = -1;
  }

  function setActiveSuggestion(index) {
    const options = Array.from(elements.suggestions.querySelectorAll("[role='option']"));
    if (!options.length) return;
    state.activeSuggestion = (index + options.length) % options.length;
    options.forEach((option, optionIndex) => {
      const active = optionIndex === state.activeSuggestion;
      option.setAttribute("aria-selected", String(active));
      if (active) {
        elements.search.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function renderSuggestions(matches) {
    state.suggestions = matches;
    state.activeSuggestion = -1;
    elements.suggestions.replaceChildren();

    matches.forEach((entry, index) => {
      const item = document.createElement("li");
      item.setAttribute("role", "presentation");
      const button = document.createElement("button");
      button.type = "button";
      button.id = `procedure-option-${index}`;
      button.dataset.index = String(index);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");

      const name = document.createElement("span");
      name.textContent = entry.name;
      const meta = document.createElement("span");
      const providerText = entry.providerCount === 1 ? "1 provider" : `${entry.providerCount} providers`;
      meta.textContent = `${entry.codeType} ${entry.code} · ${providerText}`;
      button.append(name, meta);
      item.append(button);
      elements.suggestions.append(item);
    });

    elements.suggestions.hidden = matches.length === 0;
    elements.search.setAttribute("aria-expanded", String(matches.length > 0));
  }

  function requestSearch(query, pendingSelection) {
    if (!state.workerReady) return;
    if (pendingSelection) closeSuggestions();
    state.requestId += 1;
    state.pendingSelection = Boolean(pendingSelection);
    searchWorker.postMessage({
      type: "query",
      query,
      limit: 8,
      requestId: state.requestId
    });
  }

  async function loadEntry(entry, options) {
    closeSuggestions();
    elements.searchError.textContent = "";
    elements.results.setAttribute("aria-busy", "true");
    elements.empty.hidden = false;
    elements.empty.firstElementChild.textContent = "Loading published prices…";
    elements.comparisonGroup.hidden = true;
    elements.controls.hidden = true;

    try {
      const shardPath = `catalog/shards/${entry.shard}.json.gz`;
      const shard = await fetchGzipJson(shardPath);
      const item = Array.isArray(shard)
        ? shard.find((candidate) => candidate.id === entry.id)
        : shard[entry.id];
      if (!item) throw new Error("The selected procedure is missing from its price file.");

      state.currentEntry = entry;
      state.currentItem = item;
      state.variantKey = "";
      state.priceType = "cash";
      updateUrl(entry);
      renderItem();
      elements.results.setAttribute("aria-busy", "false");

      if (options && options.focusResults) {
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        elements.results.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
        elements.resultsTitle.focus({ preventScroll: true });
      }
    } catch (error) {
      elements.results.setAttribute("aria-busy", "false");
      elements.empty.hidden = false;
      elements.empty.firstElementChild.textContent = "This procedure's price file could not be loaded.";
      elements.searchError.textContent = error.message;
    }
  }

  const searchWorker = new Worker("search-worker.js?v=6");
  searchWorker.addEventListener("message", (event) => {
    const message = event.data || {};

    if (message.type === "ready") {
      state.workerReady = true;
      elements.catalogStatus.textContent = `${integer.format(message.count)} searchable procedures and service items loaded.`;
      const requestedId = new URLSearchParams(window.location.search).get("procedure");
      state.requestId += 1;
      if (requestedId) {
        searchWorker.postMessage({ type: "find", id: requestedId, requestId: state.requestId });
      } else {
        requestSearch("colonoscopy", true);
      }
      return;
    }

    if (message.type === "results" && message.requestId === state.requestId) {
      if (Number.isFinite(message.durationMs)) {
        elements.catalogStatus.dataset.searchDurationMs = String(Math.round(message.durationMs));
      }
      if (state.pendingSelection) {
        state.pendingSelection = false;
        if (message.matches.length) loadEntry(message.matches[0]);
        else elements.searchError.textContent = "No matching procedure was found. Try a billing code or a shorter phrase.";
      } else {
        renderSuggestions(message.matches);
      }
      return;
    }

    if (message.type === "found" && message.requestId === state.requestId) {
      if (message.entry) loadEntry(message.entry);
      else requestSearch("colonoscopy", true);
      return;
    }

    if (message.type === "error") {
      elements.catalogStatus.textContent = "The procedure catalogue could not be loaded.";
      elements.searchError.textContent = message.message;
      elements.results.setAttribute("aria-busy", "false");
      elements.empty.firstElementChild.textContent = "The price catalogue is temporarily unavailable.";
    }
  });

  function variantKey(variant) {
    const rawModifiers = Array.isArray(variant.modifiers)
      ? variant.modifiers.filter(Boolean)
      : String(variant.modifiers || "").split("|").filter(Boolean);
    const modifiers = Array.from(new Set(rawModifiers));
    return JSON.stringify({
      setting: variant.setting || "not stated",
      billingClass: variant.billingClass || "not stated",
      modifiers,
      drug: variant.drug || null
    });
  }

  function variantLabel(key) {
    const context = JSON.parse(key);
    const setting = context.setting === "not stated" ? "Setting not stated" : `${titleCase(context.setting)} setting`;
    const billing = context.billingClass === "not stated"
      ? "billing class not stated"
      : `${titleCase(context.billingClass)} billing`;
    const modifiers = context.modifiers.length ? ` · modifiers ${context.modifiers.join(", ")}` : "";
    const drug = context.drug
      ? ` · drug unit ${context.drug.unit ?? "not stated"} ${context.drug.type || ""}`.trimEnd()
      : "";
    return `${setting} · ${billing}${modifiers}${drug}`;
  }

  function valuesForPrice(variant, priceType) {
    const prices = variant.prices || {};
    if (priceType === "cash") {
      const values = Array.isArray(prices.cashValues)
        ? prices.cashValues.map((item) => asNumber(item.amount)).filter((value) => value !== null)
        : [];
      const canonical = asNumber(prices.cash);
      if (!values.length && canonical !== null) values.push(canonical);
      return values.length ? { low: Math.min(...values), high: Math.max(...values), count: values.length } : null;
    }
    if (priceType === "gross") {
      const values = Array.isArray(prices.grossValues)
        ? prices.grossValues.map((item) => asNumber(item.amount)).filter((value) => value !== null)
        : [];
      const canonical = asNumber(prices.gross);
      if (!values.length && canonical !== null) values.push(canonical);
      return values.length ? { low: Math.min(...values), high: Math.max(...values), count: values.length } : null;
    }
    if (priceType === "negotiated") {
      const low = asNumber(prices.negotiatedMin);
      const high = asNumber(prices.negotiatedMax);
      return low === null || high === null
        ? null
        : { low, high, count: asNumber(prices.negotiatedCount) || 0 };
    }
    if (priceType === "deidentified") {
      const low = asNumber(prices.deidentifiedMin);
      const high = asNumber(prices.deidentifiedMax);
      return low === null || high === null ? null : { low, high, count: 1 };
    }
    if (priceType.startsWith("supplemental:")) {
      const label = priceType.slice("supplemental:".length);
      const values = Array.isArray(prices.supplementalValues)
        ? prices.supplementalValues
          .filter((item) => String(item.label || "Other published rate") === label)
          .map((item) => asNumber(item.amount))
          .filter((value) => value !== null)
        : [];
      return values.length ? { low: Math.min(...values), high: Math.max(...values), count: values.length } : null;
    }
    return null;
  }

  function priceTypeOptions(variants) {
    const options = [
      { value: "cash", label: "Discounted cash price" },
      { value: "gross", label: "Gross charge" },
      { value: "negotiated", label: "Negotiated dollar range" },
      { value: "deidentified", label: "Published deidentified range" }
    ];
    const available = options.filter((option) => variants.some((variant) => valuesForPrice(variant, option.value)));
    const supplementalLabels = new Set();
    variants.forEach((variant) => {
      const values = variant.prices && variant.prices.supplementalValues;
      if (!Array.isArray(values)) return;
      values.forEach((item) => supplementalLabels.add(String(item.label || "Other published rate")));
    });
    const supplementalPriority = (label) => {
      const normalized = label.toLowerCase();
      if (normalized.includes("retail") || normalized.includes("category price ceiling")) return 0;
      if (normalized.includes("contracted")) return 1;
      if (normalized.includes("out-of-pocket")) return 2;
      return 3;
    };
    Array.from(supplementalLabels).sort((a, b) => {
      return supplementalPriority(a) - supplementalPriority(b) || a.localeCompare(b);
    }).forEach((label) => {
      available.push({ value: `supplemental:${label}`, label });
    });
    return available;
  }

  function groupProviders(variants, priceType) {
    const grouped = new Map();
    variants.forEach((variant) => {
      const range = valuesForPrice(variant, priceType);
      if (!range) return;
      if (!grouped.has(variant.providerId)) {
        grouped.set(variant.providerId, {
          provider: providerFor(variant.providerId),
          variants: [],
          low: range.low,
          high: range.high,
          valueCount: 0
        });
      }
      const row = grouped.get(variant.providerId);
      row.variants.push(variant);
      row.low = Math.min(row.low, range.low);
      row.high = Math.max(row.high, range.high);
      row.valueCount += range.count;
    });
    return Array.from(grouped.values());
  }

  function sortProviderRows(rows) {
    return rows.sort((a, b) => {
      if (state.sortOrder === "name") return a.provider.name.localeCompare(b.provider.name);
      return state.sortOrder === "high" ? b.high - a.high : a.low - b.low;
    });
  }

  function appendTextRow(container, label, value, className) {
    const paragraph = document.createElement("p");
    if (className) paragraph.className = className;
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;
    paragraph.append(strong, value);
    container.append(paragraph);
  }

  function formatAllPrices(variant) {
    const prices = variant.prices || {};
    const values = [];
    const cash = valuesForPrice(variant, "cash");
    const gross = valuesForPrice(variant, "gross");
    const deidentified = valuesForPrice(variant, "deidentified");
    if (cash) values.push(`cash ${formatRange(cash.low, cash.high)}`);
    if (gross) values.push(`gross ${formatRange(gross.low, gross.high)}`);
    if (asNumber(prices.negotiatedMin) !== null && asNumber(prices.negotiatedMax) !== null) {
      values.push(`negotiated ${formatRange(asNumber(prices.negotiatedMin), asNumber(prices.negotiatedMax))}`);
    }
    if (deidentified) values.push(`deidentified ${formatRange(deidentified.low, deidentified.high)}`);
    if (Array.isArray(prices.supplementalValues)) {
      prices.supplementalValues.forEach((item) => {
        const amount = asNumber(item.amount);
        if (amount !== null) values.push(`${item.label || "other published rate"} ${formatMoney(amount)}`);
      });
    }
    return values.join(" · ") || "No numeric dollar amount published";
  }

  function createVariantDetails(row) {
    const list = document.createElement("ul");
    list.className = "variant-list";
    row.variants.forEach((variant) => {
      const item = document.createElement("li");
      const description = document.createElement("strong");
      description.textContent = variant.description || state.currentItem.name;
      item.append(description);

      const codes = (variant.codes || []).map((code) => `${code.type} ${code.code}`).join(" · ");
      appendTextRow(item, "Codes", codes || `${state.currentItem.codeType} ${state.currentItem.code}`, "variant-meta");
      appendTextRow(item, "Price types", formatAllPrices(variant), "variant-meta");

      const cashValues = variant.prices && variant.prices.cashValues;
      if (Array.isArray(cashValues) && cashValues.length > 1) {
        appendTextRow(
          item,
          "Cash policies",
          cashValues.map((cash) => `${cash.label}: ${formatMoney(asNumber(cash.amount))}`).join(" · "),
          "variant-meta"
        );
      }

      const grossValues = variant.prices && variant.prices.grossValues;
      if (Array.isArray(grossValues) && grossValues.length > 1) {
        appendTextRow(
          item,
          "Gross-charge policies",
          grossValues.map((gross) => `${gross.label}: ${formatMoney(asNumber(gross.amount))}`).join(" · "),
          "variant-meta"
        );
      }

      const sourceLine = document.createElement("p");
      sourceLine.className = "variant-meta";
      sourceLine.textContent = `Source row ${variant.sourceRow || "not stated"}. `;
      const sourceUrl = variant.sourcePage || (row.provider.source && (
        row.provider.source.mrfUrl ||
        row.provider.source.catalogUrl ||
        row.provider.source.officialPageUrl
      ));
      if (sourceUrl) {
        const link = document.createElement("a");
        link.href = sourceUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open provider source";
        sourceLine.append(link);
      }
      item.append(sourceLine);
      list.append(item);
    });
    return list;
  }

  function renderProviderRows(variants) {
    const rows = sortProviderRows(groupProviders(variants, state.priceType));
    elements.comparable.replaceChildren();

    rows.forEach((row, index) => {
      const tableRow = document.createElement("tr");
      const providerCell = document.createElement("td");
      const providerName = document.createElement("span");
      providerName.className = "provider-name";
      providerName.textContent = row.provider.name;
      providerCell.append(providerName);

      const locationCell = document.createElement("td");
      locationCell.textContent = [row.provider.town, row.provider.state].filter(Boolean).join(", ");

      const priceCell = document.createElement("td");
      const priceValue = document.createElement("span");
      priceValue.className = "price-value";
      priceValue.textContent = formatRange(row.low, row.high);
      priceCell.append(priceValue);

      const countCell = document.createElement("td");
      countCell.className = "entry-count";
      const entryWord = row.variants.length === 1 ? "entry" : "entries";
      countCell.textContent = `${row.variants.length} ${entryWord}`;
      if (state.priceType === "negotiated" && row.valueCount) {
        countCell.textContent += ` · ${integer.format(row.valueCount)} rates`;
      }

      const actionCell = document.createElement("td");
      const detailId = `provider-detail-${index}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "details-toggle";
      button.dataset.detailTarget = detailId;
      button.setAttribute("aria-controls", detailId);
      button.setAttribute("aria-expanded", "false");
      button.textContent = "View details";
      actionCell.append(button);
      tableRow.append(providerCell, locationCell, priceCell, countCell, actionCell);

      const detailRow = document.createElement("tr");
      detailRow.className = "detail-row";
      detailRow.id = detailId;
      detailRow.hidden = true;
      const detailCell = document.createElement("td");
      detailCell.colSpan = 5;
      detailCell.append(createVariantDetails(row));
      detailRow.append(detailCell);
      elements.comparable.append(tableRow, detailRow);
    });

    elements.summary.textContent = rows.length === 1 ? "1 provider with this price type" : `${rows.length} providers with this price type`;
    elements.empty.hidden = rows.length > 0;
    elements.comparisonGroup.hidden = rows.length === 0;
    if (!rows.length) {
      elements.empty.firstElementChild.textContent = "No provider published this price type for the selected service variant.";
    }
  }

  function renderItem() {
    const item = state.currentItem;
    const variants = item.variants || [];
    const groups = new Map();
    variants.forEach((variant) => {
      const key = variantKey(variant);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(variant);
    });

    if (!state.variantKey || !groups.has(state.variantKey)) {
      const rankedGroups = Array.from(groups.entries()).sort((a, b) => {
        const aProviders = new Set(a[1].map((variant) => variant.providerId)).size;
        const bProviders = new Set(b[1].map((variant) => variant.providerId)).size;
        return bProviders - aProviders || variantLabel(a[0]).localeCompare(variantLabel(b[0]));
      });
      state.variantKey = rankedGroups[0] ? rankedGroups[0][0] : "";
    }
    const selectedVariants = groups.get(state.variantKey) || [];

    elements.resultsTitle.textContent = item.name;
    elements.meta.textContent = `${item.codeType} ${item.code} · ${variants.length} published ${variants.length === 1 ? "entry" : "entries"}`;
    elements.serviceVariant.replaceChildren();
    groups.forEach((groupVariants, key) => {
      const providerCount = new Set(groupVariants.map((variant) => variant.providerId)).size;
      const option = document.createElement("option");
      option.value = key;
      option.textContent = `${variantLabel(key)} · ${providerCount} ${providerCount === 1 ? "provider" : "providers"}`;
      elements.serviceVariant.append(option);
    });
    elements.serviceVariant.value = state.variantKey;

    const priceOptions = priceTypeOptions(selectedVariants);
    if (!priceOptions.some((option) => option.value === state.priceType)) {
      state.priceType = priceOptions[0] ? priceOptions[0].value : "";
    }
    elements.priceType.replaceChildren();
    priceOptions.forEach((priceOption) => {
      const option = document.createElement("option");
      option.value = priceOption.value;
      option.textContent = priceOption.label;
      elements.priceType.append(option);
    });
    elements.priceType.value = state.priceType;
    elements.sortOrder.value = state.sortOrder;

    elements.controls.hidden = false;
    elements.comparisonDescription.textContent = `${variantLabel(state.variantKey)}. Multiple source rows appear as a range and remain available in details.`;
    elements.notice.hidden = false;
    elements.notice.textContent = item.local
      ? "This is a provider-specific code, so it is not comparable across facilities."
      : "The ranking includes only matching settings, billing classes, modifiers, and price types.";
    renderProviderRows(selectedVariants);
  }

  function coverageStatus(provider) {
    if (provider.pricePublicationType === "selected_prices" && provider.status === "ingested") {
      return { label: "Selected prices ingested", className: "status-badge is-warning" };
    }
    if (provider.pricePublicationType === "no_public_prices") {
      return { label: "No public prices found", className: "status-badge is-missing" };
    }
    if (provider.status === "ingested") return { label: "Catalogue ingested", className: "status-badge" };
    if (provider.availability === "not_found" || provider.availability === "no_public_price_catalog") {
      return { label: "No public catalogue found", className: "status-badge is-missing" };
    }
    if (provider.required) return { label: "Catalogue unavailable", className: "status-badge is-missing" };
    return { label: "Limited public prices", className: "status-badge is-warning" };
  }

  function renderCoverage() {
    const manifest = state.manifest;
    const providers = manifest.providers || [];
    const coverage = manifest.coverage || {};
    const counts = manifest.counts || {};
    elements.coverageSummary.textContent = `${coverage.ingestedProviders || 0} provider price sources were processed. Missing and limited sources remain visible below.`;

    const stats = [
      [counts.searchItems || 0, "Searchable procedures and service items"],
      [counts.normalizedVariants || 0, "Published service entries"],
      [coverage.ingestedProviders || 0, "Provider price sources processed"],
      [counts.negotiatedDollarValues || 0, "Negotiated dollar values summarized"]
    ];
    elements.coverageStats.replaceChildren();
    stats.forEach(([value, label]) => {
      const card = document.createElement("div");
      card.className = "coverage-stat";
      const strong = document.createElement("strong");
      strong.textContent = integer.format(value);
      const span = document.createElement("span");
      span.textContent = label;
      card.append(strong, span);
      elements.coverageStats.append(card);
    });

    elements.coverageResults.replaceChildren();
    providers.forEach((provider) => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      nameCell.textContent = provider.name;
      const locationCell = document.createElement("td");
      locationCell.textContent = [provider.town, provider.state].filter(Boolean).join(", ");
      const statusCell = document.createElement("td");
      const status = coverageStatus(provider);
      const badge = document.createElement("span");
      badge.className = status.className;
      badge.textContent = status.label;
      statusCell.append(badge);
      const dateCell = document.createElement("td");
      dateCell.textContent = formatDate(provider.source && provider.source.dataDate);
      const sourceCell = document.createElement("td");
      const sourceUrl = provider.source && (
        provider.source.catalogUrl ||
        provider.source.mrfUrl ||
        provider.source.officialPageUrl
      );
      if (sourceUrl) {
        const link = document.createElement("a");
        link.href = sourceUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open source";
        sourceCell.append(link);
      } else {
        sourceCell.textContent = "No public source";
      }
      row.append(nameCell, locationCell, statusCell, dateCell, sourceCell);
      elements.coverageResults.append(row);
    });

    const generatedDate = String(manifest.generatedAt || "").slice(0, 10);
    elements.datasetDate.textContent = `Catalogue generated ${formatDate(generatedDate)} from provider-published files.`;
  }

  let searchTimer;
  elements.search.addEventListener("input", () => {
    elements.searchError.textContent = "";
    window.clearTimeout(searchTimer);
    const query = elements.search.value.trim();
    if (query.length < 2) {
      closeSuggestions();
      return;
    }
    searchTimer = window.setTimeout(() => requestSearch(query, false), 140);
  });

  elements.search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestion(state.activeSuggestion + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestion(state.activeSuggestion - 1);
    } else if (event.key === "Enter" && state.activeSuggestion >= 0) {
      event.preventDefault();
      loadEntry(state.suggestions[state.activeSuggestion], { focusResults: true });
    } else if (event.key === "Escape") {
      closeSuggestions();
    }
  });

  elements.suggestions.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-index]");
    if (!button) return;
    const entry = state.suggestions[Number(button.dataset.index)];
    if (entry) loadEntry(entry, { focusResults: true });
  });

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    window.clearTimeout(searchTimer);
    if (state.activeSuggestion >= 0 && state.suggestions[state.activeSuggestion]) {
      loadEntry(state.suggestions[state.activeSuggestion], { focusResults: true });
      return;
    }
    const query = elements.search.value.trim();
    if (!query) {
      elements.searchError.textContent = "Enter a procedure name or billing code.";
      elements.search.focus();
      return;
    }
    requestSearch(query, true);
  });

  document.querySelectorAll("[data-query]").forEach((button) => {
    button.addEventListener("click", () => {
      window.clearTimeout(searchTimer);
      elements.search.value = button.dataset.query;
      requestSearch(button.dataset.query, true);
    });
  });

  elements.serviceVariant.addEventListener("change", () => {
    state.variantKey = elements.serviceVariant.value;
    renderItem();
  });
  elements.priceType.addEventListener("change", () => {
    state.priceType = elements.priceType.value;
    renderProviderRows((state.currentItem.variants || []).filter((variant) => variantKey(variant) === state.variantKey));
  });
  elements.sortOrder.addEventListener("change", () => {
    state.sortOrder = elements.sortOrder.value;
    renderProviderRows((state.currentItem.variants || []).filter((variant) => variantKey(variant) === state.variantKey));
  });

  elements.comparable.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-detail-target]");
    if (!button) return;
    const detail = document.getElementById(button.dataset.detailTarget);
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    button.textContent = expanded ? "View details" : "Hide details";
    detail.hidden = expanded;
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".combobox")) closeSuggestions();
  });

  elements.menuButton.addEventListener("click", () => {
    const expanded = elements.menuButton.getAttribute("aria-expanded") === "true";
    elements.menuButton.setAttribute("aria-expanded", String(!expanded));
    elements.menuButton.setAttribute("aria-label", expanded ? "Open menu" : "Close menu");
    elements.navigation.classList.toggle("is-open", !expanded);
  });

  elements.navigation.addEventListener("click", (event) => {
    if (!event.target.closest("a")) return;
    elements.menuButton.setAttribute("aria-expanded", "false");
    elements.menuButton.setAttribute("aria-label", "Open menu");
    elements.navigation.classList.remove("is-open");
  });

  async function initialize() {
    try {
      const response = await fetch("catalog/manifest.json", { cache: "no-cache" });
      if (!response.ok) throw new Error(`Manifest request failed with ${response.status}.`);
      state.manifest = await response.json();
      (state.manifest.providers || []).forEach((provider) => state.providers.set(provider.id, provider));
      renderCoverage();
      searchWorker.postMessage({ type: "init", url: "catalog/search.json.gz" });
    } catch (error) {
      elements.catalogStatus.textContent = "The price catalogue could not be initialized.";
      elements.searchError.textContent = error.message;
      elements.results.setAttribute("aria-busy", "false");
      elements.empty.firstElementChild.textContent = "The price catalogue is temporarily unavailable.";
    }
  }

  initialize();
})();
