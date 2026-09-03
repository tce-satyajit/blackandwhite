// ---- State ----
const state = {
    running: false,
    rpm: 40,
    angle: 0,          // crank angle, radians
    crank: 55,         // crank length; the link that decides Grashof
    sound: true,
    showLabels: true,
    showTrace: true,
    viewMode: 'light', // 'light' or 'blueprint'
    activePart: null,
    hoverPart: null,
    time: 0
};

const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');

// Screen-space position of each number badge, refreshed every frame.
let badgeHits = [];

// ---- Fixed geometry of the four-bar ----
// Ground link runs from the rocker pivot O4 to the crank pivot O2. The rocker
// carries a gear sector of pitch radius Rg which rolls a rack along its tangent,
// so the rocker's swing becomes a straight-line stroke.
const geo = {
    O4: { x: -150, y: 10 },    // rocker pivot (left)
    O2: { x: 200, y: 40 },     // crank pivot (right)
    coupler: 310,              // connecting rod
    rocker: 125,               // rocker arm, pivot to coupler pin
    pitchR: 185,               // gear sector pitch radius
    teeth: 36,
    rackLen: 700,
    rackThick: 30,
    TH4_REF: -0.94             // rocker angle that centres the rack
};
geo.ground = Math.hypot(geo.O2.x - geo.O4.x, geo.O2.y - geo.O4.y);
geo.toothPitch = (Math.PI * 2 * geo.pitchR) / geo.teeth;

// Offset of the rack's tooth pattern from the rack centre. Chosen so a rack
// tooth space always sits over the gear tooth arriving at the contact point,
// which keeps the two in mesh at every rocker angle.
const MESH_PHASE = geo.pitchR * (Math.PI / 2 + geo.TH4_REF) - geo.toothPitch * 0.5;

// Toothed sector spans SECTOR_FRACTION of the rim, fixed in the rocker's own
// frame, centred on the body angle that meets the rack at the nominal position.
const SECTOR_FRACTION = 0.5;
const SECTOR_CENTRE = -Math.PI / 2 - geo.TH4_REF;
const SECTOR_HALF = Math.PI * 2 * SECTOR_FRACTION / 2;
const SECTOR_KLO = Math.ceil((SECTOR_CENTRE - SECTOR_HALF) / (Math.PI * 2 / geo.teeth));
const SECTOR_KHI = Math.floor((SECTOR_CENTRE + SECTOR_HALF) / (Math.PI * 2 / geo.teeth));

// The rocker badge is fixed to the rocker casting rather than to the canvas, so
// it swings with the part. Anchor chosen to reproduce its old resting spot at the
// nominal rocker angle, on the plain rim well clear of the toothed sector.
const BADGE3_R = Math.hypot(70, 78);
const BADGE3_PSI = Math.atan2(78, 70) - geo.TH4_REF;

// ---- Kinematics ----
// Standard four-bar closure: the coupler pin B is where a circle of radius
// `coupler` about the crank pin meets a circle of radius `rocker` about O4.
// No intersection means the linkage cannot reach that crank angle: it jams.
function solveLinkage(theta, crank) {
    const A = {
        x: geo.O2.x + crank * Math.cos(theta),
        y: geo.O2.y + crank * Math.sin(theta)
    };
    const dx = geo.O4.x - A.x, dy = geo.O4.y - A.y;
    const D = Math.hypot(dx, dy);
    if (D === 0 || D > geo.coupler + geo.rocker || D < Math.abs(geo.coupler - geo.rocker)) {
        return null;
    }
    const m = (geo.coupler * geo.coupler - geo.rocker * geo.rocker + D * D) / (2 * D);
    const hsq = geo.coupler * geo.coupler - m * m;
    if (hsq < 0) return null;
    const h = Math.sqrt(hsq);
    const px = A.x + m * dx / D, py = A.y + m * dy / D;
    // One branch consistently, so the linkage never flips assembly mid-run.
    const B = { x: px - h * dy / D, y: py + h * dx / D };
    const th4 = Math.atan2(B.y - geo.O4.y, B.x - geo.O4.x);
    return { A, B, th4, rack: geo.pitchR * (th4 - geo.TH4_REF) };
}

// ---- Grashof classification ----
// s + l <= p + q means at least one link fully rotates. Which link is shortest
// then decides the type; with the shortest adjacent to ground it is a crank-rocker.
function classify(crank) {
    const links = [
        { n: 'crank', v: crank },
        { n: 'coupler', v: geo.coupler },
        { n: 'rocker', v: geo.rocker },
        { n: 'ground', v: geo.ground }
    ].slice().sort((a, b) => a.v - b.v);
    const grashof = links[0].v + links[3].v <= links[1].v + links[2].v;
    let type;
    if (!grashof) type = 'Non-Grashof';
    else if (links[0].n === 'crank') type = 'Crank-Rocker';
    else if (links[0].n === 'ground') type = 'Double-Crank';
    else type = 'Double-Rocker';
    return { grashof, type, shortest: links[0].n };
}

// How fast the rocker turns for a given crank turn. Zero at each end of the
// swing, greatest mid-stroke, which is what makes the drive audibly ease off
// and pick up again.
function rockerRate(theta, crank) {
    const e = 0.012;
    const a = solveLinkage(theta - e, crank);
    const b = solveLinkage(theta + e, crank);
    if (!a || !b) return 0;
    let d = b.th4 - a.th4;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) / (2 * e);
}

// Sweep once per crank length: full rotation possible, and the swing limits
// used for the stat readout and the motion-path overlay.
const linkCache = new Map();
function analyse(crank) {
    const key = Math.round(crank);
    if (linkCache.has(key)) return linkCache.get(key);
    let ok = 0, lo = Infinity, hi = -Infinity, peakRate = 0;
    for (let i = 0; i < 360; i++) {
        const s = solveLinkage(i * Math.PI / 180, crank);
        if (s) { ok++; lo = Math.min(lo, s.th4); hi = Math.max(hi, s.th4); }
        const r = rockerRate(i * Math.PI / 180, crank);
        if (r > peakRate) peakRate = r;
    }
    const c = classify(crank);
    const res = {
        rotates: ok === 360,
        minTh4: lo, maxTh4: hi,
        swing: ok ? (hi - lo) : 0,
        stroke: ok ? geo.pitchR * (hi - lo) : 0,
        peakRate: peakRate || 1,
        type: c.type, grashof: c.grashof
    };
    linkCache.set(key, res);
    return res;
}

// Largest crank that still satisfies s + l <= p + q, for the slider caption.
const GRASHOF_LIMIT = geo.coupler + geo.rocker - geo.ground;

// ---- Canvas sizing ----
function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    // Rounded joins so rods read as forged ends. Set here because assigning
    // canvas.width resets the whole context state.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    drawSimulation();
}
window.addEventListener('resize', resizeCanvas);

// ---- Servo drive audio ----
// A motor is a continuous sound, so the clip loops for as long as the mechanism
// turns. Its pitch follows the rocker's instantaneous angular rate rather than
// just the crank RPM, so it eases off at each end of the swing and picks up
// through mid-stroke, the way a real servo loads and unloads.
const MOTOR_URL = 'vendor/audio/grashof.mp3';
let audioCtx = null, motorBuffer = null;
let motorSrc = null, motorGain = null;

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
    motorGain = audioCtx.createGain();
    motorGain.gain.value = 0;               // ramped up in updateMotor, no click
    motorSrc.connect(motorGain).connect(audioCtx.destination);
    motorSrc.start();
}

function stopMotor() {
    if (!motorSrc) return;
    const src = motorSrc, gain = motorGain, t = audioCtx.currentTime;
    motorSrc = null; motorGain = null;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.15);   // fade rather than cut
    setTimeout(() => { try { src.stop(); } catch (e) {} }, 300);
}

function updateMotor() {
    const shouldRun = state.sound && state.running && state.rpm > 0;
    if (shouldRun) startMotor(); else stopMotor();
    if (!motorSrc) return;

    const info = analyse(state.crank);
    // 0 at the swing extremes, 1 at peak rocker speed
    const load = Math.min(1, rockerRate(state.angle, state.crank) / info.peakRate);
    const t = audioCtx.currentTime;

    // Crank speed sets the base pitch; the swing modulates it either side.
    const base = 0.55 + (state.rpm / 120) * 0.95;
    motorSrc.playbackRate.setTargetAtTime(base * (0.78 + 0.34 * load), t, 0.05);
    motorGain.gain.setTargetAtTime(0.18 + 0.30 * load, t, 0.05);
}

// ---- Drawing ----
function drawSimulation() {
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();

    // Model bounding box: gear + teeth on the left, crank wheel on the right,
    // rack across the top, support slab underneath.
    // Box measured from every element across the whole crank-length and angle
    // range, so nothing is ever clipped at the edges.
    const model = { minX: -740, maxX: 436, minY: -275, maxY: 293 };
    const pad = 24;
    const modelW = model.maxX - model.minX;
    const modelH = model.maxY - model.minY;
    const scale = Math.min((w - pad) / modelW, (h - pad) / modelH);
    const centerX = w * 0.5 - ((model.minX + model.maxX) / 2) * scale;
    const centerY = h * 0.5 - ((model.minY + model.maxY) / 2) * scale;
    ctx.translate(centerX, centerY);
    ctx.scale(scale, scale);

    const isBlueprint = state.viewMode === 'blueprint';
    const highlightPart = state.activePart || state.hoverPart;
    const TAU = Math.PI * 2;

    // Palette lifted from the reference render: green rack, cream gear and crank,
    // blue connecting rod, oxide-red support.
    // Same line-art palette as the valve gear page: parts are outlines filled
    // with the page colour, so overlapping links stay legible.
    const theme = isBlueprint ? {
        line: '#e2e8f0',
        lineSoft: '#64748b',
        fill: '#0f172a',
        fillAlt: '#1e293b',
        rodFill: '#1d3f66',      // connecting rod
        gearFill: '#2b3138',     // rocker
        rackFill: '#4a3520',     // rack
        pin: '#d97706',
        label: '#94a3b8',
        bg: '#0f172a'
    } : {
        line: '#1e293b',
        lineSoft: '#94a3b8',
        fill: '#ffffff',
        fillAlt: '#f1f5f9',
        rodFill: '#bcdcf5',      // connecting rod, light blue
        gearFill: '#e3e6ea',     // rocker, light grey
        rackFill: '#f9dcb4',     // rack, light orange
        pin: '#d97706',
        label: '#64748b',
        bg: '#ffffff'
    };

    if (isBlueprint) {
        ctx.save();
        ctx.fillStyle = theme.bg;
        ctx.fillRect(-centerX / scale, -centerY / scale, w / scale, h / scale);
        ctx.restore();
    }

    function partColor(part, fallback, hi = '#0284c7') {
        return (part != null && highlightPart === part) ? hi : fallback;
    }
    function partWidth(part, base) {
        return (part != null && highlightPart === part) ? base + 1.8 : base;
    }

    // A link drawn as an outlined capsule, filled so it occludes what it crosses.
    function rod(x1, y1, x2, y2, width, part, fill) {
        const a = Math.atan2(y2 - y1, x2 - x1);
        const r = width / 2;
        ctx.beginPath();
        ctx.arc(x1, y1, r, a + Math.PI / 2, a - Math.PI / 2);
        ctx.arc(x2, y2, r, a - Math.PI / 2, a + Math.PI / 2);
        ctx.closePath();
        ctx.fillStyle = fill || theme.fill;
        ctx.fill();
        ctx.strokeStyle = partColor(part, theme.line);
        ctx.lineWidth = partWidth(part, 2);
        ctx.stroke();
    }

    function boss(x, y, rOut, part, fill) {
        ctx.fillStyle = fill || theme.fill;
        ctx.strokeStyle = partColor(part, theme.line);
        ctx.lineWidth = partWidth(part, 2);
        ctx.beginPath(); ctx.arc(x, y, rOut, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, rOut * 0.4, 0, TAU); ctx.stroke();
    }

    const info = analyse(state.crank);
    const kin = solveLinkage(state.angle, state.crank);

    // --- 0. Support (ground link, part 5) ---
    const baseY = 242;
    ctx.fillStyle = theme.fillAlt;
    ctx.strokeStyle = partColor(1, theme.line);
    ctx.lineWidth = partWidth(1, 1);
    ctx.beginPath();
    ctx.roundRect(-430, baseY, 760, 46, 5);
    ctx.fill(); ctx.stroke();

    // Body carrying both pivots. It has to reach left past the rocker pivot at
    // O4 and stand tall enough to sit behind both, so the rocker and crank read
    // as mounted on one casting rather than floating.
    const bodyL = geo.O4.x - 120, bodyR = geo.O2.x + 70;
    // Trimmed 5% in height. The foot stays planted on the slab, so the saving
    // comes off the top edge.
    const BODY_HEIGHT_SCALE = 0.80;
    const bodyFullTop = Math.min(geo.O4.y, geo.O2.y) - 70;
    const bodyTop = baseY - (baseY - bodyFullTop) * BODY_HEIGHT_SCALE;
    ctx.beginPath();
    ctx.roundRect(bodyL, bodyTop, bodyR - bodyL, baseY - bodyTop, 1);

    ctx.fill(); ctx.stroke();

    // Ground line between the two fixed pivots
    ctx.strokeStyle = theme.lineSoft;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([9, 7]);
    ctx.beginPath();
    ctx.moveTo(geo.O4.x, geo.O4.y);
    ctx.lineTo(geo.O2.x, geo.O2.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const rackY = geo.O4.y - geo.pitchR;   // pitch line: rack rides tangent here
    const rackShift = kin ? kin.rack : 0;
    const th4 = kin ? kin.th4 : geo.TH4_REF;

    // --- 2. Rocker gear sector (part 3) ---
    // Pitch line is at radius geo.pitchR. Teeth reach ADDENDUM beyond it and are
    // cut back DEDENDUM behind it, on both gear and rack, so the two interleave.
    const ADDENDUM = 9, DEDENDUM = 11;
    const gearRoot = geo.pitchR - DEDENDUM;
    const gearTip = geo.pitchR + ADDENDUM;
    // The rocker is a gear SECTOR, not a full gear: it only ever oscillates, so
    // teeth are cut solely on the arc that passes the rack contact point over the
    // swing, plus a margin. The rest of the rim is plain, as in the reference.
    const toothA = TAU / geo.teeth;
    const halfRoot = toothA * 0.30, halfTip = toothA * 0.17;
    const gp = (r, a) => [geo.O4.x + r * Math.cos(a), geo.O4.y + r * Math.sin(a)];

    // The toothed sector is part of the casting: a fixed half of the rim, so the
    // tooth count never changes with crank length. Centred on where the rack
    // engages at the nominal rocker angle; verified to cover the engagement arc
    // for every crank the slider allows.
    const kLo = SECTOR_KLO, kHi = SECTOR_KHI;

    ctx.fillStyle = theme.gearFill;
    ctx.strokeStyle = partColor(3, theme.line);
    ctx.lineWidth = partWidth(3, 2.2);
    ctx.beginPath();
    if (kHi < kLo) {
        ctx.arc(geo.O4.x, geo.O4.y, gearRoot, 0, TAU);
    } else {
        let prevA = null;
        for (let k = kLo; k <= kHi; k++) {
            const phi = th4 + k * toothA;
            const a1 = phi - halfRoot, a2 = phi - halfTip, a3 = phi + halfTip, a4 = phi + halfRoot;
            if (prevA === null) { const s = gp(gearRoot, a1); ctx.moveTo(s[0], s[1]); }
            else ctx.arc(geo.O4.x, geo.O4.y, gearRoot, prevA, a1);
            let q = gp(gearTip, a2); ctx.lineTo(q[0], q[1]);
            q = gp(gearTip, a3); ctx.lineTo(q[0], q[1]);
            q = gp(gearRoot, a4); ctx.lineTo(q[0], q[1]);
            prevA = a4;
        }
        // Plain rim the long way round, back to where the toothed sector began
        const startA = th4 + kLo * toothA - halfRoot;
        ctx.arc(geo.O4.x, geo.O4.y, gearRoot, prevA, startA + TAU);
    }
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // Gear face detail
    ctx.strokeStyle = theme.lineSoft;
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(geo.O4.x, geo.O4.y, geo.pitchR * 0.62, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(geo.O4.x, geo.O4.y, geo.pitchR * 0.34, 0, TAU); ctx.stroke();

    // Rocker arm out to the coupler pin, and the hub
    // Rocker arm and crank throw carry the same light blue as the coupler, so the
    // three moving links read as one continuous chain against the fixed parts.
    if (kin) rod(geo.O4.x, geo.O4.y, kin.B.x, kin.B.y, 26, 3, theme.rodFill);
    boss(geo.O4.x, geo.O4.y, 26, 3, theme.gearFill);

    // --- 3. Rack (part 4) and its guide (part 6) ---
    const rackCx = geo.O4.x + rackShift;
    const rackBot = rackY - DEDENDUM;          // solid underside of the bar
    const rackTop = rackBot - geo.rackThick;

    // Guide sleeve the rack slides through: fixed, so it shows the constraint
    ctx.fillStyle = theme.fillAlt;
    ctx.strokeStyle = partColor(6, theme.lineSoft);
    ctx.lineWidth = partWidth(6, 1.8);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-60, rackTop - 10, 180, (rackBot - rackTop) + 34, 8);
    else ctx.rect(-60, rackTop - 10, 180, (rackBot - rackTop) + 34);
    ctx.fill(); ctx.stroke();

    // Rack as one rigid piece: bar and teeth are a single closed outline whose
    // tooth offsets from rackCx never change, so the teeth travel with the bar.
    // MESH_PHASE puts a rack tooth space over the gear tooth reaching contact.
    const p = geo.toothPitch;
    const rackL = rackCx - geo.rackLen / 2, rackR = rackCx + geo.rackLen / 2;
    const jLo = Math.ceil((-geo.rackLen / 2 - MESH_PHASE) / p);
    const jHi = Math.floor((geo.rackLen / 2 - MESH_PHASE) / p);
    const toothH = ADDENDUM + DEDENDUM;   // tips cross the pitch line by ADDENDUM

    ctx.fillStyle = theme.rackFill;
    ctx.strokeStyle = partColor(4, theme.line);
    ctx.lineWidth = partWidth(4, 2.2);
    ctx.beginPath();
    ctx.moveTo(rackL, rackTop);
    ctx.lineTo(rackR, rackTop);
    ctx.lineTo(rackR, rackBot);
    // walk the toothed underside from right to left
    for (let j = jHi; j >= jLo; j--) {
        const cx = rackCx + MESH_PHASE + j * p;
        if (cx - p * 0.30 < rackL || cx + p * 0.30 > rackR) continue;
        ctx.lineTo(cx + p * 0.30, rackBot);
        ctx.lineTo(cx + p * 0.17, rackBot + toothH);
        ctx.lineTo(cx - p * 0.17, rackBot + toothH);
        ctx.lineTo(cx - p * 0.30, rackBot);
    }
    ctx.lineTo(rackL, rackBot);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // --- 4. Crank (part 1) ---
    const crankR = state.crank + 26;
    ctx.fillStyle = theme.fill;
    ctx.strokeStyle = partColor(1, theme.line);
    ctx.lineWidth = partWidth(1, 2.2);
    ctx.beginPath(); ctx.arc(geo.O2.x, geo.O2.y, crankR, 0, TAU); ctx.fill(); ctx.stroke();

    // Spoked face, turning with the crank
    ctx.fillStyle = theme.fillAlt;
    ctx.strokeStyle = theme.lineSoft;
    ctx.lineWidth = 1.3;
    for (let s = 0; s < 6; s++) {
        const a0 = state.angle + s * TAU / 6 + 0.10;
        const a1 = state.angle + (s + 1) * TAU / 6 - 0.10;
        ctx.beginPath();
        ctx.arc(geo.O2.x, geo.O2.y, crankR - 12, a0, a1);
        ctx.arc(geo.O2.x, geo.O2.y, 24, a1, a0, true);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
    }
    boss(geo.O2.x, geo.O2.y, 24, 1, theme.fill);

    // Crank throw out to the pin
    if (kin) rod(geo.O2.x, geo.O2.y, kin.A.x, kin.A.y, 18, 1, theme.rodFill);

    // Fixed pivots, drawn before the coupler so nothing overdraws it
    [[geo.O4.x, geo.O4.y], [geo.O2.x, geo.O2.y]].forEach(([x, y]) => {
        ctx.fillStyle = theme.pin;
        ctx.strokeStyle = theme.line;
        ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.arc(x, y, 8, 0, TAU); ctx.fill(); ctx.stroke();
    });

    // --- 5. Motion paths ---
    // Above the crank and rocker so they stay readable, but below the
    // connecting rod, which is the nearest part of the linkage.
    if (state.showTrace) {
        ctx.save();
        ctx.strokeStyle = '#0284c7';
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 1.8;
        ctx.setLineDash([7, 6]);

        // Circle swept by the crank pin. Drawn in the crank's own rotating frame
        // so the dashes travel with it instead of sitting still under a spinning
        // part, which reads as though the path is detached from the crank.
        ctx.save();
        ctx.translate(geo.O2.x, geo.O2.y);
        ctx.rotate(state.angle);
        ctx.beginPath();
        ctx.arc(0, 0, state.crank, 0, TAU);
        ctx.stroke();
        ctx.restore();

        if (info.rotates) {
            // Arc swept by the coupler pin: the rocker only oscillates
            ctx.beginPath();
            ctx.arc(geo.O4.x, geo.O4.y, geo.rocker, info.minTh4, info.maxTh4);
            ctx.stroke();

            // Rack stroke, marked on the pitch line with end ticks
            const s0 = geo.pitchR * (info.minTh4 - geo.TH4_REF);
            const s1 = geo.pitchR * (info.maxTh4 - geo.TH4_REF);
            const ty = rackTop - 22;
            ctx.beginPath();
            ctx.moveTo(geo.O4.x + s0, ty);
            ctx.lineTo(geo.O4.x + s1, ty);
            ctx.stroke();
            ctx.setLineDash([]);
            [s0, s1].forEach(s => {
                ctx.beginPath();
                ctx.moveTo(geo.O4.x + s, ty - 9);
                ctx.lineTo(geo.O4.x + s, ty + 9);
                ctx.stroke();
            });
            // Label beside the right-hand tick, so it needs no headroom
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#0284c7';
            ctx.font = 'bold 15px Inter, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(`rack stroke ${info.stroke.toFixed(0)}`, geo.O4.x + Math.max(s0, s1) + 14, ty);
        }
        ctx.restore();
    }

    // --- 6. Connecting rod (part 2) ---
    // Last of the mechanism, so it is unambiguously the nearest part: it passes
    // in front of the crank wheel, the rocker and both pivots. Only its own pins
    // go over it, the way a pin caps the rod eye.
    if (kin) {
        rod(kin.A.x, kin.A.y, kin.B.x, kin.B.y, 20, 2, theme.rodFill);
        boss(kin.A.x, kin.A.y, 13, 2, theme.rodFill);
        boss(kin.B.x, kin.B.y, 13, 2, theme.rodFill);

        ctx.fillStyle = theme.pin;
        ctx.strokeStyle = theme.line;
        ctx.lineWidth = 1.6;
        [[kin.A.x, kin.A.y], [kin.B.x, kin.B.y]].forEach(([x, y]) => {
            ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU); ctx.fill(); ctx.stroke();
        });
    }

    // --- 7. Number badges ---
    badgeHits = [];
    if (state.showLabels && kin) {
        const labels = [
            { num: '1', x: geo.O2.x, y: geo.O2.y + crankR + 26 },
            { num: '2', x: (kin.A.x + kin.B.x) / 2, y: (kin.A.y + kin.B.y) / 2 - 26 },
            { num: '3', x: geo.O4.x + BADGE3_R * Math.cos(th4 + BADGE3_PSI),
                        y: geo.O4.y + BADGE3_R * Math.sin(th4 + BADGE3_PSI) },
            { num: '4', x: rackCx - geo.rackLen / 2 + 70, y: rackTop - 22 },
            { num: '5', x: -260, y: baseY + 23 },
            { num: '6', x: 30, y: rackBot + 42 }
        ];
        badgeHits = labels.map(l => ({
            num: l.num,
            sx: centerX + l.x * scale,
            sy: centerY + l.y * scale,
            r: 13 * scale
        }));
        labels.forEach(lbl => {
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
        });
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
        let next = (state.angle + omega * dt) % (Math.PI * 2);
        if (next < 0) next += Math.PI * 2;
        // A non-Grashof linkage cannot pass its limit: hold at the block instead
        // of tearing the assembly apart.
        if (solveLinkage(next, state.crank)) {
            state.angle = next;
        } else {
            state.running = false;
            setPlayButton(false);
        }
        document.getElementById('angle-slider').value = Math.round(state.angle * 180 / Math.PI);
        document.getElementById('val-angle').textContent = `${Math.round(state.angle * 180 / Math.PI)}°`;
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
    const delta = deg * Math.PI / 180;
    let next = (state.angle + delta + Math.PI * 2) % (Math.PI * 2);
    if (solveLinkage(next, state.crank)) state.angle = next;
    document.getElementById('angle-slider').value = Math.round(state.angle * 180 / Math.PI);
    document.getElementById('val-angle').textContent = `${Math.round(state.angle * 180 / Math.PI)}°`;
}
document.getElementById('btn-step-next').addEventListener('click', () => stepBy(10));
document.getElementById('btn-step-prev').addEventListener('click', () => stepBy(-10));

document.getElementById('btn-reset').addEventListener('click', () => {
    state.angle = 0;
    state.crank = 55;
    state.rpm = 40;
    document.getElementById('crank-slider').value = 55;
    document.getElementById('speed-slider').value = 40;
    document.getElementById('angle-slider').value = 0;
    document.getElementById('val-angle').textContent = '0°';
    updateStats();
});

const crankSlider = document.getElementById('crank-slider');
crankSlider.addEventListener('input', (e) => {
    state.crank = parseInt(e.target.value);
    // Nudge off a jammed angle so the linkage stays assembled.
    if (!solveLinkage(state.angle, state.crank)) {
        for (let d = 1; d < 360; d++) {
            const probe = (state.angle + d * Math.PI / 180) % (Math.PI * 2);
            if (solveLinkage(probe, state.crank)) { state.angle = probe; break; }
        }
    }
    updateStats();
});

const speedSlider = document.getElementById('speed-slider');
speedSlider.addEventListener('input', (e) => {
    state.rpm = parseInt(e.target.value);
    updateStats();
});

const angleSlider = document.getElementById('angle-slider');
angleSlider.addEventListener('input', (e) => {
    const deg = parseInt(e.target.value);
    const probe = deg * Math.PI / 180;
    if (solveLinkage(probe, state.crank)) state.angle = probe;
    document.getElementById('val-angle').textContent = `${Math.round(state.angle * 180 / Math.PI)}°`;
});

function updateStats() {
    const info = analyse(state.crank);
    document.getElementById('val-crank').textContent = state.crank;
    document.getElementById('val-speed').textContent = `${state.rpm} RPM`;
    document.getElementById('lbl-limit').textContent = `Grashof limit ${Math.floor(GRASHOF_LIMIT)}`;

    const swing = info.rotates ? `${(info.swing * 180 / Math.PI).toFixed(1)}°` : '—';
    const rpm = document.getElementById('stat-rpm');
    const sw = document.getElementById('stat-swing');
    const ty = document.getElementById('stat-type');
    if (rpm) rpm.textContent = state.rpm;
    if (sw) sw.textContent = swing;
    if (ty) {
        ty.textContent = info.type;
        ty.className = info.grashof ? 'text-amber-600 font-bold' : 'text-rose-600 font-bold';
    }
    const rpmM = document.getElementById('stat-rpm-mobile');
    const swM = document.getElementById('stat-swing-mobile');
    if (rpmM) rpmM.textContent = state.rpm;
    if (swM) swM.textContent = swing;

    document.getElementById('jam-banner').classList.toggle('hidden', info.rotates);
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
    '1': { title: 'Crank', desc: 'Shortest link, adjacent to ground. Grashof lets it turn a full circle.' },
    '2': { title: 'Connecting Rod', desc: 'Coupler carrying the crank pin motion across to the rocker.' },
    '3': { title: 'Rocker', desc: 'Geared sector that oscillates rather than rotates, driving the rack.' },
    '4': { title: 'Rack', desc: 'Linear output. Its stroke is the pitch radius times the rocker swing.' },
    '5': { title: 'Support', desc: 'The fixed ground link joining both pivots and carrying the frame.' },
    '6': { title: 'Rack Guide', desc: 'Sleeve constraining the rack to a straight sliding path.' }
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

function openInfo() {
    // Fill in the live geometry so the text can never drift from the model.
    document.getElementById('info-ground').textContent = geo.ground.toFixed(0);
    document.getElementById('info-coupler').textContent = geo.coupler;
    document.getElementById('info-rocker').textContent = geo.rocker;
    document.getElementById('info-pitch').textContent = geo.pitchR;
    document.getElementById('info-limit').textContent = GRASHOF_LIMIT.toFixed(1);
    infoModal.classList.remove('hidden');
}
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
    updateStats();
    resizeCanvas();
    requestAnimationFrame(animate);
    // reveal on the next painted frame, with a timeout backstop in case
    // rAF is throttled or the tab is not visible
    requestAnimationFrame(hideLoader);
    setTimeout(hideLoader, 400);
};
