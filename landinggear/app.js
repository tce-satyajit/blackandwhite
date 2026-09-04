// =============================================================
//  Aircraft landing gear
//  The gear is a linear spring and viscous damper in parallel.
//  Every number, arrow and graph point on screen comes from
//  integrating that model - nothing is animated independently.
// =============================================================
const G = 9.81;

const DEFAULTS = { m: 40000, sink: 2.0, k: 1.5e6, xMax: 0.5, zeta: 0.5, mu: 0.35 };
const P = Object.assign({ vFwd0: 72 }, DEFAULTS);

// Boeing 747 side profile, traced from a photograph: the sky was keyed out,
// the silhouette boundary walked, then smoothed and simplified to 44 points.
// Metres from the centre of mass; y is measured from the fuselage underside,
// so y = 0 is exactly where the gear strut attaches.
const PLANE = [[16.26,-7.81],[17.36,-7.74],[17.5,-7.6],[15.54,-3.69],[15.6,-3.52],[16.74,-3.13],[16.69,-3.0],[16.37,-2.73],[16.16,-2.28],[15.96,-2.1],[15.03,-1.85],[7.03,-0.25],[4.47,0.02],[0.36,0.02],[0.25,0.12],[0.26,0.32],[0.63,0.51],[0.73,0.69],[0.7,0.87],[0.53,0.94],[-14.27,0.91],[-14.53,0.5],[-14.25,0.12],[-14.29,-0.03],[-14.55,-0.11],[-14.75,-0.37],[-15.57,-0.58],[-16.68,-1.01],[-17.31,-1.43],[-17.5,-1.77],[-17.43,-2.06],[-17.08,-2.42],[-15.57,-3.36],[-14.98,-3.93],[-14.07,-4.21],[-11.26,-4.27],[-7.79,-4.05],[-3.83,-3.48],[7.44,-3.39],[9.12,-3.47],[9.7,-3.66],[15.18,-7.61],[15.65,-7.78],[16.24,-7.81]];

// ---- Text size on the canvas -------------------------------
// Every label painted on the canvas is sized through FS. Panel
// widths, row heights and badge circles scale with it too, so the
// boxes grow with the type instead of clipping it. 1 = as designed.
const FS = 1.15;
const fInter = (px, w) => `${w ? w + ' ' : ''}${(px * FS).toFixed(2)}px Inter, sans-serif`;
const fMono  = (px, w) => `${w ? w + ' ' : ''}${(px * FS).toFixed(2)}px JetBrains Mono, monospace`;

const GEO = {
    gearLen: 4.0,      // axle to body underside, fully extended (m)
    wheelR: 0.78,
    startH: 4.0,       // wheel height at the start of the approach (m)
    MAG: 3             // strut travel magnified on screen by this much
};

// A real aircraft lands on its main gear alone, held nose-up in the flare,
// and the nose wheel is flown down a couple of seconds later. The airframe
// pivots about the main-gear attachment, so that is the pivot used here.
const NOSE_WHEEL = 0.85;                 // nose tyre drawn slightly smaller, for depth
const BOGIE_LEVEL_T = 0.15;              // seconds for the bogie to level under load
const PITCH_FLARE = 7 * Math.PI / 180;   // nose-up attitude at touchdown
const DEROTATE = 2.0;                    // seconds from mains down to nose down

const state = {
    phase: 'ready',    // ready | approach | impact | rollout | stopped
    t: 0, h: GEO.startH, x: 0, v: 0,
    vFwd: 0, dist: 0, roll: 0, rollNose: 0, F: 0, a: 0,
    peakF: 0, peakX: 0, impactTime: null, impulse: 0,
    bottomed: false, settledFor: 0, hist: [], sample: 0,
    pitch: PITCH_FLARE, tDown: 0, bogieLevel: 0,
    paused: false, slowMo: false, sound: true,
    showLabels: true, showForces: true, showPhysics: true, showGraphs: true,
    viewMode: 'light', activePart: null, hoverPart: null
};
let lastRun = null;
let badgeHits = [];

const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');
const $ = id => document.getElementById(id);

const cOf = () => 2 * P.zeta * Math.sqrt(P.k * P.m);
const xEq = () => P.m * G / P.k;          // static squash under weight

// ---- Landing audio ---------------------------------------------
// The clip is a 14.2 s flyby: it swells as the aeroplane comes in, is
// loudest as it passes, then recedes down the runway. Rather than just
// playing it on LAND, it is started at whatever offset puts its loudest
// moment exactly on touchdown — so a slow 0.5 m/s descent hears the full
// approach and a fast 5 m/s one is dropped in near the end. Picture and
// sound then arrive together at every sink rate.
//
// Deliberately an <audio> element rather than the Web Audio API: these
// pages are meant to run straight off a memory stick, and fetch() plus
// decodeAudioData are refused on file:// URLs, which would leave the
// simulation silent exactly where it most needs to work.
const LANDING_URL = 'vendor/audio/landing.mp3';
const CLIP_PEAK = 7.5;         // seconds into the clip where it is overhead
const LANDING_GAIN = 0.6;
// The recording runs out long before a real rollout does, so once the
// aeroplane is down the rolling section is held under it. These two marks
// bound the steadiest stretch of that section — their levels match to
// within 0.2%, so the repeat is not audible as a seam. The 2 s of
// recorded decay after LOOP_B is saved to finish the landing naturally.
const LOOP_A = 10.7, LOOP_B = 12.2;

const landingAudio = new Audio();
landingAudio.preload = 'auto';
landingAudio.src = LANDING_URL;
landingAudio.volume = LANDING_GAIN;
landingAudio.preservesPitch = false;           // slow-mo should drop in pitch
landingAudio.load();
landingAudio.addEventListener('ended', () => { landingPlaying = false; });

let landingTimer = null, fadeTimer = null;
let landingDueAt = 0, landingRemain = null, landingPlaying = false;

function startClip(offset) {
    landingTimer = null;
    if (!state.sound) return;
    landingAudio.currentTime = Math.max(0, offset || 0);
    landingAudio.volume = LANDING_GAIN;
    landingPlaying = true;
    landingAudio.play().catch(() => {});       // LAND is the gesture that permits this
}

function stopLanding(fade) {
    clearTimeout(landingTimer); landingTimer = null;
    clearInterval(fadeTimer); fadeTimer = null;
    landingRemain = null; landingPlaying = false;
    if (landingAudio.paused) { landingAudio.volume = LANDING_GAIN; return; }
    if (!fade) {
        landingAudio.pause(); landingAudio.volume = LANDING_GAIN; return;
    }
    const dv = landingAudio.volume / 12;       // fade out rather than cut
    fadeTimer = setInterval(() => {
        landingAudio.volume = Math.max(0, landingAudio.volume - dv);
        if (landingAudio.volume <= 0.001) {
            clearInterval(fadeTimer); fadeTimer = null;
            landingAudio.pause(); landingAudio.volume = LANDING_GAIN;
        }
    }, 25);
}

function playLanding() {
    stopLanding(false);
    if (!state.sound) return;
    const rate = state.slowMo ? 0.15 : 1;      // sound slows with the picture
    const tApp = GEO.startH / P.sink;          // sim-seconds of descent still to come
    const lead = CLIP_PEAK - tApp;             // clip time to skip before starting
    landingAudio.playbackRate = rate;
    if (lead >= 0) {
        startClip(lead);                       // short approach: start part-way in
    } else {
        const delay = (-lead / rate) * 1000;   // long approach: hold the clip back
        landingDueAt = performance.now() + delay;
        landingTimer = setTimeout(() => startClip(0), delay);
    }
}

// Once the wheels are down the sound follows the aeroplane rather than the
// clock: volume and pitch both fall away with ground speed, and the rolling
// section repeats for as long as it takes to stop. The loop is released at
// the point where the recording's own fade-out will finish just as the
// aeroplane does, so it lands on silence instead of being cut off.
function updateLanding() {
    if (!landingPlaying) return;      // volume/rate stay correct even while paused
    const slow = state.slowMo ? 0.15 : 1;
    const rolling = state.phase === 'impact' || state.phase === 'rollout' || state.phase === 'stopped';
    if (!rolling) { landingAudio.playbackRate = slow; landingAudio.volume = LANDING_GAIN; return; }

    const sp = P.vFwd0 > 0 ? Math.max(0, Math.min(1, state.vFwd / P.vFwd0)) : 0;
    const rateBase = 0.55 + 0.45 * sp;              // spools down as it slows
    landingAudio.playbackRate = rateBase * slow;
    landingAudio.volume = LANDING_GAIN * (0.30 + 0.70 * sp);

    const dur = landingAudio.duration;
    if (!isFinite(dur)) return;
    const rollLeft = state.vFwd / Math.max(0.01, P.mu * G);   // seconds left to stop
    const tailLeft = (dur - LOOP_B) / rateBase;               // slow-mo cancels out
    if (landingAudio.currentTime >= LOOP_B && rollLeft > tailLeft) landingAudio.currentTime = LOOP_A;
}

// Pausing the simulation pauses the sound with it, including a clip that
// has been scheduled but has not begun.
function setLandingPaused(paused) {
    if (paused) {
        if (landingTimer) {
            clearTimeout(landingTimer); landingTimer = null;
            landingRemain = Math.max(0, landingDueAt - performance.now());
        }
        if (landingPlaying) landingAudio.pause();
    } else {
        if (landingRemain != null) {
            const d = landingRemain; landingRemain = null;
            landingDueAt = performance.now() + d;
            landingTimer = setTimeout(() => startClip(0), d);
        }
        if (landingPlaying) landingAudio.play().catch(() => {});
    }
}

// ---- Simulation ------------------------------------------------
function reset() {
    state.phase = 'ready';
    state.t = 0; state.h = GEO.startH; state.x = 0; state.v = 0;
    state.vFwd = P.vFwd0; state.dist = 0; state.roll = 0; state.rollNose = 0; state.F = 0; state.a = 0;
    state.peakF = 0; state.peakX = 0; state.impactTime = null; state.impulse = 0;
    state.bottomed = false; state.settledFor = 0; state.hist = []; state.sample = 0;
    state.pitch = PITCH_FLARE; state.tDown = 0; state.bogieLevel = 0;
    $('btn-land').disabled = false;
    stopLanding();
    updateStats();
}

function land() {
    if (state.phase !== 'ready') reset();
    playLanding();
    state.phase = 'approach';
    state.v = P.sink;
    state.vFwd = P.vFwd0;
    $('btn-land').disabled = true;
}

function step(dt) {
    // Attitude: held nose-up through the flare, then eased down onto the
    // nose gear once the main wheels are carrying the aeroplane.
    if (state.phase !== 'ready' && state.phase !== 'approach') {
        state.tDown += dt;
        // The bogie beam pivots on the leg. Airborne it hangs with the leg;
        // as it takes load it swings level with the runway, which is why the
        // aft wheels of a real 747 touch a moment before the forward ones.
        state.bogieLevel = Math.min(1, state.bogieLevel + dt / BOGIE_LEVEL_T);
        const u = Math.min(1, state.tDown / DEROTATE);
        state.pitch = PITCH_FLARE * (1 - u * u * (3 - 2 * u));   // smoothstep
    }
    if (state.phase === 'approach') {
        state.h -= P.sink * dt;
        state.dist += state.vFwd * dt;
        if (state.h <= 0) {
            state.h = 0; state.phase = 'impact'; state.t = 0; state.v = P.sink;
        }
        return;
    }
    if (state.phase === 'rollout') {
        state.x = xEq(); state.v = 0; state.F = P.m * G; state.a = 0;
        state.vFwd = Math.max(0, state.vFwd - P.mu * G * dt);
        state.dist += state.vFwd * dt;
        state.roll += state.vFwd * dt;
        if (state.pitch <= 0) state.rollNose += state.vFwd * dt;
        if (state.vFwd <= 0.005) state.phase = 'stopped';
        return;
    }
    if (state.phase !== 'impact') return;

    const c = cOf();
    let F = P.k * state.x + c * state.v;
    if (state.x > P.xMax) {                    // strut hits its stop
        F += 20 * P.k * (state.x - P.xMax);
        state.bottomed = true;
    }
    if (state.x <= 0 && F < 0) F = 0;           // wheel off the ground

    const a = G - F / P.m;                      // downward positive
    const vPrev = state.v;
    state.v += a * dt;
    state.x += state.v * dt;
    if (state.x < 0) state.x = 0;
    state.F = F; state.a = a; state.t += dt;

    if (F > state.peakF) state.peakF = F;
    if (state.x > state.peakX) state.peakX = state.x;

    // Impact time: touchdown until the aircraft first stops descending
    if (state.impactTime === null && vPrev > 0 && state.v <= 0) {
        state.impactTime = state.t;
        state.impulse = P.m * P.sink;
    }

    // Friction acts on the real normal force, so braking is briefly
    // stronger while the gear is loaded past the aircraft's weight
    state.vFwd = Math.max(0, state.vFwd - P.mu * F / P.m * dt);
    state.dist += state.vFwd * dt;
    state.roll += state.vFwd * dt;
    if (state.pitch <= 0) state.rollNose += state.vFwd * dt;

    state.sample += dt;
    if (state.sample >= 0.004 && state.hist.length < 1200) {
        state.sample = 0;
        state.hist.push({ t: state.t, F: F, x: state.x });
    }

    // The impact ends once the strut settles on its static deflection.
    // The rollout carries on, but the physics of interest is done.
    const atRest = Math.abs(state.v) < 0.02 && Math.abs(state.x - xEq()) < 0.005;
    state.settledFor = atRest ? state.settledFor + dt : 0;
    if (state.settledFor > 0.35) {
        state.phase = 'rollout';
        state.x = xEq(); state.v = 0;
        finish();
    }
}

function finish() {
    $('btn-land').disabled = false;
    writeObservation();
    lastRun = { sink: P.sink, m: P.m, k: P.k, peakF: state.peakF, dt: state.impactTime };
}

// ---- Auto-generated observation --------------------------------
function writeObservation() {
    const kN = v => (v / 1000).toFixed(0);
    const gl = (state.peakF / (P.m * G)).toFixed(2);
    const dt = state.impactTime ? state.impactTime.toFixed(2) : '—';
    const KE = 0.5 * P.m * P.sink * P.sink / 1000;
    const p = P.m * P.sink / 1000;

    let s = `Touchdown at <b>${P.sink.toFixed(1)} m/s</b> carrying <b>${p.toFixed(0)} kN&middot;s</b> of ` +
            `downward momentum and <b>${KE.toFixed(0)} kJ</b> of kinetic energy. The gear squashed ` +
            `<b>${state.peakX.toFixed(2)} m</b> over <b>${dt} s</b>, turning that momentum change into a ` +
            `peak force of <b>${kN(state.peakF)} kN</b> &mdash; about <b>${gl} g</b> on the airframe.`;

    if (state.bottomed) {
        s += xEq() > P.xMax
            ? ` The gear is too soft for this weight: it would rest at ${xEq().toFixed(2)} m but only has
                ${P.xMax.toFixed(2)} m of travel, so it sat on its stop before the impact even began.`
            : ` The strut ran out of travel and slammed into its stop, which is why the force spiked:
                once there is no squash left, there is no time left either.`;
    }

    if (lastRun) {
        const ratio = state.peakF / lastRun.peakF;
        const bits = [];
        if (Math.abs(P.sink - lastRun.sink) > 0.05)
            bits.push(`landing ${P.sink > lastRun.sink ? 'faster' : 'slower'} (${lastRun.sink.toFixed(1)} &rarr; ${P.sink.toFixed(1)} m/s)`);
        if (Math.abs(P.m - lastRun.m) > 500)
            bits.push(`${P.m > lastRun.m ? 'heavier' : 'lighter'} (${(lastRun.m / 1000).toFixed(0)} &rarr; ${(P.m / 1000).toFixed(0)} t)`);
        if (Math.abs(P.k - lastRun.k) > 1e4)
            bits.push(`a ${P.k > lastRun.k ? 'stiffer' : 'softer'} spring (${(lastRun.k / 1e6).toFixed(1)} &rarr; ${(P.k / 1e6).toFixed(1)} MN/m)`);
        if (bits.length) {
            s += `<br><br>Against your last landing &mdash; ${bits.join(', ')} &mdash; peak force ` +
                 `${ratio > 1.05 ? 'rose' : ratio < 0.95 ? 'fell' : 'held steady'}` +
                 `${(ratio > 1.05 || ratio < 0.95) ? ` by a factor of <b>${ratio.toFixed(2)}</b>` : ''}, ` +
                 `and the impact took <b>${lastRun.dt ? lastRun.dt.toFixed(2) : '—'} s</b> then versus <b>${dt} s</b> now.`;
            if (state.impactTime && lastRun.dt) {
                const slower = state.impactTime > lastRun.dt;
                s += ` The momentum to remove was fixed at touchdown, so taking ` +
                     `${slower ? 'longer' : 'less time'} over it is exactly why the force ` +
                     `${slower ? 'came down' : 'went up'}.`;
            }
        }
    } else {
        s += ` Change a slider and land again &mdash; the next note will compare the two.`;
    }
    $('obs-text').innerHTML = s;
    $('obs-box').classList.remove('hidden');
}

// ---- Header stats ----------------------------------------------
function updateStats() {
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('stat-pf', state.peakF ? (state.peakF / 1000).toFixed(0) : '—');
    set('stat-pf-mobile', state.peakF ? (state.peakF / 1000).toFixed(0) : '—');
    set('stat-dt', state.impactTime ? state.impactTime.toFixed(2) : '—');
    set('stat-g', state.peakF ? (state.peakF / (P.m * G)).toFixed(2) : '—');
    set('stat-g-mobile', state.peakF ? (state.peakF / (P.m * G)).toFixed(2) : '—');
}

// ---- Canvas sizing ---------------------------------------------
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
function draw() {
    const W = canvas.getBoundingClientRect().width;
    const H = canvas.getBoundingClientRect().height;
    const dark = state.viewMode === 'blueprint';

    const T = dark ? {
        line: '#e2e8f0', soft: '#64748b', fill: '#0f172a', alt: '#1e293b',
        body: '#1e293b', accent: '#38bdf8', bg: '#0f172a', hud: 'rgba(15,23,42,.88)',
        runway: '#17191c', mark: '#e2e8f0', edge: '#334155'
    } : {
        line: '#1e293b', soft: '#94a3b8', fill: '#ffffff', alt: '#f1f5f9',
        body: '#e8eaed', accent: '#0284c7', bg: '#f8fafc', hud: 'rgba(248,250,252,.88)',
        runway: '#7b7b7b', mark: '#f8fafc', edge: '#3f434a'
    };

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, W, H);

    // ---- world transform ----
    const model = { minX: -30, maxX: 34, minY: -2.4, maxY: 14 };
    const pad = 16;
    const mw = model.maxX - model.minX, mh = model.maxY - model.minY;
    const scale = Math.min((W - pad) / mw, (H - pad) / mh);
    const ox = W * 0.5 - ((model.minX + model.maxX) / 2) * scale;
    const oy = H * 0.62 + ((model.minY + model.maxY) / 2) * scale;
    const X = m => ox + m * scale;
    const Y = m => oy - m * scale;

    const hot = state.activePart || state.hoverPart;
    const pc = (n, f) => (n != null && hot === n) ? '#0284c7' : f;
    const pw = (n, b) => (n != null && hot === n) ? b + 1.4 : b;

    // ---- runway ----
    ctx.strokeStyle = T.line; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(W, Y(0)); ctx.stroke();
    ctx.fillStyle = T.runway;
    ctx.fillRect(0, Y(0) + 2, W, Math.max(0, H - Y(0) - 2));
    ctx.strokeStyle = pc(4, T.mark); ctx.lineWidth = pw(6, 6);
    ctx.setLineDash([40, 30]);
    ctx.lineDashOffset = -(state.dist * scale) % 70;
    ctx.beginPath();
    ctx.moveTo(0, Y(0) + 20); ctx.lineTo(W, Y(0) + 20); ctx.stroke();
    ctx.setLineDash([]);

    // ---- geometry of the aircraft ----
    const airborne = state.phase === 'ready' || state.phase === 'approach';
    const axleM = (airborne ? state.h : 0) + GEO.wheelR;
    const squash = Math.min(state.x * GEO.MAG, GEO.gearLen - 2.2);
    const bodyM = axleM + (GEO.gearLen - GEO.wheelR) - squash;
    const cx = X(0), axleY = Y(axleM), bodyY = Y(bodyM);
    const gx = cx + 1.2 * scale;

    // Everything attached to the airframe rotates about the main-gear
    // attachment; the strut, main wheel and runway do not.
    const cosP = Math.cos(state.pitch), sinP = Math.sin(state.pitch);
    const rot = (x, y) => {
        const dx = x - gx, dy = y - bodyY;
        return [gx + dx * cosP - dy * sinP, bodyY + dx * sinP + dy * cosP];
    };

    // ---- landing gear (part 2) ----
    // The legs are bolted to the airframe, so they lean with it. Everything
    // from here to the aeroplane itself is drawn in the tilted frame; the
    // runway and the measurement annotations stay upright.
    ctx.save();
    ctx.translate(gx, bodyY); ctx.rotate(state.pitch); ctx.translate(-gx, -bodyY);
    const outerH = (bodyY - axleY) * 0.5;
    ctx.fillStyle = T.fill; ctx.strokeStyle = pc(2, T.line); ctx.lineWidth = pw(2, 2);
    rr(gx - 0.28 * scale, bodyY, 0.56 * scale, outerH, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = T.alt;
    rr(gx - 0.18 * scale, bodyY + outerH - 2, 0.36 * scale, (axleY - bodyY) - outerH + 2, 3);
    ctx.fill(); ctx.stroke();

    // spring, visibly closing up as the strut compresses
    const cTop = bodyY + 4, cBot = axleY - 0.35 * scale, coils = 7;
    ctx.strokeStyle = pc(2, T.soft); ctx.lineWidth = pw(2, 2.2);
    ctx.beginPath();
    for (let i = 0; i <= coils * 14; i++) {
        const f = i / (coils * 14);
        const yy = cTop + f * (cBot - cTop);
        const xx = gx + Math.sin(f * coils * Math.PI * 2) * 0.42 * scale;
        i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
    }
    ctx.stroke();

    // ---- wheel (part 3) ----
    const wr = GEO.wheelR * scale;
    // Roll only accumulates once the wheels are on the runway, so they hang
    // still through the approach and spin up at touchdown, as real ones do.
    const spin = -state.roll / GEO.wheelR;   // rolling left ⇒ anticlockwise on screen

    // One tyre with a hub and six spokes; reused by both legs.
    function wheelAt(wx, wy, r, ang, part) {
        ctx.fillStyle = T.fill; ctx.strokeStyle = pc(part, T.line); ctx.lineWidth = pw(part, 2.4);
        ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.lineWidth = 2.2;
        for (let i = 0; i < 6; i++) {
            const a = ang + i * Math.PI / 3;
            ctx.beginPath();
            ctx.moveTo(wx + Math.cos(a) * r * 0.22, wy + Math.sin(a) * r * 0.22);
            ctx.lineTo(wx + Math.cos(a) * r * 0.82, wy + Math.sin(a) * r * 0.82);
            ctx.stroke();
        }
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(wx, wy, r * 0.22, 0, Math.PI * 2); ctx.stroke();
    }

    // A 747 main leg carries a four-wheel bogie — two tyres fore and two aft —
    // so a side view shows a tandem pair on a beam, with the strut landing on
    // the middle of it. The spacing follows the real bogie: centres a little
    // over one tyre diameter apart, leaving a clear gap between them.
    const bogie = wr * 1.15;
    // Cancel the airframe lean by however much the beam has levelled, so on
    // the ground both tyres sit flat on the tarmac instead of one digging in.
    ctx.save();
    const beam = -state.pitch * state.bogieLevel;
    ctx.translate(gx, axleY); ctx.rotate(beam); ctx.translate(-gx, -axleY);
    ctx.fillStyle = T.alt; ctx.strokeStyle = pc(3, T.line); ctx.lineWidth = pw(3, 2);
    rr(gx - bogie - wr * 0.22, axleY - wr * 0.17, 2 * (bogie + wr * 0.22), wr * 0.34, wr * 0.17);
    ctx.fill(); ctx.stroke();
    wheelAt(gx - bogie, axleY, wr, spin, 3);
    wheelAt(gx + bogie, axleY, wr, spin, 3);
    ctx.restore();

    // Nose gear, standing on the same runway line as the main gear. A 747
    // carries 18 tyres — 16 on the mains, 2 on the nose — and they really are
    // all one size. Drawn dead equal though, the aeroplane reads as a car, so
    // the nose wheel is taken down a little to give the side view some depth.
    const noseR = wr * NOSE_WHEEL;
    const ngx = cx - 12.4 * scale;
    const noseWheelY = axleY + wr - noseR;
    // Built like the main leg but at the nose wheel's scale: an outer cylinder
    // with the piston sliding out of it, and a spring inside. A real nose gear
    // is sprung too — it just carries far less load, so it barely moves. The
    // physics readouts describe the main gear only.
    const nLegH = noseWheelY - bodyY;
    ctx.fillStyle = T.fill; ctx.strokeStyle = pc(2, T.line); ctx.lineWidth = pw(2, 2);
    rr(ngx - 0.20 * scale, bodyY, 0.40 * scale, nLegH * 0.5, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = T.alt;
    rr(ngx - 0.13 * scale, bodyY + nLegH * 0.5 - 2, 0.26 * scale, nLegH * 0.5 + 2, 3);
    ctx.fill(); ctx.stroke();

    const nTop = bodyY + 3, nBot = noseWheelY - 0.22 * scale, nCoils = 5;
    ctx.strokeStyle = pc(2, T.soft); ctx.lineWidth = pw(2, 1.8);
    ctx.beginPath();
    for (let i = 0; i <= nCoils * 14; i++) {
        const fr = i / (nCoils * 14);
        const yy = nTop + fr * (nBot - nTop);
        const xx = ngx + Math.sin(fr * nCoils * Math.PI * 2) * 0.30 * scale;
        i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
    }
    ctx.stroke();


    // The nose wheel is still in the air while the mains are already rolling,
    // so it keeps its own roll count and spins up only when it touches.
    const spinNose = -state.rollNose / (GEO.wheelR * NOSE_WHEEL);
    wheelAt(ngx, noseWheelY, noseR, spinNose, 2);

    // ---- Boeing 747, drawn from the traced profile ----
    const fh = 3.2 * scale;                    // fuselage depth, for the arrows
    const fy = bodyY - fh;
    const PX = mx => cx + mx * scale;
    const PY = my => bodyY + my * scale;        // y = 0 is the belly

    ctx.fillStyle = T.body;
    ctx.strokeStyle = pc(1, T.line);
    ctx.lineWidth = pw(1, 2.4);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    PLANE.forEach(([mx, my], i) => {
        const X2 = PX(mx), Y2 = PY(my);
        i ? ctx.lineTo(X2, Y2) : ctx.moveTo(X2, Y2);
    });
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // interior detail, kept light so the silhouette still reads
    ctx.strokeStyle = T.soft; ctx.lineWidth = 1.2;
    ctx.beginPath();                                   // cabin window line
    ctx.moveTo(PX(-14.0), PY(-1.55)); ctx.lineTo(PX(11.5), PY(-1.85));
    ctx.stroke();
    ctx.beginPath();                                   // upper-deck floor
    ctx.moveTo(PX(-15.4), PY(-2.75)); ctx.lineTo(PX(-8.4), PY(-2.95));
    ctx.stroke();
    ctx.beginPath();                                   // flight-deck glazing
    ctx.moveTo(PX(-16.6), PY(-2.30)); ctx.lineTo(PX(-15.5), PY(-2.85));
    ctx.stroke();
    for (let i = 0; i < 5; i++) {                      // upper-deck windows
        ctx.beginPath();
        ctx.arc(PX(-14.6 + i * 1.0), PY(-3.25), 1.5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    // ---- indicators ----
    ctx.textBaseline = 'middle';
    ctx.font = fInter(12, 600);

    if (state.showPhysics) {
        // compression dimension beside the strut
        const dx = gx + 1.5 * scale;
        const ref = Y(axleM + (GEO.gearLen - GEO.wheelR));
        ctx.strokeStyle = T.soft; ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(gx + 0.4 * scale, bodyY); ctx.lineTo(dx + 12, bodyY); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(gx + 0.4 * scale, ref); ctx.lineTo(dx + 12, ref); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = T.line; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(dx, ref); ctx.lineTo(dx, bodyY); ctx.stroke();
        head(dx, ref, -Math.PI / 2, 6); head(dx, bodyY, Math.PI / 2, 6);
        ctx.fillStyle = T.line; ctx.textAlign = 'left';
        ctx.fillText(`x = ${state.x.toFixed(3)} m`, dx + 8, (ref + bodyY) / 2);
        ctx.fillStyle = T.soft; ctx.font = fInter(11);
        ctx.fillText(`travel shown ×${GEO.MAG}`, dx + 8, (ref + bodyY) / 2 + 15);
        ctx.font = fInter(12, 600);

        if (state.phase === 'approach') {
            const [ax, ay] = rot(PX(-18.4), fy + 4);
            ctx.strokeStyle = T.line; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax, ay + 46); ctx.stroke();
            head(ax, ay + 46, Math.PI / 2, 8);
            ctx.fillStyle = T.line; ctx.textAlign = 'right';
            ctx.fillText(`v = ${P.sink.toFixed(1)} m/s`, ax - 8, ay + 23);
        }
        if (!airborne) {
            const [nx, ay] = rot(PX(-17), fy - 1.6 * scale);
            const len = 20 + 70 * (state.vFwd / P.vFwd0);
            ctx.strokeStyle = T.line; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(nx, ay); ctx.lineTo(nx - len, ay); ctx.stroke();
            head(nx - len, ay, Math.PI, 8);
            ctx.fillStyle = T.line; ctx.textAlign = 'right';
            ctx.fillText(`${state.vFwd.toFixed(0)} m/s`, nx - len - 6, ay - 13);
        }
    }

    if (state.showForces && state.phase !== 'ready') {
        // Two separate columns so the labels can never sit on top of each other:
        // weight hangs from the CG on the left, gear reaction rises from the wheel
        // on the right. Both share one newtons-per-pixel scale, so the arrow
        // lengths can be compared directly by eye.
        const NPP = (P.m * G) / 78;
        const wLen = (P.m * G) / NPP;
        // weight column, clear of the strut; hangs from the CG, which rides the airframe
        const [wx, wTop] = rot(PX(-5.2), fy + fh * 0.5);

        ctx.strokeStyle = T.line; ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.moveTo(wx, wTop); ctx.lineTo(wx, wTop + wLen); ctx.stroke();
        head(wx, wTop + wLen, Math.PI / 2, 9);
        ctx.fillStyle = T.line;
        ctx.textAlign = 'center'; ctx.font = fInter(11, 700);
        ctx.fillText('WEIGHT', wx, wTop + wLen + 14);
        ctx.font = fInter(12, 600);
        ctx.fillText(`${(P.m * G / 1000).toFixed(0)} kN`, wx, wTop + wLen + 28);

        if (state.F > 1) {
            const fLen = Math.min(state.F / NPP, (axleY - wr) - 34);
            const [rx, rFoot] = rot(gx, axleY - wr - 6);   // foot tracks the tilted leg
            const fTop = rFoot - fLen;
            ctx.strokeStyle = T.line; ctx.lineWidth = 2.6;
            ctx.beginPath(); ctx.moveTo(rx, rFoot); ctx.lineTo(rx, fTop); ctx.stroke();
            head(rx, fTop, -Math.PI / 2, 9);
            ctx.fillStyle = T.line; ctx.textAlign = 'center';
            ctx.font = fInter(11, 700);
            ctx.fillText('LANDING FORCE', rx, fTop - 20);
            ctx.font = fInter(12, 600);
            ctx.fillText(`${(state.F / 1000).toFixed(0)} kN`, rx, fTop - 7);
        }
    }

    // ---- numbered badges ----
    badgeHits = [];
    if (state.showLabels) {
        const [b1x, b1y] = rot(cx - 6 * scale, fy + fh * 0.5);   // badges ride the airframe
        // clear of the forward bogie tyre, which reaches 1.7 m ahead of the leg
        const [b2x, b2y] = rot(gx - 2.6 * scale, bodyY + (axleY - bodyY) * 0.35);
        const bl = -state.pitch * state.bogieLevel, cb = Math.cos(bl), sb = Math.sin(bl);
        // just outboard of the aft bogie tyre, with clear air between them
        const b3dx = bogie + wr + 26, b3dy = 0;
        const [b3x, b3y] = rot(gx + b3dx * cb - b3dy * sb, axleY + b3dx * sb + b3dy * cb);
        const labels = [
            { n: '1', x: b1x, y: b1y },
            { n: '2', x: b2x, y: b2y },
            { n: '3', x: b3x, y: b3y },
            { n: '4', x: W - 190, y: Y(0) + 22 }
        ];
        badgeHits = labels.map(l => ({ num: l.n, sx: l.x, sy: l.y, r: 13 * FS }));
        labels.forEach(l => {
            const on = hot === parseInt(l.n);
            ctx.save();
            ctx.fillStyle = on ? '#0284c7' : (dark ? '#1e293b' : '#ffffff');
            ctx.strokeStyle = on ? '#0f172a' : '#0284c7';
            ctx.lineWidth = 1.8;
            ctx.beginPath(); ctx.arc(l.x, l.y, 13 * FS, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = on ? '#ffffff' : '#0284c7';
            ctx.font = fMono(13, 'bold');
            ctx.textAlign = 'center';
            ctx.fillText(l.n, l.x, l.y);
            ctx.restore();
        });
    }

    // ---- phase caption ----
    ctx.fillStyle = T.soft; ctx.textAlign = 'left';
    ctx.font = fInter(11, 600);
    ctx.fillText(({
        ready: 'READY — PRESS LAND', approach: 'APPROACH',
        impact: 'IMPACT — GEAR ABSORBING', rollout: 'ROLLOUT — BRAKING ON FRICTION',
        stopped: 'STOPPED'
    })[state.phase], 14, 16 * FS);
    if (state.slowMo) { ctx.textAlign = 'right'; ctx.fillText('SLOW MOTION ×0.15', W - 14, 16 * FS); }

    // ---- live physics panel, inside the sim area ----
    const hudBottom = state.showPhysics ? drawHUD(W, H, T) : 30;
    if (state.showGraphs) drawGraphs(W, H, T, hudBottom + 10);

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
}

// ---- live values, drawn as a panel in the corner of the sim ----
function drawHUD(W, H, T) {
    const v = state.phase === 'approach' ? P.sink : state.v;
    const rows = [
        ['Velocity', v.toFixed(2), 'm/s'],
        ['Momentum  p = mv', (P.m * v / 1000).toFixed(0), 'kN·s'],
        ['Kinetic energy  ½mv²', (0.5 * P.m * v * v / 1000).toFixed(0), 'kJ'],
        ['Compression  x', state.x.toFixed(3), 'm'],
        ['Impact force  kx + cv', (state.F / 1000).toFixed(0), 'kN'],
        ['Acceleration  F/m', state.a.toFixed(2), 'm/s²'],
        ['Load factor', (state.F / (P.m * G)).toFixed(2), 'g'],
        ['Impact time  Δt', state.impactTime ? state.impactTime.toFixed(3) : '—', 's'],
        ['Impulse  J = Δp', state.impulse ? (state.impulse / 1000).toFixed(0) : '—', 'kN·s'],
        ['Resting  x = mg/k', xEq().toFixed(3), 'm']
    ];
    const pad = 10 * FS, lh = 17 * FS, w = 250 * FS, h = rows.length * lh + pad * 2 + 16 * FS;
    const x = W - w - 14, y = 26;

    ctx.save();
    ctx.fillStyle = T.hud;
    ctx.strokeStyle = T.line; ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 8); else ctx.rect(x, y, w, h);
    ctx.fill(); ctx.stroke();

    ctx.fillStyle = T.line;
    ctx.font = fInter(12, 700); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('LIVE PHYSICS  ·  CALCULATED', x + pad, y + pad + 4 * FS);
    ctx.strokeStyle = T.soft; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(x + pad, y + pad + 12 * FS); ctx.lineTo(x + w - pad, y + pad + 12 * FS); ctx.stroke();

    rows.forEach((r, i) => {
        const yy = y + pad + 24 * FS + i * lh;
        ctx.fillStyle = T.line; ctx.font = fInter(12); ctx.textAlign = 'left';
        ctx.fillText(r[0], x + pad, yy);
        ctx.fillStyle = T.line; ctx.font = fMono(12, 700); ctx.textAlign = 'right';
        ctx.fillText(r[1], x + w - pad - 26 * FS, yy);
        ctx.fillStyle = T.line; ctx.font = fInter(12); ctx.textAlign = 'left';
        ctx.fillText(r[2], x + w - pad - 22 * FS, yy);
    });
    ctx.restore();
    return y + h;                     // where the graphs start
}

// ---- both graphs, drawn inside the sim area ----
function drawGraphs(W, H, T, top) {
    const gw = 250 * FS, gh = 100 * FS, gap = 8;
    const x = W - gw - 14;
    // Stacked immediately below the live-physics panel, clamped so they
    // never run off the bottom on a short window.
    const y = Math.min(top, H - gh * 2 - gap - 12);
    plot(x, y, gw, gh, 'F', 'IMPACT FORCE (kN)', 1000, P.m * G, 'weight');
    plot(x, y + gh + gap, gw, gh, 'x', 'GEAR COMPRESSION (m)', 1, P.xMax, 'max travel');

    function plot(px, py, w, h, key, title, div, ref, refLabel) {
        ctx.save();
        ctx.fillStyle = T.hud; ctx.strokeStyle = T.line; ctx.lineWidth = 1.4;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(px, py, w, h, 8); else ctx.rect(px, py, w, h);
        ctx.fill(); ctx.stroke();

        const L = px + 34 * FS, R = px + w - 8, TT = py + 20 * FS, B = py + h - 16 * FS;
        const data = state.hist;
        const tMax = Math.max(0.5, data.length ? data[data.length - 1].t : 0.5);
        let vMax = ref || 1;
        for (const d of data) if (d[key] > vMax) vMax = d[key];
        vMax *= 1.12;

        const gx2 = t => L + (t / tMax) * (R - L);
        const gy2 = val => B - (val / vMax) * (B - TT);

        ctx.fillStyle = T.soft; ctx.font = fInter(8.5, 700);
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(title, px + 8 * FS, py + 11 * FS);

        ctx.strokeStyle = T.soft; ctx.lineWidth = 0.6; ctx.globalAlpha = .5;
        for (let i = 0; i <= 2; i++) {
            const yy = TT + (B - TT) * i / 2;
            ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(R, yy); ctx.stroke();
        }
        ctx.globalAlpha = 1;

        if (ref) {
            ctx.strokeStyle = T.soft; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
            ctx.beginPath(); ctx.moveTo(L, gy2(ref)); ctx.lineTo(R, gy2(ref)); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = T.soft; ctx.font = fInter(8); ctx.textAlign = 'left';
            ctx.fillText(refLabel, L + 3, gy2(ref) - 5);
        }

        ctx.strokeStyle = T.line; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(L, TT); ctx.lineTo(L, B); ctx.lineTo(R, B); ctx.stroke();

        ctx.fillStyle = T.soft; ctx.font = fMono(8);
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText((vMax / div).toFixed(vMax / div < 10 ? 1 : 0), L - 4, TT);
        ctx.fillText('0', L - 4, B);
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(tMax.toFixed(2) + ' s', R - 12, B + 3);

        if (data.length > 1) {
            ctx.strokeStyle = T.accent; ctx.lineWidth = 1.8;
            ctx.beginPath();
            data.forEach((d, i) => i ? ctx.lineTo(gx2(d.t), gy2(d[key])) : ctx.moveTo(gx2(d.t), gy2(d[key])));
            ctx.stroke();
            const last = data[data.length - 1];
            ctx.fillStyle = T.accent;
            ctx.beginPath(); ctx.arc(gx2(last.t), gy2(last[key]), 2.6, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
    }
}

// =============================================================
//  Loop
// =============================================================
const DT = 1 / 1000;
let acc = 0, last = performance.now();
function frame(now) {
    let real = Math.min((now - last) / 1000, 0.05); last = now;
    if (!state.paused) {
        acc += real * (state.slowMo ? 0.15 : 1);
        let guard = 0;
        while (acc >= DT && guard++ < 4000) { step(DT); acc -= DT; }
    }
    updateLanding();
    updateStats();
    draw();
    positionPopover();
    requestAnimationFrame(frame);
}

// =============================================================
//  Controls
// =============================================================
function bindSlider(id, key, fmt, mul) {
    const el = $(id);
    el.addEventListener('input', () => {
        P[key] = parseFloat(el.value) * (mul || 1);
        $(id.replace('s-', 'v-')).textContent = fmt(parseFloat(el.value));
        if (state.phase === 'ready') reset();
        updateStats();
    });
}
bindSlider('s-mass', 'm',    v => v.toLocaleString());
bindSlider('s-sink', 'sink', v => v.toFixed(1));
bindSlider('s-k',    'k',    v => v.toFixed(1), 1e6);
bindSlider('s-xmax', 'xMax', v => v.toFixed(2));
bindSlider('s-zeta', 'zeta', v => v.toFixed(2));
bindSlider('s-mu',   'mu',   v => v.toFixed(2));

$('btn-land').addEventListener('click', land);
$('btn-reset').addEventListener('click', () => {
    Object.assign(P, DEFAULTS);
    $('s-mass').value = DEFAULTS.m;   $('v-mass').textContent = DEFAULTS.m.toLocaleString();
    $('s-sink').value = DEFAULTS.sink; $('v-sink').textContent = DEFAULTS.sink.toFixed(1);
    $('s-k').value = DEFAULTS.k / 1e6; $('v-k').textContent = (DEFAULTS.k / 1e6).toFixed(1);
    $('s-xmax').value = DEFAULTS.xMax; $('v-xmax').textContent = DEFAULTS.xMax.toFixed(2);
    $('s-zeta').value = DEFAULTS.zeta; $('v-zeta').textContent = DEFAULTS.zeta.toFixed(2);
    $('s-mu').value = DEFAULTS.mu;     $('v-mu').textContent = DEFAULTS.mu.toFixed(2);
    reset();
    $('obs-box').classList.add('hidden');
});
$('btn-pause').addEventListener('click', () => {
    state.paused = !state.paused;
    setLandingPaused(state.paused);
    $('pause-icon').className = state.paused ? 'fa-solid fa-play' : 'fa-solid fa-pause';
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
bindChip('chk-labels', 'chip-labels', 'showLabels', on => { if (!on) closePopover(); });
bindChip('chk-forces', 'chip-forces', 'showForces');
bindChip('chk-physics', 'chip-physics', 'showPhysics');
bindChip('chk-graphs', 'chip-graphs', 'showGraphs');
bindChip('chk-slow', 'chip-slow', 'slowMo');   // updateLanding retimes the audio
bindChip('chk-sound', 'chip-sound', 'sound', on => { if (!on) stopLanding(true); });
$('chk-view-mode').addEventListener('change', e => {
    const dark = e.target.checked;
    state.viewMode = dark ? 'blueprint' : 'light';
    $('txt-view-mode').textContent = dark ? 'Light Mode' : 'Dark Mode';
    popover.classList.toggle('dark', dark);
    paintChip($('chip-view-mode'), dark);
});

// =============================================================
//  Badge popover
// =============================================================
const popover = $('part-popover');
const partInfo = {
    '1': { title: 'Aircraft', desc: 'Its mass sets the momentum p = mv to be removed, and the weight mg the gear must hold.' },
    '2': { title: 'Gear Strut', desc: 'Spring and damper in parallel. Pushes back with F = kx + cv, so it resists both squash and squash-rate.' },
    '3': { title: 'Wheel', desc: 'Carries the load to the runway. Friction F = μN then slows the roll.' },
    '4': { title: 'Runway', desc: 'Provides the normal force N and the friction that brings the aircraft to a stop.' }
};
let popoverPart = null;

function openPopover(num) {
    const info = partInfo[num]; if (!info) return;
    popoverPart = num;
    $('popover-num').textContent = num;
    $('popover-title').textContent = info.title;
    $('popover-desc').textContent = info.desc;
    popover.classList.remove('hidden');
    state.activePart = parseInt(num);
    positionPopover();
}
function closePopover() {
    popoverPart = null; popover.classList.add('hidden'); state.activePart = null;
}
function positionPopover() {
    if (!popoverPart) return;
    const hit = badgeHits.find(b => b.num === popoverPart);
    if (!hit) { closePopover(); return; }
    const box = canvas.getBoundingClientRect();
    const pw2 = popover.offsetWidth, ph = popover.offsetHeight;
    let left = hit.sx + hit.r + 10;
    if (left + pw2 > box.width - 6) left = hit.sx - hit.r - 10 - pw2;
    left = Math.max(6, Math.min(left, box.width - pw2 - 6));
    let top = Math.max(6, Math.min(hit.sy - ph / 2, box.height - ph - 6));
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
}
function badgeAt(clientX, clientY) {
    const box = canvas.getBoundingClientRect();
    const mx = clientX - box.left, my = clientY - box.top;
    return badgeHits.find(b => Math.hypot(mx - b.sx, my - b.sy) <= b.r + 4);
}
canvas.addEventListener('click', e => {
    const hit = badgeAt(e.clientX, e.clientY);
    if (!hit) return closePopover();
    if (hit.num === popoverPart) return closePopover();
    openPopover(hit.num);
});
canvas.addEventListener('mousemove', e => {
    const hit = badgeAt(e.clientX, e.clientY);
    canvas.style.cursor = hit ? 'pointer' : '';
    state.hoverPart = hit ? parseInt(hit.num) : null;
});
canvas.addEventListener('mouseleave', () => { state.hoverPart = null; });
$('popover-close').addEventListener('click', closePopover);

// ---- explainer modal ----
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
