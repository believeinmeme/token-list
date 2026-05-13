// ==UserScript==
// @name         Iceman Runner Bot
// @namespace    https://github.com/believeinmeme/token-list
// @version      2.3.0
// @description  Heartbeat-jump strategy (never stops jumping), smart 30s submit/skip, fully hands-free.
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
 * v2.1 changes vs v2.0:
 *  - Much higher obstacle-detection thresholds → far fewer unnecessary jumps
 *  - window.confirm / alert / prompt overridden → native popups auto-approved
 *  - MutationObserver + periodic sweeper → custom HTML dialogs auto-clicked
 *  - Publish-score button auto-clicked on every game-over
 *  - Full game loop: playing → game-over → publish → restart (no touches needed)
 *  - Bot auto-starts 2.5 s after page load
 *  - 30-second cooldown guard: won't attempt publish twice within 30 s
 */
(function () {
  "use strict";

  /* ── idempotency ─────────────────────────────────────────────────────────── */
  if (window.__RB_ACTIVE__ !== undefined) { window.__RB_TOGGLE__(); return; }

  /* ══════════════════════════════════════════════════════════════════════════
     POPUP AUTO-APPROVE
     Runs immediately so it catches dialogs from the very first frame.
  ══════════════════════════════════════════════════════════════════════════ */

  // 1. Override native browser dialogs (confirm / alert / prompt).
  //    @grant none means we're already in page context, so this works directly.
  window.confirm = () => true;
  window.alert   = () => undefined;
  window.prompt  = (_, def) => (def !== undefined ? def : "");

  // 2. Patterns for custom HTML popups/modals.
  // "SUBMIT" alone is the exact button text on the end-run form.
  // "SKIP"   is the skip-without-submitting button on the same form.
  const RE_PUBLISH = /^\s*submit\s*$|publish|submit[\s\S]{0,20}score|send[\s\S]{0,20}score|leaderboard|high.?score/i;
  const RE_APPROVE = /\b(ok|yes|confirm|accept|continue|got.?it|done|send|save|upload|close)\b/i;
  const RE_RESTART = /^\s*skip\s*$|play.?again|try.?again|restart|new.?game|next.?run|retry/i;

  function elVisible(el) {
    if (!el || el.closest("#__rb__")) return false; // never click bot's own UI
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity) > 0.02;
  }

  function clickMatching(re) {
    const sel = 'button:not(#__rb__ *), [role="button"]:not(#__rb__ *),' +
                'input[type="button"], input[type="submit"], a[class*="btn"]:not(#__rb__ *)';
    const els = Array.from(document.querySelectorAll(sel));
    for (const el of els) {
      if (el.disabled || !elVisible(el)) continue;
      const txt = ((el.textContent || "") + (el.value || "") + (el.getAttribute("aria-label") || "")).trim();
      if (re.test(txt)) { el.click(); return true; }
    }
    return false;
  }

  // Tick every unchecked checkbox visible on screen (needed for the end-run consent box).
  function checkAllCheckboxes() {
    document.querySelectorAll('input[type="checkbox"]:not(#__rb__ *)').forEach(cb => {
      if (cb.closest("#__rb__") || !elVisible(cb) || cb.checked) return;
      cb.checked = true;
      ["change","input","click"].forEach(t => cb.dispatchEvent(new Event(t, { bubbles: true })));
    });
  }

  // Sweep in priority order: tick checkboxes → publish/submit → generic approve → skip/restart.
  // The small delay between checkbox-tick and button-click gives the form time to re-validate.
  function sweepPopups() {
    checkAllCheckboxes();
    setTimeout(() => {
      clickMatching(RE_PUBLISH) || clickMatching(RE_APPROVE) || clickMatching(RE_RESTART);
    }, 150);
  }

  // MutationObserver: instant response when new popup elements arrive in DOM
  new MutationObserver(() => sweepPopups())
    .observe(document.documentElement, { childList: true, subtree: true });

  // Periodic fallback every 350 ms — only outside active gameplay to avoid
  // accidentally clicking game-UI buttons while the player is running.
  setInterval(() => { if (!S.active || S.phase !== "playing") sweepPopups(); }, 350);


  /* ══════════════════════════════════════════════════════════════════════════
     STATE
  ══════════════════════════════════════════════════════════════════════════ */
  const S = {
    active: false, canvas: null, ctx: null,
    bg: null, tainted: false,
    rafId: null, calTimer: null, restartTid: null, rhythmTid: null, heartbeatTid: null,
    lastJumpAt: 0, lastDuckAt: 0,
    jumpCount: 0, startTime: 0,
    lastChangeAt: 0, prevHash: 0,
    frame: 0, gameObj: null,
    panel: null, statusEl: null, infoEl: null, btn: null,
    phase: "idle",  // "idle" | "playing" | "over" | "publishing" | "restarting"
    lastPublishedAt: 0,
  };

  const PUBLISH_COOLDOWN_MS = 31_000; // game allows one publish every 30 s

  /* ══════════════════════════════════════════════════════════════════════════
     CONFIG  –  v2.1: higher thresholds = fewer false-positive jumps
  ══════════════════════════════════════════════════════════════════════════ */
  const C = {
    // ── jump timing ──────────────────────────────────────────────────────
    jumpCooldown:  400,   // ms min between jumps — tighter so heartbeat fires reliably
    duckCooldown:  300,
    jumpAirMs:     650,   // estimated jump arc
    duckHoldMs:    240,
    heartbeatMs:   820,   // guaranteed jump every 820 ms if no recent jump
                          // → bot clears virtually all ground obstacles even when
                          //   pixel scan misses them (tainted canvas / bad thresholds)
    // ── game loop ─────────────────────────────────────────────────────────
    gameOverMs:   1800,   // ms of canvas silence → game-over
    publishWait:  1000,   // ms after game-over before clicking SUBMIT
    restartDelay: 3800,   // ms after game-over before restart (when submitting)
    skipRestartMs: 700,   // ms after game-over before restart (when skipping)
    calIntervalMs:8000,
    // ── pixel detection ───────────────────────────────────────────────────
    bgTol:          60,   // Manhattan-distance threshold
    obstacleHits:    4,   // ground zone: min pixels to call it an obstacle
    airExtraHits:    5,   // extra pixels needed to trigger duck
    hashEvery:       3,
    // ── scan geometry — 4 columns, starting closer to player ─────────────
    groundTop: 0.52, groundBot: 0.88,  // wider vertical range
    airTop:    0.26, airBot:    0.56,
    baseCols: [0.22, 0.30, 0.38, 0.47],  // 4 columns, shifted right as game speeds up
    colPushPer30s: 0.02, colPushMax: 0.10, colMax: 0.62,
    // ── rhythm fallback (tainted canvas / iOS) ────────────────────────────
    rhythmBase:    820,   // mirrors heartbeatMs — rhythm IS the heartbeat when tainted
    rhythmMinMs:   450,
    rhythmStep:     30,
    rhythmEvery:    20,
  };

  /* ══════════════════════════════════════════════════════════════════════════
     GAME-OBJECT HOOK  (direct window access – runs in page context)
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
  function callFn(path) { // path: 'jump' | 'duck' | 'start' | 'restart'
    const g = findGameObj(); if (!g) return false;
    const p = g.player || g.runner || g;
    const fns = {
      jump:    [p.jump, p.doJump, g.jump],
      duck:    [p.duck, p.crouch, g.duck],
      start:   [g.start, g.restart, g.reset],
      restart: [g.restart, g.reset, g.start],
    }[path] || [];
    for (const f of fns) if (typeof f==="function") { f.call(p); return true; }
    return false;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     CANVAS
  ══════════════════════════════════════════════════════════════════════════ */
  function findCanvas() {
    const all = Array.from(document.querySelectorAll("canvas"))
      .filter(c => c.width>30 && c.height>30)
      .sort((a,b) => b.width*b.height - a.width*a.height);
    for (const c of all) {
      try { const ctx=c.getContext("2d"); if(ctx){S.canvas=c;S.ctx=ctx;return true;} } catch(_){}
    }
    return false;
  }

  function calibrateBg() {
    if (!S.ctx||S.tainted) return;
    const {canvas:cv,ctx}=S;
    const w=Math.max(2,cv.width*0.06|0), h=Math.max(2,cv.height*0.06|0);
    let data;
    try { data=ctx.getImageData(2,2,w,h); } catch(_){S.tainted=true;return;}
    let r=0,g=0,b=0,n=data.data.length/4;
    for(let i=0;i<data.data.length;i+=4){r+=data.data[i];g+=data.data[i+1];b+=data.data[i+2];}
    S.bg={r:r/n,g:g/n,b:b/n};
  }

  function isObs(r,g,b) {
    if(!S.bg) return false;
    return Math.abs(r-S.bg.r)+Math.abs(g-S.bg.g)+Math.abs(b-S.bg.b) > C.bgTol;
  }

  function hashSample() {
    if(!S.ctx||S.tainted) return 0;
    const {canvas:cv,ctx}=S;
    let data;
    try{data=ctx.getImageData(cv.width*0.5|0,cv.height*0.5|0,10,4);}catch(_){S.tainted=true;return 0;}
    let h=0;
    for(let i=0;i<data.data.length;i+=8) h=(h*31+data.data[i])|0;
    return h;
  }

  function getScanCols() {
    const elapsed=S.active?(Date.now()-S.startTime)/1000:0;
    const push=Math.min(C.colPushMax,(elapsed/30|0)*C.colPushPer30s);
    return C.baseCols.map(col=>Math.min(C.colMax,col+push));
  }

  /* ══════════════════════════════════════════════════════════════════════════
     OBSTACLE DETECTION
  ══════════════════════════════════════════════════════════════════════════ */
  function detectObstacle() {
    if(!S.ctx||!S.canvas||S.tainted) return null;
    const {canvas:cv,ctx}=S;
    const W=cv.width,H=cv.height;
    const cols=getScanCols();
    const gY=H*C.groundTop|0, gH=Math.max(1,H*(C.groundBot-C.groundTop)|0);
    const aY=H*C.airTop|0,    aH=Math.max(1,H*(C.airBot-C.airTop)|0);
    let groundHits=0, airHits=0;
    for(const frac of cols){
      const sx=Math.min(W-1,W*frac|0);
      let gd,ad;
      try{gd=ctx.getImageData(sx,gY,1,gH);ad=ctx.getImageData(sx,aY,1,aH);}
      catch(_){S.tainted=true;return null;}
      for(let i=0;i<gd.data.length;i+=4) if(isObs(gd.data[i],gd.data[i+1],gd.data[i+2])) groundHits++;
      for(let i=0;i<ad.data.length;i+=4) if(isObs(ad.data[i],ad.data[i+1],ad.data[i+2])) airHits++;
    }
    if(groundHits>=C.obstacleHits)                  return "jump";
    if(airHits  >=C.obstacleHits+C.airExtraHits)    return "duck";
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     INPUT
  ══════════════════════════════════════════════════════════════════════════ */
  function key(type,k,code,kc){
    const e=new KeyboardEvent(type,{key:k,code,keyCode:kc,which:kc,bubbles:true,cancelable:true});
    [S.canvas,document.body,document].filter(Boolean).forEach(t=>t.dispatchEvent(e));
  }

  function tapCanvas(down){
    if(!S.canvas) return;
    const r=S.canvas.getBoundingClientRect();
    const cx=r.left+r.width*0.5, cy=r.top+r.height*0.72;
    if(typeof TouchEvent!=="undefined"){
      try{
        const t=new Touch({identifier:Date.now()&0xffff,target:S.canvas,clientX:cx,clientY:cy,screenX:cx,screenY:cy,pageX:cx+scrollX,pageY:cy+scrollY,radiusX:2,radiusY:2,rotationAngle:0,force:1});
        S.canvas.dispatchEvent(new TouchEvent(down?"touchstart":"touchend",{bubbles:true,cancelable:true,touches:down?[t]:[],targetTouches:down?[t]:[],changedTouches:[t]}));
      }catch(_){}
    }
    try{S.canvas.dispatchEvent(new PointerEvent(down?"pointerdown":"pointerup",{bubbles:true,cancelable:true,clientX:cx,clientY:cy,isPrimary:true}));}catch(_){}
    if(!down){try{S.canvas.dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:cx,clientY:cy}));}catch(_){}}
  }

  function swipeDown(){
    if(!S.canvas||typeof TouchEvent==="undefined") return;
    try{
      const r=S.canvas.getBoundingClientRect();
      const cx=r.left+r.width*0.5,y1=r.top+r.height*0.35,y2=r.top+r.height*0.65;
      const id=Date.now()&0xffff;
      const mk=y=>new Touch({identifier:id,target:S.canvas,clientX:cx,clientY:y,screenX:cx,screenY:y,pageX:cx+scrollX,pageY:y+scrollY,radiusX:2,radiusY:2,rotationAngle:0,force:1});
      const t1=mk(y1);
      S.canvas.dispatchEvent(new TouchEvent("touchstart",{bubbles:true,cancelable:true,touches:[t1],targetTouches:[t1],changedTouches:[t1]}));
      setTimeout(()=>{const t2=mk(y2);S.canvas.dispatchEvent(new TouchEvent("touchend",{bubbles:true,cancelable:true,touches:[],targetTouches:[],changedTouches:[t2]}));},60);
    }catch(_){}
  }

  function isInAir(){ return(Date.now()-S.lastJumpAt)<C.jumpAirMs; }

  function pressJump(){
    const now=Date.now();
    if(now-S.lastJumpAt<C.jumpCooldown) return;
    S.lastJumpAt=now; S.jumpCount++;
    callFn("jump");
    key("keydown"," ","Space",32); key("keydown","ArrowUp","ArrowUp",38);
    tapCanvas(true);
    setTimeout(()=>{key("keyup"," ","Space",32);key("keyup","ArrowUp","ArrowUp",38);tapCanvas(false);},90);
  }

  function pressDuck(){
    const now=Date.now();
    if(now-S.lastDuckAt<C.duckCooldown) return;
    S.lastDuckAt=now;
    callFn("duck");
    key("keydown","ArrowDown","ArrowDown",40);
    swipeDown();
    setTimeout(()=>key("keyup","ArrowDown","ArrowDown",40),C.duckHoldMs);
  }

  function sendStart(){
    callFn("start");
    key("keydown"," ","Space",32); key("keydown","Enter","Enter",13);
    tapCanvas(true);
    setTimeout(()=>{key("keyup"," ","Space",32);key("keyup","Enter","Enter",13);tapCanvas(false);},90);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     RHYTHM FALLBACK  (tainted canvas – very common on iOS)
     v2.1: much more conservative starting at 1400 ms
  ══════════════════════════════════════════════════════════════════════════ */
  function startRhythm(){
    if(S.rhythmTid) return;
    setStatus("Rhythm mode (conservative)");
    const sched=()=>{
      const elapsed=S.active?(Date.now()-S.startTime)/1000:0;
      const ms=Math.max(C.rhythmMinMs,C.rhythmBase-(elapsed/C.rhythmEvery|0)*C.rhythmStep);
      S.rhythmTid=setTimeout(()=>{if(!S.active)return;pressJump();sched();},ms);
    };
    sched();
  }
  function stopRhythm(){if(S.rhythmTid){clearTimeout(S.rhythmTid);S.rhythmTid=null;}}

  /* ══════════════════════════════════════════════════════════════════════════
     MAIN rAF LOOP
  ══════════════════════════════════════════════════════════════════════════ */
  function tick(){
    if(!S.active) return;
    S.frame++;

    if(!S.canvas){
      if(findCanvas()){calibrateBg();updateInfo();}
      S.rafId=requestAnimationFrame(tick);
      return;
    }

    // Only scan/jump while actually playing
    if(S.phase==="playing"){
      if(!S.tainted){
        const type=detectObstacle();
        if     (type==="jump"&&!isInAir()) pressJump();
        else if(type==="duck"&&!isInAir()) pressDuck();

        if(S.frame%C.hashEvery===0){
          const h=hashSample();
          if(h!==S.prevHash){S.prevHash=h;S.lastChangeAt=Date.now();}
          else if(Date.now()-S.lastChangeAt>C.gameOverMs) onGameOver();
        }
      } else {
        startRhythm();
        // Still detect game-over in rhythm mode via hash
        if(S.frame%C.hashEvery===0){
          const h=hashSample();
          if(h!==S.prevHash){S.prevHash=h;S.lastChangeAt=Date.now();}
          else if(Date.now()-S.lastChangeAt>C.gameOverMs) onGameOver();
        }
      }
    }

    if(S.frame%60===0) updateStatus();
    S.rafId=requestAnimationFrame(tick);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     GAME LOOP STATE MACHINE
     playing → over → publishing → restarting → playing
  ══════════════════════════════════════════════════════════════════════════ */
  function canSubmit() {
    return Date.now() - S.lastPublishedAt >= PUBLISH_COOLDOWN_MS;
  }

  function onGameOver(){
    if(S.phase!=="playing") return;
    S.phase="over";
    stopRhythm();

    if(canSubmit()){
      // ── SUBMIT path ───────────────────────────────────────────────────
      // Cooldown has passed → tick checkbox then click SUBMIT.
      setStatus("Game over – submitting score…");
      setTimeout(()=>{
        S.phase="publishing";
        sweepPopups();             // tick checkbox → then SUBMIT after 150 ms
        S.lastPublishedAt=Date.now();
        setStatus("Score submitted ✓ – restarting…");
      }, C.publishWait);
      // Give time for submission to process, then restart.
      S.restartTid=setTimeout(()=>{ S.restartTid=null; doRestart(); }, C.restartDelay);
    } else {
      // ── SKIP path ─────────────────────────────────────────────────────
      // Still within the 30 s cooldown → click SKIP immediately and
      // restart as fast as possible to get a better score before next submit.
      setStatus("Game over – skipping (cooldown) – restarting fast…");
      clickMatching(RE_RESTART);   // click SKIP
      S.restartTid=setTimeout(()=>{ S.restartTid=null; doRestart(); }, C.skipRestartMs);
    }
  }

  function doRestart(){
    S.phase="restarting";
    setStatus("Restarting…");
    stopRhythm();
    calibrateBg();
    // Dismiss any remaining popups first, then send start
    sweepPopups();
    setTimeout(()=>{
      sendStart();
      S.jumpCount=0;
      S.startTime=Date.now();
      S.lastChangeAt=Date.now();
      S.prevHash=0;
      S.frame=0;
      S.phase="playing";
      setStatus("Running…");
    }, 600);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     BOT CONTROLS
  ══════════════════════════════════════════════════════════════════════════ */
  function startBot(){
    if(S.active) return;
    S.active=true;
    S.startTime=Date.now(); S.jumpCount=0;
    S.lastChangeAt=Date.now(); S.frame=0;
    S.phase="playing";
    if(!S.canvas) findCanvas();
    calibrateBg();
    sendStart();
    S.rafId=requestAnimationFrame(tick);
    S.calTimer=setInterval(()=>{if(S.active&&!S.tainted)calibrateBg();},C.calIntervalMs);

    // ── heartbeat jump ────────────────────────────────────────────────────
    // Fires every heartbeatMs. If no jump has happened recently (pixel scan
    // missed the obstacle, canvas tainted, etc.) it forces a jump.
    // This is the "jump over everything" safety net — the bot will never
    // stop jumping for more than ~820 ms regardless of detection quality.
    S.heartbeatTid=setInterval(()=>{
      if(S.active && S.phase==="playing" && Date.now()-S.lastJumpAt > C.heartbeatMs-20){
        pressJump();
      }
    }, C.heartbeatMs);

    renderBtn(true); updateInfo(); setStatus("Running…");
  }

  function stopBot(){
    S.active=false;
    S.phase="idle";
    if(S.rafId){cancelAnimationFrame(S.rafId);S.rafId=null;}
    clearInterval(S.calTimer);
    clearInterval(S.heartbeatTid); S.heartbeatTid=null;
    stopRhythm();
    if(S.restartTid){clearTimeout(S.restartTid);S.restartTid=null;}
    renderBtn(false); setStatus("Idle");
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PANEL UI  (iOS-optimised bottom strip + desktop card)
  ══════════════════════════════════════════════════════════════════════════ */
  function createPanel(){
    if(document.getElementById("__rb__")) return;
    const p=document.createElement("div");
    p.id="__rb__";
    const mob=/iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if(mob){
      p.style.cssText=["position:fixed","bottom:16px","left:50%","transform:translateX(-50%)",
        "z-index:2147483647","background:rgba(8,10,20,.96)","color:#dde",
        "padding:10px 16px","border-radius:16px","font:12px/1.4 monospace",
        "box-shadow:0 4px 24px rgba(0,0,0,.8)","border:1px solid #2a3060",
        "display:flex","align-items:center","gap:12px","touch-action:none","max-width:92vw"].join(";");
      p.innerHTML=`
<div style="display:flex;flex-direction:column;gap:2px">
  <div id="__rbs__" style="color:#888;font-size:11px;white-space:nowrap">● Idle</div>
  <div id="__rbi__" style="color:#445;font-size:10px;white-space:nowrap">–</div>
</div>
<button id="__rbb__" style="padding:11px 22px;cursor:pointer;border:none;border-radius:10px;background:linear-gradient(135deg,#1c8,#0a5);color:#fff;font:700 13px monospace;touch-action:manipulation;min-width:90px;flex-shrink:0">▶ Start</button>`;
    } else {
      p.style.cssText=["position:fixed","top:12px","right:12px","z-index:2147483647",
        "background:rgba(8,10,18,.93)","color:#dde","padding:14px 16px","border-radius:11px",
        "font:12px/1.5 monospace","min-width:200px","box-shadow:0 6px 28px rgba(0,0,0,.7)",
        "border:1px solid #2a3050","backdrop-filter:blur(6px)","user-select:none"].join(";");
      p.innerHTML=`
<div id="__rbh__" style="font-size:14px;font-weight:700;color:#7af;margin-bottom:10px;cursor:move;letter-spacing:.4px">⚡ Runner Bot v2.1</div>
<div id="__rbs__" style="color:#888;margin-bottom:5px">● Idle</div>
<div id="__rbi__" style="color:#444;font-size:10px;margin-bottom:10px">Searching for canvas…</div>
<button id="__rbb__" style="width:100%;padding:8px 0;cursor:pointer;border:none;border-radius:7px;background:linear-gradient(135deg,#1c8,#0a5);color:#fff;font:700 12px monospace">▶  Start Bot</button>
<div style="margin-top:10px;color:#333;font-size:10px;line-height:1.8">
  heartbeat jump · 30s submit/skip · hands-free ✓
</div>`;
    }

    document.body.appendChild(p);
    S.panel=p;
    S.statusEl=p.querySelector("#__rbs__");
    S.infoEl  =p.querySelector("#__rbi__");
    S.btn     =p.querySelector("#__rbb__");

    const doToggle=e=>{if(e.cancelable)e.preventDefault();S.active?stopBot():startBot();};
    S.btn.addEventListener("click",   doToggle);
    S.btn.addEventListener("touchend",doToggle,{passive:false});

    // Touch drag
    let sx=0,sy=0,sl=0,st=0,drag=false;
    p.addEventListener("touchstart",e=>{if(e.target===S.btn)return;drag=true;const t=e.touches[0];sx=t.clientX;sy=t.clientY;const r=p.getBoundingClientRect();sl=r.left;st=r.top;},{passive:true});
    p.addEventListener("touchmove", e=>{if(!drag||e.target===S.btn)return;e.preventDefault();const t=e.touches[0];p.style.left=(sl+t.clientX-sx)+"px";p.style.top=(st+t.clientY-sy)+"px";p.style.bottom="auto";p.style.right="auto";p.style.transform="none";},{passive:false});
    p.addEventListener("touchend",  ()=>{drag=false;},{passive:true});

    // Mouse drag (desktop)
    const head=p.querySelector("#__rbh__");
    if(head){
      let ox=0,oy=0,mx=0,my=0;
      head.addEventListener("mousedown",e=>{e.preventDefault();ox=p.offsetLeft||(innerWidth-12-p.offsetWidth);oy=p.offsetTop;mx=e.clientX;my=e.clientY;
        const onM=e2=>{p.style.left=(ox+e2.clientX-mx)+"px";p.style.top=(oy+e2.clientY-my)+"px";p.style.right="auto";};
        const onU=()=>{removeEventListener("mousemove",onM);removeEventListener("mouseup",onU);};
        addEventListener("mousemove",onM);addEventListener("mouseup",onU);});
    }
  }

  function renderBtn(running){
    if(!S.btn) return;
    const mob=/iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    S.btn.textContent=running?(mob?"■ Stop":"■  Stop Bot"):(mob?"▶ Start":"▶  Start Bot");
    S.btn.style.background=running?"linear-gradient(135deg,#c33,#911)":"linear-gradient(135deg,#1c8,#0a5)";
  }

  function setStatus(msg){
    if(!S.statusEl) return;
    const col=msg.includes("Run")?"#4e4":
              (msg.includes("over")||msg.includes("Publish")||msg.includes("Restart"))?"#fa4":"#888";
    S.statusEl.innerHTML=`<span style="color:${col}">● ${msg}</span>`;
  }

  function updateStatus(){
    if(!S.active||S.phase!=="playing") return;
    const sec=(Date.now()-S.startTime)/1000|0;
    setStatus(`Running ${String(sec/60|0).padStart(2,"0")}:${String(sec%60).padStart(2,"0")} · ${S.jumpCount}j`);
  }

  function updateInfo(){
    if(!S.infoEl||!S.canvas) return;
    S.infoEl.textContent=S.tainted?"rhythm mode (conservative)":`${S.canvas.width}×${S.canvas.height} · pixel+duck`;
  }

  /* ── end-screen DOM detector ────────────────────────────────────────────────
     The "END RUN & SUBMIT" overlay shows SUBMIT + SKIP buttons simultaneously.
     Canvas-hash detection misses this because the game-over animation keeps
     running behind the overlay. We detect the form directly instead.
  ──────────────────────────────────────────────────────────────────────────── */
  function detectEndScreen() {
    if (S.phase !== "playing") return; // already handling
    const btns = Array.from(document.querySelectorAll(
      'button:not(#__rb__ *), [role="button"]:not(#__rb__ *)'
    )).filter(elVisible);
    const texts = btns.map(b => b.textContent.trim().toLowerCase());
    // The end-run form always has both SUBMIT and SKIP visible at the same time
    if (texts.includes("submit") && texts.includes("skip")) {
      onGameOver();
    }
  }

  // Run every 300 ms — fast enough to catch the popup immediately after game-over
  setInterval(detectEndScreen, 300);

  /* ── mutation observer for late-loaded canvas ───────────────────────────── */
  new MutationObserver(()=>{if(!S.canvas&&findCanvas()){calibrateBg();updateInfo();}})
    .observe(document.documentElement,{childList:true,subtree:true});

  /* ── global toggle for bookmarklet re-tap ───────────────────────────────── */
  window.__RB_ACTIVE__=false;
  window.__RB_TOGGLE__=()=>{window.__RB_ACTIVE__=!window.__RB_ACTIVE__;window.__RB_ACTIVE__?startBot():stopBot();};

  /* ══════════════════════════════════════════════════════════════════════════
     INIT — auto-start 2.5 s after page load (fully hands-free)
  ══════════════════════════════════════════════════════════════════════════ */
  function init(){
    createPanel();
    if(findCanvas()){calibrateBg();updateInfo();}
    setTimeout(findGameObj,800);
    // Auto-start: no need to tap anything
    setTimeout(()=>{ if(!S.active) startBot(); }, 2500);
  }

  document.readyState==="loading"?document.addEventListener("DOMContentLoaded",init):init();
})();
