// ================================================================
// NARUTO AR — app.js — REBUILT FROM SCRATCH
//
// KEY ARCHITECTURE RULE:
// Video plays in <video> tag. Canvas is transparent overlay.
// MediaPipe always reads from the <video> element.
// We NEVER draw video onto canvas. This is what was breaking it.
//
// Three jutsu:
//   Rasengan   — open palm (all 4 fingers up)
//   Shadow Clone — BOTH hands, both index fingers up
//                  Uses SelfieSegmentation to cut your body out
//                  and stamp body-only clones beside you
//   Fireball   — single index finger up + open mouth
//                Fire shoots from mouth position
// ================================================================

// ── DOM elements ───────────────────────────────────────────────
const videoEl  = document.getElementById('input-video');
const canvas   = document.getElementById('output-canvas');
const ctx      = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const fpsEl    = document.getElementById('fps-display');
const handLbl  = document.getElementById('hand-label');
const mouthLbl = document.getElementById('mouth-label');
const camEl    = document.getElementById('camera-container');

// Debug dots
const dbgPalm    = document.getElementById('dbg-palm');
const dbgIndex   = document.getElementById('dbg-index');
const dbgTwohand = document.getElementById('dbg-twohand');
const dbgMouth   = document.getElementById('dbg-mouth');
const dbgSeg     = document.getElementById('dbg-seg');

// ── Global state ───────────────────────────────────────────────
let frameCount    = 0;
let lastFrameTime = performance.now();
let prevSeal      = null;
let jutsuCount    = 0;
let sessionStart  = Date.now();

// Shared between models
let latestHands = null;  // updated by Hands model
let mouthOpen   = false; // updated by FaceMesh
let mouthX      = 0.5;   // normalized 0-1
let mouthY      = 0.7;
let segMask     = null;  // updated by SelfieSegmentation
let segReady    = false;

// ── Hand landmark connections ───────────────────────────────────
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17]
];

// ================================================================
// GESTURE DETECTION
// Same logic that worked in Phase 2.
// tip.y < knuckle.y = finger pointing up (smaller y = higher on screen)
// ================================================================

function isUp(lm, tip, mid) {
  return lm[tip].y < lm[mid].y;
}

// Rasengan: all 4 fingers extended = open palm
function isOpenPalm(lm) {
  return isUp(lm,8,6) && isUp(lm,12,10) && isUp(lm,16,14) && isUp(lm,20,18);
}

// Shadow Clone hand: index finger up
// Both hands must have this = the crossed index fingers gesture
function isIndexUp(lm) {
  return isUp(lm,8,6);
}

// Fireball hand: ONLY index up, others down
function isOnlyIndex(lm) {
  return isUp(lm,8,6) && !isUp(lm,12,10) && !isUp(lm,16,14) && !isUp(lm,20,18);
}

// ================================================================
// EFFECT: RASENGAN
// Spinning blue energy orb on palm center (landmark 9)
// ================================================================
let rasAngle = 0;

function drawRasengan(lm) {
  const cx = lm[9].x * canvas.width;
  const cy = lm[9].y * canvas.height;
  const r  = 65;
  rasAngle += 0.07;

  // Outer glow
  const glow = ctx.createRadialGradient(cx, cy, 4, cx, cy, r);
  glow.addColorStop(0,   'rgba(160,220,255,1)');
  glow.addColorStop(0.4, 'rgba(80,160,255,0.8)');
  glow.addColorStop(1,   'rgba(0,60,200,0)');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI*2);
  ctx.fillStyle = glow;
  ctx.fill();

  // 3 spinning rings clockwise
  for (let i = 0; i < 3; i++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rasAngle + i * Math.PI/3);
    ctx.beginPath();
    ctx.ellipse(0, 0, r*0.88, r*0.30, 0, 0, Math.PI*2);
    ctx.strokeStyle = `rgba(200,235,255,${0.8 - i*0.2})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }

  // 3 rings counter-clockwise (depth illusion)
  for (let i = 0; i < 3; i++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-rasAngle*0.7 + i * Math.PI/3);
    ctx.beginPath();
    ctx.ellipse(0, 0, r*0.55, r*0.20, 0, 0, Math.PI*2);
    ctx.strokeStyle = `rgba(255,255,255,${0.4 - i*0.1})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  // Bright white core
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, 16);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(1, 'rgba(120,200,255,0)');
  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, Math.PI*2);
  ctx.fillStyle = core;
  ctx.fill();

  // Electric sparks outward
  for (let i = 0; i < 6; i++) {
    const a = rasAngle*2 + i*Math.PI/3;
    const l = r*0.45 + Math.sin(rasAngle*5+i)*12;
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(a)*14, cy+Math.sin(a)*14);
    ctx.lineTo(cx+Math.cos(a)*l,  cy+Math.sin(a)*l);
    ctx.strokeStyle = 'rgba(200,240,255,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// ================================================================
// EFFECT: SHADOW CLONE
//
// Uses SelfieSegmentation to cut your body from background.
// Then stamps 4 scaled copies of your body-only at different
// positions with staggered delays, exactly like the anime.
// Smoke particles pop in at each clone position.
// You stay in center on top.
//
// Clone positions match the reference JS you shared.
// ================================================================

// grabPerson uses the segmentation mask to extract only your body
// Returns an offscreen canvas — transparent background, your body only
function grabPerson() {
  if (!segMask) return null;

  const off    = document.createElement('canvas');
  off.width    = canvas.width;
  off.height   = canvas.height;
  const offCtx = off.getContext('2d');

  // Step 1: draw the mask (white = you, black = background)
  offCtx.drawImage(segMask, 0, 0, canvas.width, canvas.height);

  // Step 2: source-in keeps ONLY the pixels where mask is white
  offCtx.globalCompositeOperation = 'source-in';

  // Step 3: draw the actual video — only your body area shows through
  offCtx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

  offCtx.globalCompositeOperation = 'source-over';
  return off;
}

// Clone config: x/y = offset from center, scale = size, delay = ms
const CLONE_CONFIG = [
  { x: -110, y:  80, scale: 0.88, delay: 350 },
  { x:  120, y:  80, scale: 0.84, delay: 500 },
  { x: -260, y: 120, scale: 0.70, delay: 680 },
  { x:  270, y: 130, scale: 0.66, delay: 860 },
];

let cloneActive    = false;
let cloneStartTime = 0;
let cloneTimer     = null;
let cloneBody      = null;  // the body-only snapshot
let clonesPopped   = [];    // tracks smoke spawned per clone

// Smoke particles
const smoke = [];

function spawnSmoke(cx, cy, sc) {
  for (let i = 0; i < 40; i++) {
    smoke.push({
      x: cx, y: cy,
      vx: (Math.random()-0.5)*16*sc,
      vy: (Math.random()-0.5)*16*sc,
      life: 1.0,
      decay: 0.02 + Math.random()*0.025,
      r: (12 + Math.random()*30)*sc,
    });
  }
}

function updateSmoke() {
  for (let i = smoke.length-1; i >= 0; i--) {
    const p = smoke[i];
    p.life -= p.decay;
    if (p.life <= 0) { smoke.splice(i,1); continue; }
    p.x += p.vx; p.y += p.vy; p.r += 1.0;
    ctx.save();
    ctx.globalAlpha = p.life * 0.4;
    ctx.fillStyle = '#ddd';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }
}

function triggerClone() {
  if (cloneActive) return;
  const body = grabPerson();
  if (!body) return; // wait for segmentation to be ready

  cloneBody      = body;
  cloneActive    = true;
  cloneStartTime = performance.now();
  clonesPopped   = CLONE_CONFIG.map(() => false);

  clearTimeout(cloneTimer);
  cloneTimer = setTimeout(() => {
    cloneActive = false;
    cloneBody   = null;
  }, 3500);
}

function drawCloneEffect() {
  if (!cloneBody) return;

  const elapsed = performance.now() - cloneStartTime;

  // Draw furthest (smallest) clones first so closer ones appear on top
  [...CLONE_CONFIG]
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => b.delay - a.delay)
    .forEach(cl => {
      if (elapsed < cl.delay) return;

      // Spawn smoke once when this clone first appears
      if (!clonesPopped[cl.i]) {
        clonesPopped[cl.i] = true;
        // Center of where this clone will appear
        const sx = canvas.width/2  + cl.x + (canvas.width*(1-cl.scale))/2;
        const sy = canvas.height/2 + cl.y;
        spawnSmoke(sx, sy, cl.scale);
        playPopSound();
      }

      // Draw body-only clone at offset position and scale
      ctx.save();
      ctx.translate(
        cl.x + canvas.width  * (1 - cl.scale) / 2,
        cl.y
      );
      ctx.scale(cl.scale, cl.scale);

      // Slightly transparent
      ctx.globalAlpha = 0.82;
      ctx.drawImage(cloneBody, 0, 0);

      // Blue-dark tint = shadow clone look
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = 'rgba(15,40,160,0.40)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';

      ctx.restore();
    });

  // Draw smoke on top of clones
  updateSmoke();

  // Draw real you on top — you stay in center
  const you = grabPerson();
  if (you) ctx.drawImage(you, 0, 0);
}

// ================================================================
// EFFECT: FIREBALL
// Fire particles spawn at mouth position.
// mouthX/Y updated by FaceMesh every frame.
// Only spawns when mouth is open.
// ================================================================
const fire = [];

function spawnFire() {
  // Convert normalized mouth coords to canvas pixels
  const mx = mouthX * canvas.width;
  const my = mouthY * canvas.height;

  for (let i = 0; i < 10; i++) {
    const spread = (Math.random()-0.5) * Math.PI * 0.75;
    const angle  = Math.PI/2 + spread; // downward fan
    const speed  = Math.random()*7 + 4;
    fire.push({
      x:     mx + (Math.random()-0.5)*18,
      y:     my,
      vx:    Math.cos(angle)*speed*(Math.random()>0.5?1:-1),
      vy:    Math.sin(angle)*speed,
      size:  Math.random()*20 + 10,
      life:  1.0,
      decay: Math.random()*0.022 + 0.012,
    });
  }
}

function drawFire() {
  for (let i = fire.length-1; i >= 0; i--) {
    const p = fire[i];
    p.x    += p.vx;
    p.y    += p.vy;
    p.vy   += 0.18; // slight gravity
    p.life -= p.decay;
    p.size *= 0.965;
    if (p.life <= 0) { fire.splice(i,1); continue; }

    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
    g.addColorStop(0,   `rgba(255,255,200,${p.life})`);
    g.addColorStop(0.3, `rgba(255,${Math.floor(p.life*200)},0,${p.life*0.85})`);
    g.addColorStop(1,   'rgba(180,20,0,0)');
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI*2);
    ctx.fillStyle = g;
    ctx.fill();
  }
}

// ================================================================
// MOUTH DETECTION via FaceMesh
// Landmark 13 = upper inner lip
// Landmark 14 = lower inner lip
// Distance > 0.035 = mouth is open
// ================================================================
function updateMouth(lm) {
  const upper = lm[13];
  const lower = lm[14];
  mouthOpen = Math.abs(upper.y - lower.y) > 0.035;
  // Store lower lip position as fire origin
  mouthX = lower.x;
  mouthY = lower.y + 0.015;
}

// ================================================================
// AUDIO: Web Audio API — no files needed
// ================================================================
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playRasenganSound() {
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.connect(g); g.connect(audioCtx.destination);
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(80, audioCtx.currentTime);
  o.frequency.exponentialRampToValueAtTime(420, audioCtx.currentTime+0.4);
  g.gain.setValueAtTime(0.28, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.5);
  o.start(); o.stop(audioCtx.currentTime+0.5);
}

function playCloneSound() {
  // Whoosh
  const buf  = audioCtx.createBuffer(1, audioCtx.sampleRate*0.3, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random()*2-1)*(1-i/data.length);
  const n = audioCtx.createBufferSource(); n.buffer = buf;
  const f = audioCtx.createBiquadFilter(); f.type='bandpass'; f.frequency.value=700;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.4, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.35);
  n.connect(f); f.connect(g); g.connect(audioCtx.destination);
  n.start(); n.stop(audioCtx.currentTime+0.35);
}

function playPopSound() {
  // Small pop for each clone appearing
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.connect(g); g.connect(audioCtx.destination);
  o.frequency.setValueAtTime(280, audioCtx.currentTime);
  o.frequency.exponentialRampToValueAtTime(90, audioCtx.currentTime+0.12);
  g.gain.setValueAtTime(0.3, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.12);
  o.start(); o.stop(audioCtx.currentTime+0.12);
}

function playFireSound() {
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.connect(g); g.connect(audioCtx.destination);
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(55, audioCtx.currentTime);
  o.frequency.exponentialRampToValueAtTime(180, audioCtx.currentTime+0.25);
  g.gain.setValueAtTime(0.3, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.45);
  o.start(); o.stop(audioCtx.currentTime+0.45);
  // Crackle
  const cb  = audioCtx.createBuffer(1, audioCtx.sampleRate*0.4, audioCtx.sampleRate);
  const cd  = cb.getChannelData(0);
  for (let i=0;i<cd.length;i++) cd[i] = Math.random()>0.97?(Math.random()*2-1):0;
  const cn  = audioCtx.createBufferSource(); cn.buffer=cb;
  const cg  = audioCtx.createGain();
  cg.gain.setValueAtTime(0.5, audioCtx.currentTime);
  cg.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.4);
  cn.connect(cg); cg.connect(audioCtx.destination);
  cn.start(); cn.stop(audioCtx.currentTime+0.4);
}

// ================================================================
// SCREEN SHAKE
// ================================================================
let shakeFrames = 0;
let shakeAmt    = 0;

function shake(amt, frames) { shakeAmt=amt; shakeFrames=frames; }

function applyShake() {
  if (shakeFrames > 0) {
    camEl.style.transform = `translate(${(Math.random()-0.5)*shakeAmt}px,${(Math.random()-0.5)*shakeAmt}px)`;
    shakeFrames--;
  } else {
    camEl.style.transform = '';
  }
}

// ================================================================
// JUTSU HISTORY LOG
// ================================================================
const JUTSU = {
  rasengan: { emoji:'⚡', name:'Rasengan',       color:'#38bdf8', card:'active-blue'   },
  clone:    { emoji:'🌀', name:'Shadow Clone',    color:'#a78bfa', card:'active-purple' },
  fireball: { emoji:'🔥', name:'Fireball Jutsu', color:'#f97316', card:'active-orange' },
};

function logJutsu(key) {
  const list  = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  if (empty) empty.remove();

  const time  = new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const j     = JUTSU[key];
  const el    = document.createElement('div');
  el.className = 'history-entry';
  el.innerHTML = `<span class="h-emoji">${j.emoji}</span><span class="h-name" style="color:${j.color}">${j.name}</span><span class="h-time">${time}</span>`;
  list.insertBefore(el, list.firstChild);
  if (list.querySelectorAll('.history-entry').length > 5) list.lastChild.remove();

  jutsuCount++;
  document.getElementById('jutsu-count').textContent = jutsuCount;
}

// ================================================================
// CARD HIGHLIGHT
// ================================================================
let currentCard = null;

function setCard(key) {
  if (currentCard) {
    const prev = document.getElementById(`card-${currentCard}`);
    if (prev) prev.classList.remove('active-orange','active-blue','active-purple');
  }
  if (key) {
    const el = document.getElementById(`card-${key}`);
    if (el) el.classList.add(JUTSU[key].card);
  }

  // Trigger sounds + shake + log only on NEW detection
  if (key && key !== prevSeal) {
    audioCtx.resume();
    if (key === 'rasengan') { playRasenganSound(); shake(5,  10); }
    if (key === 'clone')    { playCloneSound();    shake(14, 22); }
    if (key === 'fireball') { playFireSound();     shake(9,  14); }
    logJutsu(key);
  }

  currentCard = key;
  prevSeal    = key;
}

// ================================================================
// DRAW HELPERS
// ================================================================
function drawSkeleton(lm) {
  // Lines
  HAND_CONNECTIONS.forEach(([a,b]) => {
    ctx.beginPath();
    ctx.moveTo(lm[a].x*canvas.width, lm[a].y*canvas.height);
    ctx.lineTo(lm[b].x*canvas.width, lm[b].y*canvas.height);
    ctx.strokeStyle = 'rgba(56,189,248,0.5)';
    ctx.lineWidth   = 1.8;
    ctx.stroke();
  });
  // Dots
  lm.forEach((p,i) => {
    ctx.beginPath();
    ctx.arc(p.x*canvas.width, p.y*canvas.height, i===0?7:4, 0, Math.PI*2);
    ctx.fillStyle   = (i===0||i===9)?'#22c55e':i<=4?'#a78bfa':'#f97316';
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth   = 1;
    ctx.fill();
    ctx.stroke();
  });
}

function drawHUD(text, color) {
  ctx.font = 'bold 18px "Share Tech Mono",monospace';
  const tw  = ctx.measureText(text).width;
  const pad = 16;
  const cx  = canvas.width/2;

  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.beginPath();
  ctx.roundRect(cx-tw/2-pad, 12, tw+pad*2, 44, 10);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.stroke();

  ctx.fillStyle    = color;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, 34);
}

function updateFPS() {
  frameCount++;
  const now  = performance.now();
  const diff = now - lastFrameTime;
  if (diff >= 1000) {
    fpsEl.textContent = Math.round(frameCount/(diff/1000));
    frameCount    = 0;
    lastFrameTime = now;
  }
}

// Session timer
setInterval(() => {
  const s = Math.floor((Date.now()-sessionStart)/1000);
  document.getElementById('session-time').textContent =
    `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}, 1000);

// ================================================================
// RECORDING
// ================================================================
let recorder = null, recChunks = [], recording = false;

function toggleRecord() {
  recording ? stopRec() : startRec();
}

function startRec() {
  const stream = canvas.captureStream(30);
  navigator.mediaDevices.getUserMedia({audio:true}).catch(()=>{}).finally(()=>{
    recorder   = new MediaRecorder(stream, {mimeType:'video/webm'});
    recChunks  = [];
    recorder.ondataavailable = e => { if (e.data.size>0) recChunks.push(e.data); };
    recorder.onstop = () => {
      const url = URL.createObjectURL(new Blob(recChunks,{type:'video/webm'}));
      Object.assign(document.createElement('a'),{href:url,download:`jutsu-${Date.now()}.webm`}).click();
      URL.revokeObjectURL(url);
    };
    recorder.start(); recording=true;
    document.getElementById('record-btn').classList.add('recording');
    document.getElementById('rec-label').textContent='STOP';
    document.getElementById('rec-indicator').classList.add('visible');
  });
}

function stopRec() {
  if (!recorder||!recording) return;
  recorder.stop(); recording=false;
  document.getElementById('record-btn').classList.remove('recording');
  document.getElementById('rec-label').textContent='REC';
  document.getElementById('rec-indicator').classList.remove('visible');
}

// ================================================================
// MAIN RENDER — called by Hands model every frame
// ================================================================
function render() {
  if (!latestHands) return;

  // Sync canvas dimensions to video
  canvas.width  = videoEl.videoWidth  || 640;
  canvas.height = videoEl.videoHeight || 480;

  // Clear canvas — video shows through from behind via CSS/HTML
  // We ONLY draw effects on the canvas, never the video itself
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  updateFPS();
  applyShake();

  const hands = latestHands.multiHandLandmarks || [];
  const n     = hands.length;

  // Update debug dots
  handLbl.textContent  = n;
  mouthLbl.textContent = mouthOpen ? 'OPEN 🔥' : 'closed';
  dbgTwohand.className = 'dbg-dot' + (n>=2      ? ' twohand' : '');
  dbgMouth.className   = 'dbg-dot' + (mouthOpen ? ' mouth'   : '');
  dbgSeg.className     = 'dbg-dot' + (segReady  ? ' seg'     : '');

  // No hands — let effects die out
  if (n === 0) {
    statusEl.textContent = '👋 SHOW YOUR HAND TO THE CAMERA';
    statusEl.className   = '';
    setCard(null);
    dbgPalm.className  = 'dbg-dot';
    dbgIndex.className = 'dbg-dot';
    drawFire();
    updateSmoke();
    if (cloneActive) drawCloneEffect();
    return;
  }

  // ── Detect active seal ───────────────────────────────────────

  let active = null;

  // SHADOW CLONE: requires 2 hands, both with index finger up
  // This matches your Image 2 — both hands crossed, both index up
  if (n >= 2 && hands.every(lm => isIndexUp(lm))) {
    active = 'clone';
    triggerClone();
    dbgPalm.className  = 'dbg-dot';
    dbgIndex.className = 'dbg-dot on';
  }

  // Single-hand checks
  if (!active && n >= 1) {
    const lm   = hands[0];
    const palm = isOpenPalm(lm);
    const idx  = isOnlyIndex(lm);

    dbgPalm.className  = 'dbg-dot' + (palm ? ' on' : '');
    dbgIndex.className = 'dbg-dot' + (idx  ? ' on' : '');

    if (palm) {
      active = 'rasengan';
    } else if (idx && mouthOpen) {
      active = 'fireball';
    } else if (idx) {
      // Pose is right, waiting for mouth
      statusEl.textContent = '🔥 NOW OPEN YOUR MOUTH!';
      statusEl.className   = 'active';
    }
  }

  // ── Draw clone behind hand skeleton ─────────────────────────
  if (cloneActive) drawCloneEffect();

  // ── Draw hand skeletons ──────────────────────────────────────
  hands.forEach(lm => drawSkeleton(lm));

  // ── Draw active effect + HUD ─────────────────────────────────
  if (active === 'rasengan') {
    drawRasengan(hands[0]);
    drawHUD('RASENGAN ⚡', '#38bdf8');
    setCard('rasengan');
    statusEl.textContent = '⚡ RASENGAN!';
    statusEl.className   = 'jutsu';

  } else if (active === 'clone') {
    drawHUD('SHADOW CLONE JUTSU 🌀', '#a78bfa');
    setCard('clone');
    statusEl.textContent = '🌀 SHADOW CLONE JUTSU!';
    statusEl.className   = 'jutsu';

  } else if (active === 'fireball') {
    spawnFire();
    drawFire();
    drawHUD('FIRE STYLE: FIREBALL JUTSU 🔥', '#f97316');
    setCard('fireball');
    statusEl.textContent = '🔥 FIREBALL JUTSU!';
    statusEl.className   = 'jutsu';

  } else {
    // No active seal — let lingering effects finish
    drawFire();
    updateSmoke();
    if (statusEl.textContent !== '🔥 NOW OPEN YOUR MOUTH!') {
      setCard(null);
      statusEl.textContent = '✅ HAND TRACKED — MAKE A SEAL!';
      statusEl.className   = 'active';
    }
  }
}

// ================================================================
// MEDIAPIPE — 3 models running together
//
// Hands:              every frame  → drives render()
// FaceMesh:           every 2nd    → updates mouthOpen/mouthX/Y
// SelfieSegmentation: every 3rd    → updates segMask for clones
// ================================================================

// 1. Hands
const handsModel = new Hands({
  locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
});
handsModel.setOptions({
  maxNumHands:            2,
  modelComplexity:        1,
  minDetectionConfidence: 0.75,
  minTrackingConfidence:  0.65,
});
handsModel.onResults(r => { latestHands=r; render(); });

// 2. FaceMesh
const faceMesh = new FaceMesh({
  locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
});
faceMesh.setOptions({
  maxNumFaces:            1,
  refineLandmarks:        true,
  minDetectionConfidence: 0.6,
  minTrackingConfidence:  0.6,
});
faceMesh.onResults(r => {
  if (r.multiFaceLandmarks?.[0]) updateMouth(r.multiFaceLandmarks[0]);
  else mouthOpen = false;
});

// 3. SelfieSegmentation
const selfie = new SelfieSegmentation({
  locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${f}`
});
selfie.setOptions({ modelSelection: 1 });
selfie.onResults(r => {
  segMask  = r.segmentationMask;
  segReady = true;
});

// Camera feeds all 3 models
// Stagger face/selfie to reduce CPU load
let tick = 0;
const camera = new Camera(videoEl, {
  onFrame: async () => {
    await handsModel.send({ image: videoEl });
    if (tick % 2 === 0) await faceMesh.send({ image: videoEl });
    if (tick % 3 === 0) await selfie.send({ image: videoEl });
    tick++;
  },
  width:  640,
  height: 480,
});

camera.start()
  .then(() => {
    statusEl.textContent = '📷 CAMERA READY — MAKE A SEAL!';
    statusEl.className   = 'active';
  })
  .catch(err => {
    statusEl.textContent = '❌ CAMERA ERROR — ' + err.message;
  });

// Unlock audio on first user interaction (browser security requirement)
document.addEventListener('click',      () => audioCtx.resume(), { once: true });
document.addEventListener('touchstart', () => audioCtx.resume(), { once: true });