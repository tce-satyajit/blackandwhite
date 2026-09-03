// ---- Defaults ----
// Where the controls sit on load and after a reset. Change these and the
// sliders, the reset button and the opening readouts all follow.
const DEFAULT_CRANK = 95;   // crank radius, giving a stroke of 2r = 190
const DEFAULT_RPM = 20;

// ---- State ----
const state = {
    running: false,
    rpm: DEFAULT_RPM,
    angle: 0,          // crank angle, radians
    crank: DEFAULT_CRANK,   // crank radius; stroke is twice this
    sound: true,
    showLabels: true,
    showTrace: true,
    viewMode: 'light',
    activePart: null,
    hoverPart: null,
    time: 0
};

const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');
let badgeHits = [];

// ---- Fixed geometry ----
// The slot is tall enough to swallow the pin's full vertical travel at the
// largest crank radius, so the yoke never runs out of slot.
const geo = {
    O: { x: 0, y: 0 },      // crank centre, on the axis of symmetry
    rMax: 140,
    yokeW: 88,              // yoke body width
    slotW: 32,              // slot width, a shade over the pin
    slotHalfH: 152,         // half the slot's length
    yokeFrame: 34,          // material above and below the slot
    rodLen: 440,            // yoke centre to either slider centre
    guideX: 218,            // each guide sits on the band the rod always covers
    guideW: 54,
    guideHalfH: 44,
    sliderW: 96,
    sliderH: 56,
    rodH: 12,               // half-thickness of the connecting rods
    guideY: 36,             // guide rail offset from the axis
    baseY: 210
};
geo.yokeHalfH = geo.slotHalfH + geo.yokeFrame;

// ---- Kinematics ----
// The slot is vertical, so it transmits only the pin's horizontal position and
// absorbs the vertical component entirely. That is the whole mechanism.
function solve(theta, r) {
    const pin = {
        x: geo.O.x + r * Math.cos(theta),
        y: geo.O.y + r * Math.sin(theta)
    };
    const disp = r * Math.cos(theta);          // displacement from mid-stroke
    const yokeX = geo.O.x + disp;              // slot centreline follows the pin
    // Both sliders hang off the same yoke, so they travel together.
    return {
        pin, disp, yokeX,
        sliderR: yokeX + geo.rodLen,
        sliderL: yokeX - geo.rodLen
    };
}

// Normalised yoke speed: |d(disp)/d(theta)| / r = |sin(theta)|.
// Zero at the dead points, one at mid-stroke.
function speedFraction(theta) {
    return Math.abs(Math.sin(theta));
}

// ---- Canvas sizing ----
function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    drawSimulation();
}
window.addEventListener('resize', resizeCanvas);

// ---- Drive audio ----
// Continuous loop whose pitch tracks |sin(theta)| - the yoke's own speed - so it
// audibly eases at each dead point and picks up through mid-stroke.
const MOTOR_URL = 'vendor/audio/motor.mp3';
let audioCtx = null, motorBuffer = null, motorSrc = null, motorGain = null;

// Tuned to the clip itself (5.22 s, 48 kHz, peak 0.27, RMS 0.021):
//  - it opens with 66 ms of silence, which would punch a gap into the drone on
//    every loop, so playback both starts and wraps past that point;
//  - it is quiet, so the gain range makes up the level. Peak x MAX lands at
//    0.71, comfortably short of clipping.
const MOTOR_LOOP_START = 0.07;   // seconds, just past the lead-in silence
const MOTOR_GAIN_MIN = 1.2;      // at the dead points, where the yoke stalls
const MOTOR_GAIN_MAX = 2.6;      // at mid-stroke, where it runs fastest

function initAudio() {
    if (audioCtx) {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    fetch(MOTOR_URL)
        .then(r => r.arrayBuffer())
        .then(b => audioCtx.decodeAudioData(b))
        .then(buf => { motorBuffer = buf; })
        .catch(err => console.warn('audio unavailable:', err));
}

function startMotor() {
    if (motorSrc || !motorBuffer || !audioCtx || audioCtx.state !== 'running') return;
    motorSrc = audioCtx.createBufferSource();
    motorSrc.buffer = motorBuffer;
    motorSrc.loop = true;
    motorSrc.loopStart = MOTOR_LOOP_START;
    motorSrc.loopEnd = motorBuffer.duration;
    motorGain = audioCtx.createGain();
    motorGain.gain.value = 0;
    motorSrc.connect(motorGain).connect(audioCtx.destination);
    motorSrc.start(0, MOTOR_LOOP_START);   // skip the lead-in on the first pass too
}

function stopMotor() {
    if (!motorSrc) return;
    const src = motorSrc, gain = motorGain, t = audioCtx.currentTime;
    motorSrc = null; motorGain = null;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.15);
    setTimeout(() => { try { src.stop(); } catch (e) {} }, 300);
}

function updateMotor() {
    const shouldRun = state.sound && state.running && state.rpm > 0;
    if (shouldRun) startMotor(); else stopMotor();
    if (!motorSrc) return;
    const load = speedFraction(state.angle);
    const t = audioCtx.currentTime;
    const base = 0.55 + (state.rpm / 120) * 0.95;
    motorSrc.playbackRate.setTargetAtTime(base * (0.78 + 0.34 * load), t, 0.05);
    motorGain.gain.setTargetAtTime(MOTOR_GAIN_MIN + (MOTOR_GAIN_MAX - MOTOR_GAIN_MIN) * load, t, 0.05);
}

// ---- Drawing ----
function drawSimulation() {
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();

    const model = { minX: -680, maxX: 680, minY: -215, maxY: 268 };
    const pad = 24;
    const scale = Math.min((w - pad) / (model.maxX - model.minX),
                           (h - pad) / (model.maxY - model.minY));
    const centerX = w * 0.5 - ((model.minX + model.maxX) / 2) * scale;
    const centerY = h * 0.5 - ((model.minY + model.maxY) / 2) * scale;
    ctx.translate(centerX, centerY);
    ctx.scale(scale, scale);

    const isBlueprint = state.viewMode === 'blueprint';
    const highlightPart = state.activePart || state.hoverPart;
    const TAU = Math.PI * 2;

    const theme = isBlueprint ? {
        line: '#e2e8f0', lineSoft: '#64748b', fill: '#0f172a', fillAlt: '#1e293b',
        assemblyFill: '#1d3f66', crankFill: '#3a2f18', boreFill: '#475569',
        pin: '#d97706', graph: '#38bdf8', bg: '#0f172a'
    } : {
        line: '#1e293b', lineSoft: '#94a3b8', fill: '#ffffff', fillAlt: '#f1f5f9',
        assemblyFill: '#bcdcf5', crankFill: '#f9dcb4', boreFill: '#cbd5e1',
        pin: '#d97706', graph: '#0284c7', bg: '#ffffff'
    };

    if (isBlueprint) {
        ctx.save();
        ctx.fillStyle = theme.bg;
        ctx.fillRect(-centerX / scale, -centerY / scale, w / scale, h / scale);
        ctx.restore();
    }

    function partColor(p, fallback, hi = '#0284c7') {
        return (p != null && highlightPart === p) ? hi : fallback;
    }
    function partWidth(p, base) {
        return (p != null && highlightPart === p) ? base + 1.8 : base;
    }
    function rod(x1, y1, x2, y2, width, part, fill) {
        const a = Math.atan2(y2 - y1, x2 - x1), rr = width / 2;
        ctx.beginPath();
        ctx.arc(x1, y1, rr, a + Math.PI / 2, a - Math.PI / 2);
        ctx.arc(x2, y2, rr, a - Math.PI / 2, a + Math.PI / 2);
        ctx.closePath();
        ctx.fillStyle = fill || theme.fill;
        ctx.fill();
        ctx.strokeStyle = partColor(part, theme.line);
        ctx.lineWidth = partWidth(part, 2);
        ctx.stroke();
    }
    function boxPart(x, y, bw, bh, part, fill, r = 4) {
        ctx.fillStyle = fill || theme.fill;
        ctx.strokeStyle = partColor(part, theme.line);
        ctx.lineWidth = partWidth(part, 2.2);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, r); else ctx.rect(x, y, bw, bh);
        ctx.fill(); ctx.stroke();
    }

    function drawBadge(lbl) {
        const hot = highlightPart === parseInt(lbl.num);
        ctx.save();
        ctx.fillStyle = hot ? '#0284c7' : (isBlueprint ? '#1e293b' : '#ffffff');
        ctx.strokeStyle = hot ? '#0f172a' : '#0284c7';
        ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.arc(lbl.x, lbl.y, 13, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.fillStyle = hot ? '#ffffff' : '#0284c7';
        ctx.font = 'bold 14px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(lbl.num, lbl.x, lbl.y);
        ctx.restore();
    }

    const kin = solve(state.angle, state.crank);

    // --- 0. Support ---
    const baseY = geo.baseY;
    ctx.fillStyle = theme.fillAlt;
    ctx.strokeStyle = partColor(5, theme.line);
    ctx.lineWidth = partWidth(5, 2.2);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-660, baseY, 1320, 46, 10);
    else ctx.rect(-660, baseY, 1320, 46);
    ctx.fill(); ctx.stroke();

    // Bearing pedestal, kept low so the crank web covers most of it
    boxPart(geo.O.x - 46, geo.O.y + 96, 92, baseY - geo.O.y - 96, 5, theme.fillAlt, 6);

    // --- 1. Crank, behind the yoke so the pin reads as sitting in the slot ---
    const crankR = state.crank + 26;
    ctx.fillStyle = theme.crankFill;
    ctx.strokeStyle = partColor(1, theme.line);
    ctx.lineWidth = partWidth(1, 2.2);
    ctx.beginPath(); ctx.arc(geo.O.x, geo.O.y, crankR, 0, TAU); ctx.fill(); ctx.stroke();

    ctx.fillStyle = theme.fillAlt;
    ctx.strokeStyle = theme.lineSoft;
    ctx.lineWidth = 1.3;
    for (let s = 0; s < 6; s++) {
        const a0 = state.angle + s * TAU / 6 + 0.10;
        const a1 = state.angle + (s + 1) * TAU / 6 - 0.10;
        ctx.beginPath();
        ctx.arc(geo.O.x, geo.O.y, crankR - 13, a0, a1);
        ctx.arc(geo.O.x, geo.O.y, 26, a1, a0, true);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
    }
    rod(geo.O.x, geo.O.y, kin.pin.x, kin.pin.y, 20, 1, theme.crankFill);

    // Badge 1 belongs to the crank face, so it is drawn here rather than with the
    // rest: the yoke passes over that spot and must occlude it, otherwise the
    // badge appears to float above a part it sits behind.
    const badge1 = { num: '1', x: -crankR * 0.62, y: crankR * 0.62 };
    if (state.showLabels) drawBadge(badge1);

    // Centre bearing belongs to the crank, so it is drawn here: the yoke
    // assembly slides in front of it, not behind.
    ctx.fillStyle = theme.pin;
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(geo.O.x, geo.O.y, 9, 0, TAU); ctx.fill(); ctx.stroke();

    // --- 3. Yoke assembly: slot, rods and both sliders are one rigid casting,
    // so they are drawn as a single closed outline rather than separate pieces
    // butted together. Everything here shares one displacement, x = r cos(theta).
    const yx = kin.yokeX;
    const sH = geo.sliderH / 2, rH = geo.rodH, yH = geo.yokeHalfH;
    const L1 = kin.sliderL - geo.sliderW / 2, L2 = kin.sliderL + geo.sliderW / 2;
    const R1 = kin.sliderR - geo.sliderW / 2, R2 = kin.sliderR + geo.sliderW / 2;
    const Y1 = yx - geo.yokeW / 2, Y2 = yx + geo.yokeW / 2;

    ctx.fillStyle = theme.assemblyFill;
    ctx.strokeStyle = partColor(3, theme.line);
    ctx.lineWidth = partWidth(3, 2.4);
    // Profile of the whole casting, clockwise from the left slider's top-left:
    // slider, step down to rod, up the yoke, and symmetrically back along the
    // bottom. Every corner is filleted - nothing on a cast part is a sharp edge.
    const prof = [
        [L1, -sH], [L2, -sH], [L2, -rH], [Y1, -rH], [Y1, -yH],
        [Y2, -yH], [Y2, -rH], [R1, -rH], [R1, -sH], [R2, -sH],
        [R2,  sH], [R1,  sH], [R1,  rH], [Y2,  rH], [Y2,  yH],
        [Y1,  yH], [Y1,  rH], [L2,  rH], [L2,  sH], [L1,  sH]
    ];
    // The shortest edge is the slider-to-rod step (sH - rH), and arcTo needs the
    // radius to fit within half of it, so the fillet is clamped to that.
    const fillet = Math.min(9, (sH - rH) / 2 - 1);
    const midOf = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    ctx.beginPath();
    const nP = prof.length;
    const start = midOf(prof[nP - 1], prof[0]);
    ctx.moveTo(start[0], start[1]);
    for (let i = 0; i < nP; i++) {
        const cur = prof[i], nxt = prof[(i + 1) % nP];
        const m = midOf(cur, nxt);
        ctx.arcTo(cur[0], cur[1], m[0], m[1], fillet);
    }
    ctx.closePath();

    // The slot, as a rounded hole in the same path
    if (ctx.roundRect) {
        ctx.roundRect(yx - geo.slotW / 2, -geo.slotHalfH, geo.slotW, geo.slotHalfH * 2, geo.slotW / 2.6);
    } else {
        ctx.rect(yx - geo.slotW / 2, -geo.slotHalfH, geo.slotW, geo.slotHalfH * 2);
    }
    ctx.fill('evenodd');
    ctx.stroke();

    // --- 4. Guides: a fixed block each side, the rod running through its bore.
    // Drawn after the assembly so the rod passes behind each block, and sized so
    // the rod never withdraws from the bore across the full crank travel.
    [-geo.guideX, geo.guideX].forEach(gx => {
        const bore = geo.rodH + 5;

        // Block body
        ctx.fillStyle = theme.boreFill;
        ctx.strokeStyle = partColor(4, theme.line);
        ctx.lineWidth = partWidth(4, 2.2);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(gx - geo.guideW / 2, -geo.guideHalfH, geo.guideW, geo.guideHalfH * 2, 10);
        else ctx.rect(gx - geo.guideW / 2, -geo.guideHalfH, geo.guideW, geo.guideHalfH * 2);
        ctx.fill(); ctx.stroke();

        // Bore filled grey rather than left open, so it reads as the bearing
        // surface the rod runs against instead of a hole through the block.
        ctx.fillStyle = theme.boreFill;
        ctx.strokeStyle = partColor(4, theme.lineSoft);
        ctx.lineWidth = partWidth(4, 1.6);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(gx - geo.guideW / 2 - 2, -bore, geo.guideW + 4, bore * 2, 5);
        else ctx.rect(gx - geo.guideW / 2 - 2, -bore, geo.guideW + 4, bore * 2);
        ctx.fill(); ctx.stroke();

        // Foot tying the guide down to the base
        ctx.fillStyle = theme.fillAlt;
        ctx.strokeStyle = partColor(4, theme.lineSoft);
        ctx.lineWidth = partWidth(4, 1.8);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(gx - 16, geo.guideHalfH - 4, 32, baseY - geo.guideHalfH + 4, 4);
        else ctx.rect(gx - 16, geo.guideHalfH - 4, 32, baseY - geo.guideHalfH + 4);
        ctx.fill(); ctx.stroke();
    });

    // --- 5. Crank pin, on top: it rides in the slot ---
    ctx.fillStyle = partColor(2, theme.pin);
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = partWidth(2, 2);
    ctx.beginPath(); ctx.arc(kin.pin.x, kin.pin.y, 13, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(kin.pin.x, kin.pin.y, 5, 0, TAU); ctx.stroke();


    // --- 6. Displacement graph ---
    const gx0 = 270, gx1 = 655, gy = -140, gAmp = 52;
    if (state.showTrace) {
        ctx.save();
        ctx.strokeStyle = theme.lineSoft;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(gx0, gy); ctx.lineTo(gx1, gy);
        ctx.stroke();
        ctx.setLineDash([]);

        // x = r cos(theta), scaled so the largest crank fills the plot
        const amp = gAmp * (state.crank / geo.rMax);
        ctx.strokeStyle = theme.graph;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        for (let i = 0; i <= 120; i++) {
            const ph = (i / 120) * TAU;
            const px = gx0 + (i / 120) * (gx1 - gx0);
            const py = gy - amp * Math.cos(ph);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();

        // Where the mechanism is now
        const frac = ((state.angle % TAU) + TAU) % TAU / TAU;
        const dx = gx0 + frac * (gx1 - gx0);
        const dy = gy - amp * Math.cos(state.angle);
        ctx.strokeStyle = theme.lineSoft;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(dx, gy); ctx.lineTo(dx, dy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = theme.graph;
        ctx.beginPath(); ctx.arc(dx, dy, 6, 0, TAU); ctx.fill();

        ctx.fillStyle = theme.lineSoft;
        ctx.font = '13px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('x = r cos θ', gx0, gy - gAmp - 16);
        ctx.textAlign = 'center';
        ctx.fillText('0°', gx0, gy + gAmp + 26);
        ctx.fillText('180°', (gx0 + gx1) / 2, gy + gAmp + 26);
        ctx.fillText('360°', gx1, gy + gAmp + 26);
        ctx.restore();
    }

    // --- 7. Badges ---
    badgeHits = [];
    if (state.showLabels) {
        const onTop = [
            { num: '2', x: kin.pin.x + 26, y: kin.pin.y - 24 },
            { num: '3', x: yx, y: -geo.yokeHalfH - 24 },
            { num: '4', x: -geo.guideX, y: -geo.guideHalfH - 26 },
            { num: '5', x: -560, y: baseY + 23 }
        ];
        // Badge 1 was already painted behind the yoke, but it still needs a hit
        // target, so it goes into badgeHits alongside the rest.
        badgeHits = [badge1].concat(onTop).map(l => ({
            num: l.num, sx: centerX + l.x * scale, sy: centerY + l.y * scale, r: 13 * scale
        }));
        onTop.forEach(drawBadge);
    }

    ctx.restore();
}

// ---- Animation ----
let lastTime = performance.now();
function animate(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    state.time += dt;

    if (state.running && state.rpm > 0) {
        const omega = state.rpm * Math.PI * 2 / 60;
        state.angle = (state.angle + omega * dt) % (Math.PI * 2);
        if (state.angle < 0) state.angle += Math.PI * 2;
        document.getElementById('angle-slider').value = Math.round(state.angle * 180 / Math.PI);
        document.getElementById('val-angle').textContent = `${Math.round(state.angle * 180 / Math.PI)}°`;
        updateStats();
    }

    updateMotor();
    drawSimulation();
    positionPopover();
    requestAnimationFrame(animate);
}

// ---- Controls ----
const btnPlay = document.getElementById('btn-play');
const playIcon = document.getElementById('play-icon');
const playText = document.getElementById('play-text');

function setPlayButton(running) {
    playIcon.className = running ? 'fa-solid fa-pause' : 'fa-solid fa-play';
    playText.textContent = running ? 'Stop' : 'Start';
}

btnPlay.addEventListener('click', () => {
    initAudio();
    state.running = !state.running;
    setPlayButton(state.running);
});

function stepBy(deg) {
    state.running = false;
    setPlayButton(false);
    state.angle = (state.angle + deg * Math.PI / 180 + Math.PI * 2) % (Math.PI * 2);
    document.getElementById('angle-slider').value = Math.round(state.angle * 180 / Math.PI);
    document.getElementById('val-angle').textContent = `${Math.round(state.angle * 180 / Math.PI)}°`;
    updateStats();
}
document.getElementById('btn-step-next').addEventListener('click', () => stepBy(10));
document.getElementById('btn-step-prev').addEventListener('click', () => stepBy(-10));

document.getElementById('btn-reset').addEventListener('click', () => {
    state.angle = 0;
    state.crank = DEFAULT_CRANK;
    state.rpm = DEFAULT_RPM;
    document.getElementById('crank-slider').value = DEFAULT_CRANK;
    document.getElementById('speed-slider').value = DEFAULT_RPM;
    document.getElementById('angle-slider').value = 0;
    document.getElementById('val-angle').textContent = '0°';
    updateStats();
});

document.getElementById('crank-slider').addEventListener('input', (e) => {
    state.crank = parseInt(e.target.value);
    updateStats();
});
document.getElementById('speed-slider').addEventListener('input', (e) => {
    state.rpm = parseInt(e.target.value);
    updateStats();
});
document.getElementById('angle-slider').addEventListener('input', (e) => {
    const deg = parseInt(e.target.value);
    state.angle = deg * Math.PI / 180;
    document.getElementById('val-angle').textContent = `${deg}°`;
    updateStats();
});

function updateStats() {
    const kin = solve(state.angle, state.crank);
    document.getElementById('val-crank').textContent = state.crank;
    document.getElementById('val-speed').textContent = `${state.rpm} RPM`;

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('stat-rpm', state.rpm);
    set('stat-rpm-mobile', state.rpm);
    set('stat-stroke', (state.crank * 2).toFixed(0));
    set('stat-stroke-mobile', (state.crank * 2).toFixed(0));
    set('stat-disp', (kin.disp >= 0 ? '+' : '') + kin.disp.toFixed(0));
}

// ---- Chips ----
function paintChip(chip, checked, onClasses) {
    const offClasses = ['bg-slate-100', 'hover:bg-slate-200', 'text-slate-400', 'border-slate-200'];
    onClasses.forEach(c => chip.classList.toggle(c, checked));
    offClasses.forEach(c => chip.classList.toggle(c, !checked));
}
const ON_CLASSES = ['bg-white', 'hover:bg-slate-50', 'text-slate-900', 'border-slate-200'];

const chkLabels = document.getElementById('chk-labels');
const chipLabels = document.getElementById('chip-labels');
chkLabels.addEventListener('change', () => {
    state.showLabels = chkLabels.checked;
    if (!chkLabels.checked) closePopover();
    paintChip(chipLabels, chkLabels.checked, ON_CLASSES);
});

const chkTrace = document.getElementById('chk-trace');
const chipTrace = document.getElementById('chip-trace');
chkTrace.addEventListener('change', () => {
    state.showTrace = chkTrace.checked;
    paintChip(chipTrace, chkTrace.checked, ON_CLASSES);
});

const chkSound = document.getElementById('chk-sound');
const chipSound = document.getElementById('chip-sound');
chkSound.addEventListener('change', () => {
    state.sound = chkSound.checked;
    if (state.sound) initAudio(); else stopMotor();
    paintChip(chipSound, chkSound.checked, ON_CLASSES);
});

const chkViewMode = document.getElementById('chk-view-mode');
const chipViewMode = document.getElementById('chip-view-mode');
chkViewMode.addEventListener('change', () => {
    const dark = chkViewMode.checked;
    state.viewMode = dark ? 'blueprint' : 'light';
    document.getElementById('txt-view-mode').textContent = dark ? 'Light Mode' : 'Dark Mode';
    popover.classList.toggle('dark', dark);
    paintChip(chipViewMode, dark, ON_CLASSES);
});

// ---- Badge popover ----
const popover = document.getElementById('part-popover');
const popoverNum = document.getElementById('popover-num');
const popoverTitle = document.getElementById('popover-title');
const popoverDesc = document.getElementById('popover-desc');
const partInfo = {
    '1': { title: 'Crank', desc: 'Turns at a steady rate. Its radius sets the stroke, which is 2r.' },
    '2': { title: 'Crank Pin', desc: 'Rides in the slot, handing its horizontal position to the yoke.' },
    '3': { title: 'Yoke Assembly', desc: 'Slot, rods and both sliders are one rigid piece. The slot absorbs the pin\u2019s vertical travel, so the whole assembly moves as x = r cos θ.' },
    '4': { title: 'Guides', desc: 'A fixed block each side. The rods run through their bores, holding the assembly to one straight axis.' },
    '5': { title: 'Support', desc: 'Frame carrying the crank bearing and the guide rails.' }
};

let popoverPart = null;

function openPopover(num) {
    const info = partInfo[num];
    if (!info) return;
    popoverPart = num;
    popoverNum.textContent = num;
    popoverTitle.textContent = info.title;
    popoverDesc.textContent = info.desc;
    popover.classList.remove('hidden');
    state.activePart = parseInt(num);
    positionPopover();
}
function closePopover() {
    popoverPart = null;
    popover.classList.add('hidden');
    state.activePart = null;
}
function positionPopover() {
    if (!popoverPart) return;
    const hit = badgeHits.find(b => b.num === popoverPart);
    if (!hit) { closePopover(); return; }
    const box = canvas.getBoundingClientRect();
    const pw = popover.offsetWidth, ph = popover.offsetHeight;
    const gap = hit.r + 10;
    let left = hit.sx + gap;
    if (left + pw > box.width - 6) left = hit.sx - gap - pw;
    left = Math.max(6, Math.min(left, box.width - pw - 6));
    let top = hit.sy - ph / 2;
    top = Math.max(6, Math.min(top, box.height - ph - 6));
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
}
function badgeAt(clientX, clientY) {
    const box = canvas.getBoundingClientRect();
    const mx = clientX - box.left, my = clientY - box.top;
    return badgeHits.find(b => Math.hypot(mx - b.sx, my - b.sy) <= b.r + 4);
}

canvas.addEventListener('click', (e) => {
    initAudio();
    const hit = badgeAt(e.clientX, e.clientY);
    if (!hit) return closePopover();
    if (hit.num === popoverPart) return closePopover();
    openPopover(hit.num);
});
canvas.addEventListener('mousemove', (e) => {
    const hit = badgeAt(e.clientX, e.clientY);
    canvas.style.cursor = hit ? 'pointer' : '';
    state.hoverPart = hit ? parseInt(hit.num) : null;
});
canvas.addEventListener('mouseleave', () => { state.hoverPart = null; });
document.getElementById('popover-close').addEventListener('click', () => closePopover());

// ---- Explainer modal ----
const infoModal = document.getElementById('info-modal');
function openInfo() { infoModal.classList.remove('hidden'); }
function closeInfo() { infoModal.classList.add('hidden'); }
document.getElementById('btn-info').addEventListener('click', openInfo);
document.getElementById('info-close').addEventListener('click', closeInfo);
document.getElementById('info-backdrop').addEventListener('click', closeInfo);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !infoModal.classList.contains('hidden')) closeInfo();
});

// ---- Launch ----
function hideLoader() {
    const el = document.getElementById('loader');
    if (el) el.classList.add('gone');
}
setTimeout(hideLoader, 8000);        // never trap the page behind the veil

window.onload = function () {
    document.getElementById('crank-slider').value = DEFAULT_CRANK;
    document.getElementById('speed-slider').value = DEFAULT_RPM;
    updateStats();
    resizeCanvas();
    requestAnimationFrame(animate);
    // reveal on the next painted frame, with a timeout backstop in case
    // rAF is throttled or the tab is not visible
    requestAnimationFrame(hideLoader);
    setTimeout(hideLoader, 400);
};
