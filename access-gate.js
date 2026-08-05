(function () {
  "use strict";

  const STORAGE_KEY = "vermontPriceCompareAccess";
  const PASSWORD = "cows";

  function storageAvailable() {
    try {
      const testKey = "__vpc_access_test__";
      window.localStorage.setItem(testKey, "1");
      window.localStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }

  const canStoreAccess = storageAvailable();
  if (canStoreAccess && window.localStorage.getItem(STORAGE_KEY) === "true") {
    document.documentElement.classList.add("access-authenticated");
  }

  function initializeGate() {
    const gate = document.querySelector("#access-gate");
    const form = document.querySelector("#access-gate-form");
    const input = document.querySelector("#access-gate-password");
    const error = document.querySelector("#access-gate-error");
    if (!gate || !form || !input || !error) return;
    if (document.documentElement.classList.contains("access-authenticated")) return;

    const pageElements = Array.from(document.body.children)
      .filter((element) => element !== gate && element.tagName !== "SCRIPT");
    pageElements.forEach((element) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });

    function unlock() {
      if (canStoreAccess) window.localStorage.setItem(STORAGE_KEY, "true");
      document.documentElement.classList.add("access-authenticated");
      pageElements.forEach((element) => {
        element.inert = false;
        element.removeAttribute("aria-hidden");
      });
      document.querySelector(".skip-link")?.focus({ preventScroll: true });
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (input.value.trim().toLowerCase() === PASSWORD) {
        error.textContent = "";
        unlock();
        return;
      }
      error.textContent = "That password did not work. Try again.";
      input.value = "";
      input.focus();
    });

    input.addEventListener("input", () => {
      error.textContent = "";
    });

    gate.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(gate.querySelectorAll("input, button"));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    window.setTimeout(() => input.focus(), 60);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeGate, { once: true });
  } else {
    initializeGate();
  }
})();
