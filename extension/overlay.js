/* ============================================================================
   zstack — winamp in the z-axis, repurposed as a z-index forensics tool.
   Clean-room engine: preserve-3d rack, eased focus, depth-of-field falloff.
   Power source swapped from FFT visualizers -> the live DOM's stacking layers.
   Idempotent: running this when an overlay exists tears it down.
   ========================================================================== */
(() => {
  const HOST_ID = "__zstack_overlay_host__";
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    existing.__zstack_teardown && existing.__zstack_teardown();
    existing.remove();
    return;
  }

  // ----- tunables -------------------------------------------------------------
  const GAP = 240;                 // z-spacing between planes (px)
  const OUTLIER = 100000;          // |z-index| at or above this = felony
  const MAX_ELEMENTS = 700;        // cap analysed elements for perf
  const PALETTE = ["#39ff14", "#00e5ff", "#ff2d95", "#ffd000", "#7c4dff",
                   "#ff6b35", "#00ffa3", "#ff3860", "#4dd0ff", "#b8ff00",
                   "#ff00e6", "#ffae00"];

  // ----- DOM analysis ---------------------------------------------------------
  const scrollX = window.scrollX, scrollY = window.scrollY;
  const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth, 1);
  const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight, 1);

  const clip = (s, n = 42) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);

  // Returns the CSS declaration that opens a stacking context, or null.
  // Order roughly follows the spec's "establishes a stacking context" list.
  function stackingReason(cs) {
    if (cs.position === "fixed")  return "position: fixed";
    if (cs.position === "sticky") return "position: sticky";
    if ((cs.position === "absolute" || cs.position === "relative") && cs.zIndex !== "auto")
      return `position: ${cs.position} + z-index: ${cs.zIndex}`;
    if (parseFloat(cs.opacity) < 1)                 return `opacity: ${cs.opacity}`;
    if (cs.transform && cs.transform !== "none")    return `transform: ${clip(cs.transform)}`;
    if (cs.filter && cs.filter !== "none")          return `filter: ${clip(cs.filter)}`;
    if (cs.backdropFilter && cs.backdropFilter !== "none") return `backdrop-filter: ${clip(cs.backdropFilter)}`;
    if (cs.perspective && cs.perspective !== "none") return `perspective: ${cs.perspective}`;
    if (cs.mixBlendMode && cs.mixBlendMode !== "normal") return `mix-blend-mode: ${cs.mixBlendMode}`;
    if (cs.isolation === "isolate")                 return "isolation: isolate";
    if (cs.willChange && /transform|opacity|filter|perspective|backdrop/.test(cs.willChange))
      return `will-change: ${cs.willChange}`;
    if (cs.contain && /paint|layout|content|strict/.test(cs.contain)) return `contain: ${cs.contain}`;
    if (cs.clipPath && cs.clipPath !== "none")      return `clip-path: ${clip(cs.clipPath)}`;
    if (cs.maskImage && cs.maskImage !== "none")    return `mask-image: ${clip(cs.maskImage)}`;
    return null;
  }

  function selectorFor(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.classList.length) s += "." + [...el.classList].slice(0, 2).join(".");
    return s.length > 46 ? s.slice(0, 45) + "…" : s;
  }

  // ----- authored z-index lookup (clamp detection) ----------------------------
  // Browsers clamp z-index to the signed 32-bit range. So a CSS value of
  // 1600000000000000000 silently becomes 2147483647 in computed style. We read
  // the *authored* value from the CSSOM to expose the clamp.
  const Z_MAX = 2147483647, Z_MIN = -2147483648;
  const clampZ = (v) => Math.max(Z_MIN, Math.min(Z_MAX, v));

  const zRules = []; // { sel, val } for every rule that sets z-index
  function collectZRules(rules) {
    for (const rule of rules) {
      const t = rule.type;
      if (t === 1) {                                   // CSSStyleRule
        const v = rule.style && rule.style.getPropertyValue("z-index");
        if (v && v !== "auto") {
          const n = parseFloat(v);
          if (!isNaN(n)) zRules.push({ sel: rule.selectorText, val: n });
        }
      } else if (t === 4 || t === 12) {                // @media / @supports
        let on = true;
        try { on = t === 4 ? matchMedia(rule.media.mediaText).matches : CSS.supports(rule.conditionText); } catch {}
        if (on && rule.cssRules) collectZRules(rule.cssRules);
      }
    }
  }
  for (const sheet of document.styleSheets) {
    try { collectZRules(sheet.cssRules); } catch { /* cross-origin sheet — unreadable */ }
  }
  // The authored z-index that applies to el (inline wins; else last matching rule).
  function authoredZ(el) {
    if (el.style && el.style.zIndex && el.style.zIndex !== "auto") {
      const v = parseFloat(el.style.zIndex);
      if (!isNaN(v)) return v;
    }
    let val = null;
    for (const r of zRules) { try { if (el.matches(r.sel)) val = r.val; } catch {} }
    return val;
  }

  // Collect "interesting" elements: anything that affects stacking.
  const candidates = [];
  for (const el of document.querySelectorAll("*")) {
    if (el.id === HOST_ID) continue;
    let cs;
    try { cs = getComputedStyle(el); } catch { continue; }
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 4) continue;

    const z = cs.zIndex;
    const pos = cs.position;
    const znum = z !== "auto" && z !== "" && !isNaN(parseFloat(z)) ? parseFloat(z) : null;
    const scReason = stackingReason(cs);
    const positioned = pos === "fixed" || pos === "sticky" || pos === "absolute";
    // Real image / vector content is worth painting even when it's in normal
    // flow (no z-index, not positioned, opens no stacking context).
    const isMedia = /^(IMG|SVG|CANVAS|VIDEO)$/.test((el.tagName || "").toUpperCase());
    if (znum === null && !positioned && !scReason && !isMedia) continue;

    // Detect int32 clamping (only the boundary values can be a clamp result).
    let authored = null, clamped = false;
    if (znum === Z_MAX || znum === Z_MIN) {
      authored = authoredZ(el);
      if (authored !== null && authored !== znum && clampZ(authored) === znum) clamped = true;
    }

    // Build a human-readable "why is this here" reason.
    let reason = scReason || (positioned ? `position: ${pos}` : "");
    let warn = false;
    if (znum !== null) {
      // z-index only applies to positioned boxes or flex/grid items.
      let inFlexGrid = false;
      try {
        const pcs = el.parentElement && getComputedStyle(el.parentElement);
        inFlexGrid = pcs && /\b(flex|grid|inline-flex|inline-grid)\b/.test(pcs.display);
      } catch {}
      if (clamped) {
        reason = `z-index: ${authored} → clamped to ${znum} (int32 ${znum === Z_MAX ? "max" : "min"})`;
        warn = true;
      } else if (pos === "static" && !inFlexGrid) {
        reason = `z-index: ${z}  ⚠ ignored — position is static`;
        warn = true;
      } else {
        reason = `z-index: ${z}` + (scReason ? `  ·  ${scReason}` : ` (${pos})`);
      }
    }
    if (znum !== null && Math.abs(znum) >= OUTLIER) warn = true;
    let reasonKey = clamped ? "clamped" : (reason.split(/[:\s]/)[0] || "").trim();

    candidates.push({
      el, cs, pos, znum, authored, clamped, warn, reason, reasonKey,
      hasCtx: !!scReason, media: isMedia,
      area: r.width * r.height,
      rect: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height },
      sel: selectorFor(el),
    });
  }
  // keep the biggest / most structural elements if there are too many
  candidates.sort((a, b) => b.area - a.area);
  const kept = candidates.slice(0, MAX_ELEMENTS);

  // Bucket into stacking layers. ordering value -> back(low) .. front(high).
  function bucketOf(c) {
    if (c.znum !== null) return { key: "z:" + c.znum, order: c.znum, label: "z-index: " + c.znum, znum: c.znum };
    if (c.pos === "fixed")    return { key: "fixed",    order: 0.6, label: "fixed (z:auto)",    znum: null };
    if (c.pos === "sticky")   return { key: "sticky",   order: 0.5, label: "sticky (z:auto)",   znum: null };
    if (c.pos === "absolute") return { key: "absolute", order: 0.4, label: "absolute (z:auto)", znum: null };
    if (c.hasCtx)             return { key: "ctx", order: 0.1, label: "stacking context (z:auto)", znum: null };
    return { key: "content", order: 0.05, label: "images & svg (page flow)", znum: null };
  }
  // In-flow media (an <img>/<svg> with no z-index, not positioned, opening no
  // stacking context) paints inside the stacking context of its nearest
  // positioned/z-indexed ancestor — not on a plane of its own. So group it with
  // that ancestor's layer if one exists; otherwise it's true page-flow content.
  const keptByEl = new Map();
  for (const c of kept) keptByEl.set(c.el, c);
  function layerHostFor(c) {
    if (!(c.media && c.znum === null && c.pos !== "fixed" && c.pos !== "sticky" &&
          c.pos !== "absolute" && !c.hasCtx)) return c;      // owns its own layer
    let p = c.el.parentElement;
    while (p) { if (keptByEl.has(p)) return keptByEl.get(p); p = p.parentElement; }
    return c;                                                // no layer ancestor — page flow
  }

  const buckets = new Map();
  for (const c of kept) {
    const b = bucketOf(layerHostFor(c));
    if (!buckets.has(b.key)) buckets.set(b.key, { ...b, items: [] });
    buckets.get(b.key).items.push(c);
  }
  // also a base "page flow" plane representing the document body
  if (document.body) {
    let bcs; try { bcs = getComputedStyle(document.body); } catch { bcs = null; }
    buckets.set("flow", {
      key: "flow", order: -1, label: "page flow (base)", znum: null,
      items: [{ sel: "body", el: document.body, cs: bcs, rect: { x: 0, y: 0, w: docW, h: docH }, znum: null }],
    });
  }

  // front = highest stacking order. plane index 0 = front (the topmost layer).
  const planesMeta = [...buckets.values()].sort((a, b) => b.order - a.order);
  if (planesMeta.length === 0) {
    alert("zstack: no positioned / z-index layers found on this page.");
    return;
  }

  // ----- build the overlay (isolated in a shadow root) ------------------------
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  document.documentElement.appendChild(host);

  // canvas dimensions: full-page silhouette, aspect-matched & clamped
  const cw = 540;
  const ch = Math.max(240, Math.min(760, Math.round(cw * (docH / docW))));
  const FLATW = 300, FLATH = Math.max(120, Math.round(FLATW * (ch / cw)));  // 2D grid tile

  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .wrap {
      position: fixed; inset: 0;
      background: radial-gradient(circle at 50% 32%, #14121f 0%, #050507 78%);
      color: #cfe; font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
      overflow: hidden; cursor: grab; user-select: none;
    }
    .wrap.dragging { cursor: grabbing; }
    #viewport { position: fixed; inset: 0; display: grid; place-items: center;
      perspective: 1600px; perspective-origin: 50% 44%; }
    #stack { position: relative; width: ${cw}px; height: ${ch}px; transform-style: preserve-3d; }
    .layer {
      position: absolute; inset: 0; width: ${cw}px; height: ${ch}px;
      border-radius: 14px; border: 1px solid rgba(255,255,255,.14);
      overflow: hidden; background: rgba(255,255,255,.012);
      box-shadow: 0 24px 70px rgba(0,0,0,.45); will-change: filter, opacity, transform;
    }
    .layer canvas { width: 100%; height: 100%; display: block; }
    .layer .tag {
      position: absolute; top: 10px; left: 12px; font-size: 10px; letter-spacing: 2px;
      text-transform: uppercase; opacity: .75; text-shadow: 0 0 8px currentColor;
      z-index: 2; pointer-events: none; max-width: 92%;
    }
    .layer.felony { border-color: #ff3860 !important; box-shadow: 0 0 40px rgba(255,56,96,.5), 0 24px 70px rgba(0,0,0,.45); }
    .layer.active { border-color: rgba(140,220,255,.95); }
    .layer.active .tag { opacity: 1; }
    #hud { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
      text-align: center; opacity: .92; pointer-events: none; max-width: 90vw; }
    #hud .depth { font-size: 18px; font-weight: 700; color: #8fd0ff; text-shadow: 0 0 14px #2a6; }
    #hud .label { margin-top: 4px; font-size: 13px; color: #e8f6ff; }
    #hud .warn { color: #ff5b78; font-weight: 700; text-shadow: 0 0 10px #ff3860; }
    #hud .keys { margin-top: 8px; font-size: 11px; opacity: .5; }
    kbd { border: 1px solid rgba(255,255,255,.22); border-radius: 5px; padding: 1px 6px; margin: 0 1px; }
    #title { position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
      font-size: 11px; letter-spacing: 2px; opacity: .55; text-transform: uppercase; }
    #close { position: fixed; top: 12px; right: 16px; z-index: 6; font-size: 12px; letter-spacing: 1px;
      color: #cfe; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.2);
      border-radius: 8px; padding: 5px 12px; cursor: pointer; }
    #close:hover { background: rgba(255,255,255,.14); }
    /* pill view toggle (2D / 3D) */
    #viewtoggle { position: fixed; top: 12px; left: 16px; z-index: 3; display: inline-flex;
      border: 1px solid rgba(255,255,255,.2); border-radius: 999px; overflow: hidden;
      background: rgba(255,255,255,.06); font-size: 11px; letter-spacing: 1px; }
    #viewtoggle button { all: unset; padding: 5px 15px; cursor: pointer; color: #cfe; text-align: center; }
    #viewtoggle button.on { background: rgba(140,220,255,.92); color: #061018; font-weight: 700; }
    /* 2D flat grid view — planes tiled in reading order, no perspective */
    .wrap.flat { cursor: default; }
    .wrap.flat #viewport { perspective: none; place-items: start center; overflow: auto; padding: 60px 20px 96px; }
    .wrap.flat #stack { position: static; width: min(100%, 1120px); height: auto;
      transform: none !important; transform-style: flat; display: flex; flex-wrap: wrap;
      gap: 16px; justify-content: center; align-content: flex-start; }
    .wrap.flat .layer { position: relative; inset: auto; flex: 0 0 auto;
      width: ${FLATW}px; height: ${FLATH}px;
      transform: none !important; filter: none !important; opacity: 1 !important; visibility: visible !important; }
    /* click-to-reveal highlight drawn over a plane */
    .layer .hl { position: absolute; z-index: 3; pointer-events: none; border: 2px solid #8fd0ff;
      border-radius: 3px; box-shadow: 0 0 0 2px rgba(0,0,0,.45), 0 0 14px #8fd0ff;
      animation: hlpulse 1s ease-in-out infinite; }
    @keyframes hlpulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
    /* report toggle button */
    #reportbtn { position: fixed; top: 12px; left: 108px; z-index: 6; font-size: 11px; letter-spacing: 1px;
      color: #cfe; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.2);
      border-radius: 999px; padding: 5px 14px; cursor: pointer; }
    #reportbtn.on { background: rgba(140,220,255,.92); color: #061018; font-weight: 700; }
    /* slide-in report panel (mirror of the console report) */
    #panel { position: fixed; top: 0; right: 0; width: 340px; max-width: 86vw; height: 100%;
      background: rgba(6,8,14,.93); border-left: 1px solid rgba(255,255,255,.14);
      overflow-y: auto; padding: 14px 14px 44px; transform: translateX(100%);
      transition: transform .22s ease; z-index: 4; font: 12px/1.55 ui-monospace, monospace; }
    .wrap.showpanel #panel { transform: none; }
    #panel header { margin-bottom: 6px; }
    #panel .h-title { color: #39ff14; font-weight: 700; font-size: 14px; letter-spacing: 2px; }
    #panel .h-sub { color: #8fd0ff; margin-top: 2px; }
    #panel .h-host { color: #7f93a3; font-size: 11px; }
    #panel .section { margin-top: 14px; }
    #panel .sec-h { text-transform: uppercase; letter-spacing: 2px; font-size: 10px; opacity: .5; margin-bottom: 6px; }
    #panel .section.warn { border: 1px solid rgba(255,56,96,.35); border-radius: 8px; padding: 8px; background: rgba(255,56,96,.06); }
    #panel .warn-g { margin-bottom: 8px; }
    #panel .warn-g:last-child { margin-bottom: 0; }
    #panel .wg-h { color: #ff5b78; font-weight: 700; margin-bottom: 3px; }
    #panel .wg-item { padding: 2px 4px; border-radius: 4px; cursor: pointer; }
    #panel .wg-item:hover { background: rgba(255,56,96,.14); }
    #panel .wg-item b { color: #ff8aa0; font-weight: 600; }
    #panel .layer-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
    #panel .layer-row:hover { background: rgba(255,255,255,.06); }
    #panel .layer-row.open { background: rgba(255,255,255,.05); }
    #panel .layer-row.felony .lr-label { color: #ff8aa0; }
    #panel .sw { width: 10px; height: 10px; border-radius: 3px; flex: 0 0 auto; box-shadow: 0 0 6px currentColor; }
    #panel .lr-idx { color: #7f93a3; width: 14px; text-align: right; }
    #panel .lr-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #panel .lr-count { color: #7f93a3; font-size: 11px; flex: 0 0 auto; }
    #panel .items { margin: 2px 0 6px 24px; border-left: 1px solid rgba(255,255,255,.12); padding-left: 8px; }
    #panel .item { padding: 3px 4px; border-radius: 4px; cursor: pointer; }
    #panel .item:hover { background: rgba(140,220,255,.14); }
    #panel .item.warn .it-sel { color: #ff8aa0; }
    #panel .it-sel { color: #cfe; }
    #panel .it-reason { color: #7f93a3; display: block; font-size: 11px; }
  </style>
  <div class="wrap">
    <div id="title">zstack · ${planesMeta.length} stacking layers · ${kept.length} elements</div>
    <button id="close">esc ✕ close</button>
    <div id="viewtoggle">
      <button id="v3d" class="on">3D</button>
      <button id="v2d">2D</button>
    </div>
    <button id="reportbtn" class="on">☰ report</button>
    <div id="viewport"><div id="stack"></div></div>
    <aside id="panel"></aside>
    <div id="hud">
      <div class="depth">focus → layer <span id="cur">0</span> / ${planesMeta.length - 1}</div>
      <div class="label" id="lbl"></div>
      <div class="keys">
        <kbd>↑</kbd><kbd>↓</kbd>/scroll focus · drag orbit · <kbd>V</kbd> 2D/3D · <kbd>L</kbd> report · <kbd>P</kbd> paint/wire · <kbd>R</kbd> snap · <kbd>0</kbd> reset · <kbd>esc</kbd> close
      </div>
    </div>
  </div>`;

  const stack = root.getElementById("stack");
  const curEl = root.getElementById("cur");
  const lblEl = root.getElementById("lbl");
  const wrap = root.querySelector(".wrap");

  // ----- view: "3d" orbiting rack  ·  "2d" flat tiled grid --------------------
  const btn3d = root.getElementById("v3d");
  const btn2d = root.getElementById("v2d");
  let view = "3d";
  function setView(v) {
    view = v;
    wrap.classList.toggle("flat", v === "2d");
    btn3d.classList.toggle("on", v === "3d");
    btn2d.classList.toggle("on", v === "2d");
  }
  btn3d.addEventListener("click", () => setView("3d"));
  btn2d.addEventListener("click", () => setView("2d"));

  // ----- rendering: two modes -------------------------------------------------
  // "paint": draw each element's real bg/border/image/text from computed style.
  // "wire" : glowing outline + selector label (the original forensic look).
  let mode = "paint";
  const SX = cw / docW, SY = ch / docH;   // doc-px -> plane-px scale

  // The real page background. Paint planes are backed with this so transparent /
  // pale images (e.g. decorative PNGs authored for a white page) stay visible
  // instead of vanishing into the dark glass.
  let pageBg = "#ffffff";
  try {
    for (const node of [document.body, document.documentElement]) {
      if (!node) continue;
      const c = getComputedStyle(node).backgroundColor;
      if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") { pageBg = c; break; }
    }
  } catch {}

  function pathRR(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Load a URL (or data-URI) and draw it clipped once ready. Display-only —
  // we never read the canvas back, so a CORS-tainted image is fine.
  function drawUrl(ctx, url, x, y, w, h, radius) {
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      if (!running || mode !== "paint") return;   // plane may have been re-rendered
      try {
        ctx.save(); pathRR(ctx, x, y, w, h, radius); ctx.clip();
        ctx.drawImage(img, x, y, w, h); ctx.restore();
      } catch {}
    };
    try { img.src = new URL(url, location.href).href; } catch { try { img.src = url; } catch {} }
  }

  // Inline <svg> can't be drawImage'd directly — serialize it to a data-URI
  // first. Copy resolved color/fill/stroke so currentColor icons aren't blanked.
  function drawSvg(ctx, svgEl, x, y, w, h, radius) {
    try {
      const clone = svgEl.cloneNode(true);
      if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const bb = svgEl.getBoundingClientRect();
      if (!clone.getAttribute("width"))  clone.setAttribute("width",  Math.max(1, Math.round(bb.width)));
      if (!clone.getAttribute("height")) clone.setAttribute("height", Math.max(1, Math.round(bb.height)));
      const scs = getComputedStyle(svgEl);
      clone.style.color = scs.color;
      if (scs.fill && scs.fill !== "none")     clone.style.fill = scs.fill;
      if (scs.stroke && scs.stroke !== "none") clone.style.stroke = scs.stroke;
      const xml = new XMLSerializer().serializeToString(clone);
      drawUrl(ctx, "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml), x, y, w, h, radius);
    } catch {}
  }

  function paintEl(ctx, it, color) {
    const x = it.rect.x * SX, y = it.rect.y * SY;
    const w = Math.max(1, it.rect.w * SX), h = Math.max(1, it.rect.h * SY);
    const cs = it.cs, el = it.el;
    const radius = cs ? (parseFloat(cs.borderTopLeftRadius) || 0) * SX : 0;

    // 1. background colour
    if (cs) {
      const bg = cs.backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        ctx.fillStyle = bg; pathRR(ctx, x, y, w, h, radius); ctx.fill();
      }
    }
    // 2. real bitmap / vector content (img / svg / canvas / video)
    const tag = el && el.tagName ? el.tagName.toUpperCase() : "";
    // Back image/vector content with the real page color so transparent or pale
    // art (authored for the page's paper) doesn't vanish into the dark plane.
    if (tag === "IMG" || tag === "SVG") {
      ctx.save(); pathRR(ctx, x, y, w, h, radius); ctx.clip();
      ctx.fillStyle = pageBg; ctx.fillRect(x, y, w, h); ctx.restore();
    }
    if (tag === "IMG") {
      if (el.complete && el.naturalWidth) {          // decoded & ready — draw the live node
        try { ctx.save(); pathRR(ctx, x, y, w, h, radius); ctx.clip();
              ctx.drawImage(el, x, y, w, h); ctx.restore(); } catch {}
      } else {                                       // lazy / not-yet-decoded — reload the source
        drawUrl(ctx, el.currentSrc || el.src, x, y, w, h, radius);
      }
    } else if (tag === "SVG") {
      drawSvg(ctx, el, x, y, w, h, radius);
    } else if (tag === "CANVAS" || tag === "VIDEO") {
      try { ctx.save(); pathRR(ctx, x, y, w, h, radius); ctx.clip();
            ctx.drawImage(el, x, y, w, h); ctx.restore(); } catch {}
    }
    // 3. background-image url(...) — load async, draw clipped when ready
    if (cs) {
      const m = cs.backgroundImage && cs.backgroundImage.match(/url\((['"]?)(.*?)\1\)/);
      if (m && m[2]) drawUrl(ctx, m[2], x, y, w, h, radius);
    }
    // 4. border
    if (cs) {
      const bw = parseFloat(cs.borderTopWidth) || 0;
      const bc = cs.borderTopColor;
      if (bw > 0 && bc && bc !== "rgba(0, 0, 0, 0)") {
        ctx.strokeStyle = bc; ctx.lineWidth = Math.max(0.4, bw * SX);
        pathRR(ctx, x, y, w, h, radius); ctx.stroke();
      }
    }
    // 5. text — only for leaf-ish elements so we don't dump whole paragraphs twice
    if (cs && el && el.children.length === 0) {
      const txt = (el.textContent || "").trim();
      if (txt) {
        const fs = Math.max(6, (parseFloat(cs.fontSize) || 13) * SX);
        ctx.fillStyle = cs.color || "#fff";
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fs}px ${cs.fontFamily}`;
        ctx.textBaseline = "top";
        ctx.save(); pathRR(ctx, x, y, w, h, 0); ctx.clip();
        ctx.fillText(txt.slice(0, 120), x + 2, y + 2, w + 40);
        ctx.restore();
      }
    }
  }

  function wireEl(ctx, it, color) {
    const x = it.rect.x * SX, y = it.rect.y * SY;
    const w = Math.max(2, it.rect.w * SX), h = Math.max(2, it.rect.h * SY);
    ctx.strokeStyle = color; ctx.fillStyle = color + "14";
    ctx.lineWidth = 1.4; ctx.shadowBlur = 8; ctx.shadowColor = color;
    pathRR(ctx, x, y, w, h, 4); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    if (w > 70 && h > 16) {
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = color; ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(it.sel, x + 5, y + 13, w - 10);
      if (it.reasonKey && h > 30) {
        ctx.fillStyle = it.warn ? "#ff8aa0" : color + "aa";
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText((it.warn ? "⚠ " : "↳ ") + it.reasonKey, x + 5, y + 25, w - 10);
      }
    }
  }

  function renderPlane(p) {
    const { ctx } = p;
    ctx.clearRect(0, 0, cw, ch);
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    if (mode === "paint") {
      // back-to-front within the layer so children paint over parents
      for (const it of p.meta.items) paintEl(ctx, it, p.color);
    } else {
      for (const it of p.meta.items) wireEl(ctx, it, p.color);
    }
  }

  // ----- build planes ---------------------------------------------------------
  const planes = planesMeta.map((meta, idx) => {
    const el = document.createElement("div");
    el.className = "layer";
    const felony = meta.znum !== null && Math.abs(meta.znum) >= OUTLIER;
    if (felony) el.classList.add("felony");
    el.style.transform = `translateZ(${-idx * GAP}px)`;
    const color = felony ? "#ff3860" : PALETTE[idx % PALETTE.length];
    el.style.borderColor = color + "66";

    const cv = document.createElement("canvas");
    cv.width = cw; cv.height = ch;
    const clampedItem = meta.items.find((it) => it.clamped);
    const clampNote = clampedItem ? `  ·  ⚠ clamped from ${clampedItem.authored.toExponential(1)}` : "";
    const tagTxt = (felony ? "⚠ " : "") + meta.label + " · " + meta.items.length + " el" + clampNote;
    el.innerHTML = `<span class="tag" style="color:${color}">${tagTxt}</span>`;
    el.appendChild(cv);
    stack.appendChild(el);

    const p = { el, meta, felony, color, ctx: cv.getContext("2d") };
    renderPlane(p);
    return p;
  });

  // ----- clickable console report ---------------------------------------------
  // Passing the real DOM element as a console arg makes it inspectable: click
  // it in DevTools to jump to the node (and right-click → "Reveal in Elements").
  function dumpReport() {
    const H = "color:#39ff14;font-weight:700", DIM = "color:#8fd0ff",
          WARN = "color:#ff3860;font-weight:700", SEL = "color:#cfe", SUB = "color:#7f93a3";
    console.groupCollapsed(
      `%c⬢ zstack%c  ${planesMeta.length} stacking layers · ${kept.length} elements · ${location.host}`,
      H, DIM);

    const clampedL = kept.filter((c) => c.clamped);
    const outliers = kept.filter((c) => c.znum !== null && Math.abs(c.znum) >= OUTLIER && !c.clamped);
    const ignored  = kept.filter((c) => c.warn && !c.clamped && (c.znum === null || Math.abs(c.znum) < OUTLIER));

    if (clampedL.length) {
      console.group(`%c⚠ z-index clamped to int32 range (${clampedL.length})`, WARN);
      for (const c of clampedL)
        console.warn(`%c${c.sel}%c   authored ${c.authored} (${c.authored.toExponential(2)})  →  clamped to ${c.znum}`, WARN, SUB, c.el);
      console.groupEnd();
    }
    if (outliers.length) {
      console.group(`%c⚠ absurd z-index outliers (${outliers.length})`, WARN);
      for (const c of outliers)
        console.warn(`%c${c.sel}%c   z-index: ${c.znum}`, WARN, SUB, c.el);
      console.groupEnd();
    }
    if (ignored.length) {
      console.group(`%c⚠ z-index that does nothing — position:static (${ignored.length})`, WARN);
      for (const c of ignored)
        console.warn(`%c${c.sel}%c   ${c.reason}`, WARN, SUB, c.el);
      console.groupEnd();
    }

    for (let i = 0; i < planesMeta.length; i++) {
      const m = planesMeta[i];
      console.groupCollapsed(`%clayer ${i}%c  ${m.label}  ·  ${m.items.length} el`, DIM, SUB);
      for (const it of m.items) {
        const extra = it.reason ? `   ↳ ${it.reason}` : "";
        if (it.el) console.log(`%c${it.sel}%c${extra}`, it.warn ? WARN : SEL, SUB, it.el);
        else console.log(`%c${it.sel}%c${extra}`, SEL, SUB);
      }
      console.groupEnd();
    }
    console.groupEnd();
    console.info("%c⬢ zstack%c report logged ↑  ·  click any element to inspect  ·  press D on the overlay to re-log",
      H, DIM);
  }
  dumpReport();

  // ----- on-screen report panel (mirror of the console report) ----------------
  // Same findings as dumpReport(), rendered in a side panel. Clicking a row
  // logs the live element (inspectable in DevTools) and reveals it in the stack:
  // focuses its plane and pulses a highlight box over the element's rectangle.
  const panel = root.getElementById("panel");
  const reportBtn = root.getElementById("reportbtn");

  // element -> its layer index, so a clicked row knows which plane to reveal.
  const layerIndex = new Map();
  planesMeta.forEach((m, i) => m.items.forEach((it) => { if (it.el) layerIndex.set(it.el, i); }));

  function elt(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function focusLayer(i) { depthT = Math.max(0, Math.min(N - 1, i)); }

  function highlightItem(i, it) {
    const plane = planes[i];
    if (!plane || !it.rect) return;
    const old = plane.el.querySelector(".hl");
    if (old) old.remove();
    const hl = elt("div", "hl");
    hl.style.left   = (it.rect.x * SX) + "px";
    hl.style.top    = (it.rect.y * SY) + "px";
    hl.style.width  = Math.max(2, it.rect.w * SX) + "px";
    hl.style.height = Math.max(2, it.rect.h * SY) + "px";
    plane.el.appendChild(hl);
    if (view === "2d") plane.el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => { if (hl.isConnected) hl.remove(); }, 2400);
  }

  // Log + reveal the element behind a row.
  function revealItem(c) {
    if (c.el) console.log(c.sel, c.el);
    const i = layerIndex.get(c.el);
    if (i == null) return;
    focusLayer(i);
    highlightItem(i, c);
  }

  function warnGroup(title, list, fmt) {
    const g = elt("div", "warn-g");
    g.appendChild(elt("div", "wg-h", title));
    for (const c of list) {
      const row = elt("div", "wg-item");
      row.appendChild(elt("span", "it-sel", c.sel + "  "));
      row.appendChild(elt("b", null, fmt(c)));
      if (c.el) row.addEventListener("click", () => revealItem(c));
      g.appendChild(row);
    }
    return g;
  }

  function toggleItems(row, m) {
    const nxt = row.nextElementSibling;
    if (nxt && nxt.classList.contains("items")) { nxt.remove(); row.classList.remove("open"); return; }
    const box = elt("div", "items");
    for (const it of m.items) {
      const r = elt("div", "item" + (it.warn ? " warn" : ""));
      r.appendChild(elt("span", "it-sel", it.sel));
      if (it.reason) r.appendChild(elt("span", "it-reason", it.reason));
      if (it.el) r.addEventListener("click", (e) => { e.stopPropagation(); revealItem(it); });
      box.appendChild(r);
    }
    row.after(box);
    row.classList.add("open");
  }

  function buildPanel() {
    panel.innerHTML = "";
    const hdr = elt("header");
    hdr.appendChild(elt("div", "h-title", "⬢ zstack"));
    hdr.appendChild(elt("div", "h-sub", `${planesMeta.length} stacking layers · ${kept.length} elements`));
    hdr.appendChild(elt("div", "h-host", location.host));
    panel.appendChild(hdr);

    const clampedL = kept.filter((c) => c.clamped);
    const outliers = kept.filter((c) => c.znum !== null && Math.abs(c.znum) >= OUTLIER && !c.clamped);
    const ignored  = kept.filter((c) => c.warn && !c.clamped && (c.znum === null || Math.abs(c.znum) < OUTLIER));
    if (clampedL.length || outliers.length || ignored.length) {
      const w = elt("div", "section warn");
      if (outliers.length) w.appendChild(warnGroup(`⚠ absurd z-index outliers (${outliers.length})`, outliers, (c) => `z-index: ${c.znum}`));
      if (clampedL.length) w.appendChild(warnGroup(`⚠ clamped to int32 (${clampedL.length})`, clampedL, (c) => `${c.authored.toExponential(1)} → ${c.znum}`));
      if (ignored.length)  w.appendChild(warnGroup(`⚠ ignored — position:static (${ignored.length})`, ignored, () => "no-op z-index"));
      panel.appendChild(w);
    }

    const sec = elt("div", "section");
    sec.appendChild(elt("div", "sec-h", "layers · front → back"));
    planesMeta.forEach((m, i) => {
      const row = elt("div", "layer-row" + (planes[i].felony ? " felony" : ""));
      const sw = elt("span", "sw"); sw.style.background = planes[i].color; sw.style.color = planes[i].color;
      row.appendChild(sw);
      row.appendChild(elt("span", "lr-idx", String(i)));
      row.appendChild(elt("span", "lr-label", m.label));
      row.appendChild(elt("span", "lr-count", m.items.length + " el"));
      row.addEventListener("click", () => { focusLayer(i); toggleItems(row, m); });
      sec.appendChild(row);
    });
    panel.appendChild(sec);
  }

  let panelOpen = false;
  function setPanel(on) {
    panelOpen = on;
    wrap.classList.toggle("showpanel", on);
    reportBtn.classList.toggle("on", on);
  }
  reportBtn.addEventListener("click", () => setPanel(!panelOpen));
  buildPanel();
  setPanel(true);

  // ----- camera / depth-of-field (the heisted engine) -------------------------
  let depth = 0, depthT = 0, rotY = 0, rotYT = 0, rotX = 0, rotXT = 0;
  const N = planes.length;
  const ctrl = new AbortController();
  const sig = ctrl.signal;
  let running = true;

  function setFocus(step) { depthT = Math.max(0, Math.min(N - 1, depthT + step)); }

  addEventListener("keydown", (e) => {
    if (!running) return;
    if (e.key === "ArrowUp")   { setFocus(1);  e.preventDefault(); }
    if (e.key === "ArrowDown") { setFocus(-1); e.preventDefault(); }
    if (e.key.toLowerCase() === "r") { const on = Math.abs(rotYT) < 1; rotYT = on ? 45 : 0; rotXT = on ? -12 : 0; }
    if (e.key.toLowerCase() === "p") { mode = mode === "paint" ? "wire" : "paint"; for (const p of planes) renderPlane(p); }
    if (e.key.toLowerCase() === "v") { setView(view === "3d" ? "2d" : "3d"); }
    if (e.key.toLowerCase() === "l") { setPanel(!panelOpen); }
    if (e.key.toLowerCase() === "d") { dumpReport(); }
    if (e.key === "0") { depthT = 0; rotYT = 0; rotXT = 0; }
    if (e.key === "Escape") teardown();
  }, { signal: sig, capture: true });

  addEventListener("wheel", (e) => {
    if (!running) return;
    setFocus(e.deltaY > 0 ? -0.5 : 0.5); e.preventDefault();
  }, { passive: false, capture: true, signal: sig });

  let dragging = false, lx = 0, ly = 0;
  wrap.addEventListener("mousedown", (e) => { dragging = true; lx = e.clientX; ly = e.clientY; wrap.classList.add("dragging"); });
  addEventListener("mousemove", (e) => {
    if (!dragging) return;
    rotYT += (e.clientX - lx) * 0.4; rotXT -= (e.clientY - ly) * 0.4;
    rotXT = Math.max(-80, Math.min(80, rotXT)); lx = e.clientX; ly = e.clientY;
  }, { signal: sig });
  addEventListener("mouseup", () => { dragging = false; wrap.classList.remove("dragging"); }, { signal: sig });
  root.getElementById("close").addEventListener("click", () => teardown());

  function loop() {
    if (!running) return;
    depth += (depthT - depth) * 0.12;
    rotY  += (rotYT - rotY) * 0.18;
    rotX  += (rotXT - rotX) * 0.18;

    const focused = Math.max(0, Math.min(N - 1, Math.round(depth)));
    curEl.textContent = focused;
    const fm = planes[focused];
    lblEl.innerHTML = fm.felony
      ? `<span class="warn">⚠ ${fm.meta.label}</span> &nbsp;·&nbsp; absurd z-index outlier`
      : fm.meta.label;

    // 2D grid is laid out by CSS — skip all the camera / depth-of-field work.
    if (view !== "3d") { requestAnimationFrame(loop); return; }

    stack.style.transform = `translateZ(${depth * GAP}px) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
    for (let i = 0; i < N; i++) {
      const L = planes[i];
      const rel = depth - i;          // >0 passed (toward camera), <0 ahead
      const dist = Math.abs(rel);
      if (rel > 1.1) { L.el.style.visibility = "hidden"; continue; }
      L.el.style.visibility = "visible";

      let blur, bright, opacity;
      if (rel > 0) {                  // punching through the lens — dissolve
        blur = Math.min(18, rel * 7); bright = 1; opacity = Math.max(0, 1 - rel * 1.25);
      } else {                        // depth-of-field falloff into the distance
        blur = Math.min(16, dist * 3.2);
        bright = Math.max(0.4, 1 - dist * 0.12);
        opacity = Math.max(0.18, 1 - dist * 0.055);
      }
      L.el.style.filter = `blur(${blur.toFixed(2)}px) brightness(${bright.toFixed(2)})`;
      L.el.style.opacity = opacity.toFixed(2);
      L.el.classList.toggle("active", Math.round(depth) === i);
    }
    requestAnimationFrame(loop);
  }

  function teardown() {
    running = false;
    ctrl.abort();
    host.remove();
  }
  host.__zstack_teardown = teardown;

  loop();
})();
