// =============================================================
//  Breadboard — model
// =============================================================
// Volts, amps and ohms, displayed in the units a bench actually uses:
// milliamps and milliwatts, because everything on this board is small.
//
// The whole simulation is one series loop solved fresh every frame.
// There is no general circuit solver here and there does not need to
// be — there are four topologies, they are all known in advance, and
// each one is a single line of algebra. What matters is that the line
// of algebra is the real one, so the numbers on screen are numbers a
// student could have got with a calculator.

// A battery is not a perfect source. It has resistance of its own, and
// that one fact is the whole reason the supply reading sags the moment
// you ask it for current — and the reason a dead short draws amps
// rather than infinity.
const R_INT = 1.0;                    // ohms, a small AA pack
const R_WIRE = 0.2;                   // the board's own contacts, all told

// The preferred values you actually find in a school parts drawer.
// Nought is in the list on purpose: it is the mistake worth making.
const R_VALUES = [0, 10, 22, 47, 100, 220, 330, 470, 680, 1000, 2200, 4700, 10000];

// A red 5 mm LED. Below the forward voltage it passes nothing worth
// having; above it, the current runs away. rd is the small slope
// resistance that stops the model dividing by zero — a real diode's
// curve is exponential, and this is its tangent.
const LED = {
    vf: 1.8,          // forward voltage, red
    rd: 12,           // slope resistance, ohms
    rated: 0.020,     // what it is designed to pass
    hurt: 0.035,      // above this it is cooking
    kill: 0.20        // accumulated heat that finishes it
};

// A small can motor, of the kind that comes in a kit. Modelled at
// steady state: the supply pushes current through the winding, the
// current makes torque, and the spinning generates a voltage back
// against the supply. That last term is why a running motor draws so
// much less than a stalled one.
const MOTOR = {
    r: 6,             // armature resistance, ohms
    k: 0.0075,        // V per rad/s, and N·m per A — the same constant
    b: 2.2e-6,        // viscous friction
    tf: 0.00035       // the torque it takes just to break it free
};

// A piezo buzzer is near enough a resistor that also makes a noise.
const BUZZER = { r: 95, on: 0.004, hz: 2300 };

const DEFAULTS = { emf: 6, res: 5, pot: 22 };
const P = Object.assign({}, DEFAULTS);

const state = {
    circuit: 'led',                   // led | two | motor | buzzer
    wiring: 'series',                 // only means anything with two LEDs
    limiter: 'fixed',                 // fixed | pot
    probe: 'off',                     // off | batt | res | load | amps
    closed: false,                    // is the switch made?
    flipped: false,                   // is the LED in backwards?
    burnt: false,                     // has it been killed?
    heat: 0,                          // how close it is to being killed
    fast: false, slow: false,
    links: true,                      // x-ray the board and show the strips
    flow: true,                       // beads running round the loop
    labels: false,
    sound: false, mesh: false, turntable: false,
    lit: 0,                           // LED brightness, eased for the glow
    rpm: 0,                           // motor speed, eased
    spin: 0,                          // motor shaft angle
    beads: 0,                         // how far the flow beads have gone
    viewMode: 'light'
};

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ---- the chain of consequences, all from four numbers ---------
const emf = () => P.emf;
const resOhms = () => R_VALUES[P.res];
// Squared, so the first half of the knob's travel covers the range
// where an LED actually changes brightness. A linear pot would spend
// nine tenths of its sweep doing nothing you can see.
const potOhms = () => Math.round((P.pot / 100) * (P.pot / 100) * 10000);
const limiterOhms = () => state.limiter === 'pot' ? potOhms() : resOhms();

// How many LEDs are lit up as one load, and how they are joined.
const twoLED = () => state.circuit === 'two';
const inSeries = () => twoLED() && state.wiring === 'series';
const inParallel = () => twoLED() && state.wiring === 'parallel';

// Is there a path at all? Every one of these stops the loop dead, and
// each of them is a different lesson.
function broken() {
    if (!state.closed) return 'switch';
    if (state.burnt && state.circuit !== 'motor' && state.circuit !== 'buzzer') return 'burnt';
    if (state.flipped && state.circuit !== 'motor' && state.circuit !== 'buzzer') return 'backwards';
    return null;
}

// The one piece of algebra the whole page rests on. Everything the
// readings show, the LED's brightness, the motor's speed and the
// buzzer's note all come out of this.
function solve() {
    const out = {
        i: 0,          // current the battery is supplying
        iled: 0,       // current through one LED
        vterm: emf(),  // what the terminals are actually at
        vres: 0,       // volts across the limiter
        vload: 0,      // volts across the LED, motor or buzzer
        rext: 0,       // what the battery is looking into
        w: 0,          // power leaving the battery
        omega: 0       // motor speed, rad/s
    };
    if (broken()) return out;

    const R = limiterOhms() + R_WIRE;
    let i = 0;

    if (state.circuit === 'motor') {
        // Solve the two steady-state equations together:
        //     V = I(R + Rm) + k·omega        (the electrical loop)
        //     kI = b·omega + Tf              (torque in equals torque out)
        const Rt = R + R_INT + MOTOR.r;
        const num = emf() - MOTOR.tf * Rt / MOTOR.k;
        const den = MOTOR.b * Rt / MOTOR.k + MOTOR.k;
        const w = num / den;
        if (w > 0) {
            out.omega = w;
            i = (MOTOR.b * w + MOTOR.tf) / MOTOR.k;
        } else {
            // Not enough to break it free. It sits there stalled, and
            // with no back-EMF it draws far more than it would running.
            out.omega = 0;
            i = emf() / Rt;
        }
    } else if (state.circuit === 'buzzer') {
        i = emf() / (R + R_INT + BUZZER.r);
    } else {
        // One LED, two in series, or two side by side. In parallel the
        // pair passes the same volts as one but splits the current, so
        // its slope resistance halves.
        const vf = inSeries() ? 2 * LED.vf : LED.vf;
        const rd = inSeries() ? 2 * LED.rd : inParallel() ? LED.rd / 2 : LED.rd;
        i = Math.max(0, (emf() - vf) / (R + R_INT + rd));
        out.iled = inParallel() ? i / 2 : i;
    }

    out.i = i;
    out.vterm = emf() - i * R_INT;
    out.vres = i * limiterOhms();
    out.vload = Math.max(0, out.vterm - out.vres - i * R_WIRE);
    out.rext = i > 1e-9 ? out.vterm / i : 0;
    out.w = out.vterm * i;
    return out;
}
let S = solve();

// Brightness, as a fraction of what the LED is designed to pass. Over
// 1 it is being driven too hard, and it goes white before it goes out.
const brightness = () => clamp(S.iled / LED.rated, 0, 1.6);

// A dead short is worth naming separately from an overload: it is the
// same fault, but it is the one that happens in a hurry.
const shorted = () => limiterOhms() === 0 && state.closed &&
    (state.circuit === 'led' || state.circuit === 'two') && !state.burnt && !state.flipped;

// =============================================================
//  The board, in three dimensions
// =============================================================
// One unit is a quarter of a millimetre, near enough, which makes the
// 0.1 inch hole pitch a round ten. Every position on the board is
// therefore a whole number of units, and nothing ever has to be
// nudged into place by eye.
const PITCH = 10;
const COLS = 30;                      // a half-size, 400-point board
const colX = c => (c - (COLS - 1) / 2) * PITCH;

// Rows A to E above the channel, F to J below it. The channel is three
// pitches wide, which is what makes a chip straddle it correctly.
const ROW_Z = { A: -55, B: -45, C: -35, D: -25, E: -15, F: 15, G: 25, H: 35, I: 45, J: 55 };
const ROWS_TOP = ['A', 'B', 'C', 'D', 'E'];
const ROWS_BOT = ['F', 'G', 'H', 'I', 'J'];

// The four rails, and which way round the printed lines go.
const RAIL = {
    tn: { z: -88, plus: false }, tp: { z: -78, plus: true },
    bp: { z: 78, plus: true }, bn: { z: 88, plus: false }
};
// 25 holes a rail, in five groups of five — the gaps are moulded in so
// you can count along without losing your place.
const railX = i => -140 + Math.floor(i / 5) * 60 + (i % 5) * 10;

const BOARD = { x: 165, z: 103, h: 18 };   // half-width, half-depth, thickness
const TOP = BOARD.h;                        // y of the board's face
const CHAN = 13;                            // half-width of the centre channel

const HOLE_XZ = (c, r) => new THREE.Vector3(colX(c), TOP, ROW_Z[r]);

let scene, camera, renderer, controls;
let bench3, grid3, boardGrp, stripGrp, partsGrp, wireGrp, beadGrp;
let ledGrp = [], ledCore = [], ledGlow = [], ledLight = [];
let motorGrp = null, propGrp = null, buzzGrp = null, potGrp = null, potKnob = null;
let resGrp = null, resBands = [], switchGrp = null, switchLever = null;
let meterGrp = null, meterCv = null, meterTex = null, meterSock = [], meterFace = null, meterKnob = null;
let probeRed = null, probeBlk = null;
let labelGrp = null;
let beads = [];
let gl = false;
const MAT = {};

function roundedBox(w, h, d, r) {
    const bev = Math.min(1.5, w / 6, h / 6, d / 6);
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

// ---- the face of the board ------------------------------------
// Holes, the two coloured rail lines, the row letters and the column
// numbers, all drawn once into a canvas. Painting them rather than
// modelling them saves eight hundred meshes for something that is
// flat anyway — and the numbers down the edge are half the reason a
// beginner can follow an instruction sheet at all.
let boardTex = null;
function boardTexture() {
    if (boardTex) return boardTex;
    const U = 4;                                   // pixels per unit
    const W = BOARD.x * 2 * U, H = BOARD.z * 2 * U;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const px = x => (x + BOARD.x) * U, pz = z => (z + BOARD.z) * U;

    g.fillStyle = '#efece1'; g.fillRect(0, 0, W, H);
    // the faint speckle of moulded ABS, so it is not dead flat white
    for (let i = 0; i < 5200; i++) {
        g.fillStyle = 'rgba(150,146,132,' + (0.03 + Math.random() * 0.05) + ')';
        g.fillRect(Math.random() * W, Math.random() * H, 2, 2);
    }
    // the channel down the middle
    const cg = g.createLinearGradient(0, pz(-CHAN), 0, pz(CHAN));
    cg.addColorStop(0, '#c9c5b6'); cg.addColorStop(0.5, '#ded9cb'); cg.addColorStop(1, '#c9c5b6');
    g.fillStyle = cg; g.fillRect(0, pz(-CHAN), W, (CHAN * 2) * U);

    // a hole is a square pocket with a dark throat and a lit top edge
    function hole(x, z) {
        const s = 4.4 * U, X = px(x) - s / 2, Z = pz(z) - s / 2;
        g.fillStyle = '#3d3a33'; g.fillRect(X, Z, s, s);
        g.fillStyle = '#17161a'; g.fillRect(X + 1.5, Z + 1.5, s - 3, s - 3);
        g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(X, Z, s, 1.5);
    }
    for (let c = 0; c < COLS; c++)
        Object.keys(ROW_Z).forEach(r => hole(colX(c), ROW_Z[r]));
    Object.keys(RAIL).forEach(k => { for (let i = 0; i < 25; i++) hole(railX(i), RAIL[k].z); });

    // The printed lines. They sit outside their own row of holes, which
    // is how you tell at a glance which rail is which.
    Object.keys(RAIL).forEach(k => {
        const r = RAIL[k], out = (r.z < 0 ? -1 : 1) * 7;
        g.fillStyle = r.plus ? '#c0392b' : '#2a5fa8';
        g.fillRect(px(-152), pz(r.z + out) - 1.5 * U, 304 * U, 3 * U);
        g.font = 'bold ' + (11 * U) + 'px ui-monospace, Menlo, monospace';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        [-157, 157].forEach(x => g.fillText(r.plus ? '+' : '−', px(x), pz(r.z + out)));
    });

    // column numbers along both edges of the main block, every fifth
    g.fillStyle = '#6b675c';
    g.font = 'bold ' + (7 * U) + 'px ui-monospace, Menlo, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let c = 0; c < COLS; c++) {
        const n = c + 1;
        if (n !== 1 && n !== COLS && n % 5 !== 0) continue;
        g.fillText(String(n), px(colX(c)), pz(-64));
        g.fillText(String(n), px(colX(c)), pz(64));
    }
    // row letters down both sides
    Object.keys(ROW_Z).forEach(r => {
        [-155, 155].forEach(x => g.fillText(r, px(x), pz(ROW_Z[r])));
    });

    boardTex = new THREE.CanvasTexture(cv);
    boardTex.anisotropy = 8;
    return boardTex;
}

// The meter's own display, redrawn whenever the reading changes.
function meterTexture() {
    meterCv = document.createElement('canvas');
    meterCv.width = 512; meterCv.height = 256;
    meterTex = new THREE.CanvasTexture(meterCv);
    drawMeter('OFF', '');
    return meterTex;
}
function drawMeter(value, unit) {
    if (!meterCv) return;
    const g = meterCv.getContext('2d');
    // A digital meter's display is a passive LCD: dark segments on a
    // pale grey-green ground. It does not glow, and drawing it glowing
    // is the fastest way to make an instrument look like a toy.
    g.fillStyle = '#aebfae'; g.fillRect(0, 0, 512, 256);
    g.fillStyle = '#b9c9b6'; g.fillRect(6, 6, 500, 244);
    g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillStyle = '#171d18';
    g.font = 'bold 132px ui-monospace, Menlo, monospace';
    g.fillText(value, unit ? 392 : 468, 138);
    if (unit) {
        g.font = 'bold 62px ui-monospace, Menlo, monospace';
        g.textAlign = 'left';
        g.fillText(unit, 404, 158);
    }
    // the little annunciators every LCD carries in its corner
    g.font = 'bold 30px ui-monospace, Menlo, monospace';
    g.textAlign = 'left'; g.fillStyle = '#4a564a';
    g.fillText('DC', 22, 42);
    if (meterTex) meterTex.needsUpdate = true;
}

// The colour code, worked out from the value actually on the slider.
// Getting this right is worth the twenty lines: a student can read the
// bands off the screen and check them against the number beside it.
const BAND = ['#1a1a1a', '#6b3f1d', '#c0392b', '#d97b28', '#e3c53d',
              '#3f9e4d', '#2a5fa8', '#7d4b9e', '#8d8d8d', '#f2f2f2'];
function bandColours(ohms) {
    if (ohms <= 0) return null;                    // a plain wire has none
    let mult = 0, v = ohms;
    while (v >= 100) { v /= 10; mult++; }
    const d1 = Math.floor(v / 10), d2 = Math.round(v % 10);
    return [BAND[d1], BAND[d2], BAND[Math.min(mult, 9)], '#b8963f'];
}

const VIEWS = {
    bench: { pos: [175, 645, 715], tgt: [-28, 52, -86] },
    top:   { pos: [0, 560, 58],    tgt: [0, 8, 6] },
    rails: { pos: [-70, 150, 272], tgt: [-50, 10, 84] },
    parts: { pos: [30, 215, 300],  tgt: [-14, 22, 26] },
    meter: { pos: [286, 250, -186], tgt: [270, 148, -424] }
};

function init3D() {
    const host = $('view3d');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1f5f9);

    camera = new THREE.PerspectiveCamera(42, 1, 2, 4000);
    camera.position.fromArray(VIEWS.bench.pos);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 80;
    controls.maxDistance = 3000;
    controls.maxPolarAngle = Math.PI / 2 + 0.02;
    controls.autoRotateSpeed = 0.9;
    controls.target.fromArray(VIEWS.bench.tgt);

    scene.add(new THREE.AmbientLight(0xffffff, 0.30));
    const key = new THREE.DirectionalLight(0xffffff, 0.70);
    key.position.set(420, 720, 520);
    key.castShadow = true;
    key.shadow.mapSize.width = key.shadow.mapSize.height = 2048;
    key.shadow.camera.left = -760; key.shadow.camera.right = 760;
    key.shadow.camera.top = 760; key.shadow.camera.bottom = -760;
    key.shadow.camera.far = 2200;
    key.shadow.bias = -0.0009;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4f0, 0.26);
    fill.position.set(-340, 250, -280); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.22);
    rim.position.set(0, 200, -460); scene.add(rim);

    // Tinned legs and a chrome probe tip show you their surroundings and
    // almost nothing else. Without something to reflect they render
    // black, so here is a room in six brush strokes.
    const ec = document.createElement('canvas');
    ec.width = 256; ec.height = 128;
    const eg = ec.getContext('2d');
    const sky = eg.createLinearGradient(0, 0, 0, 128);
    sky.addColorStop(0, '#aab4c0'); sky.addColorStop(0.44, '#8b95a2');
    sky.addColorStop(0.54, '#5a626d'); sky.addColorStop(1, '#343a42');
    eg.fillStyle = sky; eg.fillRect(0, 0, 256, 128);
    eg.fillStyle = '#ffffff';
    eg.fillRect(30, 12, 84, 12); eg.fillRect(148, 12, 84, 12);
    const pm = new THREE.PMREMGenerator(renderer);
    pm.compileEquirectangularShader();
    const et = new THREE.CanvasTexture(ec);
    et.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = pm.fromEquirectangular(et).texture;
    et.dispose(); pm.dispose();

    bench3 = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000),
        new THREE.MeshStandardMaterial({ color: 0xdbe1ea, roughness: 0.92 }));
    bench3.rotation.x = -Math.PI / 2;
    bench3.position.y = -0.5;
    bench3.receiveShadow = true;
    scene.add(bench3);
    grid3 = new THREE.GridHelper(2800, 28, 0x94a3b8, 0xcbd5e1);
    scene.add(grid3);

    // Moulded ABS, tinned copper, and the handful of plastics that a
    // parts drawer is actually made of.
    MAT.board  = new THREE.MeshStandardMaterial({ color: 0xffffff, map: boardTexture(), roughness: 0.58, metalness: 0.02 });
    MAT.body   = new THREE.MeshStandardMaterial({ color: 0xe6e2d6, roughness: 0.62, metalness: 0.02 });
    MAT.chan   = new THREE.MeshStandardMaterial({ color: 0xbdb9ab, roughness: 0.7, metalness: 0.02 });
    // The clips inside. Phosphor bronze, not copper, but nobody has ever
    // called them anything but the copper strips.
    MAT.copper = new THREE.MeshStandardMaterial({ color: 0x9c6a33, metalness: 0.92, roughness: 0.28 });
    MAT.railP  = new THREE.MeshStandardMaterial({ color: 0xa86248, metalness: 0.9, roughness: 0.3 });
    MAT.leg    = new THREE.MeshStandardMaterial({ color: 0xc8ccd3, metalness: 0.92, roughness: 0.22 });
    MAT.legDark = new THREE.MeshStandardMaterial({ color: 0x8f96a1, metalness: 0.85, roughness: 0.3 });
    MAT.resBody = new THREE.MeshStandardMaterial({ color: 0xd8c9a3, roughness: 0.55, metalness: 0.05 });
    MAT.black  = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.55, metalness: 0.18 });
    MAT.grey   = new THREE.MeshStandardMaterial({ color: 0x6c737d, roughness: 0.45, metalness: 0.4 });
    MAT.can    = new THREE.MeshStandardMaterial({ color: 0xb6bcc6, metalness: 0.88, roughness: 0.24 });
    MAT.blue   = new THREE.MeshStandardMaterial({ color: 0x2f6fb8, roughness: 0.42, metalness: 0.1 });
    MAT.yellowP = new THREE.MeshStandardMaterial({ color: 0xe0b229, roughness: 0.42, metalness: 0.08 });
    MAT.screen = new THREE.MeshStandardMaterial({ color: 0xffffff, map: meterTexture(),
        roughness: 0.22, metalness: 0.04 });
    MAT.prop   = new THREE.MeshStandardMaterial({ color: 0xe8843c, roughness: 0.5, metalness: 0.05 });
    MAT.body2  = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.62, metalness: 0.08 });
    MAT.white  = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.5, metalness: 0.02 });
    MAT.brass  = new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.85, roughness: 0.3 });
    // the moulded rubber sleeve a field meter lives in
    MAT.holster = new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.86, metalness: 0.03 });
    MAT.chromeTip = new THREE.MeshStandardMaterial({ color: 0xd6dae1, metalness: 0.97, roughness: 0.09 });
    // the red rubber sleeve and the dark instrument inside it
    MAT.holsterRed = new THREE.MeshStandardMaterial({ color: 0xbe2f24, roughness: 0.82, metalness: 0.02 });
    MAT.meterBody = new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.58, metalness: 0.06 });

    // Wire insulation. Red for the positive side, black for the return,
    // and the rest for jumpers, exactly as a kit comes.
    ['red', 'black', 'yellow', 'green', 'blue2'].forEach((n, i) => {
        MAT[n] = new THREE.MeshStandardMaterial({
            color: [0xc0392b, 0x22252a, 0xe3c53d, 0x3f9e4d, 0x2a5fa8][i],
            roughness: 0.5, metalness: 0.05 });
    });

    MAT.board.envMapIntensity = 0.3;
    MAT.body.envMapIntensity = 0.3;
    MAT.leg.envMapIntensity = 1.8;
    MAT.can.envMapIntensity = 1.6;
    MAT.copper.envMapIntensity = 1.2;
    MAT.chromeTip.envMapIntensity = 2.2;
    MAT.brass.envMapIntensity = 1.4;
    MAT.railP.envMapIntensity = 1.2;

    buildBoard();
    buildParts();
    buildMeter();
    rewire();
}

// A plane carrying its slice of the printed face. The board is two
// blocks with a channel between them, so the face is two planes, and
// each takes the strip of the texture that belongs to it.
function facePlane(z0, z1) {
    const g = new THREE.PlaneGeometry(BOARD.x * 2, z1 - z0);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
        const z = uv.getY(i) > 0.5 ? z0 : z1;      // local +Y points at -Z
        uv.setY(i, (BOARD.z - z) / (BOARD.z * 2));
    }
    const m = new THREE.Mesh(g, MAT.board);
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, TOP + 0.05, (z0 + z1) / 2);
    m.receiveShadow = true;
    return m;
}

function buildBoard() {
    boardGrp = new THREE.Group();
    scene.add(boardGrp);

    // Two blocks with a real groove between them. The groove is not
    // decoration: it is why a chip's two rows of legs land in different
    // strips instead of shorting together.
    [[-BOARD.z, -CHAN], [CHAN, BOARD.z]].forEach(([z0, z1]) => {
        const b = new THREE.Mesh(roundedBox(BOARD.x * 2, BOARD.h, z1 - z0, 3), MAT.body);
        b.position.set(0, BOARD.h / 2, (z0 + z1) / 2);
        b.castShadow = true; b.receiveShadow = true;
        boardGrp.add(b);
        boardGrp.add(facePlane(z0, z1));
    });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(BOARD.x * 2, BOARD.h - 6, CHAN * 2), MAT.chan);
    floor.position.set(0, (BOARD.h - 6) / 2, 0);
    floor.receiveShadow = true;
    boardGrp.add(floor);

    // ---- what is actually inside ------------------------------
    // Sixty strips of five in the middle and four long ones down the
    // edges: 400 holes, 64 connections. Every circuit that will not
    // work is a misunderstanding about which is which, so they are
    // modelled at their true depth and the Links chip x-rays the
    // plastic away to show them.
    stripGrp = new THREE.Group();
    stripGrp.visible = state.links;
    scene.add(stripGrp);

    function strip(x, z, w, d, mat) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, mm(0.45), d), mat);
        m.position.set(x, mm(2.1), z);
        stripGrp.add(m);
        return m;
    }
    for (let c = 0; c < COLS; c++) {
        // A strip spans its five holes and stops. It does not reach the
        // channel and it does not reach its neighbour.
        strip(colX(c), (ROW_Z.A + ROW_Z.E) / 2, 5.6, 47, MAT.copper);
        strip(colX(c), (ROW_Z.F + ROW_Z.J) / 2, 5.6, 47, MAT.copper);
    }
    Object.keys(RAIL).forEach(k => {
        strip(0, RAIL[k].z, 292, 5.6, RAIL[k].plus ? MAT.railP : MAT.copper);
    });
}

// =============================================================
//  The parts
// =============================================================
// Which columns everything sits in. Written down once, here, so the
// wiring and the model can never disagree about what is joined to
// what — and so that laying the board out differently later is a
// change to this table rather than a change to the code.
// A slide switch has three pins on 2.54 centres and the middle one is
// the common, so it occupies three columns and not two. Everything else
// follows from that, and the whole circuit sits across the middle of
// the board rather than crowding into one end of it.
const COL = {
    swA: 10, swB: 11, swC: 12,        // the switch's three pins
    in: 11,                            // + arrives on the common pin
    out: 12,                           // and leaves on the switched one
    potA: 16, potB: 17,                // the pot's first two pins; the
    a: 18,                             //   third one IS the load node
    b: 19, d: 20, buz: 21
};

// Where the current comes back to. The return jumper moves with the
// circuit, because the last part in the loop is not always the same one.
function outCol() {
    if (state.circuit === 'buzzer') return COL.buz;
    if (inSeries()) return COL.d;
    return COL.b;
}

// A tinned leg: down the side of the part and into its hole.
// Everything from here on is dimensioned in real millimetres and
// converted, rather than in units picked by eye. A student is meant to
// look at this bench and recognise the parts drawer it came out of, and
// that only works if a AA cell is bigger than a resistor, a meter is
// longer than the board, and a 5 mm LED is actually 5 mm.
const MM = 1 / 0.254;                 // units per millimetre; the pitch is 2.54
const mm = v => v * MM;

// A tinned leg: down the side of the part and into its hole.
function leg(parent, x, z, top, mat) {
    const h = top - (TOP - 13);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(mm(0.28), mm(0.28), h, 8), mat || MAT.leg);
    m.position.set(x, (top + TOP - 13) / 2, z);
    m.castShadow = true;
    parent.add(m);
    return m;
}

// A jumper wire. Solid core, the kind that comes pre-formed in a box of
// assorted lengths: it goes straight down into its hole, turns a square
// corner, and lies where you put it. That vertical entry is the whole
// difference between wiring that looks placed and wiring that looks
// spilled — and it is also how you can see which hole a wire is in.
function jumper(a, b, mat, lift) {
    const drop = mm(3.2);
    const rise = lift === undefined ? mm(1.6) + Math.min(mm(5), a.distanceTo(b) * 0.035) : lift;
    const a1 = a.clone(); a1.y += drop;
    const b1 = b.clone(); b1.y += drop;
    const a2 = a1.clone(); a2.y += rise; a2.lerp(b1, 0.14);
    const b2 = b1.clone(); b2.y += rise; b2.lerp(a1, 0.14);
    const curve = new THREE.CatmullRomCurve3([a, a1, a2, b2, b1, b]);
    curve.curveType = 'catmullrom';
    curve.tension = 0.22;
    const g = new THREE.Group();
    const wire = new THREE.Mesh(new THREE.TubeGeometry(curve, 54, mm(0.62), 8, false), mat);
    wire.castShadow = true;
    g.add(wire);
    // The bare tinned tail, stripped back and pushed into the hole. Only
    // an end that lands on the board gets one — a lead going to a
    // battery or a meter ends in a plug, not in a hole.
    [a, b].forEach(p => {
        if (Math.abs(p.y - TOP) > 1) return;
        const t = new THREE.Mesh(new THREE.CylinderGeometry(mm(0.32), mm(0.32), 15, 7), MAT.leg);
        t.position.set(p.x, TOP - 5.5, p.z);
        g.add(t);
    });
    return { mesh: g, curve: curve };
}

// ---- a 5 mm LED ----------------------------------------------
// 5.0 dia, 8.6 tall, legs on 2.54 centres, and a flat moulded on the
// cathode side of the flange. The flat is the only marking it has.
function makeLED() {
    const g = new THREE.Group();
    const R = mm(2.5);
    const tint = new THREE.MeshStandardMaterial({
        color: 0xcf3a26, roughness: 0.14, metalness: 0,
        transparent: true, opacity: 0.76,
        emissive: 0xff3a12, emissiveIntensity: 0 });
    tint.envMapIntensity = 1.5;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(R, R, mm(5.2), 24), tint);
    barrel.position.y = TOP + mm(3.6);
    barrel.castShadow = true;
    g.add(barrel);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), tint);
    dome.position.y = TOP + mm(6.2);
    g.add(dome);
    // the flange, with the flat filed on one side
    const fl = new THREE.Mesh(new THREE.CylinderGeometry(mm(2.95), mm(2.95), mm(1.0), 24), tint);
    fl.position.y = TOP + mm(0.5);
    g.add(fl);
    const flat = new THREE.Mesh(new THREE.BoxGeometry(mm(3.4), mm(1.1), mm(0.7)), tint);
    flat.position.set(0, TOP + mm(0.5), mm(2.7));
    g.add(flat);
    // The die sits on a reflector cup on the anode post, with the
    // cathode post bent over above it — visible through the epoxy, and
    // the real way to tell an LED's polarity when the legs are cut.
    const post = new THREE.Mesh(new THREE.BoxGeometry(mm(0.5), mm(3.4), mm(0.5)), MAT.legDark);
    post.position.set(mm(1.27), TOP + mm(2.2), 0);
    g.add(post);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(mm(0.95), mm(0.6), mm(1.0), 12), MAT.legDark);
    cup.position.set(-mm(1.27), TOP + mm(3.6), 0);
    g.add(cup);
    const core = new THREE.Mesh(new THREE.BoxGeometry(mm(0.62), mm(0.35), mm(0.62)),
        new THREE.MeshStandardMaterial({ color: 0x4a1207, emissive: 0xff3c14, emissiveIntensity: 0 }));
    core.position.set(-mm(1.27), TOP + mm(4.2), 0);
    g.add(core);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        color: 0xff5a2a, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending }));
    glow.scale.set(mm(16), mm(16), 1);
    glow.position.y = TOP + mm(5);
    g.add(glow);
    const light = new THREE.PointLight(0xff5527, 0, mm(48), 2);
    light.position.y = TOP + mm(6);
    g.add(light);
    leg(g, -mm(1.27), 0, TOP + mm(0.5));      // anode, the long one
    leg(g, mm(1.27), 0, TOP + mm(0.5));
    g.userData = { core: core, glow: glow, light: light, tint: tint };
    return g;
}

// ---- a quarter-watt resistor ---------------------------------
function makeResistor() {
    const g = new THREE.Group();
    const span = colX(COL.a) - colX(COL.out);
    const L = mm(6.3), R = mm(1.15), y = TOP + mm(3.2);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, L, 20), MAT.resBody);
    body.rotation.z = Math.PI / 2;
    body.position.y = y;
    body.castShadow = true;
    g.add(body);
    [-1, 1].forEach(s => {
        const cap = new THREE.Mesh(new THREE.SphereGeometry(R, 16, 10), MAT.resBody);
        cap.position.set(s * L / 2, y, 0);
        cap.scale.x = 0.6;
        g.add(cap);
    });
    resBands = [];
    [-2.0, -1.0, 0, 2.1].forEach((x, i) => {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.04, R * 1.04, mm(i === 3 ? 0.55 : 0.62), 20),
            new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5 }));
        b.rotation.z = Math.PI / 2;
        b.position.set(mm(x), y, 0);
        g.add(b); resBands.push(b);
    });
    // leads out to each end, then square down into the board
    [-1, 1].forEach(s => {
        const run = span / 2 - L / 2;
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(mm(0.28), mm(0.28), run, 8), MAT.leg);
        arm.rotation.z = Math.PI / 2;
        arm.position.set(s * (L / 2 + run / 2), y, 0);
        g.add(arm);
        leg(g, s * span / 2, 0, y);
    });
    return g;
}

// ---- an SPDT slide switch ------------------------------------
function makeSwitch() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(roundedBox(mm(12.8), mm(4.0), mm(6.6), mm(0.5)), MAT.body2);
    body.position.set(0, TOP + mm(2.6), 0);
    body.castShadow = true;
    g.add(body);
    // the pressed-steel cover with the slot in it
    [-1, 1].forEach(s => {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(mm(12.8), mm(0.5), mm(1.9)), MAT.can);
        rail.position.set(0, TOP + mm(4.7), s * mm(2.3));
        g.add(rail);
    });
    switchLever = new THREE.Mesh(roundedBox(mm(2.6), mm(3.2), mm(2.4), mm(0.4)), MAT.black);
    switchLever.position.set(-mm(2.2), TOP + mm(6.0), 0);
    switchLever.castShadow = true;
    g.add(switchLever);
    // three pins, though only the two ends are used here
    [-1, 0, 1].forEach(i => leg(g, i * PITCH, 0, TOP + mm(0.6), MAT.legDark));
    return g;
}

// ---- a 9 mm panel pot with a knob ----------------------------
function makePot() {
    const g = new THREE.Group();
    const can = new THREE.Mesh(new THREE.CylinderGeometry(mm(4.8), mm(4.8), mm(5.0), 22), MAT.can);
    can.position.y = TOP + mm(2.5);
    can.castShadow = true;
    g.add(can);
    const base = new THREE.Mesh(roundedBox(mm(9.8), mm(1.4), mm(9.8), mm(0.6)), MAT.body2);
    base.position.y = TOP + mm(0.7);
    g.add(base);
    const bush = new THREE.Mesh(new THREE.CylinderGeometry(mm(3.4), mm(3.4), mm(2.2), 18), MAT.can);
    bush.position.y = TOP + mm(6.1);
    g.add(bush);
    potKnob = new THREE.Group();
    const k = new THREE.Mesh(new THREE.CylinderGeometry(mm(6.2), mm(5.4), mm(7.5), 26), MAT.black);
    k.position.y = mm(3.75);
    potKnob.add(k);
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(mm(6.4), mm(6.4), mm(1.1), 26), MAT.grey);
    skirt.position.y = mm(0.6);
    potKnob.add(skirt);
    // the pointer, so the knob's position is readable at a glance
    const nick = new THREE.Mesh(new THREE.BoxGeometry(mm(0.9), mm(7.6), mm(6.4)), MAT.white);
    nick.position.set(0, mm(3.8), mm(3.2));
    potKnob.add(nick);
    potKnob.position.set(0, TOP + mm(7.2), 0);
    g.add(potKnob);
    [-1, 0, 1].forEach(i => leg(g, i * PITCH, 0, TOP + mm(0.6), MAT.legDark));
    return g;
}

// ---- a 130-size can motor ------------------------------------
function makeMotor() {
    const g = new THREE.Group();
    const L = mm(25), R = mm(10.2), y = R + mm(1);
    const can = new THREE.Mesh(new THREE.CylinderGeometry(R, R, L, 30), MAT.can);
    can.rotation.z = Math.PI / 2;
    can.position.y = y;
    can.castShadow = true;
    g.add(can);
    // the flats pressed into the sides of a 130 can
    [-1, 1].forEach(s => {
        const f = new THREE.Mesh(new THREE.BoxGeometry(L, mm(15), mm(0.8)), MAT.can);
        f.position.set(0, y, s * mm(9.4));
        g.add(f);
    });
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(R, R, mm(3), 30), MAT.body2);
    bell.rotation.z = Math.PI / 2;
    bell.position.set(-L / 2 - mm(1.5), y, 0);
    g.add(bell);
    const front = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.96, mm(1.6), 30), MAT.can);
    front.rotation.z = Math.PI / 2;
    front.position.set(L / 2 + mm(0.8), y, 0);
    g.add(front);
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(mm(3.1), mm(3.1), mm(2.4), 18), MAT.can);
    boss.rotation.z = Math.PI / 2;
    boss.position.set(L / 2 + mm(2.4), y, 0);
    g.add(boss);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(mm(1), mm(1), mm(10), 12), MAT.leg);
    shaft.rotation.z = Math.PI / 2;
    shaft.position.set(L / 2 + mm(8), y, 0);
    g.add(shaft);
    // the two brass terminal tabs on the end bell
    [-1, 1].forEach(s => {
        const tab = new THREE.Mesh(new THREE.BoxGeometry(mm(1), mm(4.4), mm(2.6)), MAT.brass);
        tab.position.set(-L / 2 - mm(2.6), y + s * mm(4.6), 0);
        g.add(tab);
    });
    // a propeller, because a bare shaft turning looks completely still
    propGrp = new THREE.Group();
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(mm(2.6), mm(2.6), mm(4), 14), MAT.black);
    hub.rotation.z = Math.PI / 2;
    propGrp.add(hub);
    [0, 1].forEach(i => {
        const bl = new THREE.Mesh(roundedBox(mm(1.2), mm(26), mm(6), mm(1)), MAT.prop);
        bl.rotation.x = i ? 0.36 : -0.36;
        bl.position.set(0, (i ? 1 : -1) * mm(13), 0);
        propGrp.add(bl);
    });
    propGrp.position.set(L / 2 + mm(11), y, 0);
    g.add(propGrp);
    g.userData = { lead: mm(-14.5), leadY: y, leadZ: mm(4.6) };
    return g;
}

// ---- a 12 mm piezo buzzer ------------------------------------
function makeBuzzer() {
    const g = new THREE.Group();
    const R = mm(6), H = mm(9.5);
    const can = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 28), MAT.black);
    can.position.y = TOP + H / 2;
    can.castShadow = true;
    g.add(can);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(R, R, mm(0.5), 28), MAT.body2);
    lid.position.y = TOP + H;
    g.add(lid);
    const port = new THREE.Mesh(new THREE.CylinderGeometry(mm(1.1), mm(1.1), mm(1), 14), MAT.black);
    port.position.y = TOP + H + mm(0.2);
    g.add(port);
    // the polarity sticker, which is the only thing on a buzzer's case
    const dot = new THREE.Mesh(new THREE.PlaneGeometry(mm(3), mm(3)), MAT.white);
    dot.rotation.x = -Math.PI / 2;
    dot.position.set(mm(2.6), TOP + H + mm(0.4), mm(1.4));
    g.add(dot);
    const span = colX(COL.buz) - colX(COL.a);
    [-1, 1].forEach(s => leg(g, s * span / 2, 0, TOP + mm(0.6), MAT.legDark));
    return g;
}

// ---- four AA cells in a holder -------------------------------
// The pack is drawn as the pack it would be: one 50.5 x 14.5 cell per
// 1.5 V, in a moulded holder with springs at one end. Sliding the
// supply up does not make an abstract number bigger, it puts another
// cell in — which is where the volts were coming from all along.
let battGrp = null, battCells = null;
const battPlus = new THREE.Vector3(), battMinus = new THREE.Vector3();
function rebuildBattery() {
    if (!battCells) return;
    while (battCells.children.length) {
        const c = battCells.children.pop();
        if (c.geometry) c.geometry.dispose();
        battCells.remove(c);
    }
    const n = Math.max(1, Math.round(emf() / 1.5));
    const CL = mm(50.5), CR = mm(7.25), pitchZ = mm(15.4);
    const W = CL + mm(8), D = n * pitchZ + mm(3), wall = mm(1.4), y0 = mm(1.0);
    const FLOOR = mm(2.6), WALL_H = mm(13);

    // A holder is a tray: a thin floor, walls up past the middle of the
    // cells, and dividers between them. The cells sit DOWN in it — which
    // is the difference between a battery box and four tubes balanced
    // on a slab.
    const floor = new THREE.Mesh(roundedBox(W, FLOOR, D, mm(1.2)), MAT.body2);
    floor.position.set(0, y0 + FLOOR / 2, 0);
    floor.castShadow = true; floor.receiveShadow = true;
    battCells.add(floor);
    [-1, 1].forEach(sgn => {
        const side = new THREE.Mesh(roundedBox(wall * 2, WALL_H, D, mm(0.6)), MAT.body2);
        side.position.set(sgn * (W / 2 - wall), y0 + WALL_H / 2, 0);
        side.castShadow = true;
        battCells.add(side);
        const end = new THREE.Mesh(roundedBox(W, WALL_H, wall * 2, mm(0.6)), MAT.body2);
        end.position.set(0, y0 + WALL_H / 2, sgn * (D / 2 - wall));
        end.castShadow = true;
        battCells.add(end);
    });
    for (let i = 1; i < n; i++) {
        const dv = new THREE.Mesh(new THREE.BoxGeometry(W - wall * 4, mm(9), mm(1.2)), MAT.body2);
        dv.position.set(0, y0 + mm(4.5), (i - n / 2) * pitchZ);
        battCells.add(dv);
    }

    for (let i = 0; i < n; i++) {
        const z = (i - (n - 1) / 2) * pitchZ;
        const cy = y0 + FLOOR + CR;
        const wrap = new THREE.Mesh(new THREE.CylinderGeometry(CR, CR, CL * 0.86, 22),
            new THREE.MeshStandardMaterial({ color: 0x22456e, roughness: 0.42, metalness: 0.12 }));
        wrap.rotation.z = Math.PI / 2;
        wrap.position.set(0, cy, z);
        wrap.castShadow = true;
        battCells.add(wrap);
        // a band round the middle, so the cells are not featureless tubes
        const band = new THREE.Mesh(new THREE.CylinderGeometry(CR * 1.01, CR * 1.01, CL * 0.2, 22),
            new THREE.MeshStandardMaterial({ color: 0xd8a12a, roughness: 0.4 }));
        band.rotation.z = Math.PI / 2;
        band.position.set(-CL * 0.16, cy, z);
        battCells.add(band);
        [-1, 1].forEach(s => {
            const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(CR * 0.97, CR * 0.97, CL * 0.07, 22), MAT.can);
            shoulder.rotation.z = Math.PI / 2;
            shoulder.position.set(s * CL * 0.465, cy, z);
            battCells.add(shoulder);
        });
        // the positive nub at one end, flat at the other
        const nub = new THREE.Mesh(new THREE.CylinderGeometry(mm(2.5), mm(2.5), mm(1.4), 14), MAT.can);
        nub.rotation.z = Math.PI / 2;
        nub.position.set(CL / 2 + mm(0.7), cy, z);
        battCells.add(nub);
        // and the spring pressing on it from the other end
        const spr = new THREE.Mesh(new THREE.CylinderGeometry(mm(3.4), mm(4.4), mm(4), 12, 1, true), MAT.leg);
        spr.rotation.z = Math.PI / 2;
        spr.position.set(-CL / 2 - mm(2.4), cy, z);
        battCells.add(spr);
    }
    // The leads come out of the near end and travel with the holder.
    const zEnd = D / 2 + mm(3);
    battPlus.set(-mm(10), y0 + mm(7), zEnd);
    battMinus.set(mm(10), y0 + mm(7), zEnd);
    [[-mm(10), MAT.red], [mm(10), MAT.black]].forEach(([x, m]) => {
        const gr = new THREE.Mesh(new THREE.CylinderGeometry(mm(1.5), mm(1.5), mm(6), 10), m);
        gr.rotation.x = Math.PI / 2;
        gr.position.set(x, y0 + mm(7), D / 2 + mm(1));
        battCells.add(gr);
    });
}

function makeBattery() {
    const g = new THREE.Group();
    battCells = new THREE.Group();
    g.add(battCells);
    rebuildBattery();
    return g;
}

// ---- the meter, on a stand behind the bench ------------------
// Scale is a judgement, not just a measurement. A full-size hand-held
// meter is 150 mm tall — nearly twice this board — and modelled at that
// size it stops being an instrument beside the experiment and becomes
// the thing the picture is about. So this is the pocket meter a school
// buys by the dozen, about 118 mm, stood up on its own fold-out back
// stand. Everything ON the board stays at true scale, because those
// sizes are relative to the 2.54 mm pitch and faking any of them would
// make the board itself a lie.
const METER_SCALE = 0.82;
const MET = { w: mm(64), t: mm(26), h: mm(118) };
const PROBE_SCALE = 0.52;

// The printed face, drawn once. Every range label, socket marking and
// warning on a real meter is silkscreen, so painting them is not a
// shortcut — it is how the actual object is made, and it is the only
// way to get that much fine lettering without a thousand meshes.
let faceTex = null;
function meterFaceTexture() {
    if (faceTex) return faceTex;
    const W = 620, H = 1140;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#17181c'; g.fillRect(0, 0, W, H);
    // the LCD's recess, which the live display sits inside
    g.fillStyle = '#0c0d10';
    g.fillRect(W * 0.09, 52, W * 0.82, 250);
    // brand plate and model number, the way every one of these has
    g.fillStyle = '#e8ecf2';
    g.font = 'bold 30px system-ui, sans-serif';
    g.textAlign = 'left'; g.fillText('TCE-LAB', 40, 34);
    g.textAlign = 'right'; g.fillText('DM-830', W - 40, 34);

    // the range labels, in a ring round where the knob will sit
    const cx = W / 2, cy = 640, R = 218;
    const marks = [
        ['OFF', -90, '#ff5a4d'],
        ['200', -58, '#e8ecf2'], ['2k', -36, '#e8ecf2'], ['20k', -14, '#e8ecf2'],
        ['200k', 8, '#e8ecf2'], ['2M', 30, '#e8ecf2'],
        ['200m', 62, '#f5c542'], ['2', 84, '#f5c542'], ['20', 106, '#f5c542'],
        ['200', 128, '#f5c542'], ['600', 150, '#f5c542'],
        ['10A', 176, '#5ad1a0'], ['200m', 198, '#5ad1a0'], ['20m', 220, '#5ad1a0'],
        ['2m', 242, '#5ad1a0'], ['200u', 264, '#5ad1a0'],
        ['hFE', 286, '#8fb8ff'], ['2000k', 308, '#e8ecf2'], ['20M', 330, '#e8ecf2']
    ];
    marks.forEach(([txt, deg, col]) => {
        const a = (deg - 90) * Math.PI / 180;
        g.save();
        g.translate(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        g.rotate(a + Math.PI / 2);
        g.fillStyle = col;
        g.font = 'bold 26px ui-monospace, Menlo, monospace';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(txt, 0, 0);
        g.restore();
        // the tick each label belongs to
        g.save();
        g.translate(cx, cy); g.rotate(a + Math.PI / 2);
        g.fillStyle = col;
        g.fillRect(-2.5, -(R - 34), 5, 20);
        g.restore();
    });
    // the group headings a meter prints inside the ring
    [['Ω', -25, 0, '#e8ecf2'], ['V', 118, 0, '#f5c542'], ['A', 218, 0, '#5ad1a0']].forEach(([t, deg]) => {
        const a = (deg - 90) * Math.PI / 180;
        g.fillStyle = ['#e8ecf2', '#f5c542', '#5ad1a0'][['Ω', 'V', 'A'].indexOf(t)];
        g.font = 'bold 40px system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(t, cx + Math.cos(a) * (R - 92), cy + Math.sin(a) * (R - 92));
    });

    // socket labels along the bottom
    const sy = 1010;
    g.font = 'bold 24px ui-monospace, Menlo, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    [['10A', 0.2, '#5ad1a0'], ['mA', 0.4, '#5ad1a0'],
     ['COM', 0.62, '#e8ecf2'], ['VΩ', 0.84, '#ff6b5e']].forEach(([t, fx, c]) => {
        g.fillStyle = c;
        g.fillText(t, W * fx, sy - 74);
    });
    g.fillStyle = '#9aa3ad';
    g.font = 'bold 20px system-ui, sans-serif';
    g.fillText('CAT III  600V', W / 2, H - 26);

    faceTex = new THREE.CanvasTexture(cv);
    faceTex.anisotropy = 8;
    return faceTex;
}

function buildMeter() {
    meterGrp = new THREE.Group();
    meterGrp.position.set(mm(70), 0, -mm(116));
    meterGrp.scale.setScalar(METER_SCALE);
    meterGrp.rotation.y = -0.22;
    scene.add(meterGrp);

    const W = MET.w, T = MET.t, H = MET.h;
    // The whole instrument leans on its stand. Everything below is built
    // flat and then tipped up as one piece, which is also how the back
    // stand can be a flap hinged along the bottom edge.
    const face = new THREE.Group();
    face.position.set(0, mm(40), 0);
    face.rotation.x = 1.06;
    meterGrp.add(face);
    meterFace = face;

    // the red rubber holster the instrument drops into
    const holster = new THREE.Mesh(roundedBox(W + mm(9), T + mm(4), H + mm(7), mm(6)), MAT.holsterRed);
    holster.castShadow = true;
    face.add(holster);
    const body = new THREE.Mesh(roundedBox(W, T + mm(6), H - mm(4), mm(3)), MAT.meterBody);
    face.add(body);
    // the silkscreened face
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(W, H - mm(4)),
        new THREE.MeshStandardMaterial({ map: meterFaceTexture(), roughness: 0.6, metalness: 0.05 }));
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = T / 2 + mm(3.1);
    face.add(plate);

    // the display: a grey-green LCD sunk behind a bezel
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.78, mm(24)), MAT.screen);
    scr.rotation.x = -Math.PI / 2;
    scr.position.set(0, T / 2 + mm(3.4), -H * 0.31);
    face.add(scr);

    // the range knob
    meterKnob = new THREE.Group();
    meterKnob.position.set(0, T / 2 + mm(6), H * 0.055);
    face.add(meterKnob);
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(mm(15), mm(16.5), mm(7), 32), MAT.black);
    knob.castShadow = true;
    meterKnob.add(knob);
    const ptr = new THREE.Mesh(roundedBox(mm(5), mm(3), mm(26), mm(1)), MAT.white);
    ptr.position.set(0, mm(3.4), -mm(8));
    meterKnob.add(ptr);

    // four sockets along the bottom, the two live ones ringed in colour
    meterSock = [];
    [[-0.30, MAT.grey], [-0.10, MAT.grey], [0.12, MAT.black], [0.34, MAT.red]].forEach(([fx, m], i) => {
        const x = fx * W;
        const z = H * 0.36;
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(mm(5.4), mm(5.4), mm(3.6), 20), m);
        rim.position.set(x, T / 2 + mm(4), z);
        face.add(rim);
        const bore = new THREE.Mesh(new THREE.CylinderGeometry(mm(2.4), mm(2.4), mm(4.4), 14), MAT.black);
        bore.position.set(x, T / 2 + mm(5), z);
        face.add(bore);
        meterSock.push(new THREE.Vector3(x, T / 2 + mm(7), z));
    });
    // index 1 is mA, 2 is COM, 3 is VΩ — the three a student ever uses
    meterSock = [meterSock[1], meterSock[2], meterSock[3]];

    // ---- the back stand --------------------------------------
    // A moulded flap hinged along the bottom edge, swung out until its
    // foot reaches the bench. It is what actually holds one of these up.
    const stand = new THREE.Group();
    stand.position.set(0, mm(6), H * 0.30);
    stand.rotation.x = -0.62;
    meterGrp.add(stand);
    const flap = new THREE.Mesh(roundedBox(W * 0.52, mm(3.4), mm(62), mm(3)), MAT.black);
    flap.position.set(0, 0, mm(28));
    flap.castShadow = true;
    stand.add(flap);
    // the cut-out that makes it a frame rather than a paddle
    const slot = new THREE.Mesh(roundedBox(W * 0.30, mm(5), mm(34), mm(2)), MAT.holsterRed);
    slot.position.set(0, 0, mm(28));
    stand.add(slot);
}

// ---- test probes ---------------------------------------------
// Slim, pointed, and on thin flexible leads — the shape in every
// textbook photograph. A probe that reads as a probe is worth the
// trouble: it is how a student knows the meter is touching the circuit
// rather than being part of it.
function makeProbe(mat) {
    const g = new THREE.Group();
    const needle = new THREE.Mesh(new THREE.CylinderGeometry(mm(0.25), mm(0.9), mm(42), 12), MAT.chromeTip);
    needle.position.y = mm(21);
    g.add(needle);
    const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(mm(2.6), mm(1.6), mm(11), 16), MAT.black);
    ferrule.position.y = mm(46);
    g.add(ferrule);
    // the finger guard: the flange that keeps a hand off the needle
    const guard = new THREE.Mesh(new THREE.CylinderGeometry(mm(7.4), mm(7.4), mm(3), 22), mat);
    guard.position.y = mm(53);
    g.add(guard);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(mm(5.2), mm(6.2), mm(86), 20), mat);
    grip.position.y = mm(97);
    grip.castShadow = true;
    g.add(grip);
    for (let i = 0; i < 4; i++) {
        const r = new THREE.Mesh(new THREE.TorusGeometry(mm(5.9), mm(0.55), 6, 18), MAT.black);
        r.rotation.x = Math.PI / 2;
        r.position.y = mm(70 + i * 7);
        g.add(r);
    }
    const boot = new THREE.Mesh(new THREE.CylinderGeometry(mm(3.4), mm(5.2), mm(14), 18), MAT.black);
    boot.position.y = mm(146);
    g.add(boot);
    g.userData = { tail: mm(152) };
    return g;
}

function textSprite(text) {
    const cv = document.createElement('canvas');
    const g = cv.getContext('2d');
    g.font = 'bold 44px system-ui, -apple-system, Segoe UI, sans-serif';
    const w = Math.ceil(g.measureText(text).width) + 34;
    cv.width = w; cv.height = 72;
    const g2 = cv.getContext('2d');
    g2.fillStyle = 'rgba(15,23,42,0.86)';
    if (g2.roundRect) { g2.beginPath(); g2.roundRect(0, 0, w, 72, 16); g2.fill(); }
    else g2.fillRect(0, 0, w, 72);
    g2.font = 'bold 44px system-ui, -apple-system, Segoe UI, sans-serif';
    g2.fillStyle = '#ffffff';
    g2.textAlign = 'center'; g2.textBaseline = 'middle';
    g2.fillText(text, w / 2, 39);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
    sp.scale.set(w * 0.5, 36, 1);
    return sp;
}

function buildParts() {
    partsGrp = new THREE.Group(); scene.add(partsGrp);
    wireGrp = new THREE.Group(); scene.add(wireGrp);
    beadGrp = new THREE.Group(); scene.add(beadGrp);
    labelGrp = new THREE.Group(); labelGrp.visible = false; scene.add(labelGrp);

    battGrp = makeBattery();
    battGrp.position.set(-mm(96), 0, -mm(4));
    partsGrp.add(battGrp);

    switchGrp = makeSwitch();
    switchGrp.position.set(colX(COL.swB), 0, ROW_Z.H);
    partsGrp.add(switchGrp);

    resGrp = makeResistor();
    resGrp.position.set((colX(COL.out) + colX(COL.a)) / 2, 0, ROW_Z.F);
    partsGrp.add(resGrp);

    potGrp = makePot();
    potGrp.position.set(colX(COL.potB), 0, ROW_Z.I);
    partsGrp.add(potGrp);

    ledGrp[0] = makeLED();
    ledGrp[0].position.set((colX(COL.a) + colX(COL.b)) / 2, 0, ROW_Z.H);
    partsGrp.add(ledGrp[0]);
    ledGrp[1] = makeLED();
    partsGrp.add(ledGrp[1]);

    motorGrp = makeMotor();
    motorGrp.position.set(mm(80), 0, -mm(14));
    motorGrp.rotation.y = -2.6;
    partsGrp.add(motorGrp);

    buzzGrp = makeBuzzer();
    buzzGrp.position.set((colX(COL.a) + colX(COL.buz)) / 2, 0, ROW_Z.J);
    partsGrp.add(buzzGrp);

    // Held probes are 150 mm long — twice the board — so at true size
    // they stand over the experiment like scaffolding and hide the very
    // thing they are pointing at. Scaled to match the meter and laid
    // back towards it, they read as a hand reaching in, which is what
    // they are for.
    probeRed = makeProbe(MAT.red); probeBlk = makeProbe(MAT.black);
    probeRed.scale.setScalar(PROBE_SCALE); probeBlk.scale.setScalar(PROBE_SCALE);
    scene.add(probeRed); scene.add(probeBlk);

    [['Battery', -mm(96), mm(34), -mm(4)],
     ['Switch', colX(COL.swB), mm(16), ROW_Z.H],
     ['Resistor', (colX(COL.out) + colX(COL.a)) / 2, mm(14), ROW_Z.F - 8],
     ['LED', (colX(COL.a) + colX(COL.b)) / 2, mm(19), ROW_Z.H],
     ['+ rail', -mm(30), mm(7), RAIL.bp.z], ['− rail', -mm(30), mm(7), RAIL.bn.z],
     ['Meter', mm(70), mm(52), -mm(116)]].forEach(([t, x, y, z]) => {
        const s = textSprite(t);
        s.position.set(x, y, z);
        labelGrp.add(s);
    });
}


// =============================================================
//  Wiring the board up
// =============================================================
// Everything the current has to pass through, in the order it passes
// through it. The same list does three jobs: it is the jumpers you can
// see, it is the path the flow beads run along, and it is the proof
// that the circuit on the board is the circuit in the model.
let flowCurve = null;
const holeV = (c, r) => new THREE.Vector3(colX(c), TOP, ROW_Z[r]);
const railV = (k, i) => new THREE.Vector3(railX(i), TOP, RAIL[k].z);
const localV = (o, x, y, z) => {
    o.updateMatrixWorld(true);
    return o.localToWorld(new THREE.Vector3(x, y, z));
};

function clearGroup(g) {
    while (g.children.length) {
        const c = g.children.pop();
        if (c.geometry) c.geometry.dispose();
        g.remove(c);
    }
}

function paintBands() {
    const cols = bandColours(resOhms());
    resBands.forEach((b, i) => {
        b.visible = !!cols;
        if (cols) b.material.color.set(cols[i]);
    });
}

function rewire() {
    if (!gl) return;
    clearGroup(wireGrp);
    const pts = [];
    const hop = p => pts.push(p.clone());
    const addJ = (a, b, mat, lift) => {
        const j = jumper(a, b, mat, lift);
        wireGrp.add(j.mesh);
        for (let i = 0; i <= 18; i++) pts.push(j.curve.getPoint(i / 18));
    };

    // ---- out of the battery and along the + rail ---------------
    addJ(battPlus, railV('bp', 1), MAT.red);
    hop(railV('bp', 7));
    addJ(railV('bp', 7), holeV(COL.in, 'J'), MAT.red);

    // Down the strip and through the switch. Nothing is drawn for these
    // two hops because nothing is there to draw: it is the board's own
    // metal doing the joining, which is the point.
    hop(holeV(COL.in, 'H'));
    hop(holeV(COL.out, 'H'));

    // ---- the limiter ------------------------------------------
    const fixed = state.limiter === 'fixed';
    const link = fixed && resOhms() === 0;      // nought ohms is a wire, and looks like one
    resGrp.visible = fixed && !link;
    potGrp.visible = !fixed;
    paintBands();
    if (fixed) {
        if (link) addJ(holeV(COL.out, 'F'), holeV(COL.a, 'F'), MAT.green);
        else { hop(holeV(COL.out, 'F')); hop(holeV(COL.a, 'F')); }
    } else {
        // the pot's third pin sits in the load's own column, so only the
        // way in needs a jumper
        addJ(holeV(COL.out, 'G'), holeV(COL.potA, 'G'), MAT.yellow);
        hop(holeV(COL.potA, 'I'));
        hop(holeV(COL.a, 'I'));
    }

    // ---- the load ---------------------------------------------
    const two = twoLED();
    const lamps = state.circuit === 'led' || two;
    ledGrp[0].visible = lamps;
    ledGrp[1].visible = two;
    motorGrp.visible = state.circuit === 'motor';
    buzzGrp.visible = state.circuit === 'buzzer';
    ledGrp.forEach(g => { g.rotation.y = state.flipped ? Math.PI : 0; });

    if (lamps) {
        hop(holeV(COL.a, 'H'));
        hop(holeV(COL.b, 'H'));
        if (inSeries()) {
            // one after the other: the second starts where the first ended
            ledGrp[1].position.set((colX(COL.b) + colX(COL.d)) / 2, 0, ROW_Z.F);
            hop(holeV(COL.b, 'F'));
            hop(holeV(COL.d, 'F'));
        } else if (inParallel()) {
            // both legs in the same two strips as the first one, four
            // rows down. Same two nodes, so the same voltage across it.
            ledGrp[1].position.set((colX(COL.a) + colX(COL.b)) / 2, 0, ROW_Z.J);
        }
    } else if (state.circuit === 'motor') {
        hop(holeV(COL.a, 'I'));
        addJ(holeV(COL.a, 'I'), localV(motorGrp, -24, 17, 7), MAT.red);
        hop(localV(motorGrp, 0, 17, 0));
        addJ(localV(motorGrp, -24, 17, -7), holeV(COL.b, 'I'), MAT.black);
    } else {
        hop(holeV(COL.a, 'J'));
        hop(holeV(COL.buz, 'J'));
    }

    // ---- the way home -----------------------------------------
    // With the meter set to read current it goes IN the loop, so the
    // return jumper comes out and the meter takes its place. That
    // swap is the lesson: an ammeter is part of the circuit, a
    // voltmeter never is.
    const amps = state.probe === 'amps';
    const back = holeV(outCol(), 'G');
    const railEnd = railV('bn', 13);
    if (!amps) addJ(back, railEnd, MAT.black);
    hop(railV('bn', 1));
    addJ(railV('bn', 1), battMinus, MAT.black);

    flowCurve = pts.length > 3 ? new THREE.CatmullRomCurve3(pts) : null;
    placeProbes(back, railEnd);
}

// Where the two needles are parked, and the leads back to the meter.
function placeProbes(back, railEnd) {
    const on = state.probe !== 'off';
    probeRed.visible = probeBlk.visible = on;
    if (!on) return;
    let a, b;
    if (state.probe === 'batt') { a = railV('bp', 23); b = railV('bn', 23); }
    else if (state.probe === 'res') {
        const r = state.limiter === 'fixed' ? 'F' : 'I';
        a = holeV(state.limiter === 'fixed' ? COL.out : COL.potA, r); b = holeV(COL.a, r);
    } else if (state.probe === 'load') {
        a = holeV(COL.a, 'H'); b = holeV(outCol(), 'H');
    } else { a = back; b = railEnd; }
    // Each needle stands on its point, leaning back the way a hand
    // holds it. The red lead moves to the A socket to read current and
    // back to the V socket to read volts — which is the difference
    // between the two measurements, made visible.
    [[probeRed, a, -1], [probeBlk, b, 1]].forEach(([pr, p, s]) => {
        pr.position.set(p.x, TOP + 1, p.z + mm(1.5));
        pr.rotation.set(-0.98, 0, s * 0.26);
        pr.updateMatrixWorld(true);
    });
    meterGrp.updateMatrixWorld(true);
    const sock = meterSock.map(v => meterFace.localToWorld(v.clone()));
    const hot = state.probe === 'amps' ? sock[0] : sock[2];
    [[probeRed, hot, MAT.red], [probeBlk, sock[1], MAT.black]].forEach(([pr, sk, m]) => {
        const tail = pr.localToWorld(new THREE.Vector3(0, pr.userData.tail, 0));
        const m1 = tail.clone().lerp(sk, 0.34); m1.y -= mm(26);
        const m2 = tail.clone().lerp(sk, 0.72); m2.y -= mm(14);
        const cv = new THREE.CatmullRomCurve3([tail, m1, m2, sk]);
        wireGrp.add(new THREE.Mesh(new THREE.TubeGeometry(cv, 40, mm(1.15), 8, false), m));
    });
}

// Beads of current. They are not electrons and they are not to scale;
// they are there so that "the same current everywhere" is something
// you can watch rather than something you are told.
function buildBeads() {
    clearGroup(beadGrp);
    beads = [];
    const geo = new THREE.SphereGeometry(mm(0.62), 10, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffcf4d });
    for (let i = 0; i < 12; i++) {
        const m = new THREE.Mesh(geo, mat);
        m.visible = false;
        beadGrp.add(m);
        beads.push(m);
    }
}

// =============================================================
//  One tick of the bench
// =============================================================
function step(dt) {
    S = solve();

    // An LED does not die the instant it is overloaded, it cooks. Heat
    // goes in faster the harder it is driven and leaks away slowly when
    // it is not, so a brief flash survives and a dead short does not.
    if (state.circuit === 'led' || twoLED()) {
        const over = S.iled - LED.hurt;
        state.heat = Math.max(0, state.heat + (over > 0 ? over * dt : -0.06 * dt));
        if (state.heat > LED.kill && !state.burnt) {
            state.burnt = true;
            state.heat = LED.kill;
            blip(140, 0.12, 'sawtooth');
            S = solve();
        }
    }

    // Brightness and speed are both eased, because neither an LED's
    // phosphor nor a motor's rotor changes state instantly and a
    // reading that snaps looks wrong even when it is right.
    const wantLit = state.burnt ? 0 : brightness();
    state.lit += (wantLit - state.lit) * Math.min(1, dt * 16);
    const wantRpm = S.omega * 60 / (2 * Math.PI);
    state.rpm += (wantRpm - state.rpm) * Math.min(1, dt * (wantRpm > state.rpm ? 2.2 : 3.4));
    state.spin += state.rpm / 60 * 2 * Math.PI * dt;

    // The beads run at a speed that stands for the current. Scaled by a
    // cube root so that a 20 mA trickle and a 600 mA short are both
    // watchable in the same window.
    state.beads += Math.pow(Math.min(S.i, 1.2), 0.34) * dt * 0.26;
    if (state.beads > 1) state.beads -= 1;
}

function update3D() {
    if (!gl) return;

    // the board's plastic, seen through or not
    MAT.board.transparent = state.links;
    MAT.board.opacity = state.links ? 0.74 : 1;
    MAT.body.transparent = state.links;
    MAT.body.opacity = state.links ? 0.5 : 1;
    stripGrp.visible = state.links;
    labelGrp.visible = state.labels;

    // the lit LEDs
    const lit = state.lit;
    const nLit = twoLED() ? 2 : 1;
    ledGrp.forEach((g, i) => {
        if (!g.visible) return;
        const u = i < nLit ? lit : 0;
        const d = g.userData;
        d.core.material.emissiveIntensity = u * 3.4;
        // driven past its rating it goes white before it goes out
        d.core.material.emissive.setHex(u > 1.05 ? 0xffd9c0 : 0xff3c14);
        d.glow.material.opacity = clamp(u * 0.62, 0, 0.92);
        d.glow.scale.setScalar(52 + u * 34);
        d.light.intensity = u * 26;
        d.tint.emissiveIntensity = Math.min(u, 1.2) * 0.85;
    });

    // the knob, turned to where the slider says
    if (potKnob) potKnob.rotation.y = -(P.pot / 100) * 4.6;
    // the switch, thrown
    if (switchLever) {
        // the actuator's own throw, not a fraction of the pin spacing
        const want = (state.closed ? 1 : -1) * mm(2.2);
        switchLever.position.x += (want - switchLever.position.x) * 0.35;
    }
    if (propGrp) propGrp.rotation.x = state.spin;

    // The range knob turns to whatever is being measured. It costs six
    // lines and it is the difference between an instrument and a picture
    // of one — and it quietly teaches that you SELECT a function before
    // you read anything.
    if (meterKnob) {
        const want = state.probe === 'off' ? 0
                   : state.probe === 'amps' ? 2.42       // round to the A group
                   : 1.28;                                //  ... or the V group
        let d = want - meterKnob.rotation.y;
        meterKnob.rotation.y += d * 0.18;
    }

    // the beads, spread evenly round the loop
    const show = state.flow && flowCurve && S.i > 1e-5;
    beads.forEach((b, i) => {
        b.visible = show;
        if (!show) return;
        let u = (state.beads + i / beads.length) % 1;
        b.position.copy(flowCurve.getPoint(u));
    });
}

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
        camT = Math.min(1, camT + real / 0.8);
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
    bench3.material.color.setHex(dark ? 0x131c2e : 0xdbe1ea);
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
const fmtOhms = r => r >= 1000 ? (r / 1000).toFixed(r >= 10000 ? 0 : 1) + ' k' : r.toFixed(0);

function meterReads() {
    if (state.probe === 'off') return ['OFF', ''];
    if (state.probe === 'amps') return [(S.i * 1000).toFixed(1), 'mA'];
    const v = state.probe === 'batt' ? S.vterm : state.probe === 'res' ? S.vres : S.vload;
    return [v.toFixed(2), 'V'];
}

function updateStats() {
    $('stat-volts').textContent = S.vterm.toFixed(2);
    $('stat-amps').textContent = (S.i * 1000).toFixed(1);
    $('stat-ohms').textContent = S.i > 1e-6 ? fmtOhms(S.rext) : '——';
    $('stat-power').textContent = (S.w * 1000).toFixed(0);
    const m = meterReads();
    $('stat-meter').textContent = state.probe === 'off' ? '——' : m[0] + ' ' + m[1];
    drawMeter(m[0], m[1]);

    // The supply sagging is not a fault, it is the battery telling you
    // how hard it is being worked — but past a fifth it is worth saying.
    const sag = (emf() - S.vterm) / emf();
    $('stat-volts').className = 'stat font-bold ' + (sag > 0.2 ? 'text-rose-600' : 'text-sky-600');
    const hot = (state.circuit === 'led' || twoLED()) && S.iled > LED.hurt;
    $('stat-amps').className = 'stat font-bold ' + (hot ? 'text-rose-600' : 'text-emerald-600');
    $('stat-ohms').className = 'stat font-bold text-violet-600';
    $('stat-power').className = 'stat font-bold text-amber-600';
    paintAlarm();
}

// Nothing on this board fails silently. Every way a circuit can refuse
// to work has its own name and its own number, because "it doesn't
// light up" is the least useful sentence in electronics.
function paintAlarm() {
    const box = $('alarm');
    let title = '', body = '', tone = '';
    const mA = (S.i * 1000).toFixed(0);

    if (state.burnt) {
        title = 'The LED is burnt out.';
        body = 'It was passing far more than the 20 mA it is built for, and the '
             + 'junction has gone open circuit. Nothing will bring it back. Press Reset, '
             + 'and this time put a resistor in the loop first.';
        tone = 'bg-rose-50 border-rose-300 text-rose-800';
    } else if (state.flipped && (state.circuit === 'led' || twoLED())) {
        title = 'The LED is in backwards.';
        body = 'An LED only conducts one way round. There is no damage and no current at '
             + 'all — it is simply a gap in the loop. The long leg goes to the + rail.';
        tone = 'bg-slate-100 border-slate-300 text-slate-700';
    } else if (shorted() && S.iled > LED.hurt) {
        title = 'Short circuit.';
        body = 'With no resistor there is nothing to set the current but the battery’s '
             + 'own internal resistance, so it is passing ' + mA + ' mA — about '
             + (S.iled / LED.rated).toFixed(0) + ' times what the LED is rated for. '
             + 'Watch how long it lasts.';
        tone = 'bg-rose-50 border-rose-300 text-rose-800';
    } else if ((state.circuit === 'led' || twoLED()) && S.iled > LED.hurt) {
        title = 'Too much current.';
        body = 'The LED is passing ' + (S.iled * 1000).toFixed(0) + ' mA where 20 mA is '
             + 'wanted. It is cooking. Wind the resistance up, or the battery down.';
        tone = 'bg-amber-50 border-amber-300 text-amber-800';
    } else if (state.circuit === 'motor' && state.closed && S.omega === 0) {
        title = 'The motor cannot start.';
        body = 'There is ' + fmtOhms(limiterOhms()) + 'Ω in the way, so the motor only '
             + 'gets ' + S.vload.toFixed(2) + ' V and it is stalled — drawing ' + mA
             + ' mA and turning it all into heat. A motor needs current, not just volts.';
        tone = 'bg-amber-50 border-amber-300 text-amber-800';
    } else if (inSeries() && state.closed && S.i < 1e-4) {
        title = 'Not enough volts to go round.';
        body = 'Two LEDs in series need ' + (2 * LED.vf).toFixed(1) + ' V between them before '
             + 'either will light, and the battery is only giving ' + emf().toFixed(1)
             + ' V. Add cells, or wire them in parallel instead.';
        tone = 'bg-slate-100 border-slate-300 text-slate-700';
    }
    box.classList.toggle('hidden', !title);
    if (!title) return;
    box.className = 'absolute top-3 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-xl '
                  + 'border shadow-md text-[calc(13px*var(--fs))] text-center max-w-md ' + tone;
    $('alarm-title').textContent = title;
    $('alarm-body').textContent = body;
}

// =============================================================
//  Sound
// =============================================================
// A motor's whine and a buzzer's note are both just tones, so they are
// generated rather than played. That is not a shortcut: the buzzer's
// pitch is its resonant frequency and the motor's is its commutator
// rate, and both are driven by the current the model worked out — so
// what you hear is the reading, not a loop of someone else's motor.
let ac = null, mOsc = null, mGain = null, bOsc = null, bGain = null;
function audioOn() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
        ac = new AC();
        mOsc = ac.createOscillator(); mOsc.type = 'sawtooth'; mOsc.frequency.value = 60;
        const filt = ac.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 1100;
        mGain = ac.createGain(); mGain.gain.value = 0;
        mOsc.connect(filt); filt.connect(mGain); mGain.connect(ac.destination);
        mOsc.start();
        bOsc = ac.createOscillator(); bOsc.type = 'square'; bOsc.frequency.value = BUZZER.hz;
        bGain = ac.createGain(); bGain.gain.value = 0;
        bOsc.connect(bGain); bGain.connect(ac.destination);
        bOsc.start();
    } catch (e) { ac = null; }
}
// the switch's click, and the small sad noise an LED makes when it goes
function blip(hz, dur, type) {
    if (!ac || !state.sound) return;
    try {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = type || 'square'; o.frequency.value = hz;
        g.gain.setValueAtTime(0.09, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
        o.connect(g); g.connect(ac.destination);
        o.start(); o.stop(ac.currentTime + dur + 0.02);
    } catch (e) {}
}
function soundUpdate() {
    if (!ac) return;
    const on = state.sound;
    const t = ac.currentTime;
    const mv = (on && state.circuit === 'motor' && state.rpm > 40)
        ? clamp(0.015 + S.i * 0.2, 0, 0.14) : 0;
    mGain.gain.setTargetAtTime(mv, t, 0.05);
    mOsc.frequency.setTargetAtTime(clamp(state.rpm / 60 * 3, 20, 900), t, 0.06);
    const bv = (on && state.circuit === 'buzzer' && S.i > BUZZER.on)
        ? clamp(S.i * 1.4, 0, 0.08) : 0;
    bGain.gain.setTargetAtTime(bv, t, 0.02);
}
function soundAllStop() {
    if (!ac) return;
    try {
        mGain.gain.setTargetAtTime(0, ac.currentTime, 0.02);
        bGain.gain.setTargetAtTime(0, ac.currentTime, 0.02);
    } catch (e) {}
}

// =============================================================
//  Loop
// =============================================================
const DT = 1 / 240;
let acc = 0, last = performance.now();
function frame(now) {
    requestAnimationFrame(frame);
    const real = Math.min(0.05, (now - last) / 1000);
    last = now;
    const byT = state.fast ? 4 : state.slow ? 0.25 : 1;
    acc += real * byT;
    let n = 0;
    while (acc >= DT && n < 500) { step(DT); acc -= DT; n++; }
    advanceCamera(real);
    update3D();
    updateStats();
    soundUpdate();
    if (gl) { controls.update(); renderer.render(scene, camera); }
}

function reset() {
    state.closed = false;
    state.flipped = false;
    state.burnt = false;
    state.heat = 0;
    state.lit = 0; state.rpm = 0; state.spin = 0;
    S = solve();
    paintRun(); paintFlip();
    rewire();
}

// =============================================================
//  The controls
// =============================================================
function bindSlider(id, key, fmt, after) {
    const el = $(id);
    const out = $(id.replace('s-', 'v-'));
    el.addEventListener('input', () => {
        P[key] = parseFloat(el.value);
        out.textContent = fmt(P[key]);
        if (after) after();
    });
    out.textContent = fmt(P[key]);
    el.value = P[key];
}
bindSlider('s-emf', 'emf', v => v.toFixed(1), () => { rebuildBattery(); rewire(); });
bindSlider('s-res', 'res', () => fmtOhms(resOhms()), () => rewire());
bindSlider('s-pot', 'pot', () => fmtOhms(potOhms()));

function paintSeg(cls, key) {
    document.querySelectorAll('.' + cls).forEach(b =>
        b.classList.toggle('on', b.dataset[key] === state[key]));
}
function bindSeg(cls, key, after) {
    document.querySelectorAll('.' + cls).forEach(b => b.addEventListener('click', () => {
        state[key] = b.dataset[key];
        paintSeg(cls, key);
        if (after) after();
    }));
    paintSeg(cls, key);
}
bindSeg('cseg', 'circuit', () => { rewire(); paintFlip(); });
bindSeg('wseg', 'wiring', () => rewire());
bindSeg('lseg', 'limiter', () => rewire());
bindSeg('pseg', 'probe', () => rewire());

function paintRun() {
    $('run-label').textContent = state.closed ? 'Open Switch' : 'Close Switch';
    $('btn-run').querySelector('i').className = state.closed
        ? 'fa-solid fa-power-off text-emerald-300' : 'fa-solid fa-power-off';
}
$('btn-run').addEventListener('click', () => {
    audioOn();
    state.closed = !state.closed;
    blip(state.closed ? 900 : 620, 0.045);
    paintRun();
});
// Only the LEDs have a way round. With a motor or a buzzer on the board
// there is nothing to turn, so the button says so by going away.
function paintFlip() {
    const lamps = state.circuit === 'led' || twoLED();
    $('btn-flip').classList.toggle('hidden', !lamps);
    $('flip-label').textContent = state.flipped ? 'Turn LED Back' : 'Turn LED Round';
}
$('btn-flip').addEventListener('click', () => {
    state.flipped = !state.flipped;
    paintFlip(); rewire();
});
$('btn-reset').addEventListener('click', () => { audioOn(); reset(); });

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
        if (after) after(chk.checked);
    });
    chk.checked = state[key];
    paintChip(chip, chk.checked);
}
function setChip(id, on) {
    const chk = $('chk-' + id);
    if (chk.checked === on) return;
    chk.checked = on;
    chk.dispatchEvent(new Event('change'));
}
bindChip('links', 'links');
bindChip('flow', 'flow');
bindChip('labels', 'labels');
bindChip('fast', 'fast', on => { if (on) setChip('slow', false); });
bindChip('slow', 'slow', on => { if (on) setChip('fast', false); });
bindChip('sound', 'sound', on => { if (on) audioOn(); else soundAllStop(); });
bindChip('mesh', 'mesh', applyMesh);
bindChip('spin', 'turntable');

function paintViews(name) {
    document.querySelectorAll('.vseg').forEach(b =>
        b.classList.toggle('on', b.dataset.view === name));
}
document.querySelectorAll('.vseg').forEach(b => b.addEventListener('click', () => {
    setView(b.dataset.view); paintViews(b.dataset.view);
}));
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
        buildBeads();
        rewire();
        controls.addEventListener('start', () => paintViews(null));
    } catch (e) {
        console.warn('3D unavailable:', e);
        const n = $('nogl');
        n.classList.remove('hidden'); n.classList.add('flex');
    }
    reset();
    paintRun(); paintFlip(); paintViewMode();
    paintViews('bench');
    applyMesh();
    resizeView();
    requestAnimationFrame(hideLoader);
    setTimeout(hideLoader, 400);
    requestAnimationFrame(frame);
};


// =============================================================
//  Show and hide the control panel
// =============================================================
// Two buttons, not one that moves. The hide button sits in the panel's
// own bottom-right corner, so it travels with the panel and is gone the
// moment the panel is - which is exactly why it cannot also be the way
// back. The show button lives outside the panel and lands in the same
// spot on screen, so toggling swaps one for the other without anything
// appearing to move.
(function () {
    const hide = document.getElementById('btn-hide');
    const show = document.getElementById('btn-show');
    if (!hide || !show) return;

    function setControls(off) {
        document.body.classList.toggle('controls-off', off);
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
