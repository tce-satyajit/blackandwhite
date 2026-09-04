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
    ice: false, slowMo: false,
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
function reset() {
    state.v = 0; state.t = 0; state.dist = 0;
    state.drive = false; state.brake = false;
    state.slip = 0; state.slipping = false;
    state.angL = 0; state.angR = 0; state.angC = 0; state.angS = 0;
    state.hist = []; state.sample = 0;
    state.done = [false, false, false, false, false];
    state.ice = false;
    paintDrive(); paintIce(); paintChallenges();
    recompute(0);
}

function recompute(dt) {
    const R = turnRadius(), t = TRACK, rw = CAR.wheelR, m = CAR.mass;

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
        win(0, 'Challenge 1 — straight ahead the wheels match, and the spider gears do not spin at all.');
    if (state.drive && lo > 1 && hi / lo >= 1.4)
        win(1, 'Challenge 2 — the outer wheel is turning over 1.4x as fast as the inner one.');
    // The rule is on screen the whole time; this ticks once they have
    // driven a corner long enough to have watched it hold.
    if (state.drive && dl > 15) {
        state.ruleWatch = (state.ruleWatch || 0) + 1;
        if (state.ruleWatch > 240 * 3)
            win(2, 'Challenge 3 — the average of the two wheel speeds is the carrier speed. Always.');
    } else state.ruleWatch = 0;
    if (state.drive && Math.abs(P.steer) >= 24 && dl > 30)
        win(3, 'Challenge 4 — the tighter the turn, the bigger the gap between the two circles, so the bigger the speed difference.');
    if (state.slipping && state.slip > 5 && state.v < 1.5)
        win(4, 'Challenge 5 — equal torque split: the icy wheel sets the limit for both, so the car goes nowhere.');
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
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4600);
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

    // Two halves: the car on the road, and the gears that make it possible.
    const leftW = Math.min(W * 0.40, 620);
    drawRoad(0, 0, leftW, H, T);
    drawMech(leftW, 0, W - leftW, H, T);
}

// ---- the car, actually driving along the road ---------------
function drawRoad(x, y, w, h, T) {
    const scale = 21;                       // px per metre — sized to be read across a classroom
    const cx = x + w * 0.5, cy = y + h * 0.62;
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

// ---- a gear drawn the way a real one is cut ----------------
// Involute-ish flanks: the tooth is widest at the root, narrows through
// the pitch circle and ends in a flat tip. `slant` skews the tips round
// the rim, which is what gives a spiral-bevel ring gear its look.
function realGear(cx, cy, Rp, n, ang, T, stroke, fill, opt) {
    opt = opt || {};
    const m = 2 * Rp / n;                       // module
    const Rt = Rp + m * 0.52 * (opt.add || 1);  // tip circle
    const Rr = Rp - m * 0.62 * (opt.ded || 1);  // root circle
    const p = Math.PI / n;
    const wr = p * 0.70, wp = p * 0.50, wt = p * 0.26;
    const sl = (opt.slant || 0) * p;
    const at = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
        const th = ang + i * 2 * Math.PI / n;
        const q = at(th - wr, Rr);
        i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]);
        const b = at(th - wp, Rp), c = at(th - wt + sl, Rt);
        ctx.quadraticCurveTo(b[0], b[1], c[0], c[1]);
        const dd = at(th + wt + sl, Rt);
        ctx.lineTo(dd[0], dd[1]);
        const e = at(th + wp, Rp), g = at(th + wr, Rr);
        ctx.quadraticCurveTo(e[0], e[1], g[0], g[1]);
        ctx.arc(cx, cy, Rr, th + wr, th + 2 * Math.PI / n - wr);
    }
    ctx.closePath();
    ctx.fillStyle = fill || T.fill; ctx.strokeStyle = stroke; ctx.lineWidth = opt.lw || 2;
    ctx.fill(); ctx.stroke();

    // machined detail: web, hub and bolt holes, so it reads as a real part
    if (opt.web !== false) {
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(cx, cy, Rr * 0.80, 0, Math.PI * 2); ctx.stroke();
    }
    const hub = Rp * (opt.hub || 0.26);
    ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(cx, cy, hub, 0, Math.PI * 2); ctx.stroke();
    if (opt.bolts) {
        ctx.lineWidth = 1.3;
        for (let i = 0; i < opt.bolts; i++) {
            const a = ang + i * 2 * Math.PI / opt.bolts;
            const b = at(a, Rr * 0.56);
            ctx.beginPath(); ctx.arc(b[0], b[1], Rp * 0.055, 0, Math.PI * 2); ctx.stroke();
        }
    }
    // keyway on the hub marks the rotation unmistakably
    ctx.lineWidth = 2.4;
    const k1 = at(ang, hub * 0.30), k2 = at(ang, hub);
    ctx.beginPath(); ctx.moveTo(k1[0], k1[1]); ctx.lineTo(k2[0], k2[1]); ctx.stroke();
}

// ---- the differential, drawn as the real assembly ----------
// Bevel gears meet at right angles in a real unit. They are laid flat here
// so every part can be watched turning at once; the speeds are the accurate
// part. Ring gear, carrier case, spider gears, side gears and the drive
// pinion are all present, as in a cutaway of a live axle.
function drawMech(x, y, w, h, T) {
    const ring = Math.min(w * 0.32, h * 0.34);
    const cx = x + w * 0.47, cy = y + h * 0.43;
    const side = ring * 0.35, spid = side / SPIDER_RATIO, d = ring * 0.49;
    const spinning = Math.abs(state.wR - state.wL) > 0.02;
    const N_RING = 38, N_PIN = 10;

    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    // ---- half-shafts, splined where they enter the side gears ----
    ctx.strokeStyle = T.line; ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(cx - ring - 54 * FS, cy); ctx.lineTo(cx - d, cy);
    ctx.moveTo(cx + d, cy); ctx.lineTo(cx + ring + 54 * FS, cy);
    ctx.stroke();
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 6; i++) {
        [-1, 1].forEach(sg => {
            const sx = cx + sg * (ring + 16 * FS + i * 5 * FS);
            ctx.beginPath(); ctx.moveTo(sx, cy - 4); ctx.lineTo(sx, cy + 4); ctx.stroke();
        });
    }

    // ---- ring gear: spiral-bevel teeth, bolted to the carrier ----
    realGear(cx, cy, ring, N_RING, state.angC, T, T.line, T.alt,
             { slant: 0.55, add: 1.1, lw: 2.4, hub: 0.74, web: false });

    // ---- carrier case, turning with the ring gear ----
    ctx.strokeStyle = T.accent; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(cx, cy, ring * 0.72, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 8; i++) {              // case bolts
        const a = state.angC + i * Math.PI / 4;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * ring * 0.72, cy + Math.sin(a) * ring * 0.72,
                ring * 0.035, 0, Math.PI * 2);
        ctx.stroke();
    }
    // the pin the spiders ride on, carried round by the case
    ctx.strokeStyle = T.accent; ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(state.angC + Math.PI / 2) * ring * 0.72,
               cy + Math.sin(state.angC + Math.PI / 2) * ring * 0.72);
    ctx.lineTo(cx + Math.cos(state.angC - Math.PI / 2) * ring * 0.72,
               cy + Math.sin(state.angC - Math.PI / 2) * ring * 0.72);
    ctx.stroke();

    // ---- drive pinion on the propeller shaft, feeding the ring ----
    const pinR = ring * N_PIN / N_RING;
    // The pinion is bolted to the axle housing: it stays put and spins.
    // Only its gear turns — it must not orbit the ring gear.
    const pa = Math.PI * 0.78;                               // fixed, lower-left
    const px = cx + Math.cos(pa) * (ring + pinR), py = cy + Math.sin(pa) * (ring + pinR);
    ctx.strokeStyle = T.line; ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(pa) * 42 * FS, py + Math.sin(pa) * 42 * FS);
    ctx.stroke();
    realGear(px, py, pinR, N_PIN, -state.angC * (N_RING / N_PIN), T, T.line, T.fill,
             { slant: 0.4, lw: 2, hub: 0.3 });

    // ---- spider gears on the carrier pin ----
    realGear(cx, cy - d, spid, 11, state.angS, T,
             spinning ? T.accent : T.soft, T.fill, { bolts: 0, hub: 0.3 });
    realGear(cx, cy + d, spid, 11, -state.angS, T,
             spinning ? T.accent : T.soft, T.fill, { bolts: 0, hub: 0.3 });

    // ---- side gears, one per half-shaft ----
    realGear(cx - d, cy, side, 16, state.angL, T,
             state.slipLeft && state.slipping ? T.warn : T.accent, T.fill,
             { bolts: 5, hub: 0.30 });
    realGear(cx + d, cy, side, 16, state.angR, T,
             !state.slipLeft && state.slipping ? T.warn : T.accent, T.fill,
             { bolts: 5, hub: 0.30 });

    // ---- labels ----
    ctx.fillStyle = T.soft; ctx.font = fInter(11, 700);
    ctx.fillText('RING GEAR', cx, cy - ring - 14 * FS);
    ctx.fillText('CARRIER CASE', cx, cy + ring + 15 * FS);
    ctx.textAlign = 'left';
    ctx.fillText('SPIDER GEARS', cx + spid + 10 * FS, cy - d - 10 * FS);
    ctx.fillText('DRIVE PINION', px + 12 * FS, py + 14 * FS);
    ctx.textAlign = 'right';
    ctx.fillText('SIDE GEARS', cx - spid - 10 * FS, cy + d + 10 * FS);
    ctx.textAlign = 'center';
    ctx.font = fInter(10, 600);
    ctx.fillText('to left wheel', cx - ring - 54 * FS, cy - 16 * FS);
    ctx.fillText('to right wheel', cx + ring + 54 * FS, cy - 16 * FS);

    // ---- the rule ----
    // The block is measured up from the bottom edge. It used to end exactly
    // on it, which cut the last line in half at every window size.
    const by = y + h - 84 * FS;
    ctx.font = fInter(10, 700); ctx.fillStyle = T.soft;
    ctx.fillText('THE DIFFERENTIAL RULE', cx, by - 4 * FS);

    // Shrink the equation if a wide panel is not on offer, so three-digit
    // readings can never run past the edge.
    const eq = `${RPM(state.wL).toFixed(0)}  +  ${RPM(state.wR).toFixed(0)}   =   2 × ${RPM(state.wc).toFixed(0)}`;
    const room = w - 24;
    let eqSize = 22;
    ctx.font = fMono(eqSize, 700);
    while (eqSize > 11 && ctx.measureText(eq).width > room) {
        eqSize -= 1;
        ctx.font = fMono(eqSize, 700);
    }
    ctx.fillStyle = T.line;
    ctx.fillText(eq, cx, by + 22 * FS);
    ctx.font = fInter(11); ctx.fillStyle = T.soft;
    ctx.fillText('left wheel  +  right wheel   =   twice the carrier', cx, by + 42 * FS);
    ctx.font = fInter(12, 600);
    ctx.fillStyle = state.slipping ? T.warn : spinning ? T.accent : T.soft;
    ctx.fillText(state.slipping
        ? `Both wheels held to ${state.tEach.toFixed(0)} N·m — the icy one sets the limit.`
        : spinning ? 'Spiders are spinning — that spin IS the difference.'
        : 'Spiders carried round without spinning — wheels matched.',
        cx, by + 62 * FS);
    ctx.restore();
}

// =============================================================
//  Panels outside the canvas
// =============================================================
function updateStats() {
    $('stat-l').textContent = RPM(state.wL).toFixed(0);
    $('stat-r').textContent = RPM(state.wR).toFixed(0);
    $('stat-c').textContent = RPM(state.wc).toFixed(0);
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
    updateStats(); draw();
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
    paintDrive(); recompute(0);
});
$('btn-ice').addEventListener('click', () => {
    state.ice = !state.ice;
    if (!state.ice) state.slip = 0;
    paintIce(); recompute(0);
});
$('btn-reset').addEventListener('click', () => {
    P.steer = 0;
    $('s-steer').value = 0; $('v-steer').textContent = '0';
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
bindChip('chk-slow', 'chip-slow', 'slowMo');
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
