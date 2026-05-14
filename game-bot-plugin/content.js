/**
 * Iceman Runner Bot v2 – content script (desktop Chrome/Firefox + Chrome Android)
 *
 * Algorithm:
 *  • 60 fps rAF loop for pixel-perfect timing
 *  • Two scan zones per frame: ground zone (→ jump) and air zone (→ duck)
 *  • Air-time guard: skips redundant jumps while player is already airborne
 *  • Adaptive scan columns: shift right every 30 s to match game speed-up
 *  • Background auto-calibration every 8 s (handles dynamic sky/palette changes)
 *  • Smart rhythm fallback when canvas is tainted (common on mobile/CDN assets)
 *  • Game-global hook via page-context shim (Phaser / custom engine support)
 *  • Reliable game-over detection + auto-restart
 *
 * For iOS Safari: use bookmarklet.js or userscript.js instead.
 */
(function () {
  "use strict";

  /* ── page-context shim ─────────────────────────────────────────────────── */
  // Injected as a <script> so it can read window.game / window.runner etc.
  // Communicates back via CustomEvent.
  void (function injectShim() {
    const s = document.createElement("script");
    s.textContent = `(function(){
  var G={g:null,ok:false};
  var N=['game','Game','runner','Runner','App','app','GameScene','mainGame','scene','phaser'];
  function probe(){
    for(var i=0;i<N.length;i++){
      var v=window[N[i]];
      if(!v||typeof v!=='object')continue;
      var p=v.player||v.runner||v;
      if(typeof p.jump==='function'||typeof p.doJump==='function'||typeof p.duck==='function'){
        G.g=v;G.ok=true;
        document.dispatchEvent(new CustomEvent('__RB_HOOKED__'));
        return true;
      }
    }
    return false;
  }
  var _raf=window.requestAnimationFrame;
  window.requestAnimationFrame=function(cb){
    return _raf.call(window,function(ts){if(!G.ok)probe();return cb(ts);});
  };
  function act(ev,fn){
    document.addEventListener(ev,function(){
      try{if(!G.g)probe();var g=G.g;if(!g)return;fn(g);}catch(e){}
    });
  }
  act('__RB_JUMP__',function(g){
    var p=g.player||g.runner||g;
    if(typeof p.jump==='function')p.jump();
    else if(typeof p.doJump==='function')p.doJump();
    else if(typeof g.jump==='function')g.jump();
  });
  act('__RB_DUCK__',function(g){
    var p=g.player||g.runner||g;
    if(typeof p.duck==='function')p.duck();
    else if(typeof p.crouch==='function')p.crouch();
    else if(typeof g.duck==='function')g.duck();
  });
  act('__RB_START__',function(g){
    if(typeof g.start==='function')g.start();
    else if(typeof g.restart==='function')g.restart();
    else if(typeof g.reset==='function')g.reset();
  });
  probe();
})();`;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  })();

  /* ── state ─────────────────────────────────────────────────────────────── */
  const S = {
    active: false, canvas: null, ctx: null,
    bg: null, tainted: false,
    rafId: null, calTimer: null, restartTid: null, rhythmTid: null,
    lastJumpAt: 0, lastDuckAt: 0,
    jumpCount: 0, startTime: 0,
    lastChangeAt: 0, prevHash: 0,
    frame: 0, hooked: false,
    // UI refs
    panel: null, statusEl: null, infoEl: null, btn: null,
  };

  /* ── config ─────────────────────────────────────────────────────────────── */
  const C = {
    // Timing
    jumpCooldown:  380,  // ms – minimum time between jumps
    duckCooldown:  300,  // ms – minimum time between ducks
    jumpAirMs:     620,  // ms – estimated jump arc (air-time guard)
    duckHoldMs:    260,  // ms – how long to hold ArrowDown
    gameOverMs:   2400,  // ms – canvas silence → assume game-over
    restartDelay:  700,  // ms – pause before sending restart input
    hashEvery:       3,  // frames – check game-over hash this often
    calIntervalMs: 8000, // ms – background recalibration interval

    // Pixel detection
    bgTol:          55,  // Manhattan-distance tolerance for obstacle vs background
    obstacleHits:    3,  // pixel count threshold per scan column
    airExtraHits:    3,  // extra hits required to call a duck (avoids false positives)

    // Scan zones (fractions of canvas height)
    groundTop: 0.58, groundBot: 0.85,  // cactus / wall type obstacles
    airTop:    0.28, airBot:    0.58,   // pterodactyl / aerial obstacles

    // Base scan columns as fraction of canvas width.
    // Player is typically pinned at ~10 % from left.
    // Shifted right every 30 s as the game accelerates.
    baseCols: [0.27, 0.34, 0.42],
    colPushPer30s: 0.025,   // how far right to shift every 30 s
    colPushMax:    0.12,    // maximum total shift
    colMax:        0.60,    // never scan beyond this fraction

    // Rhythm fallback (tainted canvas)
    rhythmBase:    880,  // ms starting interval
    rhythmMinMs:   380,  // ms floor
    rhythmStep:     40,  // ms reduction per 20 s
    rhythmEvery:    20,  // seconds between step-downs
  };

  /* ── canvas helpers ─────────────────────────────────────────────────────── */
  function findCanvas() {
    const all = Array.from(document.querySelectorAll("canvas"))
      .filter(c => c.width > 30 && c.height > 30)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    for (const c of all) {
      try {
        const ctx = c.getContext("2d");
        if (ctx) { S.canvas = c; S.ctx = ctx; return true; }
      } catch (_) {}
    }
    return false;
  }

  function calibrateBg() {
    if (!S.ctx || S.tainted) return;
    const { canvas: cv, ctx } = S;
    const w = Math.max(2, cv.width  * 0.06 | 0);
    const h = Math.max(2, cv.height * 0.06 | 0);
    let data;
    try { data = ctx.getImageData(2, 2, w, h); }
    catch (_) { S.tainted = true; return; }
    let r = 0, g = 0, b = 0, n = data.data.length / 4;
    for (let i = 0; i < data.data.length; i += 4) {
      r += data.data[i]; g += data.data[i + 1]; b += data.data[i + 2];
    }
    S.bg = { r: r / n, g: g / n, b: b / n };
  }

  function isObs(r, g, b) {
    if (!S.bg) return false;
    return Math.abs(r - S.bg.r) + Math.abs(g - S.bg.g) + Math.abs(b - S.bg.b) > C.bgTol;
  }

  function hashSample() {
    if (!S.ctx || S.tainted) return 0;
    const { canvas: cv, ctx } = S;
    let data;
    try { data = ctx.getImageData(cv.width * 0.5 | 0, cv.height * 0.5 | 0, 10, 4); }
    catch (_) { S.tainted = true; return 0; }
    let h = 0;
    for (let i = 0; i < data.data.length; i += 8) h = (h * 31 + data.data[i]) | 0;
    return h;
  }

  // Returns current scan columns, shifted right as game speeds up.
  function scanCols() {
    const elapsed = S.active ? (Date.now() - S.startTime) / 1000 : 0;
    const push = Math.min(C.colPushMax, (elapsed / 30 | 0) * C.colPushPer30s);
    return C.baseCols.map(col => Math.min(C.colMax, col + push));
  }

  /* ── obstacle detection ─────────────────────────────────────────────────── */
  // Returns 'jump', 'duck', or null.
  function detectObstacle() {
    if (!S.ctx || !S.canvas || S.tainted) return null;
    const { canvas: cv, ctx } = S;
    const W = cv.width, H = cv.height;
    const cols = scanCols();

    const gY = H * C.groundTop | 0, gH = Math.max(1, H * (C.groundBot - C.groundTop) | 0);
    const aY = H * C.airTop    | 0, aH = Math.max(1, H * (C.airBot    - C.airTop)    | 0);

    let groundHits = 0, airHits = 0;

    for (const frac of cols) {
      const sx = Math.min(W - 1, W * frac | 0);
      let gd, ad;
      try {
        gd = ctx.getImageData(sx, gY, 1, gH);
        ad = ctx.getImageData(sx, aY, 1, aH);
      } catch (_) { S.tainted = true; return null; }
      for (let i = 0; i < gd.data.length; i += 4) if (isObs(gd.data[i], gd.data[i+1], gd.data[i+2])) groundHits++;
      for (let i = 0; i < ad.data.length; i += 4) if (isObs(ad.data[i], ad.data[i+1], ad.data[i+2])) airHits++;
    }

    if (groundHits >= C.obstacleHits)                    return "jump";
    if (airHits    >= C.obstacleHits + C.airExtraHits)   return "duck";
    return null;
  }

  /* ── input simulation ───────────────────────────────────────────────────── */
  function key(type, k, code, kc) {
    const e = new KeyboardEvent(type, { key: k, code, keyCode: kc, which: kc, bubbles: true, cancelable: true });
    [S.canvas, document.body, document].filter(Boolean).forEach(t => t.dispatchEvent(e));
  }

  function tapCanvas(down) {
    if (!S.canvas || typeof TouchEvent === "undefined") return;
    try {
      const r = S.canvas.getBoundingClientRect();
      const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.7;
      const touch = new Touch({ identifier: Date.now(), target: S.canvas, clientX: cx, clientY: cy, screenX: cx, screenY: cy, pageX: cx + scrollX, pageY: cy + scrollY, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1 });
      const type = down ? "touchstart" : "touchend";
      S.canvas.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: down ? [touch] : [], targetTouches: down ? [touch] : [], changedTouches: [touch] }));
    } catch (_) {}
  }

  function isInAir() {
    return (Date.now() - S.lastJumpAt) < C.jumpAirMs;
  }

  function pressJump() {
    const now = Date.now();
    if (now - S.lastJumpAt < C.jumpCooldown) return;
    S.lastJumpAt = now;
    S.jumpCount++;

    key("keydown", " ", "Space", 32);
    key("keydown", "ArrowUp", "ArrowUp", 38);
    tapCanvas(true);
    document.dispatchEvent(new CustomEvent("__RB_JUMP__"));
    setTimeout(() => { key("keyup", " ", "Space", 32); key("keyup", "ArrowUp", "ArrowUp", 38); tapCanvas(false); }, 90);
  }

  function pressDuck() {
    const now = Date.now();
    if (now - S.lastDuckAt < C.duckCooldown) return;
    S.lastDuckAt = now;
    key("keydown", "ArrowDown", "ArrowDown", 40);
    document.dispatchEvent(new CustomEvent("__RB_DUCK__"));
    setTimeout(() => key("keyup", "ArrowDown", "ArrowDown", 40), C.duckHoldMs);
  }

  function sendStart() {
    ["Space:32", "Enter:13"].forEach(pair => {
      const [code, kc] = pair.split(":");
      key("keydown", code === "Space" ? " " : "Enter", code, +kc);
      setTimeout(() => key("keyup", code === "Space" ? " " : "Enter", code, +kc), 90);
    });
    document.dispatchEvent(new CustomEvent("__RB_START__"));
    tapCanvas(true);
    setTimeout(() => tapCanvas(false), 90);
    if (S.canvas) {
      const r = S.canvas.getBoundingClientRect();
      S.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    }
  }

  /* ── rhythm fallback (tainted canvas) ──────────────────────────────────── */
  function startRhythm() {
    if (S.rhythmTid) return;
    setStatus("Rhythm mode");
    const sched = () => {
      const elapsed = S.active ? (Date.now() - S.startTime) / 1000 : 0;
      const ms = Math.max(C.rhythmMinMs, C.rhythmBase - (elapsed / C.rhythmEvery | 0) * C.rhythmStep);
      S.rhythmTid = setTimeout(() => { if (!S.active) return; pressJump(); sched(); }, ms);
    };
    sched();
  }

  function stopRhythm() {
    if (S.rhythmTid) { clearTimeout(S.rhythmTid); S.rhythmTid = null; }
  }

  /* ── main rAF loop ──────────────────────────────────────────────────────── */
  function tick() {
    if (!S.active) return;
    S.frame++;

    if (!S.canvas) {
      if (findCanvas()) { calibrateBg(); updateInfo(); }
      S.rafId = requestAnimationFrame(tick);
      return;
    }

    if (!S.tainted) {
      const type = detectObstacle();
      if      (type === "jump" && !isInAir()) pressJump();
      else if (type === "duck" && !isInAir()) pressDuck();

      if (S.frame % C.hashEvery === 0) {
        const h = hashSample();
        if (h !== S.prevHash) { S.prevHash = h; S.lastChangeAt = Date.now(); }
        else if (Date.now() - S.lastChangeAt > C.gameOverMs) scheduleRestart();
      }
    } else {
      startRhythm();
    }

    if (S.frame % 60 === 0) updateStatus(); // update timer display every ~1 s

    S.rafId = requestAnimationFrame(tick);
  }

  function scheduleRestart() {
    if (S.restartTid) return;
    setStatus("Game over – restarting…");
    S.lastChangeAt = Date.now();
    S.restartTid = setTimeout(() => {
      S.restartTid = null;
      calibrateBg();
      sendStart();
    }, C.restartDelay);
  }

  /* ── bot controls ───────────────────────────────────────────────────────── */
  function startBot() {
    if (S.active) return;
    S.active = true;
    S.startTime = Date.now();
    S.jumpCount = 0;
    S.lastChangeAt = Date.now();
    S.frame = 0;
    if (!S.canvas) findCanvas();
    calibrateBg();
    sendStart();
    S.rafId = requestAnimationFrame(tick);
    S.calTimer = setInterval(() => { if (S.active && !S.tainted) calibrateBg(); }, C.calIntervalMs);
    renderBtn(true);
    updateInfo();
    setStatus("Running…");
  }

  function stopBot() {
    S.active = false;
    if (S.rafId) { cancelAnimationFrame(S.rafId); S.rafId = null; }
    clearInterval(S.calTimer);
    stopRhythm();
    if (S.restartTid) { clearTimeout(S.restartTid); S.restartTid = null; }
    renderBtn(false);
    setStatus("Idle");
  }

  /* ── panel UI ───────────────────────────────────────────────────────────── */
  function createPanel() {
    if (document.getElementById("__rb__")) return;
    const p = document.createElement("div");
    p.id = "__rb__";
    p.style.cssText = [
      "position:fixed", "top:12px", "right:12px", "z-index:2147483647",
      "background:rgba(8,10,18,.93)", "color:#dde", "padding:14px 16px",
      "border-radius:11px", "font:12px/1.5 monospace", "min-width:200px",
      "box-shadow:0 6px 28px rgba(0,0,0,.7)", "border:1px solid #2a3050",
      "backdrop-filter:blur(6px)", "user-select:none",
    ].join(";");
    p.innerHTML = `
<div id="__rbh__" style="font-size:14px;font-weight:700;color:#7af;margin-bottom:10px;cursor:move;letter-spacing:.4px">⚡ Runner Bot v2</div>
<div id="__rbs__" style="color:#888;margin-bottom:5px">● Idle</div>
<div id="__rbi__" style="color:#444;font-size:10px;margin-bottom:10px">Searching for canvas…</div>
<button id="__rbb__" style="width:100%;padding:8px 0;cursor:pointer;border:none;border-radius:7px;background:linear-gradient(135deg,#1c8,#0a5);color:#fff;font:700 12px monospace">▶  Start Bot</button>
<div style="margin-top:10px;color:#333;font-size:10px;line-height:1.8">
  60 fps · adaptive scan · jump+duck<br>
  air-guard · auto-restart ✓
</div>`;
    document.body.appendChild(p);
    S.panel = p;
    S.statusEl = p.querySelector("#__rbs__");
    S.infoEl   = p.querySelector("#__rbi__");
    S.btn      = p.querySelector("#__rbb__");
    S.btn.addEventListener("click", () => S.active ? stopBot() : startBot());

    // Drag
    const h = p.querySelector("#__rbh__");
    let ox = 0, oy = 0, mx = 0, my = 0;
    h.addEventListener("mousedown", e => {
      e.preventDefault();
      ox = p.offsetLeft || (innerWidth - 12 - p.offsetWidth);
      oy = p.offsetTop; mx = e.clientX; my = e.clientY;
      const onM = e2 => {
        p.style.left = (ox + e2.clientX - mx) + "px";
        p.style.top  = (oy + e2.clientY - my) + "px";
        p.style.right = "auto";
      };
      const onU = () => { removeEventListener("mousemove", onM); removeEventListener("mouseup", onU); };
      addEventListener("mousemove", onM); addEventListener("mouseup", onU);
    });
  }

  function renderBtn(running) {
    if (!S.btn) return;
    S.btn.textContent = running ? "■  Stop Bot" : "▶  Start Bot";
    S.btn.style.background = running ? "linear-gradient(135deg,#c33,#911)" : "linear-gradient(135deg,#1c8,#0a5)";
  }

  function setStatus(msg) {
    if (!S.statusEl) return;
    const col = msg.includes("Run") ? "#4e4" : msg.includes("over") ? "#fa4" : "#888";
    S.statusEl.innerHTML = `<span style="color:${col}">● ${msg}</span>`;
  }

  function updateStatus() {
    if (!S.active) return;
    const sec  = (Date.now() - S.startTime) / 1000 | 0;
    const time = String(sec / 60 | 0).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
    setStatus(`Running ${time} · ${S.jumpCount} jumps`);
  }

  function updateInfo() {
    if (!S.infoEl || !S.canvas) return;
    const cols = scanCols().map(f => S.canvas.width * f | 0).join(", ");
    S.infoEl.innerHTML =
      `Canvas: ${S.canvas.width}×${S.canvas.height}<br>` +
      `Scan X: [${cols}]<br>` +
      (S.tainted ? "Mode: rhythm fallback" : "Mode: pixel scan + duck");
  }

  /* ── event / mutation hooks ─────────────────────────────────────────────── */
  document.addEventListener("__RB_HOOKED__", () => { S.hooked = true; });
  new MutationObserver(() => {
    if (!S.canvas && findCanvas()) { calibrateBg(); updateInfo(); }
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* ── init ───────────────────────────────────────────────────────────────── */
  const init = () => { createPanel(); if (findCanvas()) { calibrateBg(); updateInfo(); } };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();
