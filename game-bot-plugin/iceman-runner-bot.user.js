// ==UserScript==
// @name         Iceman Runner Bot
// @namespace    https://github.com/believeinmeme/token-list
// @version      2.6.0
// @description  Learns the obstacle map over runs and anticipates obstacles from memory. Dual-zone pixel scan, adaptive speed, smart 30s submit/skip. Hands-free.
// @author       believeinmeme
// @match        https://www.icemancountdown.com/runner*
// @match        https://www.icemancountdown.com/runner
// @run-at       document-idle
// @grant        none
// @noframes
// @downloadURL  https://raw.githubusercontent.com/believeinmeme/token-list/claude/game-bot-plugin-ruwut/game-bot-plugin/iceman-runner-bot.user.js
// @updateURL    https://raw.githubusercontent.com/believeinmeme/token-list/claude/game-bot-plugin-ruwut/game-bot-plugin/iceman-runner-bot.user.js
// ==/UserScript==

/**
 * v2.6 – run-based learning system
 *
 * Ground ice  → jump over it
 * Sky plane   → stay grounded (suppress jumping while it passes)
 *
 * v2.6 new feature: the bot learns the obstacle map and improves every run.
 *  - Every pixel-scan detection is timestamped and stored in localStorage.
 *  - After each death, events are merged into a persistent pattern map
 *    keyed by time-bucket (300ms resolution).
 *  - After 3 training runs, high-confidence patterns (≥60% for jump,
 *    ≥72% for duck) are anticipated 500ms BEFORE the pixel scan would
 *    catch them. The bot acts on memory, not just sight.
 *  - The more runs completed, the sharper the confidence scores become
 *    and the earlier/more reliably the bot reacts.
 *  - Memory persists across page reloads (localStorage). A "Reset" button
 *    clears it if the map changes or patterns go wrong.
 */
(function () {
  "use strict";

  /* ── idempotency ─────────────────────────────────────────────────────────── */
  if (window.__RB_ACTIVE__ !== undefined) { window.__RB_TOGGLE__(); return; }

  /* ══════════════════════════════════════════════════════════════════════════
     POPUP AUTO-APPROVE  (runs from page load, catches all native dialogs)
  ══════════════════════════════════════════════════════════════════════════ */
  window.confirm = () => true;
  window.alert   = () => undefined;
  window.prompt  = (_, def) => (def !== undefined ? def : "");

  const RE_PUBLISH = /^\s*submit\s*$|publish|submit[\s\S]{0,20}score|leaderboard/i;
  const RE_APPROVE = /\b(ok|yes|confirm|accept|continue|got.?it|done|send|save|close)\b/i;
  const RE_RESTART = /^\s*skip\s*$|play.?again|try.?again|restart|new.?game|retry/i;

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
      if (cb.closest("#__rb__") || !elVisible(cb) || cb.checked) return;
      cb.checked = true;
      ["change", "input", "click"].forEach(t => cb.dispatchEvent(new Event(t, { bubbles: true })));
    });
  }

  function sweepPopups() {
    checkAllCheckboxes();
    setTimeout(() => { clickMatching(RE_PUBLISH) || clickMatching(RE_APPROVE) || clickMatching(RE_RESTART); }, 150);
  }

  // Only sweep outside of active gameplay (prevents clicking game UI buttons during a run)
  new MutationObserver(() => { if (!S.active || S.phase !== "playing") sweepPopups(); })
    .observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => { if (!S.active || S.phase !== "playing") sweepPopups(); }, 400);

  /* ══════════════════════════════════════════════════════════════════════════
     STATE
  ══════════════════════════════════════════════════════════════════════════ */
  const S = {
    active: false, canvas: null, ctx: null,
    bgSky: null,      // background colour of the sky zone  (for plane detection)
    bgGnd: null,      // background colour of the ground zone (for ice detection)
    tainted: false,
    rafId: null, calTimer: null, restartTid: null, rhythmTid: null, heartbeatTid: null,
    lastJumpAt: 0, lastDuckAt: 0,
    suppressJumpUntil: 0,   // ms timestamp – no jumping allowed while Date.now() < this
    jumpCount: 0, startTime: 0,
    lastChangeAt: 0, prevHash: 0,
    frame: 0, gameObj: null,
    panel: null, statusEl: null, infoEl: null, btn: null,
    phase: "idle",            // "idle"|"playing"|"over"|"publishing"|"restarting"
    lastPublishedAt: 0,
    detectEnabled: false,     // end-screen detection paused during grace period after restart
    runLog: [],               // obstacle events logged during the current run (for learning)
  };

  const PUBLISH_COOLDOWN_MS = 31_000;

  /* ══════════════════════════════════════════════════════════════════════════
     CONFIG
  ══════════════════════════════════════════════════════════════════════════ */
  const C = {
    // ── jump timing ──────────────────────────────────────────────────────
    jumpCooldown:  380,   // ms min between jumps
    duckCooldown:  280,
    jumpAirMs:     620,   // estimated jump arc duration
    duckHoldMs:    220,
    // suppressMs is now computed adaptively — see adaptiveSuppressMs()
    heartbeatMs:   850,   // ms – safety-net jump interval (only when NOT suppressed)

    // ── game loop ─────────────────────────────────────────────────────────
    gameOverMs:   1800,   // ms of canvas silence → game-over
    publishWait:  1000,   // ms after game-over before clicking SUBMIT
    restartDelay: 3800,   // ms after game-over before restart (submit path)
    skipRestartMs: 800,   // ms after game-over before restart (skip path)
    restartGraceMs:3500,  // ms after restart where end-screen detection is paused
    calIntervalMs: 8000,

    // ── pixel detection ───────────────────────────────────────────────────
    bgTolGnd:     55,     // colour distance for ice (ground zone)
    bgTolAir:     60,     // colour distance for plane (sky zone) — slightly stricter
    groundHits:    4,     // pixels needed to call it a ground ice obstacle
    airHits:      10,     // pixels needed to call it a sky plane — higher threshold
                          // prevents city-building bg from causing false duck events
    hashEvery:     3,

    // ── scan zones (fraction of canvas height) ────────────────────────────
    // Ground zone: where ice obstacles live (lower part of screen)
    groundTop: 0.65, groundBot: 0.90,
    // Air zone:    where planes fly (mid-screen, NOT overlapping ground zone)
    airTop:    0.24, airBot:    0.55,

    // ── scan columns (fraction of canvas width) ───────────────────────────
    // 4 columns further right = much more lead time at high speed.
    // colPushPer30s is aggressive so columns keep advancing as game accelerates.
    baseCols: [0.28, 0.40, 0.52, 0.64],
    colPushPer30s: 0.04, colPushMax: 0.16, colMax: 0.80,

    // ── rhythm fallback (tainted canvas) ─────────────────────────────────
    rhythmBase:    900,
    rhythmMinMs:   480,
    rhythmStep:     28,
    rhythmEvery:    20,
  };

  /* ══════════════════════════════════════════════════════════════════════════
     GAME-OBJECT HOOK
  ══════════════════════════════════════════════════════════════════════════ */
  const GAME_NAMES = ["game","Game","runner","Runner","App","app","GameScene","mainGame","scene","phaser"];

  function findGameObj() {
    if (S.gameObj) return S.gameObj;
    for (const n of GAME_NAMES) {
      try {
        const v = window[n];
        if (!v || typeof v !== "object") continue;
        const p = v.player || v.runner || v;
        if (typeof p.jump==="function"||typeof p.doJump==="function"||
            typeof p.duck==="function"||typeof p.crouch==="function") {
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
    for (const f of (map[path] || [])) if (typeof f === "function") { f.call(p); return true; }
    return false;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     CANVAS  +  DUAL-ZONE BACKGROUND CALIBRATION
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

  function avgColor(data) {
    let r = 0, g = 0, b = 0, n = data.data.length / 4;
    for (let i = 0; i < data.data.length; i += 4) { r += data.data[i]; g += data.data[i+1]; b += data.data[i+2]; }
    return { r: r/n, g: g/n, b: b/n };
  }

  function calibrateBg() {
    if (!S.ctx || S.tainted) return;
    const { canvas: cv, ctx } = S;

    // Sky background: top-left corner — used to detect planes against the sky
    const skyW = Math.max(2, cv.width  * 0.07 | 0);
    const skyH = Math.max(2, cv.height * 0.07 | 0);
    try { S.bgSky = avgColor(ctx.getImageData(2, 2, skyW, skyH)); }
    catch (_) { S.tainted = true; return; }

    // Ground background: far-left edge at ground level (behind the player, no obstacles).
    // Sampling here gives us the true colour of the ground/snow so ice obstacles
    // (which are a different shade) stand out clearly.
    const gX = Math.max(1, cv.width  * 0.02 | 0);
    const gY = Math.max(1, cv.height * C.groundTop | 0);
    const gW = Math.max(2, cv.width  * 0.05 | 0);
    const gH = Math.max(2, cv.height * (C.groundBot - C.groundTop) | 0);
    try { S.bgGnd = avgColor(ctx.getImageData(gX, gY, gW, gH)); }
    catch (_) {}
  }

  // Is pixel (r,g,b) different from the sky background? → plane detected
  function isSkyObs(r, g, b) {
    if (!S.bgSky) return false;
    return Math.abs(r-S.bgSky.r) + Math.abs(g-S.bgSky.g) + Math.abs(b-S.bgSky.b) > C.bgTolAir;
  }

  // Is pixel (r,g,b) different from the ground background? → ice obstacle detected
  function isGndObs(r, g, b) {
    if (!S.bgGnd) return false;
    return Math.abs(r-S.bgGnd.r) + Math.abs(g-S.bgGnd.g) + Math.abs(b-S.bgGnd.b) > C.bgTolGnd;
  }

  // How long to suppress jumping after seeing a plane.
  // Starts at ~1100ms and shrinks as the game speeds up (obstacles pass faster).
  // Formula: 1100 - 5ms per second of elapsed play time, floor 480ms.
  function adaptiveSuppressMs() {
    const elapsed = S.active ? (Date.now() - S.startTime) / 1000 : 0;
    return Math.max(480, 1100 - elapsed * 5);
    // 0s → 1100ms · 60s → 800ms · 120s → 500ms · ≥124s → 480ms
  }

  /* ══════════════════════════════════════════════════════════════════════════
     LEARNING SYSTEM
     Records pixel-scan events during each run, consolidates them into
     localStorage after each death. After RUNS_MIN runs, high-confidence
     patterns are anticipated LOOK_AHEAD ms before the pixel scan would see
     them — so the bot reacts from memory rather than sight alone.
  ══════════════════════════════════════════════════════════════════════════ */
  const MEM_KEY   = "__rb_mem__";
  const MEM_VER   = 1;
  const BUCKET_MS = 300;   // 300ms buckets — events within ±150ms merge together
  const LOOK_AHEAD= 500;   // ms ahead of current elapsed time to check memory
  const CONF_JUMP = 0.60;  // fraction of runs jump must appear to be anticipated
  const CONF_DUCK = 0.72;  // higher bar: false duck kills jump window
  const RUNS_MIN  = 3;     // training runs before anticipation switches on

  let MEM = null;           // { v, runs, p: {"<ms>": {j, d}} }
  let lastAntBucket = -1;   // prevents re-firing the same bucket twice per run

  function bucketOf(ms) { return Math.round(ms / BUCKET_MS) * BUCKET_MS; }

  function memLoad() {
    try {
      const raw = localStorage.getItem(MEM_KEY);
      if (!raw) return { v: MEM_VER, runs: 0, p: {} };
      const m = JSON.parse(raw);
      return (m && m.v === MEM_VER) ? m : { v: MEM_VER, runs: 0, p: {} };
    } catch (_) { return { v: MEM_VER, runs: 0, p: {} }; }
  }

  function memSave() {
    if (!MEM) return;
    try { localStorage.setItem(MEM_KEY, JSON.stringify(MEM)); } catch (_) {}
  }

  function memReset() { MEM = { v: MEM_VER, runs: 0, p: {} }; memSave(); updateInfo(); }

  // Reload from storage at the start of every run
  function memRefresh() { MEM = memLoad(); lastAntBucket = -1; }

  // Log a pixel-scan confirmed obstacle (deduped: same type in adjacent bucket ignored)
  function memLog(type) {
    if (!S.active || !S.startTime) return;
    const t = bucketOf(Date.now() - S.startTime);
    const last = S.runLog[S.runLog.length - 1];
    if (last && last.type === type && t - last.t <= BUCKET_MS) return;
    S.runLog.push({ t, type });
  }

  // Merge run log into persistent memory; call on game-over
  function memConsolidate() {
    if (!MEM || S.runLog.length === 0) { S.runLog = []; return; }
    MEM.runs = (MEM.runs || 0) + 1;
    for (const { t, type } of S.runLog) {
      const key = String(t);
      if (!MEM.p[key]) MEM.p[key] = { j: 0, d: 0 };
      if (type === "jump") MEM.p[key].j++; else MEM.p[key].d++;
    }
    // Prune impossibly late buckets (>10 min) to keep storage lean
    for (const key of Object.keys(MEM.p)) {
      if (Number(key) > 600_000) delete MEM.p[key];
    }
    memSave();
    S.runLog = [];
    updateInfo();
  }

  // Return anticipated action ("jump"|"duck"|null) for the approaching time window
  function memAnticipate() {
    if (!MEM || MEM.runs < RUNS_MIN || !S.startTime) return null;
    const target = bucketOf(Date.now() - S.startTime + LOOK_AHEAD);
    if (target === lastAntBucket) return null;
    const b = MEM.p[String(target)];
    if (!b) return null;
    if (b.j >= b.d) {
      if (b.j / MEM.runs >= CONF_JUMP) { lastAntBucket = target; return "jump"; }
    } else {
      if (b.d / MEM.runs >= CONF_DUCK) { lastAntBucket = target; return "duck"; }
    }
    return null;
  }

  function memPatternCount() { return MEM ? Object.keys(MEM.p).length : 0; }
  function memRunCount()     { return MEM ? (MEM.runs || 0) : 0; }

  function hashSample() {
    if (!S.ctx || S.tainted) return 0;
    const { canvas: cv, ctx } = S;
    let data;
    try { data = ctx.getImageData(cv.width*0.5|0, cv.height*0.5|0, 10, 4); }
    catch (_) { S.tainted = true; return 0; }
    let h = 0;
    for (let i = 0; i < data.data.length; i += 8) h = (h * 31 + data.data[i]) | 0;
    return h;
  }

  function getScanCols() {
    const elapsed = S.active ? (Date.now() - S.startTime) / 1000 : 0;
    const push = Math.min(C.colPushMax, (elapsed / 30 | 0) * C.colPushPer30s);
    return C.baseCols.map(col => Math.min(C.colMax, col + push));
  }

  /* ══════════════════════════════════════════════════════════════════════════
     OBSTACLE DETECTION  –  two independent zones, two independent bg colours
  ══════════════════════════════════════════════════════════════════════════ */
  function detectObstacle() {
    if (!S.ctx || !S.canvas || S.tainted) return null;
    const { canvas: cv, ctx } = S;
    const W = cv.width, H = cv.height;
    const cols = getScanCols();

    const gY = H * C.groundTop | 0;
    const gH = Math.max(1, H * (C.groundBot - C.groundTop) | 0);
    const aY = H * C.airTop    | 0;
    const aH = Math.max(1, H * (C.airBot    - C.airTop)    | 0);

    let groundPixels = 0, airPixels = 0;

    for (const frac of cols) {
      const sx = Math.min(W - 1, W * frac | 0);
      let gd, ad;
      try { gd = ctx.getImageData(sx, gY, 1, gH); ad = ctx.getImageData(sx, aY, 1, aH); }
      catch (_) { S.tainted = true; return null; }

      for (let i = 0; i < gd.data.length; i += 4)
        if (isGndObs(gd.data[i], gd.data[i+1], gd.data[i+2])) groundPixels++;
      for (let i = 0; i < ad.data.length; i += 4)
        if (isSkyObs(ad.data[i], ad.data[i+1], ad.data[i+2])) airPixels++;
    }

    // Plane (sky) check takes priority: if detected, suppress jumping immediately.
    if (airPixels    >= C.airHits)    return "duck";
    if (groundPixels >= C.groundHits) return "jump";
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     INPUT SIMULATION
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
        const t = new Touch({ identifier: Date.now() & 0xffff, target: S.canvas, clientX: cx, clientY: cy, screenX: cx, screenY: cy, pageX: cx + scrollX, pageY: cy + scrollY, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1 });
        S.canvas.dispatchEvent(new TouchEvent(down ? "touchstart" : "touchend", { bubbles: true, cancelable: true, touches: down ? [t] : [], targetTouches: down ? [t] : [], changedTouches: [t] }));
      } catch (_) {}
    }
    try { S.canvas.dispatchEvent(new PointerEvent(down ? "pointerdown" : "pointerup", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, isPrimary: true })); } catch (_) {}
    if (!down) { try { S.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: cx, clientY: cy })); } catch (_) {} }
  }

  function isInAir() { return (Date.now() - S.lastJumpAt) < C.jumpAirMs; }
  function isSuppressed() { return Date.now() < S.suppressJumpUntil; }

  function pressJump() {
    const now = Date.now();
    if (now - S.lastJumpAt < C.jumpCooldown) return;
    if (isSuppressed()) return; // plane incoming — stay on the ground!
    S.lastJumpAt = now; S.jumpCount++;

    callFn("jump");
    key("keydown", " ",       "Space",   32);
    key("keydown", "ArrowUp", "ArrowUp", 38);
    tapCanvas(true);
    setTimeout(() => {
      key("keyup", " ",       "Space",   32);
      key("keyup", "ArrowUp", "ArrowUp", 38);
      tapCanvas(false);
    }, 90);
  }

  function pressDuck() {
    const now = Date.now();
    if (now - S.lastDuckAt < C.duckCooldown) return;
    S.lastDuckAt = now;

    // Extend jump suppression: plane is nearby, don't jump until it passes.
    // Duration shrinks as game speeds up so we can jump again sooner.
    S.suppressJumpUntil = Math.max(S.suppressJumpUntil, now + adaptiveSuppressMs());

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
     RHYTHM FALLBACK  (tainted canvas — can't read pixels)
     When canvas is tainted we can't distinguish obstacle types.
     Rhythm mode keeps a steady beat; it won't be perfect but it's the best
     possible without pixel access.
  ══════════════════════════════════════════════════════════════════════════ */
  function startRhythm() {
    if (S.rhythmTid) return;
    setStatus("Rhythm mode");
    const sched = () => {
      const elapsed = S.active ? (Date.now() - S.startTime) / 1000 : 0;
      const ms = Math.max(C.rhythmMinMs, C.rhythmBase - (elapsed / C.rhythmEvery | 0) * C.rhythmStep);
      S.rhythmTid = setTimeout(() => {
        if (!S.active) return;
        if (!isSuppressed()) pressJump(); // respect suppression even in rhythm mode
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
        const type = detectObstacle();
        if (type === "jump" && !isInAir()) {
          memLog("jump");   // record for learning before acting
          pressJump();      // ice on ground → jump over it
        } else if (type === "duck") {
          memLog("duck");   // record for learning before acting
          pressDuck();      // plane in sky → suppress jumping, stay grounded
        } else {
          // Nothing in the pixel scan — check learned memory for what's coming
          const ant = memAnticipate();
          if      (ant === "jump" && !isInAir() && !isSuppressed()) pressJump();
          else if (ant === "duck" && !isSuppressed())               pressDuck();
        }

        // Game-over detection via canvas hash
        if (S.frame % C.hashEvery === 0) {
          const h = hashSample();
          if (h !== S.prevHash) { S.prevHash = h; S.lastChangeAt = Date.now(); }
          else if (Date.now() - S.lastChangeAt > C.gameOverMs) onGameOver();
        }
      } else {
        startRhythm();
        // Still detect game-over even in rhythm mode
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
     Looks for the "END RUN & SUBMIT" overlay (SUBMIT + SKIP visible together).
     detectEnabled is false for restartGraceMs after every restart so leftover
     buttons from the previous form can't trigger a false game-over.
  ══════════════════════════════════════════════════════════════════════════ */
  function detectEndScreen() {
    if (!S.detectEnabled || S.phase !== "playing") return;
    const btns = Array.from(document.querySelectorAll(
      'button:not(#__rb__ *), [role="button"]:not(#__rb__ *)'
    )).filter(elVisible);
    const texts = btns.map(b => b.textContent.trim().toLowerCase());
    // Both SUBMIT and SKIP must be visible simultaneously — unique to the end-run form
    if (texts.includes("submit") && texts.includes("skip")) {
      onGameOver();
    }
  }
  setInterval(detectEndScreen, 300);

  /* ══════════════════════════════════════════════════════════════════════════
     GAME LOOP  –  playing → over → (submit | skip) → restarting → playing
  ══════════════════════════════════════════════════════════════════════════ */
  function canSubmit() { return Date.now() - S.lastPublishedAt >= PUBLISH_COOLDOWN_MS; }

  function onGameOver() {
    if (S.phase !== "playing") return;
    S.phase = "over";
    stopRhythm();
    S.detectEnabled = false; // pause end-screen detection while we handle this
    memConsolidate();         // save this run's obstacle log to persistent memory

    if (canSubmit()) {
      setStatus("Game over – submitting score…");
      setTimeout(() => {
        S.phase = "publishing";
        sweepPopups();             // tick checkbox → then SUBMIT
        S.lastPublishedAt = Date.now();
        setStatus("Submitted ✓ – restarting…");
      }, C.publishWait);
      S.restartTid = setTimeout(() => { S.restartTid = null; doRestart(); }, C.restartDelay);
    } else {
      // Still within 30 s cooldown → skip immediately, restart fast
      setStatus("Game over – cooldown, skipping…");
      clickMatching(RE_RESTART); // click SKIP
      S.restartTid = setTimeout(() => { S.restartTid = null; doRestart(); }, C.skipRestartMs);
    }
  }

  function doRestart() {
    S.phase = "restarting";
    setStatus("Restarting…");
    stopRhythm();
    calibrateBg();
    sweepPopups(); // clear any remaining overlay before restarting

    setTimeout(() => {
      sendStart();
      S.jumpCount    = 0;
      S.startTime    = Date.now();
      S.lastChangeAt = Date.now();
      S.prevHash     = 0;
      S.frame        = 0;
      S.runLog       = [];     // fresh log for this run
      S.suppressJumpUntil = 0; // clear any plane suppression from the dead run
      S.phase        = "playing";
      memRefresh();            // reload memory (captures pattern count updates)
      setStatus("Running…");

      // Grace period: don't check for end screen for restartGraceMs after restart.
      // This prevents the leftover SUBMIT/SKIP buttons from the old run
      // from triggering an immediate false game-over on the new run.
      S.detectEnabled = false;
      setTimeout(() => { S.detectEnabled = true; }, C.restartGraceMs);
    }, 500);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     BOT CONTROLS
  ══════════════════════════════════════════════════════════════════════════ */
  function startBot() {
    if (S.active) return;
    S.active   = true;
    S.startTime = Date.now(); S.jumpCount = 0;
    S.lastChangeAt = Date.now(); S.frame = 0;
    S.phase    = "playing";
    S.suppressJumpUntil = 0;
    S.runLog   = [];
    memRefresh();      // load persisted patterns from previous sessions
    if (!S.canvas) findCanvas();
    calibrateBg();
    sendStart();
    S.rafId    = requestAnimationFrame(tick);
    S.calTimer = setInterval(() => { if (S.active && !S.tainted) calibrateBg(); }, C.calIntervalMs);

    // Heartbeat: safety-net jump every 900 ms.
    // Only fires when the bot is NOT suppressed (no plane incoming) and
    // has not jumped recently. Clears ground ice even if pixel scan lags.
    S.heartbeatTid = setInterval(() => {
      if (!S.active || S.phase !== "playing") return;
      if (isSuppressed()) return;                           // plane nearby — stay grounded
      if (Date.now() - S.lastJumpAt > C.heartbeatMs - 20) pressJump();
    }, C.heartbeatMs);

    // Enable end-screen detection after the initial grace period
    S.detectEnabled = false;
    setTimeout(() => { S.detectEnabled = true; }, C.restartGraceMs);

    renderBtn(true); updateInfo(); setStatus("Running…");
  }

  function stopBot() {
    S.active = false;
    S.phase  = "idle";
    S.detectEnabled = false;
    if (S.rafId) { cancelAnimationFrame(S.rafId); S.rafId = null; }
    clearInterval(S.calTimer);
    clearInterval(S.heartbeatTid); S.heartbeatTid = null;
    stopRhythm();
    if (S.restartTid) { clearTimeout(S.restartTid); S.restartTid = null; }
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
      p.style.cssText = ["position:fixed","bottom:16px","left:50%","transform:translateX(-50%)",
        "z-index:2147483647","background:rgba(8,10,20,.96)","color:#dde",
        "padding:10px 16px","border-radius:16px","font:12px/1.4 monospace",
        "box-shadow:0 4px 24px rgba(0,0,0,.8)","border:1px solid #2a3060",
        "display:flex","align-items:center","gap:12px","touch-action:none","max-width:92vw"].join(";");
      p.innerHTML = `
<div style="display:flex;flex-direction:column;gap:2px">
  <div id="__rbs__" style="color:#888;font-size:11px;white-space:nowrap">● Idle</div>
  <div id="__rbi__" style="color:#445;font-size:10px;white-space:nowrap">–</div>
</div>
<button id="__rbb__" style="padding:11px 22px;cursor:pointer;border:none;border-radius:10px;background:linear-gradient(135deg,#1c8,#0a5);color:#fff;font:700 13px monospace;touch-action:manipulation;min-width:90px;flex-shrink:0">▶ Start</button>`;
    } else {
      p.style.cssText = ["position:fixed","top:12px","right:12px","z-index:2147483647",
        "background:rgba(8,10,18,.93)","color:#dde","padding:14px 16px","border-radius:11px",
        "font:12px/1.5 monospace","min-width:200px","box-shadow:0 6px 28px rgba(0,0,0,.7)",
        "border:1px solid #2a3050","backdrop-filter:blur(6px)","user-select:none"].join(";");
      p.innerHTML = `
<div id="__rbh__" style="font-size:14px;font-weight:700;color:#7af;margin-bottom:10px;cursor:move;letter-spacing:.4px">⚡ Runner Bot v2.6</div>
<div id="__rbs__" style="color:#888;margin-bottom:5px">● Idle</div>
<div id="__rbi__" style="color:#444;font-size:10px;margin-bottom:10px">Searching for canvas…</div>
<button id="__rbb__" style="width:100%;padding:8px 0;cursor:pointer;border:none;border-radius:7px;background:linear-gradient(135deg,#1c8,#0a5);color:#fff;font:700 12px monospace">▶  Start Bot</button>
<div style="margin-top:8px;display:flex;align-items:center;justify-content:space-between">
  <span style="color:#333;font-size:10px">ice→jump · plane→stay · learns map ✧</span>
  <button id="__rbr__" style="padding:2px 7px;font:10px monospace;border:1px solid #2a3050;border-radius:4px;background:#0e1020;color:#556;cursor:pointer" title="Clear learned patterns">✕ mem</button>
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

    const resetBtn = p.querySelector("#__rbr__");
    if (resetBtn) {
      resetBtn.addEventListener("click", e => {
        e.stopPropagation();
        if (confirm("Clear all learned patterns? The bot will re-learn from the next run.")) memReset();
      });
    }

    // Touch drag
    let sx=0,sy=0,sl=0,st=0,drag=false;
    p.addEventListener("touchstart", e => { if (e.target===S.btn) return; drag=true; const t=e.touches[0]; sx=t.clientX; sy=t.clientY; const r=p.getBoundingClientRect(); sl=r.left; st=r.top; }, { passive: true });
    p.addEventListener("touchmove",  e => { if (!drag||e.target===S.btn) return; e.preventDefault(); const t=e.touches[0]; p.style.left=(sl+t.clientX-sx)+"px"; p.style.top=(st+t.clientY-sy)+"px"; p.style.bottom="auto"; p.style.right="auto"; p.style.transform="none"; }, { passive: false });
    p.addEventListener("touchend",   () => { drag=false; }, { passive: true });

    const head = p.querySelector("#__rbh__");
    if (head) {
      let ox=0,oy=0,mx=0,my=0;
      head.addEventListener("mousedown", e => {
        e.preventDefault();
        ox=p.offsetLeft||(innerWidth-12-p.offsetWidth); oy=p.offsetTop; mx=e.clientX; my=e.clientY;
        const onM = e2 => { p.style.left=(ox+e2.clientX-mx)+"px"; p.style.top=(oy+e2.clientY-my)+"px"; p.style.right="auto"; };
        const onU = () => { removeEventListener("mousemove",onM); removeEventListener("mouseup",onU); };
        addEventListener("mousemove",onM); addEventListener("mouseup",onU);
      });
    }
  }

  function renderBtn(running) {
    if (!S.btn) return;
    const mob = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    S.btn.textContent = running ? (mob ? "■ Stop" : "■  Stop Bot") : (mob ? "▶ Start" : "▶  Start Bot");
    S.btn.style.background = running ? "linear-gradient(135deg,#c33,#911)" : "linear-gradient(135deg,#1c8,#0a5)";
  }

  function setStatus(msg) {
    if (!S.statusEl) return;
    const col = msg.includes("Run") ? "#4e4" : (msg.includes("over")||msg.includes("Submit")||msg.includes("skip")) ? "#fa4" : "#888";
    S.statusEl.innerHTML = `<span style="color:${col}">● ${msg}</span>`;
  }

  function updateStatus() {
    if (!S.active || S.phase !== "playing") return;
    const sec  = (Date.now() - S.startTime) / 1000 | 0;
    const time = String(sec / 60 | 0).padStart(2,"0") + ":" + String(sec % 60).padStart(2,"0");
    const sup  = isSuppressed() ? " ✈" : "";
    const runs = memRunCount();
    const memStr = runs > 0
      ? (runs < RUNS_MIN ? ` · learn ${runs}/${RUNS_MIN}` : ` · ✧${runs}r`)
      : "";
    setStatus(`Running ${time} · ${S.jumpCount}j${sup}${memStr}`);
  }

  function updateInfo() {
    if (!S.infoEl) return;
    const pats = memPatternCount();
    const runs = memRunCount();
    const memStr = pats > 0
      ? ` · ${pats}pat/${runs}r`
      : (runs > 0 ? ` · learning…` : "");
    if (!S.canvas) { S.infoEl.textContent = `Searching…${memStr}`; return; }
    S.infoEl.textContent = S.tainted
      ? `rhythm mode${memStr}`
      : `${S.canvas.width}×${S.canvas.height}${memStr}`;
  }

  /* ── canvas watcher ─────────────────────────────────────────────────────── */
  new MutationObserver(() => { if (!S.canvas && findCanvas()) { calibrateBg(); updateInfo(); } })
    .observe(document.documentElement, { childList: true, subtree: true });

  /* ── global toggle ──────────────────────────────────────────────────────── */
  window.__RB_ACTIVE__ = false;
  window.__RB_TOGGLE__ = () => { window.__RB_ACTIVE__ = !window.__RB_ACTIVE__; window.__RB_ACTIVE__ ? startBot() : stopBot(); };

  /* ══════════════════════════════════════════════════════════════════════════
     INIT  –  auto-start 2.5 s after page load
  ══════════════════════════════════════════════════════════════════════════ */
  function init() {
    createPanel();
    if (findCanvas()) { calibrateBg(); updateInfo(); }
    setTimeout(findGameObj, 800);
    setTimeout(() => { if (!S.active) startBot(); }, 2500);
  }

  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();
