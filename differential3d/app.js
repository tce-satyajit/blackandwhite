// =============================================================
//  Differential Gear — model
// =============================================================
const G = 9.81;
const CAR = { wheelbase: 2.6, wheelR: 0.32, mass: 1400, length: 4.3, width: 1.85 };
const CRR = 0.015;          // rolling resistance coefficient
const MU_R = 0.90;          // the right wheel is always on dry tarmac
const BRAKE_A = 6.0;        // braking deceleration, m/s²
const V_MAX = 20;           // m/s — this is a low-speed manoeuvring demonstration
const SPIN_GAIN = 200;      // how fast a wheel with no grip runs away
const SPIN_MAX = 80;        // rad/s ceiling on that runaway
const SPIDER_RATIO = 1.8;   // side gear radius ÷ spider gear radius

// Only the steering is left as a control. Torque and track are fixed at
// ordinary family-car values, and grip is the one thing the ice button
// changes — three fewer sliders to read before the physics shows up.
const TORQUE = 700;         // N·m arriving at the ring gear
const TRACK = 1.60;         // m between the driven wheels
const MU_DRY = 0.90, MU_ICE = 0.02;
const DEFAULTS = { steer: 0 };
const P = Object.assign({}, DEFAULTS);

const state = {
    v: 0, t: 0, dist: 0,
    drive: false, brake: false,
    wL: 0, wR: 0, wc: 0, wLroll: 0, wRroll: 0,
    slip: 0, slipping: false, slipLeft: true,
    tEach: 0, tGripL: 0, tGripR: 0, a: 0, F: 0,
    angL: 0, angR: 0, angC: 0, angS: 0,
    hist: [], sample: 0,
    ice: false, slowMo: false, sound: true,
    holdL: false, holdR: false, vectors: false, exploded: 0,
    viewMode: 'light',
    done: [false, false, false, false, false]
};

const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');
const $ = id => document.getElementById(id);

const FS = 1.15;
const fInter = (px, w) => `${w ? w + ' ' : ''}${(px * FS).toFixed(2)}px Inter, sans-serif`;
const fMono = (px, w) => `${w ? w + ' ' : ''}${(px * FS).toFixed(2)}px JetBrains Mono, monospace`;

const RPM = w => w * 60 / (2 * Math.PI);        // rad/s → rev/min
const muL = () => state.ice ? MU_ICE : MU_DRY;
// Steering angle sets the radius the car drives round, from the bicycle
// model. Dead ahead is an infinite radius, which is why it is special-cased.
const turnRadius = () => Math.abs(P.steer) < 0.5
    ? Infinity
    : CAR.wheelbase / Math.tan(Math.abs(P.steer) * Math.PI / 180);

// =============================================================
//  Simulation
// =============================================================
// ---- Engine sound ----------------------------------------------
// The same two clips the gearbox simulation uses: the starter cranking,
// then the engine running. Measured from the files — the crank is done by
// about 1.4 s, and the run clip loops between 8.20 s and 14.30 s, where its
// two ends match to within 0.2% and the repeat is inaudible.
//
// <audio> elements rather than the Web Audio API on purpose: these pages
// open straight off the disk, where fetch() and decodeAudioData are refused.
const SND_CATCH = 1.40;
const RUN_A = 8.20, RUN_B = 14.30;
// volume is capped at 1.0 by the media element, so these sit as high as
// the platform allows: the starter at the ceiling, the run loop just under
// it at road speed.
const RUN_VOL = 0.80, START_VOL = 1.0;

const sndStart = new Audio();
sndStart.preload = 'auto'; sndStart.src = 'vendor/audio/car-start-audio.mp3'; sndStart.load();
const sndRun = new Audio();
sndRun.preload = 'auto'; sndRun.src = 'vendor/audio/car-run-audio.mp3';
sndRun.preservesPitch = false;
sndRun.load();

let catchTimer = null, runFading = false, spinHandle = null;

function fadeOut(el, ms, done) {
    const steps = 10, dv = el.volume / steps;
    let n = 0;
    const t = setInterval(() => {
        el.volume = Math.max(0, el.volume - dv);
        if (++n >= steps) { clearInterval(t); el.pause(); if (done) done(); }
    }, ms / steps);
}

function soundStart() {
    if (!state.sound) return;
    clearTimeout(catchTimer);
    clearInterval(spinHandle); spinHandle = null; runFading = false;
    sndStart.currentTime = 0; sndStart.volume = START_VOL;
    sndStart.play().catch(() => {});
    catchTimer = setTimeout(() => {
        if (!state.drive || !state.sound) return;
        runFading = false;
        sndRun.currentTime = RUN_A; sndRun.volume = RUN_VOL;
        sndRun.play().catch(() => {});
        fadeOut(sndStart, 400);
    }, SND_CATCH * 1000);
}

// Stopping spins the engine down rather than cutting it, so the sound does
// not vanish while the car is still rolling.
function soundStop() {
    clearTimeout(catchTimer);
    if (!sndStart.paused) fadeOut(sndStart, 250);
    if (sndRun.paused) return;
    runFading = true;
    const steps = 18, ms = 1200;
    const v0 = sndRun.volume, r0 = sndRun.playbackRate;
    let n = 0;
    clearInterval(spinHandle);
    spinHandle = setInterval(() => {
        const f = ++n / steps;
        sndRun.volume = Math.max(0, v0 * (1 - f));
        sndRun.playbackRate = Math.max(0.30, r0 - (r0 - 0.30) * f);
        if (n >= steps) {
            clearInterval(spinHandle); spinHandle = null;
            sndRun.pause(); sndRun.playbackRate = 1; runFading = false;
        }
    }, ms / steps);
}

function soundResume() {
    if (!state.sound || !state.drive) return;
    clearTimeout(catchTimer);
    clearInterval(spinHandle); spinHandle = null;
    runFading = false;
    sndRun.currentTime = RUN_A;
    sndRun.volume = RUN_VOL;
    sndRun.playbackRate = 1;
    sndRun.play().catch(() => {});
}

// Pitch follows the carrier — the shaft the engine actually turns — so the
// note rises with road speed and drops away under slow motion.
function soundUpdate() {
    if (!state.drive || sndRun.paused || runFading) return;
    const f = Math.max(0, Math.min(1, state.v / V_MAX));
    const slow = state.slowMo ? SLOW : 1;
    sndRun.playbackRate = (0.80 + 0.80 * f) * slow;
    sndRun.volume = RUN_VOL * (0.70 + 0.30 * f);
    if (sndRun.currentTime >= RUN_B) sndRun.currentTime = RUN_A;
}

function reset() {
    state.v = 0; state.t = 0; state.dist = 0;
    state.drive = false; state.brake = false;
    state.slip = 0; state.slipping = false;
    state.angL = 0; state.angR = 0; state.angC = 0; state.angS = 0;
    state.hist = []; state.sample = 0;
    state.done = [false, false, false, false, false];
    state.ice = false; state.holdL = false; state.holdR = false;
    paintDrive(); paintIce(); paintHold(); paintChallenges();
    recompute(0);
}

// With one wheel jacked up and held, the car cannot move and the input
// shaft simply turns the carrier. This is the demonstration rate it turns
// at — everything else about the case follows from the differential rule.
const HOLD_CARRIER = 12;    // rad/s

function recompute(dt) {
    const R = turnRadius(), t = TRACK, rw = CAR.wheelR, m = CAR.mass;

    if (state.holdL || state.holdR) {
        // The held wheel is stopped, so the whole of the carrier's motion
        // has to come out of the other one: 0 + ω = 2 × carrier.
        const wc = state.drive ? HOLD_CARRIER : 0;
        state.wc = wc;
        state.wL = state.holdL ? 0 : 2 * wc;
        state.wR = state.holdR ? 0 : 2 * wc;
        state.v = 0; state.a = 0; state.F = 0;
        state.slip = 0; state.slipping = false;
        state.tGripL = muL() * m * G / 2 * rw;
        state.tGripR = MU_R * m * G / 2 * rw;
        state.tEach = Math.min(TORQUE / 2, state.tGripL, state.tGripR);
        return;
    }

    // ---- speeds: both wheels sweep the same angle, on different radii ----
    let vL, vR;
    if (!isFinite(R)) {
        vL = vR = state.v;
    } else {
        const vIn = state.v * (R - t / 2) / R;
        const vOut = state.v * (R + t / 2) / R;
        if (P.steer > 0) { vL = vOut; vR = vIn; }   // turning right: left wheel outside
        else { vL = vIn; vR = vOut; }
    }
    state.wLroll = vL / rw;
    state.wRroll = vR / rw;

    // ---- torque: an open differential always splits it equally ----
    const N = m * G / 2;                       // load carried by each driven wheel
    state.tGripL = muL() * N * rw;
    state.tGripR = MU_R * N * rw;
    const tSide = TORQUE / 2;                // what each side is offered
    const tLim = Math.min(state.tGripL, state.tGripR);
    state.tEach = Math.min(tSide, tLim);       // held down to the weaker wheel
    state.slipping = state.drive && tSide > tLim + 1e-6;
    state.slipLeft = muL() <= MU_R;

    // A wheel that cannot hold its share of the torque runs away. The one
    // that still grips keeps rolling with the road, so the carrier — which
    // is the average of the two — speeds up with it.
    const excess = Math.max(0, tSide - tLim);
    const target = state.slipping ? Math.min(SPIN_MAX, excess / (N * rw) * SPIN_GAIN) : 0;
    state.slip += (target - state.slip) * Math.min(1, dt / 0.6);

    state.wL = state.wLroll + (state.slipLeft ? state.slip : 0);
    state.wR = state.wRroll + (state.slipLeft ? 0 : state.slip);
    state.wc = (state.wL + state.wR) / 2;      // the differential rule, by construction

    // ---- motion ----
    state.F = state.drive ? 2 * state.tEach / rw : 0;
    const Froll = CRR * m * G;
    const Fbrake = state.brake && state.v > 0 ? BRAKE_A * m : 0;
    const vPrev = state.v;
    let v = state.v + ((state.F - Froll - Fbrake) / m) * dt;
    if (v < 0) v = 0;
    // A car cannot round a bend faster than its tyres will hold it.
    if (isFinite(R)) v = Math.min(v, Math.sqrt(MU_R * G * R));
    v = Math.min(v, V_MAX);
    state.v = v;
    state.a = dt > 0 ? (v - vPrev) / dt : 0;
    state.dist += v * dt;
}

function step(dt) {
    recompute(dt);
    state.t += dt;
    state.angL += state.wL * dt;
    state.angR += state.wR * dt;
    state.angC += state.wc * dt;
    // The spider gears only spin when the two wheels disagree. Going
    // straight they are carried round without turning on their own pins.
    state.angS += ((state.wR - state.wL) / 2) * SPIDER_RATIO * dt;

    state.sample += dt;
    if (state.sample >= 0.05) {
        state.sample = 0;
        state.hist.push({
            t: state.t, wl: RPM(state.wL), wr: RPM(state.wR),
            d: Math.abs(RPM(state.wR) - RPM(state.wL)), tq: state.tEach
        });
        if (state.hist.length > 700) state.hist.shift();
    }
    checkChallenges();
}

// =============================================================
//  Try This
// =============================================================
function checkChallenges() {
    const dl = Math.abs(RPM(state.wL) - RPM(state.wR));
    const lo = Math.min(Math.abs(state.wL), Math.abs(state.wR));
    const hi = Math.max(Math.abs(state.wL), Math.abs(state.wR));

    if (state.drive && state.v > 2 && Math.abs(P.steer) < 0.5 && dl < 0.01)
        win(0);
    if (state.drive && lo > 1 && hi / lo >= 1.4)
        win(1);
    // The rule is on screen the whole time; this ticks once they have
    // driven a corner long enough to have watched it hold.
    if (state.drive && dl > 15) {
        state.ruleWatch = (state.ruleWatch || 0) + 1;
        if (state.ruleWatch > 240 * 3)
            win(2);
    } else state.ruleWatch = 0;
    if (state.drive && Math.abs(P.steer) >= 24 && dl > 30)
        win(3);
    if (state.slipping && state.slip > 5 && state.v < 1.5)
        win(4);
}
// Challenges still tick themselves off in the (i) panel; they simply no
// longer interrupt the lesson with a banner over the simulation.
function win(i) {
    if (state.done[i]) return;
    state.done[i] = true;
    paintChallenges();
}
function paintChallenges() {
    for (let i = 0; i < 5; i++) {
        const el = $('ch-' + i);
        if (!el) continue;
        el.innerHTML = state.done[i] ? '&#9745;' : '&#9744;';
        el.className = 'mono ' + (state.done[i] ? 'text-emerald-600 font-bold' : '');
    }
}

// =============================================================
//  Canvas
// =============================================================
function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    draw();
}
window.addEventListener('resize', resizeCanvas);

function rr(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, Math.max(1, h), r);
    else ctx.rect(x, y, w, Math.max(1, h));
}
function head(x, y, ang, s) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-s, -s * 0.6); ctx.lineTo(-s, s * 0.6);
    ctx.closePath(); ctx.fillStyle = ctx.strokeStyle; ctx.fill(); ctx.restore();
}

function draw() {
    const W = canvas.getBoundingClientRect().width;
    const H = canvas.getBoundingClientRect().height;
    const dark = state.viewMode === 'blueprint';

    const T = dark ? {
        line: '#e2e8f0', soft: '#64748b', fill: '#0f172a', alt: '#1e293b',
        body: '#1e293b', accent: '#38bdf8', bg: '#0f172a', hud: 'rgba(15,23,42,.9)',
        road: '#000000', mark: '#e2e8f0', grass: '#132033', warn: '#fbbf24'
    } : {
        line: '#1e293b', soft: '#94a3b8', fill: '#ffffff', alt: '#f1f5f9',
        body: '#e8eaed', accent: '#0284c7', bg: '#f8fafc', hud: 'rgba(255,255,255,.94)',
        road: '#17191c', mark: '#f8fafc', grass: '#eef2f0', warn: '#b45309'
    };

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);

    // The canvas is now only the road; the differential itself is the
    // three-dimensional model in the panel beside it.
    drawRoad(0, 0, W, H, T);
}

// ---- the car, actually driving along the road ---------------
function drawRoad(x, y, w, h, T) {
    const scale = 21;                       // px per metre — sized to be read across a classroom
    const cx = x + w * 0.5, cy = y + h * 0.66;
    const t = TRACK * scale, rw = CAR.wheelR * scale;
    const half = 2.7 * scale;               // half the road width
    const R = turnRadius();
    const dir = Math.sign(P.steer) || 1;
    const post = 6;                         // metres between roadside posts

    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = T.grass; ctx.fillRect(x, y, w, h);

    if (!isFinite(R)) {
        // ---- straight: the road runs up the screen and slides past ----
        ctx.fillStyle = T.road;
        ctx.fillRect(cx - half, y, half * 2, h);
        ctx.strokeStyle = T.mark; ctx.lineWidth = 3;
        ctx.setLineDash([18, 16]);
        ctx.lineDashOffset = -(state.dist * scale);
        ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx, y + h); ctx.stroke();
        ctx.setLineDash([]);

        // the two wheel tracks, which here sit exactly on top of each other
        ctx.setLineDash([9, 8]); ctx.lineWidth = 2;
        ctx.lineDashOffset = -(state.dist * scale);
        [[-1, T.accent], [1, T.soft]].forEach(([sg, col]) => {
            ctx.strokeStyle = col;
            ctx.beginPath();
            ctx.moveTo(cx + sg * t / 2, y); ctx.lineTo(cx + sg * t / 2, y + h); ctx.stroke();
        });
        ctx.setLineDash([]);

        // posts sliding by — the clearest sign the car is moving
        const step = post * scale;
        const phase = (state.dist * scale) % step;
        ctx.strokeStyle = T.soft; ctx.lineWidth = 3;
        for (let py = y - step + phase; py < y + h + step; py += step) {
            ctx.beginPath(); ctx.moveTo(cx - half - 6, py); ctx.lineTo(cx - half - 14, py); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(cx + half + 6, py); ctx.lineTo(cx + half + 14, py); ctx.stroke();
        }
    } else {
        // ---- turning: the road is an arc, and it sweeps past ----
        const Rc = R * scale;
        const ox = cx + dir * Rc, oy = cy;
        ctx.strokeStyle = T.road; ctx.lineWidth = half * 2;
        ctx.beginPath(); ctx.arc(ox, oy, Rc, 0, Math.PI * 2); ctx.stroke();

        ctx.strokeStyle = T.mark; ctx.lineWidth = 3;
        ctx.setLineDash([18, 16]);
        ctx.lineDashOffset = dir * state.dist * scale;
        ctx.beginPath(); ctx.arc(ox, oy, Rc, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);

        // the two wheel tracks: different circles, which is the whole point
        ctx.setLineDash([9, 8]); ctx.lineWidth = 2;
        ctx.lineDashOffset = dir * state.dist * scale;
        [[-1, 0], [1, 0]].forEach(([sg]) => {
            const rad = Math.abs(ox - (cx + sg * t / 2));
            // the outer track is the far one from the centre of the turn
            ctx.strokeStyle = rad > Rc ? T.accent : T.soft;
            ctx.beginPath(); ctx.arc(ox, oy, rad, 0, Math.PI * 2); ctx.stroke();
        });
        ctx.setLineDash([]);

        // posts, placed by real arc position so they track the car exactly
        const phi0 = dir > 0 ? Math.PI : 0;
        ctx.strokeStyle = T.soft; ctx.lineWidth = 3;
        for (let k = -40; k <= 40; k++) {
            const phi = phi0 + dir * (k * post - state.dist) / R;
            [-1, 1].forEach(side => {
                const r1 = Rc + side * (half + 6), r2 = Rc + side * (half + 14);
                const px1 = ox + Math.cos(phi) * r1, py1 = oy + Math.sin(phi) * r1;
                if (px1 < x - 20 || px1 > x + w + 20 || py1 < y - 20 || py1 > y + h + 20) return;
                ctx.beginPath();
                ctx.moveTo(px1, py1);
                ctx.lineTo(ox + Math.cos(phi) * r2, oy + Math.sin(phi) * r2);
                ctx.stroke();
            });
        }
    }

    // ---- the car ----
    const L = CAR.length * scale, Wd = CAR.width * scale;
    const rearY = cy + 1.1 * scale;
    ctx.fillStyle = T.body; ctx.strokeStyle = T.line; ctx.lineWidth = 2.6;
    rr(cx - Wd / 2, cy - L / 2, Wd, L, Wd * 0.30); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = T.soft; ctx.lineWidth = 1.5;
    rr(cx - Wd * 0.34, cy - L * 0.20, Wd * 0.68, L * 0.34, 5); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - t / 2, rearY); ctx.lineTo(cx + t / 2, rearY); ctx.stroke();

    [[-1, state.wL, state.slipLeft && state.slipping],
     [1, state.wR, !state.slipLeft && state.slipping]].forEach(([sg, ww, spin]) => {
        const wx = cx + sg * t / 2;
        ctx.fillStyle = spin ? T.warn : T.fill;
        ctx.strokeStyle = T.line; ctx.lineWidth = 2.2;
        rr(wx - rw * 0.34, rearY - rw, rw * 0.68, rw * 2, 3); ctx.fill(); ctx.stroke();
        // tread marks that run round with the wheel, so it visibly rolls
        ctx.strokeStyle = T.soft; ctx.lineWidth = 1.6;
        const ang = sg < 0 ? state.angL : state.angR;
        for (let i = 0; i < 4; i++) {
            const f = (((ang / (2 * Math.PI)) + i / 4) % 1 + 1) % 1;
            const ty = rearY - rw + f * rw * 2;
            ctx.beginPath();
            ctx.moveTo(wx - rw * 0.30, ty); ctx.lineTo(wx + rw * 0.30, ty); ctx.stroke();
        }
        ctx.fillStyle = spin ? T.warn : T.line; ctx.font = fMono(11, 700);
        ctx.textAlign = sg < 0 ? 'right' : 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(`${RPM(ww).toFixed(0)}`, wx + sg * (rw * 0.34 + 8), rearY + 2);
        ctx.fillStyle = T.soft; ctx.font = fInter(9, 600);
        ctx.fillText(sg < 0 ? 'LEFT' : 'RIGHT', wx + sg * (rw * 0.34 + 8), rearY - 14 * FS);
    });

    // front wheels follow the steering
    const frontY = cy - 1.5 * scale, sa = P.steer * Math.PI / 180;
    [-1, 1].forEach(sg => {
        ctx.save(); ctx.translate(cx + sg * t / 2, frontY); ctx.rotate(sa);
        ctx.fillStyle = T.fill; ctx.strokeStyle = T.soft; ctx.lineWidth = 1.8;
        rr(-rw * 0.30, -rw * 0.85, rw * 0.60, rw * 1.7, 3); ctx.fill(); ctx.stroke();
        ctx.restore();
    });

    // one plain sentence, and how far it has come
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = T.soft; ctx.font = fInter(11, 600);
    ctx.fillText(!isFinite(R)
        ? 'Straight road — both wheels roll the same distance.'
        : `Turning: the outer wheel is on a circle ${TRACK.toFixed(1)} m bigger.`,
        x + w / 2, y + h - 26 * FS);
    ctx.font = fMono(11, 700); ctx.fillStyle = T.line;
    ctx.fillText(`${(state.v * 3.6).toFixed(0)} km/h    ${state.dist.toFixed(0)} m travelled`,
        x + w / 2, y + h - 10 * FS);
    if (state.slowMo) {
        ctx.font = fInter(10, 700); ctx.fillStyle = T.accent;
        ctx.fillText(`SLOW MOTION ×${SLOW}  —  speeds shown are the real ones`,
            x + w / 2, y + 14 * FS);
    }
    ctx.restore();
}

// =============================================================
//  The differential in three dimensions
//  Model lifted from gemini.html as built. It carries no physics of its
//  own here: every part is turned by the angles this simulation already
//  computes, so what you see is exactly what the numbers say.
// =============================================================
let scene, camera, renderer, controls;

// Object Groups
let mainAssemblyGroup, pinionGroup, crownWheelGroup, rotatingCageGroup;
let spiderGear1Group, spiderGear2Group;
let leftAxleGroup, rightAxleGroup;
let vectorArrowsGroup;
let studioFloorMesh, gridHelper;

// Visual Velocity Arrows
let arrowPinion, arrowCarrier, arrowLeftAxle, arrowRightAxle;


function initScene() {
    const container = document.getElementById('canvas-container');

    scene = new THREE.Scene();

    scene.background = new THREE.Color(0xdbe0e6);
    scene.fog = new THREE.FogExp2(0xdbe0e6, 0.012);

    camera = new THREE.PerspectiveCamera(38, container.clientWidth / container.clientHeight, 0.1, 1000);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxDistance = 50;
    controls.minDistance = 3;
    controls.target.set(0, 0, 0);

    // Studio Lighting Setup
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xffffff, 1.4);
    mainLight.position.set(15, 22, 18);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    mainLight.shadow.bias = -0.0001;
    scene.add(mainLight);

    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.6);
    fillLight.position.set(-18, 12, -12);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffedd5, 0.5);
    rimLight.position.set(0, -10, -15);
    scene.add(rimLight);

    // Ground Plane
    const planeGeo = new THREE.PlaneGeometry(120, 120);
    const planeMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        roughness: 0.8,
        metalness: 0.1
    });
    studioFloorMesh = new THREE.Mesh(planeGeo, planeMat);
    studioFloorMesh.rotation.x = -Math.PI / 2;
    studioFloorMesh.position.y = -5.0;
    studioFloorMesh.receiveShadow = true;
    scene.add(studioFloorMesh);

    gridHelper = new THREE.GridHelper(50, 50, 0x334155, 0x1e293b);
    gridHelper.position.y = -4.99;
    gridHelper.visible = false;
    scene.add(gridHelper);

    window.addEventListener('resize', onWindowResize);
}


let cachedChevronTireTextures = null;

function getChevronTireTextures() {
    if (cachedChevronTireTextures) return cachedChevronTireTextures;

    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 1024, 512);

    ctx.fillStyle = '#000000';
    const circumferentialGrooves = [130, 210, 302, 382];
    circumferentialGrooves.forEach(y => {
        ctx.fillRect(0, y - 5, 1024, 10);
    });

    ctx.fillRect(0, 252, 1024, 8);

    const numChevrons = 32;
    const stepX = 1024 / numChevrons;

    for (let i = 0; i < numChevrons; i++) {
        const x = i * stepX;

        ctx.lineWidth = 9;
        ctx.strokeStyle = '#050505';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(x, 130);
        ctx.lineTo(x + stepX * 0.7, 190);
        ctx.lineTo(x + stepX * 0.4, 252);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(x, 382);
        ctx.lineTo(x + stepX * 0.7, 322);
        ctx.lineTo(x + stepX * 0.4, 252);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(x + stepX * 0.2, 50);
        ctx.lineTo(x + stepX * 0.6, 130);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(x + stepX * 0.2, 462);
        ctx.lineTo(x + stepX * 0.6, 382);
        ctx.stroke();

        ctx.lineWidth = 3;
        ctx.strokeStyle = '#303030';
        ctx.beginPath();
        ctx.moveTo(x + stepX * 0.3, 150);
        ctx.lineTo(x + stepX * 0.8, 195);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(x + stepX * 0.3, 362);
        ctx.lineTo(x + stepX * 0.8, 317);
        ctx.stroke();
    }

    const bumpMap = new THREE.CanvasTexture(canvas);
    bumpMap.wrapS = THREE.RepeatWrapping;
    bumpMap.wrapT = THREE.ClampToEdgeWrapping;

    cachedChevronTireTextures = { bumpMap };
    return cachedChevronTireTextures;
}


function createRealWheelAssembly() {
    const wheelGroup = new THREE.Group();

    // Oversized Realistic Wheel & Tire (Outer radius ~4.2, much larger than the ~2.2 radius crown wheel)
    const tirePoints = [
        new THREE.Vector2(2.4, -1.20),
        new THREE.Vector2(2.6, -1.25),
        new THREE.Vector2(3.3, -1.30),
        new THREE.Vector2(3.9, -1.00),
        new THREE.Vector2(4.1, -0.55),
        new THREE.Vector2(4.2,  0.00),
        new THREE.Vector2(4.1,  0.55),
        new THREE.Vector2(3.9,  1.00),
        new THREE.Vector2(3.3,  1.30),
        new THREE.Vector2(2.6,  1.25),
        new THREE.Vector2(2.4,  1.20)
    ];

    const tireGeo = new THREE.LatheGeometry(tirePoints, 64);
    const { bumpMap } = getChevronTireTextures();

    const tireMat = new THREE.MeshStandardMaterial({
        color: 0x1a1e22,
        roughness: 0.85,
        metalness: 0.05,
        bumpMap: bumpMap,
        bumpScale: 0.16
    });

    const tireMesh = new THREE.Mesh(tireGeo, tireMat);
    tireMesh.castShadow = true;
    tireMesh.receiveShadow = true;
    wheelGroup.add(tireMesh);

    // Alloy Rim Barrel
    const rimProfile = [
        new THREE.Vector2(2.38, -1.20),
        new THREE.Vector2(2.50, -1.20),
        new THREE.Vector2(2.42, -1.00),
        new THREE.Vector2(2.20, -0.70),
        new THREE.Vector2(1.95, -0.30),
        new THREE.Vector2(1.95,  0.30),
        new THREE.Vector2(2.20,  0.70),
        new THREE.Vector2(2.42,  1.00),
        new THREE.Vector2(2.50,  1.20),
        new THREE.Vector2(2.38,  1.20)
    ];

    const rimBarrelGeo = new THREE.LatheGeometry(rimProfile, 64);
    const rimMat = new THREE.MeshStandardMaterial({
        color: 0xd1d5db,
        metalness: 0.92,
        roughness: 0.15
    });
    const rimBarrelMesh = new THREE.Mesh(rimBarrelGeo, rimMat);
    rimBarrelMesh.castShadow = true;
    wheelGroup.add(rimBarrelMesh);

    // 5-Spoke Alloy Wheel Face
    const spokeMat = new THREE.MeshStandardMaterial({
        color: 0x9ca3af,
        metalness: 0.9,
        roughness: 0.2
    });

    for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2;
        const spokeGroup = new THREE.Group();
        spokeGroup.rotation.y = angle;

        const spokeGeo = new THREE.BoxGeometry(0.38, 0.38, 1.35);
        const pos = spokeGeo.attributes.position;
        for (let k = 0; k < pos.count; k++) {
            if (pos.getZ(k) > 0) {
                pos.setX(k, pos.getX(k) * 0.7);
                pos.setY(k, pos.getY(k) * 0.7);
            }
        }
        spokeGeo.computeVertexNormals();

        const spokeMesh = new THREE.Mesh(spokeGeo, spokeMat);
        spokeMesh.position.set(0, 0.7, 1.3);
        spokeMesh.castShadow = true;
        spokeGroup.add(spokeMesh);

        wheelGroup.add(spokeGroup);
    }

    // Center Wheel Hub Cap with axle sleeve
    const hubCapGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.5, 32);
    const hubCapMat = new THREE.MeshStandardMaterial({ color: 0x374151, metalness: 0.9, roughness: 0.2 });
    const hubCapMesh = new THREE.Mesh(hubCapGeo, hubCapMat);
    hubCapMesh.position.y = 0.8;
    wheelGroup.add(hubCapMesh);

    return wheelGroup;
}


function createBevelGearGeometry(numTeeth, outerRadius, innerRadius, faceWidth, bevelAngle, colorHex) {
    const group = new THREE.Group();

    const coneGeo = new THREE.CylinderGeometry(outerRadius, outerRadius - Math.tan(bevelAngle) * faceWidth, faceWidth, numTeeth * 2);
    const gearMat = new THREE.MeshStandardMaterial({
        color: colorHex,
        metalness: 0.82,
        roughness: 0.22
    });

    for (let i = 0; i < numTeeth; i++) {
        const angle = (i / numTeeth) * Math.PI * 2;
        const toothWidth = (2 * Math.PI * outerRadius) / (numTeeth * 2.2);
        const toothDepth = faceWidth * 0.95;
        const toothHeight = outerRadius * 0.24;

        const toothGeo = new THREE.BoxGeometry(toothWidth, toothHeight, toothDepth);
        const posAttr = toothGeo.attributes.position;
        for (let j = 0; j < posAttr.count; j++) {
            if (posAttr.getY(j) > 0) {
                posAttr.setX(j, posAttr.getX(j) * 0.6);
            }
        }
        toothGeo.computeVertexNormals();

        const toothMesh = new THREE.Mesh(toothGeo, gearMat);
        toothMesh.position.x = Math.cos(angle) * (outerRadius - toothHeight * 0.18);
        toothMesh.position.z = Math.sin(angle) * (outerRadius - toothHeight * 0.18);
        toothMesh.rotation.y = -angle;
        toothMesh.rotation.z = Math.PI / 12;
        toothMesh.castShadow = true;

        group.add(toothMesh);
    }

    const coreMesh = new THREE.Mesh(coneGeo, gearMat);
    coreMesh.castShadow = true;
    group.add(coreMesh);

    return { group, gearMat };
}


function createPropellerShaftAndPinion() {
    const group = new THREE.Group();

    // Green Tail Pinion (Drive Gear)
    const pinionRes = createBevelGearGeometry(10, 0.75, 0.45, 0.7, Math.PI / 4, 0x16a34a);
    pinionRes.group.rotation.x = Math.PI / 2;
    pinionRes.group.position.z = 1.0;
    group.add(pinionRes.group);

    // Green Propeller Shaft
    const shaftGeo = new THREE.CylinderGeometry(0.32, 0.32, 4.5, 24);
    const shaftMat = new THREE.MeshStandardMaterial({ color: 0x15803d, metalness: 0.8, roughness: 0.25 });
    const shaftMesh = new THREE.Mesh(shaftGeo, shaftMat);
    shaftMesh.rotation.x = Math.PI / 2;
    shaftMesh.position.z = 3.25;
    shaftMesh.castShadow = true;
    group.add(shaftMesh);

    // Universal Joint Yoke & Flange Coupling
    const flangeGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.25, 24);
    const flangeMat = new THREE.MeshStandardMaterial({ color: 0x166534, metalness: 0.85, roughness: 0.2 });
    const flangeMesh = new THREE.Mesh(flangeGeo, flangeMat);
    flangeMesh.rotation.x = Math.PI / 2;
    flangeMesh.position.z = 4.0;
    flangeMesh.castShadow = true;
    group.add(flangeMesh);

    const yokeGeo = new THREE.BoxGeometry(0.7, 0.35, 0.8);
    const yokeMesh = new THREE.Mesh(yokeGeo, shaftMat);
    yokeMesh.position.z = 4.5;
    yokeMesh.castShadow = true;
    group.add(yokeMesh);

    return group;
}


function createRotatingCageMesh() {
    // Distinctive Red Differential Housing / Cage as in the diagram
    const cageGroup = new THREE.Group();
    const cageMat = new THREE.MeshStandardMaterial({
        color: 0xdc2626, // Vivid Red
        metalness: 0.7,
        roughness: 0.3
    });

    // Base Ring attaching cage to Crown Wheel
    const ringGeo = new THREE.CylinderGeometry(1.6, 1.6, 0.3, 32);
    const ringMesh = new THREE.Mesh(ringGeo, cageMat);
    ringMesh.rotation.z = Math.PI / 2;
    ringMesh.position.x = 0.2;
    ringMesh.castShadow = true;
    cageGroup.add(ringMesh);

    // Tapered Bracket / Rotating Cage Shell around spider gears
    const cageBodyShape = new THREE.Shape();
    cageBodyShape.moveTo(0.2, 1.45);
    cageBodyShape.lineTo(2.2, 0.85);
    cageBodyShape.lineTo(2.2, -0.85);
    cageBodyShape.lineTo(0.2, -1.45);
    cageBodyShape.closePath();

    // Top Arch Leg of the Cage
    const archTopGeo = new THREE.BoxGeometry(2.0, 0.35, 0.5);
    const archTopMesh = new THREE.Mesh(archTopGeo, cageMat);
    archTopMesh.position.set(1.1, 1.3, 0);
    archTopMesh.rotation.z = -0.25;
    archTopMesh.castShadow = true;
    cageGroup.add(archTopMesh);

    // Bottom Arch Leg of the Cage
    const archBotMesh = new THREE.Mesh(archTopGeo, cageMat);
    archBotMesh.position.set(1.1, -1.3, 0);
    archBotMesh.rotation.z = 0.25;
    archBotMesh.castShadow = true;
    cageGroup.add(archBotMesh);

    // Outer Shaft Bearing Support Sleeve at cage end
    const sleeveGeo = new THREE.CylinderGeometry(0.65, 0.65, 0.7, 32);
    const sleeveMesh = new THREE.Mesh(sleeveGeo, cageMat);
    sleeveMesh.rotation.z = Math.PI / 2;
    sleeveMesh.position.x = 2.0;
    sleeveMesh.castShadow = true;
    cageGroup.add(sleeveMesh);

    return cageGroup;
}


function buildDifferentialAssembly() {
    mainAssemblyGroup = new THREE.Group();
    scene.add(mainAssemblyGroup);

    // 1. PROPELLER SHAFT & TAIL PINION (Green Drive Gear)
    pinionGroup = createPropellerShaftAndPinion();
    mainAssemblyGroup.add(pinionGroup);

    // 2. CROWN WHEEL (Yellow Bevel Ring Gear) & ROTATING CAGE (Red Housing)
    crownWheelGroup = new THREE.Group();

    // Yellow Crown Wheel
    const ringRes = createBevelGearGeometry(30, 2.2, 1.4, 0.65, Math.PI / 4, 0xf59e0b);
    ringRes.group.rotation.z = Math.PI / 2;
    crownWheelGroup.add(ringRes.group);

    // Red Rotating Cage
    rotatingCageGroup = createRotatingCageMesh();
    crownWheelGroup.add(rotatingCageGroup);

    // Cross-Pin Pinion Shaft holding Bevel Gears
    const pinMat = new THREE.MeshStandardMaterial({ color: 0x15803d, metalness: 0.8, roughness: 0.2 });
    const pinGeo = new THREE.CylinderGeometry(0.2, 0.2, 2.8, 24);
    const pinMesh = new THREE.Mesh(pinGeo, pinMat);
    pinMesh.castShadow = true;
    crownWheelGroup.add(pinMesh);

    mainAssemblyGroup.add(crownWheelGroup);

    // 3. BEVEL GEARS (Green Internal Spider Pinions)
    spiderGear1Group = new THREE.Group();
    const spider1Res = createBevelGearGeometry(12, 0.75, 0.4, 0.55, Math.PI / 4, 0x22c55e); // Green
    spider1Res.group.rotation.x = Math.PI;
    spiderGear1Group.add(spider1Res.group);
    spiderGear1Group.position.y = 1.05;
    crownWheelGroup.add(spiderGear1Group);

    spiderGear2Group = new THREE.Group();
    const spider2Res = createBevelGearGeometry(12, 0.75, 0.4, 0.55, Math.PI / 4, 0x22c55e); // Green
    spiderGear2Group.add(spider2Res.group);
    spiderGear2Group.position.y = -1.05;
    crownWheelGroup.add(spiderGear2Group);

    // 4. INNER HALF SHAFT & AXLE SHAFT GEAR / SUN GEAR (Steel Light Blue + Oversized Wheel)
    leftAxleGroup = new THREE.Group();

    const leftSideRes = createBevelGearGeometry(16, 1.0, 0.5, 0.55, Math.PI / 4, 0x60a5fa); // Steel Blue
    leftSideRes.group.rotation.z = -Math.PI / 2;
    leftSideRes.group.position.x = -1.05;
    leftAxleGroup.add(leftSideRes.group);

    // Steel Blue Inner Half Shaft
    const leftShaftGeo = new THREE.CylinderGeometry(0.35, 0.35, 8.0, 24);
    const leftShaftMat = new THREE.MeshStandardMaterial({ color: 0x93c5fd, metalness: 0.85, roughness: 0.2 });
    const leftShaftMesh = new THREE.Mesh(leftShaftGeo, leftShaftMat);
    leftShaftMesh.rotation.z = Math.PI / 2;
    leftShaftMesh.position.x = -4.8;
    leftShaftMesh.castShadow = true;
    leftAxleGroup.add(leftShaftMesh);

    // Oversized Left Wheel
    const leftWheel = createRealWheelAssembly();
    leftWheel.position.x = -8.8;
    leftWheel.rotation.z = Math.PI / 2;
    leftAxleGroup.add(leftWheel);

    mainAssemblyGroup.add(leftAxleGroup);

    // 5. OUTER HALF SHAFT & AXLE SHAFT GEAR / SUN GEAR (Steel Light Blue + Oversized Wheel)
    rightAxleGroup = new THREE.Group();

    const rightSideRes = createBevelGearGeometry(16, 1.0, 0.5, 0.55, Math.PI / 4, 0x60a5fa); // Steel Blue
    rightSideRes.group.rotation.z = Math.PI / 2;
    rightSideRes.group.position.x = 1.05;
    rightAxleGroup.add(rightSideRes.group);

    // Steel Blue Outer Half Shaft
    const rightShaftGeo = new THREE.CylinderGeometry(0.35, 0.35, 8.0, 24);
    const rightShaftMat = new THREE.MeshStandardMaterial({ color: 0x93c5fd, metalness: 0.85, roughness: 0.2 });
    const rightShaftMesh = new THREE.Mesh(rightShaftGeo, rightShaftMat);
    rightShaftMesh.rotation.z = Math.PI / 2;
    rightShaftMesh.position.x = 4.8;
    rightShaftMesh.castShadow = true;
    rightAxleGroup.add(rightShaftMesh);

    // Oversized Right Wheel
    const rightWheel = createRealWheelAssembly();
    rightWheel.position.x = 8.8;
    rightWheel.rotation.z = -Math.PI / 2;
    rightAxleGroup.add(rightWheel);

    mainAssemblyGroup.add(rightAxleGroup);

    // Velocity Vector Indicator Rings aligned with respective shaft axes
    vectorArrowsGroup = new THREE.Group();
    vectorArrowsGroup.visible = false;   // toggled by the Speed Rings chip

    // Pinion ring encircles Z-axis propeller shaft (XY plane)
    arrowPinion = createRotationRing(0.85, 0x16a34a, 'Z');
    arrowPinion.position.set(0, 0, 3.2);
    vectorArrowsGroup.add(arrowPinion);

    // Carrier ring aligned with X-axis crown wheel (YZ plane)
    arrowCarrier = createRotationRing(2.5, 0xf59e0b, 'X');
    arrowCarrier.position.set(0, 0, 0);
    vectorArrowsGroup.add(arrowCarrier);

    // Axle shaft rings aligned with X-axis axles (YZ plane)
    arrowLeftAxle = createRotationRing(1.5, 0x60a5fa, 'X');
    arrowLeftAxle.position.set(-5.0, 0, 0);
    vectorArrowsGroup.add(arrowLeftAxle);

    arrowRightAxle = createRotationRing(1.5, 0x60a5fa, 'X');
    arrowRightAxle.position.set(5.0, 0, 0);
    vectorArrowsGroup.add(arrowRightAxle);

    mainAssemblyGroup.add(vectorArrowsGroup);
}


function createRotationRing(radius, colorHex, alignAxis = 'Z') {
    const group = new THREE.Group();
    const ringGeo = new THREE.TorusGeometry(radius, 0.04, 12, 48);

    // Align torus normal to X axis if needed (default Torus is perpendicular to Z)
    if (alignAxis === 'X') {
        ringGeo.rotateY(Math.PI / 2);
    }

    const ringMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.85 });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    group.add(ringMesh);

    const coneGeo = new THREE.ConeGeometry(0.16, 0.4, 16);
    const coneMat = new THREE.MeshBasicMaterial({ color: colorHex });
    const coneMesh = new THREE.Mesh(coneGeo, coneMat);

    if (alignAxis === 'X') {
        coneMesh.position.set(0, radius, 0);
        coneMesh.rotation.z = -Math.PI / 2;
    } else {
        coneMesh.position.set(0, radius, 0);
        coneMesh.rotation.z = -Math.PI / 2;
    }
    group.add(coneMesh);

    return group;
}


function setCameraCADView() {
    moveCamera(-8.5, 6.2, 14.5, 0, 0, 0);
}


function moveCamera(x, y, z, tx = 0, ty = 0, tz = 0) {
    const startPos = camera.position.clone();
    const targetPos = new THREE.Vector3(x, y, z);
    const startTarget = controls.target.clone();
    const endTarget = new THREE.Vector3(tx, ty, tz);
    const duration = 650;
    const startTime = performance.now();

    function animateCam(now) {
        const t = Math.min((now - startTime) / duration, 1.0);
        const easeT = t * (2 - t);
        camera.position.lerpVectors(startPos, targetPos, easeT);
        controls.target.lerpVectors(startTarget, endTarget, easeT);
        controls.update();
        if (t < 1.0) requestAnimationFrame(animateCam);
    }
    requestAnimationFrame(animateCam);
}

function onWindowResize() {
    const container = document.getElementById('canvas-container');
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}


const RING_PINION = 3.0;      // the model's ring-to-pinion ratio
let three3DReady = false;

// A classroom machine with no WebGL must still get the working simulation.
// Anything that goes wrong building the 3D view is contained here, so the
// road, the physics and every reading carry on regardless.
function init3D() {
    try {
        if (!window.THREE) throw new Error('three.js did not load');
        initScene();
        buildDifferentialAssembly();
        setCameraCADView();
        three3DReady = true;
    } catch (err) {
        three3DReady = false;
        console.warn('3D view unavailable:', err.message);
        const c = $('canvas-container');
        if (c) c.innerHTML =
            '<div class="w-full h-full flex items-center justify-center p-6 text-center">' +
            '<p class="text-[calc(12px*var(--fs))] text-slate-500 max-w-xs">' +
            'The 3D differential needs WebGL, which this browser has turned off. ' +
            'Everything else on the page still works.</p></div>';
    }
}

// Drive the model from our own angles, every frame. The updated build
// spins the carrier and axle rings about X and the pinion about Z, so the
// indicator rings follow the same axes as the parts they belong to.
function update3D() {
    if (!three3DReady) return;
    if (controls && controls.update) controls.update();

    crownWheelGroup.rotation.x = state.angC;          // ring gear + carrier case
    leftAxleGroup.rotation.x = state.angL;            // left half-shaft
    rightAxleGroup.rotation.x = state.angR;           // right half-shaft
    spiderGear1Group.rotation.y = state.angS;         // spiders spin only on a difference
    spiderGear2Group.rotation.y = -state.angS;
    const pinAngle = -state.angC * RING_PINION;
    pinionGroup.rotation.z = pinAngle;

    // Exploded view: slide the shafts and spiders apart so the meshing
    // faces inside the cage can be seen.
    const exp = state.exploded * 3.0;
    leftAxleGroup.position.x = -exp;
    rightAxleGroup.position.x = exp;
    pinionGroup.position.z = exp * 1.3;
    spiderGear1Group.position.y = 1.05 + exp * 0.7;
    spiderGear2Group.position.y = -(1.05 + exp * 0.7);

    if (state.vectors) {                    // each ring turns with its own shaft
        arrowPinion.rotation.z = pinAngle;
        arrowPinion.position.z = 3.2 + exp * 1.3;
        arrowCarrier.rotation.x = state.angC;
        arrowLeftAxle.rotation.x = state.angL;
        arrowLeftAxle.position.x = -5.0 - exp;
        arrowRightAxle.rotation.x = state.angR;
        arrowRightAxle.position.x = 5.0 + exp;
    }
    renderer.render(scene, camera);
}

// =============================================================
//  Panels outside the canvas
// =============================================================
function updateStats() {
    const l = RPM(state.wL).toFixed(0), r = RPM(state.wR).toFixed(0), c = RPM(state.wc).toFixed(0);
    $('stat-l').textContent = l;
    $('stat-r').textContent = r;
    $('stat-c').textContent = c;
    $('rl-l').textContent = l; $('rl-r').textContent = r; $('rl-c').textContent = c;
}

// =============================================================
//  Loop
// =============================================================
const DT = 1 / 240;
// At road speed the side gears turn about four times a second, which is
// far too quick to follow. Slow motion scales the whole simulation — car,
// wheels and gears together — so the speeds still agree with each other.
const SLOW = 0.14;
let acc = 0, last = performance.now();
function frame(now) {
    const real = Math.min((now - last) / 1000, 0.05); last = now;
    acc += real * (state.slowMo ? SLOW : 1);
    let guard = 0;
    while (acc >= DT && guard++ < 600) { step(DT); acc -= DT; }
    updateStats(); soundUpdate(); draw(); update3D();
    requestAnimationFrame(frame);
}

// =============================================================
//  Controls
// =============================================================
$('s-steer').addEventListener('input', e => {
    P.steer = parseFloat(e.target.value);
    $('v-steer').textContent = P.steer.toFixed(0);
    recompute(0);
});

function paintToggle(btn, on) {
    const yes = ['bg-slate-900', 'text-white', 'border-slate-900'];
    const no = ['bg-white', 'text-slate-900', 'border-slate-200', 'hover:bg-slate-50'];
    yes.forEach(c => btn.classList.toggle(c, on));
    no.forEach(c => btn.classList.toggle(c, !on));
}
function paintDrive() {
    paintToggle($('btn-drive'), state.drive);
    $('drive-label').textContent = state.drive ? 'Stop Driving' : 'Start Driving';
}
function paintIce() {
    paintToggle($('btn-ice'), state.ice);
    $('ice-label').textContent = state.ice ? 'Back on Dry Road' : 'Left Wheel on Ice';
}

$('btn-drive').addEventListener('click', () => {
    state.drive = !state.drive;
    state.drive ? soundStart() : soundStop();
    paintDrive(); recompute(0);
});
function paintHold() {
    paintToggle($('btn-hold-l'), state.holdL);
    paintToggle($('btn-hold-r'), state.holdR);
}
function hold(which) {
    const on = which === 'L' ? !state.holdL : !state.holdR;
    state.holdL = which === 'L' && on;
    state.holdR = which === 'R' && on;   // only one can be held at a time
    state.slip = 0;
    paintHold(); recompute(0);
}
$('btn-hold-l').addEventListener('click', () => hold('L'));
$('btn-hold-r').addEventListener('click', () => hold('R'));

$('s-exploded').addEventListener('input', e => {
    state.exploded = parseFloat(e.target.value) / 100;
    $('v-exploded').textContent = e.target.value + '%';
});

const CAMS = {
    cad:   () => moveCamera(-8.5, 6.2, 14.5),
    iso:   () => moveCamera(12, 9, 16),
    front: () => moveCamera(0, 0, 20),
    top:   () => moveCamera(0, 22, 0.1)
};
document.querySelectorAll('.cam').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.cam').forEach(o => o.classList.toggle('on', o === b));
    if (three3DReady) CAMS[b.dataset.cam]();
}));

$('btn-ice').addEventListener('click', () => {
    state.ice = !state.ice;
    if (!state.ice) state.slip = 0;
    paintIce(); recompute(0);
});
$('btn-reset').addEventListener('click', () => {
    soundStop();
    P.steer = 0;
    $('s-steer').value = 0; $('v-steer').textContent = '0';
    state.exploded = 0;
    $('s-exploded').value = 0; $('v-exploded').textContent = '0%';
    reset();
});

function paintChip(chip, on) {
    ['bg-white', 'hover:bg-slate-50', 'text-slate-900', 'border-slate-200']
        .forEach(c => chip.classList.toggle(c, on));
    ['bg-slate-100', 'hover:bg-slate-200', 'text-slate-400', 'border-slate-200']
        .forEach(c => chip.classList.toggle(c, !on));
}
function bindChip(chk, chip, key, after) {
    $(chk).addEventListener('change', e => {
        state[key] = e.target.checked;
        paintChip($(chip), e.target.checked);
        if (after) after(e.target.checked);
    });
}
bindChip('chk-slow', 'chip-slow', 'slowMo');
bindChip('chk-sound', 'chip-sound', 'sound', on => on ? soundResume() : soundStop());
bindChip('chk-vectors', 'chip-vectors', 'vectors', on => {
    if (three3DReady) vectorArrowsGroup.visible = on;
});
$('chk-view-mode').addEventListener('change', e => {
    const dark = e.target.checked;
    state.viewMode = dark ? 'blueprint' : 'light';
    $('txt-view-mode').textContent = dark ? 'Light Mode' : 'Dark Mode';
    // (the rule box sits on the control bar, which stays light in either mode)
    if (three3DReady) {
        scene.background = new THREE.Color(dark ? 0x0f172a : 0xdbe0e6);
        scene.fog = new THREE.FogExp2(dark ? 0x0f172a : 0xdbe0e6, 0.012);
        studioFloorMesh.material.color.set(dark ? 0x1e293b : 0xe2e8f0);
        gridHelper.visible = dark;
    }
    paintChip($('chip-view-mode'), dark);
});

const infoModal = $('info-modal');
$('btn-info').addEventListener('click', () => infoModal.classList.remove('hidden'));
$('info-close').addEventListener('click', () => infoModal.classList.add('hidden'));
$('info-backdrop').addEventListener('click', () => infoModal.classList.add('hidden'));
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !infoModal.classList.contains('hidden')) infoModal.classList.add('hidden');
});

// ---- launch ----
function hideLoader() {
    const el = document.getElementById('loader');
    if (el) el.classList.add('gone');
}
setTimeout(hideLoader, 8000);        // never trap the page behind the veil

window.onload = function () {
    reset();
    resizeCanvas();
    init3D();
    requestAnimationFrame(frame);
    // reveal on the next painted frame, with a timeout backstop in case
    // rAF is throttled or the tab is not visible
    requestAnimationFrame(hideLoader);
    setTimeout(hideLoader, 400);
};
