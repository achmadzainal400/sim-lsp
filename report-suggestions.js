"use strict";

(function () {
  const INPUT_SELECTOR = '#reportForm input[name="location"], #reportForm input[name="object"], #editReportForm input[name="location"], #editReportForm input[name="object"]';
  const MAX_VISIBLE = 20;
  let activeInput = null;
  let blurTimer = null;

  function normalize(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("id-ID");
  }

  function choicesFor(input) {
    if (!input || typeof db === "undefined") return [];
    const source = input.name === "location" ? db.reportLocationOptions : db.reportObjectOptions;
    return normalizeDropdownOptions(source, []);
  }

  function configureInput(input) {
    if (!input || input.dataset.reportSuggestionsReady === "true") return;
    const form = input.form;
    const field = input.closest(".field");
    if (!form || !field || !["reportForm", "editReportForm"].includes(form.id)) return;

    input.dataset.reportSuggestionsReady = "true";
    input.removeAttribute("list");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-autocomplete", "list");

    form.querySelectorAll("datalist").forEach(function (list) { list.remove(); });

    const listbox = document.createElement("div");
    listbox.className = "report-suggestion-list";
    listbox.id = "report-suggestions-" + (input.id || input.name) + "-" + Math.random().toString(36).slice(2, 7);
    listbox.setAttribute("role", "listbox");
    listbox.setAttribute("aria-label", input.name === "location" ? "Saran lokasi terverifikasi" : "Saran objek terverifikasi");
    listbox.hidden = true;
    input.setAttribute("aria-controls", listbox.id);
    input.setAttribute("aria-expanded", "false");
    field.classList.add("report-suggest-field");
    input.insertAdjacentElement("afterend", listbox);
  }

  function listFor(input) {
    const id = input && input.getAttribute("aria-controls");
    return id ? document.getElementById(id) : null;
  }

  function closeList(input) {
    const list = listFor(input);
    if (list) list.hidden = true;
    if (input) {
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
    if (activeInput === input) activeInput = null;
  }

  function openList(input) {
    if (activeInput && activeInput !== input) closeList(activeInput);
    configureInput(input);
    const list = listFor(input);
    if (!list) return;
    activeInput = input;
    renderList(input, list);
  }

  function renderList(input, list) {
    const query = normalize(input.value);
    const choices = choicesFor(input);
    const matches = choices.filter(function (name) { return !query || normalize(name).includes(query); });
    const visible = matches.slice(0, MAX_VISIBLE);
    const title = document.createElement("div");
    title.className = "report-suggestion-heading";
    title.textContent = input.name === "location" ? "Lokasi terverifikasi Admin" : "Objek terverifikasi Admin";
    list.replaceChildren(title);

    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "report-suggestion-empty";
      empty.textContent = query
        ? "Tidak ada saran yang cocok. Nama yang Anda ketik tetap dapat digunakan."
        : "Belum ada pilihan resmi. Nama yang Anda ketik tetap dapat digunakan.";
      list.appendChild(empty);
    } else {
      visible.forEach(function (name, index) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "report-suggestion-option";
        option.id = list.id + "-option-" + index;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        option.dataset.suggestionValue = name;
        option.textContent = name;
        list.appendChild(option);
      });
    }

    if (matches.length > visible.length) {
      const more = document.createElement("div");
      more.className = "report-suggestion-foot";
      more.textContent = "Menampilkan " + visible.length + " dari " + matches.length + " saran. Ketik lagi untuk mempersempit.";
      list.appendChild(more);
    } else if (!query && choices.length) {
      const hint = document.createElement("div");
      hint.className = "report-suggestion-foot";
      hint.textContent = "Ketik untuk mencari, atau pilih salah satu.";
      list.appendChild(hint);
    }

    list.style.top = (input.offsetTop + input.offsetHeight + 4) + "px";
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
  }

  function setActiveOption(input, direction) {
    const list = listFor(input);
    if (!list || list.hidden) return;
    const options = Array.from(list.querySelectorAll("[role=option]"));
    if (!options.length) return;
    const current = options.findIndex(function (option) { return option.getAttribute("aria-selected") === "true"; });
    const next = current < 0 ? (direction > 0 ? 0 : options.length - 1) : Math.max(0, Math.min(options.length - 1, current + direction));
    options.forEach(function (option, index) { option.setAttribute("aria-selected", index === next ? "true" : "false"); });
    input.setAttribute("aria-activedescendant", options[next].id);
    options[next].scrollIntoView({ block: "nearest" });
  }

  function choose(input, value) {
    if (!input) return;
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    closeList(input);
  }

  function configureTree(root) {
    if (!root) return;
    if (root.matches && root.matches(INPUT_SELECTOR)) configureInput(root);
    if (root.querySelectorAll) root.querySelectorAll(INPUT_SELECTOR).forEach(configureInput);
  }

  document.addEventListener("focusin", function (event) {
    const input = event.target.closest && event.target.closest(INPUT_SELECTOR);
    if (input) openList(input);
  });

  document.addEventListener("input", function (event) {
    const input = event.target.closest && event.target.closest(INPUT_SELECTOR);
    if (input) {
      configureInput(input);
      renderList(input, listFor(input));
    }
  });

  document.addEventListener("keydown", function (event) {
    const input = event.target.closest && event.target.closest(INPUT_SELECTOR);
    if (!input) return;
    const list = listFor(input);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!list || list.hidden) openList(input);
      setActiveOption(input, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && list && !list.hidden) {
      const selected = list.querySelector('[role="option"][aria-selected="true"]');
      if (selected) {
        event.preventDefault();
        choose(input, selected.dataset.suggestionValue || selected.textContent || "");
      }
    } else if (event.key === "Escape" && list && !list.hidden) {
      event.preventDefault();
      closeList(input);
    }
  });

  document.addEventListener("click", function (event) {
    const option = event.target.closest && event.target.closest(".report-suggestion-option");
    if (option) {
      event.preventDefault();
      const field = option.closest(".report-suggest-field");
      const input = field && field.querySelector('input[name="location"], input[name="object"]');
      choose(input, option.dataset.suggestionValue || option.textContent || "");
      return;
    }
    if (activeInput && !event.target.closest(".report-suggest-field")) closeList(activeInput);
  });

  document.addEventListener("focusout", function (event) {
    const input = event.target.closest && event.target.closest(INPUT_SELECTOR);
    if (!input) return;
    window.clearTimeout(blurTimer);
    blurTimer = window.setTimeout(function () {
      if (activeInput === input && !input.closest(".field").contains(document.activeElement)) closeList(input);
    }, 160);
  });

  new MutationObserver(function (records) {
    records.forEach(function (record) {
      record.addedNodes.forEach(function (node) { if (node.nodeType === 1) configureTree(node); });
    });
  }).observe(document.body, { childList: true, subtree: true });
  configureTree(document);
})();
