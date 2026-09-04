// =============================================================
//  6-Axis Robot Arm — model
// =============================================================
// Everything below works in millimetres, seconds, kilograms and
// degrees, so the numbers on screen are the ones a robot programmer
// would actually recognise.
//
//   J1  base swing        rotates about the vertical
//   J2  shoulder          |  between them these two set how far out
//   J3  elbow             |  and how high the wrist sits
//   J4  forearm roll      |
//   J5  wrist bend        |  these three aim the tool
//   J6  tool twist        |
//
// The arm is built as a chain of nested groups, each one rotating
// about a single axis, which is exactly what the real machine is.
const BASE_R = 220, BASE_H = 130;   // the plinth it stands on
const SH_R = 115, SH_Y = 385;       // shoulder pivot: forward of centre, and up
const L2 = 700;                     // upper arm:  shoulder -> elbow
const L3 = 560;                     // forearm:    elbow    -> wrist centre
// J4 sits back along the forearm and J5 sits forward of it by the same
// amount, so the wrist centre lands at exactly L3 from the elbow —
// which is what the inverse solution assumes. Let these two drift apart
// and the drawn tool quietly stops matching the commanded point.
const J4_BACK = 96;
const WR = 110;                     // wrist centre -> tool flange
const REACH = SH_R + L2 + L3;       // 1020 mm, arm dead straight
const TAU_MAX = 200;                // N·m the shoulder joint is rated for
const G = 9.81;

// Two tools, and they hold a part by completely different physics.
//
//   Vacuum   four cups; the pump takes the air out and the atmosphere
//            presses the part on.   F = Δp × A
//   Jaws     two parallel faces squeezed together; what stops the part
//            sliding out is friction.   F = 2 μ N
//
// Parallel jaws, not scissor jaws: parallel faces stay flat against a
// box and tangent to a drum, where an angular pair pinches at a corner
// and rolls a round part straight out of the grip.
const CUP_R = 26, CUP_H = 30, CUP_SPAN = 58;   // mm
const CUP_N = 4;
const VAC_KPA = 55;                            // how far below atmosphere the pump pulls
const CUP_AREA = CUP_N * Math.PI * (CUP_R / 1000) ** 2;      // m²
const MU = 0.55;                               // rubber pads on card or steel
const JAW_N = 340;                             // N the cylinder squeezes with
const JAW_OPEN = 168;                          // how far apart the jaws sit, open
const PAD_T = 9;                               // thickness of the rubber pad
const PAD_GAP = 0.6;                           // a hair of clearance, so faces do not fight
const TOOLS = {
    vac: { name: 'Vacuum', len: 150 },
    jaw: { name: 'Jaws',   len: 165 }
};
let TOOL = TOOLS.vac.len;                      // flange -> tool point
const holdForce = () => state.tool === 'vac'
    ? VAC_KPA * 1000 * CUP_AREA                // pressure times sealed area
    : 2 * MU * JAW_N;                          // friction on two faces
// Neither tool only carries the weight. Whatever the arm accelerates
// at, the part has to be accelerated too, and that comes through it.
const needForce = () => P.load * (G + P.accel / 1000);       // N required
const holdFail = () => needForce() > holdForce();
// Jaws have to reach in from the sides. They cannot get under a panel
// lying flat on a table without hitting the table first.
const toolFits = () => state.tool === 'vac' || partDef().jaw !== false;
// The lowest thing on the jaw tool that sits on the tool's own centre
// line is the slide rail, 59mm above the tool point. Anything of the
// part that reaches higher than that ends up inside the gripper, so the
// jaws take hold this far down from the top face and no less.
const JAW_TOP_CLEAR = 45;
// Where the tool takes hold: cups seal on the top face, jaws close near
// the top and hang the rest of the part below themselves.
const holdDrop = () => state.tool === 'vac'
    ? partH()
    : Math.max(partH() / 2, partH() - JAW_TOP_CLEAR);

// ---- the cell around it ----
// The top is lower than it was so that a stack of parts still passes
// under the height everything travels at, without costing reach.
const TABLE = { x: 980, z: 60, top: 220, w: 660, d: 620 };
const BELT  = { x: -880, y: 340, w: 340, z0: -1200, z1: 1200 };
const DROP  = { x: -880, z: -700 };   // where a part is set down on the belt
const HOME = { x: 520, y: 850, z: 0 };

// Three things to move, each a different size and shape, because the
// gripper has to close to a different width for each.
// All three have a flat top for the cups to seal against, and all
// three are wide enough for the four of them to land on it.
const PARTS = {
    // `stack` is how many are piled in each place on the table. Cartons
    // and panels stack; a drum on its end does not.
    box:   { name: 'Carton', kind: 'box',   w: 240, d: 180, h: 160, grip: 182, stack: 2 },
    can:   { name: 'Drum',   kind: 'cyl',   r: 88,  h: 200,          grip: 179, stack: 1 },
    // a panel is the part suction was invented for, and the one a pair
    // of jaws cannot get hold of: too thin to reach under
    panel: { name: 'Panel',  kind: 'panel', w: 250, d: 185, h: 34, grip: 185, jaw: false, stack: 4 }
};
// Drums are the coloured ones — a warehouse drum really is painted.
// A carton is kraft board, and the small differences between them are
// just how the board came out, not four different products.
const COLOURS = [0x0ea5e9, 0x10b981, 0xf59e0b, 0x8b5cf6, 0xef4444, 0x14b8a6];
const KRAFT   = [0xbf9165, 0xb2845a, 0xba8b60, 0xac7f55, 0xbb8d62, 0xb08257];

const DEFAULTS = { speed: 700, accel: 2500, belt: 55, load: 6 };
const P = Object.assign({}, DEFAULTS);

const state = {
    part: 'box', path: 'ptp', tool: 'vac',
    running: false, paused: false,
    fast: false, slow: false,
    axes: false, env: false, trail: true, mesh: false, spin: false,
    sound: true,
    viewMode: 'light',
    placed: 0, cycle: 0, cycleT: 0,     // finished parts, and how long one takes
    phase: 'idle', phaseT: 0, phaseDur: 0,
    grip: 1,                            // 1 = wide open, 0 = closed on the part
    held: null,
    q: [0, 0, 0, 0, 0, 0],              // the six joint angles, radians
    tcp: { x: HOME.x, y: HOME.y, z: HOME.z },
    yaw: 0,                             // which way round the tool is holding it
    clock: 0, cycleStart: undefined,    // for timing one part start to finish
    homing: false,                      // travelling back to the ready pose
    demo: false, demoJ: 0, demoT: 0,    // running each axis through its travel
    demoW: 0,                           // how fast that joint is turning, rad/s
    servo: 0,                           // how hard the motors are working, 0..1
    tcpV: 0, reachFail: false
};

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DEG = 180 / Math.PI;

// =============================================================
//  Kinematics
// =============================================================
// Forward is easy: follow the arm along. Inverse is the useful one —
// given a point the tool has to reach, what must the six angles be?
// With the tool held pointing straight down it comes apart into a base
// swing and a triangle, and the triangle is just the cosine rule.
function ik(x, y, z, yaw) {
    const R = Math.hypot(x, z);
    const q1 = Math.atan2(-z, x);            // swing the arm into the target's plane

    // The tool points straight down, so the wrist sits directly above
    // the tool point by the length of the wrist and the tool together.
    const dr = R - SH_R, dy = (y + WR + TOOL) - SH_Y;
    const D0 = Math.hypot(dr, dy);
    const Dmax = L2 + L3 - 0.5;              // arm dead straight
    const Dmin = Math.abs(L2 - L3) + 0.5;    // arm folded back on itself
    const D = clamp(D0, Dmin, Dmax);

    // the shoulder–elbow–wrist triangle, solved elbow-up
    const inner = Math.acos(clamp((L2 * L2 + L3 * L3 - D * D) / (2 * L2 * L3), -1, 1));
    const lift  = Math.acos(clamp((D * D + L2 * L2 - L3 * L3) / (2 * D * L2), -1, 1));
    const q2 = Math.atan2(dy, dr) + lift;
    const q3 = -(Math.PI - inner);

    // whatever the shoulder and elbow did, the wrist takes it back out
    const q5 = -Math.PI / 2 - q2 - q3;
    const q4 = 0;
    // J6 turns the head back against the base swing, so the cups stay
    // lined up with the part however far the arm has swung round
    const q6 = q1 - (yaw || 0);

    // Flagged the moment the triangle had to be forced, not half a
    // millimetre later: inside that slack the arm was quietly put
    // somewhere it had not been asked to go, and said nothing.
    return { q: [q1, q2, q3, q4, q5, q6], reachFail: D0 > Dmax || D0 < Dmin };
}

// Where the tool point actually ends up, given the angles. Only used to
// check the inverse solution, and to read the arm's true reach.
function fk(q) {
    const rWrist = SH_R + L2 * Math.cos(q[1]) + L3 * Math.cos(q[1] + q[2]);
    const yWrist = SH_Y + L2 * Math.sin(q[1]) + L3 * Math.sin(q[1] + q[2]);
    const a = q[1] + q[2] + q[4];                 // where the tool points
    const r = rWrist + (WR + TOOL) * Math.cos(a);
    const y = yWrist + (WR + TOOL) * Math.sin(a);
    return { x: r * Math.cos(q[0]), y: y, z: -r * Math.sin(q[0]) };
}

// How far out the tool is held, measured from the shoulder axis. This
// is the lever arm the payload acts on, so it is what sets the torque.
const leverArm = () => Math.max(0, Math.hypot(state.tcp.x, state.tcp.z) - SH_R);
const torque = () => P.load * G * leverArm() / 1000;      // N·m
const overload = () => torque() > TAU_MAX;

// =============================================================
//  Getting there: the trapezoidal speed profile
// =============================================================
// Nothing jumps to speed. A move accelerates at a, holds v if it ever
// reaches it, then brakes in time to stop. Draw speed against time and
// it is a trapezium — or, on a short move, a triangle, because there
// was never room to reach v at all.
function moveTime(d, v, a) {
    if (d <= 1e-6) return 0;
    if (d < v * v / a) return 2 * Math.sqrt(d / a);   // never gets to full speed
    return d / v + v / a;
}
// how far along the move it has got, and how fast it is going
function moveAt(t, d, v, a) {
    if (d <= 1e-6) return { s: d, v: 0 };
    const T = moveTime(d, v, a);
    t = clamp(t, 0, T);
    if (d < v * v / a) {                              // triangle
        const ta = T / 2;
        if (t <= ta) return { s: 0.5 * a * t * t, v: a * t };
        const r = T - t;
        return { s: d - 0.5 * a * r * r, v: a * r };
    }
    const ta = v / a, sa = 0.5 * v * v / a;            // trapezium
    if (t <= ta) return { s: 0.5 * a * t * t, v: a * t };
    const tc = (d - 2 * sa) / v;
    if (t <= ta + tc) return { s: sa + v * (t - ta), v: v };
    const r = T - t;
    return { s: d - 0.5 * a * r * r, v: a * r };
}
// A joint move is timed off the joint with the furthest to turn, not
// off the distance the tool covers. Speeds are converted at a nominal
// radius so the two path types stay comparable.
const NOMINAL_R = 620;
const jointV = () => P.speed / NOMINAL_R;
const jointA = () => P.accel / NOMINAL_R;

// =============================================================
//  The cell, in three dimensions
// =============================================================
let scene, camera, renderer, controls;
let j1G, j2G, j3G, j4G, j5G, j6G, tcpNode;
let floor3, grid3, envGroup, cabScreen = null, cabTex = null;
const axisHelpers = [];
let beltTop = null, beltTex = null, partsGroup = null;
const rollers = [];
const ROLLER_R = 24;
let trailLine = null, trailPos = null, trailCol = null, trailN = 0;
let gl = false;

const MAT = {};
const TRAIL_MAX = 1600;

// Every bar on a real machine has a softened edge; a plain box looks
// like a diagram. The profile is a rounded rectangle and the extrusion
// carries a small bevel, so the front and back edges come off too.
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

// The conveyor belt, as a texture that can be scrolled along. Without
// the cross-cleats a moving belt is a plain grey strip and reads as
// standing perfectly still.
function beltTexture() {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#2b2f36'; g.fillRect(0, 0, 32, 128);
    g.fillStyle = '#3d434c'; g.fillRect(0, 0, 32, 10);
    g.fillStyle = '#22262c'; g.fillRect(0, 10, 32, 3);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}

// The screen on the stand beside the robot: the six joint angles, what
// the machine is doing, and how many parts it has put through.
const SCR_W = 256, SCR_H = 208;      // the screen is drawn in these units...
const SCR_SC = 1.6;                  // ...and rendered this much larger
function cabinetScreen() {
    const c = document.createElement('canvas');
    c.width = Math.round(SCR_W * SCR_SC); c.height = Math.round(SCR_H * SCR_SC);
    cabScreen = c.getContext('2d');
    // everything below is written in the 256x208 layout; this scales the
    // whole drawing up so the bigger panel stays sharp
    cabScreen.setTransform(SCR_SC, 0, 0, SCR_SC, 0, 0);
    cabTex = new THREE.CanvasTexture(c);
    cabTex.anisotropy = 4;
    drawCabinet(true);
    return cabTex;
}
let cabWas = '', cabSkip = 0, cabState = '';
function drawCabinet(force) {
    if (!cabScreen) return;
    const st = statusText();
    const sig = state.q.map(v => (v * DEG).toFixed(0)).join(',') + st;
    const changed = st !== cabState;
    // Redrawing uploads the whole texture to the GPU, and the angles
    // change every frame while the arm is moving. So it is capped at
    // about fifteen refreshes a second — what a real panel manages —
    // and a change of state is never held back.
    if (!force && !changed) {
        if (sig === cabWas) return;
        if (++cabSkip < 4) return;
    }
    cabSkip = 0; cabWas = sig; cabState = st;

    const g = cabScreen;
    g.fillStyle = '#06140e'; g.fillRect(0, 0, 256, 208);
    g.textBaseline = 'middle';
    const cols = ['#ff6b6b', '#fb923c', '#facc15', '#4ade80', '#38bdf8', '#c084fc'];
    for (let i = 0; i < 6; i++) {
        const y = 20 + i * 27;
        g.font = 'bold 25px ui-monospace, Menlo, Consolas, monospace';
        g.fillStyle = cols[i]; g.textAlign = 'left';
        g.fillText('J' + (i + 1), 10, y);
        g.fillStyle = '#e9fff5'; g.textAlign = 'right';
        g.fillText((state.q[i] * DEG).toFixed(1), 214, y);
        g.font = 'bold 16px ui-monospace, Menlo, Consolas, monospace';
        g.fillStyle = '#5d7f72'; g.textAlign = 'left';
        g.fillText('deg', 218, y + 2);
    }
    g.fillStyle = '#1d3a2e'; g.fillRect(8, 178, 240, 2);
    g.font = 'bold 20px ui-monospace, Menlo, Consolas, monospace';
    g.textAlign = 'left';
    g.fillStyle = (state.reachFail || (state.held && (overload() || holdFail())))
        ? '#f87171'
        : state.running ? '#34d399'
        : state.paused ? '#f0b45f' : '#8aa79b';
    g.fillText(st, 10, 195);
    g.textAlign = 'right'; g.fillStyle = '#8aa79b';
    g.fillText(state.placed + ' done', 246, 195);
    cabTex.needsUpdate = true;
}

function init3D() {
    const host = $('view3d');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1f5f9);

    // The near plane is what sets depth precision, and 1 against a far
    // of 12000 leaves so little of it out here that touching surfaces
    // flicker. Nothing ever comes nearer than the 260 mm the controls
    // allow, so this costs nothing and buys a great deal.
    camera = new THREE.PerspectiveCamera(42, 1, 20, 11000);
    // opens on the Tool view, which rides along with the tool point
    camera.position.set(1220, 1350, 900);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 260;
    controls.maxDistance = 9000;
    controls.maxPolarAngle = Math.PI / 2 + 0.02;
    controls.autoRotateSpeed = 0.9;
    controls.target.set(520, 850, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(1700, 2700, 2000);
    key.castShadow = true;
    key.shadow.mapSize.width = key.shadow.mapSize.height = 2048;
    key.shadow.camera.left = -2400; key.shadow.camera.right = 2400;
    key.shadow.camera.top = 2400; key.shadow.camera.bottom = -2400;
    key.shadow.camera.far = 7000;
    key.shadow.bias = -0.0006;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x93c5fd, 0.34);
    fill.position.set(-2000, 1300, -1600); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.42);
    rim.position.set(0, 1400, -3000); scene.add(rim);

    floor3 = new THREE.Mesh(
        new THREE.PlaneGeometry(9000, 9000),
        new THREE.MeshStandardMaterial({ color: 0xdbe1ea, roughness: 0.92 }));
    floor3.rotation.x = -Math.PI / 2;
    floor3.position.y = -1;
    floor3.receiveShadow = true;
    scene.add(floor3);

    grid3 = new THREE.GridHelper(9000, 60, 0x94a3b8, 0xcbd5e1);
    scene.add(grid3);

    MAT.shell  = new THREE.MeshStandardMaterial({ color: 0xf2c218, roughness: 0.38, metalness: 0.10 });
    MAT.black  = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.52, metalness: 0.22 });
    MAT.grey   = new THREE.MeshStandardMaterial({ color: 0x53585f, roughness: 0.44, metalness: 0.40 });
    MAT.cable  = new THREE.MeshStandardMaterial({ color: 0x121417, roughness: 0.72 });
    MAT.dark   = new THREE.MeshStandardMaterial({ color: 0x2b303a, roughness: 0.5, metalness: 0.24 });
    // Legs and frames: light grey aluminium extrusion. In black they
    // read as heavy dark bars and pull the eye off the robot; too shiny
    // and they catch the light instead. This sits back and stays quiet.
    MAT.alu    = new THREE.MeshStandardMaterial({ color: 0xc8cdd4, roughness: 0.46, metalness: 0.34 });
    // The pendant's case: a warm off-white, the way moulded machine
    // housings usually are. Paler than this and it would vanish against
    // the light background; the dark glass gives it its edge either way.
    MAT.case   = new THREE.MeshStandardMaterial({ color: 0xe9e5dd, roughness: 0.58, metalness: 0.04 });
    MAT.steel  = new THREE.MeshStandardMaterial({ color: 0xb9bfc9, metalness: 0.62, roughness: 0.24 });
    MAT.pale   = new THREE.MeshStandardMaterial({ color: 0xd3d9e1, metalness: 0.26, roughness: 0.42 });
    MAT.rubber = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.88 });
    MAT.paint  = new THREE.MeshStandardMaterial({ color: 0xeab308, roughness: 0.8 });

    buildRobot();
    buildCell();
    buildEnvelope();
    buildAxes();
    buildTrail();
}

// ---- the arm itself: six groups, six rotations ----------------
// A big black joint hub with concentric rings on its face, which is
// what an industrial arm actually looks like where the castings meet.
function hub(r, len) {
    const g = new THREE.Group();
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 34), MAT.black);
    drum.rotation.x = Math.PI / 2; drum.castShadow = true; g.add(drum);
    [-1, 1].forEach(sgn => {
        const ring = new THREE.Mesh(
            new THREE.CylinderGeometry(r * 0.86, r * 0.86, 14, 34), MAT.grey);
        ring.rotation.x = Math.PI / 2; ring.position.z = sgn * (len / 2 + 3); g.add(ring);
        const face = new THREE.Mesh(
            new THREE.CylinderGeometry(r * 0.66, r * 0.66, 18, 34), MAT.black);
        face.rotation.x = Math.PI / 2; face.position.z = sgn * (len / 2 + 7); g.add(face);
        const boss = new THREE.Mesh(
            new THREE.CylinderGeometry(r * 0.30, r * 0.30, 22, 26), MAT.grey);
        boss.rotation.x = Math.PI / 2; boss.position.z = sgn * (len / 2 + 10); g.add(boss);
    });
    return g;
}

// The black cable looms that run down the outside of every real arm.
// Each one gets a gland clamped over both ends: a tube that simply stops
// in mid-air reads as a cable someone has left unplugged.
const _up = new THREE.Vector3(0, 1, 0);
function loom(pts, rad, parent) {
    const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], p[1], p[2])));
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 30, rad, 9, false), MAT.cable);
    m.castShadow = true; parent.add(m);
    [0, 1].forEach(t => {
        const p = curve.getPoint(t);
        const tan = curve.getTangent(t).normalize();
        const g = new THREE.Mesh(
            new THREE.CylinderGeometry(rad * 1.55, rad * 1.9, rad * 2.8, 14), MAT.grey);
        g.position.copy(p).addScaledVector(tan, t === 0 ? rad * 0.7 : -rad * 0.7);
        g.quaternion.setFromUnitVectors(_up, tan);
        g.castShadow = true;
        g.userData.gland = true;
        parent.add(g);
    });
    return m;
}

// The warning plates. Every industrial arm carries them, and they are
// most of what makes a yellow casting read as machinery.
function decalTexture(word, sub) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#f2c218'; g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#16181b'; g.fillRect(0, 0, 256, 12);
    g.fillRect(0, 116, 256, 12);
    g.fillStyle = '#16181b';
    g.font = 'bold 44px Inter, Helvetica, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(word, 128, 52);
    g.font = 'bold 17px Inter, Helvetica, Arial, sans-serif';
    g.fillText(sub, 128, 90);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
}
// The maker's badge, on the flat of the shoulder casting: a mark of the
// arm itself — base joint, upper arm, elbow, forearm, tool — and the
// wordmark. Dark ink straight on the yellow shell, which is about 11:1,
// so it reads from the back of a classroom.
function brandTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 160;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 512, 160);
    const ink = '#1b1d20';
    g.strokeStyle = ink; g.fillStyle = ink;
    g.lineCap = 'round'; g.lineJoin = 'round';
    // the arm: shoulder, upper arm, elbow, forearm, tool
    g.lineWidth = 17;
    g.beginPath();
    g.moveTo(40, 118); g.lineTo(78, 52); g.lineTo(140, 74);
    g.stroke();
    g.beginPath(); g.arc(40, 118, 21, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f2c218';
    g.beginPath(); g.arc(40, 118, 8, 0, Math.PI * 2); g.fill();
    g.fillStyle = ink;
    g.beginPath(); g.arc(78, 52, 15, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f2c218';
    g.beginPath(); g.arc(78, 52, 6, 0, Math.PI * 2); g.fill();
    g.fillStyle = ink;
    g.fillRect(134, 62, 22, 24);                 // the tool on the end
    g.fillRect(24, 136, 90, 11);                 // the plinth it stands on
    g.textBaseline = 'middle';
    g.font = 'bold 66px Inter, Helvetica, Arial, sans-serif';
    g.fillText('TCE-LAB', 186, 66);
    g.font = '600 25px Inter, Helvetica, Arial, sans-serif';
    g.globalAlpha = 0.82;
    g.fillText('SIX  AXIS  ROBOTICS', 188, 116);
    g.globalAlpha = 1;
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
}
function brand(w, h) {
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshStandardMaterial({
            map: brandTexture(), transparent: true, roughness: 0.5, metalness: 0 }));
}

function decal(word, sub, w, h) {
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshStandardMaterial({ map: decalTexture(word, sub), roughness: 0.6 }));
}

function buildRobot() {
    // --- the cast base plate it is bolted down to ---
    const plate = new THREE.Mesh(
        new THREE.CylinderGeometry(540, 540, 62, 8), MAT.black);
    plate.rotation.y = Math.PI / 8;
    plate.position.y = 31;
    plate.castShadow = plate.receiveShadow = true;
    scene.add(plate);
    for (let i = 0; i < 8; i++) {                       // hold-down bolts
        const a = i / 8 * Math.PI * 2 + Math.PI / 8;
        const bolt = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 16, 6), MAT.grey);
        bolt.position.set(Math.cos(a) * 445, 66, Math.sin(a) * 445);
        bolt.castShadow = true; scene.add(bolt);
    }
    // the fixed part of the turntable
    const seat = new THREE.Mesh(
        new THREE.CylinderGeometry(304, 332, BASE_H - 62, 40), MAT.black);
    seat.position.y = 62 + (BASE_H - 62) / 2;
    seat.castShadow = seat.receiveShadow = true; scene.add(seat);

    // --- J1: the whole arm swings about the vertical ---
    j1G = new THREE.Group();
    scene.add(j1G);
    // the yellow band around the turntable, which is what makes the
    // base swing visible at all
    const band = new THREE.Mesh(
        new THREE.CylinderGeometry(294, 294, 34, 40), MAT.shell);
    band.position.y = BASE_H + 17; band.castShadow = true; j1G.add(band);
    const drum = new THREE.Mesh(
        new THREE.CylinderGeometry(272, 286, 98, 40), MAT.black);
    drum.position.y = BASE_H + 34 + 49; drum.castShadow = true; j1G.add(drum);
    // the yellow casting that carries the shoulder, leaning forward
    const col = new THREE.Mesh(roundedBox(286, SH_Y - BASE_H - 148, 270, 34), MAT.shell);
    col.position.set(26, BASE_H + 132 + (SH_Y - BASE_H - 148) / 2, 0);
    col.castShadow = true; j1G.add(col);
    // the two cheeks the shoulder is slung between
    [-1, 1].forEach(sgn => {
        const cheek = new THREE.Mesh(roundedBox(240, 218, 52, 24), MAT.shell);
        cheek.position.set(SH_R - 30, SH_Y - 50, sgn * 119);
        cheek.castShadow = true; j1G.add(cheek);
        // the badge, on the outer flat of each shoulder cheek
        const bd = brand(168, 52);
        bd.position.set(SH_R - 30, SH_Y - 96, sgn * 145.6);
        if (sgn < 0) bd.rotation.y = Math.PI;     // face outwards on both sides
        j1G.add(bd);
    });
    const bhouse = new THREE.Mesh(roundedBox(172, 150, 218, 18), MAT.black);
    bhouse.position.set(-138, SH_Y - 110, 0); bhouse.castShadow = true; j1G.add(bhouse);

    // --- J2: the shoulder ---
    j2G = new THREE.Group();
    j2G.position.set(SH_R, SH_Y, 0);
    j1G.add(j2G);
    j2G.add(hub(128, 246));                       // the big black shoulder hub
    const upper = new THREE.Mesh(roundedBox(L2 - 70, 170, 172, 44), MAT.shell);
    upper.position.x = L2 / 2 + 12; upper.castShadow = true; j2G.add(upper);
    const upperBack = new THREE.Mesh(roundedBox(172, 138, 182, 32), MAT.black);
    upperBack.position.x = L2 - 54; upperBack.castShadow = true; j2G.add(upperBack);
    // the loom down the outside of the upper arm
    loom([[46, -90, 99], [196, -106, 110], [380, -101, 108], [L2 - 46, -76, 99]], 15, j2G);
    loom([[46, -90, 71], [196, -110, 83], [380, -106, 81], [L2 - 46, -80, 71]], 13, j2G);
    const d1 = decal('CAUTION', 'KEEP CLEAR OF MOVING MACHINERY', 196, 72);
    d1.position.set(L2 * 0.42, 0, 87); j2G.add(d1);
    // the maker's mark down the far side of the upper arm — the biggest
    // flat on the machine, and the one the warning plate does not use
    const bigBadge = brand(268, 83);
    bigBadge.position.set(L2 * 0.50, 6, -87);
    bigBadge.rotation.y = Math.PI;
    j2G.add(bigBadge);

    // --- J3: the elbow ---
    j3G = new THREE.Group();
    j3G.position.set(L2, 0, 0);
    j2G.add(j3G);
    j3G.add(hub(101, 193));
    const fore = new THREE.Mesh(roundedBox(L3 - 160, 136, 143, 36), MAT.shell);
    fore.position.x = (L3 - 160) / 2 + 53; fore.castShadow = true; j3G.add(fore);
    // the loom looping over the elbow, which is where it always goes
    loom([[-34, 106, 80], [64, 147, 85], [172, 120, 80], [L3 - 150, 85, 76]], 14, j3G);
    const d2 = decal('DANGER', 'DO NOT REACH INTO MACHINE', 173, 62);
    d2.position.set(L3 * 0.40, 0, 73); j3G.add(d2);

    // --- J4: the forearm rolls about its own length ---
    j4G = new THREE.Group();
    j4G.position.set(L3 - J4_BACK, 0, 0);
    j3G.add(j4G);
    const rollTube = new THREE.Mesh(
        new THREE.CylinderGeometry(60, 67, 100, 30), MAT.shell);
    rollTube.rotation.z = Math.PI / 2; rollTube.position.x = 48;
    rollTube.castShadow = true; j4G.add(rollTube);
    const rollBand = new THREE.Mesh(
        new THREE.CylinderGeometry(69, 69, 18, 30), MAT.black);
    rollBand.rotation.z = Math.PI / 2; rollBand.position.x = 15; j4G.add(rollBand);
    // a cable spiralling round it, so the roll is visible at all
    loom([[6, 64, 0], [32, 34, 53], [62, -23, 46], [92, -39, -16]], 9, j4G);

    // --- J5: the wrist bends ---
    j5G = new THREE.Group();
    j5G.position.set(J4_BACK, 0, 0);
    j4G.add(j5G);
    j5G.add(hub(71, 120));
    const wrArm = new THREE.Mesh(roundedBox(WR, 99, 110, 25), MAT.shell);
    wrArm.position.x = WR / 2; wrArm.castShadow = true; j5G.add(wrArm);

    // --- J6: the tool flange twists, and carries the tool ---
    j6G = new THREE.Group();
    j6G.position.set(WR, 0, 0);
    j5G.add(j6G);
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(50, 50, 28, 30), MAT.grey);
    flange.rotation.z = Math.PI / 2; flange.castShadow = true; j6G.add(flange);

    tcpNode = new THREE.Object3D();
    tcpNode.position.set(TOOL, 0, 0);
    j6G.add(tcpNode);
    buildTool();
}

// ---- the tools ------------------------------------------------
// Whichever is fitted is built into its own group, so swapping one for
// the other is a matter of throwing the group away and building again.
let cups = [], jaws = [], toolGroup = null;
function buildTool() {
    if (toolGroup) {
        j6G.remove(toolGroup);
        toolGroup.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
    }
    cups = []; jaws = [];
    toolGroup = new THREE.Group();
    j6G.add(toolGroup);
    TOOL = TOOLS[state.tool].len;
    if (tcpNode) tcpNode.position.set(TOOL, 0, 0);
    if (state.tool === 'vac') buildVacuum(); else buildJaws();
    applyMesh();
}

// Four cups on a cross frame — what a real cell uses to lift cartons
// and panels off a table.
function buildVacuum() {
    const g = toolGroup;
    // The flange face is at x = 14. The stem has to start behind that,
    // or the whole head reads as hanging in the air off the end of the
    // wrist rather than being bolted to it.
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(36, 36, 46, 20), MAT.grey);
    collar.rotation.z = Math.PI / 2; collar.position.x = 22;
    collar.castShadow = true; g.add(collar);
    const stem = new THREE.Mesh(roundedBox(88, 66, 66, 12), MAT.black);
    stem.position.x = 54; stem.castShadow = true; g.add(stem);
    const barA = new THREE.Mesh(roundedBox(24, 22, CUP_SPAN * 2 + 52, 6), MAT.black);
    barA.position.x = 88; barA.castShadow = true; g.add(barA);
    const barB = new THREE.Mesh(roundedBox(24, CUP_SPAN * 2 + 52, 22, 6), MAT.black);
    barB.position.x = 88; barB.castShadow = true; g.add(barB);
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sy, sz]) => {
        // the group carries no offset of its own, so a cup's x really
        // is its distance from the flange — which is what lets the
        // squash keep the sealing face exactly on the tool point
        const c = new THREE.Group();
        c.position.set(0, sy * CUP_SPAN, sz * CUP_SPAN);
        // The post has to run all the way into the cup. Stopping it
        // short left a gap that opened wider as the bellows squashed,
        // so it now meets a fitting that covers the joint whatever the
        // cup is doing.
        const post = new THREE.Mesh(
            new THREE.CylinderGeometry(10, 10, 46, 14), MAT.grey);
        post.rotation.z = Math.PI / 2; post.position.x = 100; c.add(post);
        const fit = new THREE.Mesh(
            new THREE.CylinderGeometry(15, 15, 20, 12), MAT.black);
        fit.rotation.z = Math.PI / 2; fit.position.x = 120;
        fit.castShadow = true; c.add(fit);
        // the cup itself: a bellows that squashes as it takes hold.
        // The bell faces the part — built the other way up its narrow
        // tip touched first and it sank into whatever it was picking.
        const cup = new THREE.Mesh(
            new THREE.CylinderGeometry(CUP_R, 12, CUP_H, 22, 1, true),
            MAT.rubber);
        cup.rotation.z = -Math.PI / 2;
        cup.position.x = TOOL - CUP_H / 2;        // sealing face on the tool point
        cup.castShadow = true;
        c.add(cup);
        c.userData.cup = cup;
        g.add(c);
        cups.push(c);
    });
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sy, sz]) => {
        loom([[36, sy * 18, sz * 18], [70, sy * 44, sz * 44],
              [116, sy * CUP_SPAN, sz * CUP_SPAN]], 6, g);
    });
}

// Two parallel faces on a slide, squeezed together by an air cylinder.
// Parallel and not scissor: these stay flat on a box and tangent to a
// drum however wide they are set, where an angular pair pinches at a
// corner and rolls a round part out of the grip.
function buildJaws() {
    const g = toolGroup;
    const body = new THREE.Mesh(roundedBox(76, 96, 132, 16), MAT.black);
    body.position.x = 54; body.castShadow = true; g.add(body);
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 74, 22), MAT.grey);
    cyl.rotation.z = Math.PI / 2; cyl.position.x = 30; cyl.castShadow = true; g.add(cyl);
    // the slide the two carriers run along
    const rail = new THREE.Mesh(roundedBox(20, 22, JAW_OPEN * 2 + 40, 5), MAT.grey);
    rail.position.x = 96; g.add(rail);
    loom([[22, 26, 0], [50, 60, 30], [84, 48, 0]], 7, g);
    // A jaw's origin IS its gripping face, and everything bolted to it
    // sits outboard of that. Built the other way round, the pad ended up
    // 22mm inside whatever the jaws closed on.
    [1, -1].forEach(sgn => {
        const j = new THREE.Group();
        // the rubber pad, its inner face on the origin — this is where
        // the friction that holds the part actually acts
        const pad = new THREE.Mesh(roundedBox(104, 30, PAD_T, 3), MAT.rubber);
        pad.position.set(168, 0, sgn * PAD_T / 2); j.add(pad);
        // the finger reaches down past the tool point, so it closes
        // round the middle of the part rather than the top of it
        const finger = new THREE.Mesh(roundedBox(130, 34, 44, 6), MAT.grey);
        finger.position.set(160, 0, sgn * (PAD_T + 22));
        finger.castShadow = true; j.add(finger);
        const carrier = new THREE.Mesh(roundedBox(34, 56, 52, 8), MAT.black);
        carrier.position.set(100, 0, sgn * (PAD_T + 26));
        carrier.castShadow = true; j.add(carrier);
        g.add(j);
        jaws.push({ g: j, side: sgn });
    });
}

// ---- everything the robot works with ------------------------
function buildCell() {
    // --- the pick table, with a lip so the parts read as located ---
    const t = new THREE.Group();
    const top = new THREE.Mesh(new THREE.BoxGeometry(TABLE.w, 26, TABLE.d), MAT.pale);
    top.position.y = TABLE.top - 13;
    top.castShadow = top.receiveShadow = true; t.add(top);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => {
        const leg = new THREE.Mesh(roundedBox(34, TABLE.top - 26, 34, 6), MAT.alu);
        leg.position.set(sx * (TABLE.w / 2 - 30), (TABLE.top - 26) / 2, sz * (TABLE.d / 2 - 30));
        leg.castShadow = true; t.add(leg);
    });
    // a shallow tray edge, so it looks like parts are presented in it
    [[0, 1], [0, -1], [1, 0], [-1, 0]].forEach(([sx, sz]) => {
        const lw = sx ? 16 : TABLE.w, ld = sz ? 16 : TABLE.d;
        const lip = new THREE.Mesh(roundedBox(lw, 26, ld, 4), MAT.dark);
        lip.position.set(sx * (TABLE.w / 2 - 8), TABLE.top + 13, sz * (TABLE.d / 2 - 8));
        t.add(lip);
    });
    t.position.set(TABLE.x, 0, TABLE.z);
    scene.add(t);

    // --- the conveyor ---
    const len = BELT.z1 - BELT.z0, cz = (BELT.z0 + BELT.z1) / 2;
    const c = new THREE.Group();
    c.position.set(BELT.x, 0, cz);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(BELT.w, 26, len), MAT.rubber);
    slab.position.y = BELT.y - 14;
    slab.castShadow = slab.receiveShadow = true; c.add(slab);
    // the running surface, a texture that is scrolled along
    beltTex = beltTexture();
    beltTex.repeat.set(1, len / 190);
    beltTop = new THREE.Mesh(new THREE.PlaneGeometry(BELT.w, len),
        new THREE.MeshStandardMaterial({ map: beltTex, roughness: 0.86 }));
    beltTop.rotation.x = -Math.PI / 2;
    beltTop.position.y = BELT.y;
    beltTop.receiveShadow = true; c.add(beltTop);
    [-1, 1].forEach(sgn => {
        const rail = new THREE.Mesh(roundedBox(22, 62, len, 5), MAT.steel);
        rail.position.set(sgn * (BELT.w / 2 + 12), BELT.y + 10, 0);
        rail.castShadow = true; c.add(rail);
        const skirt = new THREE.Mesh(roundedBox(14, 90, len - 40, 4), MAT.pale);
        skirt.position.set(sgn * (BELT.w / 2 + 12), BELT.y - 70, 0); c.add(skirt);
    });
    // Four pairs, evenly spaced with a clear gap between them. Seven
    // pairs made a picket fence under the belt and cluttered the cell.
    [-1.5, -0.5, 0.5, 1.5].forEach(k => {
        [-1, 1].forEach(sgn => {
            const leg = new THREE.Mesh(roundedBox(28, BELT.y - 30, 28, 5), MAT.alu);
            leg.position.set(sgn * (BELT.w / 2 - 10), (BELT.y - 30) / 2, k * (len / 4));
            leg.castShadow = true; c.add(leg);
        });
    });
    [-1, 1].forEach(sgn => {                            // the drive rollers
        // wrapped in a group so it can be spun about its own axis
        // without fighting the rotation that stood it on its side
        const rg = new THREE.Group();
        rg.position.set(0, BELT.y - 14, sgn * (len / 2 - 6));
        const rol = new THREE.Mesh(
            new THREE.CylinderGeometry(ROLLER_R, ROLLER_R, BELT.w + 8, 22), MAT.steel);
        rol.rotation.z = Math.PI / 2;
        rol.castShadow = true; rg.add(rol);
        // a painted line, or a smooth roller looks completely still
        const key = new THREE.Mesh(
            new THREE.BoxGeometry(BELT.w + 9, 4, 7), MAT.dark);
        key.position.y = ROLLER_R - 1; rg.add(key);
        c.add(rg); rollers.push(rg);
    });
    scene.add(c);

    // --- the pendant, on a slim stand ---
    // A full control cabinet is a big pale box standing in the cell for
    // no reason a class cares about. All that is wanted is the screen,
    // so it goes on a post and the floor round the robot stays clear.
    const cab = new THREE.Group();
    // A slim light-grey column, the same extrusion the table stands on.
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(86, 104, 18, 28), MAT.alu);
    foot.position.y = 9; foot.castShadow = foot.receiveShadow = true; cab.add(foot);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(17, 21, 982, 20), MAT.alu);
    post.position.y = 509; post.castShadow = true; cab.add(post);
    // The screen pivots on this boss, and the boss is what the column
    // runs into — so the two are joined by construction rather than by
    // happening to be near each other. Mounted further forward, as it
    // was, the screen simply hung in the air off the top of the post.
    const MOUNT_Y = 1000, MOUNT_Z = 14;
    // Behind the screen, not level with it. Centred on the pivot, a
    // 30mm boss reaches ~29mm in front of the bezel's back face and
    // comes straight out through the glass.
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(28, 28, 76, 20), MAT.alu);
    boss.rotation.z = Math.PI / 2;
    boss.position.set(0, MOUNT_Y, -26);
    boss.castShadow = true; cab.add(boss);
    // the screen, tilted up towards whoever is standing at it
    const head = new THREE.Group();
    head.position.set(0, MOUNT_Y, MOUNT_Z);
    head.rotation.x = -0.34;
    const bezel = new THREE.Mesh(roundedBox(400, 333, 24, 14), MAT.case);
    bezel.castShadow = true; head.add(bezel);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(340, 277),
        new THREE.MeshBasicMaterial({ map: cabinetScreen() }));
    glass.position.z = 13; head.add(glass);
    cab.add(head);
    // stood outside the arm's reach, so it is plainly not in the way
    cab.position.set(1080, 0, -1080);
    cab.rotation.y = -0.72;
    scene.add(cab);

    // --- painted floor markings, the way a real cell is bounded ---
    const mk = [[0, 1460, 3060, 70], [0, -1460, 3060, 70],
                [1530, 0, 70, 2990], [-1530, 0, 70, 2990]];
    mk.forEach(([mx, mz, mw, md]) => {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(mw, 3, md), MAT.paint);
        strip.position.set(mx, 1, mz);
        strip.receiveShadow = true;
        scene.add(strip);
    });

    partsGroup = new THREE.Group();
    scene.add(partsGroup);
    buildParts();
}

// ---- the working envelope, and the joint axes ----------------
function buildEnvelope() {
    envGroup = new THREE.Group();
    envGroup.visible = false;
    // The wrist can be anywhere on a sphere about the shoulder, out to
    // the arm laid straight and no closer than it can fold. Because it
    // hangs off J1 it swings round with the arm, which is what makes
    // the far corner of the table plainly out of reach.
    const outer = new THREE.Mesh(
        new THREE.SphereGeometry(L2 + L3, 40, 26),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true,
            opacity: 0.055, side: THREE.DoubleSide, depthWrite: false }));
    const inner = new THREE.Mesh(
        new THREE.SphereGeometry(Math.abs(L2 - L3), 24, 16),
        new THREE.MeshBasicMaterial({ color: 0xf97316, transparent: true,
            opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    const wire = new THREE.Mesh(
        new THREE.SphereGeometry(L2 + L3, 26, 16),
        new THREE.MeshBasicMaterial({ color: 0x0ea5e9, wireframe: true,
            transparent: true, opacity: 0.12, depthWrite: false }));
    [outer, inner, wire].forEach(m => { m.position.set(SH_R, SH_Y, 0); envGroup.add(m); });
    j1G.add(envGroup);

    // and the footprint it sweeps out on the floor
    const pts = [];
    for (let i = 0; i <= 96; i++) {
        const a = i / 96 * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * REACH, 3, Math.sin(a) * REACH));
    }
    const ring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x0ea5e9, transparent: true, opacity: 0.6 }));
    ring.name = 'envRing'; ring.visible = false;
    scene.add(ring);
}

function buildAxes() {
    const AXC = [0xef4444, 0xf97316, 0xeab308, 0x22c55e, 0x06b6d4, 0xa855f7];
    // each joint turns about exactly one line; this draws that line
    const spec = [
        [j1G, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, BASE_H, 0), 460],
        [j2G, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -150), 300],
        [j3G, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -130), 260],
        [j4G, new THREE.Vector3(1, 0, 0), new THREE.Vector3(-40, 0, 0), 220],
        [j5G, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -110), 220],
        [j6G, new THREE.Vector3(1, 0, 0), new THREE.Vector3(-20, 0, 0), 220]
    ];
    // Each arrow has to stay a child of its own joint, or it will not
    // follow the arm. They are kept in a plain list, and shown and
    // hidden one by one — an Object3D can only ever have one parent.
    spec.forEach(([grp, dir, org, len], i) => {
        const a = new THREE.ArrowHelper(dir, org, len, AXC[i], 34, 20);
        a.visible = false;
        grp.add(a);
        axisHelpers.push(a);
    });
    // and a set of axes on the tool itself, which is the frame a robot
    // programmer actually works in
    const tri = new THREE.Group();
    [[new THREE.Vector3(1, 0, 0), 0xef4444],
     [new THREE.Vector3(0, 1, 0), 0x22c55e],
     [new THREE.Vector3(0, 0, 1), 0x3b82f6]].forEach(([d, c]) => {
        tri.add(new THREE.ArrowHelper(d, new THREE.Vector3(), 150, c, 26, 15));
    });
    tri.visible = false;
    tcpNode.add(tri);
    axisHelpers.push(tri);
}

function buildTrail() {
    trailPos = new Float32Array(TRAIL_MAX * 3);
    trailCol = new Float32Array(TRAIL_MAX * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
    g.setDrawRange(0, 0);
    trailLine = new THREE.Line(g, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.95 }));
    trailLine.frustumCulled = false;
    scene.add(trailLine);
}
const _tv = new THREE.Vector3();
function pushTrail() {
    tcpNode.getWorldPosition(_tv);
    if (trailN > 0) {
        const i = (trailN - 1) * 3;
        const d = Math.hypot(trailPos[i] - _tv.x, trailPos[i + 1] - _tv.y, trailPos[i + 2] - _tv.z);
        if (d < 4) return;                       // do not fill it with duplicates
    }
    if (trailN >= TRAIL_MAX) {                   // drop the oldest half, keep going
        const keep = TRAIL_MAX >> 1;
        trailPos.copyWithin(0, keep * 3, TRAIL_MAX * 3);
        trailCol.copyWithin(0, keep * 3, TRAIL_MAX * 3);
        trailN = TRAIL_MAX - keep;
    }
    const i = trailN * 3;
    trailPos[i] = _tv.x; trailPos[i + 1] = _tv.y; trailPos[i + 2] = _tv.z;
    // carrying something is drawn warm, running empty is drawn cool,
    // so the loaded half of the cycle stands out on the path
    const hot = !!state.held;
    trailCol[i] = hot ? 0.96 : 0.16;
    trailCol[i + 1] = hot ? 0.45 : 0.72;
    trailCol[i + 2] = hot ? 0.09 : 0.92;
    trailN++;
    trailLine.geometry.attributes.position.needsUpdate = true;
    trailLine.geometry.attributes.color.needsUpdate = true;
    trailLine.geometry.setDrawRange(0, trailN);
}
function clearTrail() {
    trailN = 0;
    if (trailLine) trailLine.geometry.setDrawRange(0, 0);
}

// =============================================================
//  The parts, and where they are in their journey
// =============================================================
// Six places on the table, laid out in two rows of three. Each part is
// set down at a slightly different angle, so J6 has real work to do:
// it picks them however they lie and sets them all down square.
const SLOTS = [];
for (let row = 0; row < 2; row++)
    for (let col = 0; col < 2; col++)
        SLOTS.push({ x: TABLE.x + (col - 0.5) * 300, z: TABLE.z + (row - 0.5) * 300,
                     // enough of an angle that J6 has real work to do,
                     // not so much that the footprint runs over the lip
                     yaw: (col - 0.5) * 0.40 + (row ? 0.06 : -0.06) });

let parts = [];            // on the table, waiting
let riding = [];           // on the belt, being carried away
// How wide the part really is across the direction the jaws close,
// measured off the finished mesh rather than written down by hand — a
// carton's strap and a drum's rims stand proud of the body, and closing
// to the body's width put the pads a millimetre inside them.
const gripW = {};
function gripWidth() {
    const k = state.part;
    if (gripW[k] !== undefined) return gripW[k];
    const g = partMesh(0);
    const b = new THREE.Box3();
    g.children.forEach(o => {
        if (!o.geometry) return;
        o.geometry.computeBoundingBox();
        const c = o.geometry.boundingBox.clone();
        c.translate(o.position);
        b.union(c);
    });
    g.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
    });
    gripW[k] = b.max.z - b.min.z;
    return gripW[k];
}
const partDef = () => PARTS[state.part];
const partH = () => { const p = partDef(); return p.h; };

function partMesh(seed) {
    const p = partDef();
    const g = new THREE.Group();
    if (p.kind === 'box') {
        // kraft board: matt, barely reflective, and a shade different
        // from the next one along
        const mat = new THREE.MeshStandardMaterial({
            color: KRAFT[seed % KRAFT.length], roughness: 0.88, metalness: 0 });
        const m = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), mat);
        m.position.y = p.h / 2; g.add(m);
        // the strap round it, standing a hair proud as a strap does
        const band = new THREE.Mesh(new THREE.BoxGeometry(p.w + 2, 14, p.d + 2),
            new THREE.MeshStandardMaterial({ color: 0x6f5738, roughness: 0.7 }));
        band.position.y = p.h * 0.42; g.add(band);
        // brown tape down the seam of the lid
        const tape = new THREE.Mesh(new THREE.BoxGeometry(p.w * 0.97, 2, p.d * 0.20),
            new THREE.MeshStandardMaterial({ color: 0x9a7748, roughness: 0.55 }));
        tape.position.y = p.h - 1.5; g.add(tape);
        // and a shipping label on the front
        const label = new THREE.Mesh(new THREE.BoxGeometry(p.w * 0.34, p.h * 0.30, 1.5),
            new THREE.MeshStandardMaterial({ color: 0xf3efe6, roughness: 0.85 }));
        label.position.set(-p.w * 0.22, p.h * 0.66, p.d / 2 + 0.4); g.add(label);
        const bar = new THREE.Mesh(new THREE.BoxGeometry(p.w * 0.24, p.h * 0.07, 1),
            new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.8 }));
        bar.position.set(-p.w * 0.22, p.h * 0.60, p.d / 2 + 0.9); g.add(bar);
    } else if (p.kind === 'cyl') {
        const mat = new THREE.MeshStandardMaterial({
            color: COLOURS[seed % COLOURS.length], roughness: 0.42, metalness: 0.05 });
        const m = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, p.h, 30), mat);
        m.position.y = p.h / 2; g.add(m);
        [0.14, 0.86].forEach(f => {
            const rim = new THREE.Mesh(
                new THREE.CylinderGeometry(p.r + 1.5, p.r + 1.5, 9, 30), MAT.steel);
            rim.position.y = p.h * f; g.add(rim);
        });
    } else {
        // a flat electronic unit: a dark case with a glass face, the
        // sort of thing that comes down a line in a tray
        const shell = new THREE.MeshStandardMaterial({
            color: 0x30353d, roughness: 0.46, metalness: 0.28 });
        const m = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), shell);
        m.position.y = p.h / 2; g.add(m);
        // the glass, flush with the top so the cups still seal on it
        // sunk a little below the case, so the two tops are not the
        // same plane — and matt rather than glossy, which keeps the
        // specular off it at a distance
        const glass = new THREE.Mesh(
            new THREE.BoxGeometry(p.w - 30, 3, p.d - 30),
            new THREE.MeshStandardMaterial({
                color: 0x11151b, roughness: 0.42, metalness: 0.18 }));
        glass.position.y = p.h - 2.3; g.add(glass);
        // a lit indicator in the corner of the face
        const led = new THREE.Mesh(new THREE.BoxGeometry(14, 2, 6),
            new THREE.MeshStandardMaterial({ color: 0x22c55e,
                emissive: 0x16a34a, emissiveIntensity: 0.7, roughness: 0.4 }));
        led.position.set(p.w / 2 - 26, p.h - 1.6, -p.d / 2 + 22); g.add(led);
        // cooling slots and a row of ports down one end
        // short slots spread along the end, not long ones stacked on
        // top of each other — which is what they were
        for (let k = -2; k <= 2; k++) {
            const vent = new THREE.Mesh(new THREE.BoxGeometry(2.5, p.h - 14, 9),
                new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.9 }));
            vent.position.set(-p.w / 2 + 0.6, p.h / 2 - 2, k * 24); g.add(vent);
        }
        [-1, 0, 1].forEach(k => {
            const port = new THREE.Mesh(new THREE.BoxGeometry(3, 9, 16),
                new THREE.MeshStandardMaterial({ color: 0x8b919b, metalness: 0.7, roughness: 0.3 }));
            port.position.set(p.w / 2 - 0.8, p.h * 0.42, k * 26); g.add(port);
        });
    }
    g.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
    return g;
}

function clearParts() {
    if (!partsGroup) return;
    while (partsGroup.children.length) {
        const c = partsGroup.children[0];
        partsGroup.remove(c);
        c.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
    }
    parts = []; riding = [];
}

const stackOf = () => partDef().stack || 1;
// A part resting exactly on the table, or exactly on the one below it,
// puts two faces in the same plane and they flicker against each other.
// A fraction of a millimetre is invisible and settles it for good.
const PART_GAP = 0.4;
const restY = level => TABLE.top + PART_GAP + level * (partH() + PART_GAP);
function buildParts() {
    clearParts();
    const h = partH(), n = stackOf();
    const made = [];
    SLOTS.forEach((s, i) => {
        for (let level = 0; level < n; level++) {
            // each one left at a slightly different angle, so J6 always
            // has something to correct
            const yaw = s.yaw + (level - (n - 1) / 2) * 0.11;
            const g = partMesh(i + level * 2);
            g.position.set(s.x, restY(level), s.z);
            g.rotation.y = yaw;
            partsGroup.add(g);
            made.push({ g, slot: i, level, yaw });
        }
    });
    // taken a layer at a time, off the top down, the way a stack is
    // actually broken down
    made.sort((a, b) => (b.level - a.level) || (a.slot - b.slot));
    made.forEach(p => parts.push(p));
    applyMesh();
}

// =============================================================
//  The cycle
// =============================================================
const GRIP_T = 0.42;             // seconds for the vacuum to pull down or vent
// Which way round a part has to lie to travel well on the belt. The belt
// runs along Z and is 340 wide, so a rectangular part wants its SHORT
// side across it and its long side running with the travel — which is a
// quarter turn from how the parts are drawn, not a half. Turning a
// rectangle 180 degrees puts it back exactly where it started.
const placeYaw = () => partDef().kind === 'cyl' ? 0 : Math.PI / 2;
// Everything travels at one height, well over the tallest part on the
// table and over the robot's own shoulder. Going straight from the
// table to the belt would drag the part through the shoulder casting —
// so the route goes out to the front of the cell and across, which is
// exactly why a real programme is written as a list of via points.
const LIFT_Y = 740;
const VIA1 = { x: 700, y: LIFT_Y, z: 820 };     // out in front, pick side
const VIA2 = { x: -600, y: LIFT_Y, z: 820 };    // across the front, belt side
// How wide a corner is rounded off. A robot does not stop at a via
// point: it cuts the corner and carries its speed through. The two ends
// of a run are different — the approach and the retract stay near
// enough vertical, so a picked part is lifted clear before it turns.
const BLEND = 210, BLEND_END = 60;
let mv = null;                   // the run in progress

// the pick height comes down a whole part every time a layer is cleared
const pickTcp = p => ({ x: SLOTS[p.slot].x,
                        y: restY(p.level) + holdDrop(),
                        z: SLOTS[p.slot].z });
const placeTcp = () => ({ x: DROP.x, y: BELT.y + PART_GAP + holdDrop(), z: DROP.z });
const over = t => ({ x: t.x, y: LIFT_Y, z: t.z });

const wrapAng = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const V3 = p => new THREE.Vector3(p.x, p.y, p.z);

// ---- a rounded path through a list of via points ----------------
// Straight runs, with a quadratic curve tucked into each corner so the
// tool sweeps through it instead of stopping dead on it.
function buildPath(pts) {
    const P = [];
    pts.forEach(p => {
        if (!P.length || V3(P[P.length - 1]).distanceTo(V3(p)) > 1e-6) P.push(p);
    });
    const segs = [];
    let total = 0;
    const push = seg => { seg.at = total; total += seg.len; segs.push(seg); };
    if (P.length < 2) return { segs, total: 0, pts: P };

    const n = P.length;
    const legLen = [];
    for (let i = 0; i < n - 1; i++) legLen.push(V3(P[i]).distanceTo(V3(P[i + 1])));
    const r = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
        const wide = (i === 1 || i === n - 2) ? BLEND_END : BLEND;
        r[i] = Math.min(wide, legLen[i - 1] * 0.45, legLen[i] * 0.45);
    }

    let cur = V3(P[0]);
    for (let i = 0; i < n - 1; i++) {
        const A = V3(P[i]), B = V3(P[i + 1]);
        const dAB = B.clone().sub(A).normalize();
        const last = i === n - 2;
        const stop = last ? B : B.clone().addScaledVector(dAB, -r[i + 1]);
        const L = cur.distanceTo(stop);
        if (L > 1e-6) push({ line: true, a: cur.clone(), b: stop.clone(), len: L });
        if (!last) {
            const C = V3(P[i + 2]);
            const dBC = C.clone().sub(B).normalize();
            const p0 = stop.clone();
            const p2 = B.clone().addScaledVector(dBC, r[i + 1]);
            // arc length of the corner, sampled — near enough for a curve this short
            let len = 0, prev = p0.clone(), q = new THREE.Vector3();
            for (let k = 1; k <= 10; k++) {
                const t = k / 10, u = 1 - t;
                q.set(u * u * p0.x + 2 * u * t * B.x + t * t * p2.x,
                      u * u * p0.y + 2 * u * t * B.y + t * t * p2.y,
                      u * u * p0.z + 2 * u * t * B.z + t * t * p2.z);
                len += prev.distanceTo(q); prev.copy(q);
            }
            if (len > 1e-6) push({ line: false, p0: p0.clone(), p1: B.clone(), p2: p2.clone(), len });
            cur = p2.clone();
        }
    }
    return { segs, total: Math.max(total, 1e-9), pts: P };
}
const _pa = new THREE.Vector3();
function pathAt(path, s) {
    s = clamp(s, 0, path.total);
    let lo = 0, hi = path.segs.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (path.segs[mid].at <= s) lo = mid; else hi = mid - 1;
    }
    const g = path.segs[lo], f = clamp((s - g.at) / g.len, 0, 1);
    if (g.line) return _pa.copy(g.a).lerp(g.b, f);
    const u = 1 - f;
    return _pa.set(u * u * g.p0.x + 2 * u * f * g.p1.x + f * f * g.p2.x,
                   u * u * g.p0.y + 2 * u * f * g.p1.y + f * f * g.p2.y,
                   u * u * g.p0.z + 2 * u * f * g.p1.z + f * f * g.p2.z);
}

// ---- start one continuous run, through all its via points --------
function startRun(pts, yawTo, end) {
    const yawFrom = state.yaw;
    if (state.path === 'ptp') {
        // Every joint runs from angle to angle. It is still one run with
        // one speeding up and one slowing down — but the tool swings out
        // through a curve on the way, which is the whole difference.
        const qs = [state.q.slice()];
        const cum = [0];
        let prev = state.q.slice(), tot = 0;
        for (let i = 1; i < pts.length; i++) {
            const f = i / (pts.length - 1);
            const q = ik(pts[i].x, pts[i].y, pts[i].z,
                         yawFrom + wrapAng(yawTo - yawFrom) * f).q;
            let d = 0;
            for (let k = 0; k < 6; k++) {
                q[k] = prev[k] + wrapAng(q[k] - prev[k]);
                d = Math.max(d, Math.abs(q[k] - prev[k]));
            }
            tot += d; cum.push(tot); qs.push(q.slice()); prev = q;
        }
        mv = { ptp: true, qs, cum, total: Math.max(tot, 1e-9),
               T: moveTime(Math.max(tot, 1e-9), jointV(), jointA()),
               t: 0, yawFrom, yawTo, end };
    } else {
        const path = buildPath(pts);
        mv = { ptp: false, path, total: path.total,
               T: moveTime(path.total, P.speed, P.accel),
               t: 0, yawFrom, yawTo, end };
    }
    state.phaseDur = mv.T;
}

function advanceMove(dt) {
    if (!mv) return false;
    mv.t += dt;
    const done = mv.t >= mv.T;
    const prof = mv.ptp ? moveAt(mv.t, mv.total, jointV(), jointA())
                        : moveAt(mv.t, mv.total, P.speed, P.accel);
    const f = clamp(prof.s / mv.total, 0, 1);
    state.yaw = mv.yawFrom + wrapAng(mv.yawTo - mv.yawFrom) * f;
    if (mv.ptp) {
        const s = prof.s;
        let i = 1;
        while (i < mv.cum.length - 1 && mv.cum[i] < s) i++;
        const span = mv.cum[i] - mv.cum[i - 1];
        const u = span > 1e-9 ? clamp((s - mv.cum[i - 1]) / span, 0, 1) : 1;
        for (let k = 0; k < 6; k++)
            state.q[k] = mv.qs[i - 1][k] + (mv.qs[i][k] - mv.qs[i - 1][k]) * u;
        const p = fk(state.q);
        state.tcpV = dt > 1e-9
            ? Math.hypot(p.x - state.tcp.x, p.y - state.tcp.y, p.z - state.tcp.z) / dt : 0;
        state.tcp = p;
        state.servo = clamp(prof.v / jointV(), 0, 1);
        state.reachFail = false;
    } else {
        const p = pathAt(mv.path, prof.s);
        state.tcp = { x: p.x, y: p.y, z: p.z };
        const sol = ik(p.x, p.y, p.z, state.yaw);
        // take each joint the short way from where it already is, or a
        // path passing behind the robot makes J1 jump a full turn
        for (let i = 0; i < 6; i++)
            sol.q[i] = state.q[i] + wrapAng(sol.q[i] - state.q[i]);
        state.q = sol.q;
        state.reachFail = sol.reachFail;
        state.tcpV = prof.v;
        state.servo = clamp(prof.v / Math.max(150, P.speed), 0, 1);
    }
    if (done) {
        state.tcpV = 0;
        state.servo = 0;
        const end = mv.end;
        mv = null;
        if (end === 'idle') { state.phase = 'idle'; return true; }
        if (end === 'descend') { goToDescend(); return true; }
        state.phase = end; state.phaseT = 0; state.phaseDur = GRIP_T;
        return true;
    }
    return false;
}

// ---- the programme ---------------------------------------------
// Two continuous sweeps a part: round to the table and down onto it,
// then up and round to the belt. The arm only ever stops where it has
// to — on the part to take hold, and on the belt to let go.
// How close a straight run between two points would pass to the base
// column. Sweeping across it is what drags a carried part through the
// shoulder, and it makes J1 spin wildly besides — near the axis a given
// tool speed needs an enormous turn rate.
const BASE_KEEP = 500;
function nearBase(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = dx * dx + dz * dz;
    const t = len > 1e-9 ? clamp(-(a.x * dx + a.z * dz) / len, 0, 1) : 0;
    return Math.hypot(a.x + dx * t, a.z + dz * t);
}
// The two via points are a detour round the front of the cell, and they
// are only worth taking when the direct run would cross the base. Going
// round regardless sent the arm out past the table and back again to
// reach a part it was already standing in front of.
//
// Whichever way it goes, EVERY leg has to clear the base — picking the
// via points off the first leg alone left the last one cutting straight
// across it, which is worse than not detouring at all.
function routeTo(pts, from, to) {
    if (nearBase(from, to) >= BASE_KEEP) return;      // straight there
    const fromRight = from.x >= 0, toRight = to.x >= 0;
    if (fromRight && !toRight) pts.push(VIA1, VIA2);        // table side to belt side
    else if (!fromRight && toRight) pts.push(VIA2, VIA1);   // and back again
    else pts.push(fromRight ? VIA1 : VIA2);                 // same side, just swing wide
}

function goToPick() {
    if (!parts.length) buildParts();
    const pk = pickTcp(parts[0]);
    const here = { x: state.tcp.x, y: state.tcp.y, z: state.tcp.z };
    const pts = [here];
    if (Math.abs(here.y - LIFT_Y) > 5) pts.push({ x: here.x, y: LIFT_Y, z: here.z });
    routeTo(pts, pts[pts.length - 1], over(pk));
    pts.push(over(pk), pk);
    state.cycleStart = state.clock;
    state.phase = 'move';
    startRun(pts, parts[0].yaw, 'grip');
}
function goToPlace() {
    const pl = placeTcp();
    const here = { x: state.tcp.x, y: state.tcp.y, z: state.tcp.z };
    const lifted = { x: here.x, y: LIFT_Y, z: here.z };
    const pts = [here, lifted];
    routeTo(pts, lifted, over(pl));
    pts.push(over(pl));
    state.phase = 'move';
    // carried across still lying the way it was picked up
    startRun(pts, state.yaw, 'descend');
}
// The turn happens on the way down onto the belt, not before it: J6
// brings the part round to lie along the conveyor at the same time as
// the arm sets it there, which is how it looks on a real line.
function goToDescend() {
    state.phase = 'move';
    startRun([{ x: state.tcp.x, y: state.tcp.y, z: state.tcp.z }, placeTcp()],
             placeYaw(), 'release');
}
function beginCycle() { goToPick(); }

function stepCycle(dt) {
    state.clock += dt;
    if (!state.running) return;
    if (mv) { advanceMove(dt); return; }
    if (state.phase === 'grip') {
        state.phaseT += dt;
        state.grip = clamp(1 - state.phaseT / GRIP_T, 0, 1);
        if (state.phaseT >= GRIP_T) {
            state.grip = 0;
            state.held = parts.shift();      // it is ours now
            goToPlace();
        }
    } else if (state.phase === 'release') {
        state.phaseT += dt;
        state.grip = clamp(state.phaseT / GRIP_T, 0, 1);
        if (state.phaseT >= GRIP_T) {
            state.grip = 1;
            // let go onto a belt that never stopped: it takes the
            // belt's speed the instant the vacuum is vented
            const h = state.held;
            h.g.position.set(DROP.x, BELT.y + PART_GAP, DROP.z);
            h.g.rotation.y = placeYaw();
            riding.push({ g: h.g, z: DROP.z });
            state.held = null;
            state.placed++;
            if (state.cycleStart !== undefined) {
                state.cycleT = state.clock - state.cycleStart;
                state.cycle++;
            }
            goToPick();
        }
    }
}

// the parts already on the belt just travel, and are taken off the end
function stepBelt(dt) {
    for (let i = riding.length - 1; i >= 0; i--) {
        const r = riding[i];
        r.z += P.belt * dt;
        r.g.position.z = r.z;
        if (r.z > BELT.z1 - 60) {
            partsGroup.remove(r.g);
            r.g.traverse(o => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
            riding.splice(i, 1);
        }
    }
    if (beltTex) {
        // +V runs down the belt towards -Z, and the pattern travels
        // against increasing offset — so this sign is what sends the
        // surface the same way as the parts standing on it.
        beltTex.offset.y = (beltTex.offset.y + P.belt * dt / 190) % 1;
    }
    // the end rollers are what drive the belt, so they turn with it
    const w = P.belt * dt / ROLLER_R;
    for (const r of rollers) r.rotation.x += w;
}

// =============================================================
//  Showing what each axis does
// =============================================================
// The pick-and-place programme holds the tool pointing straight down
// the whole time, and with the tool down J4 and J6 turn about the same
// line — so the programme leaves J4 at zero and lets J6 do the work.
// That is a real choice a real controller makes, but it means one of
// the six axes never moves. This runs each of them on its own, through
// its own travel, so a class can see exactly what each one is for.
const AXIS_NAME = ['J1 base swing', 'J2 shoulder', 'J3 elbow',
                   'J4 forearm roll', 'J5 wrist bend', 'J6 tool twist'];
// How far each joint may swing from the ready pose, in degrees. These
// are not guesses: each was found by sweeping the joint until the arm
// fouled ITSELF, the floor, or anything else standing in the cell — the
// table especially, which the shoulder drops straight onto if J2 is
// given its full self-clearance of 66 degrees. Then 10-15% held back.
// They are strongly lopsided — the wrist has 119 degrees one way and 20
// the other before the tool meets the forearm, and the shoulder has 77
// up against 32 down before it meets the table — so the sweep is
// lopsided too, rather than being cut to the smaller of each pair.
const DEMO_HI = [149,  64,  54,  157, 119,  157];
const DEMO_LO = [-149, -48, -38, -157, -20, -157];
const DEMO_T = 4.0;                  // seconds a joint takes, out and back
// the fastest any of them turns: the widest sweep, at the steepest part
// of its easing, which for a smoothstep is 1.5x the average
const DEMO_W_MAX = Math.max.apply(null, DEMO_HI.map((h, j) =>
    3 * (h - DEMO_LO[j]) / DEG / DEMO_T));
// out to one end, across to the other, then back to where it started
function demoAngle(u, lo, hi) {
    if (u < 0.25) return hi * ease(u / 0.25);
    if (u < 0.75) return hi + (lo - hi) * ease((u - 0.25) / 0.5);
    return lo * (1 - ease((u - 0.75) / 0.25));
}
let demoHome = null;

function startDemo() {
    state.running = false; state.paused = false;
    mv = null; state.homing = false;
    state.held = null; state.grip = 1;
    state.demo = true; state.demoJ = 0; state.demoT = 0;
    demoHome = ik(HOME.x, HOME.y, HOME.z, 0).q.slice();
    state.q = demoHome.slice();
    state.yaw = 0;
    clearTrail();
    paintRun();
}
function stopDemo() {
    state.demo = false;
    state.demoW = 0;
    if (demoHome) state.q = demoHome.slice();
    state.tcp = fk(state.q);
    state.tcpV = 0;
    paintRun();
}
function stepDemo(dt) {
    state.demoT += dt;
    // The sine is evaluated at u = 1 before the joint hands over, so it
    // lands exactly back on the ready pose. Skipping that frame left a
    // small snap as the next joint took over.
    const u = Math.min(1, state.demoT / DEMO_T);
    const j = state.demoJ;
    const was = state.q[j];
    state.q = demoHome.slice();
    state.q[j] = demoHome[j]
        + demoAngle(u, DEMO_LO[j] / DEG, DEMO_HI[j] / DEG);
    // how fast that joint is actually turning — the motor is what makes
    // the noise, so this is what the sound follows
    state.demoW = dt > 1e-9 ? Math.abs(state.q[j] - was) / dt : 0;
    const p = fk(state.q);
    state.tcpV = dt > 1e-9
        ? Math.hypot(p.x - state.tcp.x, p.y - state.tcp.y, p.z - state.tcp.z) / dt : 0;
    state.tcp = p;
    state.reachFail = false;
    if (state.demoT >= DEMO_T) {
        state.demoT = 0;
        state.demoJ++;
        if (state.demoJ >= 6) stopDemo();
    }
}

function statusText() {
    if (state.demo) return AXIS_NAME[state.demoJ].toUpperCase();
    // the warnings the overlay used to carry now show here, where a
    // class can see them without turning anything on
    if (state.reachFail) return 'OUT OF REACH';
    if (state.held && overload()) return 'OVERLOADED';
    if (state.held && holdFail()) return 'LOSING GRIP';
    if (!state.running && !state.paused) return 'READY';
    if (state.paused) return 'HELD';
    // the descent onto the belt is where the part gets turned
    if (mv && Math.abs(wrapAng(mv.yawTo - mv.yawFrom)) > 0.05) return 'TURNING TO FIT';
    if (state.phase === 'grip') return 'VACUUM ON';
    if (state.phase === 'release') return 'VENTING';
    if (state.held) return 'CARRYING';
    return 'MOVING';
}

// =============================================================
//  Drawing one frame
// =============================================================
const _hv = new THREE.Vector3();
function update3D() {
    if (!gl) return;
    // the six angles, straight onto the six groups — this is the arm
    j1G.rotation.y = state.q[0];
    j2G.rotation.z = state.q[1];
    j3G.rotation.z = state.q[2];
    j4G.rotation.x = state.q[3];
    j5G.rotation.z = state.q[4];
    j6G.rotation.x = state.q[5];

    if (state.tool === 'vac') {
        // the bellows squash down as the cups take hold and spring back
        // when the vacuum is dropped, and their face stays on the part.
        // A bellows gives about a fifth of its height; squashing it
        // further pulled the cup off the fitting above it.
        const squash = 1 - 0.18 * (1 - state.grip);
        for (const c of cups) {
            const cup = c.userData.cup;
            cup.scale.y = squash;
            cup.position.x = TOOL - squash * CUP_H / 2;
        }
    } else {
        // the jaws close from wide open onto the width of this part.
        // A jaw's origin is its gripping face, so this lands the pads on
        // the surface of the part rather than inside it.
        const shut = gripWidth() / 2 + PAD_GAP;
        const half = shut + (JAW_OPEN - shut) * state.grip;
        for (const j of jaws) j.g.position.z = j.side * half;
    }

    // whatever is being carried rides with the tool point
    if (state.held) {
        // the part hangs below the tool point by however far down the
        // tool has taken hold of it
        state.held.g.position.set(state.tcp.x, state.tcp.y - holdDrop(), state.tcp.z);
        state.held.g.rotation.y = state.yaw;
    }

    if (state.trail && (state.running || state.homing)) pushTrail();
    if (state.demo) applyAxes();          // follow the axis being shown
    drawCabinet(false);

    if (camFollow && camT >= 1) {
        // the Tool view rides along with the tool point, and swings
        // round to the far side of the arm as the tool crosses the cell
        _hv.set(state.tcp.x, state.tcp.y, state.tcp.z);
        const side = clamp(state.tcp.x / 320, -1, 1);
        followOff.x += (FOLLOW.x * side - followOff.x) * 0.03;
        controls.target.lerp(_hv, 0.14);
        camera.position.copy(controls.target).add(followOff);
    }

    controls.update();
    renderer.render(scene, camera);
}

// Five places to look from, so the whole cell can be seen without
// anyone having to drag the view around.
// Fitted to the cell rather than guessed: each one is the closest the
// camera can sit and still hold everything it is meant to show, at
// every window shape the page is used at.
const VIEWS = {
    cell:  { pos: [3560, 3101, 3954], tgt: [0, 621, 0] },
    front: { pos: [169, 1740, 4844],  tgt: [0, 621, 0] },
    top:   { pos: [28, 5867, 405],    tgt: [0, 60, 0] },
    arm:   { pos: [1833, 1463, 1511], tgt: [155, 686, 0] },
    tool:  { pos: [1220, 1350, 900],  tgt: [520, 850, 0] }
};
let camFrom = null, camTo = null, camT = 1, camFollow = true;
// Where the Tool view sits relative to the tool point. The arm always
// reaches out from the robot in the middle of the cell, so a camera on
// the same side as the arm ends up looking straight down the forearm at
// the back of the wrist — which is what hid the placing on the belt.
// Swapping sides as the tool crosses the middle keeps the work facing
// the camera at both ends of the cycle.
const FOLLOW = new THREE.Vector3().fromArray(VIEWS.tool.pos)
                .sub(new THREE.Vector3().fromArray(VIEWS.tool.tgt));
const followOff = FOLLOW.clone();
function setView(name) {
    const v = VIEWS[name];
    if (!v || !gl) return;
    camFollow = name === 'tool';
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
    controls.autoRotate = state.spin && camT >= 1 && !camFollow;
}
const ease = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

// Every solid on screen is a mesh of flat triangles pretending to be a
// curve. This shows them, which is worth a minute of any lesson about
// how a 3D model is actually stored.
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
    renderer.setSize(w, h);      // sets the CSS size too, or the view comes out doubled
}
window.addEventListener('resize', resizeView);

// =============================================================
//  Sound
// =============================================================
// The servo noise runs while the arm is actually travelling and stops
// when it does — so a pause, a grip and a release are all silent, which
// is what makes the cycle audible as a rhythm.
const aMove = $('a-move');
let soundOn = false, curVol = 0;
if (aMove) aMove.preservesPitch = aMove.mozPreservesPitch
         = aMove.webkitPreservesPitch = false;

// Switching a loop on and off at the start and end of every move is
// what makes a machine sound dubbed rather than recorded. Instead the
// loop runs the whole time the cell is live, and its loudness and pitch
// follow how fast the tool is ACTUALLY travelling — so the sound rises
// through each acceleration and falls away as the arm brakes, which is
// the same trapezium the motion follows.
function soundUpdate(real) {
    if (!aMove) return;
    const want = state.sound && (state.running || state.homing || state.demo);
    // What is heard is how hard the motors are working, not how fast
    // the tip happens to be going. On a straight move those are the same
    // thing; on a joint move the tool point overruns the tool-speed
    // setting badly, and in the demonstration J6 twists the tool without
    // moving the tool point at all. A servo under load does not fall
    // silent because the tip is still.
    const frac = state.demo
        ? clamp(state.demoW / DEMO_W_MAX, 0, 1)
        : state.servo;
    const target = want ? 0.10 + 0.80 * Math.pow(frac, 0.7) : 0;
    if (want && !soundOn) {
        soundOn = true; curVol = 0;
        try { aMove.volume = 0; aMove.play().catch(() => {}); } catch (e) {}
    }
    if (!soundOn) return;
    // ease towards the target, or every change of direction clicks
    curVol += (target - curVol) * Math.min(1, real * 9);
    try {
        aMove.volume = clamp(curVol, 0, 1);
        const byT = state.fast ? 1.5 : state.slow ? 0.72 : 1;
        aMove.playbackRate = clamp((0.70 + 0.60 * frac) * byT, 0.4, 2.4);
    } catch (e) {}
    if (!want && curVol < 0.012) {
        soundOn = false;
        try { aMove.pause(); } catch (e) {}
    }
}
function soundStop() {
    if (!aMove) return;
    soundOn = false; curVol = 0;
    try { aMove.pause(); aMove.volume = 0; } catch (e) {}
}
// is the arm actually travelling right now, as opposed to gripping?
const armMoving = () => !!mv && (state.running || state.homing);

// =============================================================
//  Panels outside the canvas
// =============================================================
function updateStats() {
    $('stat-placed').textContent = state.placed;
    $('stat-cycle').textContent = state.cycleT > 0 ? state.cycleT.toFixed(1) : '--';
    $('stat-rate').textContent = state.cycleT > 0 ? (60 / state.cycleT).toFixed(0) : '--';
    // The live physics stays on the header now that the overlay has
    // gone: turning effort at the shoulder, and what the tool can hold
    // against what it is being asked to.
    $('stat-torque').textContent = torque().toFixed(0);
    $('stat-torque').className = overload()
        ? 'text-rose-600 font-bold' : 'text-violet-600 font-bold';
    $('stat-hold').textContent = needForce().toFixed(0) + '/' + holdForce().toFixed(0);
    $('stat-hold').className = holdFail()
        ? 'text-rose-600 font-bold' : 'text-slate-700 font-bold';
}

// =============================================================
//  Loop
// =============================================================
const DT = 1 / 240;
let acc = 0, last = performance.now();
function frame(now) {
    const real = Math.min((now - last) / 1000, 0.05); last = now;
    // The cell runs in real time. Fast forward runs it at four times,
    // slow motion at a quarter, so a single joint can be followed.
    const scale = state.fast ? 4 : state.slow ? 0.25 : 1;
    acc += real * scale;
    advanceCamera(real);
    let guard = 0;
    while (acc >= DT && guard++ < 3000) {
        if (state.demo) stepDemo(DT);
        else if (state.running) stepCycle(DT);
        else if (state.homing && mv) { if (advanceMove(DT)) state.homing = false; }
        stepBelt(DT);           // the conveyor never stops for the robot
        acc -= DT;
    }
    soundUpdate(real);
    updateStats();
    update3D();
    requestAnimationFrame(frame);
}

// =============================================================
//  Controls
// =============================================================
function reset(glide) {
    state.running = false; state.paused = false;
    state.placed = 0; state.cycle = 0; state.cycleT = 0;
    state.cycleStart = undefined;
    state.phase = 'idle'; state.phaseT = 0;
    state.grip = 1; state.held = null; state.reachFail = false;
    state.tcpV = 0;
    mv = null; state.homing = false;
    soundStop();
    clearTrail();
    if (gl) {
        buildParts();
        const dx = Math.abs(state.tcp.x - HOME.x) + Math.abs(state.tcp.y - HOME.y)
                 + Math.abs(state.tcp.z - HOME.z);
        if (glide && dx > 1) {
            // snapping the arm across the cell looks like a glitch, so
            // unless it is already there it travels back to the ready pose
            const here = { x: state.tcp.x, y: state.tcp.y, z: state.tcp.z };
            const lifted = { x: here.x, y: Math.max(here.y, LIFT_Y), z: here.z };
            const pts = [here, lifted];
            routeTo(pts, lifted, HOME);
            pts.push(HOME);
            startRun(pts, 0, 'idle');
            state.homing = true;
        } else {
            state.tcp = { x: HOME.x, y: HOME.y, z: HOME.z };
            state.yaw = 0;
            state.q = ik(HOME.x, HOME.y, HOME.z, 0).q;
        }
    }
    paintRun();
}

function bindSlider(id, key, fmt) {
    const el = $(id);
    el.addEventListener('input', () => {
        P[key] = parseFloat(el.value);
        $(id.replace('s-', 'v-')).textContent = fmt(P[key]);
    });
}
bindSlider('s-speed', 'speed', v => v.toFixed(0));
bindSlider('s-accel', 'accel', v => v.toFixed(0));
bindSlider('s-belt', 'belt', v => v.toFixed(0));
bindSlider('s-load', 'load', v => v.toFixed(0));

function paintParts() {
    document.querySelectorAll('.oseg').forEach(b => {
        b.classList.toggle('on', b.dataset.part === state.part);
        // Jaws reach in from the sides, so on a part this thin there is
        // nowhere to put them that is not the table. Rather than drive
        // the fingers through it, the combination is not offered.
        const barred = state.tool === 'jaw' && PARTS[b.dataset.part].jaw === false;
        b.disabled = barred;
        b.classList.toggle('dim', barred);
        b.title = barred
            ? 'Too thin for the jaws to get under — fit the vacuum head for this one'
            : '';
    });
}
document.querySelectorAll('.oseg').forEach(b => b.addEventListener('click', () => {
    if (b.disabled || b.dataset.part === state.part) return;
    state.part = b.dataset.part;
    paintParts();
    reset(true);                 // a different part means a different cycle
}));

function paintTools() {
    document.querySelectorAll('.tseg').forEach(b =>
        b.classList.toggle('on', b.dataset.tool === state.tool));
}
document.querySelectorAll('.tseg').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.tool === state.tool) return;
    state.tool = b.dataset.tool;
    // if the tool that has just been fitted cannot manage the part on
    // the table, fall back to one it can
    if (!toolFits()) state.part = 'box';
    paintTools(); paintParts();
    if (gl) buildTool();     // a different tool is a different tool length
    reset(true);
}));

function paintPaths() {
    document.querySelectorAll('.mseg').forEach(b =>
        b.classList.toggle('on', b.dataset.path === state.path));
}
document.querySelectorAll('.mseg').forEach(b => b.addEventListener('click', () => {
    state.path = b.dataset.path;
    paintPaths();
    clearTrail();                // the old path is not this path
}));

function paintRun() {
    const b = $('btn-run');
    const on = ['bg-slate-900', 'text-white', 'border-slate-900'];
    const off = ['bg-white', 'text-slate-900', 'border-slate-200', 'hover:bg-slate-50'];
    on.forEach(c => b.classList.toggle(c, !state.running));
    off.forEach(c => b.classList.toggle(c, state.running));
    $('run-label').textContent = state.running ? 'Hold'
        : state.paused ? 'Carry On' : 'Start Cycle';
    const d = $('demo-label');
    if (d) d.textContent = state.demo ? 'Stop' : 'Show Axes';
}
$('btn-run').addEventListener('click', () => {
    if (state.demo) stopDemo();          // one or the other, not both
    if (state.running) { state.running = false; state.paused = true; }
    else if (state.paused) { state.running = true; state.paused = false; }
    else {
        state.homing = false; mv = null;
        state.running = true; state.paused = false;
        state.clock = 0;
        beginCycle();
    }
    paintRun();
});
$('btn-demo').addEventListener('click', () => {
    if (state.demo) stopDemo(); else startDemo();
});
$('btn-reset').addEventListener('click', () => {
    state.demo = false;
    Object.assign(P, DEFAULTS);
    ['speed', 'accel', 'belt', 'load'].forEach(k => {
        $('s-' + k).value = DEFAULTS[k];
        $('v-' + k).textContent = DEFAULTS[k];
    });
    reset(true);
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
function setChip(key, on) {
    state[key] = on;
    $('chk-' + key).checked = on;
    paintChip($('chip-' + key), on);
}
bindChip('chk-fast', 'chip-fast', 'fast', on => { if (on) setChip('slow', false); });
bindChip('chk-slow', 'chip-slow', 'slow', on => { if (on) setChip('fast', false); });
bindChip('chk-sound', 'chip-sound', 'sound', on => { if (!on) soundStop(); });
bindChip('chk-axes', 'chip-axes', 'axes', () => applyAxes());
bindChip('chk-env', 'chip-env', 'env', () => applyEnv());
bindChip('chk-trail', 'chip-trail', 'trail', on => { if (!on) clearTrail(); });
bindChip('chk-mesh', 'chip-mesh', 'mesh', () => applyMesh());
bindChip('chk-spin', 'chip-spin', 'spin');

function applyAxes() {
    if (!gl) return;
    axisHelpers.forEach((a, i) => {
        a.visible = state.axes || (state.demo && i === state.demoJ);
    });
}
function applyEnv() {
    if (!gl) return;
    envGroup.visible = state.env;
    const ring = scene.getObjectByName('envRing');
    if (ring) ring.visible = state.env;
}

function paintViews(name) {
    document.querySelectorAll('.vseg').forEach(b =>
        b.classList.toggle('on', b.dataset.view === name));
}
document.querySelectorAll('.vseg').forEach(b => b.addEventListener('click', () => {
    setView(b.dataset.view);
    paintViews(b.dataset.view);
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
setTimeout(hideLoader, 8000);        // never trap the page behind the veil

window.onload = function () {
    try {
        init3D();
        gl = true;
        // dragging the view by hand means none of the presets is the
        // current one. This has to be hooked up after the scene starts.
        controls.addEventListener('start', () => { paintViews(null); camFollow = false; });
    } catch (e) {
        // No WebGL: lose the cell, keep the lesson.
        console.warn('3D unavailable:', e);
        const n = $('nogl');
        n.classList.remove('hidden'); n.classList.add('flex');
    }
    reset();
    paintParts(); paintPaths(); paintTools(); paintRun();
    applyAxes(); applyEnv(); applyMesh();
    paintViewMode();
    resizeView();
    requestAnimationFrame(hideLoader);
    setTimeout(hideLoader, 400);
    requestAnimationFrame(frame);
};


// =============================================================
//  Show and hide the control panel
// =============================================================
// The panel floats over the view, so this uncovers the model rather than
// resizing anything - the canvas is always the full size of the window
// under the header, and nothing here has to tell the renderer otherwise.
//
// The one rule is that the way back has to stay on screen: the button
// sits over the view rather than in the panel it hides, or turning this
// on would be a one-way door.
(function () {
    const btn = document.getElementById('btn-wide');
    if (!btn) return;

    function paintControls() {
        const off = document.body.classList.contains('controls-off');
        btn.innerHTML = off ? '<i class="fa-solid fa-sliders"></i>'
                            : '<i class="fa-solid fa-chevron-down"></i>';
        btn.title = off ? 'Show the controls' : 'Hide the controls (Esc)';
        btn.setAttribute('aria-label', btn.title);
    }
    function setControls(off) {
        document.body.classList.toggle('controls-off', off);
        paintControls();
    }
    btn.addEventListener('click',
        () => setControls(!document.body.classList.contains('controls-off')));

    // Escape backs out of the panel - but only once the explainer is out
    // of the way, since this page already uses Escape to close that and
    // one key should not do two things at once.
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        const modal = document.getElementById('info-modal');
        if (modal && !modal.classList.contains('hidden')) return;
        if (!document.body.classList.contains('controls-off')) setControls(true);
    });
})();
