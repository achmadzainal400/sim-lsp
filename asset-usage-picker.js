"use strict";

(function () {
  const SELECTOR = "#assetUseId";
  const MAX_VISIBLE = 30;
  let activeInput = null;
  let activeIndex = -1;
  let blurTimer = null;

  function normalize(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("id-ID");
  }

  function pickerFor(input) {
    return input && input.closest(".asset-usage-picker");
  }

  function selectFor(input) {
    const picker = pickerFor(input);
    return picker && picker.parentElement && picker.parentElement.querySelector(SELECTOR);
  }

  function syncInput(select) {
    const picker = select && select.parentElement && select.parentElement.querySelector(".asset-usage-picker");
    const input = picker && picker.querySelector("input[role=combobox]");
    if (!input) return;
    const option = select.selectedOptions && select.selectedOptions[0];
    input.value = option ? (option.dataset.display || option.textContent || "") : "";
  }

  function configure(select) {
    if (!select || select.dataset.searchPickerReady === "true") return;
    const field = select.closest(".asset-usage-picker-field");
    if (!field) return;

    select.dataset.searchPickerReady = "true";
    select.classList.add("asset-usage-native-select");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");

    const label = field.querySelector('label[for="assetUseId"]');
    if (label) label.htmlFor = "assetUseSearch";

    const picker = document.createElement("div");
    picker.className = "asset-usage-picker";

    const input = document.createElement("input");
    input.id = "assetUseSearch";
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Cari nama aset atau area…";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-haspopup", "listbox");
    input.setAttribute("aria-expanded", "false");

    const list = document.createElement("div");
    list.className = "asset-usage-options";
    list.id = "assetUseOptions";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Aset yang tersedia");
    list.hidden = true;
    input.setAttribute("aria-controls", list.id);

    const help = document.createElement("small");
    help.className = "asset-usage-picker-help";
    help.textContent = "Ketik nama aset atau area, lalu pilih satu stok yang tersedia.";

    picker.append(input, help, list);
    select.insertAdjacentElement("beforebegin", picker);
    syncInput(select);
  }

  function listFor(input) {
    const picker = pickerFor(input);
    return picker && picker.querySelector(".asset-usage-options");
  }

  function setPopupPosition(input, list) {
    const picker = pickerFor(input);
    const modal = input.closest(".modal");
    const rect = picker.getBoundingClientRect();
    let top = 8;
    let bottom = window.innerHeight - 8;
    if (modal) {
      const modalRect = modal.getBoundingClientRect();
      const stickyHeader = modal.querySelector(".modal-head");
      top = stickyHeader ? Math.max(modalRect.top + 8, stickyHeader.getBoundingClientRect().bottom + 5) : modalRect.top + 8;
      bottom = modalRect.bottom - 8;
    }

    const below = Math.max(0, bottom - rect.bottom - 6);
    const above = Math.max(0, rect.top - top - 6);
    const openUp = below < 180 && above > below;
    const available = openUp ? above : below;
    list.classList.toggle("opens-up", openUp);
    list.style.maxHeight = Math.max(80, Math.min(280, available || 80)) + "px";
  }

  function close(input, restoreValue) {
    const list = listFor(input);
    if (list) list.hidden = true;
    if (input) {
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      if (restoreValue) syncInput(selectFor(input));
    }
    if (activeInput === input) activeInput = null;
    activeIndex = -1;
  }

  function render(input, query) {
    const select = selectFor(input);
    const list = listFor(input);
    if (!select || !list) return;

    const options = Array.from(select.options).map(function (option) {
      return {
        value: option.value,
        label: option.textContent.trim(),
        display: option.dataset.display || option.textContent.trim(),
        current: option.value === select.value
      };
    });
    const needle = normalize(query);
    let matches = options.filter(function (option) { return !needle || normalize(option.label).includes(needle); });
    if (!needle && select.value) {
      matches.sort(function (a, b) { return Number(b.current) - Number(a.current); });
    }

    list.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "asset-usage-picker-message";
    heading.textContent = needle
      ? matches.length + " hasil cocok"
      : (options.length - 1) + " aset tersedia · ketik nama atau area untuk mencari";
    list.appendChild(heading);

    const visible = matches.slice(0, MAX_VISIBLE);
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "asset-usage-picker-message";
      empty.textContent = "Aset tidak ditemukan. Coba nama atau area lain.";
      list.appendChild(empty);
    } else {
      visible.forEach(function (option, index) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "asset-usage-option" + (option.current ? " is-current" : "");
        button.id = list.id + "-option-" + index;
        button.dataset.assetValue = option.value;
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", option.current ? "true" : "false");

        const copy = document.createElement("span");
        copy.className = "asset-usage-option-copy";
        const title = document.createElement("strong");
        title.textContent = option.display || "Tidak menggunakan aset";
        copy.appendChild(title);
        if (option.value) {
          const meta = document.createElement("small");
          meta.textContent = option.label.replace(option.display, "").replace(/^\s*[·—-]\s*/, "");
          copy.appendChild(meta);
        }
        button.appendChild(copy);
        list.appendChild(button);
      });
    }

    if (matches.length > visible.length) {
      const more = document.createElement("div");
      more.className = "asset-usage-picker-message";
      more.textContent = "Menampilkan " + visible.length + " dari " + matches.length + " hasil. Ketik lagi untuk mempersempit.";
      list.appendChild(more);
    }

    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
    setPopupPosition(input, list);
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function open(input, query) {
    if (activeInput && activeInput !== input) close(activeInput, true);
    const select = selectFor(input);
    if (!select) return;
    activeInput = input;
    render(input, query);
  }

  function choose(input, value) {
    const select = selectFor(input);
    if (!select) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    syncInput(select);
    close(input, false);
  }

  function moveActive(input, direction) {
    const list = listFor(input);
    if (!list || list.hidden) return;
    const options = Array.from(list.querySelectorAll("[role=option]"));
    if (!options.length) return;
    activeIndex = activeIndex < 0
      ? (direction > 0 ? 0 : options.length - 1)
      : Math.max(0, Math.min(options.length - 1, activeIndex + direction));
    options.forEach(function (option, index) { option.classList.toggle("is-active", index === activeIndex); });
    input.setAttribute("aria-activedescendant", options[activeIndex].id);
    options[activeIndex].scrollIntoView({ block: "nearest" });
  }

  function configureTree(root) {
    if (!root) return;
    if (root.matches && root.matches(SELECTOR)) configure(root);
    if (root.querySelectorAll) root.querySelectorAll(SELECTOR).forEach(configure);
  }

  document.addEventListener("focusin", function (event) {
    const input = event.target.closest && event.target.closest("#assetUseSearch");
    if (!input) return;
    input.select();
    open(input, "");
  });

  document.addEventListener("input", function (event) {
    const input = event.target.closest && event.target.closest("#assetUseSearch");
    if (input) render(input, input.value);
  });

  document.addEventListener("change", function (event) {
    const select = event.target.closest && event.target.closest(SELECTOR);
    if (select) syncInput(select);
  });

  document.addEventListener("keydown", function (event) {
    const input = event.target.closest && event.target.closest("#assetUseSearch");
    if (!input) return;
    const list = listFor(input);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!list || list.hidden) open(input, input.value);
      moveActive(input, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && list && !list.hidden) {
      event.preventDefault();
      const options = list.querySelectorAll("[role=option]");
      if (activeIndex >= 0 && options[activeIndex]) choose(input, options[activeIndex].dataset.assetValue || "");
      else {
        const select = selectFor(input);
        const exact = Array.from(select.options).find(function (option) { return normalize(option.label) === normalize(input.value); });
        if (exact) choose(input, exact.value);
      }
    } else if (event.key === "Escape" && list && !list.hidden) {
      event.preventDefault();
      close(input, true);
    }
  });

  document.addEventListener("mousedown", function (event) {
    if (event.target.closest && event.target.closest(".asset-usage-option")) event.preventDefault();
  });

  document.addEventListener("click", function (event) {
    const option = event.target.closest && event.target.closest(".asset-usage-option");
    if (option) {
      event.preventDefault();
      const input = option.closest(".asset-usage-picker").querySelector("#assetUseSearch");
      choose(input, option.dataset.assetValue || "");
      return;
    }
    if (activeInput && !event.target.closest(".asset-usage-picker-field")) close(activeInput, true);
  });

  document.addEventListener("focusout", function (event) {
    const input = event.target.closest && event.target.closest("#assetUseSearch");
    if (!input) return;
    window.clearTimeout(blurTimer);
    blurTimer = window.setTimeout(function () {
      if (activeInput === input && !input.closest(".asset-usage-picker").contains(document.activeElement)) close(input, true);
    }, 180);
  });

  function repositionActive() {
    if (!activeInput) return;
    const list = listFor(activeInput);
    if (list && !list.hidden) setPopupPosition(activeInput, list);
  }

  window.addEventListener("resize", repositionActive);
  window.addEventListener("scroll", repositionActive, true);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", repositionActive);

  new MutationObserver(function (records) {
    records.forEach(function (record) {
      record.addedNodes.forEach(function (node) { if (node.nodeType === 1) configureTree(node); });
    });
  }).observe(document.body, { childList: true, subtree: true });
  configureTree(document);
})();
