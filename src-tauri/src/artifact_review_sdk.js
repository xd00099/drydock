/*
 * Drydock artifact review SDK.
 *
 * Injected by the artifact:// scheme handler into every served HTML artifact so
 * the user can annotate elements and selected text and send inline feedback to
 * the session (see docs/artifact-review.md). Runs inside the sandboxed artifact
 * iframe (opaque origin, no network): its ONLY channel out is postMessage to the
 * parent webview, which relays to the backend. The on-disk artifact file is
 * never modified — this script exists only in Drydock's served copy.
 *
 * Adapted from lavish-axi's artifact-sdk.js
 * (https://github.com/kunchenguid/lavish-axi), MIT License,
 * Copyright (c) 2026 Kun Chen. See THIRD-PARTY-NOTICES.md.
 *
 * IMPORTANT: this file is embedded verbatim inside a <script> tag, so it must
 * never contain the literal closing-script sequence (asserted by a Rust test).
 */
(function () {
  "use strict";
  if (window.__ddArtifactReview) return; // double-injection guard
  window.__ddArtifactReview = true;

  const QUEUE_KEY_FIELD = "_ddQueueKey";
  const MODE_TOGGLE_KEY = "i"; // Cmd/Ctrl+I toggles annotate <-> explore

  let annotationMode = false; // explore by default; the chrome pushes the mode
  let accent = "#f4c95d";
  let hovered = null;
  let selected = null;
  let ignoreNextClick = false;
  let shadow = null;
  let counter = 0;
  const ids = new WeakMap();

  function isModeToggleHotkeyEvent(event) {
    if (event.shiftKey || event.altKey) return false;
    return Boolean(event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === MODE_TOGGLE_KEY;
  }

  // Stable key that collapses unsent updates for the same logical input (radio
  // group, checkbox, text field, or an explicit data-dd-question group). The
  // chrome strips this field before feedback reaches the model.
  function deriveQueueKey(element, options = {}) {
    const str = (v) => (v === null || v === undefined ? "" : String(v));
    const attr = (el, name) => {
      if (!el) return "";
      if (el.getAttribute) {
        const v = el.getAttribute(name);
        if (v !== null && v !== undefined) return v;
      }
      return el[name] || "";
    };
    const tagName = (el) => str(el && (el.tagName || el.nodeName)).toLowerCase();
    const closestMatch = (el, sel) => (el && el.closest ? el.closest(sel) : null);

    function elementPath(el) {
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 6) {
        let part = tagName(node) || "element";
        const id = str(attr(node, "id") || node.id).trim();
        if (id) {
          parts.unshift(part + "#" + id);
          break;
        }
        const parentEl = node.parentElement;
        if (parentEl && parentEl.children) {
          const same = [...parentEl.children].filter((c) => tagName(c) === tagName(node));
          if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
        }
        parts.unshift(part);
        node = parentEl;
      }
      return parts.join(" > ");
    }

    function scopeKey(el) {
      const scope = closestMatch(el, "form,fieldset") || (el && el.parentElement) || el;
      const tag = tagName(scope) || "scope";
      const explicit = str(attr(scope, "data-dd-question") || attr(scope, "id") || attr(scope, "name")).trim();
      if (explicit) return tag + ":" + explicit;
      return elementPath(scope) || tag;
    }

    function controlIdentity(el) {
      const identity = str(attr(el, "name") || attr(el, "id") || (el && el.name)).trim();
      return identity || elementPath(el);
    }

    if (Object.hasOwn(options, "queueKey")) return str(options.queueKey).trim();

    const question = closestMatch(element, "[data-dd-question]");
    const questionKey = str(attr(question, "data-dd-question")).trim();
    if (questionKey) return "question:" + questionKey;

    const tag = tagName(element);
    const type = str(attr(element, "type") || (element && element.type)).toLowerCase();
    const scope = scopeKey(element);

    if (tag === "input" && type === "radio") {
      const name = str(attr(element, "name") || (element && element.name)).trim();
      return name ? "radio:" + scope + ":" + name : "";
    }
    if (tag === "input" && type === "checkbox") {
      const identity = controlIdentity(element);
      const explicitValue = str(element && element.getAttribute ? element.getAttribute("value") : "").trim();
      const option = explicitValue || str(attr(element, "id") || elementPath(element)).trim();
      return identity ? "checkbox:" + scope + ":" + identity + ":" + option : "";
    }
    const keyedInput = !new Set(["button", "submit", "reset", "file", "image", "hidden", "radio", "checkbox"]).has(type);
    if (tag === "select" || tag === "textarea" || (tag === "input" && keyedInput)) {
      const identity = controlIdentity(element);
      if (identity) return "field:" + scope + ":" + identity;
    }
    return "";
  }

  // Native controls stay interactive (toggle/focus/type) instead of annotating,
  // same as elements the artifact author marks data-dd-action.
  function isInteractiveControl(el) {
    return !!(
      el &&
      el.closest &&
      el.closest("button,input,select,textarea,option,optgroup,label,summary,[contenteditable]:not([contenteditable='false'])")
    );
  }
  function isDdUi(el) {
    return !!(el && el.closest && el.closest("[data-dd-ui]"));
  }
  function isDdAction(el) {
    return !!(el && el.closest && el.closest("[data-dd-action]"));
  }

  // ---- identity: uid / selector / context -----------------------------------

  function uid(el) {
    if (!ids.has(el)) ids.set(el, String(++counter));
    return ids.get(el);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }

  function selector(el) {
    if (!el || !el.tagName) return "";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + "#" + CSS.escape(node.id));
        break;
      }
      const parentEl = node.parentElement;
      if (parentEl) {
        const same = [...parentEl.children].filter((x) => x.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parentEl;
    }
    return parts.join(" > ");
  }

  function context(el) {
    return {
      uid: uid(el),
      selector: selector(el),
      tag: (el.tagName || "").toLowerCase(),
      text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240),
    };
  }

  // ---- text-range selection ---------------------------------------------------

  function closestElement(node) {
    if (!node) return document.body;
    if (node.nodeType === 1) return node;
    return node.parentElement || document.body;
  }

  function nodePath(node, root) {
    const path = [];
    let current = node;
    while (current && current !== root) {
      const parentNode = current.parentNode;
      if (!parentNode) break;
      path.unshift([...parentNode.childNodes].indexOf(current));
      current = parentNode;
    }
    return path;
  }

  function rangeBoundary(node, offset) {
    const el = closestElement(node);
    return { selector: selector(el), path: nodePath(node, el), offset: Number(offset) || 0 };
  }

  function textSelectionContext(sel) {
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const text = sel.toString().trim().replace(/\s+/g, " ");
    if (range.collapsed || !text) return null;
    const ancestor = closestElement(range.commonAncestorContainer);
    if (isDdUi(ancestor) || isDdAction(ancestor) || isInteractiveControl(ancestor)) return null;
    const commonAncestorSelector = selector(ancestor);
    return {
      uid: "",
      selector: commonAncestorSelector,
      tag: "text",
      text: text.slice(0, 240),
      target: {
        type: "text-range",
        text: text.slice(0, 2000), // anchors locate the range; no need to ship a whole document
        selector: commonAncestorSelector,
        commonAncestorSelector,
        start: rangeBoundary(range.startContainer, range.startOffset),
        end: rangeBoundary(range.endContainer, range.endOffset),
      },
      element: ancestor,
      range: range.cloneRange(),
    };
  }

  // ---- highlights + annotation card (shadow DOM, unstylable by the artifact) --

  function highlightElement(el) {
    if (!el) return;
    el.style.outline = "2px solid " + accent;
    el.style.outlineOffset = "2px";
  }
  function clearHighlight(el) {
    if (el) el.style.outline = "";
  }
  function clearTextHighlight() {
    if (!shadow) return;
    for (const el of [...shadow.querySelectorAll(".dd-text-highlight")]) el.remove();
  }
  function highlightTextRange(range) {
    clearTextHighlight();
    const root = ensureShadow();
    for (const rect of [...range.getClientRects()]) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const mark = document.createElement("div");
      mark.className = "dd-text-highlight";
      mark.style.left = rect.left + "px";
      mark.style.top = rect.top + "px";
      mark.style.width = rect.width + "px";
      mark.style.height = rect.height + "px";
      mark.style.background = accent;
      root.appendChild(mark);
    }
  }

  function ensureShadow() {
    if (shadow) return shadow;
    const host = document.createElement("div");
    host.setAttribute("data-dd-ui", "annotation-root");
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent =
      ":host{all:initial;position:fixed;z-index:2147483647;left:0;top:0;color-scheme:dark;font-family:system-ui,-apple-system,sans-serif}" +
      "*{box-sizing:border-box}" +
      ".dd-text-highlight{position:fixed;pointer-events:none;opacity:.28;border-radius:2px}" +
      ".dd-annotation-card{position:fixed;width:min(320px,calc(100vw - 24px));padding:12px;border-radius:10px;background:#161c25;color:#e8edf4;border:1px solid " + accent + ";box-shadow:0 20px 70px rgba(0,0,0,.45);font:13px/1.4 system-ui,-apple-system,sans-serif}" +
      ".dd-heading{font-weight:700;margin-bottom:6px}" +
      ".dd-annotation-card textarea{width:100%;min-height:80px;resize:vertical;border-radius:6px;border:1px solid #2c3647;background:#10141a;color:#e8edf4;padding:8px;font:inherit}" +
      ".dd-annotation-card textarea::placeholder{color:#7a8494}" +
      ".dd-hint{margin-top:6px;font-size:11px;color:#7a8494}" +
      ".dd-row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}" +
      ".dd-annotation-card button{border:0;border-radius:6px;padding:7px 10px;font-size:12px;font-weight:700;cursor:pointer}" +
      ".dd-annotation-card button:active{opacity:.85}" +
      ".dd-queue{background:" + accent + ";color:#17130a}" +
      ".dd-cancel{background:#2a2f3a;color:#e8edf4}";
    shadow.appendChild(style);
    return shadow;
  }

  function closeCard() {
    if (shadow) {
      for (const el of [...shadow.querySelectorAll(".dd-annotation-card")]) el.remove();
    }
    clearHighlight(hovered);
    clearHighlight(selected);
    hovered = null;
    clearTextHighlight();
    selected = null;
  }

  function cardIsOpen() {
    return !!(shadow && shadow.querySelector(".dd-annotation-card"));
  }

  function showAnnotationCard(target, options = {}) {
    const root = ensureShadow();
    closeCard();
    const c = options.context || context(target);
    let anchor = target;
    if (options.range) {
      highlightTextRange(options.range);
    } else {
      selected = anchor;
      highlightElement(selected);
    }
    const rect = options.range ? options.range.getBoundingClientRect() : anchor.getBoundingClientRect();
    const card = document.createElement("div");
    card.className = "dd-annotation-card";
    const heading = c.tag === "text" ? "Annotate text" : "Annotate &lt;" + escapeHtml(c.tag) + "&gt;";
    const placeholder = c.tag === "text" ? "Tell Claude what to change about this text..." : "Tell Claude what to change about this element...";
    card.innerHTML =
      '<div class="dd-heading">' + heading + "</div>" +
      '<textarea placeholder="' + placeholder + '"></textarea>' +
      '<div class="dd-hint">Enter to queue &middot; send from the review panel</div>' +
      '<div class="dd-row"><button class="dd-cancel" type="button">Cancel</button><button class="dd-queue" type="button">Queue</button></div>';
    root.appendChild(card);

    const left = Math.min(Math.max(12, rect.left), window.innerWidth - card.offsetWidth - 12);
    const top = Math.min(Math.max(12, rect.bottom + 8), window.innerHeight - card.offsetHeight - 12);
    card.style.left = left + "px";
    card.style.top = top + "px";

    const textarea = card.querySelector("textarea");
    const cancelButton = card.querySelector(".dd-cancel");
    const queueButton = card.querySelector(".dd-queue");
    if (!textarea || !cancelButton || !queueButton) return;
    cancelButton.onclick = closeCard;
    queueButton.onclick = () => {
      const prompt = textarea.value.trim();
      if (prompt) queuePrompt(prompt, { ...c, queueKey: "" });
      closeCard();
    };
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        // Queue only — SENDING always happens in the trusted review panel. The
        // chrome cannot tell a user keystroke in this card from artifact
        // script, so an in-frame "send now" would let a hostile artifact
        // deliver forged feedback to the model with no human gesture.
        queueButton.click();
      }
    });
    setTimeout(() => textarea.focus(), 0);
  }

  // ---- mode + outbound API ------------------------------------------------------

  function setAnnotationMode(enabled) {
    annotationMode = !!enabled;
    let style = document.getElementById("dd-cursor-style");
    if (annotationMode && !style) {
      style = document.createElement("style");
      style.id = "dd-cursor-style";
      style.textContent =
        "*{cursor:default!important}" +
        "[data-dd-action],[data-dd-action] *{cursor:pointer!important}" +
        "input,textarea,[contenteditable]:not([contenteditable='false']){cursor:text!important}" +
        "button,select,label,option,input[type='button'],input[type='submit'],input[type='reset'],input[type='checkbox'],input[type='radio'],input[type='file'],input[type='color'],input[type='range'],input[type='image']{cursor:pointer!important}";
      document.head.appendChild(style);
    }
    if (!annotationMode && style) style.remove();
    if (!annotationMode) closeCard();
  }

  function queuePrompt(prompt, options = {}) {
    const originElement = options.element || document.activeElement || document.body;
    const item = { ...context(originElement), prompt: String(prompt || "") };
    const queueKey = deriveQueueKey(originElement, options);
    if (queueKey) item[QUEUE_KEY_FIELD] = String(queueKey);
    if (options.uid) item.uid = String(options.uid);
    if (options.selector) item.selector = String(options.selector);
    if (options.tag) item.tag = String(options.tag);
    if (options.text) item.text = String(options.text);
    if (options.target) item.target = options.target;
    if (options.data) item.prompt += "\n\nContext data:\n" + JSON.stringify(options.data, null, 2);
    parent.postMessage({ type: "dd-artifact:queuePrompt", prompt: item }, "*");
  }

  function sendQueued() {
    parent.postMessage({ type: "dd-artifact:sendQueued" }, "*");
  }

  function endReview() {
    parent.postMessage({ type: "dd-artifact:endReview" }, "*");
  }

  function snapshot() {
    const lines = [];
    function walk(el, depth) {
      if (!(el instanceof Element) || depth > 6 || isDdUi(el)) return;
      const c = context(el);
      const name = c.text ? ' "' + c.text.slice(0, 80).replace(/"/g, "'") + '"' : "";
      lines.push("  ".repeat(depth) + "uid=" + c.uid + " " + c.tag + name);
      for (const child of el.children) walk(child, depth + 1);
    }
    walk(document.body, 0);
    return lines.join("\n");
  }

  // ---- layout audit -------------------------------------------------------------
  // Three subtle failure modes are deliberately handled here (each learned the
  // hard way upstream): (1) wrapped inline elements report one bounding rect
  // spanning both lines, so overlap must compare per-line getClientRects()
  // fragments; (2) overflow:visible spills bubble scrollHeight up through every
  // unconstrained ancestor, so only the innermost element of a same-edge chain
  // is reported; (3) overlapping-text stays "warning" severity — it is heuristic.

  const auditEpsilon = 1;
  const auditErrorPx = 4;
  const auditSettleMs = 180;
  const auditMaxWaitMs = 2000;
  let auditTimer = 0;
  let auditRun = 0;
  let lastAuditSignature = null;

  function toPixelNumber(value) {
    const parsed = Number.parseFloat(String(value || "0"));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function roundedOverflowPx(value) {
    return Math.round(Math.max(0, Number(value) || 0) * 10) / 10;
  }
  function overflowSeverity(px) {
    return px > auditErrorPx ? "error" : "warning"; // strictly-greater, like upstream
  }

  function fragmentsSignificantlyOverlap(fragmentsA, fragmentsB, opts = {}) {
    const minAreaRatio = opts.minAreaRatio || 0.25;
    const minAreaPx = opts.minAreaPx || 24;
    const areaOf = (r) => Math.max(0, r.width) * Math.max(0, r.height);
    const intersect = (a, b) => {
      const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return w * h;
    };
    for (const a of fragmentsA) {
      const threshold = Math.min(areaOf(a) * minAreaRatio, minAreaPx);
      for (const b of fragmentsB) {
        if (intersect(a, b) >= threshold) return true;
      }
    }
    return false;
  }

  function classifyHorizontalOverflow({ scrollWidth, clientWidth, overflowX, hasText, isTruncated }) {
    const overflowPx = clientWidth > 0 ? scrollWidth - clientWidth : 0;
    if (overflowPx <= auditEpsilon) return null;
    const clipsText = hasText && (overflowX === "hidden" || overflowX === "clip") && !isTruncated;
    return { overflowPx, kind: clipsText ? "clipped-text" : "element-scroll-overflow" };
  }

  function classifyVerticalOverflow({ scrollHeight, clientHeight, overflowY, hasText, isTruncated }) {
    const overflowPx = clientHeight > 0 ? scrollHeight - clientHeight : 0;
    if (overflowPx <= auditEpsilon) return null;
    const scrollable = overflowY === "auto" || overflowY === "scroll";
    if (scrollable || !hasText || isTruncated) return null;
    const clips = overflowY === "hidden" || overflowY === "clip";
    return { overflowPx, kind: "clipped-text", clips };
  }

  // A visible spill bubbles into every unconstrained ancestor: keep only the
  // innermost element of each chain sharing the same spill bottom edge.
  function resolveVisibleSpillCandidates(spillCandidates) {
    const bottomOf = (c) => {
      const explicit = Number(c.spillBottom); // coerce BEFORE the finiteness check (upstream parity)
      if (Number.isFinite(explicit)) return explicit;
      const rectBottom = Number(c.rect && c.rect.bottom);
      const overflowPx = Number(c.overflowPx);
      if (!Number.isFinite(rectBottom) || !Number.isFinite(overflowPx)) return null;
      return rectBottom + overflowPx;
    };
    const sameEdge = (a, b) => {
      const ab = bottomOf(a);
      const bb = bottomOf(b);
      return ab !== null && bb !== null && Math.abs(ab - bb) <= auditEpsilon;
    };
    return spillCandidates.filter(
      (candidate) => !spillCandidates.some((other) => other.el !== candidate.el && candidate.el.contains(other.el) && sameEdge(candidate, other))
    );
  }

  function elementText(el) {
    return String((el && (el.innerText || el.textContent)) || "").trim().replace(/\s+/g, " ");
  }
  function hasReadableText(el) {
    return elementText(el).length > 0;
  }
  function rectArea(rect) {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }
  function isVisibleForAudit(el, rect = el.getBoundingClientRect()) {
    if (!el || isDdUi(el) || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }
  function isIntentionalHorizontalScroller(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const overflowX = getComputedStyle(el).overflowX;
    return overflowX === "auto" || overflowX === "scroll";
  }
  function hasIntentionalScrollerAncestor(el) {
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      if (isIntentionalHorizontalScroller(node)) return true;
      node = node.parentElement;
    }
    return false;
  }
  function isIntentionalTruncation(style) {
    return style.textOverflow === "ellipsis" || Number.parseInt(style.webkitLineClamp || "0", 10) > 0;
  }

  function contentBoxRect(el) {
    const rect = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      left: rect.left + toPixelNumber(s.borderLeftWidth) + toPixelNumber(s.paddingLeft),
      right: rect.right - toPixelNumber(s.borderRightWidth) - toPixelNumber(s.paddingRight),
      top: rect.top + toPixelNumber(s.borderTopWidth) + toPixelNumber(s.paddingTop),
      bottom: rect.bottom - toPixelNumber(s.borderBottomWidth) - toPixelNumber(s.paddingBottom),
    };
  }

  function collectAuditElements() {
    const elements = [];
    function walk(el) {
      if (!(el instanceof Element) || isDdUi(el)) return;
      if (isIntentionalHorizontalScroller(el)) return;
      elements.push(el);
      for (const child of el.children) walk(child);
    }
    if (document.body) walk(document.body);
    return elements;
  }

  function pushFinding(findings, seen, finding) {
    const sel = finding.selector || "";
    const key = finding.kind + ":" + sel;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      selector: sel,
      kind: String(finding.kind || "layout-warning"),
      overflowPx: roundedOverflowPx(finding.overflowPx),
      viewportWidth: Math.round(Number(finding.viewportWidth) || window.innerWidth || 0),
      severity: finding.severity === "warning" ? "warning" : "error",
    });
  }

  function auditElementOverflow(el, viewportWidth, findings, seen, spillCandidates) {
    if (el === document.body || el === document.documentElement || hasIntentionalScrollerAncestor(el)) return;
    const rect = el.getBoundingClientRect();
    if (!isVisibleForAudit(el, rect)) return;
    const style = getComputedStyle(el);
    const hasText = hasReadableText(el);
    const isTruncated = isIntentionalTruncation(style);

    const horizontal = classifyHorizontalOverflow({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: style.overflowX,
      hasText,
      isTruncated,
    });
    if (horizontal) {
      pushFinding(findings, seen, {
        selector: selector(el),
        kind: horizontal.kind,
        overflowPx: horizontal.overflowPx,
        viewportWidth,
        severity: horizontal.kind === "clipped-text" ? "error" : overflowSeverity(horizontal.overflowPx),
      });
    }

    const vertical = classifyVerticalOverflow({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: style.overflowY,
      hasText,
      isTruncated,
    });
    if (vertical) {
      if (vertical.clips) {
        pushFinding(findings, seen, {
          selector: selector(el),
          kind: vertical.kind,
          overflowPx: vertical.overflowPx,
          viewportWidth,
          severity: "error",
        });
      } else {
        spillCandidates.push({
          el,
          selector: selector(el),
          overflowPx: vertical.overflowPx,
          viewportWidth,
          spillBottom: rect.bottom + vertical.overflowPx,
        });
      }
    }

    const parentEl = el.parentElement;
    if (!parentEl || parentEl === document.body || parentEl === document.documentElement) return;
    if (hasIntentionalScrollerAncestor(parentEl)) return;
    const parentBox = contentBoxRect(parentEl);
    const parentOverflowPx = rect.right - parentBox.right;
    if (parentOverflowPx > auditEpsilon && rectArea(rect) > 1) {
      const positionedOffCanvas = style.position === "absolute" || style.position === "fixed" || style.position === "sticky";
      pushFinding(findings, seen, {
        selector: selector(el),
        kind: "element-parent-overflow",
        overflowPx: parentOverflowPx,
        viewportWidth,
        severity: positionedOffCanvas ? "warning" : overflowSeverity(parentOverflowPx),
      });
    }
  }

  function resolveSpillCandidates(spillCandidates, findings, seen) {
    for (const candidate of resolveVisibleSpillCandidates(spillCandidates)) {
      pushFinding(findings, seen, {
        selector: candidate.selector,
        kind: "clipped-text",
        overflowPx: candidate.overflowPx,
        viewportWidth: candidate.viewportWidth,
        severity: "error",
      });
    }
  }

  function elementLineFragments(el) {
    const rects = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (rects.length) return rects;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? [rect] : [];
  }

  function auditOverlappingText(elements, viewportWidth, findings, seen) {
    const candidates = elements
      .filter((el) => el.children.length === 0 && hasReadableText(el))
      .filter((el) => isVisibleForAudit(el))
      .filter((el) => getComputedStyle(el).position === "static")
      .slice(0, 200);
    for (const el of candidates) {
      const fragments = elementLineFragments(el);
      let flagged = false;
      for (const rect of fragments) {
        if (flagged) break;
        if (rectArea(rect) < 16) continue;
        const points = [
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          { x: rect.left + Math.min(4, rect.width / 2), y: rect.top + Math.min(4, rect.height / 2) },
          { x: rect.right - Math.min(4, rect.width / 2), y: rect.bottom - Math.min(4, rect.height / 2) },
        ];
        for (const point of points) {
          if (point.x < 0 || point.y < 0 || point.x > viewportWidth || point.y > window.innerHeight) continue;
          const top = document.elementFromPoint(point.x, point.y);
          if (!(top instanceof Element) || top === el || el.contains(top) || top.contains(el) || isDdUi(top)) continue;
          if (hasIntentionalScrollerAncestor(top)) continue;
          if (getComputedStyle(top).position !== "static") continue;
          if (!fragmentsSignificantlyOverlap([rect], elementLineFragments(top))) continue;
          pushFinding(findings, seen, {
            selector: selector(el),
            kind: "overlapping-text",
            overflowPx: 0,
            viewportWidth,
            severity: "warning", // heuristic + sampled: never holds the gate
          });
          flagged = true;
          break;
        }
      }
    }
  }

  function auditLayout() {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const findings = [];
    const seen = new Set();
    const pageOverflowPx = document.documentElement.scrollWidth - viewportWidth;
    if (pageOverflowPx > auditEpsilon) {
      pushFinding(findings, seen, {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: pageOverflowPx,
        viewportWidth,
        severity: overflowSeverity(pageOverflowPx),
      });
    }
    const elements = collectAuditElements();
    const spillCandidates = [];
    for (const el of elements) auditElementOverflow(el, viewportWidth, findings, seen, spillCandidates);
    resolveSpillCandidates(spillCandidates, findings, seen);
    auditOverlappingText(elements, viewportWidth, findings, seen);
    return findings;
  }

  function waitForFontsReady() {
    try {
      if (document.fonts && document.fonts.ready) return document.fonts.ready.catch(() => {});
    } catch {
      /* ResizeObserver settle below is the safety net */
    }
    return Promise.resolve();
  }

  function waitForAnimationFrames(count) {
    return new Promise((resolve) => {
      function step(remaining) {
        if (remaining <= 0) {
          resolve();
          return;
        }
        const next = () => step(remaining - 1);
        if (window.requestAnimationFrame) window.requestAnimationFrame(next);
        else window.setTimeout(next, 16);
      }
      step(count);
    });
  }

  function waitForResizeSettle() {
    return new Promise((resolve) => {
      let observer = null;
      let settleTimer = 0;
      let maxTimer = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (settleTimer) window.clearTimeout(settleTimer);
        if (maxTimer) window.clearTimeout(maxTimer);
        if (observer) observer.disconnect();
        resolve();
      };
      const scheduleFinish = () => {
        if (settleTimer) window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(finish, auditSettleMs);
      };
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(scheduleFinish);
        const observed = [document.documentElement, document.body, ...[...((document.body && document.body.querySelectorAll("*")) || [])]]
          .filter(Boolean)
          .slice(0, 800);
        for (const el of observed) observer.observe(el);
      }
      scheduleFinish();
      maxTimer = window.setTimeout(finish, auditMaxWaitMs);
    });
  }

  async function runLayoutAudit(runId) {
    await waitForFontsReady();
    await waitForResizeSettle();
    await waitForAnimationFrames(2);
    if (runId !== auditRun) return;
    const layout_warnings = auditLayout();
    const signature = JSON.stringify(layout_warnings);
    if (signature === lastAuditSignature) return;
    lastAuditSignature = signature;
    parent.postMessage({ type: "dd-artifact:layout", layout_warnings }, "*");
  }

  function scheduleLayoutAudit() {
    if (auditTimer) window.clearTimeout(auditTimer);
    const runId = ++auditRun;
    auditTimer = window.setTimeout(() => {
      runLayoutAudit(runId).catch(() => {});
    }, 50);
  }

  function startLayoutAudit() {
    scheduleLayoutAudit();
    window.addEventListener("load", scheduleLayoutAudit, { once: true });
    window.addEventListener("resize", scheduleLayoutAudit, { passive: true });
  }

  // ---- public hook for artifact authors (input playbook pattern) ----------------

  window.dd = {
    queuePrompt,
    sendQueued,
    endReview,
    setStatus: (message) => parent.postMessage({ type: "dd-artifact:status", message: String(message) }, "*"),
    snapshot,
  };

  // ---- wiring --------------------------------------------------------------------

  // Only the parent chrome may drive the SDK, and the accent (concatenated into
  // shadow-DOM CSS) must look like the color the trusted path produces — a
  // sibling frame or the page itself can't restyle or hijack annotation UI.
  const ACCENT_RE = /^(#[0-9a-fA-F]{3,8}|hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+\s*)?\))$/;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const msg = event.data || {};
    if (msg.type === "dd-artifact:setMode") {
      if (typeof msg.accent === "string" && ACCENT_RE.test(msg.accent)) accent = msg.accent;
      setAnnotationMode(msg.enabled);
    }
    if (msg.type === "dd-artifact:requestSnapshot") {
      parent.postMessage({ type: "dd-artifact:snapshot", snapshot: snapshot() }, "*");
    }
  });

  // Capture phase so the hotkey fires no matter where focus is inside the
  // artifact. The SDK owns no mode state; it asks the chrome to toggle the same
  // state its toolbar switch drives. The modifier requirement is what makes
  // preventDefault() safe for plain typing.
  document.addEventListener(
    "keydown",
    (event) => {
      if (!isModeToggleHotkeyEvent(event)) return;
      event.preventDefault();
      parent.postMessage({ type: "dd-artifact:toggleMode" }, "*");
    },
    true
  );

  // An open annotation card claims Escape (close the card, keep the overlay up).
  // Registered on window BEFORE the Esc-forwarder script (which is appended
  // after this SDK), so stopImmediatePropagation() keeps the forwarder from
  // also closing Drydock's full-window overlay on the same keypress.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !cardIsOpen()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeCard();
    },
    true
  );

  document.addEventListener(
    "mouseover",
    (event) => {
      if (!annotationMode || isDdUi(event.target) || isDdAction(event.target) || isInteractiveControl(event.target)) return;
      const target = event.target;
      if (!(target instanceof Element) || target === selected) return;
      if (hovered && hovered !== selected) clearHighlight(hovered);
      hovered = target;
      highlightElement(hovered);
    },
    true
  );

  document.addEventListener(
    "mouseout",
    () => {
      if (hovered && hovered !== selected) {
        clearHighlight(hovered);
        hovered = null;
      }
    },
    true
  );

  document.addEventListener(
    "mouseup",
    (event) => {
      if (!annotationMode || isDdUi(event.target) || isDdAction(event.target) || isInteractiveControl(event.target)) return;
      const c = textSelectionContext(document.getSelection());
      if (!c) return;
      ignoreNextClick = true;
      showAnnotationCard(c.element, { context: c, range: c.range });
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      if (!annotationMode || isDdUi(event.target) || isDdAction(event.target) || isInteractiveControl(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (ignoreNextClick) {
        ignoreNextClick = false;
        return;
      }
      if (event.target instanceof Element) showAnnotationCard(event.target);
    },
    true
  );

  setAnnotationMode(annotationMode);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startLayoutAudit, { once: true });
  } else {
    startLayoutAudit();
  }

  // Tell the chrome we booted so it can push the current mode + accent color.
  parent.postMessage({ type: "dd-artifact:ready" }, "*");
})();
