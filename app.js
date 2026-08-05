(function () {
  "use strict";

  const data = window.VPC_DATA;
  if (!data) throw new Error("Price data failed to load.");

  document.documentElement.classList.add("js");

  const procedureById = new Map(data.procedures.map((procedure) => [procedure.id, procedure]));
  const currency = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });

  const elements = {
    form: document.querySelector("#search-form"),
    search: document.querySelector("#procedure-search"),
    suggestions: document.querySelector("#search-suggestions"),
    searchError: document.querySelector("#search-error"),
    results: document.querySelector("#results"),
    resultsTitle: document.querySelector("#results-title"),
    meta: document.querySelector("#procedure-meta"),
    summary: document.querySelector("#results-summary"),
    priceType: document.querySelector("#price-type"),
    sortOrder: document.querySelector("#sort-order"),
    comparisonDescription: document.querySelector("#comparison-description"),
    comparable: document.querySelector("#comparable-results"),
    showAll: document.querySelector("#show-all"),
    otherSection: document.querySelector("#other-prices"),
    other: document.querySelector("#other-results"),
    incompleteGroup: document.querySelector("#incomplete-prices"),
    incompleteSummary: document.querySelector("#incomplete-summary"),
    incomplete: document.querySelector("#incomplete-results"),
    menuButton: document.querySelector(".menu-toggle"),
    navigation: document.querySelector("#primary-navigation")
  };

  const queryProcedure = new URLSearchParams(window.location.search).get("procedure");
  const initialProcedure = procedureById.has(queryProcedure) ? queryProcedure : "colonoscopy";
  const state = {
    procedureId: initialProcedure,
    priceType: "gross",
    sortOrder: "low",
    showAll: false,
    activeSuggestion: -1
  };

  function normalize(value) {
    return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function formatMoney(amount) {
    return currency.format(amount);
  }

  function scoreProcedure(procedure, query) {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) return 10;

    const values = [procedure.code, procedure.shortName, procedure.name].concat(procedure.aliases);
    const normalizedValues = values.map(normalize);
    if (normalizedValues.includes(normalizedQuery)) return 0;
    if (normalizedValues.some((value) => value.startsWith(normalizedQuery))) return 1;
    if (normalizedValues.some((value) => value.includes(normalizedQuery))) return 2;

    const queryTokens = normalizedQuery.split(" ");
    if (normalizedValues.some((value) => queryTokens.every((token) => value.includes(token)))) return 3;
    return Number.POSITIVE_INFINITY;
  }

  function findProcedures(query) {
    return data.procedures
      .map((procedure) => ({ procedure, score: scoreProcedure(procedure, query) }))
      .filter((match) => Number.isFinite(match.score))
      .sort((a, b) => a.score - b.score || a.procedure.name.localeCompare(b.procedure.name))
      .map((match) => match.procedure);
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

  function renderSuggestions(query) {
    const matches = findProcedures(query).slice(0, 5);
    elements.suggestions.replaceChildren();
    state.activeSuggestion = -1;

    matches.forEach((procedure, index) => {
      const item = document.createElement("li");
      item.setAttribute("role", "presentation");
      const button = document.createElement("button");
      button.type = "button";
      button.id = `procedure-option-${index}`;
      button.dataset.procedure = procedure.id;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");
      const name = document.createElement("span");
      name.textContent = procedure.shortName;
      const code = document.createElement("span");
      code.textContent = `CPT ${procedure.code}`;
      button.append(name, code);
      item.append(button);
      elements.suggestions.append(item);
    });

    const show = matches.length > 0;
    elements.suggestions.hidden = !show;
    elements.search.setAttribute("aria-expanded", String(show));
  }

  function updateUrl(procedureId) {
    const url = new URL(window.location.href);
    url.searchParams.set("procedure", procedureId);
    url.hash = "";
    window.history.replaceState({}, "", url);
  }

  function accessibleLabel(text) {
    const label = document.createElement("span");
    label.className = "visually-hidden";
    label.textContent = `${text}: `;
    return label;
  }

  function selectProcedure(procedureId, options) {
    const procedure = procedureById.get(procedureId);
    if (!procedure) return;

    state.procedureId = procedureId;
    state.showAll = false;
    if (state.priceType === "cash" && procedure.cash.length === 0) state.priceType = "gross";
    elements.search.value = procedure.shortName;
    elements.searchError.textContent = "";
    closeSuggestions();
    updateUrl(procedureId);
    renderProcedure();

    if (options && options.focusResults) {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      elements.results.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      elements.resultsTitle.focus({ preventScroll: true });
    }
  }

  function createChevron() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m7 10 5 5 5-5");
    svg.append(path);
    return svg;
  }

  function appendSourceLink(container, source) {
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `Open ${source.label}`;
    container.append(link);
  }

  function resultDetail(procedure, rate, kind) {
    const detail = document.createElement("div");
    detail.className = "result-detail";
    detail.hidden = true;

    const copy = document.createElement("p");
    if (kind === "gross") {
      copy.textContent = `This is the total gross charge in Vermont's 2026 table. It combines the hospital and hospital-employed physician amounts shown in that report. Insurance discounts and outside clinician bills are not included. Most charges apply ${data.statePeriod}.`;
      detail.append(copy);
      appendSourceLink(detail, procedure.grossSource);
    } else if (kind === "cash") {
      copy.textContent = `This is the provider's published discounted cash price for this service. The file does not necessarily identify every billing component, and another provider may bill separately. File updated ${rate.source.updated}.`;
      detail.append(copy);
      appendSourceLink(detail, rate.source);
    } else {
      copy.textContent = `${rate.detail} Price list updated ${rate.updated}.`;
      detail.append(copy);
      appendSourceLink(detail, rate.source);
    }
    return detail;
  }

  function makeResultEntry(procedure, rate, rank, kind) {
    const provider = data.providers[rate.provider];
    const entry = document.createElement("article");
    entry.className = "result-entry";
    entry.setAttribute("role", "listitem");

    const row = document.createElement("div");
    row.className = "result-row";

    const rankCell = document.createElement("span");
    rankCell.className = "result-rank";
    if (rank === null) {
      rankCell.setAttribute("aria-hidden", "true");
    } else {
      rankCell.append(accessibleLabel("Rank"), String(rank));
    }

    const providerCell = document.createElement("div");
    providerCell.className = "provider-cell";
    const providerName = document.createElement("strong");
    providerName.append(accessibleLabel("Provider"), provider.name);
    const mobileTown = document.createElement("span");
    mobileTown.className = "mobile-town";
    mobileTown.append(accessibleLabel("Location"), provider.town);
    providerCell.append(providerName, mobileTown);

    const townCell = document.createElement("span");
    townCell.className = "town-cell";
    townCell.append(accessibleLabel("Location"), provider.town);

    const priceCell = document.createElement("strong");
    priceCell.className = "price-cell";
    priceCell.append(accessibleLabel("Price"), formatMoney(rate.amount));

    const basisCell = document.createElement("span");
    basisCell.className = "basis-cell";
    basisCell.append(accessibleLabel("Price basis"), kind === "gross"
      ? "Hospital + employed physician"
      : kind === "cash"
        ? "Discounted cash price"
        : rate.basis);

    const detailId = `detail-${procedure.id}-${kind}-${rate.provider}`;
    const detail = resultDetail(procedure, rate, kind);
    detail.id = detailId;

    const button = document.createElement("button");
    button.className = "detail-button";
    button.type = "button";
    button.dataset.detailTarget = detailId;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", detailId);
    button.setAttribute("aria-label", `View price details for ${provider.name}`);
    const buttonLabel = document.createElement("span");
    buttonLabel.textContent = "View Price Details";
    button.append(buttonLabel, createChevron());

    row.append(rankCell, providerCell, townCell, priceCell, basisCell, button);
    entry.append(row, detail);
    return entry;
  }

  function sortRates(rates) {
    return rates.slice().sort((a, b) => {
      if (state.sortOrder === "name") {
        return data.providers[a.provider].name.localeCompare(data.providers[b.provider].name);
      }
      return state.sortOrder === "high" ? b.amount - a.amount : a.amount - b.amount;
    });
  }

  function renderPriceTypeOptions(procedure) {
    const options = [{ value: "gross", label: "Total gross charge" }];
    if (procedure.cash.length) options.push({ value: "cash", label: "Discounted cash price" });
    elements.priceType.replaceChildren();
    options.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      elements.priceType.append(option);
    });
    elements.priceType.value = state.priceType;
  }

  function renderIncomplete(procedure) {
    const missingRates = procedure.gross.filter((rate) => rate.amount === null);
    elements.incomplete.replaceChildren();
    elements.incompleteGroup.hidden = missingRates.length === 0 || state.priceType !== "gross";
    if (elements.incompleteGroup.hidden) return;

    elements.incompleteSummary.textContent = `${missingRates.length} more ${missingRates.length === 1 ? "hospital does" : "hospitals do"} not report a complete total`;
    missingRates.forEach((rate) => {
      const provider = data.providers[rate.provider];
      const row = document.createElement("div");
      row.className = "incomplete-row";
      const name = document.createElement("strong");
      name.textContent = provider.name;
      const town = document.createElement("span");
      town.textContent = provider.town;
      const note = document.createElement("span");
      note.textContent = rate.status === "not-listed"
        ? "No charge is listed for this CPT code in the state table."
        : `${rate.partialBasis}: ${formatMoney(rate.partialAmount)}. A complete total is not available.`;
      const link = document.createElement("a");
      link.href = procedure.grossSource.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open Source";
      row.append(name, town, note, link);
      elements.incomplete.append(row);
    });
  }

  function renderProcedure() {
    const procedure = procedureById.get(state.procedureId);
    renderPriceTypeOptions(procedure);

    elements.resultsTitle.textContent = procedure.name;
    elements.meta.textContent = `CPT ${procedure.code} · 2026 published prices`;

    const sourceRates = state.priceType === "cash"
      ? procedure.cash
      : procedure.gross.filter((rate) => rate.amount !== null);
    const comparableRates = sortRates(sourceRates);
    const visibleRates = state.showAll ? comparableRates : comparableRates.slice(0, 4);
    const countLabel = comparableRates.length === 1 ? "price" : "prices";
    elements.summary.textContent = `${comparableRates.length} comparable ${countLabel}`;
    elements.comparisonDescription.textContent = state.priceType === "gross"
      ? "Hospital and hospital-employed physician charges. Insurance discounts are not applied."
      : "Published discounted cash prices for the coded service. Other provider bills may apply.";

    elements.comparable.replaceChildren();
    visibleRates.forEach((rate, index) => {
      const fullRank = comparableRates.findIndex((item) => item.provider === rate.provider) + 1;
      elements.comparable.append(makeResultEntry(procedure, rate, fullRank, state.priceType));
    });

    const hasHiddenRates = comparableRates.length > 4;
    elements.showAll.hidden = !hasHiddenRates;
    if (hasHiddenRates) {
      elements.showAll.textContent = state.showAll
        ? "Show Fewer Providers"
        : `Show All ${comparableRates.length} Comparable Prices`;
      elements.showAll.setAttribute("aria-expanded", String(state.showAll));
    }

    const showOther = state.priceType === "gross" && procedure.other.length > 0;
    elements.otherSection.hidden = !showOther;
    elements.other.replaceChildren();
    if (showOther) {
      procedure.other.forEach((rate) => {
        elements.other.append(makeResultEntry(procedure, rate, null, "other"));
      });
    }

    renderIncomplete(procedure);
  }

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const matches = findProcedures(elements.search.value);
    if (!matches.length || !normalize(elements.search.value)) {
      elements.searchError.textContent = "This demo has five procedures. Try colonoscopy, mammogram, MRI, CT scan, or carpal tunnel release.";
      elements.search.setAttribute("aria-invalid", "true");
      return;
    }
    elements.search.removeAttribute("aria-invalid");
    selectProcedure(matches[0].id, { focusResults: true });
  });

  elements.search.addEventListener("input", () => {
    elements.search.removeAttribute("aria-invalid");
    elements.searchError.textContent = "";
    renderSuggestions(elements.search.value);
  });

  elements.search.addEventListener("focus", () => renderSuggestions(elements.search.value));

  elements.search.addEventListener("keydown", (event) => {
    const options = Array.from(elements.suggestions.querySelectorAll("[role='option']"));
    if (event.key === "ArrowDown" && options.length) {
      event.preventDefault();
      setActiveSuggestion(state.activeSuggestion + 1);
    } else if (event.key === "ArrowUp" && options.length) {
      event.preventDefault();
      setActiveSuggestion(state.activeSuggestion - 1);
    } else if (event.key === "Enter" && state.activeSuggestion >= 0) {
      event.preventDefault();
      selectProcedure(options[state.activeSuggestion].dataset.procedure, { focusResults: true });
    } else if (event.key === "Escape") {
      closeSuggestions();
    }
  });

  elements.suggestions.addEventListener("click", (event) => {
    const option = event.target.closest("[data-procedure]");
    if (option) selectProcedure(option.dataset.procedure, { focusResults: true });
  });

  document.querySelectorAll("#search-help [data-procedure]").forEach((button) => {
    button.addEventListener("click", () => selectProcedure(button.dataset.procedure, { focusResults: true }));
  });

  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".combobox")) closeSuggestions();
  });

  elements.priceType.addEventListener("change", () => {
    state.priceType = elements.priceType.value;
    state.showAll = false;
    renderProcedure();
  });

  elements.sortOrder.addEventListener("change", () => {
    state.sortOrder = elements.sortOrder.value;
    renderProcedure();
  });

  elements.showAll.addEventListener("click", () => {
    state.showAll = !state.showAll;
    renderProcedure();
  });

  elements.results.addEventListener("click", (event) => {
    const button = event.target.closest("[data-detail-target]");
    if (!button) return;
    const detail = document.getElementById(button.dataset.detailTarget);
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    detail.hidden = expanded;
  });

  elements.menuButton.addEventListener("click", () => {
    const expanded = elements.menuButton.getAttribute("aria-expanded") === "true";
    elements.menuButton.setAttribute("aria-expanded", String(!expanded));
    elements.menuButton.setAttribute("aria-label", expanded ? "Open menu" : "Close menu");
    elements.navigation.classList.toggle("is-open", !expanded);
  });

  elements.navigation.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      elements.menuButton.setAttribute("aria-expanded", "false");
      elements.menuButton.setAttribute("aria-label", "Open menu");
      elements.navigation.classList.remove("is-open");
    });
  });

  elements.search.value = procedureById.get(state.procedureId).shortName;
  elements.sortOrder.value = state.sortOrder;
  renderProcedure();
})();
