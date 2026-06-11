// Phase G place card UI (new ui/ folder convention).
//
// A self-contained, dependency-injected bottom-sheet "place card" for tappable
// POIs. It renders name, category, rating, structured hours, a tap-to-call phone
// link, a sandboxed website preview (with a new-tab fallback), a photos carousel
// (thumbnail -> lazy full-res), and a Navigate button that calls back into the
// host (which routes through createRoutingRuntime).
//
// Design / security notes (documented inline):
// - All DOM/window access is injected (documentLike, windowLike) so the pure
//   view-model + security helpers below are unit-testable under Node and the
//   factory is drivable from the browser smoke harness.
// - Website preview uses a sandboxed iframe whose sandbox token set NEVER
//   combines allow-scripts with allow-same-origin for third-party content
//   (that combination would let the framed page escape the sandbox). Many sites
//   block framing via X-Frame-Options / CSP frame-ancestors, so a visible
//   "Open site" new-tab fallback is always provided and the iframe falls back
//   automatically on load error/timeout.
// - Accessibility: the card is role="dialog" aria-modal, labelled by its title,
//   traps Tab focus, restores focus on close, and closes on Escape.
// - Privacy: the card holds only bounded place metadata passed in by the host.

const DAY_LABELS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);

// Sandbox tokens that are safe for third-party preview content. allow-same-origin
// is intentionally excluded; combined with allow-scripts it defeats the sandbox.
const DEFAULT_IFRAME_SANDBOX = Object.freeze(["allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox"]);
const DEFAULT_IFRAME_LOAD_TIMEOUT_MS = 4000;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Build a safe tel: href from a phone string, keeping only dialable characters.
// Returns null when no dialable digits remain.
function buildTelHref(phone) {
  if (!isNonEmptyString(phone)) {
    return null;
  }
  // Preserve a single leading +, then digits only.
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (!digits) {
    return null;
  }
  return `tel:${hasPlus ? "+" : ""}${digits}`;
}

// Decide how to preview a website. Returns a plan the renderer consumes:
//   { mode: 'none' } | { mode: 'iframe', url, sandbox } with a guaranteed
// new-tab fallback. Only http(s) URLs are eligible; sandbox never includes
// allow-same-origin alongside allow-scripts.
function resolveWebsitePreviewPlan(website, { sandbox = DEFAULT_IFRAME_SANDBOX } = {}) {
  if (!isNonEmptyString(website)) {
    return { mode: "none", url: null, sandbox: [] };
  }

  let parsed;
  try {
    parsed = new URL(website.trim());
  } catch {
    return { mode: "none", url: null, sandbox: [] };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { mode: "none", url: null, sandbox: [] };
  }

  // Enforce the security invariant: never allow-scripts + allow-same-origin.
  let tokens = Array.from(new Set(sandbox.filter(isNonEmptyString)));
  if (tokens.includes("allow-scripts") && tokens.includes("allow-same-origin")) {
    tokens = tokens.filter((token) => token !== "allow-same-origin");
  }

  return { mode: "iframe", url: parsed.href, sandbox: tokens };
}

function formatClockTime(hhmm) {
  if (!/^\d{4}$/.test(String(hhmm))) {
    return null;
  }
  const hours = Number(String(hhmm).slice(0, 2));
  const minutes = String(hhmm).slice(2);
  const period = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHour}:${minutes} ${period}`;
}

// Turn structured hours ({ periods, weekdayText }) into renderable rows. Prefers
// weekdayText when present; otherwise groups periods by day into time ranges.
function formatHoursRows(hours) {
  if (!hours || typeof hours !== "object") {
    return [];
  }

  if (Array.isArray(hours.weekdayText) && hours.weekdayText.length > 0) {
    return hours.weekdayText.map((text) => ({ dayLabel: null, rangeText: String(text) }));
  }

  const periods = Array.isArray(hours.periods) ? hours.periods : [];
  const byDay = new Map();
  for (const period of periods) {
    const open = formatClockTime(period?.open);
    const close = formatClockTime(period?.close);
    if (open === null || close === null) {
      continue;
    }
    const day = Number(period.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      continue;
    }
    if (!byDay.has(day)) {
      byDay.set(day, []);
    }
    byDay.get(day).push(`${open} – ${close}`);
  }

  return Array.from(byDay.keys())
    .sort((a, b) => a - b)
    .map((day) => ({ dayLabel: DAY_LABELS[day], rangeText: byDay.get(day).join(", ") }));
}

// Compute the next carousel index with wrap-around. Returns 0 for an empty set.
function nextCarouselIndex(count, index, delta) {
  const total = Math.max(0, Math.trunc(Number(count) || 0));
  if (total === 0) {
    return 0;
  }
  const current = Math.trunc(Number(index) || 0);
  const step = Math.trunc(Number(delta) || 0);
  return ((current + step) % total + total) % total;
}

// Build a deterministic, render-ready view model from a place. Pure: no DOM.
function buildPlaceCardViewModel(place) {
  if (!place || typeof place !== "object") {
    return null;
  }

  const ratingValue = typeof place.rating === "number" && Number.isFinite(place.rating) ? place.rating : null;

  return {
    id: isNonEmptyString(place.id) ? place.id : null,
    name: isNonEmptyString(place.name) ? place.name : "Unknown place",
    category: isNonEmptyString(place.category) ? place.category.replace(/_/g, " ") : null,
    rating: ratingValue,
    ratingText: ratingValue === null ? null : `${ratingValue.toFixed(1)} ★`,
    telHref: buildTelHref(place.phone),
    phoneText: isNonEmptyString(place.phone) ? place.phone : null,
    websitePlan: resolveWebsitePreviewPlan(place.website),
    websiteUrl: isNonEmptyString(place.website) ? place.website : null,
    hoursRows: formatHoursRows(place.hours),
    photoRefs: Array.isArray(place.photoRefs) ? place.photoRefs.slice() : [],
    lat: typeof place.lat === "number" ? place.lat : null,
    lon: typeof place.lon === "number" ? place.lon : null,
  };
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "iframe",
  "input:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

// Dependency-injected place card controller. Returns an { open, close, isOpen,
// getDebugMetadata, destroy } API. The host wires onNavigate to its routing
// runtime and getPhotosHandler to the Phase G photos handler.
function createPlaceCard({
  documentLike = typeof document !== "undefined" ? document : null,
  windowLike = typeof window !== "undefined" ? window : null,
  container = null,
  onNavigate = () => {},
  getPhotosHandler = () => null,
  isPhotoGuardDisabled = () => false,
  shouldExposeDebug = () => false,
  openInNewTab = null,
  injectStylesheet = true,
  stylesheetHref = "./styles/place_card.css?v=20260610-phaseg-place-card",
  iframeLoadTimeoutMs = DEFAULT_IFRAME_LOAD_TIMEOUT_MS,
} = {}) {
  if (!documentLike || typeof documentLike.createElement !== "function") {
    throw new Error("createPlaceCard requires a document-like object");
  }

  const host = container || documentLike.body;
  let rootEl = null;
  let activeModel = null;
  let previouslyFocused = null;
  let carouselIndex = 0;
  let keydownHandler = null;
  const diagnostics = { opens: 0, navigateClicks: 0, photoLoads: 0, iframeFallbacks: 0 };

  function ensureStylesheet() {
    if (!injectStylesheet || typeof documentLike.querySelector !== "function") {
      return;
    }
    const head = documentLike.head || documentLike.getElementsByTagName?.("head")?.[0];
    if (!head || documentLike.querySelector(`link[data-dgm-place-card]`)) {
      return;
    }
    const link = documentLike.createElement("link");
    link.rel = "stylesheet";
    link.href = stylesheetHref;
    link.setAttribute("data-dgm-place-card", "true");
    head.appendChild(link);
  }

  function el(tag, props = {}, children = []) {
    const node = documentLike.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) {
        continue;
      }
      if (key === "class") {
        node.className = value;
      } else if (key === "text") {
        node.textContent = value;
      } else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === "dataset" && typeof value === "object") {
        for (const [dataKey, dataValue] of Object.entries(value)) {
          // Mirror DOM dataset semantics: camelCase keys map to data-kebab-case
          // attributes (e.g. photoCount -> data-photo-count).
          const attrName = `data-${dataKey.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`;
          node.setAttribute(attrName, String(dataValue));
        }
      } else {
        node.setAttribute(key, String(value));
      }
    }
    for (const child of [].concat(children)) {
      if (child) {
        node.appendChild(child);
      }
    }
    return node;
  }

  function openWebsiteInNewTab(url) {
    if (typeof openInNewTab === "function") {
      openInNewTab(url);
      return;
    }
    if (windowLike && typeof windowLike.open === "function") {
      // noopener/noreferrer prevents the opened page from accessing window.opener.
      windowLike.open(url, "_blank", "noopener,noreferrer");
    }
  }

  function buildWebsiteSection(model) {
    const plan = model.websitePlan;
    if (plan.mode === "none") {
      return null;
    }

    const newTabButton = el("button", {
      type: "button",
      class: "dgm-place-card__website-newtab",
      "aria-label": `Open ${model.name} website in a new tab`,
      text: "Open site ↗",
      onclick: () => openWebsiteInNewTab(model.websiteUrl),
    });

    const section = el("section", { class: "dgm-place-card__website", "aria-label": "Website preview" }, [newTabButton]);

    const iframe = el("iframe", {
      class: "dgm-place-card__iframe",
      src: plan.url,
      title: `${model.name} website preview`,
      sandbox: plan.sandbox.join(" "),
      referrerpolicy: "no-referrer",
      loading: "lazy",
    });

    // Auto-fallback: if the frame errors or never loads, surface a clear message
    // and rely on the always-present new-tab button.
    let settled = false;
    const markBlocked = () => {
      if (settled) {
        return;
      }
      settled = true;
      diagnostics.iframeFallbacks += 1;
      iframe.classList.add("is-blocked");
      section.classList.add("is-frame-blocked");
      const note = el("p", {
        class: "dgm-place-card__website-note",
        text: "This site can't be previewed here. Use “Open site”.",
      });
      section.appendChild(note);
    };
    iframe.addEventListener("error", markBlocked);
    iframe.addEventListener("load", () => {
      settled = true;
    });
    if (windowLike && typeof windowLike.setTimeout === "function") {
      windowLike.setTimeout(markBlocked, iframeLoadTimeoutMs);
    }

    section.insertBefore(iframe, newTabButton);
    return section;
  }

  function loadPhotoInto(imgEl, photoRef, { fullRes = false } = {}) {
    const handler = getPhotosHandler();
    if (!handler) {
      return;
    }

    if (fullRes && typeof handler.getFullResolution === "function") {
      const full = handler.getFullResolution(photoRef);
      if (full && full.url && !full.skipped) {
        imgEl.src = full.url;
        diagnostics.photoLoads += 1;
      }
      return;
    }

    if (typeof handler.getThumbnail === "function") {
      Promise.resolve(handler.getThumbnail(photoRef))
        .then((thumb) => {
          if (thumb && thumb.dataUrl) {
            imgEl.src = thumb.dataUrl;
            diagnostics.photoLoads += 1;
          }
        })
        .catch(() => {});
    }
  }

  function buildPhotosSection(model) {
    if (model.photoRefs.length === 0) {
      return null;
    }
    carouselIndex = 0;

    const mainImg = el("img", {
      class: "dgm-place-card__photo",
      alt: `${model.name} photo`,
      decoding: "async",
    });

    const guardTripped = isPhotoGuardDisabled() === true;

    const renderCurrent = ({ fullRes = false } = {}) => {
      const ref = model.photoRefs[carouselIndex];
      if (!ref) {
        return;
      }
      if (guardTripped) {
        // Skip heavy decode/network work when the perf guard has tripped.
        mainImg.removeAttribute("src");
        mainImg.classList.add("is-placeholder");
        return;
      }
      mainImg.classList.remove("is-placeholder");
      loadPhotoInto(mainImg, ref, { fullRes });
    };

    const prevButton = el("button", {
      type: "button",
      class: "dgm-place-card__carousel-prev",
      "aria-label": "Previous photo",
      text: "‹",
      onclick: () => {
        carouselIndex = nextCarouselIndex(model.photoRefs.length, carouselIndex, -1);
        renderCurrent();
      },
    });
    const nextButton = el("button", {
      type: "button",
      class: "dgm-place-card__carousel-next",
      "aria-label": "Next photo",
      text: "›",
      onclick: () => {
        carouselIndex = nextCarouselIndex(model.photoRefs.length, carouselIndex, 1);
        renderCurrent();
      },
    });

    // Activating the main photo upgrades the thumbnail to full resolution lazily.
    mainImg.addEventListener("click", () => renderCurrent({ fullRes: true }));

    const controls = el("div", { class: "dgm-place-card__carousel-controls" }, [prevButton, nextButton]);
    const section = el(
      "section",
      {
        class: "dgm-place-card__photos",
        "aria-label": `Photos of ${model.name}`,
        dataset: { photoCount: String(model.photoRefs.length), guard: guardTripped ? "disabled" : "enabled" },
      },
      [mainImg, controls]
    );

    // Lazy first paint: load only the current thumbnail on open.
    renderCurrent();
    return section;
  }

  function buildCard(model) {
    const titleId = "dgm-place-card-title";

    const closeButton = el("button", {
      type: "button",
      class: "dgm-place-card__close",
      "aria-label": "Close place card",
      text: "✕",
      onclick: () => close(),
    });

    const headerChildren = [el("h2", { id: titleId, class: "dgm-place-card__name", text: model.name })];
    const metaParts = [];
    if (model.category) {
      metaParts.push(el("span", { class: "dgm-place-card__category", text: model.category }));
    }
    if (model.ratingText) {
      metaParts.push(el("span", { class: "dgm-place-card__rating", text: model.ratingText }));
    }
    if (metaParts.length > 0) {
      headerChildren.push(el("div", { class: "dgm-place-card__meta" }, metaParts));
    }
    const header = el("header", { class: "dgm-place-card__header" }, [...headerChildren, closeButton]);

    const bodyChildren = [];

    if (model.telHref) {
      bodyChildren.push(
        el("a", {
          class: "dgm-place-card__phone",
          href: model.telHref,
          "aria-label": `Call ${model.name} at ${model.phoneText}`,
          text: `Call ${model.phoneText}`,
        })
      );
    }

    if (model.hoursRows.length > 0) {
      const rows = model.hoursRows.map((row) =>
        el("li", { class: "dgm-place-card__hours-row" }, [
          row.dayLabel ? el("span", { class: "dgm-place-card__hours-day", text: row.dayLabel }) : null,
          el("span", { class: "dgm-place-card__hours-range", text: row.rangeText }),
        ])
      );
      bodyChildren.push(
        el("section", { class: "dgm-place-card__hours", "aria-label": "Opening hours" }, [
          el("h3", { class: "dgm-place-card__section-title", text: "Hours" }),
          el("ul", { class: "dgm-place-card__hours-list" }, rows),
        ])
      );
    }

    const photosSection = buildPhotosSection(model);
    if (photosSection) {
      bodyChildren.push(photosSection);
    }

    const websiteSection = buildWebsiteSection(model);
    if (websiteSection) {
      bodyChildren.push(websiteSection);
    }

    const navigateButton = el("button", {
      type: "button",
      class: "dgm-place-card__navigate",
      "aria-label": `Navigate to ${model.name}`,
      text: "Navigate",
      dataset: { placeId: model.id || "" },
      onclick: () => {
        diagnostics.navigateClicks += 1;
        onNavigate({ id: model.id, name: model.name, lat: model.lat, lon: model.lon });
      },
    });
    bodyChildren.push(el("footer", { class: "dgm-place-card__footer" }, [navigateButton]));

    const body = el("div", { class: "dgm-place-card__body" }, bodyChildren);

    return el(
      "div",
      {
        class: "dgm-place-card",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
      },
      [header, body]
    );
  }

  function getFocusable() {
    if (!rootEl || typeof rootEl.querySelectorAll !== "function") {
      return [];
    }
    return Array.from(rootEl.querySelectorAll(FOCUSABLE_SELECTOR));
  }

  function handleKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const focusable = getFocusable();
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = documentLike.activeElement;
    if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus?.();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus?.();
    }
  }

  function close() {
    if (!rootEl) {
      return false;
    }
    if (keydownHandler) {
      rootEl.removeEventListener("keydown", keydownHandler);
      keydownHandler = null;
    }
    rootEl.remove?.();
    rootEl = null;
    activeModel = null;
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      previouslyFocused.focus();
    }
    previouslyFocused = null;
    return true;
  }

  function open(place) {
    const model = buildPlaceCardViewModel(place);
    if (!model) {
      return null;
    }

    ensureStylesheet();
    close();

    previouslyFocused = documentLike.activeElement || null;
    activeModel = model;
    diagnostics.opens += 1;

    rootEl = buildCard(model);
    keydownHandler = handleKeydown;
    rootEl.addEventListener("keydown", keydownHandler);
    host.appendChild(rootEl);

    // Focus management: move focus into the dialog.
    const focusable = getFocusable();
    const target = rootEl.querySelector?.(".dgm-place-card__close") || focusable[0];
    target?.focus?.();

    return model;
  }

  function getDebugMetadata() {
    if (typeof shouldExposeDebug !== "function" || !shouldExposeDebug()) {
      return null;
    }
    return {
      isOpen: Boolean(rootEl),
      activePlaceId: activeModel?.id || null,
      carouselIndex,
      photoCount: activeModel?.photoRefs.length || 0,
      websiteMode: activeModel?.websitePlan?.mode || null,
      ...diagnostics,
    };
  }

  return {
    open,
    close,
    isOpen: () => Boolean(rootEl),
    getActiveModel: () => activeModel,
    getDebugMetadata,
    destroy: () => close(),
  };
}

export {
  createPlaceCard,
  buildPlaceCardViewModel,
  buildTelHref,
  resolveWebsitePreviewPlan,
  formatHoursRows,
  nextCarouselIndex,
  DEFAULT_IFRAME_SANDBOX,
};
