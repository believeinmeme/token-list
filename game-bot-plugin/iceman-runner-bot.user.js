// ==UserScript==
// @name         Iceman Runner Bot
// @namespace    https://github.com/believeinmeme/token-list
// @version      3.1.0
// @description  Self-learning runner bot. Fixed ground calibration, faster reaction, earlier learning. Dual-zone pixel scan, memory anticipation, hands-free.
// @author       believeinmeme
// @match        https://www.icemancountdown.com/runner*
// @run-at       document-idle
// @grant        none
// @noframes
// @downloadURL  https://raw.githubusercontent.com/believeinmeme/token-list/claude/game-bot-plugin-ruwut/game-bot-plugin/iceman-runner-bot.user.js
// @updateURL    https://raw.githubusercontent.com/believeinmeme/token-list/claude/game-bot-plugin-ruwut/game-bot-plugin/iceman-runner-bot.user.js
// ==/UserScript==

/**
 * Iceman Runner Bot v3.1 — learning fix + faster reactions
 *
 * OBSTACLE RECOGNITION
 *   Ground ice  → jump    (lower canvas zone, vs ground-bg colour)
 *   Sky plane   → stay    (mid-canvas zone,   vs sky-bg colour)
 *   Independent background calibrations for each zone — ice-vs-ground
 *   and plane-vs-sky are measured correctly, not conflated.
 *
 * LEARNING SYSTEM (v3.1 fixes)
 *   Ground calibration now samples x=14% (clear ground between the
 *   player sprite at ~10% and the first scan column at 28%).  The v3.0
 *   sample at x=2% landed on the player and contaminated bgGnd, so
 *   isGndObs() never fired and no obstacle data was ever logged.
 *   After 2 training runs (was 3), patterns with ≥55% confidence
 *   (jump, was 60%) or ≥72% (duck) are anticipated 700 ms early (was 500).
 *
 * FASTER REACTIONS (v3.1)
 *   Jump cooldown: 300 ms (was 380).  Heartbeat: 650 ms (was 850).
 *   Extra close-range scan column at x=0.16 for last-second obstacles.
 *   bgTolGnd tightened to 40 (was 55). groundHits: 2 (was 4). airHits: 8.
 *
 * ADAPTIVE SPEED
 *   Scan columns shift right every 30 s (longer look-ahead as speed rises).
 *   Plane-suppression window shrinks from ~1100 ms → 480 ms over 2 min.
 *   Heartbeat safety-net jump every 650 ms, respects plane suppression.
 *
 * SUBMISSION FLOW
 *   Game-over → tick T&C checkbox → click SUBMIT (3 retries over 3.4 s).
 *   If within 30 s cooldown → show score 2.2 s → SKIP → restart.
 *   Leaderboard modal (CLOSE button) dismissed automatically after submit.
 *   7.5 s total before next run; 5.5 s on the skip path.
 *
 * RELIABILITY (carried from v3.0)
 *   • Screen Wake Lock  — prevents iOS from sleeping mid-run.
 *   • Visibility guard  — resets canvas hash when tab is backgrounded.
 *   • Watchdog timer    — force-restarts if stuck > 12 s outside "playing".
 *   • Phase timestamps  — atomic setPhase() keeps the watchdog accurate.
 *   • sweepPopups guard — excluded from "over" phase so doPublish() owns submit.
 *   • memReset double-tap — requires two taps within 2 s (confirm() overridden).
 */
(function () {
  "use strict";

  /* ── idempotency: bookmarklet re-tap toggles the bot ─────────────────── */
  if (window.__RB_ACTIVE__ !== undefined) { window.__RB_TOGGLE__(); return; }

  /* ── override native dialogs (game can't block progress with alert/confirm) */
  window.confirm = () => true;
  window.alert   = () => undefined;
  window.prompt  = (_, d) => (d !== undefined ? d : "");

  /* ══════════════════════════════════════════════════════════════════════════
     BUTTON-TEXT REGEXES
     RE_PUBLISH must NOT contain "leaderboard" — clicking "VIEW LEADERBOARD"
     opens the loading modal and gets the bot permanently stuck.
  ══════════════════════════════════════════════════════════════════════════ */
  const RE_PUBLISH = /^\s*(submit|publish)\s*$|submit[\s\S]{0,20}score/i;
  const RE_CLOSE   = /^\s*(close|dismiss|done|got.?it)\s*$/i;
  const RE_APPROVE = /^\s*(ok|yes|confirm|accept|continue|send|save)\s*$/i;
  const RE_RESTART = /^\s*skip\s*$|play.?again|try.?again|restart|new.?game|retry/i;

  /* ══════════════════════════════════════════════════════════════════════════
     STATE
  ══════════════════════════════════════════════════════════════════════════ */
  const S = {
    active: false,
    phase:  "idle",   // "idle"|"playing"|"over"|"publishing"|"restarting"
    phaseAt: 0,       // timestamp of last phase transition (for watchdog)

    canvas: null, ctx: null, tainted: false,
    bgSky: null, bgGnd: null,

    lastJumpAt: 0, lastDuckAt: 0, suppressJumpUntil: 0,
    jumpCount: 0, startTime: 0, lastChangeAt: 0, prevHash: 0, frame: 0,

    rafId: null, calTimer: null, restartTid: null,
    rhythmTid: null, heartbeatTid: null, watchdogTid: null,

    gameObj: null,
    panel: null, statusEl: null, infoEl: null, btn: null,

    lastPublishedAt: 0,
    detectEnabled: false,
    runLog: [],
    wakeLock: null,
  };

  const PUBLISH_COOLDOWN_MS = 31_000;

  /* ══════════════════════════════════════════════════════════════════════════
     CONFIG
  ══════════════════════════════════════════════════════════════════════════ */
  const C = {
    // jump / duck
    jumpCooldown:  300,   // min ms between jumps
    duckCooldown:  280,
    jumpAirMs:     620,   // estimated air time (prevents double-jump)
    duckHoldMs:    220,
    heartbeatMs:   650,   // safety-net jump when no obstacle detected

    // game loop
    gameOverMs:   2000,   // ms canvas must freeze before declaring game-over
    publishWait:  1400,   // ms after game-over → first SUBMIT attempt
    publishRetry1:1900,   // ms after attempt 1 → retry 2
    publishRetry2:3400,   // ms after attempt 1 → retry 3
    restartDelay: 7500,   // ms total game-over → restart (submit path)
    skipClickMs:  2200,   // ms after game-over → click SKIP
    skipRestartMs:5500,   // ms total game-over → restart (skip path)
    restartGraceMs:3500,  // ms post-restart during which end-screen detection is off
    calIntervalMs:8000,   // background recalibration interval
    watchdogMs:  12_000,  // max ms allowed outside "playing" before force-restart

    // pixel detection
    bgTolGnd:      40,    // colour-distance threshold — ice vs ground
    bgTolAir:      60,    // colour-distance threshold — plane vs sky
    groundHits:     2,    // min differing pixels to confirm ice
    airHits:        8,    // min differing pixels to confirm plane
    hashEvery:      4,    // check canvas hash every N frames

    // scan zones (fraction of canvas height)
    groundTop: 0.65, groundBot: 0.90,   // ice zone
    airTop:    0.24, airBot:    0.55,   // plane zone (non-overlapping)

    // scan columns (fraction of canvas width) — pushed right as speed rises
    // 0.16 = close-range safety column just ahead of the player (~10% x)
    baseCols: [0.16, 0.28, 0.40, 0.52, 0.64],
    colPushPer30s: 0.04, colPushMax: 0.16, colMax: 0.80,

    // rhythm fallback (tainted canvas)
    rhythmBase: 900, rhythmMinMs: 480, rhythmStep: 28, rhythmEvery: 20,
  };

  /* ══════════════════════════════════════════════════════════════════════════
     PHASE HELPER — updates phase and stamps the time for the watchdog
  ══════════════════════════════════════════════════════════════════════════ */
  function setPhase(p) { S.phase = p; S.phaseAt = Date.now(); }

  /* ══════════════════════════════════════════════════════════════════════════
     GAME-OBJECT HOOK — calls engine jump/duck directly when available
  ══════════════════════════════════════════════════════════════════════════ */
  const GAME_NAMES = ["game","Game","runner","Runner","App","app","GameScene","mainGame","scene","phaser"];

  function findGameObj() {
    if (S.gameObj) return S.gameObj;
    for (const n of GAME_NAMES) {
      try {
        const v = window[n];
        if (!v || typeof v !== "object") continue;
        const p = v.player || v.runner || v;
        if (typeof p.jump === "function" || typeof p.doJump === "function" ||
            typeof p.duck === "function" || typeof p.crouch === "function") {
          S.gameObj = v; return v;
        }
      } catch (_) {}
    }
    return null;
  }

  function callFn(path) {
    const g = findGameObj(); if (!g) return false;
    const p = g.player || g.runner || g;
    const map = {
      jump:    [p.jump, p.doJump, g.jump],
      duck:    [p.duck, p.crouch, g.duck],
      start:   [g.start, g.restart, g.reset],
      restart: [g.restart, g.reset, g.start],
    };
    for (const f of (map[path] || [])) if (typeof f === "function") { try { f.call(p); } catch (_) {} return true; }
    return false;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     UI HELPERS
  ══════════════════════════════════════════════════════════════════════════ */
  function elVisible(el) {
    if (!el || el.closest("#__rb__")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity) > 0.02;
  }

  function clickMatching(re) {
    const sel = 'button:not(#__rb__ *), [role="button"]:not(#__rb__ *), input[type="button"], input[type="submit"]';
    for (const el of document.querySelectorAll(sel)) {
      if (el.disabled || !elVisible(el)) continue;
      const txt = ((el.textContent || "") + (el.value || "") + (el.getAttribute("aria-label") || "")).trim();
      if (re.test(txt)) { el.click(); return true; }
    }
    return false;
  }

  function checkAllCheckboxes() {
    document.querySelectorAll('input[type="checkbox"]:not(#__rb__ *)').forEach(cb => {
      if (!elVisible(cb) || cb.checked) return;
      cb.checked = true;
      ["change", "input", "click"].forEach(t => cb.dispatchEvent(new Event(t, { bubbles: true })));
    });
  }

  // Dismiss leaderboard modal or any blocking overlay.
  // First tries standard button selectors, then falls back to class-name hints
  // (avoids scanning every DOM node while still catching <div>/<a> close buttons).
  function closeOverlay() {
    if (clickMatching(RE_CLOSE)) return true;
    const extra = [
      'a:not(#__rb__ *)',
      '[class*="close"]:not(#__rb__ *)',
      '[class*="btn"]:not(#__rb__ *)',
      '[class*="button"]:not(#__rb__ *)',
    ].join(",");
    for (const el of document.querySelectorAll(extra)) {
      if (!elVisible(el)) continue;
      const txt = (el.textContent || "").trim();
      if (txt.length < 20 && RE_CLOSE.test(txt)) { el.click(); return true; }
    }
    return false;
  }

  // General popup sweeper — called outside "playing" and "over" phases only.
  // "over" is excluded so doPublish() has sole control of the submission flow.
  function sweepPopups() {
    closeOverlay();
    checkAllCheckboxes();
    setTimeout(() => {
      clickMatching(RE_PUBLISH) || clickMatching(RE_APPROVE) || clickMatching(RE_RESTART);
    }, 150);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     CANVAS + DUAL-ZONE BACKGROUND CALIBRATION
  ══════════════════════════════════════════════════════════════════════════ */
  function findCanvas() {
    const all = Array.from(document.querySelectorAll("canvas"))
      .filter(c => c.width > 30 && c.height > 30)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    for (const c of all) {
      try { const ctx = c.getContext("2d"); if (ctx) { S.canvas = c; S.ctx = ctx; return true; } } catch (_) {}
    }
    return false;
  }

  function avgColor(d) {
    let r = 0, g = 0, b = 0, n = d.data.length / 4;
    for (let i = 0; i < d.data.length; i += 4) { r += d.data[i]; g += d.data[i+1]; b += d.data[i+2]; }
    return { r: r/n, g: g/n, b: b/n };
  }

  function calibrateBg() {
    if (!S.ctx || S.tainted) return;
    const cv = S.canvas, ctx = S.ctx;
    // Sky: top-left corner — reference for plane detection
    try {
      S.bgSky = avgColor(ctx.getImageData(2, 2,
        Math.max(2, cv.width * 0.07 | 0),
        Math.max(2, cv.height * 0.07 | 0)));
    } catch (_) { S.tainted = true; return; }
    // Ground: sampled at x=14% — between player sprite (~10%) and first scan
    // column at 28%.  Sampling closer to the left edge (x=2%) captures the
    // player sprite itself, contaminating bgGnd and breaking ice detection.
    try {
      S.bgGnd = avgColor(ctx.getImageData(
        Math.max(1, cv.width  * 0.14 | 0),
        Math.max(1, cv.height * C.groundTop | 0),
        Math.max(2, cv.width  * 0.05 | 0),
        Math.max(2, cv.height * (C.groundBot - C.groundTop) | 0)));
    } catch (_) {}
  }

  function isSkyObs(r, g, b) {
    if (!S.bgSky) return false;
    return Math.abs(r - S.bgSky.r) + Math.abs(g - S.bgSky.g) + Math.abs(b - S.bgSky.b) > C.bgTolAir;
  }

  function isGndObs(r, g, b) {
    if (!S.bgGnd) return false;
    return Math.abs(r - S.bgGnd.r) + Math.abs(g - S.bgGnd.g) + Math.abs(b - S.bgGnd.b) > C.bgTolGnd;
  }

  // Suppression window shrinks as game speeds up — planes pass faster at high speed
  function suppressMs() {
    const elapsed = S.startTime ? (Date.now() - S.startTime) / 1000 : 0;
    return Math.max(480, 1100 - elapsed * 5);
    // 0 s → 1100 ms   60 s → 800 ms   120 s → 500 ms   ≥ 124 s → 480 ms
  }

  /* ══════════════════════════════════════════════════════════════════════════
     LEARNING SYSTEM
     Time-stamps every confirmed obstacle and persists it to localStorage
     in 300 ms buckets. After 3 training runs, high-confidence patterns
     are fired 500 ms BEFORE the pixel scan would see them.
  ══════════════════════════════════════════════════════════════════════════ */
  const MEM_KEY    = "__rb_mem__";
  const MEM_VER    = 2;       // bump if schema changes — old data auto-discarded
  const BUCKET_MS  = 300;
  const LOOK_AHEAD = 700;     // anticipate 700 ms early (was 500)
  const CONF_JUMP  = 0.55;    // confidence threshold for jump (was 0.60)
  const CONF_DUCK  = 0.72;    // higher bar: false duck blocks jumps for ~800 ms
  const RUNS_MIN   = 2;       // training runs before anticipation fires (was 3)

  let MEM = null;
  let lastAntBucket = -1;

  function bucketOf(ms) { return Math.round(ms / BUCKET_MS) * BUCKET_MS; }

  function memLoad() {
    try {
      const m = JSON.parse(localStorage.getItem(MEM_KEY) || "null");
      return (m && m.v === MEM_VER) ? m : { v: MEM_VER, runs: 0, p: {} };
    } catch (_) { return { v: MEM_VER, runs: 0, p: {} }; }
  }

  function memSave() {
    if (!MEM) return;
    try { localStorage.setItem(MEM_KEY, JSON.stringify(MEM)); } catch (_) {}
  }

  function memReset() { MEM = { v: MEM_VER, runs: 0, p: {} }; memSave(); updateInfo(); }

  function memRefresh() { MEM = memLoad(); lastAntBucket = -1; }

  // Log a pixel-scan-confirmed obstacle. Deduped: same type in the same or
  // adjacent bucket is ignored to avoid inflating pattern counts.
  function memLog(type) {
    if (!S.active || !S.startTime) return;
    const t    = bucketOf(Date.now() - S.startTime);
    const last = S.runLog[S.runLog.length - 1];
    if (last && last.type === type && t - last.t <= BUCKET_MS) return;
    S.runLog.push({ t, type });
  }

  // Merge this run's log into persistent memory. Only increments run count
  // when there is actual data (avoids inflating denominator on empty runs).
  function memConsolidate() {
    if (!MEM || !S.runLog.length) { S.runLog = []; return; }
    MEM.runs = (MEM.runs || 0) + 1;
    for (const { t, type } of S.runLog) {
      const k = String(t);
      if (!MEM.p[k]) MEM.p[k] = { j: 0, d: 0 };
      if (type === "jump") MEM.p[k].j++; else MEM.p[k].d++;
    }
    for (const k of Object.keys(MEM.p)) if (Number(k) > 600_000) delete MEM.p[k];
    memSave();
    S.runLog = [];
    updateInfo();
  }

  // Returns anticipated action ("jump"|"duck"|null) for the near future.
  // Guards: minimum runs, minimum confidence, no repeat within same bucket.
  function memAnticipate() {
    if (!MEM || MEM.runs < RUNS_MIN || !S.startTime) return null;
    const target = bucketOf(Date.now() - S.startTime + LOOK_AHEAD);
    if (target === lastAntBucket) return null;
    const b = MEM.p[String(target)];
    if (!b) return null;
    const bj = b.j || 0, bd = b.d || 0;
    if (bj >= bd) {
      if (bj / MEM.runs >= CONF_JUMP) { lastAntBucket = target; return "jump"; }
    } else {
      if (bd / MEM.runs >= CONF_DUCK) { lastAntBucket = target; return "duck"; }
    }
    return null;
  }

  function memRunCount()     { return MEM ? (MEM.runs || 0) : 0; }
  function memPatternCount() { return MEM ? Object.keys(MEM.p).length : 0; }

  /* ══════════════════════════════════════════════════════════════════════════
     CANVAS HASH + ADAPTIVE SCAN COLUMNS
  ══════════════════════════════════════════════════════════════════════════ */
  function hashSample() {
    if (!S.ctx || S.tainted) return 0;
    try {
      const d = S.ctx.getImageData(S.canvas.width * 0.5 | 0, S.canvas.height * 0.5 | 0, 10, 4);
      let h = 0;
      for (let i = 0; i < d.data.length; i += 8) h = (h * 31 + d.data[i]) | 0;
      return h;
    } catch (_) { S.tainted = true; return 0; }
  }

  function getScanCols() {
    const elapsed = S.startTime ? (Date.now() - S.startTime) / 1000 : 0;
    const push = Math.min(C.colPushMax, (elapsed / 30 | 0) * C.colPushPer30s);
    return C.baseCols.map(col => Math.min(C.colMax, col + push));
  }

  /* ══════════════════════════════════════════════════════════════════════════
     OBSTACLE DETECTION — two independent zones, two independent bg colours
  ══════════════════════════════════════════════════════════════════════════ */
  function detectObstacle() {
    if (!S.ctx || !S.canvas || S.tainted) return null;
    const W = S.canvas.width, H = S.canvas.height;
    const cols = getScanCols();
    const gY = H * C.groundTop | 0, gH = Math.max(1, H * (C.groundBot - C.groundTop) | 0);
    const aY = H * C.airTop    | 0, aH = Math.max(1, H * (C.airBot    - C.airTop)    | 0);
    let groundPx = 0, airPx = 0;

    for (const frac of cols) {
      const sx = Math.min(W - 1, W * frac | 0);
      let gd, ad;
      try { gd = S.ctx.getImageData(sx, gY, 1, gH); ad = S.ctx.getImageData(sx, aY, 1, aH); }
      catch (_) { S.tainted = true; return null; }
      for (let i = 0; i < gd.data.length; i += 4) if (isGndObs(gd.data[i], gd.data[i+1], gd.data[i+2])) groundPx++;
      for (let i = 0; i < ad.data.length; i += 4) if (isSkyObs(ad.data[i], ad.data[i+1], ad.data[i+2])) airPx++;
    }

    if (airPx    >= C.airHits)    return "duck";   // plane takes priority
    if (groundPx >= C.groundHits) return "jump";
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     INPUT SIMULATION — keyboard + touch + pointer events + game API
  ══════════════════════════════════════════════════════════════════════════ */
  function key(type, k, code, kc) {
    const e = new KeyboardEvent(type, { key: k, code, keyCode: kc, which: kc, bubbles: true, cancelable: true });
    [S.canvas, document.body, document].filter(Boolean).forEach(t => t.dispatchEvent(e));
  }

  function tapCanvas(down) {
    if (!S.canvas) return;
    const r  = S.canvas.getBoundingClientRect();
    const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.72;
    if (typeof TouchEvent !== "undefined") {
      try {
        const t = new Touch({
          identifier: Date.now() & 0xffff, target: S.canvas,
          clientX: cx, clientY: cy, screenX: cx, screenY: cy,
          pageX: cx + (window.scrollX || 0), pageY: cy + (window.scrollY || 0),
          radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1,
        });
        S.canvas.dispatchEvent(new TouchEvent(down ? "touchstart" : "touchend", {
          bubbles: true, cancelable: true,
          touches: down ? [t] : [], targetTouches: down ? [t] : [], changedTouches: [t],
        }));
      } catch (_) {}
    }
    try {
      S.canvas.dispatchEvent(new PointerEvent(down ? "pointerdown" : "pointerup",
        { bubbles: true, cancelable: true, clientX: cx, clientY: cy, isPrimary: true }));
    } catch (_) {}
    if (!down) {
      try { S.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: cx, clientY: cy })); } catch (_) {}
    }
  }

  const isInAir      = () => (Date.now() - S.lastJumpAt)    < C.jumpAirMs;
  const isSuppressed = () => Date.now() < S.suppressJumpUntil;

  function pressJump() {
    if (!S.active) return;
    const now = Date.now();
    if (now - S.lastJumpAt < C.jumpCooldown) return;
    if (isSuppressed()) return;
    S.lastJumpAt = now; S.jumpCount++;
    callFn("jump");
    key("keydown", " ",       "Space",   32);
    key("keydown", "ArrowUp", "ArrowUp", 38);
    tapCanvas(true);
    setTimeout(() => { key("keyup", " ", "Space", 32); key("keyup", "ArrowUp", "ArrowUp", 38); tapCanvas(false); }, 90);
  }

  function pressDuck() {
    if (!S.active) return;
    const now = Date.now();
    if (now - S.lastDuckAt < C.duckCooldown) return;
    S.lastDuckAt = now;
    S.suppressJumpUntil = Math.max(S.suppressJumpUntil, now + suppressMs());
    callFn("duck");
    key("keydown", "ArrowDown", "ArrowDown", 40);
    setTimeout(() => key("keyup", "ArrowDown", "ArrowDown", 40), C.duckHoldMs);
  }

  function sendStart() {
    callFn("start");
    key("keydown", " ",     "Space", 32);
    key("keydown", "Enter", "Enter", 13);
    tapCanvas(true);
    setTimeout(() => { key("keyup", " ", "Space", 32); key("keyup", "Enter", "Enter", 13); tapCanvas(false); }, 90);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     RHYTHM FALLBACK  (canvas tainted — pixel reads blocked by browser)
  ══════════════════════════════════════════════════════════════════════════ */
  function startRhythm() {
    if (S.rhythmTid) return;
    setStatus("Rhythm mode (pixel scan blocked)");
    const sched = () => {
      const elapsed = S.startTime ? (Date.now() - S.startTime) / 1000 : 0;
      const ms = Math.max(C.rhythmMinMs, C.rhythmBase - (elapsed / C.rhythmEvery | 0) * C.rhythmStep);
      S.rhythmTid = setTimeout(() => {
        if (!S.active || S.rhythmTid === null) return;
        if (!isSuppressed()) pressJump();
        sched();
      }, ms);
    };
    sched();
  }
  function stopRhythm() { if (S.rhythmTid) { clearTimeout(S.rhythmTid); S.rhythmTid = null; } }

  /* ══════════════════════════════════════════════════════════════════════════
     MAIN rAF LOOP
  ══════════════════════════════════════════════════════════════════════════ */
  function tick() {
    if (!S.active) return;
    S.frame++;

    if (!S.canvas) {
      if (findCanvas()) { calibrateBg(); updateInfo(); }
      S.rafId = requestAnimationFrame(tick);
      return;
    }

    if (S.phase === "playing") {
      if (!S.tainted) {
        const obs = detectObstacle();
        if (obs === "jump" && !isInAir()) {
          memLog("jump");
          pressJump();
        } else if (obs === "duck") {
          memLog("duck");
          pressDuck();
        } else {
          // No pixel obstacle — check learned memory for what's coming next
          const ant = memAnticipate();
          if      (ant === "jump" && !isInAir() && !isSuppressed()) pressJump();
          else if (ant === "duck" && !isSuppressed())               pressDuck();
        }

        if (S.frame % C.hashEvery === 0) {
          const h = hashSample();
          if (h !== S.prevHash) { S.prevHash = h; S.lastChangeAt = Date.now(); }
          else if (Date.now() - S.lastChangeAt > C.gameOverMs) onGameOver();
        }
      } else {
        startRhythm();
        if (S.frame % C.hashEvery === 0) {
          const h = hashSample();
          if (h !== S.prevHash) { S.prevHash = h; S.lastChangeAt = Date.now(); }
          else if (Date.now() - S.lastChangeAt > C.gameOverMs) onGameOver();
        }
      }
    }

    if (S.frame % 60 === 0) updateStatus();
    S.rafId = requestAnimationFrame(tick);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     END-SCREEN DOM DETECTION
     Polls for SUBMIT + SKIP visible together — the unique signature of the
     end-run form. Disabled for restartGraceMs after every restart to
     prevent leftover buttons from triggering a false game-over.
  ══════════════════════════════════════════════════════════════════════════ */
  function detectEndScreen() {
    if (!S.active || !S.detectEnabled || S.phase !== "playing") return;
    const btns  = Array.from(document.querySelectorAll(
      'button:not(#__rb__ *), [role="button"]:not(#__rb__ *)'
    )).filter(elVisible);
    const texts = btns.map(b => b.textContent.trim().toLowerCase());
    if (texts.includes("submit") && texts.includes("skip")) onGameOver();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     GAME LOOP  —  playing → over → (submit | skip) → restarting → playing
  ══════════════════════════════════════════════════════════════════════════ */
  function canSubmit() { return Date.now() - S.lastPublishedAt >= PUBLISH_COOLDOWN_MS; }

  // Dedicated submit flow: tick checkbox → click SUBMIT (3 retries) → close leaderboard.
  // Runs publishWait ms after game-over so the popup is fully rendered.
  // sweepPopups is excluded from "over" phase, so this has exclusive control.
  function doPublish() {
    setPhase("publishing");
    S.lastPublishedAt = Date.now(); // start cooldown immediately to prevent double-submit

    function attempt(n) {
      checkAllCheckboxes();
      setTimeout(() => {
        const ok = clickMatching(RE_PUBLISH);
        setStatus(ok ? `Score submitted (${n}/3) — restarting in 5s…` : `Submitting… (${n}/3)`);
      }, 350);
    }

    attempt(1);
    setTimeout(() => attempt(2), C.publishRetry1);
    setTimeout(() => attempt(3), C.publishRetry2);

    // Leaderboard modal appears after submit — close it
    setTimeout(() => closeOverlay(), C.publishRetry1 + 900);
    setTimeout(() => closeOverlay(), C.publishRetry2 + 900);
  }

  function onGameOver() {
    if (S.phase !== "playing") return;
    setPhase("over");
    stopRhythm();
    S.detectEnabled = false;
    memConsolidate();

    if (canSubmit()) {
      setStatus("Game over — submitting in 1.4s…");
      setTimeout(doPublish, C.publishWait);
      S.restartTid = setTimeout(() => { S.restartTid = null; doRestart(); }, C.restartDelay);
    } else {
      setStatus("Game over — skipping in 2s…");
      setTimeout(() => {
        clickMatching(RE_RESTART);
        setStatus("Skipped — restarting in 3s…");
      }, C.skipClickMs);
      S.restartTid = setTimeout(() => { S.restartTid = null; doRestart(); }, C.skipRestartMs);
    }
  }

  function doRestart() {
    setPhase("restarting");
    setStatus("Restarting…");
    stopRhythm();
    calibrateBg();
    // Dismiss any lingering leaderboard modal before sending start
    closeOverlay();
    setTimeout(closeOverlay, 350);
    sweepPopups();

    setTimeout(() => {
      sendStart();
      S.jumpCount = 0; S.startTime = Date.now(); S.lastChangeAt = Date.now();
      S.prevHash = 0; S.frame = 0; S.runLog = []; S.suppressJumpUntil = 0;
      memRefresh();
      setPhase("playing");
      setStatus("Running…");
      S.detectEnabled = false;
      setTimeout(() => { S.detectEnabled = true; }, C.restartGraceMs);
    }, 500);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     BOT CONTROLS
  ══════════════════════════════════════════════════════════════════════════ */
  async function requestWakeLock() {
    if ("wakeLock" in navigator) {
      try { S.wakeLock = await navigator.wakeLock.request("screen"); } catch (_) {}
    }
  }

  function startBot() {
    if (S.active) return;
    S.active = true;
    S.jumpCount = 0; S.startTime = Date.now(); S.lastChangeAt = Date.now();
    S.frame = 0; S.runLog = []; S.suppressJumpUntil = 0;
    memRefresh();
    setPhase("playing");

    if (!S.canvas) findCanvas();
    calibrateBg();
    findGameObj();
    sendStart();
    requestWakeLock();

    S.rafId    = requestAnimationFrame(tick);
    S.calTimer = setInterval(() => { if (S.active && !S.tainted) calibrateBg(); }, C.calIntervalMs);

    // Safety-net jump when pixel scan lags (e.g. fast ice after plane suppression)
    S.heartbeatTid = setInterval(() => {
      if (!S.active || S.phase !== "playing") return;
      if (isSuppressed()) return;
      if (Date.now() - S.lastJumpAt > C.heartbeatMs - 20) pressJump();
    }, C.heartbeatMs);

    // Watchdog: force-restart if stuck in a non-playing phase too long
    S.watchdogTid = setInterval(() => {
      if (!S.active || S.phase === "playing" || S.phase === "idle") return;
      if (Date.now() - S.phaseAt > C.watchdogMs) {
        if (S.restartTid) { clearTimeout(S.restartTid); S.restartTid = null; }
        doRestart();
      }
    }, 5_000);

    S.detectEnabled = false;
    setTimeout(() => { S.detectEnabled = true; }, C.restartGraceMs);

    renderBtn(true); updateInfo(); setStatus("Running…");
  }

  function stopBot() {
    S.active = false;
    setPhase("idle");
    S.detectEnabled = false;
    if (S.rafId)        { cancelAnimationFrame(S.rafId); S.rafId = null; }
    if (S.calTimer)     { clearInterval(S.calTimer);     S.calTimer = null; }
    if (S.heartbeatTid) { clearInterval(S.heartbeatTid); S.heartbeatTid = null; }
    if (S.watchdogTid)  { clearInterval(S.watchdogTid);  S.watchdogTid = null; }
    if (S.restartTid)   { clearTimeout(S.restartTid);    S.restartTid = null; }
    stopRhythm();
    if (S.wakeLock)     { S.wakeLock.release().catch(() => {}); S.wakeLock = null; }
    renderBtn(false); setStatus("Idle");
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PANEL UI
  ══════════════════════════════════════════════════════════════════════════ */
  function createPanel() {
    if (document.getElementById("__rb__")) return;
    const p   = document.createElement("div");
    p.id      = "__rb__";
    const mob = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (mob) {
      p.style.cssText = [
        "position:fixed","bottom:16px","left:50%","transform:translateX(-50%)",
        "z-index:2147483647","background:rgba(8,10,20,.96)","color:#dde",
        "padding:10px 16px","border-radius:16px","font:12px/1.4 monospace",
        "box-shadow:0 4px 24px rgba(0,0,0,.8)","border:1px solid #2a3060",
        "display:flex","align-items:center","gap:12px","touch-action:none","max-width:92vw",
      ].join(";");
      p.innerHTML = `
<div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0">
  <div id="__rbs__" style="color:#888;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">● Idle</div>
  <div id="__rbi__" style="color:#445;font-size:10px;white-space:nowrap">–</div>
</div>
<button id="__rbb__" style="padding:11px 22px;cursor:pointer;border:none;border-radius:10px;background:linear-gradient(135deg,#1c8,#0a5);color:#fff;font:700 13px monospace;touch-action:manipulation;min-width:90px;flex-shrink:0">▶ Start</button>`;
    } else {
      p.style.cssText = [
        "position:fixed","top:12px","right:12px","z-index:2147483647",
        "background:rgba(8,10,18,.93)","color:#dde","padding:14px 16px","border-radius:11px",
        "font:12px/1.5 monospace","min-width:210px","box-shadow:0 6px 28px rgba(0,0,0,.7)",
        "border:1px solid #2a3050","backdrop-filter:blur(6px)","user-select:none",
      ].join(";");
      p.innerHTML = `
<div id="__rbh__" style="font-size:14px;font-weight:700;color:#7af;margin-bottom:10px;cursor:move;letter-spacing:.4px">⚡ Runner Bot v3.1</div>
<div id="__rbs__" style="color:#888;margin-bottom:5px">● Idle</div>
<div id="__rbi__" style="color:#444;font-size:10px;margin-bottom:10px">Searching for canvas…</div>
<button id="__rbb__" style="width:100%;padding:8px 0;cursor:pointer;border:none;border-radius:7px;background:linear-gradient(135deg,#1c8,#0a5);color:#fff;font:700 12px monospace">▶  Start Bot</button>
<div style="margin-top:8px;display:flex;align-items:center;justify-content:space-between">
  <span style="color:#333;font-size:10px">ice↑ · plane✈ · learns map · submit ✓</span>
  <button id="__rbr__" style="padding:2px 8px;font:10px monospace;border:1px solid #2a3050;border-radius:4px;background:#0e1020;color:#556;cursor:pointer" title="Clear learned patterns — tap twice">✕ mem</button>
</div>`;
    }

    document.body.appendChild(p);
    S.panel    = p;
    S.statusEl = p.querySelector("#__rbs__");
    S.infoEl   = p.querySelector("#__rbi__");
    S.btn      = p.querySelector("#__rbb__");

    const doToggle = e => { if (e.cancelable) e.preventDefault(); S.active ? stopBot() : startBot(); };
    S.btn.addEventListener("click",    doToggle);
    S.btn.addEventListener("touchend", doToggle, { passive: false });

    // Reset learned patterns — requires two taps within 2 s.
    // (window.confirm is overridden to always return true, so we can't use it.)
    const resetBtn = p.querySelector("#__rbr__");
    if (resetBtn) {
      let pendingAt = 0;
      resetBtn.addEventListener("click", e => {
        e.stopPropagation();
        const now = Date.now();
        if (now - pendingAt < 2000) {
          memReset();
          resetBtn.textContent = "✓ cleared";
          setTimeout(() => { resetBtn.textContent = "✕ mem"; }, 1500);
          pendingAt = 0;
        } else {
          pendingAt = now;
          resetBtn.textContent = "tap again";
          setTimeout(() => { if (Date.now() - pendingAt >= 1900) resetBtn.textContent = "✕ mem"; }, 2000);
        }
      });
    }

    // Touch drag (mobile repositioning)
    let sx = 0, sy = 0, sl = 0, st = 0, drag = false;
    p.addEventListener("touchstart", e => {
      if (e.target === S.btn) return;
      drag = true; const t = e.touches[0]; sx = t.clientX; sy = t.clientY;
      const r = p.getBoundingClientRect(); sl = r.left; st = r.top;
    }, { passive: true });
    p.addEventListener("touchmove", e => {
      if (!drag || e.target === S.btn) return; e.preventDefault();
      const t = e.touches[0];
      p.style.left = (sl + t.clientX - sx) + "px"; p.style.top = (st + t.clientY - sy) + "px";
      p.style.bottom = "auto"; p.style.right = "auto"; p.style.transform = "none";
    }, { passive: false });
    p.addEventListener("touchend", () => { drag = false; }, { passive: true });

    // Mouse drag (desktop repositioning)
    const head = p.querySelector("#__rbh__");
    if (head) {
      let ox = 0, oy = 0, mx = 0, my = 0;
      head.addEventListener("mousedown", e => {
        e.preventDefault();
        ox = p.offsetLeft || (innerWidth - 12 - p.offsetWidth); oy = p.offsetTop;
        mx = e.clientX; my = e.clientY;
        const onM = e2 => { p.style.left = (ox + e2.clientX - mx) + "px"; p.style.top = (oy + e2.clientY - my) + "px"; p.style.right = "auto"; };
        const onU = () => { removeEventListener("mousemove", onM); removeEventListener("mouseup", onU); };
        addEventListener("mousemove", onM); addEventListener("mouseup", onU);
      });
    }
  }

  function renderBtn(running) {
    if (!S.btn) return;
    const mob = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    S.btn.textContent   = running ? (mob ? "■ Stop" : "■  Stop Bot") : (mob ? "▶ Start" : "▶  Start Bot");
    S.btn.style.background = running ? "linear-gradient(135deg,#c33,#911)" : "linear-gradient(135deg,#1c8,#0a5)";
  }

  function setStatus(msg) {
    if (!S.statusEl) return;
    const col =
      /running/i.test(msg)              ? "#4e4" :   // green  — playing
      /submitted|✓/i.test(msg)          ? "#4af" :   // blue   — score saved
      /submitting|game over/i.test(msg) ? "#fa4" :   // amber  — transitioning
      /skip|restart/i.test(msg)         ? "#c8f" :   // purple — restarting
      "#888";                                          // grey   — idle/other
    S.statusEl.innerHTML = `<span style="color:${col}">● ${msg}</span>`;
  }

  function updateStatus() {
    if (!S.active || S.phase !== "playing") return;
    const sec  = (Date.now() - S.startTime) / 1000 | 0;
    const mm   = String(sec / 60 | 0).padStart(2, "0");
    const ss   = String(sec % 60).padStart(2, "0");
    const sup  = isSuppressed() ? " ✈" : "";
    const runs = memRunCount();
    const mem  = runs > 0 ? (runs < RUNS_MIN ? ` · learn ${runs}/${RUNS_MIN}` : ` · ✧${runs}r`) : "";
    setStatus(`Running ${mm}:${ss} · ${S.jumpCount}j${sup}${mem}`);
  }

  function updateInfo() {
    if (!S.infoEl) return;
    const pats = memPatternCount(), runs = memRunCount();
    // Always show run count so the user can confirm learning is happening
    const mem = pats > 0
      ? ` · ${pats}pat/${runs}r`
      : ` · ${runs}r${runs < RUNS_MIN ? ` (need ${RUNS_MIN})` : ""}`;
    const base = !S.canvas ? "canvas not found" : S.tainted ? "rhythm mode" : `${S.canvas.width}×${S.canvas.height}`;
    S.infoEl.textContent = base + mem;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     EVENT OBSERVERS
  ══════════════════════════════════════════════════════════════════════════ */

  // Watch for new canvas elements added dynamically after page load
  new MutationObserver(() => {
    if (!S.canvas && findCanvas()) { calibrateBg(); updateInfo(); }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Auto-dismiss popups when not actively playing or managing game-over.
  // Guard excludes "playing" (never click during a run) and "over" (doPublish
  // owns the submission flow — no outside interference allowed).
  new MutationObserver(() => {
    if (!S.active || S.phase === "playing" || S.phase === "over") return;
    sweepPopups();
  }).observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => {
    if (!S.active || S.phase === "playing" || S.phase === "over") return;
    sweepPopups();
  }, 400);

  setInterval(detectEndScreen, 300);

  // Prevent false game-over when tab is backgrounded (rAF pauses → canvas hash
  // stops changing → the 2000 ms threshold would fire). Reset hash state on
  // any visibility change so the timer starts fresh when the tab returns.
  document.addEventListener("visibilitychange", () => {
    S.lastChangeAt = Date.now();
    S.prevHash = 0;
    // Re-acquire wake lock after iOS releases it on tab hide
    if (!document.hidden && S.active && !S.wakeLock) requestWakeLock();
  });

  /* ── global toggle (bookmarklet / external call) ─────────────────────── */
  window.__RB_ACTIVE__ = false;
  window.__RB_TOGGLE__ = () => {
    window.__RB_ACTIVE__ = !window.__RB_ACTIVE__;
    window.__RB_ACTIVE__ ? startBot() : stopBot();
  };

  /* ══════════════════════════════════════════════════════════════════════════
     INIT — create panel, find canvas, auto-start 2.5 s after page load
  ══════════════════════════════════════════════════════════════════════════ */
  function init() {
    createPanel();
    if (findCanvas()) { calibrateBg(); updateInfo(); }
    setTimeout(findGameObj, 800);
    setTimeout(() => { if (!S.active) startBot(); }, 2500);
  }

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", init)
    : init();
})();
