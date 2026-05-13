/**
 * Iceman Runner Bot – content script
 *
 * Strategy:
 *  1. Inject a tiny page-context shim that tries to find & expose game globals
 *     (some frameworks store the game object on window).
 *  2. Scan a vertical slice of the canvas a fixed number of pixels ahead of
 *     the player each tick and jump on non-background pixels (obstacle pixels).
 *  3. Fall back to a rhythm-based jump pattern if the canvas is cross-origin
 *     tainted and pixel reads throw SecurityError.
 *  4. Watch for the score stopping (game-over) and auto-restart.
 */
(function () {
  "use strict";

  /* ─────────────────── page-context hook injection ─────────────────── */
  // Runs in the page's JS world so it can reach game globals.
  // Communicates back via CustomEvent.
  function injectPageShim() {
    const s = document.createElement("script");
    s.textContent = `(function(){
      var BOT = { game: null, hooked: false };
      // Try common game-object names used by Phaser / custom runners
      var NAMES = ['game','Game','runner','Runner','GameScene','mainGame','scene'];
      function probe(){
        for(var i=0;i<NAMES.length;i++){
          var v=window[NAMES[i]];
          if(v&&typeof v==='object'&&(v.jump||v.player||(v.scene&&v.scene.jump))){
            BOT.game=v; BOT.hooked=true;
            document.dispatchEvent(new CustomEvent('__RB_HOOKED__'));
            return true;
          }
        }
        return false;
      }
      // Also intercept rAF to catch game object at runtime
      var _raf=window.requestAnimationFrame;
      window.requestAnimationFrame=function(cb){
        return _raf.call(window,function(ts){
          if(!BOT.hooked) probe();
          return cb(ts);
        });
      };
      // Respond to jump commands from the content script
      document.addEventListener('__RB_JUMP__',function(){
        try{
          if(!BOT.game) probe();
          var g=BOT.game;
          if(!g) return;
          if(typeof g.jump==='function') g.jump();
          else if(g.player&&typeof g.player.jump==='function') g.player.jump();
          else if(g.scene&&typeof g.scene.jump==='function') g.scene.jump();
        }catch(e){}
      });
      document.addEventListener('__RB_START__',function(){
        try{
          var g=BOT.game;
          if(!g) return;
          if(typeof g.start==='function') g.start();
          else if(typeof g.restart==='function') g.restart();
        }catch(e){}
      });
      probe();
    })();`;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }
  injectPageShim();

  /* ─────────────────────────────── state ──────────────────────────────── */
  const S = {
    active: false,
    canvas: null,
    ctx: null,
    bg: null,           // { r, g, b } background colour
    tainted: false,     // canvas cross-origin tainted → pixel reads fail
    scanInterval: null,
    restartTimeout: null,
    lastJumpAt: 0,
    jumpCount: 0,
    gameOverAt: 0,
    lastPixelChangeAt: Date.now(),
    prevHash: 0,
    hooked: false,      // page shim found a game object
  };

  /* ─────────────────────────── configuration ──────────────────────────── */
  const CFG = {
    tickMs: 30,           // main scan rate
    jumpCooldownMs: 420,  // minimum gap between jumps
    bgTolerance: 60,      // pixel-diff threshold to classify as obstacle
    bgCalibX: 0.02,       // top-left corner for background sampling
    bgCalibY: 0.02,
    bgCalibW: 0.06,
    bgCalibH: 0.06,
    // Scan columns as fraction of canvas width ahead of the character.
    // The player is usually pinned near the left (~10-15 % of width).
    scanCols: [0.22, 0.27, 0.32],
    scanTop: 0.45,        // start of vertical scan (fraction)
    scanBot: 0.83,        // end of vertical scan
    obstacleHits: 4,      // pixels needed to call it an obstacle
    gameOverQuietMs: 2200,// ms without pixel change before assuming game-over
    restartDelayMs: 600,  // wait after game-over before restarting
    rhythmFallback: false,// enable rhythm-jump fallback
    rhythmJumpMs: 900,    // rhythm-jump interval (if pixel scan unavailable)
  };

  /* ───────────────────────── canvas helpers ───────────────────────────── */
  function findCanvas() {
    const all = Array.from(document.querySelectorAll("canvas"));
    if (!all.length) return false;
    // Pick the largest visible canvas (most likely the game)
    all.sort((a, b) => b.width * b.height - a.width * a.height);
    for (const c of all) {
      if (c.width > 10 && c.height > 10) {
        S.canvas = c;
        try {
          S.ctx = c.getContext("2d");
        } catch (_) {
          S.ctx = null;
        }
        return true;
      }
    }
    return false;
  }

  function calibrateBg() {
    if (!S.ctx || S.tainted) return;
    const { canvas: cv, ctx } = S;
    const x = Math.floor(cv.width * CFG.bgCalibX);
    const y = Math.floor(cv.height * CFG.bgCalibY);
    const w = Math.max(1, Math.floor(cv.width * CFG.bgCalibW));
    const h = Math.max(1, Math.floor(cv.height * CFG.bgCalibH));
    let data;
    try { data = ctx.getImageData(x, y, w, h); }
    catch (_) { S.tainted = true; return; }
    let r = 0, g = 0, b = 0, n = data.data.length / 4;
    for (let i = 0; i < data.data.length; i += 4) {
      r += data.data[i]; g += data.data[i + 1]; b += data.data[i + 2];
    }
    S.bg = { r: r / n, g: g / n, b: b / n };
  }

  function isObstaclePixel(r, g, b) {
    if (!S.bg) return false;
    return Math.abs(r - S.bg.r) + Math.abs(g - S.bg.g) + Math.abs(b - S.bg.b) > CFG.bgTolerance;
  }

  /* Cheap pixel-hash to detect if the game is still animating */
  function sampleHash() {
    if (!S.ctx || S.tainted) return 0;
    const { canvas: cv, ctx } = S;
    const cx = Math.floor(cv.width * 0.5);
    const cy = Math.floor(cv.height * 0.5);
    let data;
    try { data = ctx.getImageData(cx, cy, 8, 4); } catch (_) { S.tainted = true; return 0; }
    let h = 0;
    for (let i = 0; i < data.data.length; i += 8) h = (h * 31 + data.data[i]) | 0;
    return h;
  }

  /* ─────────────────────────── obstacle scan ──────────────────────────── */
  function detectObstacle() {
    if (!S.ctx || !S.canvas || S.tainted) return false;
    const { canvas: cv, ctx } = S;
    const W = cv.width, H = cv.height;
    const startY = Math.floor(H * CFG.scanTop);
    const endY   = Math.floor(H * CFG.scanBot);
    const scanH  = Math.max(1, endY - startY);
    for (const frac of CFG.scanCols) {
      const sx = Math.min(W - 1, Math.floor(W * frac));
      let data;
      try { data = ctx.getImageData(sx, startY, 1, scanH); }
      catch (_) { S.tainted = true; return false; }
      let hits = 0;
      for (let i = 0; i < data.data.length; i += 4) {
        if (isObstaclePixel(data.data[i], data.data[i + 1], data.data[i + 2])) {
          if (++hits >= CFG.obstacleHits) return true;
        }
      }
    }
    return false;
  }

  /* ─────────────────────────── input simulation ───────────────────────── */
  function dispatchKey(type, key, code, keyCode) {
    const opts = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true };
    const targets = [S.canvas, document.body, document].filter(Boolean);
    targets.forEach(t => t.dispatchEvent(new KeyboardEvent(type, opts)));
  }

  function pressJump() {
    const now = Date.now();
    if (now - S.lastJumpAt < CFG.jumpCooldownMs) return;
    S.lastJumpAt = now;
    S.jumpCount++;

    dispatchKey("keydown", " ", "Space", 32);
    dispatchKey("keydown", "ArrowUp", "ArrowUp", 38);
    setTimeout(() => {
      dispatchKey("keyup", " ", "Space", 32);
      dispatchKey("keyup", "ArrowUp", "ArrowUp", 38);
    }, 80);

    // Also tell the page-shim to call game.jump() directly if hooked
    document.dispatchEvent(new CustomEvent("__RB_JUMP__"));

    // Some games respond to pointer/touch
    if (S.canvas) {
      S.canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      setTimeout(() => S.canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })), 80);
    }

    setStatus(`Running — jumps: ${S.jumpCount}`);
  }

  function sendStart() {
    dispatchKey("keydown", " ", "Space", 32);
    dispatchKey("keydown", "Enter", "Enter", 13);
    setTimeout(() => {
      dispatchKey("keyup", " ", "Space", 32);
      dispatchKey("keyup", "Enter", "Enter", 13);
    }, 80);
    document.dispatchEvent(new CustomEvent("__RB_START__"));
    if (S.canvas) {
      const r = S.canvas.getBoundingClientRect();
      S.canvas.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }));
    }
  }

  /* ─────────────────────────── main bot loop ──────────────────────────── */
  let rhythmTimer = null;

  function tick() {
    if (!S.active) return;

    // Canvas not found yet → keep searching
    if (!S.canvas) {
      if (findCanvas()) { calibrateBg(); setInfo(); }
      return;
    }

    // Pixel-scan approach
    if (!S.tainted) {
      if (detectObstacle()) pressJump();

      // Game-over detection: if centre pixels stop changing
      const h = sampleHash();
      if (h !== S.prevHash) { S.prevHash = h; S.lastPixelChangeAt = Date.now(); }
      if (Date.now() - S.lastPixelChangeAt > CFG.gameOverQuietMs) {
        scheduleRestart();
      }
    } else if (CFG.rhythmFallback) {
      // Canvas is tainted; start rhythm jump timer
      if (!rhythmTimer) {
        rhythmTimer = setInterval(pressJump, CFG.rhythmJumpMs);
        setStatus("Rhythm mode (canvas tainted)");
      }
    }
  }

  function scheduleRestart() {
    if (S.restartTimeout) return; // already scheduled
    setStatus("Game over — restarting…");
    S.lastPixelChangeAt = Date.now(); // reset so we don't double-trigger
    S.restartTimeout = setTimeout(() => {
      S.restartTimeout = null;
      calibrateBg(); // re-sample background after possible menu change
      sendStart();
      setStatus(`Running — jumps: ${S.jumpCount}`);
    }, CFG.restartDelayMs);
  }

  /* ─────────────────────────── public controls ────────────────────────── */
  function startBot() {
    if (S.active) return;
    S.active = true;
    S.jumpCount = 0;
    S.lastPixelChangeAt = Date.now();
    if (!S.canvas) findCanvas();
    calibrateBg();
    sendStart();
    S.scanInterval = setInterval(tick, CFG.tickMs);
    // Periodic re-calibration (lighting / scroll could shift BG colour)
    setInterval(() => { if (S.active) calibrateBg(); }, 6000);
    renderPanel(true);
    setInfo();
    setStatus("Running…");
  }

  function stopBot() {
    S.active = false;
    clearInterval(S.scanInterval);
    clearInterval(rhythmTimer);
    rhythmTimer = null;
    if (S.restartTimeout) { clearTimeout(S.restartTimeout); S.restartTimeout = null; }
    renderPanel(false);
    setStatus("Idle");
  }

  /* ──────────────────────────────── UI ────────────────────────────────── */
  let panel, statusEl, infoEl, toggleBtn;

  function createPanel() {
    if (document.getElementById("__rb_panel__")) return;

    panel = document.createElement("div");
    panel.id = "__rb_panel__";
    panel.style.cssText = [
      "position:fixed", "top:12px", "right:12px", "z-index:2147483647",
      "background:rgba(8,10,18,.93)", "color:#dde", "padding:14px 16px",
      "border-radius:11px", "font:12px/1.5 monospace", "min-width:180px",
      "box-shadow:0 6px 28px rgba(0,0,0,.7)", "border:1px solid #2a3050",
      "backdrop-filter:blur(6px)", "user-select:none",
    ].join(";");

    panel.innerHTML = `
<div id="__rb_head__" style="font-size:14px;font-weight:700;color:#7af;
  margin-bottom:10px;cursor:move;letter-spacing:.4px">⚡ Runner Bot</div>
<div id="__rb_status__" style="color:#888;margin-bottom:5px">● Idle</div>
<div id="__rb_info__"   style="color:#444;font-size:10px;margin-bottom:10px">
  Searching for canvas…</div>
<button id="__rb_btn__" style="
  width:100%;padding:7px 0;cursor:pointer;border:none;border-radius:7px;
  background:linear-gradient(135deg,#1c8,#0a5);color:#fff;
  font:700 12px monospace;letter-spacing:.3px">▶  Start Bot</button>
<div style="margin-top:10px;color:#333;font-size:10px;line-height:1.7">
  Scan: ${CFG.tickMs}ms · Cooldown: ${CFG.jumpCooldownMs}ms<br>
  Auto-restart on game-over ✓
</div>`;

    document.body.appendChild(panel);
    statusEl  = document.getElementById("__rb_status__");
    infoEl    = document.getElementById("__rb_info__");
    toggleBtn = document.getElementById("__rb_btn__");

    toggleBtn.addEventListener("click", () => { S.active ? stopBot() : startBot(); });

    // Drag support
    const head = document.getElementById("__rb_head__");
    let ox = 0, oy = 0, mx = 0, my = 0;
    head.addEventListener("mousedown", e => {
      e.preventDefault();
      ox = panel.offsetLeft || (window.innerWidth - 12 - panel.offsetWidth);
      oy = panel.offsetTop;
      mx = e.clientX; my = e.clientY;
      const onMove = e2 => {
        panel.style.left   = (ox + e2.clientX - mx) + "px";
        panel.style.top    = (oy + e2.clientY - my) + "px";
        panel.style.right  = "auto";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function renderPanel(running) {
    if (!toggleBtn) return;
    if (running) {
      toggleBtn.textContent = "■  Stop Bot";
      toggleBtn.style.background = "linear-gradient(135deg,#c33,#911)";
    } else {
      toggleBtn.textContent = "▶  Start Bot";
      toggleBtn.style.background = "linear-gradient(135deg,#1c8,#0a5)";
    }
  }

  function setStatus(msg) {
    if (!statusEl) return;
    const color = msg.startsWith("Running") ? "#4e4" : msg.includes("over") ? "#fa4" : "#888";
    statusEl.innerHTML = `<span style="color:${color}">● ${msg}</span>`;
  }

  function setInfo() {
    if (!infoEl) return;
    if (S.canvas) {
      const cols = CFG.scanCols.map(f => Math.floor(S.canvas.width * f)).join(", ");
      infoEl.innerHTML =
        `Canvas: ${S.canvas.width}×${S.canvas.height}<br>` +
        `Scan X: [${cols}]<br>` +
        `Tainted: ${S.tainted ? "yes (rhythm mode)" : "no (pixel scan)"}`;
    } else {
      infoEl.textContent = "Canvas not found yet…";
    }
  }

  /* ────────────────────── page-shim hook event ─────────────────────────── */
  document.addEventListener("__RB_HOOKED__", () => {
    S.hooked = true;
    if (infoEl && S.canvas) setInfo();
  });

  /* ───────────────────────────── canvas watcher ────────────────────────── */
  // Observe DOM mutations so we detect canvas added after page load
  const observer = new MutationObserver(() => {
    if (!S.canvas) {
      if (findCanvas()) { calibrateBg(); setInfo(); }
    }
  });

  /* ─────────────────────────────── init ───────────────────────────────── */
  function init() {
    createPanel();
    if (findCanvas()) { calibrateBg(); setInfo(); }
    observer.observe(document.body || document.documentElement,
      { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
