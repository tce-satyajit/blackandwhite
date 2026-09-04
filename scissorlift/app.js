// =============================================================
//  Scissor Lift - model
// =============================================================
// Millimetres, newtons, seconds. Bar for pressure and litres a minute
// for flow, because that is what is written on a hydraulic power pack.
const G_ACC = 9.81;

// The linkage. Two stages of scissor, each a pair of arms of length L
// pinned at their middles. Everything about the machine's position
// follows from one number: theta, the angle the arms make with the floor.
const ARM_L = 900;
const STAGES = 2;
const TH_MIN = 8 * Math.PI / 180;
// 51.159 deg puts the deck top at exactly 1.80 m, which is what the
// machine is sold as doing and so is not negotiable. It fell from
// 54.752 when the chassis was raised onto bigger wheels: the pivot line
// starts 68 mm higher, so the linkage has 68 mm less to find, and the
// angle that finds it is smaller. Any higher and the machine is taller
// than its own wheelbase is long, which looks - and is - top heavy.
const TH_MAX = 51.159 * Math.PI / 180;

// Where the rams are bolted on. RAM_P is measured along the base from
// the fixed pivot, RAM_Q along the arm from the same pivot - so the ram,
// the base and the arm make a triangle with theta in the corner, and the
// cosine rule gives its length without any further thought.
const RAM_P = 340, RAM_Q = 760;
const N_RAM = 2;
const EFF = 0.72;                     // pump, motor and pipework together

// The machine itself, before anything is put on it.
const DECK_MASS = 420;                // deck, upper stage and rails
const BASE_MASS = 380;                // base frame, power pack, wheels
const WHEEL_X = 420;                  // how far out the wheels are - the tipping line

const DEFAULTS = { load: 600, offset: 0, bore: 80, flow: 8, relief: 250, steer: 0 };
const P = Object.assign({}, DEFAULTS);

const state = {
    th: TH_MIN,                        // the one variable the machine has
    cmd: 0,                            // -1 lowering, 0 holding, +1 raising
    // The arrows are a teaching overlay, not part of the machine, so
    // they wait to be asked for.
    crate: true, forces: false, sound: true, mesh: false, turntable: false,
    warn: 0,                           // seconds of warning still to sound
    motion: 0,                         // 0..1, how much of full flow is actually moving
    lastDir: 0,                        // which way it was going, for the run-down
    viewMode: 'blueprint'
};

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ---- the chain of consequences, all from theta -------------------
// Deck height above the base pivots: each stage lifts by L sin(theta),
// and there are two of them.
const liftH = th => STAGES * ARM_L * Math.sin(th);
// Ram length, straight off the cosine rule on that mounting triangle.
const ramLen = th => Math.sqrt(RAM_P * RAM_P + RAM_Q * RAM_Q
                               - 2 * RAM_P * RAM_Q * Math.cos(th));

// The mechanical advantage, and the whole point of the machine.
//
// Virtual work says the ram's work equals the load's work: F ds = W dh.
// So F/W is just how much height one millimetre of ram buys, and both
// come from differentiating the two lines above. No force needs
// resolving, and no triangle needs drawing.
//
//   dh/dtheta = 2 L cos(theta)
//   ds/dtheta = p q sin(theta) / s
//
// As theta goes to zero the first is at its largest and the second at
// its smallest, so the ratio runs away - which is exactly the trouble
// with a scissor lift lying flat on the floor.
function ratio(th) {
    const s = ramLen(th);
    return (STAGES * ARM_L * Math.cos(th)) * s / (RAM_P * RAM_Q * Math.sin(th));
}

const ramArea = () => Math.PI * P.bore * P.bore / 4;        // mm^2
const totalMass = () => DECK_MASS + P.load;                 // kg on the rams
const loadW = () => totalMass() * G_ACC;                    // N
const ramForce = () => loadW() * ratio(state.th);           // N, all rams
// N/mm^2 is a megapascal, and a megapascal is ten bar.
const pressure = () => ramForce() / (N_RAM * ramArea()) * 10;
const stalled = () => pressure() > P.relief;

// Flow is the only thing that sets ram speed: the oil has to go
// somewhere, and the ram is the only place it can go.
const flowMM3 = () => P.flow * 1e6 / 60;                    // mm^3/s
const ramSpeed = () => flowMM3() / (N_RAM * ramArea());     // mm/s
const deckSpeed = () => ramSpeed() * ratio(state.th);       // mm/s
const LOWER_SPEED = 26;                                     // mm/s of ram, on the way down
// How long the warning sounds before anything is allowed to move.
const WARN_TIME = 1.3;
// Nothing mechanical steps from still to full flow and back again. The
// valve is eased open and shut and the motor takes a moment either way,
// so the lift settles onto its stops instead of arriving at them - which
// on a real machine is the difference between stopping and shock-loading
// the linkage with a tonne on the deck.
const RAMP_TIME = 0.5;                // seconds to spin up, and to run down
const EASE_RAM = 30;                  // mm of ram travel eased at each end
const EASE_FLOOR = 0.2;               // never quite zero, or it would never arrive

const hydPower = () => pressure() * 1e5 * (P.flow / 60000); // W
const motorPower = () => hydPower() / EFF;                  // W

// Where the whole thing balances, machine and load together. The machine
// is symmetric, so its own centre of gravity sits at x = 0.
const cgX = () => P.load * P.offset / (BASE_MASS + DECK_MASS + P.load);
const tipping = () => Math.abs(cgX()) > WHEEL_X;
const tipMargin = () => (WHEEL_X - Math.abs(cgX()));

const deckY = () => PIVOT_Y + liftH(state.th);
const heightM = () => (deckY() + DECK_T) / 1000;

// =============================================================
//  The machine, in three dimensions
// =============================================================
// One millimetre is one unit. The lift stands on the floor at y = 0 and
// travels straight up; x runs along the machine, z across it.
// Rough-terrain tyres, and the chassis carried clear above them. The
// old 50 mm of ground clearance was less than a kerb: a machine that
// has to be pushed across a yard has to be able to get over what is
// lying in it, and that is what the clearance is for.
const WHEEL_R = 135;
const BASE_Y0 = 118;                  // the chassis underside, clear of the ground
const BASE_H = 190;
const PIVOT_Y = BASE_Y0 + BASE_H;     // the line the scissor is pinned on
const FIX_X = -ARM_L / 2;             // the fixed pivots, which never move
const DECK_T = 90;
const BASE_X = 640, BASE_Z = 430;
const DECK_X = 750, DECK_Z = 450;
const ARM_Z_OUT = 355, ARM_Z_IN = 295;
const RAM_Z = 150;
const ARM_W = 96, ARM_T = 26;         // the flat bar an arm is cut from

// ---- how the wheels are hung ------------------------------------
// Not on a stub axle straight into the chassis side: that is a mounting
// that can never do anything but roll straight, and a machine you have
// to push into position has to be able to point somewhere.
//
// So the front pair hang off a king pin - a vertical pivot bolted to
// the chassis, just outboard of it - on a swing arm that carries the
// hub. Everything from the king pin outwards turns; everything inboard
// of it does not. The wheel has to sit far enough out that the tyre
// clears the pivot boss as it swings, which is what sets WHEEL_Z.
const WHEEL_W = 92;                   // across the tread
const KING_Z = BASE_Z + 18;           // the king pin the arm swings about
const WHEEL_Z = BASE_Z + 110;         // the wheel's own centre plane
const TREAD_N = 22;                   // lugs round the tyre
// The roller at the sliding end of each stage, and so how far below the
// pivot line the rail it runs on has to sit.
const ROLL_R = 38;

// ---- what is actually on the deck -------------------------------
// Not a cube. A timber crate banded down to a block pallet - and the
// pallet is a piece of engineering in its own right: three bottom
// boards, nine blocks, three bearers and five deck boards, in that
// order, because that is the only order that lets a fork in from all
// four sides.
const PAL_X = 1000, PAL_Z = 760;
const PAL_BOARD = 22, PAL_BLOCK_H = 78;
const PAL_H = PAL_BOARD * 3 + PAL_BLOCK_H;   // 144, near enough a euro pallet
const PAL_BX = 427, PAL_BZ = 330;            // where the bearers and blocks sit
// The crate, measured over its four corner posts. The boarding is
// nailed to the outside of them, which is why it stands proud.
const CRATE_X = 900, CRATE_Z = 660;
const CRATE_T = 24;                          // board thickness
const CRATE_BOARD = 130, CRATE_PITCH = 175;  // a course, and the pitch to the next
const CRATE_POST = 62;
const POST_NOM = 1000;                       // posts are drawn this long and scaled
const ROWS_MAX = 5;
const KG_PER_ROW = 420;
const BAND_X = 250;                          // where the two steel bands run over

// The crate gains a course of boarding for every 420 kg. It is the one
// thing tying the number on the slider to the object on the deck: you
// should be able to see how heavily it is loaded without reading
// anything.
const loadRows = () => clamp(Math.ceil(P.load / KG_PER_ROW), 1, ROWS_MAX);
const crateH = () => loadRows() * CRATE_PITCH - (CRATE_PITCH - CRATE_BOARD) + CRATE_T;
const loadH = () => PAL_H + crateH();        // pallet foot to crate lid
const loadShown = () => state.crate && P.load > 0;

let scene, camera, renderer, controls;
let floor3, grid3, liftGrp;
let armsL = [], armsU = [], deckGrp, crateGrp;
// The front pair of swing arms. Only these turn; the back pair are
// fixed, which is what makes the machine track straight when pushed.
const steerArms = [];
// The parts of the load that have to move or come and go as the mass on
// the slider changes. Everything is built once; nothing is rebuilt.
const loadParts = { posts: [], rows: [], bands: [], lid: null, goods: null };
const joints = {};   // C D E F A B N M, named for the schematic
let ramGrp = [], rollerL = [], rollerU = [];
let arrowRam = [], arrowLoad = null;
let beaconLamp = null, beaconLight = null;
let ramPinBase = null, ramPinRod = null;
let gl = false;
const MAT = {};

// A flat bar running between two points in the machine's own plane -
// which is what every arm, rail and link on this lift actually is.
function bar(x1, y1, x2, y2, z, w, t, mat, r) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const m = new THREE.Mesh(roundedBox(len, w, t, r === undefined ? w / 2 : r), mat);
    m.position.set((x1 + x2) / 2, (y1 + y2) / 2, z);
    m.rotation.z = Math.atan2(dy, dx);
    m.castShadow = m.receiveShadow = true;
    return m;
}

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

// A pin through a joint, drawn as the boss and the head you would see.
function pin(x, y, z, r, len, mat) {
    const g = new THREE.Group();
    const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 18), mat || MAT.steel);
    p.rotation.x = Math.PI / 2;
    p.castShadow = true;
    g.add(p);
    [-len / 2, len / 2].forEach(zz => {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.5, r * 1.5, 8, 18), mat || MAT.steel);
        c.rotation.x = Math.PI / 2; c.position.z = zz;
        g.add(c);
    });
    g.position.set(x, y, z);
    return g;
}

// Hazard striping. Drawn as a tile rather than laid out as a row of
// little bars: a bar has to be mitred to whatever it sits on, and at an
// angle it never quite is, whereas a band carrying a tile is exactly
// the depth of the plate however far along it runs.
const HAZ_TILE = 160;
let hazTex = null;
function hazardTexture() {
    if (hazTex) return hazTex;
    const S = 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#dcae16'; g.fillRect(0, 0, S, S);
    g.fillStyle = '#191b1e';
    // Forty-five degrees, one whole period across the tile, so it meets
    // itself in both directions however long the band is.
    for (let k = -1; k <= 1; k++) {
        const o = k * S;
        g.beginPath();
        g.moveTo(o, 0); g.lineTo(o + S / 2, 0);
        g.lineTo(o + S / 2 + S, S); g.lineTo(o + S, S);
        g.closePath(); g.fill();
    }
    hazTex = new THREE.CanvasTexture(c);
    hazTex.wrapS = hazTex.wrapT = THREE.RepeatWrapping;
    hazTex.repeat.set(1 / HAZ_TILE, 1 / HAZ_TILE);
    hazTex.anisotropy = 8;
    return hazTex;
}

// The ribbed rubber mat on the deck. Ribs, not a flat black slab: a
// load standing on bare steel slides, and the ribs are what stop it -
// which is also why every one of these has them, and why they run
// across the deck rather than along it. One tile is 120 mm of matting,
// mapped in millimetres like the timber, so the ribs come out the same
// size whatever they are laid on.
const RIB_TILE = 120, RIBS_PER_TILE = 32;
let ribTex = null;
function rubberMatTexture() {
    if (ribTex) return ribTex;
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#151618';
    g.fillRect(0, 0, S, S);
    const p = S / RIBS_PER_TILE;
    for (let i = 0; i < RIBS_PER_TILE; i++) {
        const x = i * p;
        // Each rib is a rounded ridge, so it is dark in the valley on
        // either side and catches the light along its crown.
        const grad = g.createLinearGradient(x, 0, x + p, 0);
        grad.addColorStop(0.00, '#0b0c0d');
        grad.addColorStop(0.38, '#3a3e43');
        grad.addColorStop(0.58, '#2b2e32');
        grad.addColorStop(1.00, '#0b0c0d');
        g.fillStyle = grad;
        g.fillRect(x, 0, p, S);
    }
    ribTex = new THREE.CanvasTexture(c);
    ribTex.wrapS = ribTex.wrapT = THREE.RepeatWrapping;
    ribTex.repeat.set(1 / RIB_TILE, 1 / RIB_TILE);
    ribTex.anisotropy = 8;
    return ribTex;
}

// The maker's plate, done the way the bench drill does it: a plain grey
// plate with the name across it and nothing else on it at all. A riveted
// plate, not paint - which is why it has an edge and sits on the side
// rather than being part of it.
let badgeTex = null;
function badgeTexture() {
    if (badgeTex) return badgeTex;
    const c = document.createElement('canvas');
    c.width = 368; c.height = 100;
    const g = c.getContext('2d');
    g.fillStyle = '#999999'; g.fillRect(0, 0, 368, 100);
    g.fillStyle = '#8e6e05';
    g.font = 'bold 58px Inter, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('TCE-LAB', 184, 53);
    badgeTex = new THREE.CanvasTexture(c);
    badgeTex.anisotropy = 8;
    return badgeTex;
}

// =============================================================
//  Timber, and the marks sprayed on it
// =============================================================
// Wood is not a colour, it is a grain, and at this size the grain is
// what the eye reads first: a plain brown box says cardboard however
// carefully it is lit.
//
// One tile is 400 mm of board. Every wooden part is mapped in
// millimetres - which is what an extruded shape gives for free - so the
// grain comes out the same size on a pallet board as on a crate rail
// without anything being scaled to fit.
const WOOD_TILE = 400;

function woodTexture(base, dark, light, seed) {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    let s = seed * 7919 + 13;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;

    g.fillStyle = base;
    g.fillRect(0, 0, S, S);

    // The fibres. They run the length of the board and wander as they
    // go, but the wander is whole cycles across the tile, so the tile
    // still meets itself where it repeats.
    for (let i = 0; i < 80; i++) {
        const y = rnd() * S;
        const k = 1 + Math.floor(rnd() * 3);
        const amp = 2 + rnd() * 7;
        const ph = rnd() * Math.PI * 2;
        g.strokeStyle = rnd() < 0.72 ? dark : light;
        g.globalAlpha = 0.06 + rnd() * 0.22;
        g.lineWidth = 0.5 + rnd() * 2.6;
        g.beginPath();
        for (let x = 0; x <= S; x += 6) {
            const yy = y + Math.sin((x / S) * Math.PI * 2 * k + ph) * amp;
            if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
        }
        g.stroke();
    }

    // A knot or two, with the grain sweeping round them the way it has
    // to - a knot is a branch the tree grew round.
    const knots = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < knots; i++) {
        const cx = 70 + rnd() * (S - 140), cy = 50 + rnd() * (S - 100);
        const r = 7 + rnd() * 8;
        g.strokeStyle = dark;
        for (let j = 7; j > 0; j--) {
            g.globalAlpha = 0.10 + 0.05 * (7 - j);
            g.lineWidth = 1.1;
            g.beginPath();
            g.ellipse(cx, cy, r * j * 0.5, r * j * 0.2, 0, 0, Math.PI * 2);
            g.stroke();
        }
        g.globalAlpha = 0.8;
        g.fillStyle = dark;
        g.beginPath();
        g.ellipse(cx, cy, r * 0.5, r * 0.28, 0, 0, Math.PI * 2);
        g.fill();
    }

    // Saw marks: faint, and across the grain rather than along it.
    g.globalAlpha = 0.05;
    g.strokeStyle = dark;
    g.lineWidth = 1;
    for (let i = 0; i < 26; i++) {
        const x = rnd() * S;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 5, S); g.stroke();
    }
    g.globalAlpha = 1;

    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / WOOD_TILE, 1 / WOOD_TILE);
    t.anisotropy = 8;
    return t;
}

// Pallet blocks are not sawn timber at all - they are chips and glue
// pressed into a brick, and up close that is exactly what they look
// like.
function chipTexture() {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#8d7351';
    g.fillRect(0, 0, S, S);
    let s = 99;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 1500; i++) {
        const w = 3 + rnd() * 16, h = 1.5 + rnd() * 4;
        g.save();
        g.translate(rnd() * S, rnd() * S);
        g.rotate(rnd() * Math.PI);
        g.globalAlpha = 0.15 + rnd() * 0.4;
        g.fillStyle = rnd() < 0.5 ? '#634c30' : '#bda67e';
        g.fillRect(-w / 2, -h / 2, w, h);
        g.restore();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / 160, 1 / 160);
    return t;
}

// The three marks every crate in the world carries, drawn rather than
// written, because they have to be read by someone who does not share
// your alphabet.
function glyphGlass(g, x, y, s) {
    g.beginPath();
    g.moveTo(x - 12 * s, y - 26 * s); g.lineTo(x + 12 * s, y - 26 * s);
    g.lineTo(x + 7 * s, y - 2 * s); g.lineTo(x - 7 * s, y - 2 * s);
    g.closePath(); g.stroke();
    g.beginPath();
    g.moveTo(x, y - 2 * s); g.lineTo(x, y + 18 * s); g.stroke();
    g.beginPath();
    g.moveTo(x - 12 * s, y + 20 * s); g.lineTo(x + 12 * s, y + 20 * s); g.stroke();
    // the crack, which is the whole reason the glass is drawn
    g.beginPath();
    g.moveTo(x + 4 * s, y - 26 * s); g.lineTo(x - 2 * s, y - 17 * s);
    g.lineTo(x + 4 * s, y - 12 * s); g.lineTo(x - 2 * s, y - 3 * s); g.stroke();
}
function glyphBrolly(g, x, y, s) {
    g.beginPath(); g.arc(x, y, 22 * s, Math.PI, 0); g.stroke();
    g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 20 * s); g.stroke();
    g.beginPath(); g.arc(x - 6 * s, y + 20 * s, 6 * s, 0, Math.PI); g.stroke();
    [[-30, -10], [30, -10], [-24, 12], [24, 12]].forEach(([dx, dy]) => {
        g.beginPath();
        g.moveTo(x + dx * s, y + dy * s);
        g.lineTo(x + (dx - 4) * s, y + (dy + 12) * s);
        g.stroke();
    });
}
function glyphUp(g, x, y, s) {
    [-13, 13].forEach(dx => {
        g.beginPath();
        g.moveTo(x + dx * s, y + 22 * s); g.lineTo(x + dx * s, y - 24 * s); g.stroke();
        g.beginPath();
        g.moveTo(x + (dx - 9) * s, y - 12 * s); g.lineTo(x + dx * s, y - 26 * s);
        g.lineTo(x + (dx + 9) * s, y - 12 * s); g.stroke();
    });
    g.beginPath();
    g.moveTo(x - 26 * s, y + 24 * s); g.lineTo(x + 26 * s, y + 24 * s); g.stroke();
}

// The stencil on the side of the crate. The net weight on it is the
// number on the slider, so the crate is labelled with what the rams are
// actually being asked to lift. Redrawn whenever that changes.
//
// The gaps in the middle of the layout are not accidents: that is where
// the two steel bands come down the face, and a stencil that reads
// "NET 6" and then a band is worse than one laid out around it.
let markCanvas = null, markTex = null, markKg = -1;
const MARK_W = 1152, MARK_H = 160;

function drawMarks() {
    markKg = P.load;
    const g = markCanvas.getContext('2d');
    g.clearRect(0, 0, MARK_W, MARK_H);
    g.lineCap = g.lineJoin = 'round';
    g.strokeStyle = g.fillStyle = '#23262b';
    g.textBaseline = 'alphabetic';

    g.lineWidth = 5;
    glyphGlass(g, 58, 76, 1.3);
    glyphUp(g, 148, 76, 1.25);
    glyphBrolly(g, 1052, 62, 1.25);

    g.font = 'bold 46px Inter, Helvetica, Arial, sans-serif';
    g.fillText('SATYAJIT', 295, 70);
    g.font = '26px Inter, Helvetica, Arial, sans-serif';
    g.fillText('LOT 41-27  ·  1 OF 1', 295, 110);

    const gross = Math.round(P.load + 25 + 18 * loadRows());
    g.font = 'bold 46px Inter, Helvetica, Arial, sans-serif';
    g.fillText('NET ' + P.load + ' kg', 560, 70);
    g.font = '26px Inter, Helvetica, Arial, sans-serif';
    g.fillText('GROSS ' + gross + ' kg', 560, 110);

    // Stencils are sprayed, and spray is never solid. Punching holes
    // back out of what has just been drawn is the cheapest way to say
    // so, and it is the difference between a label and a print-out.
    g.globalCompositeOperation = 'destination-out';
    let s = 7;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 2400; i++) {
        g.globalAlpha = 0.2 + rnd() * 0.5;
        g.beginPath();
        g.arc(rnd() * MARK_W, rnd() * MARK_H, 0.6 + rnd() * 2.1, 0, Math.PI * 2);
        g.fill();
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    if (markTex) markTex.needsUpdate = true;
}

function markTexture() {
    markCanvas = document.createElement('canvas');
    markCanvas.width = MARK_W; markCanvas.height = MARK_H;
    drawMarks();
    markTex = new THREE.CanvasTexture(markCanvas);
    markTex.anisotropy = 8;
    return markTex;
}

function init3D() {
    const host = $('view3d');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);

    camera = new THREE.PerspectiveCamera(42, 1, 20, 14000);
    camera.position.set(2900, 2000, 3300);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 400;
    controls.maxDistance = 9000;
    controls.maxPolarAngle = Math.PI / 2 + 0.02;
    controls.autoRotateSpeed = 0.8;
    controls.target.set(0, 1150, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.34));
    const key = new THREE.DirectionalLight(0xfff6e8, 0.8);
    key.position.set(1900, 3000, 2100);
    key.castShadow = true;
    key.shadow.mapSize.width = key.shadow.mapSize.height = 2048;
    key.shadow.camera.left = -1900; key.shadow.camera.right = 1900;
    // High enough to hold a full crate on a deck at full height - about
    // 2.95 m to the lid - or the load stops casting a shadow just as it
    // gets big enough to need one.
    key.shadow.camera.top = 3500; key.shadow.camera.bottom = -400;
    key.shadow.camera.far = 8000;
    key.shadow.bias = -0.00018;
    key.shadow.normalBias = 2;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4f0, 0.28);
    fill.position.set(-2000, 1400, -1200); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.3);
    rim.position.set(0, 1200, -2600); scene.add(rim);

    // Painted steel is nearly all reflection of whatever is around it, so
    // without something in the sky it renders as flat colour. A workshop
    // in four strokes: a bright ceiling with two strip lights, and a floor.
    const ec = document.createElement('canvas');
    ec.width = 256; ec.height = 128;
    const eg = ec.getContext('2d');
    const sky = eg.createLinearGradient(0, 0, 0, 128);
    sky.addColorStop(0, '#ffffff'); sky.addColorStop(0.42, '#c3c8cf');
    sky.addColorStop(0.52, '#6a7078'); sky.addColorStop(1, '#262a30');
    eg.fillStyle = sky; eg.fillRect(0, 0, 256, 128);
    eg.fillStyle = '#ffffff';
    eg.fillRect(26, 12, 84, 14); eg.fillRect(148, 12, 84, 14);
    const pm = new THREE.PMREMGenerator(renderer);
    pm.compileEquirectangularShader();
    const et = new THREE.CanvasTexture(ec);
    et.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = pm.fromEquirectangular(et).texture;
    et.dispose(); pm.dispose();

    floor3 = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000),
        new THREE.MeshStandardMaterial({ color: 0x131c2e, roughness: 0.92 }));
    floor3.rotation.x = -Math.PI / 2;
    floor3.receiveShadow = true;
    scene.add(floor3);
    grid3 = new THREE.GridHelper(14000, 70, 0x334155, 0x1e293b);
    scene.add(grid3);

    // Yellow enamel on the frame, black on the linkage, bare steel where
    // the two meet - the scheme every scissor jack in a workshop wears,
    // and it is worn for a reason: the frame is the part you must not
    // walk into and the linkage is the part you must not put a hand in,
    // so the two are painted the two colours nobody confuses.
    MAT.body     = new THREE.MeshStandardMaterial({ color: 0xf7b500, metalness: 0.22, roughness: 0.36 });
    MAT.bodyDark = new THREE.MeshStandardMaterial({ color: 0xd09400, metalness: 0.22, roughness: 0.42 });
    // The arms are the other half of the scheme. Painting the moving
    // linkage black against a yellow frame is not decoration: it is the
    // one part that changes shape, and black against yellow is the
    // easiest pairing there is to read the shape of.
    MAT.arm      = new THREE.MeshStandardMaterial({ color: 0x202328, metalness: 0.30, roughness: 0.44 });
    MAT.armDark  = new THREE.MeshStandardMaterial({ color: 0x17191d, metalness: 0.30, roughness: 0.48 });
    // Machined steel, not polished steel. A shaft through a pin joint
    // comes off a lathe and then spends its life in grease and grit: it
    // is a dull grey, and it has to be, because a near-mirror at this
    // roughness reflects the environment map almost pixel for pixel and
    // the joints come out blown white and blotchy rather than round.
    MAT.steel    = new THREE.MeshStandardMaterial({ color: 0xb9bfc9, metalness: 0.70, roughness: 0.52 });
    MAT.chrome   = new THREE.MeshStandardMaterial({ color: 0xc9cfd7, metalness: 0.98, roughness: 0.055 });
    MAT.rubber   = new THREE.MeshStandardMaterial({ color: 0x1b1e23, metalness: 0.04, roughness: 0.88 });
    MAT.motor    = new THREE.MeshStandardMaterial({ color: 0x3d434c, metalness: 0.46, roughness: 0.44 });
    MAT.tank     = new THREE.MeshStandardMaterial({ color: 0x484d54, metalness: 0.70, roughness: 0.36 });
    // The deck plate is part of the frame and painted with it. What you
    // actually stand a load on is the mat laid into it.
    MAT.deck     = new THREE.MeshStandardMaterial({ color: 0xf7b500, metalness: 0.22, roughness: 0.36 });
    MAT.mat      = (() => {
        const tex = rubberMatTexture();
        return new THREE.MeshStandardMaterial({
            map: tex, bumpMap: tex, bumpScale: 0.7,
            metalness: 0.02, roughness: 0.86
        });
    })();
    MAT.hose     = new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.2, roughness: 0.7 });
    // Three boards off the same stack, no two of them alike. Handing
    // them out in turn is what stops a crate reading as one moulding.
    // The grain doubles as the bump map, so it catches the light as
    // relief and not just as a picture of relief.
    MAT.wood = [
        ['#c2a173', '#6b4f2c', '#e4cda6', 1],
        ['#b59468', '#5c4324', '#d8c096', 2],
        ['#caab7f', '#755738', '#e8d4b0', 3]
    ].map(([base, dark, light, seed]) => {
        const tex = woodTexture(base, dark, light, seed);
        return new THREE.MeshStandardMaterial({
            map: tex, bumpMap: tex, bumpScale: 0.5,
            metalness: 0.02, roughness: 0.8
        });
    });
    MAT.block    = (() => {
        const tex = chipTexture();
        return new THREE.MeshStandardMaterial({
            map: tex, bumpMap: tex, bumpScale: 0.4,
            metalness: 0.02, roughness: 0.9
        });
    })();
    // Whatever is in the crate, seen through the gaps between courses.
    MAT.goods    = new THREE.MeshStandardMaterial({ color: 0x4d5560, metalness: 0.08, roughness: 0.58 });
    // Steel strapping: thin, bright and pulled tight.
    MAT.band     = new THREE.MeshStandardMaterial({ color: 0x6f7885, metalness: 0.88, roughness: 0.38 });
    MAT.mark     = new THREE.MeshStandardMaterial({ map: markTexture(), transparent: true,
                                                    alphaTest: 0.1, metalness: 0, roughness: 0.9 });
    // Hazard striping only works as a pair. On a yellow machine the
    // stripes are the black half.
    MAT.warn     = new THREE.MeshStandardMaterial({ color: 0x191b1e, metalness: 0.2, roughness: 0.55 });
    MAT.hazard   = new THREE.MeshStandardMaterial({ map: hazardTexture(),
                                                    metalness: 0.25, roughness: 0.5 });
    MAT.forceRam = new THREE.MeshStandardMaterial({ color: 0x8b5cf6, metalness: 0.2, roughness: 0.4,
                                                    emissive: 0x4c1d95, emissiveIntensity: 0.35 });
    MAT.forceW   = new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.2, roughness: 0.4,
                                                    emissive: 0x92400e, emissiveIntensity: 0.35 });
    MAT.beacon   = new THREE.MeshStandardMaterial({ color: BEACON_RED_LENS, roughness: 0.25, metalness: 0.1,
                                                    emissive: BEACON_RED, emissiveIntensity: 0.1,
                                                    transparent: true, opacity: 0.92 });

    // Enamel picks up a little of the room but nowhere near as much as
    // the bare steel beside it, which is most of what separates a
    // painted face from a machined one.
    MAT.body.envMapIntensity = 0.45;
    MAT.bodyDark.envMapIntensity = 0.45;
    MAT.arm.envMapIntensity = 0.35;
    MAT.armDark.envMapIntensity = 0.35;
    MAT.steel.envMapIntensity = 0.55;
    MAT.chrome.envMapIntensity = 2.4;
    MAT.deck.envMapIntensity = 0.45;
    MAT.mat.envMapIntensity = 0.12;
    MAT.motor.envMapIntensity = 0.8;
    MAT.tank.envMapIntensity = 0.9;
    MAT.rubber.envMapIntensity = 0.2;
    MAT.wood.forEach(m => { m.envMapIntensity = 0.3; });
    MAT.block.envMapIntensity = 0.25;
    MAT.hazard.envMapIntensity = 0.7;
    MAT.goods.envMapIntensity = 0.4;
    MAT.band.envMapIntensity = 0.9;

    buildLift();
}

// =============================================================
//  Building it
// =============================================================
// The dark under the machine. One directional light with one shadow map
// gives a clean cast shadow and nothing else, so the gap between the
// ground and a chassis standing 118 mm above it comes out as brightly
// lit as the open floor - and a machine with daylight under it does not
// look like it is standing on anything. This is the ambient darkness
// that gap really has: light that gets in there has nowhere to bounce.
//
// Built from stacked rectangles rather than a blur, because canvas
// filters are not something to rely on, and rather than a radial
// gradient, because what is casting it is a rectangle.
function buildGroundShade() {
    const S = 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(0,0,0,0.055)';
    for (let i = 0; i < 24; i++) {
        const inset = 6 + (i / 23) * 48;
        g.fillRect(inset, inset, S - inset * 2, S - inset * 2);
    }
    const tex = new THREE.CanvasTexture(c);
    const m = new THREE.Mesh(
        new THREE.PlaneGeometry(BASE_X * 2.45, (BASE_Z + 40) * 2.35),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = 2;                  // clear of the floor, under everything else
    m.renderOrder = 1;
    liftGrp.add(m);
}

function buildLift() {
    liftGrp = new THREE.Group();
    scene.add(liftGrp);
    buildGroundShade();
    buildBase();
    buildWheels();
    buildPowerPack();
    buildBeacon();
    buildScissor();
    buildRams();
    buildDeck();
    buildLoad();
    buildArrows();
}

// The chassis. A welded box, open only at the top - which is how a real
// one is built, and why the power pack is out of the weather but still
// in plain sight from above.
function buildBase() {
    const g = new THREE.Group();
    const yMid = BASE_Y0 + BASE_H / 2;

    const floorPan = new THREE.Mesh(roundedBox(BASE_X * 2, 26, BASE_Z * 2, 10), MAT.body);
    floorPan.position.set(0, BASE_Y0 + 13, 0);
    floorPan.castShadow = floorPan.receiveShadow = true;
    g.add(floorPan);

    [-1, 1].forEach(s2 => {
        const side = new THREE.Mesh(roundedBox(BASE_X * 2, BASE_H, 34, 10), MAT.body);
        side.position.set(0, yMid, s2 * (BASE_Z - 17));
        side.castShadow = side.receiveShadow = true;
        g.add(side);

        // a rubbing strip along the bottom, which is what actually meets
        // the pallet, the kerb and everything else it gets pushed into
        const bump = new THREE.Mesh(roundedBox(BASE_X * 2 + 30, 34, 26, 8), MAT.bodyDark);
        bump.position.set(0, BASE_Y0 + 18, s2 * (BASE_Z + 10));
        bump.castShadow = true;
        g.add(bump);

        // The track the lower roller runs along. Where it sits is not a
        // free choice: the roller's pin is on the pivot line, so the rail
        // it rides on has to be exactly one roller radius below that,
        // and one rail half-thickness below again. Put it any higher -
        // as it was - and the rail passes straight through the cross
        // shafts and their collars, which is what you see as a rail with
        // a shaft growing out of it.
        const track = new THREE.Mesh(roundedBox(BASE_X * 1.7, 22, 44, 5), MAT.steel);
        track.position.set(60, PIVOT_Y - ROLL_R - 11, s2 * (ARM_Z_IN + 40));
        g.add(track);
    });

    // The maker's plate, on the front end of the base and nowhere else -
    // the same end the beacon stands on, which is the end you walk up
    // to. High enough on it to clear the rubbing strip that wraps the
    // corners below.
    const badge = new THREE.Mesh(new THREE.PlaneGeometry(320, 87),
        new THREE.MeshStandardMaterial({ map: badgeTexture(), roughness: 0.4 }));
    badge.position.set(BASE_X + 1, yMid + 12, 0);
    badge.rotation.y = Math.PI / 2;
    g.add(badge);

    [-1, 1].forEach(s2 => {
        const end = new THREE.Mesh(roundedBox(40, BASE_H, BASE_Z * 2, 10), MAT.body);
        end.position.set(s2 * (BASE_X - 20), yMid, 0);
        end.castShadow = end.receiveShadow = true;
        g.add(end);
        // the upstand the deck comes down onto
        const post = new THREE.Mesh(roundedBox(46, 90, 46, 6), MAT.bodyDark);
        post.position.set(s2 * (BASE_X - 40), BASE_Y0 + BASE_H + 45, 0);
        g.add(post);
    });

    // the fixed pivots, one each side, that the whole lift turns about
    [-1, 1].forEach(s2 => {
        [ARM_Z_OUT, ARM_Z_IN].forEach(zz => {
            const lug = new THREE.Mesh(roundedBox(70, 84, 30, 14), MAT.bodyDark);
            lug.position.set(FIX_X, PIVOT_Y - 24, s2 * zz);
            g.add(lug);
        });
    });
    liftGrp.add(g);
}

// Four solid tyres on stub axles out of the chassis sides. Solid,
// because a pneumatic tyre under a tonne would squash and let the deck
// rock - and these are also the tipping line, so where they sit decides
// everything the machine is allowed to carry.
// One wheel, built about its own centre: carcass, tread, rim and hub.
// It knows nothing about where it is on the machine or which way it is
// pointing - that is the arm's business.
function makeWheel(g) {
    const hw = WHEEL_W / 2;
    // The carcass stops short of the rolling radius; the tread blocks
    // make up the rest, so the wheel still stands exactly WHEEL_R high.
    const carc = WHEEL_R - 16;
    const tyre = new THREE.Mesh(new THREE.LatheGeometry([
        new THREE.Vector2(58, -hw + 6), new THREE.Vector2(carc - 26, -hw),
        new THREE.Vector2(carc - 6, -hw + 10), new THREE.Vector2(carc, -hw + 26),
        new THREE.Vector2(carc, hw - 26), new THREE.Vector2(carc - 6, hw - 10),
        new THREE.Vector2(carc - 26, hw), new THREE.Vector2(58, hw - 6)
    ], 40), MAT.rubber);
    tyre.rotation.x = Math.PI / 2;
    tyre.castShadow = true;
    g.add(tyre);

    // The tread. Blocks round the circumference with the gaps between
    // them, which is the whole difference between a tyre that grips a
    // yard and a castor off an office chair.
    for (let i = 0; i < TREAD_N; i++) {
        const a = i * Math.PI * 2 / TREAD_N;
        const lug = new THREE.Mesh(roundedBox(26, 26, WHEEL_W - 14, 5), MAT.rubber);
        lug.position.set(Math.cos(a) * (WHEEL_R - 13), Math.sin(a) * (WHEEL_R - 13), 0);
        lug.rotation.z = a + Math.PI / 2;
        lug.castShadow = true;
        g.add(lug);
    }

    // The rim is painted with the machine, which is why it is the one
    // bright thing inside all that black.
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(62, 62, WHEEL_W + 2, 32), MAT.body);
    rim.rotation.x = Math.PI / 2;
    rim.castShadow = true;
    g.add(rim);
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(40, 40, WHEEL_W + 16, 24), MAT.bodyDark);
    dish.rotation.x = Math.PI / 2;
    g.add(dish);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, WHEEL_W + 26, 16), MAT.steel);
    cap.rotation.x = Math.PI / 2;
    g.add(cap);
    for (let i = 0; i < 6; i++) {            // the studs round the hub
        const a = i * Math.PI * 2 / 6;
        const b = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, WHEEL_W + 22, 10), MAT.steel);
        b.rotation.x = Math.PI / 2;
        b.position.set(Math.cos(a) * 28, Math.sin(a) * 28, 0);
        g.add(b);
    }
}

function buildWheels() {
    [-1, 1].forEach(sx => [-1, 1].forEach(sz => {
        // What is bolted to the chassis and stays put: a bracket off the
        // side, and the king-pin boss it carries.
        const bracket = new THREE.Mesh(roundedBox(150, 96, 60, 10), MAT.body);
        bracket.position.set(sx * WHEEL_X, WHEEL_R + 14, sz * (BASE_Z + 4));
        bracket.castShadow = true;
        liftGrp.add(bracket);
        const boss = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 132, 20), MAT.bodyDark);
        boss.position.set(sx * WHEEL_X, WHEEL_R + 14, sz * KING_Z);
        boss.castShadow = true;
        liftGrp.add(boss);

        // And what swings: everything from the king pin outwards. The
        // arm is a child of nothing but this pivot, so turning the group
        // turns the hub, the wheel and the tread together, exactly the
        // way a knuckle does.
        const arm = new THREE.Group();
        arm.position.set(sx * WHEEL_X, WHEEL_R, sz * KING_Z);

        const kingPin = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, 168, 16), MAT.steel);
        kingPin.position.y = 14;
        arm.add(kingPin);
        const reach = WHEEL_Z - KING_Z;
        const yoke = new THREE.Mesh(roundedBox(104, 86, reach, 12), MAT.bodyDark);
        yoke.position.z = sz * reach / 2;
        yoke.castShadow = true;
        arm.add(yoke);

        const hub = new THREE.Group();
        hub.position.z = sz * reach;
        makeWheel(hub);
        arm.add(hub);

        // Only the front pair steer, which is how these are built: the
        // back pair are there to be pushed, not aimed.
        if (sx > 0) steerArms.push(arm);
        liftGrp.add(arm);
    }));
}

// Motor, pump and tank, sat on the floor of the base where every one of
// them lives. Narrow enough to pass between the rams.
function buildPowerPack() {
    const g = new THREE.Group();
    const y = BASE_Y0 + 20;

    const tank = new THREE.Mesh(roundedBox(300, 150, 190, 12), MAT.tank);
    tank.position.set(-330, y + 75, 0);
    tank.castShadow = true;
    g.add(tank);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(26, 26, 22, 16), MAT.steel);
    cap.position.set(-410, y + 158, 0);
    g.add(cap);
    // the sight glass, because you have to be able to see the oil
    const sight = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 8, 14), MAT.warn);
    sight.rotation.x = Math.PI / 2;
    sight.position.set(-330, y + 70, 96);
    g.add(sight);

    const motor = new THREE.Mesh(new THREE.CylinderGeometry(78, 78, 230, 30), MAT.motor);
    motor.rotation.z = Math.PI / 2;
    motor.position.set(-40, y + 82, 0);
    motor.castShadow = true;
    g.add(motor);
    for (let i = 0; i < 9; i++) {          // cooling fins
        const f = new THREE.Mesh(new THREE.TorusGeometry(80, 4, 6, 24), MAT.motor);
        f.rotation.y = Math.PI / 2;
        f.position.set(-140 + i * 24, y + 82, 0);
        g.add(f);
    }
    const fan = new THREE.Mesh(new THREE.CylinderGeometry(66, 66, 34, 22), MAT.motor);
    fan.rotation.z = Math.PI / 2;
    fan.position.set(-170, y + 82, 0);
    g.add(fan);
    const box = new THREE.Mesh(roundedBox(90, 56, 70, 6), MAT.motor);
    box.position.set(-40, y + 168, 0);
    g.add(box);

    const pump = new THREE.Mesh(new THREE.CylinderGeometry(52, 52, 120, 20), MAT.steel);
    pump.rotation.z = Math.PI / 2;
    pump.position.set(110, y + 82, 0);
    pump.castShadow = true;
    g.add(pump);
    const valve = new THREE.Mesh(roundedBox(90, 90, 90, 8), MAT.steel);
    valve.position.set(200, y + 92, 0);
    g.add(valve);

    // hoses out to the two rams
    [-1, 1].forEach(s => {
        const c = new THREE.CatmullRomCurve3([
            new THREE.Vector3(230, y + 110, s * 40),
            new THREE.Vector3(300, y + 60, s * 130),
            new THREE.Vector3(FIX_X + RAM_P + 40, y + 40, s * RAM_Z)
        ]);
        const h = new THREE.Mesh(new THREE.TubeGeometry(c, 24, 11, 8, false), MAT.hose);
        h.castShadow = true;
        g.add(h);
    });
    liftGrp.add(g);
}

// The scissor itself. Both arms of a stage are the same bar, pinned at
// their middles - which is why their midpoints are always the same point,
// and why the whole linkage has exactly one degree of freedom.
//
// The `thin` argument is not styling. Where one stage hands over to the
// next, at E and at F, two arms meet on the same pin at the same z, and
// their bars, their bosses and their bores end up in exactly the same
// planes. Two surfaces sharing a plane give the depth buffer a coin to
// toss, and it tosses it again every frame and every pixel: that is the
// stipple on the bosses and the checkerboard where the bars cross. So
// every B arm is drawn a few millimetres smaller than every A arm in
// each direction. Wherever the two overlap, one is now strictly inside
// the other, there is nothing left to toss for, and at three
// millimetres on a ninety-six millimetre bar nobody can see which is
// which.
function makeArm(mat, thin) {
    const g = new THREE.Group();
    const w = ARM_W - thin, t = ARM_T - thin;
    const b = new THREE.Mesh(roundedBox(ARM_L, w, t, 18), mat);
    b.castShadow = b.receiveShadow = true;
    g.add(b);
    [-1, 1].forEach(s => {                 // a boss at each pin
        const boss = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, t + 6 - thin, 22), mat);
        boss.rotation.x = Math.PI / 2;
        boss.position.x = s * ARM_L / 2;
        boss.castShadow = true;
        g.add(boss);
        const hole = new THREE.Mesh(
            new THREE.CylinderGeometry(15 - thin / 2, 15 - thin / 2, t + 14 - thin, 16), MAT.steel);
        hole.rotation.x = Math.PI / 2;
        hole.position.x = s * ARM_L / 2;
        g.add(hole);
    });
    return g;
}

function makeRoller() {
    const g = new THREE.Group();
    const w = new THREE.Mesh(new THREE.CylinderGeometry(ROLL_R, ROLL_R, 44, 22), MAT.steel);
    w.rotation.x = Math.PI / 2;
    w.castShadow = true;
    g.add(w);
    const t = new THREE.Mesh(new THREE.TorusGeometry(ROLL_R, 7, 8, 24), MAT.rubber);
    g.add(t);
    return g;
}

// The beacon. Every lift and every crane carries one, and this is the
// kind with a clear lens and a lamp behind it that can be either
// colour, because it has two things to say and they are opposites:
// stand clear, and all clear. The lens colour is set every frame in
// update3D, along with what the lamp is doing.
const BEACON_RED = 0xff2a12, BEACON_RED_LENS = 0xb01810;
const BEACON_GREEN = 0x1fd45e, BEACON_GREEN_LENS = 0x0e7a37;

function buildBeacon() {
    const g = new THREE.Group();
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(34, 42, 22, 20), MAT.bodyDark);
    foot.position.y = 11;
    g.add(foot);
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(13, 13, 78, 14), MAT.steel);
    stalk.position.y = 60;
    g.add(stalk);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(40, 40, 20, 22), MAT.motor);
    base.position.y = 106;
    g.add(base);
    // the lens: a dome, so it is seen from every side at once
    beaconLamp = new THREE.Mesh(new THREE.SphereGeometry(40, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
                                MAT.beacon);
    beaconLamp.position.y = 116;
    beaconLamp.scale.y = 1.15;
    g.add(beaconLamp);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(14, 10, 10, 16), MAT.motor);
    cap.position.y = 162;
    g.add(cap);
    // a real light too, so the lamp lands on the machine around it
    beaconLight = new THREE.PointLight(BEACON_RED, 0, 1400, 2);
    beaconLight.position.y = 126;
    g.add(beaconLight);

    // On the front corner, where anyone standing at the machine sees it
    // without having to walk round.
    g.position.set(BASE_X - 90, BASE_Y0 + BASE_H, BASE_Z - 62);
    liftGrp.add(g);
}

function buildScissor() {
    [[armsL, ARM_Z_OUT, ARM_Z_IN], [armsU, ARM_Z_IN, ARM_Z_OUT]].forEach(([store, zA, zB]) => {
        [-1, 1].forEach(s => {
            [['A', zA, MAT.arm, 0], ['B', zB, MAT.armDark, 3]].forEach(([kind, z, mat, thin]) => {
                const m = makeArm(mat, thin);
                m.position.z = s * z;
                store.push({ m: m, kind: kind });
                liftGrp.add(m);
            });
        });
    });

    // Rollers: the ends that are not pinned have to be free to run in,
    // or the linkage would be a triangle and could not move at all.
    [-1, 1].forEach(s => {
        [[rollerL, ARM_Z_IN], [rollerU, ARM_Z_OUT]].forEach(([store, z]) => {
            const r = makeRoller();
            r.position.z = s * (z + 34);
            store.push(r);
            liftGrp.add(r);
        });
    });

    // The joints, named as they are on the schematic. C and A are the
    // fixed pivots, D and B the sliders, E and F the pins where one
    // stage hands over to the next, N and M the pins through the two
    // crossings.
    //
    // There is deliberately no beam spanning E to F. The gap between
    // them is L cos(theta) - 886 mm flat, 337 mm at full height - so
    // nothing rigid can bridge it. What ties the machine together
    // crossways is these shafts, and their length is the width of the
    // machine, which never changes at all.
    'C D E F A B'.split(' ').forEach(k => {
        joints[k] = crossShaft(26, ARM_Z_OUT + 52);
        liftGrp.add(joints[k]);
    });
    'N M'.split(' ').forEach(k => {
        const g = new THREE.Group();
        [-1, 1].forEach(s => {
            // Long enough that both heads finish clear of the steel they
            // are holding. At the old length the head landed with its
            // face in the same plane as the face of the arm, which is
            // the other place the stipple was coming from - a pin head
            // sits proud of the plate, it does not sit flush in it.
            const len = (ARM_Z_OUT - ARM_Z_IN) + ARM_T + 12;
            const pn = pin(0, 0, s * (ARM_Z_OUT + ARM_Z_IN) / 2, 20, len, MAT.steel);
            g.add(pn);
        });
        joints[k] = g;
        liftGrp.add(g);
    });
}

// A shaft right across the machine. These are the members that actually
// hold the two side frames square to each other, and the only reason
// they can be rigid is that they run across the width, not along the
// travel: their length never has to change.
function crossShaft(r, halfZ) {
    const g = new THREE.Group();
    const sh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, halfZ * 2, 20), MAT.steel);
    sh.rotation.x = Math.PI / 2;
    sh.castShadow = true;
    g.add(sh);
    [-1, 1].forEach(s => {
        const collar = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.55, r * 1.55, 26, 20), MAT.bodyDark);
        collar.rotation.x = Math.PI / 2;
        collar.position.z = s * (halfZ - 16);
        collar.castShadow = true;
        g.add(collar);
        const nut = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.15, r * 1.15, 16, 6), MAT.steel);
        nut.rotation.x = Math.PI / 2;
        nut.position.z = s * (halfZ + 6);
        g.add(nut);
    });
    return g;
}

// The rams. Two of them, mounted low and shallow, which is exactly the
// arrangement that makes the machine hardest to start off the floor -
// and exactly the arrangement every real one uses, because there is
// nowhere else for them to go.
function buildRams() {
    [-1, 1].forEach(s => {
        const g = new THREE.Group();
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 26), MAT.motor);
        barrel.rotation.z = Math.PI / 2;
        barrel.castShadow = true;
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 22), MAT.chrome);
        rod.rotation.z = Math.PI / 2;
        rod.castShadow = true;
        const capA = new THREE.Mesh(roundedBox(60, 60, 46, 10), MAT.steel);
        const capB = new THREE.Mesh(roundedBox(60, 60, 46, 10), MAT.steel);
        const port = new THREE.Mesh(new THREE.CylinderGeometry(13, 13, 44, 12), MAT.steel);
        port.rotation.x = Math.PI / 2;
        g.add(barrel); g.add(rod); g.add(capA); g.add(capB); g.add(port);
        g.position.z = s * RAM_Z;
        ramGrp.push({ g: g, barrel: barrel, rod: rod, capA: capA, capB: capB, port: port });
        liftGrp.add(g);
    });

    // The rams run inboard at z = +/-150 and the arms they drive are out
    // at +/-355, so a clevis on its own reaches nothing: it would hang in
    // clear air 205 mm short of the steel. What it actually pushes on is
    // a shaft right across the machine, through both arms and both rod
    // ends at once - which is also how the load gets shared between them.
    ramPinRod = crossShaft(24, ARM_Z_OUT + 46);
    ramPinBase = crossShaft(22, RAM_Z + 78);
    liftGrp.add(ramPinRod); liftGrp.add(ramPinBase);
}

function buildDeck() {
    deckGrp = new THREE.Group();
    const plate = new THREE.Mesh(roundedBox(DECK_X * 2, 26, DECK_Z * 2, 6), MAT.deck);
    plate.position.y = DECK_T - 13;
    plate.castShadow = plate.receiveShadow = true;
    deckGrp.add(plate);

    // The mat, laid into the plate with the painted frame showing all
    // round it. Its top stands a millimetre proud of the steel rather
    // than flush with it - flush would put two surfaces in exactly the
    // same plane, and that is the stipple all over again.
    const matt = new THREE.Mesh(
        roundedBox(DECK_X * 2 - 76, 10, DECK_Z * 2 - 76, 3), MAT.mat);
    matt.position.y = DECK_T - 4;
    matt.castShadow = matt.receiveShadow = true;
    deckGrp.add(matt);
    // the skirt underneath, which is what the arms actually push on
    [-1, 1].forEach(s => {
        const side = new THREE.Mesh(roundedBox(DECK_X * 2, DECK_T - 26, 60, 8), MAT.body);
        side.position.set(0, (DECK_T - 26) / 2, s * (DECK_Z - 30));
        side.castShadow = true;
        deckGrp.add(side);
        const end = new THREE.Mesh(roundedBox(60, DECK_T - 26, DECK_Z * 2, 8), MAT.body);
        end.position.set(s * (DECK_X - 30), (DECK_T - 26) / 2, 0);
        end.castShadow = true;
        deckGrp.add(end);
        // the track the upper roller runs along, under the deck
        const track = new THREE.Mesh(roundedBox(ARM_L * 1.3, 20, 34, 5), MAT.steel);
        track.position.set(60, 12, s * (ARM_Z_OUT + 34));
        deckGrp.add(track);
        // and the lugs the upper arms are pinned to
        const lug = new THREE.Mesh(roundedBox(70, 70, 30, 14), MAT.bodyDark);
        lug.position.set(FIX_X, 26, s * ARM_Z_IN);
        deckGrp.add(lug);
    });
    // Hazard striping right round the edge of the deck plate, which is
    // what these actually wear - all four edges, because the edge you
    // can walk into is every edge. The band is exactly the depth of the
    // plate and carries the stripes as a tile, so nothing hangs below
    // the plate or stands proud above it whatever length it runs.
    const hy = DECK_T - 13;
    [-1, 1].forEach(s => {
        const long = new THREE.Mesh(roundedBox(DECK_X * 2 + 16, 26, 8, 2), MAT.hazard);
        long.position.set(0, hy, s * (DECK_Z + 4));
        deckGrp.add(long);
        const short = new THREE.Mesh(roundedBox(DECK_Z * 2, 26, 8, 2), MAT.hazard);
        short.rotation.y = Math.PI / 2;
        short.position.set(s * (DECK_X + 4), hy, 0);
        deckGrp.add(short);
    });
    liftGrp.add(deckGrp);
}

// =============================================================
//  The load
// =============================================================
const woodOf = i => MAT.wood[((i % MAT.wood.length) + MAT.wood.length) % MAT.wood.length];

function buildLoad() {
    crateGrp = new THREE.Group();
    // A pallet is never quite square to the deck. A degree and a half of
    // it is the difference between something put there and something
    // modelled there.
    crateGrp.rotation.y = 0.026;
    buildPallet();
    buildCrate();
    liftGrp.add(crateGrp);
}

function buildPallet() {
    const g = new THREE.Group();
    let n = 0;

    // three bottom boards, running the length
    [0, -1, 1].forEach(i => {
        const b = new THREE.Mesh(roundedBox(PAL_X, PAL_BOARD, 100, 3), woodOf(n++));
        b.position.set(0, PAL_BOARD / 2, i * PAL_BZ);
        b.castShadow = b.receiveShadow = true;
        g.add(b);
    });

    // nine blocks, which are what actually hold the fork openings open
    [0, -1, 1].forEach(ix => [0, -1, 1].forEach(iz => {
        const bl = new THREE.Mesh(roundedBox(120, PAL_BLOCK_H, 100, 4), MAT.block);
        bl.position.set(ix * PAL_BX, PAL_BOARD + PAL_BLOCK_H / 2, iz * PAL_BZ);
        bl.castShadow = bl.receiveShadow = true;
        g.add(bl);
    }));

    // three bearers across them
    [0, -1, 1].forEach(i => {
        const b = new THREE.Mesh(roundedBox(PAL_Z, PAL_BOARD, 145, 3), woodOf(n++));
        b.rotation.y = Math.PI / 2;
        b.position.set(i * PAL_BX, PAL_BOARD + PAL_BLOCK_H + PAL_BOARD / 2, 0);
        b.castShadow = b.receiveShadow = true;
        g.add(b);
    });

    // and the deck boards on top: wide, narrow, wide, narrow, wide, with
    // the gaps that let the rain off and the forks of a pallet truck in
    const wide = [145, 100, 145, 100, 145];
    const gap = (PAL_Z - wide.reduce((a, b) => a + b, 0)) / (wide.length - 1);
    let z = -PAL_Z / 2;
    wide.forEach(w => {
        const b = new THREE.Mesh(roundedBox(PAL_X, PAL_BOARD, w, 3), woodOf(n++));
        b.position.set(0, PAL_H - PAL_BOARD / 2, z + w / 2);
        b.castShadow = b.receiveShadow = true;
        g.add(b);
        // a nail down into each bearer, which is where they always are
        [0, -1, 1].forEach(ix => {
            const nail = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 3, 8), MAT.steel);
            nail.position.set(ix * PAL_BX, PAL_H - 0.5, z + w / 2);
            g.add(nail);
        });
        z += w + gap;
    });
    crateGrp.add(g);
}

function buildCrate() {
    const g = new THREE.Group();
    g.position.y = PAL_H;

    // Four corner posts, drawn a metre long and scaled. The only thing
    // the load changes about a post is how far up it goes, and stretching
    // grain that already runs lengthwise is the one stretch nobody sees.
    [-1, 1].forEach(sx => [-1, 1].forEach(sz => {
        const p = new THREE.Mesh(roundedBox(CRATE_POST, POST_NOM, CRATE_POST, 6), woodOf(1));
        p.position.set(sx * (CRATE_X - CRATE_POST) / 2, POST_NOM / 2,
                       sz * (CRATE_Z - CRATE_POST) / 2);
        p.castShadow = p.receiveShadow = true;
        loadParts.posts.push(p);
        g.add(p);
    }));

    // The courses of boarding, nailed to the outside of the posts, the
    // long boards lapping the ends so the corner is closed. All five are
    // built; how many are shown is the load.
    for (let k = 0; k < ROWS_MAX; k++) {
        const row = new THREE.Group();
        row.position.y = k * CRATE_PITCH + CRATE_BOARD / 2;
        [-1, 1].forEach(s => {
            const long = new THREE.Mesh(
                roundedBox(CRATE_X + CRATE_T * 2, CRATE_BOARD, CRATE_T, 3), woodOf(k));
            long.position.z = s * (CRATE_Z + CRATE_T) / 2;
            long.castShadow = long.receiveShadow = true;
            row.add(long);
            const end = new THREE.Mesh(
                roundedBox(CRATE_Z, CRATE_BOARD, CRATE_T, 3), woodOf(k + 1));
            end.rotation.y = Math.PI / 2;
            end.position.x = s * (CRATE_X + CRATE_T) / 2;
            end.castShadow = end.receiveShadow = true;
            row.add(end);
        });
        loadParts.rows.push(row);
        g.add(row);
    }

    // the lid, four boards across with the gaps left between them
    const lid = new THREE.Group();
    const span = CRATE_Z + CRATE_T * 2;
    const lw = span / 4;
    for (let i = 0; i < 4; i++) {
        const b = new THREE.Mesh(roundedBox(CRATE_X + CRATE_T * 2, CRATE_T, lw - 9, 3), woodOf(i));
        b.position.z = -span / 2 + lw * (i + 0.5);
        b.castShadow = b.receiveShadow = true;
        lid.add(b);
    }
    loadParts.lid = lid;
    g.add(lid);

    // whatever is inside, seen through the gaps between the courses
    const goods = new THREE.Mesh(new THREE.BoxGeometry(CRATE_X - 30, 1, CRATE_Z - 30), MAT.goods);
    goods.castShadow = goods.receiveShadow = true;
    loadParts.goods = goods;
    g.add(goods);

    // the stencil, on the bottom course - the only one that is always there
    [-1, 1].forEach(s => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(850, 118), MAT.mark);
        m.position.set(0, CRATE_BOARD / 2, s * (span / 2 + 1.5));
        m.rotation.y = s > 0 ? 0 : Math.PI;
        g.add(m);
    });

    // Two steel bands over the lid and down through the pallet's fork
    // openings. They are the only thing making the crate and the pallet
    // one object rather than two stacked ones - which is exactly what a
    // lift is entitled to assume before it picks the lot up.
    [-1, 1].forEach(s => {
        const b = new THREE.Group();
        b.position.x = s * BAND_X;
        const w = CRATE_Z + CRATE_T * 2 + 22;
        const top = new THREE.Mesh(roundedBox(58, 5, w, 2), MAT.band);
        top.castShadow = true;
        const bot = new THREE.Mesh(roundedBox(58, 5, w, 2), MAT.band);
        bot.position.y = -PAL_BOARD - 6;
        const sides = [];
        [-1, 1].forEach(sz => {
            const side = new THREE.Mesh(roundedBox(58, POST_NOM, 5, 2), MAT.band);
            side.position.z = sz * w / 2;
            sides.push(side);
            b.add(side);
        });
        b.add(top); b.add(bot);
        loadParts.bands.push({ top: top, sides: sides });
        g.add(b);
    });

    crateGrp.add(g);
}

// Two arrows to the same scale: what the rams are pushing with, and what
// the load weighs. Seeing them side by side at the bottom of the stroke
// is the whole lesson in one picture.
function makeArrow(mat) {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 1, 14), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(26, 62, 18), mat);
    g.add(shaft); g.add(head);
    g.userData = { shaft: shaft, head: head };
    return g;
}

function buildArrows() {
    [-1, 1].forEach(s => {
        const a = makeArrow(MAT.forceRam);
        a.position.z = s * RAM_Z;
        arrowRam.push(a);
        liftGrp.add(a);
    });
    arrowLoad = makeArrow(MAT.forceW);
    liftGrp.add(arrowLoad);
}

// =============================================================
//  Drawing one frame
// =============================================================
// Nothing below decides anything. Every position on the machine is
// theta and the two lines of trigonometry at the top of this file.
function setArms(list, yBase, midX, h, th) {
    list.forEach(a => {
        a.m.position.x = midX;
        a.m.position.y = yBase + h / 2;
        // Both arms of a stage share this midpoint - that is the pin
        // through the middle - and they lean opposite ways about it.
        a.m.rotation.z = a.kind === 'A' ? th : Math.PI - th;
    });
}

// The load is built once at its largest and then told how much of
// itself to be. Nothing here allocates, so the mass slider can be
// dragged the whole way across without the frame rate noticing.
function updateLoad(y2) {
    crateGrp.visible = loadShown();
    crateGrp.position.set(P.offset, y2 + DECK_T, 0);
    if (!crateGrp.visible) return;

    const rows = loadRows(), h = crateH();
    loadParts.rows.forEach((r, i) => { r.visible = i < rows; });
    loadParts.posts.forEach(p => {
        p.scale.y = h / POST_NOM;
        p.position.y = h / 2;
    });
    loadParts.lid.position.y = h - CRATE_T / 2;
    const gh = h - CRATE_T - 16;
    loadParts.goods.scale.y = gh;
    loadParts.goods.position.y = 8 + gh / 2;
    loadParts.bands.forEach(b => {
        b.top.position.y = h + 4;
        b.sides.forEach(side => {
            side.scale.y = (h + 32) / POST_NOM;
            side.position.y = (h - 24) / 2;
        });
    });
    if (markKg !== P.load) drawMarks();
}

function update3D() {
    if (!gl) return;
    const th = state.th, c = Math.cos(th), s = Math.sin(th);
    const h = ARM_L * s, span = ARM_L * c;
    const rollX = FIX_X + span, midX = FIX_X + span / 2;
    const y0 = PIVOT_Y, y1 = y0 + h, y2 = y1 + h;

    setArms(armsL, y0, midX, h, th);
    setArms(armsU, y1, midX, h, th);
    rollerL.forEach(r => { r.position.x = rollX; r.position.y = y0; });
    rollerU.forEach(r => { r.position.x = rollX; r.position.y = y2 - 6; });
    deckGrp.position.y = y2;

    // Every joint on the schematic, put where the trigonometry says.
    // E sits square above C and F square above D at every height, which
    // is what makes the deck rise straight up instead of swinging.
    joints.C.position.set(FIX_X, y0, 0);
    joints.D.position.set(rollX, y0, 0);
    joints.E.position.set(FIX_X, y1, 0);
    joints.F.position.set(rollX, y1, 0);
    joints.A.position.set(FIX_X, y2, 0);
    joints.B.position.set(rollX, y2, 0);
    joints.N.position.set(midX, y0 + h / 2, 0);
    joints.M.position.set(midX, y1 + h / 2, 0);
    updateLoad(y2);

    // Steering. Both front arms take the same angle - no Ackermann here,
    // since nothing on this page is asked to roll far enough to care
    // that the inner wheel should turn further than the outer one.
    const lock = P.steer * Math.PI / 180;
    steerArms.forEach(a => { a.rotation.y = lock; });

    // the rams, from the cosine-rule triangle
    const bx = FIX_X + RAM_P, by = y0;
    const rx = FIX_X + RAM_Q * c, ry = y0 + RAM_Q * s;
    const dx = rx - bx, dy = ry - by, L = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx), ux = dx / L, uy = dy / L;
    const bodyR = P.bore * 0.62, rodR = P.bore * 0.30, BODY = 380;
    const rodL = Math.max(40, L - 300);
    ramGrp.forEach(r => {
        r.barrel.scale.set(bodyR, BODY, bodyR);
        r.barrel.rotation.z = Math.PI / 2 + ang;
        r.barrel.position.set(bx + ux * BODY / 2, by + uy * BODY / 2, 0);
        r.rod.scale.set(rodR, rodL, rodR);
        r.rod.rotation.z = Math.PI / 2 + ang;
        r.rod.position.set(bx + ux * (300 + rodL / 2), by + uy * (300 + rodL / 2), 0);
        r.capA.position.set(bx, by, 0); r.capA.rotation.z = ang;
        r.capB.position.set(rx, ry, 0); r.capB.rotation.z = ang;
        r.port.position.set(bx + ux * 300, by + uy * 300, 0);
    });
    ramPinBase.position.set(bx, by, 0);
    ramPinRod.position.set(rx, ry, 0);

    // Force arrows. A ram at the bottom of its stroke is pushing twenty
    // times the weight it is lifting, so drawn to a true scale one arrow
    // would be off the screen while the other was a stub. The square root
    // keeps both in the picture; the read-out has the real numbers.
    const arrowLen = f => 90 + 700 * Math.sqrt(clamp(f / 400000, 0, 1));
    const fRam = ramForce() / N_RAM;
    arrowRam.forEach(a => {
        a.visible = state.forces;
        const len = arrowLen(fRam);
        a.userData.shaft.scale.y = len;
        a.userData.shaft.position.set(0, len / 2, 0);
        a.userData.head.position.set(0, len + 31, 0);
        a.position.set(rx, ry, a.position.z);
        a.rotation.z = ang - Math.PI / 2;
    });
    if (arrowLoad) {
        arrowLoad.visible = state.forces;
        const len = arrowLen(loadW());
        arrowLoad.userData.shaft.scale.y = len;
        arrowLoad.userData.shaft.position.set(0, -len / 2, 0);
        arrowLoad.userData.head.position.set(0, -len - 31, 0);
        arrowLoad.userData.head.rotation.z = Math.PI;
        // Above whatever is on the deck, pointing down onto it - the
        // weight has to be seen arriving somewhere.
        arrowLoad.position.set(P.offset, y2 + DECK_T + (loadShown() ? loadH() : 0) + len + 80, 0);
        arrowLoad.rotation.z = 0;
    }

    // The beacon says one of three things, and only one at a time.
    //
    // Red, flashing twice a second: a direction has been asked for, and
    // the machine is either sounding its warning or moving. It follows
    // the command and not the motor run-down, so arriving at a stop
    // ends it at once rather than leaving it flashing over a machine
    // that has finished moving.
    //
    // Green, steady: fully down or fully up. These are the only two
    // states in which the deck is resting on something and cannot move
    // any further that way - nothing is part way through anything, and
    // it is safe to load, unload or walk up to. A steady lamp, not a
    // strobe: a strobe is a warning, and there is nothing to warn of.
    //
    // Dark: held part way. Not moving, but not resting on anything
    // either - the load is standing on oil, and that is not a state to
    // put a green light over.
    if (beaconLamp) {
        const live = state.cmd !== 0 || state.warn > 0;
        const safe = !live && (atStop(1) || atStop(-1));
        const flash = live && Math.sin(performance.now() / 1000 * Math.PI * 4) > 0;
        const m = beaconLamp.material;
        m.color.setHex(safe ? BEACON_GREEN_LENS : BEACON_RED_LENS);
        m.emissive.setHex(safe ? BEACON_GREEN : BEACON_RED);
        m.emissiveIntensity = safe ? 1.5 : (flash ? 2.4 : 0.08);
        beaconLight.color.setHex(safe ? BEACON_GREEN : BEACON_RED);
        // The red flash can afford to throw itself over the machine
        // because it is gone again half a second later. The green is on
        // the whole time the lift is parked, and a machine permanently
        // washed green reads as a fault rather than as calm - so the
        // lens is bright and what it spills is barely there.
        beaconLight.intensity = safe ? 0.22 : (flash ? 2.2 : 0);
    }

    controls.update();
    renderer.render(scene, camera);
}

const VIEWS = {
    // Far enough back to hold the whole travel, and the load on top of
    // it, without the deck walking out of frame as it rises.
    whole:   { pos: [2900, 2000, 3300], tgt: [0, 1150, 0] },
    // Where the mechanical advantage lives: the arms, the pins and the
    // angle between them.
    scissor: { pos: [1500, 1150, 1600], tgt: [-40, 720, 60] },
    ram:     { pos: [520, 640, 900],    tgt: [-20, 490, 150] },
    pack:    { pos: [-620, 520, 880],   tgt: [-160, 250, 0] },
    wheel:   { pos: [1000, 470, 1120],  tgt: [420, 150, 470] },
    deck:    { pos: [1600, 2500, 2000], tgt: [0, 1700, 0] }
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
    $('stat-h').textContent = heightM().toFixed(2);
    $('stat-f').textContent = (ramForce() / 1000).toFixed(0);
    $('stat-p').textContent = pressure().toFixed(0);
    const dir = state.cmd || (state.motion > 0 ? state.lastDir : 0);
    $('stat-v').textContent = ((dir > 0 ? deckSpeed()
                              : dir < 0 ? -LOWER_SPEED * ratio(state.th) : 0)
                              * state.motion).toFixed(0);
    $('stat-w').textContent = (state.cmd > 0 && stalled() ? motorPower() / 1000
                              : dir > 0 ? motorPower() * state.motion / 1000 : 0).toFixed(1);
}

// =============================================================
//  Sound
// =============================================================
// Three recordings and one rule: the warning sounds first and nothing
// moves until it has. On the way up that is the pump; on the way down
// there is no pump at all - the load does the work and the valve only
// meters out what it gives back - so the two are not the same noise.
let aBeep = null, aRaise = null, aLower = null;
function initAudio() {
    aBeep = $('a-beep'); aRaise = $('a-raise'); aLower = $('a-lower');
}
function loopOn(el, vol, rate) {
    if (!el) return;
    el.volume = clamp(vol, 0, 1);
    el.playbackRate = clamp(rate || 1, 0.5, 2);
    if (el.paused) el.play().catch(() => {});
}
function loopOff(el) { if (el && !el.paused) { try { el.pause(); } catch (e) {} } }
function oneShot(el, vol) {
    if (!el || !state.sound) return;
    try { el.currentTime = 0; } catch (e) {}
    el.volume = vol;
    el.play().catch(() => {});
}

// Already as far as it goes that way. A machine sat on its stop does
// not warn, flash or beep at a button it cannot act on.
const atStop = dir => dir > 0 ? state.th >= TH_MAX - 1e-9 : state.th <= TH_MIN + 1e-9;

// Sounded the moment a direction is asked for, before any of it moves.
function warnAndGo(dir) {
    if (atStop(dir)) { state.cmd = 0; state.warn = 0; return; }
    state.cmd = dir;
    state.lastDir = dir;
    state.warn = WARN_TIME;
    loopOff(aRaise); loopOff(aLower);
    oneShot(aBeep, 0.25);
}

function soundUpdate() {
    if (!aRaise) return;
    // The sound follows state.motion, so it winds up with the pump and
    // runs down with it, instead of being cut off at the stop.
    const m = state.sound && state.warn <= 0 ? state.motion : 0;
    const dir = state.cmd || state.lastDir;
    const rate = 0.78 + 0.22 * m;
    if (m > 0.02 && dir > 0) {
        // and the note rides with the pressure the load is asking for
        loopOn(aRaise, (0.30 + 0.25 * clamp(pressure() / P.relief, 0, 1)) * m, rate);
    } else loopOff(aRaise);
    if (m > 0.02 && dir < 0) loopOn(aLower, 0.34 * m, rate);
    else loopOff(aLower);
}
function soundStop() {
    [aBeep, aRaise, aLower].forEach(loopOff);
}

// =============================================================
//  Loop
// =============================================================
// How much of full flow to allow, given how near the ram is to the end
// of its own travel. Measured on the RAM rather than on the angle,
// because the ram is the part moving at a steady rate - so the run-in
// takes the same couple of seconds whether it is easing onto the top
// stop or the bottom one, even though the deck speed differs tenfold.
function endEase(dir) {
    const sr = ramLen(state.th);
    const room = dir > 0 ? (ramLen(TH_MAX) - sr) : (sr - ramLen(TH_MIN));
    return EASE_FLOOR + (1 - EASE_FLOOR) * ease(room / EASE_RAM);
}

function step(dt) {
    // The warning runs first and the machine waits for it. This is the
    // order a real one does it in, and it is not decoration: people
    // stand next to these things.
    if (state.warn > 0) {
        state.warn = Math.max(0, state.warn - dt);
        state.motion = 0;
        return;
    }

    // Past the relief setting the valve opens and the oil goes round in a
    // circle. The motor works just as hard and nothing moves.
    const blocked = state.cmd > 0 && stalled();
    const want = (state.cmd !== 0 && !blocked) ? endEase(state.cmd) : 0;
    state.motion += (want - state.motion) * Math.min(1, dt / RAMP_TIME);
    if (state.motion < 0.001) state.motion = 0;
    if (blocked || state.cmd === 0) return;

    // Coming down needs no pump at all: the load does the work, and the
    // valve only decides how fast it is allowed to give it back.
    const dth = (state.cmd > 0 ? deckSpeed() : -LOWER_SPEED * ratio(state.th))
                * state.motion * dt / (STAGES * ARM_L * Math.cos(state.th));
    state.th = clamp(state.th + dth, TH_MIN, TH_MAX);
    // The command drops out at the stop, and the motor runs itself down
    // over the next half second rather than being switched off.
    if (state.th >= TH_MAX || state.th <= TH_MIN) state.cmd = 0;
}

const DT = 1 / 120;
let acc = 0, last = performance.now();
function frame(now) {
    const real = Math.min((now - last) / 1000, 0.05); last = now;
    advanceCamera(real);
    acc += real;
    let guard = 0;
    while (acc >= DT && guard++ < 400) { step(DT); acc -= DT; }
    soundUpdate();
    updateStats();
    update3D();
    requestAnimationFrame(frame);
}

// =============================================================
//  Controls
// =============================================================
function reset() {
    Object.assign(P, DEFAULTS);
    state.th = TH_MIN; state.cmd = 0; state.warn = 0;
    state.motion = 0; state.lastDir = 0;
    soundStop();
    ['load', 'offset', 'bore', 'flow', 'relief', 'steer'].forEach(k => {
        $('s-' + k).value = P[k];
        $('v-' + k).textContent = P[k];
    });
    paintRun();
}
function bindSlider(id, key, after) {
    const s = $(id), out = $(id.replace('s-', 'v-'));
    s.addEventListener('input', () => {
        P[key] = parseFloat(s.value);
        if (out) out.textContent = P[key];
        if (after) after();
    });
}
['load', 'offset', 'bore', 'flow', 'relief', 'steer'].forEach(k => bindSlider('s-' + k, k));

function paintRun() {
    $('btn-up').classList.toggle('bg-slate-900', state.cmd >= 0);
    $('btn-up').classList.toggle('text-white', state.cmd >= 0);
}
$('btn-up').addEventListener('click', () => { warnAndGo(1); paintRun(); });
$('btn-down').addEventListener('click', () => { warnAndGo(-1); paintRun(); });
$('btn-stop').addEventListener('click', () => {
    state.cmd = 0; state.warn = 0; soundStop(); paintRun();
});
$('btn-reset').addEventListener('click', () => reset());

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
bindChip('crate', 'crate');
bindChip('sound', 'sound', () => { if (!state.sound) soundStop(); });
bindChip('forces', 'forces');
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
