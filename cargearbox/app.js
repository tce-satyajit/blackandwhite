// =============================================================
//  Car Gearbox — model
// =============================================================
const G = 9.81;

// Gearbox ratios as specified. Each feeds a fixed final drive at the
// axle, exactly as a real manual car does. The chain the students read
// uses the TOTAL ratio (gearbox × final drive), because that is the
// number that actually multiplies the engine's torque at the wheel.
const GEARS = [
    { name: '1st', ratio: 4.00 },
    { name: '2nd', ratio: 2.50 },
    { name: '3rd', ratio: 1.50 },
    { name: '4th', ratio: 1.00 },
    { name: '5th', ratio: 0.80 }
];
const FINAL = 3.70;        // final drive at the axle
const ETA = 0.90;          // drivetrain efficiency
const CRR = 0.015;         // rolling resistance coefficient
const BRAKE_A = 6.0;       // braking deceleration, m/s²

// Engine torque curve: a simple parabola, strongest in the mid range.
const T_PEAK = 200, RPM_PEAK = 3500, RPM_SPAN = 2500, T_DROP = 0.45;
// The drivetrain is locked together, so the engine speed is not something
// the driver picks — it is whatever the road speed and the chosen gear make
// it. Below idle the clutch is slipping (pulling away); at the red line the
// engine can rev no higher, which is what forces a change up.
const IDLE = 800, REDLINE = 6000;
function rpmNow() {
    if (!state.engineOn) return 0;
    const wheelRevsPerSec = state.v / (2 * Math.PI * P.wheelR);
    return Math.max(IDLE, Math.min(REDLINE, wheelRevsPerSec * 60 * totalRatio()));
}
const engineTorque = rpm => {
    const u = (rpm - RPM_PEAK) / RPM_SPAN;
    return T_PEAK * (1 - T_DROP * u * u);
};

const DEFAULTS = { mass: 1200, wheelR: 0.32, slope: 0 };
const P = Object.assign({}, DEFAULTS);

const state = {
    gear: 0, v: 0, dist: 0, t: 0,
    engineOn: false, accel: false, brake: false,
    a: 0, Te: 0, Tw: 0, Fd: 0, Fnet: 0, atLimit: false,
    wheelAng: 0, inAng: 0,
    hist: [], sample: 0,
    viewMode: 'light', sound: true,
    bodyLift: 0, bodyPitch: 0,
    done: [false, false, false, false, false],
    seenTorque: {}, shiftWatch: null
};

const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');
const $ = id => document.getElementById(id);

// ---- Text size on the canvas -------------------------------
// Every label painted on the canvas is sized through FS; panels and
// boxes scale with it so the type never outgrows its container.
const FS = 1.15;
const fInter = (px, w) => `${w ? w + ' ' : ''}${(px * FS).toFixed(2)}px Inter, sans-serif`;
const fMono = (px, w) => `${w ? w + ' ' : ''}${(px * FS).toFixed(2)}px JetBrains Mono, monospace`;

// ---- derived quantities ------------------------------------
const totalRatio = () => GEARS[state.gear].ratio * FINAL;
const theta = () => P.slope * Math.PI / 180;
// The speed this engine speed and gear can actually turn the wheels at.
// road speed at which this gear reaches the red line
const redlineSpeed = () => (REDLINE / totalRatio()) * (2 * Math.PI / 60) * P.wheelR;

// =============================================================
//  Simulation
// =============================================================
// ---- Engine sound ----------------------------------------------
// Two clips: the starter cranking, then the engine running. Measured from
// the files — the crank is done by about 1.4 s, and the run clip has a
// stretch between 8.20 s and 14.30 s whose ends match to within 0.2%, so
// it loops there without an audible seam.
//
// <audio> elements rather than the Web Audio API on purpose: these pages
// are opened straight off the disk, where fetch() and decodeAudioData are
// refused by CORS and would leave the car silent.
const SND_CATCH = 1.40;                 // the engine has caught by here
const RUN_A = 8.20, RUN_B = 14.30;      // the seamless stretch of the run clip
// volume is capped at 1.0 by the media element, so these sit as high as
// the platform allows: the starter at the ceiling, the run loop just under
// it once the revs are up.
const RUN_VOL = 0.82, START_VOL = 1.0;

const sndStart = new Audio();
sndStart.preload = 'auto'; sndStart.src = 'vendor/audio/car-start-audio.mp3'; sndStart.load();
const sndRun = new Audio();
sndRun.preload = 'auto'; sndRun.src = 'vendor/audio/car-run-audio.mp3';
sndRun.preservesPitch = false;          // revs should change pitch, not tempo
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
        if (!state.engineOn || !state.sound) return;
        runFading = false;
        sndRun.currentTime = RUN_A; sndRun.volume = RUN_VOL;
        sndRun.play().catch(() => {});
        fadeOut(sndStart, 400);          // hand over as the crank dies away
    }, SND_CATCH * 1000);
}

// A real engine does not go silent the instant the key turns: it spins
// down over a second or so, dropping in pitch as it dies. Fading the level
// alone sounded like the sound was cut off, so the rate falls with it.
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
        sndRun.playbackRate = Math.max(0.30, r0 - (r0 - 0.30) * f);   // dying away
        if (n >= steps) {
            clearInterval(spinHandle); spinHandle = null;
            sndRun.pause(); sndRun.playbackRate = 1; runFading = false;
        }
    }, ms / steps);
}

// Turning the sound back on while the engine is already running should
// pick the engine up where it is — not replay the starter, and not leave
// the car silent for the rest of the session.
function soundResume() {
    if (!state.sound || !state.engineOn) return;
    clearTimeout(catchTimer);
    clearInterval(spinHandle); spinHandle = null;
    runFading = false;
    sndRun.currentTime = RUN_A;
    sndRun.volume = RUN_VOL;
    sndRun.playbackRate = 1;
    sndRun.play().catch(() => {});
}

// Pitch and loudness follow the revs, so the ear hears the gearbox working.
function soundUpdate() {
    if (!state.engineOn || sndRun.paused || runFading) return;
    const f = Math.max(0, Math.min(1, (rpmNow() - IDLE) / (REDLINE - IDLE)));
    sndRun.playbackRate = 0.78 + 0.85 * f;
    sndRun.volume = RUN_VOL * (0.72 + 0.28 * f);
    if (sndRun.currentTime >= RUN_B) sndRun.currentTime = RUN_A;
}

function reset() {
    state.v = 0; state.dist = 0; state.t = 0;
    state.a = 0; state.Fnet = 0; state.atLimit = false;
    state.wheelAng = 0; state.inAng = 0;
    state.hist = []; state.sample = 0;
    state.gear = 0;
    state.engineOn = false; state.accel = false; state.brake = false;
    state.bodyLift = 0; state.bodyPitch = 0;
    state.done = [false, false, false, false, false];
    state.seenTorque = {}; state.shiftWatch = null;
    paintGears(); paintButtons(); paintEngine(); paintChallenges();
    recompute(0);
}

// The whole chain, in the order the students read it. Called every step
// so the displayed numbers are always the ones actually driving the car.
function recompute(dt) {
    const R = totalRatio(), th = theta(), m = P.mass, r = P.wheelR;

    state.Te = (state.engineOn && state.accel) ? engineTorque(rpmNow()) : 0;
    state.Tw = state.Te * R * ETA;
    state.Fd = state.Tw / r;

    // Resistances. Rolling and braking always oppose the motion; on a
    // standstill they cannot push the car backwards, so they are capped.
    const dir = state.v > 0.01 ? 1 : (state.v < -0.01 ? -1 : 0);
    const Froll = CRR * m * G * Math.cos(th) * dir;
    const Fslope = m * G * Math.sin(th);
    const Fbrake = state.brake ? BRAKE_A * m * dir : 0;

    let F = state.Fd - Froll - Fslope - Fbrake;

    // The engine cannot rev past the red line, so in each gear there is a
    // road speed it simply cannot exceed. That is the honest reason a driver
    // must change up, and it keeps the speed bounded without inventing an
    // air-resistance term.
    const vLim = state.engineOn ? redlineSpeed() : Infinity;

    const vPrev = state.v;
    let v = state.v + (F / m) * dt;
    state.atLimit = false;
    if (v > vLim) { v = vLim; state.atLimit = true; }
    if (state.brake && vPrev > 0 && v < 0) v = 0;         // brakes stop, not reverse
    if (v < 0 && Math.sin(th) <= 0) v = Math.max(v, -30); // rolling back down a hill

    state.v = v;
    // Report the acceleration that actually happened, so the number on
    // screen always agrees with the motion, limit or no limit.
    state.a = dt > 0 ? (v - vPrev) / dt : 0;
    state.Fnet = m * state.a;
    state.dist += v * dt;
}

function step(dt) {
    recompute(dt);
    state.t += dt;

    // wheels roll with the car; the gearbox input turns with the engine
    // ---- suspension ------------------------------------------
    // Very soft: a long, slow float from the road and a whisper of engine
    // tremble, both passed through a low-pass filter so nothing snaps when
    // a gear changes or the limiter cuts in. The earlier version ran at
    // 4-12 Hz, which read as a shiver rather than a ride.
    const moving = Math.min(1, state.v / 4);
    const target = (Math.sin(state.dist * 0.30) * 0.011
                  + Math.sin(state.dist * 0.53 + 1.1) * 0.005) * moving
                  + (state.engineOn ? Math.sin(state.t * 18) * 0.0012 : 0);
    const targetPitch = Math.max(-1, Math.min(1, state.a / 8)) * 0.013;
    state.bodyLift += (target - state.bodyLift) * Math.min(1, dt * 3.0);
    state.bodyPitch += (targetPitch - state.bodyPitch) * Math.min(1, dt * 2.2);

    state.wheelAng += (state.v / P.wheelR) * dt;
    if (state.engineOn) state.inAng += (rpmNow() * 2 * Math.PI / 60) * dt * 0.06;

    state.sample += dt;
    if (state.sample >= 0.05) {
        state.sample = 0;
        state.hist.push({ t: state.t, v: state.v * 3.6, rpm: rpmNow(), tw: state.Tw });
        if (state.hist.length > 700) state.hist.shift();
    }
    checkChallenges();
}

// =============================================================
//  Try This — detected from what the student actually does
// =============================================================
function checkChallenges() {
    // 1. compared the wheel torque of every gear at a steady throttle
    // Only counts as a fair comparison while the engine is still in its
    // strong range; at the red line a low gear is no longer the strongest.
    if (state.engineOn && state.accel && state.v * 3.6 < 40) state.seenTorque[state.gear] = true;
    if (Object.keys(state.seenTorque).length === 5) win(0, 'Challenge 1 — at the same road speed, the lower the gear the greater the wheel torque. 1st wins.');

    // 2. pulled away from rest in 1st
    if (state.gear === 0 && state.v > 3 && state.v < 12 && state.a > 0) win(1, 'Challenge 2 — 1st gear gets the car moving: most torque where it is needed.');

    // 3. cruising fast in a tall gear
    if (state.v * 3.6 > 100 && state.gear >= 3) win(2, 'Challenge 3 — a tall gear trades torque for speed. That is cruising.');

    // 4. still accelerating up a steep hill
    if (P.slope >= 10 && state.a > 0.05 && state.v > 1) win(3, 'Challenge 4 — up a 10° hill and still accelerating. A low gear beats gravity.');

    // 5. shifted up without the acceleration dropping to zero
    if (state.shiftWatch !== null) {
        if (state.a <= 0) state.shiftWatch = null;
        else if (state.t - state.shiftWatch > 1.2) { win(4, 'Challenge 5 — shifted up and never stopped accelerating.'); state.shiftWatch = null; }
    }
}
function win(i, msg) {
    if (state.done[i]) return;
    state.done[i] = true;
    paintChallenges();
    toast(msg);
}
let toastTimer = null;
function toast(msg) {
    $('toast-text').textContent = msg;
    $('toast').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4200);
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
//  Canvas sizing
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

// =============================================================
//  Drawing
// =============================================================
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
        road: '#000000', mark: '#e2e8f0', dial: '#1e3a5f'
    } : {
        line: '#1e293b', soft: '#94a3b8', fill: '#ffffff', alt: '#f1f5f9',
        body: '#e8eaed', accent: '#0284c7', bg: '#f8fafc', hud: 'rgba(255,255,255,.94)',
        road: '#17191c', mark: '#f8fafc', dial: '#bfe3f7'
    };

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, W, H);

    // ---- layout ----
    const lowH = Math.min(196 * FS, H * 0.38);   // lower band: dashboard
    const lowTop = H - lowH - 8;
    const roadH = lowTop - 6;                    // upper band: road and car

    // With the readout column gone the road and the dashboard have the
    // whole width to themselves.
    drawRoadAndCar(W, roadH, T, 0);
    drawDash(13, lowTop, W - 26, lowH, T);   // inset equally, so the band is centred
}

// ---- the road, the hill and the car -------------------------
function drawRoadAndCar(W, bandH, T, rightGap) {
    const th = theta();
    const cx = Math.min(W - rightGap - 40, W * 0.5);
    const cy = bandH * 0.82;      // sits the road low, so the tarmac is a strip not a slab
    // The whole car is drawn to the size of its wheels, so the slider
    // changes the machine rather than just the tyres. Bounded by the width
    // beside the readouts and by the sky above the road, so the biggest
    // wheel setting still fits the band.
    const k = P.wheelR / 0.32;                    // 0.32 m is the standard wheel
    // The explanation panel that used to sit up here is gone, so the whole
    // sky above the road belongs to the car. Only a small margin is kept.
    const topRoom = cy - 18;
    const scale = Math.min(116 * k, (W - rightGap - 80) / 5.6, topRoom / 1.52);

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, bandH); ctx.clip();   // keep the tarmac in its band
    ctx.translate(cx, cy);
    ctx.rotate(-th);                              // uphill climbs to the right

    // road surface
    const far = W + bandH;
    ctx.fillStyle = T.road;
    ctx.fillRect(-far, 0, far * 2, bandH * 2);
    ctx.strokeStyle = T.line; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(-far, 0); ctx.lineTo(far, 0); ctx.stroke();

    // lane dashes scroll with the distance travelled
    ctx.strokeStyle = T.mark; ctx.lineWidth = 4;
    ctx.setLineDash([34, 26]);
    ctx.lineDashOffset = -(state.dist * scale) % 60;
    ctx.beginPath();
    ctx.moveTo(-far, 26); ctx.lineTo(far, 26); ctx.stroke();
    ctx.setLineDash([]);

    drawCar(0, 0, scale, T);
    ctx.restore();

    // slope call-out, drawn upright so it stays readable
    if (Math.abs(P.slope) > 0.5) {
        ctx.fillStyle = T.soft; ctx.font = fInter(11, 600); ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const gy = cy + 46, gx0 = 16;
        ctx.strokeStyle = T.soft; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(gx0, gy); ctx.lineTo(gx0 + 92, gy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(gx0, gy);
        ctx.lineTo(gx0 + 92, gy - 92 * Math.tan(th)); ctx.stroke();
        ctx.fillText(`${P.slope > 0 ? 'uphill' : 'downhill'}  θ = ${Math.abs(P.slope)}°`, gx0 + 100, gy - 26);
        ctx.fillText(`gravity along road  ${Math.abs(P.mass * G * Math.sin(th)).toFixed(0)} N`,
            gx0 + 100, gy - 11);
    }

}

// A four-door saloon in profile, drawn from a line-art reference: bonnet,
// screen, roof, boot, wheel arches, doors and alloys. Everything is given
// in metres from the centre of the car at road level, so the wheel-radius
// slider can move the arches without the body changing shape.
function drawCar(x, y, s, T) {
    const WHEEL = 0.32, ARCH = 0.45;         // fixed proportions: the whole
    const wr = WHEEL * s;                    // car is scaled by the slider
    const wb = 2.70 * s;                     // wheelbase
    const M = (xm, hm) => [xm * s, -hm * s]; // metres → local canvas, h up
    const to = p => ctx.lineTo(p[0], p[1]);
    const cv = (c, p) => ctx.quadraticCurveTo(c[0], c[1], p[0], p[1]);

    const sill = 0.30;                       // underside of the door sill
    const archR = ARCH;                      // arch clears the tyre by a fixed margin
    const fx = -1.35, rx = 1.35;             // wheel stations

    ctx.save();
    ctx.translate(x, y);

    // ---- suspension ------------------------------------------
    // The wheels stay planted and the body rides above them: a little bob
    // from the road surface, a faint shake from the running engine, and
    // squat under power / dive under braking. All small — a couple of
    // millimetres of travel and under a degree of pitch.
    ctx.save();
    ctx.translate(0, -state.bodyLift * s);
    ctx.translate(0, -0.60 * s); ctx.rotate(state.bodyPitch); ctx.translate(0, 0.60 * s);

    // ---- body outline ----
    ctx.beginPath();
    ctx.moveTo(...M(-2.30, 0.40));
    cv(M(-2.34, 0.58), M(-2.30, 0.76));              // front bumper nose
    cv(M(-2.24, 0.88), M(-2.02, 0.92));              // over the headlight
    cv(M(-1.60, 0.97), M(-1.10, 1.02));              // bonnet
    to(M(-0.94, 1.05));                              // scuttle
    cv(M(-0.60, 1.30), M(-0.24, 1.45));              // windscreen
    cv(M(-0.05, 1.485), M(0.30, 1.487));             // roof front
    to(M(0.72, 1.47));                               // roof rear
    cv(M(1.05, 1.44), M(1.55, 1.13));                // rear screen
    to(M(1.78, 1.08));                               // boot lid
    cv(M(2.16, 1.04), M(2.28, 0.94));                // boot rear edge
    cv(M(2.34, 0.78), M(2.31, 0.58));                // tail
    cv(M(2.29, 0.44), M(2.20, 0.38));                // rear bumper
    // underside, running back to front, lifting over each arch
    to(M(rx + archR, sill));
    ctx.arc(rx * s, -sill * s, archR * s, 0, Math.PI, true);
    to(M(fx + archR, sill));
    ctx.arc(fx * s, -sill * s, archR * s, 0, Math.PI, true);
    to(M(-2.22, sill + 0.04));
    cv(M(-2.30, 0.34), M(-2.30, 0.40));
    ctx.closePath();
    ctx.fillStyle = T.body; ctx.strokeStyle = T.line; ctx.lineWidth = 2.4;
    ctx.fill(); ctx.stroke();

    // ---- glass ----
    ctx.strokeStyle = T.soft; ctx.lineWidth = 1.5;
    const belt = 1.06;
    ctx.beginPath();                                  // windscreen
    ctx.moveTo(...M(-0.86, belt));
    cv(M(-0.56, 1.28), M(-0.26, 1.40));
    to(M(-0.10, 1.40)); to(M(-0.30, belt));
    ctx.closePath(); ctx.stroke();
    ctx.beginPath();                                  // front door glass
    ctx.moveTo(...M(-0.22, belt)); to(M(-0.02, 1.41));
    to(M(0.52, 1.41)); to(M(0.52, belt));
    ctx.closePath(); ctx.stroke();
    ctx.beginPath();                                  // rear door glass
    ctx.moveTo(...M(0.60, belt)); to(M(0.60, 1.41));
    to(M(1.12, 1.40)); to(M(1.08, belt));
    ctx.closePath(); ctx.stroke();
    ctx.beginPath();                                  // rear quarter light
    ctx.moveTo(...M(1.16, belt)); to(M(1.20, 1.39));
    cv(M(1.34, 1.30), M(1.46, 1.16));
    ctx.closePath(); ctx.stroke();

    // ---- doors, handles and the rocker crease ----
    ctx.lineWidth = 1.3;
    [[-0.26, 0.34], [0.56, 0.34]].forEach(([dx, base]) => {
        ctx.beginPath();
        ctx.moveTo(...M(dx, belt)); to(M(dx, base));
        ctx.stroke();
    });
    ctx.beginPath();                                  // shut line at the rear door
    ctx.moveTo(...M(1.14, belt)); to(M(1.14, 0.40)); ctx.stroke();
    ctx.lineWidth = 2;
    [[0.10, 0.86], [0.92, 0.86]].forEach(([hx, hy]) => {
        ctx.beginPath();
        ctx.moveTo(...M(hx, hy)); to(M(hx + 0.22, hy)); ctx.stroke();
    });
    ctx.lineWidth = 1.3;
    ctx.beginPath();                                  // body crease
    ctx.moveTo(...M(-1.90, 0.80)); to(M(1.95, 0.86)); ctx.stroke();
    ctx.beginPath();                                  // sill line
    ctx.moveTo(...M(-0.80, 0.40)); to(M(0.80, 0.40)); ctx.stroke();

    // ---- lamps ----
    ctx.lineWidth = 1.5;
    ctx.beginPath();                                  // headlight
    ctx.moveTo(...M(-2.26, 0.84));
    cv(M(-2.05, 0.90), M(-1.86, 0.86));
    cv(M(-2.02, 0.76), M(-2.26, 0.74));
    ctx.closePath(); ctx.stroke();
    ctx.beginPath();                                  // tail lamp
    ctx.moveTo(...M(2.28, 0.90)); to(M(2.02, 0.86));
    to(M(2.04, 0.70)); to(M(2.29, 0.68));
    ctx.closePath(); ctx.stroke();

    ctx.restore();      // back to the road frame — the wheels do not bob

    // ---- wheels: tyre, rim and five spokes ----
    [fx, rx].forEach((cxm, i) => {
        const wx = cxm * s, wy = -wr;
        ctx.fillStyle = T.fill; ctx.strokeStyle = T.line; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.arc(wx, wy, wr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(wx, wy, wr * 0.70, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 2.2;
        for (let k = 0; k < 5; k++) {
            const a2 = -state.wheelAng + k * Math.PI * 2 / 5;
            ctx.beginPath();
            ctx.moveTo(wx + Math.cos(a2) * wr * 0.20, wy + Math.sin(a2) * wr * 0.20);
            ctx.lineTo(wx + Math.cos(a2) * wr * 0.64, wy + Math.sin(a2) * wr * 0.64);
            ctx.stroke();
        }
        ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.arc(wx, wy, wr * 0.20, 0, Math.PI * 2); ctx.stroke();
        if (i === 1) {                       // mark the driven wheel
            ctx.fillStyle = T.accent; ctx.font = fInter(8, 700); ctx.textAlign = 'center';
            ctx.fillText('DRIVEN', wx, wy - wr - 8);
        }
    });

    // ---- engine and gearbox, shown through a cutaway ----
    const eY = -0.62 * s;
    ctx.strokeStyle = T.accent; ctx.lineWidth = 1.6; ctx.setLineDash([3, 3]);
    rr(-2.00 * s, eY - 0.26 * s, 0.78 * s, 0.54 * s, 4); ctx.stroke();
    rr(-1.10 * s, eY - 0.22 * s, 0.70 * s, 0.46 * s, 4); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = T.soft; ctx.font = fInter(8, 700);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('ENGINE', -1.61 * s, eY - 0.36 * s);
    ctx.fillText('GEARBOX', -0.75 * s, eY - 0.32 * s);

    const cr = 0.16 * s;                              // crank, so the engine reads as running
    ctx.strokeStyle = T.line; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(-1.61 * s, eY, cr, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-1.61 * s, eY);
    ctx.lineTo(-1.61 * s + Math.cos(state.inAng) * cr, eY + Math.sin(state.inAng) * cr);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();                                  // propshaft to the driven wheel
    ctx.moveTo(-0.40 * s, eY); ctx.lineTo(rx * s, eY); ctx.stroke();

    // ---- driving force at the contact patch ----
    if (state.accel && state.Fd > 1) {
        const len = Math.min(90, 14 + state.Fd / 90);
        ctx.strokeStyle = T.accent; ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.moveTo(rx * s, 6); ctx.lineTo(rx * s - len, 6); ctx.stroke();
        head(rx * s - len, 6, Math.PI, 8);
        ctx.fillStyle = T.accent; ctx.font = fInter(9, 700); ctx.textAlign = 'right';
        ctx.fillText(`${(state.Fd / 1000).toFixed(1)} kN`, rx * s - 6, 18);
    }
    ctx.restore();
}

// ---- the dashboard: two dials and the pair of gears ---------
// A car's own instruments are the most familiar way in: students read a
// rev counter and a speedometer before they read any table of numbers.
// ---- the instrument cluster -------------------------------
// Laid out the way a real binnacle is: rev counter on the left, speedo on
// the right, and a small info screen between them carrying the gear. The
// housing is dark whatever the page theme, because that is what makes it
// read as a dashboard rather than three drawings on a background.
const DASH = {
    case: '#161c26', bezel: '#2c3542', face: '#0b0f15', rim: '#3d4757',
    tick: '#8b97a8', num: '#dbe3ec', lit: '#38bdf8', red: '#ef4444',
    screen: '#0e141c', screenEdge: '#313d4d'
};

function drawDash(x, y, w, h, T) {
    const pad = 8;
    const bx = x + pad, by = y + pad, bw = w - pad * 2, bh = h - pad * 2;

    ctx.save();
    // binnacle
    ctx.fillStyle = DASH.case;
    rr(bx, by, bw, bh, 16); ctx.fill();
    ctx.strokeStyle = DASH.bezel; ctx.lineWidth = 2;
    rr(bx + 1.5, by + 1.5, bw - 3, bh - 3, 15); ctx.stroke();

    const cy = by + bh * 0.50;
    const dialR = Math.min(bh * 0.40, 88 * FS);
    const scrW = Math.min(bw * 0.24, 230 * FS);

    drawDial(bx + bw * 0.24, cy, dialR, rpmNow(), 6000, 'RPM',
             rpmNow().toFixed(0), 4800);                     // red zone from 4800
    drawDial(bx + bw * 0.76, cy, dialR, state.v * 3.6, 240, 'km/h',
             (state.v * 3.6).toFixed(0), null);
    drawScreen(bx + bw * 0.5 - scrW / 2, by + bh * 0.14, scrW, bh * 0.72);
    ctx.restore();
}

// ---- one instrument -----------------------------------------
function drawDial(cx, cy, r, value, max, unit, readout, redFrom) {
    const A0 = Math.PI * 0.75, SWEEP = Math.PI * 1.5;
    const frac = Math.max(0, Math.min(1, value / max));
    const at = (a, rr2) => [cx + Math.cos(a) * rr2, cy + Math.sin(a) * rr2];

    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    // recessed face with a machined bezel
    ctx.fillStyle = DASH.bezel;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.06, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = DASH.face;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = DASH.rim; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();

    // the sweep so far, and the red zone on the tacho
    ctx.lineCap = 'butt';
    ctx.strokeStyle = '#1d2733'; ctx.lineWidth = r * 0.10;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, A0, A0 + SWEEP); ctx.stroke();
    if (redFrom !== null) {
        const f0 = redFrom / max;
        ctx.strokeStyle = DASH.red;
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, A0 + SWEEP * f0, A0 + SWEEP); ctx.stroke();
    }
    ctx.strokeStyle = DASH.lit;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, A0, A0 + SWEEP * frac); ctx.stroke();
    ctx.lineCap = 'round';

    // graduations: every sixth is major and carries a number
    for (let i = 0; i <= 12; i++) {
        const f = i / 12, a = A0 + SWEEP * f, major = i % 2 === 0;
        const p1 = at(a, r * (major ? 0.60 : 0.68)), p2 = at(a, r * 0.76);
        ctx.strokeStyle = (redFrom !== null && value / max >= 0 && f >= redFrom / max) ? DASH.red : DASH.tick;
        ctx.lineWidth = major ? 2.4 : 1.3;
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
        if (major) {
            const t = at(a, r * 0.46);
            ctx.fillStyle = DASH.num; ctx.font = fInter(9.5, 600);
            ctx.fillText(String(Math.round(max * f)), t[0], t[1]);
        }
    }

    // needle, weighted like a real pointer, over a hub
    const a = A0 + SWEEP * frac;
    const tip = r * 0.74, back = r * 0.16, wdt = r * 0.055;
    ctx.fillStyle = DASH.red;
    ctx.beginPath();
    ctx.moveTo(...at(a, tip));
    ctx.lineTo(...at(a + Math.PI / 2, wdt));
    ctx.lineTo(...at(a + Math.PI, back));
    ctx.lineTo(...at(a - Math.PI / 2, wdt));
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = DASH.bezel;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.11, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = DASH.rim; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.11, 0, Math.PI * 2); ctx.stroke();

    // unit above the hub, digital readout below it
    ctx.fillStyle = DASH.tick; ctx.font = fInter(10, 700);
    ctx.fillText(unit, cx, cy - r * 0.34);
    ctx.fillStyle = DASH.num; ctx.font = fMono(17, 700);
    ctx.fillText(readout, cx, cy + r * 0.44);
    ctx.restore();
}

// ---- the info screen between the dials ----------------------
function drawScreen(x, y, w, h) {
    ctx.save();
    ctx.fillStyle = DASH.screen;
    rr(x, y, w, h, 10); ctx.fill();
    ctx.strokeStyle = DASH.screenEdge; ctx.lineWidth = 1.6;
    rr(x, y, w, h, 10); ctx.stroke();

    const cx = x + w / 2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = DASH.tick; ctx.font = fInter(9, 700);
    ctx.fillText('GEAR', cx, y + 13 * FS);
    ctx.fillStyle = DASH.lit; ctx.font = fMono(30, 700);
    ctx.fillText(String(state.gear + 1), cx, y + 38 * FS);
    ctx.fillStyle = DASH.num; ctx.font = fMono(11, 700);
    ctx.fillText(`${GEARS[state.gear].ratio.toFixed(2)} : 1`, cx, y + 60 * FS);

    // the pair of gears that ratio stands for, animated
    drawGearPair(x, y + 66 * FS, w, h - 70 * FS);
    ctx.restore();
}

// ---- input gear driving output gear -------------------------
function drawGearPair(x, y, w, h) {
    if (w < 90 || h < 40) return;
    const R = GEARS[state.gear].ratio;
    const C = Math.min(w * 0.34, h * 0.44);
    const rIn = C / (1 + R), rOut = C * R / (1 + R);
    const module = 2 * C / 34;
    const nIn = Math.max(6, Math.round(2 * rIn / module));
    const nOut = Math.max(6, Math.round(2 * rOut / module));
    const cyy = y + h * 0.46;
    const cxA = x + w * 0.5 - C / 2, cxB = cxA + C;

    const angIn = state.inAng;
    const angOut = (Math.PI - Math.PI / nOut) - angIn * (nIn / nOut);
    gear(cxA, cyy, rIn, nIn, angIn, null, DASH.lit);
    gear(cxB, cyy, rOut, nOut, angOut, null, DASH.num);

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = DASH.tick; ctx.font = fInter(8.5);
    ctx.fillText(`${nIn}T → ${nOut}T`, x + w * 0.5, y + h - 6 * FS);
}

function gear(cx, cy, r, n, ang, T, stroke) {
    const faceFill = T ? T.fill : DASH.face;
    const rt = r * 1.14, rr2 = r * 0.86;      // tip and root radii
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
        const a0 = ang + (i * 2 * Math.PI) / n;
        const step = (2 * Math.PI) / n / 4;
        if (i === 0) ctx.moveTo(cx + Math.cos(a0 - step) * rr2, cy + Math.sin(a0 - step) * rr2);
        else ctx.lineTo(cx + Math.cos(a0 - step) * rr2, cy + Math.sin(a0 - step) * rr2);
        ctx.lineTo(cx + Math.cos(a0 - step * 0.5) * rt, cy + Math.sin(a0 - step * 0.5) * rt);
        ctx.lineTo(cx + Math.cos(a0 + step * 0.5) * rt, cy + Math.sin(a0 + step * 0.5) * rt);
        ctx.lineTo(cx + Math.cos(a0 + step) * rr2, cy + Math.sin(a0 + step) * rr2);
        ctx.arc(cx, cy, rr2, a0 + step, a0 + 3 * step);
    }
    ctx.closePath();
    ctx.fillStyle = faceFill; ctx.strokeStyle = stroke; ctx.lineWidth = 1.8;
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.20, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * r * 0.80, cy + Math.sin(ang) * r * 0.80);
    ctx.stroke();
    ctx.restore();
}

// =============================================================
//  Panels outside the canvas
// =============================================================
function updateStats() {
    $('stat-v').textContent = (state.v * 3.6).toFixed(0);
    $('stat-gear').textContent = GEARS[state.gear].name;
    $('stat-a').textContent = state.a.toFixed(1);
}

// =============================================================
//  Loop
// =============================================================
const DT = 1 / 240;
let acc = 0, last = performance.now();
function frame(now) {
    const real = Math.min((now - last) / 1000, 0.05); last = now;
    acc += real;
    let guard = 0;
    while (acc >= DT && guard++ < 600) { step(DT); acc -= DT; }
    updateStats();
    soundUpdate();
    draw();
    requestAnimationFrame(frame);
}

// =============================================================
//  Controls
// =============================================================
function bindSlider(id, key, fmt) {
    const el = $(id);
    el.addEventListener('input', () => {
        P[key] = parseFloat(el.value);
        $(id.replace('s-', 'v-')).textContent = fmt(P[key]);
        recompute(0);
    });
}
bindSlider('s-mass', 'mass', v => v.toFixed(0));
bindSlider('s-wheel', 'wheelR', v => v.toFixed(2));
bindSlider('s-slope', 'slope', v => v.toFixed(0));

function paintGears() {
    document.querySelectorAll('.gseg').forEach(b =>
        b.classList.toggle('on', +b.dataset.gear === state.gear));
    $('gear-now').textContent = String(state.gear + 1);
}
function selectGear(i, viaShift) {
    const next = Math.max(0, Math.min(GEARS.length - 1, i));
    if (next === state.gear) return;
    const up = next > state.gear;
    state.gear = next;
    paintGears();
    recompute(0);
    // watch for challenge 5: shifted up and kept accelerating
    state.shiftWatch = (up && state.accel && state.a > 0) ? state.t : null;
}
document.querySelectorAll('.gseg').forEach(b =>
    b.addEventListener('click', () => selectGear(+b.dataset.gear)));
$('btn-up').addEventListener('click', () => selectGear(state.gear + 1, true));
$('btn-down').addEventListener('click', () => selectGear(state.gear - 1, true));

function paintButtons() {
    $('btn-accel').classList.toggle('pressed', state.accel);
    $('btn-brake').classList.toggle('pressed', state.brake);
}
function paintEngine() {
    $('btn-engine').classList.toggle('running', state.engineOn);
    $('engine-label').innerHTML = state.engineOn ? 'ENGINE<br>STOP' : 'ENGINE<br>START';
}
$('btn-engine').addEventListener('click', () => {
    state.engineOn = !state.engineOn;
    if (!state.engineOn) { state.accel = false; }   // key off cuts the drive
    state.engineOn ? soundStart() : soundStop();
    paintEngine(); paintButtons(); recompute(0);
});
$('btn-accel').addEventListener('click', () => {
    if (!state.engineOn) { toast('Start the engine first — press Start Engine.'); return; }
    state.accel = !state.accel;
    if (state.accel) state.brake = false;
    paintButtons(); recompute(0);
});
$('btn-brake').addEventListener('click', () => {
    state.brake = !state.brake;
    if (state.brake) state.accel = false;
    paintButtons(); recompute(0);
});
$('btn-reset').addEventListener('click', () => {
    soundStop();
    Object.assign(P, DEFAULTS);
    $('s-mass').value = DEFAULTS.mass; $('v-mass').textContent = DEFAULTS.mass;
    $('s-wheel').value = DEFAULTS.wheelR; $('v-wheel').textContent = DEFAULTS.wheelR.toFixed(2);
    $('s-slope').value = DEFAULTS.slope; $('v-slope').textContent = DEFAULTS.slope;
    reset();
    $('toast').classList.add('hidden');
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
bindChip('chk-sound', 'chip-sound', 'sound', on => on ? soundResume() : soundStop());
$('chk-view-mode').addEventListener('change', e => {
    const dark = e.target.checked;
    state.viewMode = dark ? 'blueprint' : 'light';
    $('txt-view-mode').textContent = dark ? 'Light Mode' : 'Dark Mode';
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
    requestAnimationFrame(frame);
    // reveal on the next painted frame, with a timeout backstop in case
    // rAF is throttled or the tab is not visible
    requestAnimationFrame(hideLoader);
    setTimeout(hideLoader, 400);
};


// =============================================================
//  Show and hide the control panel
// =============================================================
// The panel floats over the canvas, so this uncovers the drawing rather
// than resizing it - the canvas is always the full size of the window
// under the header.
//
// Two buttons, not one that moves. The hide button sits in the panel's
// own corner, so it travels with the panel and is gone the moment the
// panel is - which is exactly why it cannot also be the way back. The
// show button lives outside the panel and lands in the same spot, so
// toggling swaps one for the other without anything appearing to move.
(function () {
    const hide = document.getElementById('btn-hide');
    const show = document.getElementById('btn-show');
    if (!hide || !show) return;

    function setControls(off) {
        document.body.classList.toggle('controls-off', off);
        // A 2D canvas is sized from its box in device pixels, so it has
        // to be told when that box could have changed. Cheap, and it
        // keeps the drawing crisp if the layout ever does shift.
        if (typeof resizeCanvas === 'function') resizeCanvas();
    }
    hide.addEventListener('click', () => setControls(true));
    show.addEventListener('click', () => setControls(false));

    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        const modal = document.getElementById('info-modal');
        if (modal && !modal.classList.contains('hidden')) return;
        if (!document.body.classList.contains('controls-off')) setControls(true);
    });
})();
