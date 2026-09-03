// =============================================================
//  Analog Clock - model
// =============================================================
// Millimetres and seconds. The pendulum is a metre long, the wheels
// are the size a real skeleton clock's wheels are, and one unit is
// one millimetre throughout.
//
// Everything the clock does comes from one number: how many beats
// the pendulum has made. The hands, the wheels, the seconds hand -
// all of them are that number multiplied by a gear ratio.
const G_ACC = 9.81;                   // m/s2

// The going train, wheel teeth against pinion leaves. Read it as a
// chain of divisions from the escape wheel down to the hour hand.
const N_ESC = 30;                     // escape wheel teeth
const TRAIN = {
    escPinion: 8,  thirdWheel: 60,
    thirdPinion: 8, centreWheel: 64,
    centrePinion: 8, greatWheel: 96
};
// 30 teeth, half a tooth per beat, so 60 beats turn it exactly once.
const BEATS_PER_ESC_TURN = N_ESC * 2;
// centre arbor turns once an hour: 60 escape turns to one centre turn
const ESC_PER_CENTRE = (TRAIN.thirdWheel / TRAIN.escPinion) * (TRAIN.centreWheel / TRAIN.thirdPinion);
// the great wheel turns twice a day, so an 8-day run is 16 fusee turns
const CENTRE_PER_GREAT = TRAIN.greatWheel / TRAIN.centrePinion;
const FUSEE_TURNS = 16;
// an 8-day clock: 2 turns of the great wheel a day, 16 on the fusee

// The fusee cone. The chain leaves it at r_take, and the cone is cut
// so that r_take rises at exactly the rate the mainspring dies.
const R_FUSEE_SMALL = 25, R_FUSEE_BIG = 45.5, R_BARREL = 40;
// A spring that falls to 55% over the run - which is exactly
// R_SMALL / R_BIG, and that is not a coincidence: the cone is cut
// so the growing leverage cancels the dying spring.
const fuseeRadius  = w => R_FUSEE_BIG - (R_FUSEE_BIG - R_FUSEE_SMALL) * w;

// Solve T = 2 s exactly, allowing for the circular error of a 3
// degree arc, and this is the length that falls out. It is the one
// number the whole clock is built around.
const NOM_LEN = 993.62;
const NOM_ARC = 3.0;                  // degrees each side of centre
const NUT_PITCH = 0.5;                // mm the bob moves per turn of the nut
const STOP_ARC = 0.9;                 // below this the escapement will not unlock

// The mainspring is left permanently wound: the fusee is doing
// its job, so how far down it is makes no difference to the rate.
const WIND = 0.7;
const DEFAULTS = { len: NOM_LEN, drive: 100 };
const P = Object.assign({}, DEFAULTS);

const state = {
    running: false,
    beats: 0,                          // clock seconds since midnight
    trueT: 0,                          // true seconds since midnight
    arc: NOM_ARC,                      // degrees, eased towards its target
    mult: 1,
    esc: 'dead',
    // 'clock' as it stands, 'movement' with the dial off, or
    // 'mech' with everything that is not a working part taken away.
    show: 'clock',
    sound: true, mesh: false, turntable: false,
    viewMode: 'blueprint',
    vphase: 0,                         // the pendulum as drawn, which may be slowed
    strike: null,                      // { left, phase, hour } while striking
    windAnim: 0                        // >0 while the key is being turned
};

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ---- the chain of consequences, all from one length ----------
// The length of the pendulum is the number the whole clock rests
// on, and the only one it can actually feel.
const lengthMM = () => P.len;
const period0 = () => 2 * Math.PI * Math.sqrt(lengthMM() / 1000 / G_ACC);

// How hard the train is pushing. The fusee makes this independent
// of how far the mainspring has run down, so all that is left is
// how strongly the spring was set up in the first place.
const w01 = () => WIND;
const driveFactor = () => P.drive / 100;
// Arc against drive: the impulse energy per beat has to make up the
// friction loss, and both go as the square of the arc.
const targetArc = () => {
    const d = driveFactor();
    return d <= 0 ? 0 : NOM_ARC * Math.sqrt(d);
};
// A real arc is not free: a wider swing takes slightly longer.
const theta0 = () => state.arc * Math.PI / 180;
const period = () => period0() * (1 + theta0() * theta0() / 16);
const beatSec = () => period() / 2;
// The clock counts one second per beat, so this is how many clock
// seconds it manages in a real one.
const clockRate = () => 2 / period();
const rateDay = () => 86400 * (clockRate() - 1);
const drift = () => state.beats - state.trueT;
// How many turns of the nut this length is away from the rating
const nutTurns = () => (P.len - NOM_LEN) / NUT_PITCH;

function willRun() { return targetArc() >= STOP_ARC; }

function signed(v, dp) {
    const s = v.toFixed(dp);
    return (v > 0 ? '+' : '') + s;
}

// =============================================================
//  The clock, in three dimensions
// =============================================================
// One millimetre is one unit. Every part of the movement is laid
// out in "plate coordinates": x and y measured from the centre
// arbor, which is also the middle of the dial. place() drops that
// into the world.
const DIAL_Y = 790;                   // world height of the dial centre
const STAND_TOP = 424;                // where the flat rod meets the movement
const SUSP_Y = 420;                   // the suspension, up on a back cock
const RING_R = 336;                   // the brass ring the movement is built in
const RING_CY = -20;

const BACK_Z = -129, BACK_T = 11;     // the one frame, z = -129 .. -118
const FRONT_Z = 0;                    // where the movement ends and the dial begins
// 110 mm of clear air between the two: the pendulum swings well
// in front of the stand, and reads as being in front of it.
const PEND_Z = -152;                  // the plane the pendulum swings in
const STAND_Z = -310;                 // the flat rod, a long way behind it

// Where each wheel sits along the arbors. A wheel meshes with the
// pinion of the next arbor along, so wheels and pinions alternate
// in depth as you work forward through the train.
const Z_GREAT = -112, Z_CENTRE = -90, Z_THIRD = -68, Z_ESC = -46;
const Z_FUSEE_A = -106, Z_FUSEE_B = -14;   // the cone, wide end at A

// The module is the size of one tooth. Every MESHING PAIR has to
// share a module - that is what makes the teeth fit - but a wheel
// and the pinion on its own arbor need not, and in a real clock
// they never do. Everything else about this layout is forced:
// two wheels mesh at exactly the sum of their pitch radii.
const M_GC = 2.00, M_CT = 1.70, M_TE = 2.90, M_MOTION = 3.00, M_STRIKE = 1.90;
const R_GREAT   = TRAIN.greatWheel   * M_GC / 2;     // 96.0
const R_CENT_P  = TRAIN.centrePinion * M_GC / 2;     //  8.0
const R_CENT_W  = TRAIN.centreWheel  * M_CT / 2;     // 54.4
const R_THIRD_P = TRAIN.thirdPinion  * M_CT / 2;     //  6.8
const R_THIRD_W = TRAIN.thirdWheel   * M_TE / 2;     // 87.0
const R_ESC_P   = TRAIN.escPinion    * M_TE / 2;     // 11.6
const R_ESC_W   = 52;                 // the escape wheel meshes with nothing

const A_C  = { x: 0, y: 0 };                          // centre arbor - the minute hand
const A_T  = { x: -10.6, y: 60.3 };                   // third
const A_E  = { x: 0, y: 158.3 };                      // escape - on the dial's centre line
const A_A  = { x: 0, y: 230.1 };                      // anchor arbor
const A_G  = { x: -97.7, y: -35.6 };                  // great wheel + going fusee
const A_B  = { x: -97.7, y: -185.6 };                 // going barrel
const A_G2 = { x: 97.7, y: -35.6 };                   // strike great wheel + fusee
const A_B2 = { x: 97.7, y: -185.6 };                  // strike barrel
const A_S1 = { x: 151.7, y: 57.9 };                   // pin wheel
const A_S2 = { x: 219.0, y: 46.0 };                   // fly
const A_HAM = { x: 200, y: 96 };                      // hammer pivot
const BELL_P = { x: 200, y: 440 };                    // and the bell it hits
const R_PIN_W = 64 * M_STRIKE / 2;    // 60.8
const PIN_CIRCLE = 46;

// Motion work, in front of the frame: cannon pinion 10 into a 30
// wheel, then an 8 pinion into a 32 wheel. 3 x 4 = 12.
const MOT = { cannon: 10, minute: 30, minPinion: 8, hour: 32 };
const R_CANNON = MOT.cannon    * M_MOTION / 2;   // 15
const R_MINW   = MOT.minute    * M_MOTION / 2;   // 45
const R_MINP   = MOT.minPinion * M_MOTION / 2;   // 12
const R_HOUR   = MOT.hour      * M_MOTION / 2;   // 48
const A_MW = { x: 28.2, y: -53.0 };              // 60 out from the centre
const Z_MOTION = 18, Z_HOUR = 30, Z_CANNON = 22;

// The dial is a painted ring, not a plate: the middle is left open
// so that everything the clock is doing shows straight through it.
// The dial's rim and the ring's outer edge are the same circle,
// so the slim gold bezel sits down on the metal that carries it.
const DIAL_OUT = RING_R + 16;         // 352
const Z_DIAL = 56;
// Centre seconds. The escape arbor turns once a minute, so a
// one-to-one link brings that to a pipe through the middle of the
// dial and a sweep hand goes on the front of it. Two meshes, so
// the direction comes back the right way round.
const M_SEC = 2.0;
const SEC_TEETH = 30, SEC_IDLER = 50;
const R_SEC = SEC_TEETH * M_SEC / 2;      // 30
const R_SECI = SEC_IDLER * M_SEC / 2;     // 50
const A_I = { x: 11.6, y: 79.15 };        // 80 from each - the sum of the radii
const Z_SEC = 2;

let scene, camera, renderer, controls;
let floor3, grid3;
let clockGrp, dialGrp, faceMesh, bezelGrp, standGrp;
let escWheel, anchorGrp, crutchGrp, pendGrp, rodBrass, bobGrp;
let handH, handM, handS;
let wGreat, wCentre, wThird, wCannon, wMinute, wHour;
let secDrive, secIdler, secCentre;
let fuseeGrp, barrelGrp, chainMesh = null, chainGrpHost = null;
let wGreat2, fuseeGrp2, barrelGrp2, chain2Mesh = null;
let pinWheel, flyGrp, hammerGrp, bellMesh;
let gl = false;
const MAT = {};

// ---- small geometry helpers ---------------------------------
function roundedBox(w, h, d, r) {
    const bev = Math.min(1.2, w / 6, h / 6, d / 6);
    const iw = Math.max(0.2, w - bev * 2), ih = Math.max(0.2, h - bev * 2);
    const rr = Math.max(0.2, Math.min(r, iw / 2 - 0.05, ih / 2 - 0.05));
    const sh = new THREE.Shape();
    const x = -iw / 2, y = -ih / 2;
    sh.moveTo(x + rr, y);
    sh.lineTo(x + iw - rr, y);
    sh.quadraticCurveTo(x + iw, y, x + iw, y + rr);
    sh.lineTo(x + iw, y + ih - rr);
    sh.quadraticCurveTo(x + iw, y + ih, x + iw - rr, y + ih);
    sh.lineTo(x + rr, y + ih);
    sh.quadraticCurveTo(x, y + ih, x, y + ih - rr);
    sh.lineTo(x, y + rr);
    sh.quadraticCurveTo(x, y, x + rr, y);
    const g = new THREE.ExtrudeGeometry(sh, {
        depth: Math.max(0.2, d - bev * 2), bevelEnabled: true,
        bevelSize: bev, bevelThickness: bev, bevelSegments: 2, curveSegments: 5
    });
    g.center();
    return g;
}

// A flat annulus, standing in the xy plane and extruded towards +z.
// Rings turn up everywhere in a clock: bosses, chapter rings, collets.
function ringGeo(rIn, rOut, depth, seg) {
    const sh = new THREE.Shape();
    sh.absarc(0, 0, rOut, 0, Math.PI * 2, false);
    const h = new THREE.Path();
    h.absarc(0, 0, rIn, 0, Math.PI * 2, true);
    sh.holes.push(h);
    return new THREE.ExtrudeGeometry(sh, {
        depth: depth, bevelEnabled: false, curveSegments: seg || 64
    });
}

// A flat bar that follows a run of points, with its own half-width
// at each one. The frame of a skeleton clock is nothing but this:
// metal laid along the lines between the pivots that need holding.
function ribbonShape(pts, hw) {
    const L = [], R = [];
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        let dx = b.x - a.x, dy = b.y - a.y;
        const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
        const w = Array.isArray(hw) ? hw[i] : hw;
        L.push([p.x - dy * w, p.y + dx * w]);
        R.push([p.x + dy * w, p.y - dx * w]);
    }
    const sh = new THREE.Shape();
    sh.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < L.length; i++) sh.lineTo(L[i][0], L[i][1]);
    for (let i = R.length - 1; i >= 0; i--) sh.lineTo(R[i][0], R[i][1]);
    sh.closePath();
    return sh;
}

// ---- wheels and pinions --------------------------------------
// A clock wheel's tooth is not the involute of a gearbox. It is a
// long, blunt epicycloid, made to drive a pinion of very few leaves
// without jamming. This is a fair likeness of one.
function toothPath(sh, teeth, ra, rp, rr) {
    const p = Math.PI * 2 / teeth;
    const P = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
    for (let i = 0; i < teeth; i++) {
        const a = i * p;
        const r0 = P(rr, a - p * 0.30);
        const c1 = P((rr + ra) / 2 * 1.06, a - p * 0.235);
        const t1 = P(ra, a - p * 0.105);
        const t2 = P(ra, a + p * 0.105);
        const c2 = P((rr + ra) / 2 * 1.06, a + p * 0.235);
        const r1 = P(rr, a + p * 0.30);
        if (i === 0) sh.moveTo(r0[0], r0[1]); else sh.lineTo(r0[0], r0[1]);
        sh.quadraticCurveTo(c1[0], c1[1], t1[0], t1[1]);
        sh.lineTo(t2[0], t2[1]);
        sh.quadraticCurveTo(c2[0], c2[1], r1[0], r1[1]);
        sh.absarc(0, 0, rr, a + p * 0.30, a + p * 0.70, false);
    }
    sh.closePath();
    return sh;
}

// One wheel: a toothed rim with the middle cut away, which is what
// "crossed out" means. A clock wheel only needs metal at the teeth
// and at the arbor, and taking the rest away makes it lighter, so
// there is less for the mainspring to accelerate every tick.
function wheelGroup(teeth, module, thick, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const rp = teeth * module / 2;
    const ra = rp + module * 0.82;
    const rr = rp - module * 0.55;
    const rin = Math.max((opts.hub || 9) + 7, rp - module * 4.2);
    const mat = opts.mat || MAT.brass;

    const sh = toothPath(new THREE.Shape(), teeth, ra, rp, rr);
    const hole = new THREE.Path();
    hole.absarc(0, 0, rin, 0, Math.PI * 2, true);
    sh.holes.push(hole);
    const rim = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, {
        depth: thick, bevelEnabled: false, curveSegments: 3
    }), mat);
    rim.castShadow = true; rim.receiveShadow = true;
    g.add(rim);

    // the crossings, tapered out from the collet
    const cross = opts.crossings === undefined ? 6 : opts.crossings;
    const hub = opts.hub || 9;
    for (let i = 0; i < cross; i++) {
        const a = i * Math.PI * 2 / cross;
        const bar = new THREE.Mesh(new THREE.ExtrudeGeometry(
            ribbonShape([{ x: hub * 0.6, y: 0 }, { x: (hub + rin) / 2, y: 0 }, { x: rin + 1.2, y: 0 }],
                [Math.max(2.8, rin * 0.082), Math.max(2.2, rin * 0.060), Math.max(1.9, rin * 0.050)]),
            { depth: thick, bevelEnabled: false }), mat);
        bar.rotation.z = a;
        bar.castShadow = true;
        g.add(bar);
    }
    const collet = new THREE.Mesh(new THREE.CylinderGeometry(hub, hub, thick * 1.9, 22), mat);
    collet.rotation.x = Math.PI / 2;
    collet.position.z = thick / 2;
    collet.castShadow = true;
    g.add(collet);
    g.userData.rp = rp;
    return g;
}

// A pinion has so few leaves that there is nothing to cross out:
// it is turned solid from steel and polished, and it is the part
// that wears. Drawn short and fat, the way they really are.
function pinionMesh(leaves, module, len, mat) {
    const rp = leaves * module / 2;
    const ra = rp + module * 0.95;
    const rr = rp - module * 0.72;
    const sh = toothPath(new THREE.Shape(), leaves, ra, rp, Math.max(1.2, rr));
    const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, {
        depth: len, bevelEnabled: false, curveSegments: 4
    }), mat || MAT.pinion);
    m.castShadow = true;
    return m;
}

// The escape wheel's teeth are nothing like the train's. Each one
// is a hook: a steep face at the front for the pallet to lock
// against, then a long hollow sweep back to the root. The wheel
// runs clockwise, so the steep face is the one that leads.
function escapeWheelGroup(teeth, rOut, thick) {
    const g = new THREE.Group();
    const rr = rOut * 0.80;
    const p = Math.PI * 2 / teeth;
    const P = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
    const sh = new THREE.Shape();
    for (let i = 0; i < teeth; i++) {
        const a = i * p;
        const root = P(rr, a);
        const tip = P(rOut, a + p * 0.15);
        const heel = P(rOut * 0.972, a + p * 0.33);
        const ctrl = P(rr * 0.90, a + p * 0.74);
        const nrt = P(rr, a + p);
        if (i === 0) sh.moveTo(root[0], root[1]); else sh.lineTo(root[0], root[1]);
        sh.lineTo(tip[0], tip[1]);
        sh.lineTo(heel[0], heel[1]);
        sh.quadraticCurveTo(ctrl[0], ctrl[1], nrt[0], nrt[1]);
    }
    sh.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, rr - 12, 0, Math.PI * 2, true);
    sh.holes.push(hole);
    const rim = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, {
        depth: thick, bevelEnabled: false, curveSegments: 3
    }), MAT.steelBright);
    rim.castShadow = true;
    g.add(rim);
    for (let i = 0; i < 5; i++) {
        const bar = new THREE.Mesh(new THREE.ExtrudeGeometry(
            ribbonShape([{ x: 5, y: 0 }, { x: rr - 11, y: 0 }], [3.4, 2.4]),
            { depth: thick, bevelEnabled: false }), MAT.steelBright);
        bar.rotation.z = i * Math.PI * 2 / 5;
        g.add(bar);
    }
    const collet = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, thick * 2.2, 18), MAT.steelBright);
    collet.rotation.x = Math.PI / 2; collet.position.z = thick / 2;
    g.add(collet);
    return g;
}

// Walnut, drawn once onto a canvas: long open grain with a
// couple of darker figures across it. Painted brown on its own
// reads as plastic; it is the grain that says wood.
let woodTex = null;
function woodTexture() {
    if (woodTex) return woodTex;
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#5a3620'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 130; i++) {
        const y = Math.random() * 512;
        g.strokeStyle = 'rgba(' + (Math.random() < 0.5 ? '38,20,10,' : '128,84,48,')
                      + (0.05 + Math.random() * 0.22) + ')';
        g.lineWidth = 0.6 + Math.random() * 3.4;
        g.beginPath(); g.moveTo(0, y);
        for (let x = 0; x <= 512; x += 24)
            g.lineTo(x, y + Math.sin(x / 70 + i) * (3 + (i % 5)));
        g.stroke();
    }
    for (let k = 0; k < 3; k++) {          // a little figure
        const cx = Math.random() * 512, cy = Math.random() * 512;
        for (let r = 4; r < 46; r += 3.2) {
            g.strokeStyle = 'rgba(46,26,13,' + (0.12 - r * 0.002) + ')';
            g.lineWidth = 1.4;
            g.beginPath(); g.ellipse(cx, cy, r * 2.1, r, 0.4, 0, Math.PI * 2); g.stroke();
        }
    }
    woodTex = new THREE.CanvasTexture(g.canvas);
    woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
    woodTex.anisotropy = 8;
    return woodTex;
}

// A soft pool of shade for the base to sit in. A directional key
// light throws one hard shadow off to the side; what actually makes
// an object look set down on a surface is the darkness right where
// the two meet, and no single light gives you that.
let shadowTex = null;
function shadowTexture() {
    if (shadowTex) return shadowTex;
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(128, 128, 8, 128, 128, 126);
    gr.addColorStop(0.00, 'rgba(0,0,0,0.60)');
    gr.addColorStop(0.40, 'rgba(0,0,0,0.44)');
    gr.addColorStop(0.62, 'rgba(0,0,0,0.20)');
    gr.addColorStop(0.82, 'rgba(0,0,0,0.06)');
    gr.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    shadowTex = new THREE.CanvasTexture(c);
    return shadowTex;
}

// The maker's name, inlaid into the base. Drawn as a texture and
// then given a high metalness, so the letters take a real gold
// specular off the key light instead of being flat yellow paint.
let brandTex = null;
function brandTexture() {
    if (brandTex) return brandTex;
    const S = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const txt = 'TCE-LABS', size = 102, track = 10, R = 446;
    g.font = 'bold ' + size + 'px Inter, Helvetica, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';

    // Set round the front of the base, on a circle struck from the
    // same centre the base was turned about. Each letter is placed
    // at its own angle and stood upright on the arc, which is the
    // only way the word follows the rim instead of cutting across
    // it. The canvas is laid face up, so its bottom edge is the
    // front of the clock and letter tops point away from the
    // reader - a page lying on a table, not standing up.
    let total = 0;
    for (const ch of txt) total += (g.measureText(ch).width + track) / R;
    total -= track / R;

    g.translate(S / 2, S / 2);
    let a = total / 2;
    for (const ch of txt) {
        const w = g.measureText(ch).width;
        a -= (w / 2) / R;
        g.save();
        g.rotate(a);
        g.translate(0, R);
        // a hairline of shadow under the letter, which is what
        // makes an inlay read as sunk into the wood rather than
        // printed on top of it
        g.fillStyle = 'rgba(30,16,6,0.55)';
        g.fillText(ch, 2, 5);
        g.fillStyle = '#e0b356';
        g.fillText(ch, 0, 0);
        g.restore();
        a -= (w / 2 + track) / R;
    }

    brandTex = new THREE.CanvasTexture(c);
    brandTex.anisotropy = 8;
    return brandTex;
}

// The dial face, drawn once onto a canvas. It is a RING, not a
// disc: the middle is left clear so the train shows through, and
// the whole thing can be switched off to see the escapement.
let dialTex = null;
function dialTexture() {
    if (dialTex) return dialTex;
    const PX = 2;                              // pixels per millimetre
    const S = 780 * PX;                        // 780 mm square
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const X = x => S / 2 + x * PX, Y = y => S / 2 - y * PX;
    const ring = (cx, cy, r0, r1, fill) => {
        g.beginPath();
        g.arc(X(cx), Y(cy), r1 * PX, 0, Math.PI * 2);
        g.arc(X(cx), Y(cy), r0 * PX, 0, Math.PI * 2, true);
        g.fillStyle = fill; g.fill();
    };
    const spoke = (cx, cy, a, r0, r1, w, col) => {
        g.strokeStyle = col; g.lineWidth = w * PX; g.lineCap = 'butt';
        g.beginPath();
        g.moveTo(X(cx + Math.cos(a) * r0), Y(cy + Math.sin(a) * r0));
        g.lineTo(X(cx + Math.cos(a) * r1), Y(cy + Math.sin(a) * r1));
        g.stroke();
    };

    // The face is solid: switch it off and the whole movement is
    // there behind it, which is the point of the toggle.
    g.beginPath(); g.arc(X(0), Y(0), DIAL_OUT * PX, 0, Math.PI * 2);
    g.fillStyle = '#faf8f3'; g.fill();

    // the minute track: sixty divisions, every fifth one heavier
    for (let k = 0; k < 60; k++) {
        const a = Math.PI / 2 - k * Math.PI / 30, big = k % 5 === 0;
        spoke(0, 0, a, big ? 300 : 313, 332, big ? 5.5 : 2.2, '#2b3038');
    }

    // Plain arabic figures, because the job of a dial is to be
    // read across a room and nothing else.
    g.fillStyle = '#191d23';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold ' + Math.round(62 * PX) + 'px Inter, Helvetica, Arial, sans-serif';
    for (let h = 1; h <= 12; h++) {
        const a = Math.PI / 2 - h * Math.PI / 6;
        g.fillText(String(h), X(Math.cos(a) * 268), Y(Math.sin(a) * 268) + 2 * PX);
    }

    // The maker's name, set in an arc under the XII the way a name
    // goes on a crest. Engraved serif, widely tracked and small -
    // a dial that shouts its own maker is a cheap dial.
    // The radius matters as much as the words. Struck too near
    // the middle the name curves far tighter than anything else on
    // the dial and reads as a separate, wonkier circle; set just
    // under the figures its curve runs parallel to theirs and to
    // the minute track, and the eye takes it as part of the dial.
    // Down on the level of the X and the II, in the middle of the
    // open ground under the XII. Dropping the radius tightens the
    // arc for a given length of word, so the setting comes in with
    // it - otherwise the name starts curving harder than anything
    // else on the dial, which is what makes it look stuck on.
    const brand = 'TCE-LABS', bR = 150, bTrack = 2.5 * PX;
    g.font = '' + Math.round(14 * PX) + 'px Georgia, "Times New Roman", Times, serif';
    let bTotal = 0;
    for (const ch of brand) bTotal += (g.measureText(ch).width + bTrack) / (bR * PX);
    bTotal -= bTrack / (bR * PX);

    g.save();
    g.translate(X(0), Y(0));
    g.fillStyle = '#a87f26';
    let bA = -bTotal / 2;
    for (const ch of brand) {
        const cw = g.measureText(ch).width;
        bA += (cw / 2) / (bR * PX);
        g.save();
        g.rotate(bA);              // round the arc, clockwise from XII
        g.translate(0, -bR * PX);  // out to the radius the name sits on
        g.fillText(ch, 0, 0);      // upright, its top facing the rim
        g.restore();
        bA += (cw / 2 + bTrack) / (bR * PX);
    }
    // a small point either side, which is what stops a name in an
    // arc reading as a stray word
    [-1, 1].forEach(sg => {
        const a = sg * (bTotal / 2 + 0.085);
        g.save(); g.rotate(a); g.translate(0, -bR * PX);
        g.beginPath(); g.arc(0, -4, 2.1 * PX, 0, Math.PI * 2); g.fill();
        g.restore();
    });
    g.restore();

    dialTex = new THREE.CanvasTexture(c);
    dialTex.anisotropy = 8;
    return dialTex;
}

// A hand: flat blackened steel with a gilt chamfer round the
// edge, which is how they are really finished - and it is the only
// treatment that stays readable everywhere this one has to be. A
// flat colour cannot: dark hands disappear into the dark ground
// with the case off, gilt ones disappear into the brass, and light
// ones disappear into the dial. An outline reads against all three.
// ExtrudeGeometry puts the flat faces in material slot 0 and the
// walls in slot 1, so the two finishes come for free.
function handMesh(len, tail, wide, depth, mat) {
    const sh = new THREE.Shape();
    const bw = wide, tw = wide * 0.30;
    sh.moveTo(-bw * 0.7, -tail);
    sh.quadraticCurveTo(-bw * 1.1, -tail * 0.2, -bw, 0);
    sh.lineTo(-bw * 0.85, len * 0.30);
    sh.quadraticCurveTo(-bw * 1.35, len * 0.45, -bw * 0.55, len * 0.60);
    sh.lineTo(-tw, len * 0.80);
    sh.lineTo(0, len);
    sh.lineTo(tw, len * 0.80);
    sh.lineTo(bw * 0.55, len * 0.60);
    sh.quadraticCurveTo(bw * 1.35, len * 0.45, bw * 0.85, len * 0.30);
    sh.lineTo(bw, 0);
    sh.quadraticCurveTo(bw * 1.1, -tail * 0.2, bw * 0.7, -tail);
    sh.quadraticCurveTo(0, -tail * 1.3, -bw * 0.7, -tail);
    const hole = new THREE.Path();
    hole.absarc(0, len * 0.42, bw * 0.42, 0, Math.PI * 2, true);
    sh.holes.push(hole);
    // Wide enough to see, never so wide it eats a thin hand.
    const bev = Math.min(1.2, wide * 0.14);
    const g = new THREE.ExtrudeGeometry(sh, {
        depth: depth, bevelEnabled: true, bevelSize: bev,
        bevelThickness: bev * 0.8, bevelSegments: 2, curveSegments: 10
    });
    const m = new THREE.Mesh(g, [mat || MAT.handDark, MAT.handEdge]);
    m.castShadow = true;
    return m;
}

function init3D() {
    const host = $('view3d');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);

    camera = new THREE.PerspectiveCamera(40, 1, 20, 12000);
    camera.position.set(920, 740, 1900);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 200;
    controls.maxDistance = 6000;
    controls.maxPolarAngle = Math.PI / 2 + 0.02;
    controls.autoRotateSpeed = 0.8;
    controls.target.set(0, 590, -90);

    scene.add(new THREE.AmbientLight(0xffffff, 0.30));
    const key = new THREE.DirectionalLight(0xfff4e2, 0.78);
    key.position.set(900, 2000, 1500);
    key.castShadow = true;
    key.shadow.mapSize.width = key.shadow.mapSize.height = 2048;
    // Tight to what the clock actually occupies: a frustum any
    // bigger just spends shadow-map resolution on empty floor.
    key.shadow.camera.left = -820; key.shadow.camera.right = 820;
    key.shadow.camera.top = 1500; key.shadow.camera.bottom = -260;
    key.shadow.camera.far = 4600;
    // A large negative bias was pushing the shadow off the object
    // and losing the contact edge. normalBias fixes the acne
    // without detaching it.
    key.shadow.bias = -0.00015;
    key.shadow.normalBias = 1.6;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4f0, 0.26);
    fill.position.set(-1200, 900, -700); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.30);
    rim.position.set(0, 800, -1800); scene.add(rim);

    // Brass is almost nothing but reflection. Without something in
    // the sky to bounce off it renders as flat mustard paint, so
    // here is a room in six brush strokes: a bright ceiling with a
    // pair of windows, a warm wall, and a dark floor.
    const ec = document.createElement('canvas');
    ec.width = 256; ec.height = 128;
    const eg = ec.getContext('2d');
    const sky = eg.createLinearGradient(0, 0, 0, 128);
    sky.addColorStop(0, '#ffffff'); sky.addColorStop(0.40, '#c9ccd2');
    sky.addColorStop(0.52, '#6b6560'); sky.addColorStop(1, '#22242a');
    eg.fillStyle = sky; eg.fillRect(0, 0, 256, 128);
    eg.fillStyle = '#ffffff';
    eg.fillRect(24, 34, 46, 30); eg.fillRect(150, 34, 46, 30);   // two windows
    eg.fillStyle = '#f6e4c4'; eg.fillRect(0, 0, 256, 10);        // warm ceiling
    const pm = new THREE.PMREMGenerator(renderer);
    pm.compileEquirectangularShader();
    const et = new THREE.CanvasTexture(ec);
    et.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = pm.fromEquirectangular(et).texture;
    et.dispose(); pm.dispose();

    floor3 = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000),
        new THREE.MeshStandardMaterial({ color: 0x131c2e, roughness: 0.9 }));
    floor3.rotation.x = -Math.PI / 2;
    floor3.position.y = -1;
    floor3.receiveShadow = true;
    scene.add(floor3);
    grid3 = new THREE.GridHelper(8000, 80, 0x334155, 0x1e293b);
    scene.add(grid3);

    // The colours of an English skeleton clock: everything that can
    // be brass is brass, everything that has to be hard is steel,
    // and the hands are blackened steel.
    MAT.brass       = new THREE.MeshStandardMaterial({ color: 0xb28e3c, metalness: 0.90, roughness: 0.25 });
    MAT.brassBright = new THREE.MeshStandardMaterial({ color: 0xb8933f, metalness: 0.95, roughness: 0.16 });
    MAT.brassDark   = new THREE.MeshStandardMaterial({ color: 0x7d6229, metalness: 0.88, roughness: 0.38 });
    MAT.frame       = new THREE.MeshStandardMaterial({ color: 0xa4832f, metalness: 0.92, roughness: 0.26 });
    MAT.pinion      = new THREE.MeshStandardMaterial({ color: 0x9aa1ac, metalness: 0.97, roughness: 0.10 });
    MAT.steelBright = new THREE.MeshStandardMaterial({ color: 0xa8b0ba, metalness: 0.96, roughness: 0.12 });
    MAT.steelDark   = new THREE.MeshStandardMaterial({ color: 0x545b66, metalness: 0.90, roughness: 0.24 });
    // Blackened steel hands. Gilt looked well on the white dial and
    // then disappeared completely into the brass behind it with the
    // dial off - and the hands have to be readable in both. Kept
    // part metallic so the edges still catch a highlight and the
    // hand does not go flat.
    MAT.handDark    = new THREE.MeshStandardMaterial({ color: 0x15181d, metalness: 0.45, roughness: 0.28 });
    // The chamfer, gilt and polished. This is the edge that
    // outlines the hand against a dark ground, so it wants to be a
    // mirror - brighter and smoother than the brass of the
    // movement, or it stops separating the hand from the wheels.
    MAT.handEdge    = new THREE.MeshStandardMaterial({ color: 0xe8c465, metalness: 0.98, roughness: 0.055 });
    // The seconds hand is lacquered, not metal - which is exactly
    // why it stays legible from across a room.
    MAT.handRed     = new THREE.MeshStandardMaterial({ color: 0xb3241a, metalness: 0.15, roughness: 0.36 });
    MAT.chain       = new THREE.MeshStandardMaterial({ color: 0x6e757f, metalness: 0.95, roughness: 0.24 });
    // Brushed titanium: cool and bright against the warm movement,
    // so the clock and the thing holding it read as two objects. Kept
    // a little rough on purpose - polished to a mirror it would blow
    // out to flat white under the key light and lose all its shape.
    MAT.titanium    = new THREE.MeshStandardMaterial({ color: 0xb6c0cb, metalness: 0.96, roughness: 0.21 });
    MAT.dialFace    = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.0, roughness: 0.55,
                                                       transparent: true, alphaTest: 0.45, side: THREE.DoubleSide });
    MAT.brand       = new THREE.MeshStandardMaterial({
        color: 0xffffff, map: brandTexture(), metalness: 0.55, roughness: 0.31,
        transparent: true, alphaTest: 0.30, side: THREE.DoubleSide });
    MAT.slate       = new THREE.MeshStandardMaterial({ color: 0x23262c, metalness: 0.16, roughness: 0.42 });
    // French-polished walnut: hard, glossy, and it takes a
    // reflection - which is what separates it from matte plastic.
    MAT.wood        = new THREE.MeshStandardMaterial({
        color: 0xffffff, map: woodTexture(), metalness: 0.04, roughness: 0.30 });

    MAT.brass.envMapIntensity = 1.5;
    MAT.brassBright.envMapIntensity = 2.0;
    MAT.brassDark.envMapIntensity = 1.2;
    MAT.frame.envMapIntensity = 1.6;
    MAT.pinion.envMapIntensity = 2.4;
    MAT.steelBright.envMapIntensity = 2.2;
    MAT.steelDark.envMapIntensity = 1.5;
    MAT.handDark.envMapIntensity = 0.75;
    MAT.handEdge.envMapIntensity = 2.9;
    MAT.handRed.envMapIntensity = 0.5;
    MAT.chain.envMapIntensity = 1.8;
    MAT.titanium.envMapIntensity = 1.7;
    MAT.dialFace.envMapIntensity = 0.25;
    MAT.brand.envMapIntensity = 1.3;
    MAT.contact = new THREE.MeshBasicMaterial({
        map: shadowTexture(), transparent: true, depthWrite: false });
    MAT.slate.envMapIntensity = 0.35;
    MAT.wood.envMapIntensity = 0.55;

    buildClock();
}

// Drop something laid out in plate coordinates into the world.
function place(obj, p, z) {
    obj.position.set(p.x, DIAL_Y + p.y, z);
    return obj;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// =============================================================
//  Building it
// =============================================================
function buildClock() {
    clockGrp = new THREE.Group();
    scene.add(clockGrp);
    buildStand();
    clockGrp.add(buildFrame(BACK_Z));
    buildTrain();
    buildFusees();
    buildStrike();
    buildEscapement();
    buildMotionWork();
    buildDial();
    buildPendulum();
}

// The stand. One flat rod of nickel out of a round foot, with the
// whole movement bolted to the top of it - a pedestal fan, near
// enough. Everything above it is brass and the stand deliberately
// is not, so the eye separates the clock from what holds it up.
function buildStand() {
    const g = standGrp = new THREE.Group();
    const Z = STAND_Z + 10;
    // The foot is centred under the CLOCK, not under the rod, or
    // the whole thing looks as though it is about to fall forwards.
    const FZ = (Z + PEND_Z) / 2 + 20;

    const contact = new THREE.Mesh(new THREE.PlaneGeometry(820, 740), MAT.contact);
    contact.rotation.x = -Math.PI / 2;
    contact.position.set(0, 1.4, FZ);
    g.add(contact);

    const foot = new THREE.Mesh(new THREE.CylinderGeometry(238, 256, 24, 72), MAT.wood);
    foot.position.set(0, 12, FZ);
    foot.scale.z = 1.06;
    foot.castShadow = foot.receiveShadow = true; g.add(foot);
    // a brass bead in the moulding, which is what a turner would do
    const bead = new THREE.Mesh(new THREE.CylinderGeometry(220, 220, 5, 64), MAT.brassBright);
    bead.position.set(0, 26, FZ);
    bead.scale.z = 1.06;
    bead.castShadow = true; g.add(bead);
    const step = new THREE.Mesh(new THREE.CylinderGeometry(180, 212, 18, 64), MAT.wood);
    step.position.set(0, 37, FZ);
    step.scale.z = 1.06;
    step.castShadow = step.receiveShadow = true; g.add(step);
    // The maker's name, inlaid in the timber in front of the rod.
    // Laid face up, and turned so it reads from the front.
    // 344 mm square on a base 360 across, struck about the same
    // centre, so the lettering and the turning agree.
    const brand = new THREE.Mesh(new THREE.PlaneGeometry(344, 344), MAT.brand);
    // -90 about x, not +90: that lays the face upwards AND puts the
    // top of the letters away from the reader, which is how a page
    // lies on a table. The other way round comes out mirrored.
    brand.rotation.x = -Math.PI / 2;
    brand.position.set(0, 46.8, FZ);
    g.add(brand);

    // A plain plate over the joint, the way a rod is really let
    // into a base - no flare, no fillet, nothing to look at.
    const plate = new THREE.Mesh(roundedBox(124, 9, 50, 3), MAT.titanium);
    plate.position.set(0, 50, Z);
    plate.castShadow = true; g.add(plate);

    // The rod is flat, not round: stiff across the swing of the
    // pendulum, where it has to be, and slim from the front,
    // where it would otherwise be in the way.
    const y0 = 40, y1 = STAND_TOP;
    const rod = new THREE.Mesh(new THREE.ExtrudeGeometry(
        ribbonShape([{ x: 0, y: y0 }, { x: 0, y: (y0 + y1) / 2 }, { x: 0, y: y1 }],
                    [52, 42, 33]),
        { depth: 20, bevelEnabled: true, bevelSize: 2, bevelThickness: 2,
          bevelSegments: 2, curveSegments: 2 }), MAT.titanium);
    rod.position.set(0, 0, Z - 10);
    rod.castShadow = true; g.add(rod);

    // Two arms carrying the movement forward off the rod, with a
    // gap between them for the pendulum to hang down through.
    // Two arms cantilevering the movement well forward of the
    // rod, with an open channel between them. The pendulum hangs
    // down that channel and never comes near the stand.
    const reach = (BACK_Z - 6) - Z;
    [-58, 58].forEach(x => {
        const arm = new THREE.Mesh(roundedBox(28, 30, reach, 6), MAT.titanium);
        arm.position.set(x, y1 - 6, Z + reach / 2);
        arm.castShadow = true; g.add(arm);
        const bolt = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 22, 14), MAT.titanium);
        bolt.rotation.x = Math.PI / 2;
        bolt.position.set(x, y1 - 6, Z + reach - 4);
        g.add(bolt);
    });
    const web = new THREE.Mesh(roundedBox(134, 26, 18, 5), MAT.titanium);
    web.position.set(0, y1 - 6, Z + 6);
    g.add(web);

    clockGrp.add(g);
}

// The frame. One brass ring with bars across it, and every arbor
// in the clock runs through those bars. A solid plate would hold
// the pivots just as well - but then none of this would be worth
// looking at, which is the whole point of the thing.
function buildFrame(z) {
    const g = new THREE.Group();
    const bars = [
        [A_C, A_T, 9], [A_T, A_E, 9], [A_E, A_A, 8], [A_C, A_G, 9],
        [A_G, A_B, 8], [A_G, A_G2, 8], [A_G2, A_B2, 8],
        [A_G2, A_S1, 8], [A_S1, A_S2, 7],
        [A_B, { x: -230, y: -268 }, 8], [A_B2, { x: 230, y: -268 }, 8],
        [A_S2, { x: 324, y: 67 }, 7], [A_C, { x: -336, y: -20 }, 8],
        [A_C, { x: 0, y: -356 }, 8], [A_A, { x: 0, y: 316 }, 8]
    ];
    bars.forEach(([a, b, w]) => {
        const m = new THREE.Mesh(new THREE.ExtrudeGeometry(
            ribbonShape([a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, b], [w, w * 0.82, w]),
            { depth: BACK_T, bevelEnabled: false }), MAT.frame);
        m.position.z = z;
        m.castShadow = true;
        g.add(m);
    });

    const ring = new THREE.Mesh(ringGeo(RING_R - 16, RING_R + 16, BACK_T, 140), MAT.frame);
    ring.position.set(0, RING_CY, z);
    ring.castShadow = true;
    g.add(ring);

    // A polished boss round every pivot: the hole has to be in
    // something thicker than the bar, or the arbor wears it oval.
    [A_C, A_T, A_E, A_A, A_G, A_B, A_G2, A_B2, A_S1, A_S2].forEach(p => {
        const b = new THREE.Mesh(ringGeo(3.6, 15, BACK_T + 4, 28), MAT.brassBright);
        b.position.set(p.x, p.y, z - 2);
        b.castShadow = true;
        g.add(b);
    });

    g.position.y = DIAL_Y;
    return g;
}

// An arbor: a length of polished steel with a pivot turned on each
// end. It is the only thing in the movement that touches both frames.
function arbor(p, z0, z1, r) {
    const g = new THREE.Group();
    const len = z1 - z0;
    const s = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14), MAT.steelBright);
    s.rotation.x = Math.PI / 2;
    s.castShadow = true;
    g.add(s);
    place(g, p, (z0 + z1) / 2);
    clockGrp.add(g);
    return g;
}

// The going train. Four arbors, and between them nothing but
// division: 8 into 60, 8 into 64, 8 into 96. Read from the top,
// it turns one beat a second into one turn an hour.
function buildTrain() {
    arbor(A_G, Z_GREAT - 10, Z_FUSEE_B + 16, 5);
    arbor(A_C, Z_GREAT - 10, Z_CANNON + 10, 5);
    arbor(A_T, Z_GREAT - 10, FRONT_Z + 6, 4.5);
    arbor(A_E, Z_GREAT - 10, Z_SEC + 18, 4);

    wGreat = wheelGroup(TRAIN.greatWheel, M_GC, 7, { crossings: 6, hub: 16 });
    place(wGreat, A_G, Z_GREAT - 3.5);
    clockGrp.add(wGreat);

    // Centre arbor: the little pinion at the back takes the drive,
    // the big wheel in front of it passes it on, and the hands hang
    // off the front end. One turn an hour, all the way through.
    wCentre = new THREE.Group();
    const cp = pinionMesh(TRAIN.centrePinion, M_GC, 15);
    cp.position.z = Z_GREAT - 7.5;
    wCentre.add(cp);
    const cw = wheelGroup(TRAIN.centreWheel, M_CT, 6, { crossings: 6, hub: 14 });
    cw.position.z = Z_CENTRE - 3;
    wCentre.add(cw);
    place(wCentre, A_C, 0);
    clockGrp.add(wCentre);

    wThird = new THREE.Group();
    const tp = pinionMesh(TRAIN.thirdPinion, M_CT, 14);
    tp.position.z = Z_CENTRE - 7;
    wThird.add(tp);
    const tw = wheelGroup(TRAIN.thirdWheel, M_TE, 5.5, { crossings: 5, hub: 12 });
    tw.position.z = Z_THIRD - 2.75;
    wThird.add(tw);
    place(wThird, A_T, 0);
    clockGrp.add(wThird);
}

// A chain of little steel links. Drawn as one tube with a link
// texture on it, because five hundred separate links would cost
// more than the whole of the rest of the clock put together.
let chainTex = null;
function chainTexture() {
    if (chainTex) return chainTex;
    const c = document.createElement('canvas');
    c.width = 32; c.height = 16;
    const g = c.getContext('2d');
    g.fillStyle = '#5c636d'; g.fillRect(0, 0, 32, 16);
    g.fillStyle = '#aab2bd'; g.fillRect(2, 3, 12, 10);
    g.fillStyle = '#2e333a'; g.fillRect(15, 0, 3, 16);
    g.fillStyle = '#8d95a1'; g.fillRect(19, 5, 10, 6);
    chainTex = new THREE.CanvasTexture(c);
    chainTex.wrapS = chainTex.wrapT = THREE.RepeatWrapping;
    return chainTex;
}

// The fusee: a cone with a spiral groove, the great wheel on its
// wide end, and a chain running down to the spring barrel. When
// the spring is strong the chain pulls at the narrow end, where it
// has least leverage. As the spring dies the chain works out to the
// wide end. The cone's taper is cut so the product of the two
// stays the same all week.
function fuseeCone() {
    const g = new THREE.Group();
    const len = Z_FUSEE_B - Z_FUSEE_A;
    const pts = [];
    pts.push(new THREE.Vector2(0, 0));
    pts.push(new THREE.Vector2(R_FUSEE_BIG + 4, 0));
    pts.push(new THREE.Vector2(R_FUSEE_BIG + 4, 5));
    for (let i = 0; i <= 24; i++) {
        const s = i / 24;
        pts.push(new THREE.Vector2(R_FUSEE_BIG - (R_FUSEE_BIG - R_FUSEE_SMALL) * s, 5 + s * (len - 12)));
    }
    pts.push(new THREE.Vector2(R_FUSEE_SMALL + 4, len - 7));
    pts.push(new THREE.Vector2(R_FUSEE_SMALL + 4, len - 2));
    pts.push(new THREE.Vector2(8, len));
    pts.push(new THREE.Vector2(0, len));
    const cone = new THREE.Mesh(new THREE.LatheGeometry(pts, 44), MAT.brass);
    cone.rotation.x = -Math.PI / 2;      // the lathe axis becomes z
    cone.castShadow = true;
    g.add(cone);
    // the winding square on the front end, where the key goes
    const sq = new THREE.Mesh(new THREE.BoxGeometry(13, 13, 20), MAT.steelDark);
    sq.position.z = len + 10;
    sq.castShadow = true;
    g.add(sq);
    return g;
}

function barrelGroup(len) {
    const g = new THREE.Group();
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(R_BARREL, R_BARREL, len, 40), MAT.brass);
    drum.rotation.x = Math.PI / 2;
    drum.castShadow = true;
    g.add(drum);
    [-len / 2 - 2, len / 2 + 2].forEach(z => {
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(R_BARREL + 3.5, R_BARREL + 3.5, 5, 40), MAT.brassBright);
        cap.rotation.x = Math.PI / 2; cap.position.z = z;
        cap.castShadow = true;
        g.add(cap);
    });
    // the click and its ratchet, which is what stops the spring
    // simply unwinding itself the moment you let go of the key
    const rat = new THREE.Mesh(ringGeo(12, 26, 4, 30), MAT.steelBright);
    rat.position.z = len / 2 + 6;
    g.add(rat);
    return g;
}

// Both chains are built the same way: a helix down the cone from
// the wide end to wherever the chain currently leaves it, a free
// span across to the barrel, then the rest wound on the barrel.
function chainCurve(from, to, w) {
    const pts = [];
    const turns = FUSEE_TURNS * w;
    const coneLen = (Z_FUSEE_B - Z_FUSEE_A) - 14;
    const toBarrel = Math.atan2(to.y - from.y, to.x - from.x);
    const phase = toBarrel - Math.PI * 2 * turns;
    const N = Math.max(2, Math.round(turns * 14));
    for (let i = 0; i <= N; i++) {
        const t = turns * i / N;
        const s = t / FUSEE_TURNS;
        const r = R_FUSEE_BIG - (R_FUSEE_BIG - R_FUSEE_SMALL) * s + 2.2;
        const a = phase + Math.PI * 2 * t;
        pts.push(new THREE.Vector3(from.x + r * Math.cos(a), DIAL_Y + from.y + r * Math.sin(a),
            Z_FUSEE_A + 6 + coneLen * s));
    }
    // the free span, then on to the barrel
    const bTurns = FUSEE_TURNS - turns;
    const bLen = 84;
    const M = Math.max(2, Math.round(bTurns * 12));
    const inA = Math.atan2(from.y - to.y, from.x - to.x);
    for (let i = 0; i <= M; i++) {
        const t = bTurns * i / M;
        const a = inA - Math.PI * 2 * t;
        const z = Z_GREAT - 2 + bLen * (t / FUSEE_TURNS);
        pts.push(new THREE.Vector3(to.x + (R_BARREL + 2.2) * Math.cos(a),
            DIAL_Y + to.y + (R_BARREL + 2.2) * Math.sin(a), z));
    }
    // A run-down fusee, or a full one, leaves one of the two
    // helices with no turns in it at all - and a curve through
    // three identical points gives a tube no direction to follow.
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++)
        if (pts[i].distanceTo(out[out.length - 1]) > 0.5) out.push(pts[i]);
    while (out.length < 3) out.push(out[out.length - 1].clone().addScalar(0.6));
    return new THREE.CatmullRomCurve3(out);
}

function makeChain(from, to, w) {
    const curve = chainCurve(from, to, w);
    const geo = new THREE.TubeGeometry(curve, Math.min(720, curve.points.length * 2), 2.1, 6, false);
    const m = new THREE.Mesh(geo, MAT.chainMat || (MAT.chainMat = (() => {
        const t = chainTexture().clone();
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(160, 1);
        t.needsUpdate = true;
        const mm = MAT.chain.clone();
        mm.map = t; mm.color.setHex(0xffffff);
        return mm;
    })()));
    m.castShadow = true;
    return m;
}

function buildFusees() {
    arbor(A_B, Z_GREAT - 10, Z_GREAT + 94, 5);
    arbor(A_B2, Z_GREAT - 10, Z_GREAT + 94, 5);

    fuseeGrp = fuseeCone();
    place(fuseeGrp, A_G, Z_FUSEE_A);
    clockGrp.add(fuseeGrp);
    barrelGrp = barrelGroup(84);
    place(barrelGrp, A_B, Z_GREAT + 42);
    clockGrp.add(barrelGrp);

    fuseeGrp2 = fuseeCone();
    place(fuseeGrp2, A_G2, Z_FUSEE_A);
    clockGrp.add(fuseeGrp2);
    barrelGrp2 = barrelGroup(84);
    place(barrelGrp2, A_B2, Z_GREAT + 42);
    clockGrp.add(barrelGrp2);

    chainGrpHost = new THREE.Group();
    clockGrp.add(chainGrpHost);
    rebuildChains(true);
}

let lastChainW = -1;
function rebuildChains(force) {
    const w = w01();
    if (!force && Math.abs(w - lastChainW) < 0.006) return;
    lastChainW = w;
    [chainMesh, chain2Mesh].forEach(m => { if (m) { chainGrpHost.remove(m); m.geometry.dispose(); } });
    chainMesh = makeChain(A_G, A_B, w);
    chain2Mesh = makeChain(A_G2, A_B2, w);
    chainGrpHost.add(chainMesh); chainGrpHost.add(chain2Mesh);
}

// The striking side. Its own spring, its own fusee, its own great
// wheel - and instead of a pendulum to hold it back, a fly: two
// paddles beating the air, which is the whole of what decides how
// fast the blows come.
function buildStrike() {
    arbor(A_G2, Z_GREAT - 10, Z_FUSEE_B + 16, 5);
    arbor(A_S1, Z_GREAT - 10, FRONT_Z + 6, 4.5);
    arbor(A_S2, Z_GREAT - 10, FRONT_Z + 6, 4);

    wGreat2 = wheelGroup(TRAIN.greatWheel, M_GC, 7, { crossings: 6, hub: 16 });
    place(wGreat2, A_G2, Z_GREAT - 3.5);
    clockGrp.add(wGreat2);

    pinWheel = new THREE.Group();
    const sp = pinionMesh(12, M_GC, 15);
    sp.position.z = Z_GREAT - 7.5;
    pinWheel.add(sp);
    const pw = wheelGroup(64, M_STRIKE, 6, { crossings: 5, hub: 12 });
    pw.position.z = Z_CENTRE - 3;
    pinWheel.add(pw);
    // eight pins standing out of its face: each one lifts the
    // hammer and drops it, and eight pins is eight blows a turn
    for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        const pin = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 18, 12), MAT.steelBright);
        pin.rotation.x = Math.PI / 2;
        pin.position.set(PIN_CIRCLE * Math.cos(a), PIN_CIRCLE * Math.sin(a), Z_CENTRE + 11);
        pinWheel.add(pin);
    }
    place(pinWheel, A_S1, 0);
    clockGrp.add(pinWheel);

    flyGrp = new THREE.Group();
    const fp = pinionMesh(8, M_STRIKE, 14);
    fp.position.z = Z_CENTRE - 7;
    flyGrp.add(fp);
    for (let i = 0; i < 2; i++) {
        const bl = new THREE.Mesh(roundedBox(52, 30, 1.6, 3), MAT.brassBright);
        bl.position.set((i ? -1 : 1) * 32, 0, Z_THIRD);
        bl.rotation.y = (i ? -1 : 1) * 0.3;
        bl.castShadow = true;
        flyGrp.add(bl);
    }
    const fh = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 10, 14), MAT.brass);
    fh.rotation.x = Math.PI / 2; fh.position.z = Z_THIRD;
    flyGrp.add(fh);
    place(flyGrp, A_S2, 0);
    clockGrp.add(flyGrp);

    // the bell, and the hammer that has to reach up to it
    // Down the outside from the crown to the rim, round the lip,
    // and back up the inside. A bell is a thin shell that flares,
    // which is exactly why it rings instead of just thudding.
    bellMesh = new THREE.Mesh(new THREE.LatheGeometry([
        new THREE.Vector2(0, 0),   new THREE.Vector2(19, 0),  new THREE.Vector2(27, 3),
        new THREE.Vector2(32, 10), new THREE.Vector2(34, 21), new THREE.Vector2(36, 39),
        new THREE.Vector2(40, 59), new THREE.Vector2(47, 79), new THREE.Vector2(57, 99),
        new THREE.Vector2(67, 113), new THREE.Vector2(70, 119),
        new THREE.Vector2(68, 121), new THREE.Vector2(61, 120),
        new THREE.Vector2(53, 105), new THREE.Vector2(44, 87), new THREE.Vector2(37, 67),
        new THREE.Vector2(32, 47),  new THREE.Vector2(29, 27), new THREE.Vector2(25, 13),
        new THREE.Vector2(19, 6),   new THREE.Vector2(0, 6)
    ], 44), MAT.brassBright);
    bellMesh.rotation.z = Math.PI;      // hang it crown up
    place(bellMesh, BELL_P, -60);
    bellMesh.castShadow = true;
    clockGrp.add(bellMesh);
    const std = new THREE.Mesh(new THREE.CylinderGeometry(6, 8, 176, 14), MAT.brass);
    place(std, { x: BELL_P.x, y: BELL_P.y - 86 }, -60);
    clockGrp.add(std);

    hammerGrp = new THREE.Group();
    const arm = new THREE.Mesh(new THREE.ExtrudeGeometry(
        ribbonShape([{ x: 0, y: 0 }, { x: 24, y: 127 }, { x: 47, y: 254 }], [6.5, 5.2, 4.4]),
        { depth: 5, bevelEnabled: false }), MAT.steelDark);
    hammerGrp.add(arm);
    const head = new THREE.Mesh(new THREE.SphereGeometry(11, 18, 14), MAT.steelBright);
    head.position.set(47, 254, 2.5);
    head.castShadow = true;
    hammerGrp.add(head);
    const tail = new THREE.Mesh(new THREE.ExtrudeGeometry(
        ribbonShape([{ x: 0, y: 0 }, { x: -80, y: -15 }], [5, 3.6]),
        { depth: 5, bevelEnabled: false }), MAT.steelDark);
    hammerGrp.add(tail);
    place(hammerGrp, A_HAM, Z_CENTRE + 14);
    clockGrp.add(hammerGrp);
}

// The escapement. Everything up to here has been counting; this is
// the one place where the counting and the timekeeping touch.
function buildEscapement() {
    escWheel = new THREE.Group();
    const ep = pinionMesh(TRAIN.escPinion, M_TE, 13);
    ep.position.z = Z_THIRD - 6.5;
    escWheel.add(ep);
    const ew = escapeWheelGroup(N_ESC, R_ESC_W, 4.5);
    ew.position.z = Z_ESC - 2.25;
    escWheel.add(ew);
    place(escWheel, A_E, 0);
    clockGrp.add(escWheel);

    // The anchor. Its two pallets sit on the escape wheel a
    // quarter of a turn apart, and it rocks with the pendulum -
    // one tooth let go for every full swing, out and back.
    const px = R_ESC_W * Math.SQRT1_2;                  // 36.06
    const py = (A_E.y + R_ESC_W * Math.SQRT1_2) - A_A.y; // -36.34
    anchorGrp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ExtrudeGeometry(
        ribbonShape([{ x: -px, y: py }, { x: -26, y: -4 }, { x: 0, y: 15 },
                     { x: 26, y: -4 }, { x: px, y: py }],
                    [8, 10.5, 13, 10.5, 8]),
        { depth: 8, bevelEnabled: false }), MAT.steelBright);
    body.castShadow = true;
    anchorGrp.add(body);
    // The pallets themselves. On a dead-beat the locking face is
    // an arc struck about this very pivot, so a tooth resting on
    // it cannot drive the anchor either way - hence "dead".
    [[-1, 1], [1, -1]].forEach(([sx, lean]) => {
        const pal = new THREE.Mesh(roundedBox(12, 15, 9, 1.5), MAT.steelDark);
        pal.position.set(sx * px, py, 4);
        pal.rotation.z = sx * 0.62 + lean * 0.06;
        pal.castShadow = true;
        anchorGrp.add(pal);
    });
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 16, 20), MAT.steelBright);
    boss.rotation.x = Math.PI / 2; boss.position.z = 4;
    anchorGrp.add(boss);
    place(anchorGrp, A_A, Z_ESC - 4);
    clockGrp.add(anchorGrp);
    arbor(A_A, Z_ESC - 14, FRONT_Z + 6, 4);

    // The crutch: a rod hanging off the anchor's arbor with a fork
    // at the bottom that straddles the pendulum rod. It is how a
    // pendulum hanging free behind the clock can drive an anchor
    // that is pivoted inside it.
    crutchGrp = new THREE.Group();
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 122, 12), MAT.steelDark);
    rod.position.y = -61;
    crutchGrp.add(rod);
    [-9, 9].forEach(x => {
        const tine = new THREE.Mesh(roundedBox(4, 26, 5, 1), MAT.steelDark);
        tine.position.set(x, -132, 0);
        crutchGrp.add(tine);
    });
    const back = new THREE.Mesh(roundedBox(24, 5, 5, 1), MAT.steelDark);
    back.position.y = -120;
    crutchGrp.add(back);
    crutchGrp.rotation.x = 0.130;      // it reaches back to the pendulum
    place(crutchGrp, A_A, BACK_Z - 6);
    clockGrp.add(crutchGrp);
}

// The motion work, in front of the frame, where you can watch it.
// It has nothing to do with timekeeping - it exists only because
// there are two hands and one arbor. Divide by twelve, twice over.
function buildMotionWork() {
    wCannon = new THREE.Group();
    const cn = pinionMesh(MOT.cannon, M_MOTION, 12, MAT.brassBright);
    cn.position.z = Z_MOTION - 6;
    wCannon.add(cn);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(7.5, 7.5, 90, 16), MAT.brass);
    pipe.rotation.x = Math.PI / 2; pipe.position.z = Z_MOTION + 36;
    wCannon.add(pipe);
    place(wCannon, A_C, 0);
    clockGrp.add(wCannon);

    wMinute = new THREE.Group();
    const mw = wheelGroup(MOT.minute, M_MOTION, 4.5, { crossings: 4, hub: 9, mat: MAT.brassBright });
    mw.position.z = Z_MOTION - 2.25;
    wMinute.add(mw);
    const mp = pinionMesh(MOT.minPinion, M_MOTION, 11, MAT.brassBright);
    mp.position.z = Z_HOUR - 5.5;
    wMinute.add(mp);
    place(wMinute, A_MW, 0);
    clockGrp.add(wMinute);
    arbor(A_MW, FRONT_Z, Z_HOUR + 8, 3.4);

    // Centre seconds. A wheel on the escape arbor, an idler under
    // a brass cock, and a wheel on a thin pipe that runs forward
    // through the middle of everything else to the sweep hand.
    secDrive = wheelGroup(SEC_TEETH, M_SEC, 4.5, { crossings: 4, hub: 9, mat: MAT.brassBright });
    place(secDrive, A_E, Z_SEC);
    clockGrp.add(secDrive);

    secIdler = wheelGroup(SEC_IDLER, M_SEC, 4.5, { crossings: 4, hub: 9, mat: MAT.brassBright });
    place(secIdler, A_I, Z_SEC);
    clockGrp.add(secIdler);
    arbor(A_I, Z_SEC - 6, Z_SEC + 22, 3.4);

    // the cock the idler runs in - cantilevered off the escape
    // arbor, which is the only thing near enough to hang it on
    const cock = new THREE.Mesh(new THREE.ExtrudeGeometry(
        ribbonShape([A_E, { x: (A_E.x + A_I.x) / 2, y: (A_E.y + A_I.y) / 2 }, A_I], [13, 9, 13]),
        { depth: 7, bevelEnabled: false }), MAT.brass);
    cock.position.set(0, DIAL_Y, Z_SEC + 13);
    cock.castShadow = true;
    clockGrp.add(cock);

    secCentre = new THREE.Group();
    const sw = wheelGroup(SEC_TEETH, M_SEC, 4.5, { crossings: 4, hub: 9, mat: MAT.brassBright });
    secCentre.add(sw);
    const spipe = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.6, 108, 14), MAT.steelBright);
    spipe.rotation.x = Math.PI / 2; spipe.position.z = 56;
    secCentre.add(spipe);
    place(secCentre, A_C, Z_SEC);
    clockGrp.add(secCentre);

    wHour = new THREE.Group();
    const hw = wheelGroup(MOT.hour, M_MOTION, 4.5, { crossings: 4, hub: 12, mat: MAT.brassBright });
    hw.position.z = Z_HOUR - 2.25;
    wHour.add(hw);
    const hpipe = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 58, 18), MAT.brass);
    hpipe.rotation.x = Math.PI / 2; hpipe.position.z = Z_HOUR + 26;
    wHour.add(hpipe);
    place(wHour, A_C, 0);
    clockGrp.add(wHour);
}

// The dial. A painted ring on a plate of enamel, with the middle
// simply not there - so the wheels behind it are as much of the
// clock as the numbers on it.
function buildDial() {
    dialGrp = new THREE.Group();

    MAT.dialFace.map = dialTexture();
    faceMesh = new THREE.Mesh(new THREE.PlaneGeometry(780, 780), MAT.dialFace);
    faceMesh.position.z = Z_DIAL;
    faceMesh.receiveShadow = true;
    dialGrp.add(faceMesh);

    // the hands, and counterweighted so the train is not lifting
    // them uphill for half of every turn it makes
    // Each hand stands well off the dial on its own pipe, the way
    // they really do: three concentric tubes, one inside the next,
    // and from the side you can see which is which.
    handH = handMesh(227, 48, 19, 4.4);
    handH.position.set(0, 0, Z_DIAL + 17);
    handM = handMesh(304, 54, 14.5, 3.8);
    handM.position.set(0, 0, Z_DIAL + 30);
    const hcol = new THREE.Mesh(new THREE.CylinderGeometry(13, 14, 9, 20), MAT.brassBright);
    hcol.rotation.x = Math.PI / 2; hcol.position.set(0, 0, Z_DIAL + 13);
    const mcol = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, 8, 18), MAT.brassBright);
    mcol.rotation.x = Math.PI / 2; mcol.position.set(0, 0, Z_DIAL + 26);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(8, 10, 7, 20), MAT.brassBright);
    cap.rotation.x = Math.PI / 2; cap.position.set(0, 0, Z_DIAL + 35);
    dialGrp.add(handH); dialGrp.add(handM);
    dialGrp.add(hcol); dialGrp.add(mcol); dialGrp.add(cap);
    [handH, handM, hcol, mcol, cap].forEach(o => { o.castShadow = false; });

    // The seconds hand is the long one, right across the dial, and
    // it moves in a single jump once a beat. Thin and light, with a
    // long tail to balance it - the train has to carry it round.
    handS = handMesh(331, 84, 7, 2.6, MAT.handRed);
    handS.position.set(0, 0, Z_DIAL + 44);
    const scap = new THREE.Mesh(new THREE.CylinderGeometry(5, 6.5, 7, 18), MAT.handRed);
    scap.rotation.x = Math.PI / 2; scap.position.set(0, 0, Z_DIAL + 49);
    handS.castShadow = false; scap.castShadow = false;
    dialGrp.add(handS); dialGrp.add(scap);

    dialGrp.position.y = DIAL_Y;
    clockGrp.add(dialGrp);

    // A slim gold bezel round the rim, sitting on the outer edge
    // of the frame ring - which is the metal that is actually
    // carrying the dial, so that is where it belongs.
    bezelGrp = new THREE.Group();
    const bez = new THREE.Mesh(new THREE.TorusGeometry(DIAL_OUT - 4, 5, 14, 128), MAT.brassBright);
    bez.position.z = Z_DIAL + 2;
    bez.castShadow = true;
    bezelGrp.add(bez);
    const bezIn = new THREE.Mesh(new THREE.TorusGeometry(336, 2, 10, 128), MAT.brassBright);
    bezIn.position.z = Z_DIAL + 1;
    bezelGrp.add(bezIn);
    dialGrp.add(bezelGrp);
}

// The pendulum. Everything else in this clock is a consequence of
// this one stick of metal and how long it is.
function buildPendulum() {
    pendGrp = new THREE.Group();

    // A suspension spring, not a pivot. A knife edge or a bearing
    // would wear and rub; a thin strip of steel bending back and
    // forth loses almost nothing, and never needs oil.
    const sus = new THREE.Mesh(roundedBox(16, 30, 1.2, 0.4), MAT.steelBright);
    sus.position.y = -15;
    pendGrp.add(sus);
    [-1, 1].forEach(s => {
        const chop = new THREE.Mesh(roundedBox(22, 14, 12, 2), MAT.brass);
        chop.position.set(0, -34, s * 6);
        pendGrp.add(chop);
    });

    // Two rods, and only one of them is showing at a time.
    rodBrass = new THREE.Group();
    const r1 = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 100, 20), MAT.brassBright);
    r1.castShadow = true;
    rodBrass.add(r1);

    pendGrp.add(rodBrass);

    // The bob. A lens of solid brass, heavy so that the little
    // push from the escapement is a small fraction of what it is
    // already carrying - which is what makes the clock steady.
    bobGrp = new THREE.Group();
    const lens = new THREE.Mesh(new THREE.LatheGeometry([
        new THREE.Vector2(0, -17), new THREE.Vector2(42, -16), new THREE.Vector2(78, -10),
        new THREE.Vector2(101, -3), new THREE.Vector2(110, 0), new THREE.Vector2(101, 3),
        new THREE.Vector2(78, 10), new THREE.Vector2(42, 16), new THREE.Vector2(0, 17)
    ], 48), MAT.brassBright);
    lens.rotation.x = Math.PI / 2;
    lens.castShadow = true;
    bobGrp.add(lens);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(110, 3.8, 10, 60), MAT.brass);
    bobGrp.add(ring);
    // The rod carries straight on through the bob and finishes in
    // the rating nut, so it reads as one continuous piece.
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 190, 20), MAT.brassBright);
    stem.position.y = -50;
    bobGrp.add(stem);
    const thread = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 66, 14), MAT.steelBright);
    thread.position.y = -118;
    bobGrp.add(thread);
    // the rating nut: half a millimetre a turn, and half a
    // millimetre is twenty-two seconds a day
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, 18, 24), MAT.brassBright);
    nut.position.y = -128;
    nut.castShadow = true;
    bobGrp.add(nut);
    for (let i = 0; i < 24; i++) {
        const k = new THREE.Mesh(new THREE.BoxGeometry(2, 18, 2), MAT.brass);
        k.position.set(Math.cos(i * Math.PI / 12) * 17, -128, Math.sin(i * Math.PI / 12) * 17);
        bobGrp.add(k);
    }
    pendGrp.add(bobGrp);

    pendGrp.position.set(0, DIAL_Y + SUSP_Y, PEND_Z);
    clockGrp.add(pendGrp);

    // The back cock: a bracket standing up off the frame and
    // reaching backwards, so the pendulum hangs clear behind
    // everything and the crutch can still get at it.
    const post = new THREE.Mesh(roundedBox(30, SUSP_Y - 308, 14, 4), MAT.frame);
    post.position.set(0, DIAL_Y + (316 + SUSP_Y) / 2, BACK_Z + 5);
    post.castShadow = true;
    clockGrp.add(post);
    const shelf = new THREE.Mesh(roundedBox(56, 16, PEND_Z - BACK_Z - 22, 4), MAT.frame);
    shelf.position.set(0, DIAL_Y + SUSP_Y + 6, (BACK_Z + PEND_Z) / 2 - 5);
    shelf.castShadow = true;
    clockGrp.add(shelf);

    layoutPendulum();
}

// Both rods and the bob are re-laid every time the length changes,
// because the length is the one number the clock actually cares
// about and it has to be visible.
function layoutPendulum() {
    const L = lengthMM();
    const rodLen = L - 40;
    rodBrass.children[0].scale.y = rodLen / 100;
    rodBrass.children[0].position.y = -40 - rodLen / 2;
    bobGrp.position.y = -L;
}

// =============================================================
//  Running
// =============================================================
const BLOW_S = 0.85;                  // seconds between hammer blows
function step(dt) {
    state.trueT += dt;

    // The arc settles to whatever the drive can hold up against
    // friction. Take the drive away and it dies instead.
    const run = state.running && willRun();
    const tgt = run ? targetArc() : 0;
    state.arc += (tgt - state.arc) * Math.min(1, dt * 0.5);
    if (state.arc < 0.02) state.arc = 0;

    if (run) {
        // Here is the whole clock, in one line: the hands advance
        // at two beats per period, and nothing else touches them.
        const before = state.beats;
        state.beats += dt * clockRate();

        // strike on the hour
        const h0 = Math.floor((before % 43200) / 3600);
        const h1 = Math.floor((state.beats % 43200) / 3600);
        if (h1 !== h0) {
            const n = h1 === 0 ? 12 : h1;
            state.strike = { s1: 0, done: 0, n: n };
            bellSound();
        }
    }

    if (state.strike) {
        const rate = Math.min(state.mult, 24);
        state.strike.s1 += dt / BLOW_S * (Math.PI / 4) / Math.max(1, state.mult / rate);
        const done = Math.floor(state.strike.s1 / (Math.PI / 4));
        if (done > state.strike.done) state.strike.done = done;
        if (state.strike.done >= state.strike.n) state.strike = null;
    }
}

// =============================================================
//  Drawing one frame
// =============================================================
// Nothing here decides anything. Every angle below is state.beats
// multiplied by a gear ratio - which is exactly what the brass is
// doing too.
const HALF_TOOTH = Math.PI * 2 / (N_ESC * 2);
function update3D() {
    if (!gl) return;

    const b = Math.floor(state.beats), f = state.beats - b;
    // The tooth is held until the pendulum reaches the middle of
    // its swing, then drops in a small fraction of a second.
    const prog = f < 0.5 ? 0 : ease((f - 0.5) / 0.14);
    let escA = -(b + prog) * HALF_TOOTH;
    if (state.esc === 'recoil') {
        // A recoil escapement never lets go: the tooth stays on
        // the pallet all the way out, so the far end of the swing
        // pushes the whole train backwards.
        escA += 0.34 * Math.abs(Math.cos(Math.PI * f)) * HALF_TOOTH;
    }
    const thirdA  = -escA * TRAIN.escPinion / TRAIN.thirdWheel;
    const centreA = -thirdA * TRAIN.thirdPinion / TRAIN.centreWheel;
    const greatA  = -centreA * TRAIN.centrePinion / TRAIN.greatWheel;

    escWheel.rotation.z = escA;
    wThird.rotation.z = thirdA;
    wCentre.rotation.z = centreA;
    wGreat.rotation.z = greatA;
    fuseeGrp.rotation.z = greatA;
    barrelGrp.rotation.z = -greatA * fuseeRadius(w01()) / R_BARREL;

    // motion work, and the hands hanging off it
    wCannon.rotation.z = centreA;
    const minA = -centreA * MOT.cannon / MOT.minute;
    wMinute.rotation.z = minA;
    const hourA = -minA * MOT.minPinion / MOT.hour;
    wHour.rotation.z = hourA;
    handM.rotation.z = centreA;
    handH.rotation.z = hourA;
    handS.rotation.z = escA;
    // one-to-one from the escape arbor, through the idler and back
    secDrive.rotation.z = escA;
    secIdler.rotation.z = -escA * SEC_TEETH / SEC_IDLER;
    secCentre.rotation.z = escA;

    // the pendulum, and the anchor it drives through the crutch
    const th = state.arc * Math.PI / 180 * Math.cos(Math.PI * state.vphase);
    pendGrp.rotation.z = th;
    anchorGrp.rotation.z = th;
    crutchGrp.rotation.z = th;

    // the striking side
    const s1 = state.strike ? state.strike.s1 : 0;
    pinWheel.rotation.z = s1;
    wGreat2.rotation.z = -s1 * 12 / TRAIN.greatWheel;
    fuseeGrp2.rotation.z = wGreat2.rotation.z;
    barrelGrp2.rotation.z = -wGreat2.rotation.z * fuseeRadius(w01()) / R_BARREL;
    flyGrp.rotation.z = -s1 * 64 / 8;
    // The hammer is dragged up the back of a pin and then falls off
    // it. All the noise a striking clock makes is in that last bit.
    const u = state.strike ? ((s1 / (Math.PI / 4)) % 1) : 0;
    hammerGrp.rotation.z = -0.34 * (u < 0.8 ? u / 0.8 : 1 - ease((u - 0.8) / 0.2));

    if (chainMesh && MAT.chainMat && MAT.chainMat.map)
        MAT.chainMat.map.offset.x = -greatA * 2.6;
    rebuildChains(false);

    // The dial and the bezel are the case; the stand and the floor
    // are the furniture. None of it is the clock, and all of it can
    // go without the clock stopping.
    const m = state.show;
    faceMesh.visible = m === 'clock';
    bezelGrp.visible = m !== 'mech';
    standGrp.visible = m !== 'mech';
    floor3.visible = grid3.visible = m !== 'mech';

    controls.update();
    renderer.render(scene, camera);
}

const VIEWS = {
    whole:  { pos: [920, 740, 1900],  tgt: [0, 590, -90] },
    dial:   { pos: [0, 793, 1180],    tgt: [0, 790, 0] },
    // The one frame that shows the argument: the anchor rocking,
    // one tooth going past, and the seconds hand moving one mark.
    escape: { pos: [150, 1055, 400],  tgt: [0, 980, -46] },
    train:  { pos: [400, 960, 800],   tgt: [-15, 830, -70] },
    fusee:  { pos: [-430, 800, 420],  tgt: [-98, 685, -55] },
    pend:   { pos: [230, 420, 560],   tgt: [0, 300, -155] },
    // With the case and the stand gone there is nothing below the
    // movement, so the framing has to come up with it.
    mech:   { pos: [560, 900, 1150],  tgt: [0, 800, -60] }
};
let camFrom = null, camTo = null, camT = 1;
function setView(name) {
    const v = VIEWS[name];
    if (!v || !gl) return;
    camFrom = { pos: camera.position.clone(), tgt: controls.target.clone() };
    camTo = { pos: new THREE.Vector3().fromArray(v.pos), tgt: new THREE.Vector3().fromArray(v.tgt) };
    camT = 0;
}
function advanceCamera(real) {
    if (!gl) return;
    if (camT < 1) {
        camT = Math.min(1, camT + real / 0.9);
        const e = ease(camT);
        camera.position.lerpVectors(camFrom.pos, camTo.pos, e);
        controls.target.lerpVectors(camFrom.tgt, camTo.tgt, e);
    }
    controls.autoRotate = state.turntable && camT >= 1;
}

function applyMesh() {
    if (!gl) return;
    const on = state.mesh;
    scene.traverse(o => {
        if (!o.isMesh || !o.material) return;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach(m => { if ('wireframe' in m) m.wireframe = on; });
    });
}
function applyTheme() {
    if (!gl) return;
    const dark = state.viewMode === 'blueprint';
    scene.background.setHex(dark ? 0x0f172a : 0xf1f5f9);
    floor3.material.color.setHex(dark ? 0x131c2e : 0xdbe1ea);
    grid3.material.color.setHex(dark ? 0x1e293b : 0xcbd5e1);
}
function resizeView() {
    const r = $('view3d').getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    if (!gl) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
}
window.addEventListener('resize', resizeView);

// =============================================================
//  Readings
// =============================================================
function updateStats() {
    $('stat-beat').textContent = beatSec().toFixed(4);
    const r = rateDay();
    $('stat-rate').textContent = signed(r, 1);
    const d = drift();
    $('stat-drift').textContent = signed(d, 1);
    $('stat-amp').textContent = state.arc.toFixed(2);
    $('v-turns').textContent = signed(nutTurns(), 1) + ' turns';
}

// =============================================================
//  Sound
// =============================================================
// The ticking runs as a loop for as long as the escapement is
// actually letting teeth go, and its volume follows the arc - so
// a clock on a weak spring is quieter, and a stopped one is
// silent. Above a minute a second there is nothing to hear that
// would mean anything, so it stops.
let aTick = null, aBell = null;
function initAudio() { aTick = $('a-tick'); aBell = $('a-bell'); }

function soundUpdate() {
    if (!aTick) return;
    const want = state.sound && state.running && willRun()
              && state.mult <= 60 && state.arc > 0.5;
    if (want) {
        aTick.volume = clamp(state.arc / NOM_ARC, 0.15, 1) * 0.55;
        // A longer pendulum beats slower, and so does the tick.
        // The difference is under a percent, which is exactly the
        // point: the ear cannot hear what the read-out can measure.
        aTick.playbackRate = clamp(clockRate(), 0.5, 2);
        if (aTick.paused) aTick.play().catch(() => {});
    } else if (!aTick.paused) {
        try { aTick.pause(); } catch (e) {}
    }
}
function bellSound() {
    if (!aBell || !state.sound || state.mult > 60) return;
    try { aBell.currentTime = 0; } catch (e) {}
    aBell.volume = 0.85;
    aBell.play().catch(() => {});
}
function soundStop() {
    [aTick, aBell].forEach(a => { if (a) { try { a.pause(); } catch (e) {} } });
}

// =============================================================
//  Loop
// =============================================================
const DT = 1 / 120;
let acc = 0, last = performance.now();
function frame(now) {
    const real = Math.min((now - last) / 1000, 0.05); last = now;
    advanceCamera(real);

    const simDt = real * state.mult;
    acc += simDt;
    const bigStep = Math.max(DT, simDt / 40);
    let guard = 0;
    while (acc >= bigStep && guard++ < 400) { step(bigStep); acc -= bigStep; }

    // The pendulum can only be drawn so fast. Under about a minute
    // a second it is exactly in step with the count; above that it
    // is slowed to something an eye can follow, and said so.
    const hz = 1 / beatSec();
    if (hz * state.mult <= 3.0) {
        state.vphase = state.beats;
    } else {
        state.vphase += real * 3.0;
    }

    soundUpdate();
    updateStats();
    update3D();
    requestAnimationFrame(frame);
}

// =============================================================
//  Controls
// =============================================================
function nowSeconds() {
    const d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
}
function setToTime() {
    state.beats = nowSeconds();
    state.trueT = state.beats;
    state.strike = null;
}
function reset() {
    Object.assign(P, DEFAULTS);
    state.running = true;
    state.arc = NOM_ARC;
    state.esc = 'dead';
    state.strike = null;
    soundStop();
    setToTime();
    state.vphase = state.beats;
    ['len', 'drive'].forEach(k => { $('s-' + k).value = P[k]; });
    $('v-len').textContent = P.len.toFixed(2);
    $('v-drive').textContent = P.drive;
    if (gl) { layoutPendulum(); rebuildChains(true); }
    paintEsc(); paintShow(); paintRun();
}
function bindSlider(id, key, fmt, after) {
    const s = $(id), out = $(id.replace('s-', 'v-'));
    s.addEventListener('input', () => {
        P[key] = parseFloat(s.value);
        if (out) out.textContent = fmt ? fmt(P[key]) : P[key];
        if (after) after();
    });
}
bindSlider('s-len', 'len', v => v.toFixed(2), () => { if (gl) layoutPendulum(); });
bindSlider('s-drive', 'drive', v => v.toFixed(0));

function paintRun() {
    const on = state.running;
    $('run-label').textContent = on ? 'Stop' : 'Start';
    $('btn-run').querySelector('i').className = on ? 'fa-solid fa-pause' : 'fa-solid fa-play';
}
$('btn-run').addEventListener('click', () => {
    state.running = !state.running;
    if (!state.running) soundStop();
    paintRun();
});
$('btn-set').addEventListener('click', () => { setToTime(); state.vphase = state.beats; });
$('btn-reset').addEventListener('click', () => reset());

function paintShow() {
    document.querySelectorAll('.wseg').forEach(b => b.classList.toggle('on', b.dataset.show === state.show));
}
document.querySelectorAll('.wseg').forEach(b => b.addEventListener('click', () => {
    state.show = b.dataset.show; paintShow();
    // Taking the case away moves where the clock sits in the frame,
    // so the camera goes with it rather than leaving it in a corner.
    const v = state.show === 'mech' ? 'mech' : 'whole';
    setView(v); paintViews(v === 'whole' ? 'whole' : null);
}));

function paintEsc() {
    document.querySelectorAll('.eseg').forEach(b => b.classList.toggle('on', b.dataset.esc === state.esc));
}
document.querySelectorAll('.eseg').forEach(b => b.addEventListener('click', () => {
    state.esc = b.dataset.esc; paintEsc();
}));
document.querySelectorAll('.tseg').forEach(b => b.addEventListener('click', () => {
    state.mult = parseFloat(b.dataset.mult);
    document.querySelectorAll('.tseg').forEach(x => x.classList.toggle('on', x === b));
}));

function paintViews(name) {
    document.querySelectorAll('.vseg').forEach(b => b.classList.toggle('on', b.dataset.view === name));
}
document.querySelectorAll('.vseg').forEach(b => b.addEventListener('click', () => {
    setView(b.dataset.view); paintViews(b.dataset.view);
}));

function paintChip(chip, on) {
    chip.classList.toggle('bg-slate-100', !on);
    chip.classList.toggle('text-slate-400', !on);
    chip.classList.toggle('bg-white', on);
    chip.classList.toggle('text-slate-900', on);
}
function bindChip(id, key, after) {
    const chk = $('chk-' + id), chip = $('chip-' + id);
    chk.addEventListener('change', () => {
        state[key] = chk.checked;
        paintChip(chip, chk.checked);
        if (after) after();
    });
    paintChip(chip, chk.checked);
}
bindChip('sound', 'sound', () => { if (!state.sound) soundStop(); });
bindChip('mesh', 'mesh', applyMesh);
bindChip('spin', 'turntable');

function paintViewMode() {
    const dark = state.viewMode === 'blueprint';
    $('chk-view-mode').checked = dark;
    $('txt-view-mode').textContent = dark ? 'Light' : 'Dark';
    paintChip($('chip-view-mode'), dark);
    applyTheme();
}
$('chk-view-mode').addEventListener('change', e => {
    state.viewMode = e.target.checked ? 'blueprint' : 'light';
    paintViewMode();
});

const infoModal = $('info-modal');
$('btn-info').addEventListener('click', () => infoModal.classList.remove('hidden'));
$('info-close').addEventListener('click', () => infoModal.classList.add('hidden'));
$('info-backdrop').addEventListener('click', () => infoModal.classList.add('hidden'));
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !infoModal.classList.contains('hidden'))
        infoModal.classList.add('hidden');
});

function hideLoader() {
    const el = document.getElementById('loader');
    if (el) el.classList.add('gone');
}
setTimeout(hideLoader, 8000);

window.onload = function () {
    try {
        init3D();
        gl = true;
        controls.addEventListener('start', () => paintViews(null));
    } catch (e) {
        console.warn('3D unavailable:', e);
        const n = $('nogl');
        n.classList.remove('hidden'); n.classList.add('flex');
    }
    initAudio();
    reset();
    paintViewMode();
    applyMesh();
    resizeView();
    requestAnimationFrame(hideLoader);
    setTimeout(hideLoader, 400);
    requestAnimationFrame(frame);
};
