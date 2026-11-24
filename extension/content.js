// SaafBol content script. Runs in every page and frame.
//  - decides which boxes are "normal text boxes" (chat/comment/message boxes), not search/login/email fields
//  - draws live underlines under slang (amber) and offensive words (red); click a word for a one-click fix
//  - shows a small draggable bot; click it (or press the hotkey) for the full clean-up with stages
(() => {
  "use strict";
  if (window.__saafbolLoaded) return; // guard against double injection
  window.__saafbolLoaded = true;

  // ------------------------------------------------------------------ 0. config (rename / re-key here)
  const BRAND = "SaafBol";
  const HOTKEY = { alt: true, ctrl: false, shift: false, key: "Enter" };
  const HOTKEY_LABEL = "Alt+Enter";
  const HOST = location.hostname;
  // Sites where the bot is OFF until you switch it on from the toolbar popup. Keep in sync with popup.js.
  const DEFAULT_OFF_HOSTS = [/(^|\.)notion\.so$/, /(^|\.)canva\.com$/, /(^|\.)figma\.com$/, /^docs\.google\.com$/];
  const CODE_EDITORS = ".monaco-editor, .cm-editor, .CodeMirror, .ace_editor";
  const SEARCHY = /search|query|login|log-?in|sign-?in|sign-?up|username|password|passcode|otp|captcha|recipient|promo|coupon/i;

  // ------------------------------------------------------------------ 1. state
  let settings = { enabled: true, underline: true, hosts: {} };
  let savedPos = null;          // {fx, fy}: where the user dragged the bot on this site (fractions of the window)
  let lex = null;               // word lists from the local server
  let lexTried = 0;
  let current = null;           // the text box we are attached to
  let snap = null;              // what we sent for the full clean-up (so "Apply" replaces exactly that text)
  let hits = [];                // [{issue, rect}] used to hit-test clicks on underlined words
  let botPos = { x: 0, y: 0 };
  let dragging = false;
  let suppressHit = false;
  let observer = null;
  const ignored = new Set();    // words the user chose to ignore on this page

  const storage = chrome.storage && chrome.storage.local;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function siteAllowed() {
    const m = settings.hosts[HOST];
    if (m === "on") return true;
    if (m === "off") return false;
    return !DEFAULT_OFF_HOSTS.some((re) => re.test(HOST));
  }
  const active = () => settings.enabled && siteAllowed() && current && current.isConnected;

  // ------------------------------------------------------------------ 2. which boxes count? (generic, no per-site selectors)
  function deepActive() {
    let a = document.activeElement; // walk into open shadow roots to the real focused node
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function looksLikeMessageBox(el) {
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "searchbox" || role === "combobox") return false;                 // search bars, Gmail recipients
    const meta = [el.id, el.getAttribute("name"), el.getAttribute("placeholder"), el.getAttribute("aria-label"),
      el.getAttribute("autocomplete"), el.getAttribute("data-testid")].filter(Boolean).join(" ");
    if (SEARCHY.test(meta)) return false;
    if (el.closest("[role=search]")) return false;
    const form = el.closest("form");
    if (form && (form.querySelector("input[type=password]") || /search/i.test(form.getAttribute("action") || ""))) return false; // login / search forms
    if (el instanceof HTMLTextAreaElement && el.maxLength > 0 && el.maxLength < 40) return false; // short fields
    const r = el.getBoundingClientRect();
    return r.width >= 140 && r.height >= 22;
  }

  // Only <textarea> and contenteditable boxes qualify. Single-line <input> fields (search, email, login, names) never do.
  function boxOf(node) {
    if (!(node instanceof HTMLElement)) return null;
    if (node.closest(CODE_EDITORS)) return null;
    let el = null;
    if (node instanceof HTMLTextAreaElement) {
      if (node.readOnly || node.disabled) return null;
      el = node;
    } else if (node.isContentEditable) {
      el = node; // use the OUTERMOST editing host (ChatGPT, Claude, WhatsApp, Gmail...)
      while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
    } else {
      return null;
    }
    return looksLikeMessageBox(el) ? el : null;
  }

  // ------------------------------------------------------------------ 3. reading and writing text safely
  // What has already been cleaned? Per box we remember the text as it was right after the last clean-up, so the next
  // check sends only the sentences that were ADDED or CHANGED since then (never the whole box again).
  const baselines = new WeakMap();

  function blockOf(node, root) {          // nearest block-level ancestor: tells us where a new paragraph starts
    for (let p = node.parentElement; p; p = p.parentElement) {
      if (p === root) return root;
      const d = getComputedStyle(p).display;
      if (d !== "inline" && d !== "contents" && !d.startsWith("inline")) return p;
    }
    return root;
  }

  // The box's text plus, for rich editors, where each text node sits in it (so a span can be turned back into a Range)
  function flatText(el) {
    if (el instanceof HTMLTextAreaElement) return { text: el.value, segs: null };
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    const segs = [];
    let text = "", prev = null, n, budget = 20000;
    while (budget > 0 && (n = walker.nextNode())) {
      if (n.nodeType === 1) { if (n.tagName === "BR") { text += "\n"; prev = "br"; } continue; }
      const block = blockOf(n, el);
      if (prev && prev !== "br" && block !== prev) text += "\n";   // new paragraph = new line
      segs.push({ node: n, start: text.length, end: text.length + n.data.length });
      text += n.data;
      budget -= n.data.length;
      prev = block;
    }
    return { text, segs };
  }

  function trimSpan(text, a, b) {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    return a < b ? { a, b } : null;
  }

  // The span of `cur` that is new or changed compared with `base`, widened to whole sentences. null = nothing new.
  function newRegion(base, cur) {
    if (base === undefined) return trimSpan(cur, 0, cur.length);   // nothing cleaned yet in this box: the whole box
    if (base === cur) return null;
    let p = 0;
    const max = Math.min(base.length, cur.length);
    while (p < max && base[p] === cur[p]) p++;                       // common start
    let q = 0;
    while (q < max - p && base[base.length - 1 - q] === cur[cur.length - 1 - q]) q++;   // common end
    let a = p, b = cur.length - q;                                   // changed span in the current text
    // text added after everything that was already cleaned starts exactly where the old text ended (even if that
    // text has no final full stop); only edits INSIDE old text are widened back to the start of their sentence
    if (p < base.length) while (a > 0 && !/[.!?\n]/.test(cur[a - 1])) a--;
    while (b < cur.length && !/[.!?]/.test(cur[b - 1] || "") && cur[b] !== "\n") b++;   // ...and to its end
    return trimSpan(cur, a, b);
  }

  function rangeFor(flat, a, b) {
    const sa = flat.segs.find((x) => a >= x.start && a < x.end);
    const sb = flat.segs.find((x) => b > x.start && b <= x.end);
    if (!sa || !sb) return null;
    const r = document.createRange();
    r.setStart(sa.node, a - sa.start);
    r.setEnd(sb.node, b - sb.start);
    return r;
  }

  function markHandled(el) {   // after a clean-up: everything now in the box counts as done
    const ws = (t) => t.replace(/\s+/g, " ").trim();
    const now = flatText(el).text;
    baselines.set(el, now);                                       // right away...
    setTimeout(() => {                                            // ...and again once the editor has re-rendered (unless the user typed meanwhile)
      try { const later = flatText(el).text; if (ws(later) === ws(now)) baselines.set(el, later); } catch (_) { /* ignore */ }
    }, 150);
  }

  function snapshot(el) {
    // 1) an explicit selection always wins: the user picked exactly what to check
    if (el instanceof HTMLTextAreaElement) {
      const s = el.selectionStart, e = el.selectionEnd;
      if (s !== e) return { el, kind: "input", sel: true, start: s, end: e, text: el.value.slice(s, e) };
    } else {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed && el.contains(sel.anchorNode)) {
        return { el, kind: "rich", sel: true, range: sel.getRangeAt(0).cloneRange(), text: sel.toString() };
      }
    }
    // 2) otherwise ONLY what is new or changed since the last clean-up
    const flat = flatText(el);
    const kind = el instanceof HTMLTextAreaElement ? "input" : "rich";
    const base = baselines.get(el);
    const reg = newRegion(base, flat.text);
    if (!reg) {
      if (base !== undefined && base !== flat.text) baselines.set(el, flat.text);   // text was only deleted: just resync
      return { el, kind, nothingNew: true, empty: !flat.text.trim(), text: "" };
    }
    if (kind === "input") return { el, kind, start: reg.a, end: reg.b, text: flat.text.slice(reg.a, reg.b) };
    const range = rangeFor(flat, reg.a, reg.b);
    if (!range) return { el, kind, range: null, text: flat.text };  // could not map it back onto the page: whole box
    return { el, kind, range, text: flat.text.slice(reg.a, reg.b) };
  }

  // Replace a range inside a box. spec: textarea => {start,end}; rich => {node,start,end} | {range} | {} (whole box)
  // execCommand goes through the browser's normal editing path, so React / ProseMirror / Lexical editors get a real
  // input event and keep their own state and undo stack (deprecated, but still the most compatible way).
  function editRange(el, kind, spec, text) {
    el.focus();
    let range = null;
    if (kind === "input") {
      el.setSelectionRange(spec.start, spec.end);
    } else {
      range = spec.range;
      if (!range) {
        range = document.createRange();
        if (spec.node) { range.setStart(spec.node, spec.start); range.setEnd(spec.node, spec.end); }
        else range.selectNodeContents(el);
      }
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    let ok = false;
    try { ok = text === "" ? document.execCommand("delete") : document.execCommand("insertText", false, text); } catch (_) { /* fall through */ }
    if (ok) return true;
    if (kind === "input") { // fallback: native value setter (needed for React-controlled boxes), then fire an input event
      const v = el.value;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v.slice(0, spec.start) + text + v.slice(spec.end));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    if (range) {
      range.deleteContents();
      const node = text ? document.createTextNode(text) : null;
      if (node) range.insertNode(node);
      const after = document.createRange();              // leave a plain caret behind, not a selection of the new text
      if (node) after.setStartAfter(node); else after.setStart(range.startContainer, range.startOffset);
      after.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(after);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ 4. UI inside a Shadow DOM (page CSS cannot leak in)
  const BOT_SVG = `
    <svg viewBox="0 0 40 40" width="44" height="44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c6cf6"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs>
      <line x1="20" y1="9" x2="20" y2="4.8" stroke="#7c6cf6" stroke-width="2" stroke-linecap="round"/>
      <circle cx="20" cy="4" r="2.4" fill="#ffd166"/>
      <rect x="2.5" y="19" width="3.5" height="7" rx="1.8" fill="#5b6cf0"/>
      <rect x="34" y="19" width="3.5" height="7" rx="1.8" fill="#5b6cf0"/>
      <rect x="5" y="9" width="30" height="26" rx="11" fill="url(#g)"/>
      <rect x="9" y="14" width="22" height="16" rx="8" fill="#16162b"/>
      <ellipse class="eye" cx="15.5" cy="21.5" rx="2.3" ry="2.6" fill="#7cf5c8"/>
      <ellipse class="eye" cx="24.5" cy="21.5" rx="2.3" ry="2.6" fill="#7cf5c8"/>
      <path d="M17 26 Q20 28.6 23 26" stroke="#7cf5c8" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <circle cx="12.2" cy="26" r="1.5" fill="#ff8fa3" opacity=".65"/>
      <circle cx="27.8" cy="26" r="1.5" fill="#ff8fa3" opacity=".65"/>
    </svg>`;

  const CSS = `
    :host { --bg:#ffffff; --fg:#1d1d28; --muted:#6b7280; --line:#e5e7eb; --soft:#f4f5f9; --accent:#6b63f1;
            --good:#e8f8ef; --shadow:0 12px 40px rgba(20,20,60,.22); }
    :host([data-theme="dark"]) { --bg:#212126; --fg:#ececf1; --muted:#9a9aa8; --line:#34343c; --soft:#2b2b32;
            --good:#16352a; --shadow:0 12px 40px rgba(0,0,0,.55); }
    * { box-sizing: border-box; font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .sq { position: fixed; height: 2px; border-radius: 2px; pointer-events: none; }
    .sq.bad { background: #e5484d; } .sq.slang { background: #f5a524; }
    #bot { position: fixed; width: 44px; height: 44px; display: none; cursor: grab; user-select: none;
           filter: drop-shadow(0 4px 10px rgba(60,60,120,.35)); transition: transform .15s; }
    #bot:hover { transform: translateY(-2px) scale(1.05); }
    #bot.drag { cursor: grabbing; transition: none; transform: scale(1.08); }
    #bot svg { display: block; pointer-events: none; }
    .eye { transform-box: fill-box; transform-origin: center; animation: blink 4.5s infinite; }
    @keyframes blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(.1); } }
    #bot.busy .eye { animation: pulse .7s infinite; }
    @keyframes pulse { 50% { transform: scale(1.4); } }
    @media (prefers-reduced-motion: reduce) { .eye, #bot.busy .eye { animation: none; } #bot { transition: none; } }
    #badge { position: absolute; top: -3px; right: -3px; min-width: 18px; height: 18px; padding: 0 5px; display: none;
             border-radius: 9px; background: #e5484d; color: #fff; font: 700 11px/18px system-ui, sans-serif; text-align: center;
             pointer-events: none; }
    #panel, #card { position: fixed; display: none; background: var(--bg); color: var(--fg); border: 1px solid var(--line);
             border-radius: 14px; box-shadow: var(--shadow); font-size: 13px; line-height: 1.45; animation: pop .14s ease-out; }
    @keyframes pop { from { opacity: 0; transform: translateY(4px) scale(.98); } to { opacity: 1; transform: none; } }
    #panel { width: 372px; max-height: 70vh; overflow: auto; padding: 14px; }
    #card { width: 264px; padding: 12px; }
    .title { font-weight: 700; font-size: 14px; }
    .sub { color: var(--muted); font-size: 11px; margin-bottom: 6px; }
    .label { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 10px 0 4px; }
    .box { background: var(--soft); border-radius: 10px; padding: 10px; white-space: pre-wrap; word-break: break-word; }
    .box.clean { background: var(--good); }
    .note { color: var(--muted); font-size: 12px; margin-top: 8px; word-break: break-word; }
    .row { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
    button.act { border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 8px;
                 padding: 6px 11px; cursor: pointer; font-size: 12px; }
    button.act:hover { background: var(--soft); }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    button.primary:hover { background: var(--accent); filter: brightness(1.1); }
    details summary { cursor: pointer; margin-top: 10px; font-size: 12px; color: var(--muted); }
    .stage { display: flex; gap: 6px; margin: 3px 0; font-size: 12px; }
    .stage-k { color: var(--muted); min-width: 100px; white-space: pre; }
    .stage-v { word-break: break-word; }
    .chip { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; }
    .chip.bad { background: rgba(229,72,77,.13); color: #e5484d; }
    .chip.slang { background: rgba(245,165,36,.18); color: #b7791f; }
    :host([data-theme="dark"]) .chip.slang { color: #f5c26b; }
    .word { font-weight: 700; margin-left: 6px; }
    .tip { color: var(--muted); margin-top: 8px; font-size: 12px; }
  `;

  const uiHost = document.createElement("div");
  uiHost.setAttribute("data-saafbol", "");
  uiHost.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  const root = uiHost.attachShadow({ mode: "closed" });
  try { const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); root.adoptedStyleSheets = [sheet]; }
  catch (_) { const st = document.createElement("style"); st.textContent = CSS; root.append(st); }

  // build DOM with textContent only: text from web pages is untrusted, never put it into innerHTML
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  // buttons must not steal focus/selection from the text box the user is editing
  const keepFocus = (b) => { b.addEventListener("mousedown", (ev) => ev.preventDefault()); return b; };

  const sqLayer = h("div"); sqLayer.id = "sq";
  const bot = h("div"); bot.id = "bot"; bot.title = `${BRAND} (${HOTKEY_LABEL}). Drag me anywhere!`;
  bot.innerHTML = BOT_SVG; // static markup we wrote ourselves, no page data involved
  const badge = h("div"); badge.id = "badge"; bot.append(badge);
  const panel = h("div"); panel.id = "panel";
  const body = h("div"); panel.append(body);
  const card = h("div"); card.id = "card";
  root.append(sqLayer, bot, panel, card);
  document.documentElement.append(uiHost);

  function isDark(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const m = getComputedStyle(n).backgroundColor.match(/rgba?\(([^)]+)\)/);
      if (!m) continue;
      const [r, g, b, a = 1] = m[1].split(",").map(parseFloat);
      if ([r, g, b].some(Number.isNaN) || a < 0.1) continue;
      return 0.299 * r + 0.587 * g + 0.114 * b < 128;
    }
    return !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  }
  const applyTheme = () => uiHost.setAttribute("data-theme", current && isDark(current) ? "dark" : "light");

  // ------------------------------------------------------------------ 5. the bot: position, drag, badge
  function defaultBotPos(r) {
    // perched above the box's top-right corner (clear of send/mic buttons), or tucked inside if there is no room
    const top = Math.max(r.top, 0), right = Math.min(r.right, innerWidth);
    let y = top - 48;
    if (y < 4) y = top + 6;
    return { x: right - 52, y };
  }

  function placeBot() {
    if (!active()) { bot.style.display = "none"; return; }
    const r = current.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.width < 60 || r.height < 16) { bot.style.display = "none"; return; }
    if (!dragging) {
      const p = savedPos ? { x: savedPos.fx * innerWidth, y: savedPos.fy * innerHeight } : defaultBotPos(r);
      botPos = { x: clamp(p.x, 4, innerWidth - 48), y: clamp(p.y, 4, innerHeight - 48) };
    }
    bot.style.display = "block";
    bot.style.left = botPos.x + "px";
    bot.style.top = botPos.y + "px";
    if (panel.style.display === "block") positionPanel();
  }

  function updateBadge(n) {
    badge.textContent = n > 9 ? "9+" : String(n);
    badge.style.display = n > 0 ? "block" : "none";
  }

  // drag with mouse events (not pointer events) so a mousedown preventDefault keeps focus in the text box
  bot.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, start = { ...botPos };
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) { moved = true; dragging = true; bot.classList.add("drag"); closePanel(); closeCard(); }
      botPos = { x: clamp(start.x + dx, 4, innerWidth - 48), y: clamp(start.y + dy, 4, innerHeight - 48) };
      bot.style.left = botPos.x + "px";
      bot.style.top = botPos.y + "px";
    };
    const up = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      bot.classList.remove("drag");
      suppressHit = true; setTimeout(() => { suppressHit = false; }, 0);
      if (moved) {
        dragging = false;
        savedPos = { fx: botPos.x / innerWidth, fy: botPos.y / innerHeight }; // remembered for this site
        if (storage) storage.set({ ["pos:" + HOST]: savedPos });
      } else {
        panel.style.display === "block" ? closePanel() : run();               // a plain click = clean everything
      }
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  });

  // ------------------------------------------------------------------ 6. live underlines (slang = amber, offensive = red)
  function matchText(s) {
    const out = [], taken = [];
    if (lex.slangRe) {
      for (const m of s.matchAll(lex.slangRe)) {
        const key = m[0].toLowerCase();
        if (key.length === 1 && m[0] !== key) continue;            // leave "U.S." alone
        if (ignored.has(key)) continue;
        const a = m.index, b = a + m[0].length;
        out.push({ type: "slang", start: a, end: b, word: m[0], replacement: lex.slang.get(key) });
        taken.push([a, b]);
      }
    }
    for (const m of s.matchAll(/[A-Za-z][A-Za-z']*/g)) {
      const w = m[0].toLowerCase();
      if (!lex.bad.has(w) || lex.ignore.has(w) || ignored.has(w)) continue;
      const a = m.index, b = a + m[0].length;
      if (taken.some(([x, y]) => a < y && b > x)) continue;       // already covered by a slang phrase
      out.push({ type: "bad", start: a, end: b, word: m[0], replacement: null });
    }
    return out.sort((p, q) => p.start - q.start);
  }

  function collectIssues(el) {
    const issues = [];
    if (el instanceof HTMLTextAreaElement) {
      for (const m of matchText(el.value.slice(0, 5000))) issues.push({ ...m, el, kind: "input" });
    } else {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n, budget = 5000;
      while (budget > 0 && (n = walker.nextNode())) {
        budget -= n.data.length;
        for (const m of matchText(n.data)) issues.push({ ...m, el, kind: "rich", node: n });
      }
    }
    return issues;
  }

  // textarea text is not in the DOM, so measure it with an invisible copy ("mirror") placed exactly over the box
  const MIRROR_STYLES = ["boxSizing", "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "letterSpacing",
    "wordSpacing", "textTransform", "textIndent", "textAlign", "lineHeight", "tabSize", "direction", "paddingTop", "paddingRight",
    "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle"];

  function textareaRects(el, issues) {
    const cs = getComputedStyle(el), box = el.getBoundingClientRect();
    const m = document.createElement("div");
    for (const p of MIRROR_STYLES) m.style[p] = cs[p];
    const scrollbar = el.offsetWidth - el.clientWidth - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0);
    m.style.paddingRight = (parseFloat(cs.paddingRight) || 0) + Math.max(scrollbar, 0) + "px"; // text wraps before the scrollbar
    Object.assign(m.style, { position: "fixed", left: box.left + "px", top: box.top + "px", width: box.width + "px",
      height: box.height + "px", overflow: "hidden", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word",
      pointerEvents: "none", margin: "0" });
    const text = el.value, spans = [];
    let pos = 0;
    for (const it of issues) {
      m.append(text.slice(pos, it.start));
      const sp = document.createElement("span");
      sp.textContent = text.slice(it.start, it.end);
      m.append(sp);
      spans.push(sp);
      pos = it.end;
    }
    m.append(text.slice(pos));
    root.append(m);
    m.scrollTop = el.scrollTop;
    m.scrollLeft = el.scrollLeft;
    const rects = spans.map((sp) => [...sp.getClientRects()]);
    m.remove();
    return rects;
  }

  function richRects(it) {
    const r = document.createRange();
    r.setStart(it.node, it.start);
    r.setEnd(it.node, it.end);
    return [...r.getClientRects()];
  }

  function drawSquiggles() {
    sqLayer.replaceChildren();
    hits = [];
    if (!active() || !settings.underline || !lex) { updateBadge(0); return; }
    const box = current.getBoundingClientRect();
    const issues = collectIssues(current);
    const lists = current instanceof HTMLTextAreaElement ? textareaRects(current, issues) : issues.map((it) => richRects(it));
    issues.forEach((it, i) => {
      for (const r of lists[i]) {
        // skip text that is scrolled out of the box
        if (r.width < 2 || r.bottom < box.top || r.top > box.bottom || r.right < box.left || r.left > box.right) continue;
        const d = h("div", "sq " + it.type);
        d.style.cssText = `left:${r.left}px;top:${r.bottom - 2}px;width:${r.width}px`;
        sqLayer.append(d);
        hits.push({ issue: it, rect: r });
      }
    });
    updateBadge(issues.length);
  }

  // ------------------------------------------------------------------ 7. the word card (click an underlined word)
  function closeCard() { card.style.display = "none"; }

  function fixIssue(it) {
    let text = it.replacement == null ? "" : it.replacement;
    const first = it.word[0];
    if (text && first !== first.toLowerCase()) text = text[0].toUpperCase() + text.slice(1); // keep a leading capital
    let end = it.end;
    if (text === "") { // removing a word: also swallow one following space so no double space is left behind
      const src = it.kind === "input" ? it.el.value : it.node.data;
      if (src[end] === " ") end += 1;
    }
    editRange(it.el, it.kind, it.kind === "input" ? { start: it.start, end } : { node: it.node, start: it.start, end }, text);
    closeCard();
    scheduleScan(30);
  }

  function openWordCard({ issue, rect }) {
    const slang = issue.type === "slang";
    card.replaceChildren();
    const head = h("div");
    head.append(h("span", "chip " + issue.type, slang ? "Slang" : "Offensive word"), h("span", "word", "\u201C" + issue.word + "\u201D"));
    card.append(head, h("div", "tip", slang ? "Casual wording. A more formal option:" : "This word may offend. You can remove it."));
    const row = h("div", "row");
    const mk = (label, cls, fn) => { const b = keepFocus(h("button", "act " + cls, label)); b.addEventListener("click", fn); return b; };
    row.append(mk(slang && issue.replacement ? `Use \u201C${issue.replacement}\u201D` : `Remove \u201C${issue.word}\u201D`, "primary", () => fixIssue(issue)));
    if (!slang) row.append(mk("Clean everything", "", () => { closeCard(); run(); }));
    row.append(mk("Ignore", "", () => { ignored.add(issue.word.toLowerCase()); closeCard(); scheduleScan(0); }));
    card.append(row);
    card.style.display = "block";
    card.style.left = clamp(rect.left, 8, innerWidth - 280) + "px";
    const below = rect.bottom + 10;
    card.style.top = (below + 150 > innerHeight ? Math.max(8, rect.top - 140) : below) + "px";
  }

  // click on an underlined word -> card (hit-test by coordinates, so normal clicking and caret placement still work)
  document.addEventListener("mouseup", (e) => {
    if (suppressHit || !hits.length || !current) return;
    const path = e.composedPath();
    if (path.includes(uiHost)) return;
    if (!path.includes(current)) { closeCard(); return; }
    const x = e.clientX, y = e.clientY;
    const hit = hits.find(({ rect: r }) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 2 && y <= r.bottom + 4);
    hit ? openWordCard(hit) : closeCard();
  }, true);

  // ------------------------------------------------------------------ 8. the full clean-up panel (stage-wise view)
  function positionPanel() {
    panel.style.left = clamp(botPos.x - 322, 8, Math.max(8, innerWidth - 380)) + "px";
    if (botPos.y > innerHeight / 2) { panel.style.top = ""; panel.style.bottom = innerHeight - botPos.y + 8 + "px"; }
    else { panel.style.bottom = ""; panel.style.top = botPos.y + 52 + "px"; }
  }
  function openPanel() { applyTheme(); panel.style.display = "block"; closeCard(); positionPanel(); }
  function closePanel() { panel.style.display = "none"; maybeHide(); }
  function setStatus(text) {
    body.replaceChildren(h("div", "title", BRAND), h("div", "note", text));
  }

  function renderResult(data) {
    const mine = snap;                               // this result belongs to THIS check, even if a newer one starts later
    const unchanged = data.clean.trim() === mine.text.trim();
    if (unchanged && !mine.sel) markHandled(mine.el);   // already clean: nothing to apply, count it as done
    body.replaceChildren(h("div", "title", BRAND), h("div", "sub", "Cleaned version of your new text"));
    body.append(h("div", "box clean", data.clean || "(empty)"));
    if (unchanged) body.append(h("div", "note", "Already clean, nothing to change."));
    if (data.flagged.length) body.append(h("div", "note", "Flagged: " + data.flagged.join(", ")));
    body.append(h("div", "note", "Changes: " + data.changes));

    // stage-wise view: a bullet marks the stages that actually changed the text
    const det = h("details");
    det.append(h("summary", "", "Pipeline stages"));
    data.items.forEach((st, i) => {
      if (data.items.length > 1) det.append(h("div", "label", "Sentence " + (i + 1)));
      let prev = st.input;
      for (const [k, v] of Object.entries(st)) {
        const row = h("div", "stage");
        const changed = k !== "input" && v !== prev;
        row.append(h("span", "stage-k", (changed ? "\u2022 " : "  ") + k), h("span", "stage-v", v || "(empty)"));
        det.append(row);
        if (k !== "input") prev = v;
      }
    });
    body.append(det);

    const row = h("div", "row");
    const mk = (label, cls, fn) => { const b = keepFocus(h("button", "act " + cls, label)); b.addEventListener("click", fn); return b; };
    row.append(
      mk("Apply", "primary", () => {
        const spec = mine.kind === "input" ? { start: mine.start, end: mine.end } : (mine.range ? { range: mine.range } : {});
        const ok = editRange(mine.el, mine.kind, spec, data.clean);
        if (ok) { if (!mine.sel) markHandled(mine.el); closePanel(); scheduleScan(30); } else setStatus("Could not write into this editor. Use Copy instead.");
      }),
      mk("Copy", "", () => navigator.clipboard.writeText(data.clean).catch(() => {})),
      mk("\uD83D\uDC4D", "", () => rate(data, 1, mine)),
      mk("\uD83D\uDC4E", "", () => rate(data, -1, mine)),
      mk("Close", "", closePanel)
    );
    body.append(row);
  }

  function rate(data, rating, mine) {
    // saved locally by the server as a small real-world evaluation set (site name only, never the full URL)
    chrome.runtime.sendMessage({ type: "feedback", original: mine.text, clean: data.clean, rating, host: HOST }).catch(() => {});
  }

  let inflight = false;   // LOCK: while one check is being processed, every other click / hotkey press is ignored

  async function run() {
    if (inflight) { openPanel(); return; }          // already processing: just show the panel (it says Checking...)
    if (!current || !current.isConnected) current = boxOf(deepActive());
    if (!current) return;
    closeCard();
    snap = snapshot(current);
    openPanel();
    if (snap.nothingNew) {                          // nothing was added or changed: send NOTHING to the backend
      return setStatus(snap.empty ? "Nothing to check yet." : "Nothing new to check. Type a new sentence, or select text to check it again.");
    }
    if (!snap.text.trim()) return setStatus("Nothing to check yet.");
    inflight = true;
    bot.classList.add("busy");
    setStatus("Checking...");
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "check", text: snap.text });
    } catch (_) {
      return setStatus("The extension was reloaded. Refresh this page.");
    } finally {
      inflight = false;                             // always release the lock, even on errors
      bot.classList.remove("busy");
    }
    if (resp && resp.busy) return setStatus("Still processing the previous request. Please wait a moment.");
    if (resp && resp.empty) return setStatus("Nothing to check yet.");
    if (!resp || !resp.ok) return setStatus("Could not reach the server. Is it running on 127.0.0.1:8000?");
    renderResult(resp.data);
  }

  // ------------------------------------------------------------------ 9. wiring: focus, typing, scrolling, hotkey, settings
  let scanTimer = 0, raf = 0;
  function scheduleDraw() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { try { placeBot(); drawSquiggles(); } catch (_) { /* never break the host page */ } });
  }
  function scheduleScan(delay = 90) { clearTimeout(scanTimer); scanTimer = setTimeout(scheduleDraw, delay); }

  function maybeHide() {
    setTimeout(() => {
      if (dragging || panel.style.display === "block" || card.style.display === "block") return;
      if (!boxOf(deepActive())) { current = null; sqLayer.replaceChildren(); hits = []; updateBadge(0); placeBot(); }
    }, 250);
  }

  function attachObserver(el) {
    if (observer) observer.disconnect();
    observer = null;
    if (!(el instanceof HTMLTextAreaElement)) { // rich editors re-render the DOM; keep underlines in step
      observer = new MutationObserver(() => scheduleScan());
      observer.observe(el, { subtree: true, childList: true, characterData: true });
    }
  }

  async function loadLexicon() {
    if (Date.now() - lexTried < 5000) return;
    lexTried = Date.now();
    try {
      const resp = await chrome.runtime.sendMessage({ type: "lexicon" });
      if (!resp || !resp.ok) return;
      const d = resp.data;
      const slang = new Map(Object.entries(d.slang).map(([k, v]) => [k.toLowerCase(), v]));
      const keys = [...slang.keys()].sort((a, b) => b.length - a.length).map(esc);
      lex = { slang, slangRe: keys.length ? new RegExp("\\b(" + keys.join("|") + ")\\b", "gi") : null,
        bad: new Set(d.bad), ignore: new Set(d.ignore.map((x) => x.toLowerCase())) };
      scheduleScan(0);
    } catch (_) { /* server offline: underlines stay off until it is back */ }
  }

  document.addEventListener("focusin", (e) => {
    const path = e.composedPath();
    if (path.includes(uiHost)) return;               // focus moved into our own UI
    const el = settings.enabled && siteAllowed() ? boxOf(path[0]) : null; // path[0] = real target, even inside open shadow DOM
    if (el) {
      if (el !== current) { closeCard(); closePanel(); }
      current = el;
      attachObserver(el);
      applyTheme();
      if (!lex) loadLexicon();
      scheduleScan(0);
    } else {
      maybeHide();
    }
  }, true);
  document.addEventListener("focusout", () => maybeHide(), true);

  document.addEventListener("input", (e) => {
    if (current && e.composedPath().includes(current)) { closeCard(); scheduleScan(); }
  }, true);
  window.addEventListener("scroll", () => { closeCard(); scheduleDraw(); }, true);
  window.addEventListener("resize", () => scheduleDraw());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeCard(); if (panel.style.display === "block") closePanel(); return; }
    const hot = e.altKey === HOTKEY.alt && e.ctrlKey === HOTKEY.ctrl && e.shiftKey === HOTKEY.shift && e.key === HOTKEY.key;
    if (hot && active() && boxOf(deepActive()) === current) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) run(); }
  }, true);

  function applySettings(next) {
    settings = { enabled: true, underline: true, ...(next || {}) };
    settings.hosts = settings.hosts || {};
    if (!settings.enabled || !siteAllowed()) { current = null; sqLayer.replaceChildren(); hits = []; closePanel(); closeCard(); }
    scheduleScan(0);
  }

  if (storage) {
    chrome.storage.onChanged && chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) applySettings(changes.settings.newValue);
    });
    Promise.resolve(storage.get(["settings", "pos:" + HOST])).then((r) => {
      if (r && r.settings) applySettings(r.settings);
      if (r && r["pos:" + HOST]) savedPos = r["pos:" + HOST];
      const f = boxOf(deepActive()); // the box may already be focused when the page finishes loading
      if (f && settings.enabled && siteAllowed()) { current = f; attachObserver(f); applyTheme(); loadLexicon(); scheduleScan(0); }
    }).catch(() => {});
  }
})();