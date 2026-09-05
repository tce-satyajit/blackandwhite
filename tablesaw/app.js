// =============================================================
//  Table Saw
// =============================================================
// The lathe next door turns on the diameter changing under the tool. A
// table saw is the opposite case and that is exactly why it is worth
// having both: the blade is one fixed diameter at one fixed speed, so
// the rim speed never moves. Nothing you do to the saw changes it.
//
// What you do change is how fast the wood goes past — and the number
// that matters is not the feed rate itself but the feed SHARED OUT
// BETWEEN THE TEETH. Chip load: how much timber each tooth is asked to
// take on its way through. Too little and the teeth stop cutting and
// start rubbing, and rubbing wood at fifty metres a second sets fire to
// it. Too much and the tooth cannot clear the chip, so the edge tears
// instead of slicing and the motor bogs down.
//
// The feed is one of three things that set it. The others are the
// spindle speed, which is fixed, and the TOOTH COUNT, which is why the
// blade you fit matters as much as the hand pushing the wood.
//
// Millimetres, revs per minute, newtons and watts throughout.

const MOTOR_W = 1800;                 // a cabinet saw's induction motor
const DRIVE_EFF = 0.92;               // what survives one V-belt
const MOTOR_RPM = 1725;               // four-pole, and the smoother for it
// The belt gears the motor UP, and by a factor of two: the pulley on the
// motor has twice the teeth of the one on the arbor. A saw wants speed at
// the rim where a lathe wants torque at the chuck, and the drive is
// arranged accordingly - 1725 rpm in, 3450 out, 55 m/s at the teeth.
const BELT_PITCH = 9.5;               // mm from one tooth to the next
const MOT_TEETH = 40, ARB_TEETH = 20;
const MOT_PULLEY = MOT_TEETH * BELT_PITCH / Math.PI;   // pitch diameters
const ARB_PULLEY = ARB_TEETH * BELT_PITCH / Math.PI;
const BELT_RATIO = MOT_TEETH / ARB_TEETH;

const BLADE_R = 152;                  // a 305 mm / 12 inch blade
const KERF = 3.2;                     // how wide a slot the teeth cut
const PLATE_T = 2.2;                  // and how thick the plate behind them
const MAX_LIFT = 98;                  // full projection above the table

// The three blades in the drawer, and they are not interchangeable.
// A rip blade has few, big teeth with deep gullets to carry a long
// stringy chip; a crosscut blade has many small ones so no single tooth
// takes enough to lift a splinter. The combination blade is the
// compromise you leave on the arbor between jobs.
const BLADES = [
    { z: 24, name: '24T rip',   hook: 20, tear: 1.00, note: 'Rip' },
    { z: 40, name: '40T combi', hook: 15, tear: 0.62, note: 'Combi' },
    { z: 80, name: '80T cross', hook: 5,  tear: 0.28, note: 'Cross' }
];

// Specific cutting force, in newtons per square millimetre of chip.
// Wood is nothing like metal here: the number is an order of magnitude
// smaller, which is why a saw can take a chip a hundred times the size
// of anything a lathe would attempt.
//
// `burn` is how readily the timber scorches when the teeth stop cutting
// and start rubbing — resinous softwood and dense close-grained
// hardwood both mark badly, for opposite reasons. `tear` is how much
// the top face splinters when a tooth takes too much.
const MATS = {
    pine: { name: 'Pine',     kc: 22, burn: 1.15, tear: 0.55, dust: 0.7,
            hex: 0xf2dca6, grain: 0xd2ab6c, dark: 0x8a6c46, rough: 0.80 },
    oak:  { name: 'Oak',      kc: 60, burn: 0.95, tear: 0.75, dust: 0.9,
            hex: 0xc99a5e, grain: 0x9a6f3c, dark: 0x6b4a26, rough: 0.74 },
    mdf:  { name: 'MDF',      kc: 38, burn: 1.30, tear: 0.15, dust: 1.6,
            hex: 0xbe9068, grain: 0xb28a63, dark: 0x6e5138, rough: 0.88 },
    // Plywood is deliberately the cooler, greyer, flatter of the two pale
    // boards. Sat next to pine at nearly the same warm cream, the two were
    // impossible to tell apart - and telling them apart is the point, since
    // one tears three times as readily as the other.
    ply:  { name: 'Plywood',  kc: 45, burn: 0.85, tear: 1.35, dust: 1.0,
            hex: 0xc9b088, grain: 0x9d8154, dark: 0x6f5836, rough: 0.72 }
};

// The chip load bands, in millimetres of timber per tooth. Below the
// first the teeth are rubbing; above the second they are taking more
// than the gullet can carry away.
const FZ_RUB = 0.012, FZ_TEAR = 0.055;

const DEFAULTS = { feed: 55, lift: 52, tilt: 0, thick: 19, rip: 120 };
const P = Object.assign({}, DEFAULTS);

const state = {
    // Pine, a 40-tooth blade and a middling feed is a cut that works:
    // 0.021 mm a tooth, well inside both bands. Somewhere to start.
    mat: 'pine', blade: 1, op: 'rip',
    power: false,                     // the paddle switch
    running: false, done: false,
    spin: 0,                          // arbor angle, radians (true)
    spinShown: 0,                     // and the angle actually drawn
    rpm: 0,                           // what the arbor is really doing
    stalled: false,
    fed: 0,                           // how far the board has been pushed, mm
    cutting: false,
    cutIdle: 9,                       // seconds since the teeth last bit
    kickRisk: 0,                      // 0..1, how close this is to throwing it
    elapsed: 0,
    setupT: 1,                        // 0..1 while a fresh board is laid on
    pendingSetup: false,              // a board change waiting on the blade
    startT: 0,                        // 0..1 while the motor runs up - it starts stopped
    // what the two adjustment wheels have been wound to, drawn eased so
    // the blade rises and tilts instead of jumping
    liftShown: DEFAULTS.lift, tiltShown: DEFAULTS.tilt,
    ripShown: DEFAULTS.rip,
    paused: false,
    dust: true, sound: true,
    mesh: false, turntable: false, parts: false,
    cabinet: true,                    // and the sheet steel over the works
    viewMode: 'blueprint'
};

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ---- the chain of consequences ----------------------------------
const M = () => MATS[state.mat];
const B = () => BLADES[state.blade];
const teeth = () => B().z;

// What the arbor would do with nothing against it. Fixed, and that is
// the point: there is no gearbox on a saw.
const freeRpm = () => MOTOR_RPM * BELT_RATIO;
const omega = () => 2 * Math.PI * state.rpm / 60;

// The one speed that never changes. 254 mm at just over 4000 rpm is
// about 53 m/s at the rim, which is where every wood-cutting machine
// ends up because it is where a carbide edge lasts.
const rimSpeed = () => Math.PI * 2 * BLADE_R * state.rpm / 60 / 1000;   // m/s

// How far the blade actually stands above the table. Tilting it costs
// depth of cut, and it costs it for a reason you can see: the trunnion
// swings about a point on the table line, so the highest tooth is
// carried round an arc of radius equal to the projection itself and
// what is left standing above the table is the cosine of it.
//
// That is not a fudge - it is why every saw plate quotes two depths.
// 79 mm at 90 degrees comes out at 79 cos 45 = 56 mm at full bevel,
// which is the 2-3/16 inch a real 10 inch saw is sold as cutting.
const tiltRad = () => state.tiltShown * Math.PI / 180;
const projection = () => Math.max(0, state.liftShown * Math.cos(tiltRad()));
const bevelCost = () => state.liftShown * (1 - Math.cos(tiltRad()));

// How deep the blade is buried in the timber: the projection, or the
// thickness of the board, whichever runs out first.
const cutDepth = () => Math.min(projection(), P.thick);
const throughCut = () => projection() >= P.thick - 0.01;

// ---- teeth in the cut -------------------------------------------
// A tooth only cuts while it is inside the wood, and on a saw that is a
// short arc near the front of the blade. Measure the angle from top
// dead centre: the blade breaks the table where its own circle crosses
// the table line, and leaves the timber at the top face of the board.
// The teeth between those two angles are the ones doing the work, and
// the number of them is what the cutting force gets multiplied by.
function engagedArc() {
    const h = projection();
    if (h <= 0) return 0;
    const c = BLADE_R - h;                       // arbor centre below the table
    const a0 = Math.acos(clamp(c / BLADE_R, -1, 1));           // at table level
    const top = c + Math.min(P.thick, h);
    const a1 = top >= BLADE_R ? 0 : Math.acos(clamp(top / BLADE_R, -1, 1));
    return Math.max(0, a0 - a1);
}
// Never less than one: there is always a tooth in the cut, or the blade
// would not be cutting at all.
const teethIn = () => Math.max(1, teeth() * engagedArc() / (2 * Math.PI));

// ---- chip load, and everything that follows from it ---------------
// THE number. Feed in millimetres a second, shared out over every tooth
// that comes round in that second.
const chipLoad = () => {
    const perSec = state.rpm / 60 * teeth();
    return perSec > 0.01 ? P.feed / perSec : 0;
};
const rubbing = () => state.rpm > 100 && chipLoad() < FZ_RUB;
const tearing = () => chipLoad() > FZ_TEAR;

// The chip one tooth takes: its load by the width of the slot it is
// cutting. The kerf is wider than the plate, which is the whole reason
// a saw does not bind in its own cut.
const chipArea = () => chipLoad() * KERF;                 // mm²
const toothForce = () => M().kc * chipArea();             // N
const cutForce = () => toothForce() * teethIn();          // N, all of them
const cutTorque = () => cutForce() * BLADE_R / 1000;      // N·m
const cutPower = () => cutForce() * rimSpeed();           // W

const availPower = () => MOTOR_W * DRIVE_EFF;
const overloaded = () => cutPower() > availPower();
const loadFrac = () => clamp(cutPower() / availPower(), 0, 2);

// Timber removed per second: the kerf, by how deep the blade is in, by
// how fast it is going past.
const mrr = () => KERF * cutDepth() * P.feed;             // mm³/s

// How long the cut takes, and how far the board has to travel to make it.
// LEAD_IN is where the board waits before the teeth reach it, so a pass
// always begins with the timber clear of the blade.
const LEAD_IN = 40;
const boardLen = () => state.op === 'rip' ? 520 : 260;
const passLength = () => LEAD_IN + boardLen() + 2 * halfChord() + 20;
const passTime = () => passLength() / Math.max(1, P.feed);

// Half the slot the blade opens in the table top, measured along the
// feed. Everything about where the cut starts and stops comes off this.
function halfChord() {
    const h = projection();
    if (h <= 0) return 0;
    return Math.sqrt(Math.max(0, 2 * BLADE_R * h - h * h));
}

// ---- kickback ----------------------------------------------------
// The one that hurts. A board pinches shut behind the blade, the teeth
// coming up at the back get hold of it, and it leaves at rim speed. The
// riving knife is the answer and it is not optional: it holds the kerf
// open behind the blade so the two halves cannot close on it.
//
// This is a risk reading rather than a simulation of the board flying,
// because a lesson that ends with the workpiece leaving the screen
// teaches nothing that the warning has not already said.
function kickback() {
    if (!state.cutting) return 0;
    let r = 0;
    if (state.op === 'rip' && P.rip < 45) r += 0.2;   // hand near the blade
    if (tearing()) r += 0.25 * clamp((chipLoad() - FZ_TEAR) / FZ_TEAR, 0, 1);
    if (overloaded()) r += 0.3;
    return clamp(r, 0, 1);
}

// =============================================================
//  The board, and the slot the blade opens in it
// =============================================================
// The board is sampled along its length the way the lathe samples its
// bar along the axis. Two records per station: how badly the cut face
// was scorched there, and how badly it tore. Both are consequences of
// the chip load AT THE MOMENT THE BLADE PASSED THAT POINT, which is
// what makes them worth recording — change the feed halfway down a
// board and you can see exactly where you changed it.
const NSEG = 160;
let burn = [], tear = [];
let boardTex = null, boardCan = null;
function freshBoard() {
    burn = new Array(NSEG + 1).fill(0);
    tear = new Array(NSEG + 1).fill(0);
    paintBoard();
}
const segAt = s => clamp(Math.round(s / boardLen() * NSEG), 0, NSEG);

// The cut faces, drawn as a strip. Scorch is laid down as a brown
// stain that darkens where the blade dwelt; tearout as a ragged notched
// edge along the top corner, which is exactly where it happens.
function paintBoard() {
    if (!boardCan) {
        boardCan = document.createElement('canvas');
        boardCan.width = 1024; boardCan.height = 128;
    }
    const g = boardCan.getContext('2d'), W = boardCan.width, H = boardCan.height;
    const m = M();
    const hex = n => '#' + n.toString(16).padStart(6, '0');
    g.fillStyle = hex(m.hex); g.fillRect(0, 0, W, H);
    // the sawn face is always a little lighter than the sawn-off face:
    // it is fresh timber, and it has not seen daylight before
    g.globalAlpha = 0.18; g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
    // the marks the teeth leave going round — every saw leaves them
    g.strokeStyle = 'rgba(0,0,0,0.06)'; g.lineWidth = 1;
    for (let i = 0; i < 60; i++) {
        const x = i / 60 * W;
        g.beginPath(); g.moveTo(x, 0); g.quadraticCurveTo(x + 9, H / 2, x, H); g.stroke();
    }
    for (let i = 0; i <= NSEG; i++) {
        const x = i / NSEG * W, w = W / NSEG + 1;
        if (burn[i] > 0.01) {
            g.fillStyle = hex(m.dark);
            g.globalAlpha = clamp(burn[i], 0, 1) * 0.85;
            g.fillRect(x, 0, w, H);
            // scorch is worst where the blade is deepest in the cut
            g.globalAlpha = clamp(burn[i] - 0.4, 0, 1) * 0.8;
            g.fillStyle = '#1b1206';
            g.fillRect(x, H * 0.18, w, H * 0.64);
            g.globalAlpha = 1;
        }
        if (tear[i] > 0.01) {
            // splinters lifted off the top arris, not the middle of the face
            g.fillStyle = hex(m.grain);
            const n = Math.ceil(tear[i] * 5);
            for (let k = 0; k < n; k++) {
                const d = tear[i] * H * 0.34 * (0.4 + Math.random() * 0.6);
                g.fillRect(x, 0, w, d);
            }
        }
    }
    if (boardTex) boardTex.needsUpdate = true;
}

// =============================================================
//  The machine, in three dimensions
// =============================================================
// The feed runs along +x, front of the machine to back. The blade
// stands in the plane z = 0 and turns about z, so it is edge-on to the
// timber coming at it. The fence and both rails run parallel to the
// blade, out at +z; the tilt takes the top of the blade over toward -z,
// which is the way nearly every saw of this kind is built.
const TABLE_Y = 860;                  // the working height, off the floor
// The top runs well forward of the cabinet. That overhang is the infeed:
// it is where the board is supported while you line it up, and without
// it the timber hangs in mid air over the height wheel.
const TABLE_X0 = -620, TABLE_X1 = 500; // the cast top, front to back
const TABLE_Z0 = -330, TABLE_Z1 = 430; // and left to right
const TABLE_T = 18;                   // the ground web
const TABLE_RIM = 40;                 // and the rim cast round it
const midXConst = (TABLE_X0 + TABLE_X1) / 2;
const SLOT_W = 9;                     // the throat the blade comes up through
const PLATE_L = 340, PLATE_W = 86;    // the throat plate around it
const MITER_Z = -170;                 // the miter slot, left of the blade
const MITER_W = 19, MITER_D = 9.5;
const CAB_Y0 = 168, CAB_H = TABLE_Y - TABLE_T - CAB_Y0;
// The cabinet has to be wide enough to swallow the motor THROUGH ITS
// WHOLE SWING, not just where it sits at 90 degrees. The motor hangs off
// the trunnion, so tilting carries it sideways on an arc, and a box
// sized for the upright position has the motor coming out through the
// side of it at 45.
const CAB_X = 700, CAB_Z = 730, CAB_CZ = 35;
const RAIL_X = TABLE_X0 - 46;         // the front rail the fence rides
const RAIL_X2 = TABLE_X1 + 30;        // and the one at the back
const RAIL_Y = TABLE_Y - 44;
// Where the motor hangs, measured from the tilt pivot. Kept as close in
// as the belt allows, because everything below the pivot swings by its
// own distance from it times the sine of the tilt.
const MOTOR_X = 150, MOTOR_Y = -170, MOTOR_Z = 10;
const BELT_Z = 150;                   // the plane both pulleys run in

let scene, camera, renderer, controls;
let floor3, grid3;
let tiltGrp = null;                   // everything that goes over when it tilts
let arborGrp = null, bladeGrp = null; // and everything that turns
let bladeMesh = null, bladeTeeth = [];
let motorGrp = null, moPulley = null, arbPulley = null;
let beltTeethM = [], beltPath = null, beltLen = 0, beltPitchR = 1;
let beltMidX = 0, beltMidY = 0;
let liftWheel = null, tiltWheel = null;
// The linkage between each wheel and the thing it moves. Drawn, and
// turned, because a wheel that spins while nothing between it and the
// blade moves is worse than no wheel at all.
let trunFixed = null;
let liftShaft = null, liftBevelA = null, liftBevelB = null;
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _qs = new THREE.Quaternion();
let liftScrew = null, liftNut = null, liftArm = null, liftPost = null;
let tiltShaft = null, tiltWorm = null;
let fenceGrp = null, miterGrp = null, guardGrp = null, knifeMesh = null;
let cabSkins = [], throatPlate = null;
let boardGrp = null, boardWhole = null, boardLeft = null, boardRight = null;
let voltNeedle = null, ampNeedle = null;
let shownVolts = 238, shownAmps = 0;
let dustGrp = null, dust = [];
let lampMesh = null;
let gl = false;
const MAT = {};

// ---- shapes ------------------------------------------------------
function roundedBox(w, h, d, r) {
    const bev = Math.min(1.5, w / 6, h / 6, d / 6);
    const sh = new THREE.Shape();
    const W = w / 2 - bev, H = h / 2 - bev, rr = Math.max(0.1, Math.min(r, W, H));
    sh.moveTo(-W + rr, -H);
    sh.lineTo(W - rr, -H); sh.quadraticCurveTo(W, -H, W, -H + rr);
    sh.lineTo(W, H - rr);  sh.quadraticCurveTo(W, H, W - rr, H);
    sh.lineTo(-W + rr, H); sh.quadraticCurveTo(-W, H, -W, H - rr);
    sh.lineTo(-W, -H + rr); sh.quadraticCurveTo(-W, -H, -W + rr, -H);
    return new THREE.ExtrudeGeometry(sh, {
        depth: d - bev * 2, bevelEnabled: true, bevelThickness: bev,
        bevelSize: bev, bevelSegments: 2, curveSegments: 6
    }).translate(0, 0, -(d - bev * 2) / 2);
}

// The grain. Not decoration: it is the only thing that says which way
// a rip cut runs and which way a crosscut does, and the two operations
// are named after exactly that.
function woodTexture(key, along) {
    const m = MATS[key];
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const g = c.getContext('2d');
    const hex = n => '#' + n.toString(16).padStart(6, '0');
    g.fillStyle = hex(m.hex); g.fillRect(0, 0, 512, 512);
    if (key === 'mdf') {
        // MDF has no grain at all, which is the whole point of it: it is
        // sawdust and glue, the same in every direction.
        for (let i = 0; i < 9000; i++) {
            g.fillStyle = 'rgba(120,90,60,' + (Math.random() * 0.16) + ')';
            g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
        }
    } else if (key === 'ply') {
        // Plywood has to read as a SHEET, not a plank. Rotary-cut face
        // veneer: fine, dead-straight grain with no figure in it at all,
        // and a band of core plies along the edge. That banding is the
        // thing that says "plywood" at a glance - and it is also literally
        // why it splinters, since each ply runs across the one under it.
        for (let i = 0; i < 110; i++) {
            g.strokeStyle = 'rgba(116,92,58,' + (0.05 + Math.random() * 0.13) + ')';
            g.lineWidth = 0.6 + Math.random() * 1.8;
            const y = Math.random() * 512;
            g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke();
        }
        for (let k = 0; k < 5; k++) {           // the core, banded along the edge
            g.fillStyle = k % 2 ? 'rgba(112,88,54,0.34)' : 'rgba(206,182,142,0.38)';
            g.fillRect(0, 468 + k * 9, 512, 9);
        }
        for (let i = 0; i < 7; i++) {           // and the voids a cheap core has
            g.fillStyle = 'rgba(84,66,42,0.34)';
            g.fillRect(Math.random() * 512, 470 + Math.random() * 36,
                       10 + Math.random() * 26, 5);
        }
    } else {
        for (let i = 0; i < 34; i++) {
            g.strokeStyle = 'rgba(' + (key === 'oak' ? '110,74,34,' : '178,136,80,')
                          + (0.12 + Math.random() * 0.26) + ')';
            g.lineWidth = 1 + Math.random() * (key === 'oak' ? 5 : 9);
            const y = Math.random() * 512;
            g.beginPath(); g.moveTo(0, y);
            g.bezierCurveTo(140, y + (Math.random() - 0.5) * 34,
                            330, y + (Math.random() - 0.5) * 34, 512, y);
            g.stroke();
        }
        if (key === 'oak') {                    // the flecks oak is known by
            for (let i = 0; i < 200; i++) {
                g.fillStyle = 'rgba(96,64,30,0.16)';
                g.fillRect(Math.random() * 512, Math.random() * 512,
                           1 + Math.random() * 7, 1);
            }
        } else {
            // and the knots pine is known by. Nothing else in the rack has
            // them, so they are what tells the two pale boards apart.
            for (let i = 0; i < 3; i++) {
                const kx = 60 + Math.random() * 392, ky = 60 + Math.random() * 392;
                const kr = 12 + Math.random() * 16;
                for (let r = kr; r > 2; r -= 3.5) {
                    g.strokeStyle = 'rgba(122,86,44,0.30)';
                    g.lineWidth = 2;
                    g.beginPath();
                    g.ellipse(kx, ky, r, r * 0.62, 0.5, 0, 7); g.stroke();
                }
                g.fillStyle = 'rgba(96,64,30,0.55)';
                g.beginPath(); g.ellipse(kx, ky, 5, 3.4, 0.5, 0, 7); g.fill();
            }
        }
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (along) t.repeat.set(3, 1);
    return t;
}

// The maker's name, cast into the table the way it is on a real top:
// raised letters in the iron, not a printed label. It is drawn light on
// transparent so it sits on the cast surface rather than as a panel
// stuck to it.
function brandTexture() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 256;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 1024, 256);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    // a shadow under the letters and a highlight above, which is what
    // makes raised lettering read as raised
    g.font = 'bold 100px Inter, system-ui, sans-serif';
    g.fillStyle = 'rgba(0,0,0,0.34)';
    g.fillText('TCE-LAB', 512 + 4, 100 + 5);
    g.fillStyle = 'rgba(255,255,255,0.30)';
    g.fillText('TCE-LAB', 512 - 2, 100 - 3);
    g.fillStyle = 'rgba(226,232,240,0.44)';
    g.fillText('TCE-LAB', 512, 100);
    g.font = 'bold 84px Inter, system-ui, sans-serif';
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.fillText('305 mm  ·  3450 rpm', 512 + 2, 196 + 3);
    g.fillStyle = 'rgba(226,232,240,0.36)';
    g.fillText('305 mm  ·  3450 rpm', 512, 196);
    return new THREE.CanvasTexture(c);
}

// The badge on the cabinet. Etched into acrylic rather than printed on
// it: the letters are frosted, so they catch the light and the panel
// stays see-through behind them. Drawn light on transparent for the same
// reason the table lettering is - a solid plate stuck to a glazed panel
// would block the very thing the panel is glazed for.
function badgeTexture() {
    const c = document.createElement('canvas');
    c.width = 768; c.height = 256;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 768, 256);
    // the etched outline
    g.strokeStyle = 'rgba(255,255,255,0.34)';
    g.lineWidth = 5;
    g.strokeRect(16, 16, 736, 224);
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 2;
    g.strokeRect(30, 30, 708, 196);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 96px Inter, system-ui, sans-serif';
    g.fillStyle = 'rgba(20,28,40,0.30)';
    g.fillText('TCE LAB', 384 + 3, 104 + 4);
    g.fillStyle = 'rgb(251, 249, 249)';
    g.fillText('TCE LAB', 384, 102);
    g.font = 'bold 34px Inter, system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.40)';
    g.fillText('TABLE SAW  ·  305 mm  ·  1.8 kW', 384, 180);
    return new THREE.CanvasTexture(c);
}

// The plate riveted to the rail, telling you how far the fence is off
// the blade. Every fence carries one; without it the rip width is a
// guess.
//
// The canvas is sized FROM the plate it will be painted on. Drawn at a
// fixed 1024x64 it was a 16:1 image stretched across a 48:1 plate, and
// every figure on it came out squashed to a third of its height. A
// texture only reads right when its own aspect matches the surface.
function scaleTexture(planeW, planeH, mmMax) {
    const PX = 2600;
    const c = document.createElement('canvas');
    c.width = PX;
    c.height = Math.max(8, Math.round(PX * planeH / planeW));
    const g = c.getContext('2d'), H = c.height;
    g.fillStyle = '#e8e4d8'; g.fillRect(0, 0, PX, H);
    // a margin at each end, so the zero mark is not on the very edge
    const PAD = PX * 0.02, span = PX - PAD * 2;
    g.strokeStyle = '#22262c'; g.fillStyle = '#22262c';
    g.font = 'bold ' + Math.round(H * 0.40) + 'px Inter, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let mm = 0; mm <= mmMax; mm += 10) {
        const x = PAD + mm / mmMax * span;
        const big = mm % 50 === 0;
        g.lineWidth = big ? H * 0.05 : H * 0.025;
        g.beginPath();
        g.moveTo(x, 0); g.lineTo(x, big ? H * 0.42 : H * 0.26); g.stroke();
        if (big) g.fillText(String(mm), x, H * 0.46);
    }
    return new THREE.CanvasTexture(c);
}

// The rating plate on the motor. A real one carries exactly this and
// people read it to work out what the machine will and will not do.
function platePlateTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#b8bcc2'; g.fillRect(0, 0, 512, 256);
    g.strokeStyle = '#4a5058'; g.lineWidth = 5;
    g.strokeRect(10, 10, 492, 236);
    g.fillStyle = '#22262c';
    g.font = 'bold 24px Inter, sans-serif'; g.textAlign = 'left';
    g.fillText('TCE-LAB', 32, 56);
    g.font = 'bold 24px Inter, sans-serif';
    [['MOTOR', '1.8 kW  2.4 HP'], ['SUPPLY', '230 V  1ph  50 Hz'],
     ['SPEED', String(MOTOR_RPM) + ' rpm'], ['ARBOR', String(Math.round(freeRpm())) + ' rpm']]
        .forEach((r, i) => {
            g.fillStyle = '#4a5058'; g.fillText(r[0], 32, 96 + i * 36);
            g.fillStyle = '#22262c'; g.fillText(r[1], 190, 96 + i * 36);
        });
    return new THREE.CanvasTexture(c);
}

function init3D() {
    const host = $('view3d');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1f5f9);

    camera = new THREE.PerspectiveCamera(42, 1, 20, 9000);
    camera.position.set(-2142, 1594, -3606);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 150;
    controls.maxDistance = 4500;
    controls.maxPolarAngle = Math.PI / 2 + 0.02;
    controls.autoRotateSpeed = 0.9;
    controls.target.set(-30, TABLE_Y - 160, 40);

    scene.add(new THREE.AmbientLight(0xffffff, 0.26));
    const key = new THREE.DirectionalLight(0xffffff, 0.72);
    key.position.set(-700, 1500, 950);
    key.castShadow = true;
    key.shadow.mapSize.width = key.shadow.mapSize.height = 2048;
    key.shadow.camera.left = -1000; key.shadow.camera.right = 1000;
    key.shadow.camera.top = 1000; key.shadow.camera.bottom = -400;
    key.shadow.camera.far = 4200;
    key.shadow.bias = -0.0006;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4f0, 0.24);
    fill.position.set(900, 800, -700); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.26);
    rim.position.set(-200, 600, -1300); scene.add(rim);

    floor3 = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000),
        new THREE.MeshStandardMaterial({ color: 0xdbe1ea, roughness: 0.92 }));
    floor3.rotation.x = -Math.PI / 2;
    floor3.position.y = -1;
    floor3.receiveShadow = true;
    scene.add(floor3);
    grid3 = new THREE.GridHelper(8000, 80, 0x94a3b8, 0xcbd5e1);
    scene.add(grid3);

    // Ground carbide shows you its surroundings and little else, so with
    // nothing to reflect the blade renders black. A workshop in a few
    // strokes: bright ceiling, two strip lights, a darker floor.
    const ec = document.createElement('canvas');
    ec.width = 256; ec.height = 128;
    const eg = ec.getContext('2d');
    const sky = eg.createLinearGradient(0, 0, 0, 128);
    sky.addColorStop(0, '#9fa9b6'); sky.addColorStop(0.42, '#7d8794');
    sky.addColorStop(0.52, '#525a66'); sky.addColorStop(1, '#2e343c');
    eg.fillStyle = sky; eg.fillRect(0, 0, 256, 128);
    eg.fillStyle = '#ffffff';
    eg.fillRect(28, 10, 88, 13); eg.fillRect(150, 10, 88, 13);
    const pm = new THREE.PMREMGenerator(renderer);
    pm.compileEquirectangularShader();
    const et = new THREE.CanvasTexture(ec);
    et.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = pm.fromEquirectangular(et).texture;
    et.dispose(); pm.dispose();

    // The same palette the lathe wears, part for part: cream enamel over
    // cast iron, bright ground steel where a surface is machined, dark
    // grey for the motor and near-black cast for the pulleys.
    MAT.cast   = new THREE.MeshStandardMaterial({ color: 0xded7c4, roughness: 0.62, metalness: 0.12 });
    MAT.cast2  = new THREE.MeshStandardMaterial({ color: 0xcec6b1, roughness: 0.66, metalness: 0.10 });
    MAT.top    = new THREE.MeshStandardMaterial({ color: 0x71787f, metalness: 0.82, roughness: 0.28 });
    MAT.mach   = new THREE.MeshStandardMaterial({ color: 0x8d9299, roughness: 0.34, metalness: 0.62 });
    MAT.steel  = new THREE.MeshStandardMaterial({ color: 0xb9bfc9, metalness: 0.68, roughness: 0.22 });
    MAT.dark   = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.6, metalness: 0.2 });
    MAT.motor  = new THREE.MeshStandardMaterial({ color: 0x3d434c, roughness: 0.44, metalness: 0.46 });
    // The blade plate is ground bright; the teeth brazed onto it are
    // carbide, which is duller and greyer than any steel around it.
    MAT.plate  = new THREE.MeshStandardMaterial({ color: 0xe8eff7, metalness: 0.97, roughness: 0.06 });
    MAT.carbide= new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.55, roughness: 0.30 });
    MAT.tool   = new THREE.MeshStandardMaterial({ color: 0xd6a933, metalness: 0.78, roughness: 0.28 });
    MAT.tray   = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.7, metalness: 0.16 });
    MAT.handle = new THREE.MeshStandardMaterial({ color: 0x1b1e23, roughness: 0.40, metalness: 0.34 });
    MAT.iron   = new THREE.MeshStandardMaterial({ color: 0x3c3e40, roughness: 0.66, metalness: 0.24 });
    MAT.shaft  = new THREE.MeshStandardMaterial({ color: 0x484d54, roughness: 0.36, metalness: 0.70 });
    // Rubber, and it has to read as rubber: nearly no metalness and very
    // rough, or a dark grey strap turns into a strip of bent steel.
    MAT.belt   = new THREE.MeshStandardMaterial({ color: 0x26282d, roughness: 0.97, metalness: 0.0 });
    // Machined aluminium, for the two pulleys. Pale and bright against
    // the near-black cast iron of the gears next to them.
    MAT.alu    = new THREE.MeshStandardMaterial({ color: 0xcdd2d8, roughness: 0.30, metalness: 0.86 });
    // The guard is the one thing on the machine you are meant to see
    // through, so it is the one thing that is not opaque. Plain
    // transparency rather than real transmission: this build of three
    // does not carry the physical material's thickness term, and a guard
    // that renders as a solid block hides the part it is guarding.
    MAT.guard  = new THREE.MeshStandardMaterial({ color: 0xbfd8ea, roughness: 0.14,
                    metalness: 0.02, transparent: true, opacity: 0.30,
                    depthWrite: false, side: THREE.DoubleSide });
    // The cabinet in the same acrylic. On a real saw it is sheet steel and
    // you cannot see a thing through it - which is the whole problem with
    // teaching off a real saw. Here it is glazed, so the drive and both
    // adjustment trains stay in view with the machine still enclosed.
    MAT.acrylic = new THREE.MeshStandardMaterial({ color: 0xcfe0ee, roughness: 0.12,
                    metalness: 0.02, transparent: true, opacity: 0.22,
                    depthWrite: false, side: THREE.DoubleSide });
    MAT.acrylic.envMapIntensity = 1.4;

    MAT.cast.envMapIntensity = MAT.cast2.envMapIntensity = 0.24;
    MAT.top.envMapIntensity = 1.1;
    MAT.mach.envMapIntensity = 1.3;
    MAT.steel.envMapIntensity = 1.2;
    MAT.plate.envMapIntensity = 2.6;
    MAT.carbide.envMapIntensity = 0.9;
    MAT.tool.envMapIntensity = 1.25;
    MAT.motor.envMapIntensity = 0.8;
    MAT.dark.envMapIntensity = 0.4;
    MAT.handle.envMapIntensity = 0.7;
    MAT.iron.envMapIntensity = 0.5;
    MAT.alu.envMapIntensity = 1.5;
    MAT.belt.envMapIntensity = 0.15;
    MAT.shaft.envMapIntensity = 0.9;

    buildMachine();
    freshBoard();
    buildBoard();
}

// A machine handwheel: a round rim on three tapered spokes, a hub with
// a bore through it, and a handle standing proud on its own boss.
function handwheel(R, tube) {
    const outer = new THREE.Group();   // carries the orientation
    const g = new THREE.Group();       // and this one does the turning
    outer.add(g);
    outer.userData.spin = g;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, tube, 12, 40), MAT.top);
    rim.castShadow = true; g.add(rim);
    const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(tube * 1.8, tube * 1.8, tube * 2.8, 20), MAT.top);
    hub.rotation.x = Math.PI / 2; hub.castShadow = true; g.add(hub);
    const bore = new THREE.Mesh(
        new THREE.CylinderGeometry(tube * 0.7, tube * 0.7, tube * 3.2, 14), MAT.dark);
    bore.rotation.x = Math.PI / 2; g.add(bore);
    for (let k = 0; k < 3; k++) {
        const a2 = k / 3 * Math.PI * 2 + 0.5;
        const len = R - tube * 0.6;
        const spoke = new THREE.Mesh(
            new THREE.CylinderGeometry(tube * 0.5, tube * 0.85, len, 10), MAT.top);
        spoke.position.set(Math.cos(a2) * len / 2, Math.sin(a2) * len / 2, 0);
        spoke.rotation.z = a2 - Math.PI / 2;
        spoke.castShadow = true; g.add(spoke);
    }
    const grip = new THREE.Mesh(
        new THREE.CylinderGeometry(tube * 0.85, tube * 0.72, tube * 4.4, 14), MAT.top);
    grip.rotation.x = Math.PI / 2;
    grip.position.set(0, -R, tube * 2.8);
    grip.castShadow = true; g.add(grip);
    return outer;
}

// A vee pulley: two cones back to back, which is the whole of it. The
// belt is wedged between the faces and grips by being squeezed, not by
// being tight — which is why a slack vee belt still drives.
// A flat strap swept round a planar closed loop, with its thickness in
// the plane and its width across it. Four vertices a station, stitched
// into quads - which is all a belt is, and it cannot twist because the
// two axes of the section are stated rather than derived.
function beltRibbon(path, thick, width, steps) {
    const pos = [], idx = [];
    const P = new THREE.Vector3(), T = new THREE.Vector3();
    const ht = thick / 2, hw = width / 2;
    for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        path.getPointAt(u, P);
        path.getTangentAt(u, T);
        let nx = T.y, ny = -T.x;                 // the in-plane perpendicular
        const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
        // outer-near, outer-far, inner-far, inner-near
        pos.push(P.x + nx * ht, P.y + ny * ht, P.z - hw);
        pos.push(P.x + nx * ht, P.y + ny * ht, P.z + hw);
        pos.push(P.x - nx * ht, P.y - ny * ht, P.z + hw);
        pos.push(P.x - nx * ht, P.y - ny * ht, P.z - hw);
    }
    for (let i = 0; i < steps; i++) {
        const a = i * 4, b = (i + 1) * 4;
        for (let k = 0; k < 4; k++) {
            const k2 = (k + 1) % 4;
            idx.push(a + k, b + k, b + k2, a + k, b + k2, a + k2);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
}

// An arc standing in the y-z plane, centred on the group's own origin,
// swept by psi measured from straight down toward -z. Built as a tube on
// an explicit curve rather than as a rotated torus: a torus has to be
// turned twice to stand in this plane, the two rotations compose in an
// order that is easy to get backwards, and getting it backwards puts the
// teeth of a gear on the opposite side of the machine from its own rim.
// With the points written out there is nothing left to get wrong.
function arcPoint(R, psi, x) {
    return new THREE.Vector3(x, -R * Math.cos(psi), -R * Math.sin(psi));
}
function arcTube(R, psi0, psi1, tubeR, x, mat) {
    const pts = [];
    for (let i = 0; i <= 24; i++) pts.push(arcPoint(R, psi0 + (psi1 - psi0) * i / 24, x));
    const m = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, tubeR, 8, false), mat);
    m.castShadow = true;
    return m;
}

// Built lying along z rather than along y, so the group's own z IS the
// shaft axis and setting rotation.z spins it about that axis. Built the
// other way it needs an x-rotation to stand it up, and then no single
// Euler angle turns it about its shaft any more.
// A toothed pulley: a barrel with teeth cut across it and a flange each
// side to keep the belt on. The flanges are not decoration - a toothed
// belt has no wedge holding it in place the way a vee belt does, so
// something has to stop it walking off the end.
//
// The tooth count is set from the pitch diameter and the belt pitch, so
// the two pulleys really do carry teeth in the ratio their diameters
// say - which is the ratio the drive is geared by.
function timingPulley(R, w) {
    const g = new THREE.Group();
    const n = Math.max(8, Math.round(2 * Math.PI * R / BELT_PITCH));
    // The root the grooves are cut down to, and the lands between them.
    // Both stop AT R, so the belt teeth drop into the gaps rather than
    // trying to occupy the same millimetres as the pulley teeth.
    const body = new THREE.Mesh(
        new THREE.CylinderGeometry(R - 2.6, R - 2.6, w, 34).rotateX(Math.PI / 2), MAT.alu);
    body.castShadow = true; g.add(body);
    for (let k = 0; k < n; k++) {
        const a = k / n * Math.PI * 2;
        const t = new THREE.Mesh(roundedBox(BELT_PITCH * 0.46, 2.8, w, 0.5), MAT.alu);
        t.position.set(Math.cos(a) * (R - 1.3), Math.sin(a) * (R - 1.3), 0);
        t.rotation.z = a + Math.PI / 2;
        g.add(t);
    }
    [-1, 1].forEach(s => {                   // the flanges either side
        const fl = new THREE.Mesh(
            new THREE.CylinderGeometry(R + 4, R + 4, 2.5, 34).rotateX(Math.PI / 2), MAT.alu);
        fl.position.z = s * (w / 2 + 1.2); fl.castShadow = true; g.add(fl);
    });
    const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 0.34, R * 0.34, w * 1.7, 16).rotateX(Math.PI / 2), MAT.alu);
    g.add(hub);
    // a key line, so the eye can see it turning at all
    const mark = new THREE.Mesh(roundedBox(3.5, R * 0.5, w * 0.85, 1), MAT.dark);
    mark.position.set(0, R * 0.6, 0); g.add(mark);
    g.userData.teeth = n;
    return g;
}

function buildMachine() {
    // --- the frame ------------------------------------------------
    // What actually holds the table up. This matters because the sheet
    // steel can be taken off, and a cast top standing on nothing but its
    // own cladding would be a lie about how the machine is built: the
    // skins keep the dust in and your fingers out, they carry no load.
    // Four legs, a rail round the top and another round the bottom, all
    // welded, and every one of them stays when the cabinet comes off.
    const LEG = 20, legX = CAB_X / 2 - LEG / 2, legZ = CAB_Z / 2 - LEG / 2;
    const frameTop = TABLE_Y - TABLE_T;
    // Big swivel casters, which is how a saw of this size gets moved: a
    // cabinet saw is three hundred kilos and it does not get carried.
    // They are what sets the leg length - the frame starts above them.
    const CAST_R = 62, CAST_W = 34;
    const LEG_Y0 = CAST_R * 2 + 34;
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(c => {
        const lx = c[0] * legX, lz = CAB_CZ + c[1] * legZ;
        const leg = new THREE.Mesh(roundedBox(LEG, frameTop - LEG_Y0, LEG, 4), MAT.mach);
        leg.position.set(lx, (LEG_Y0 + frameTop) / 2, lz);
        leg.castShadow = leg.receiveShadow = true; scene.add(leg);

        // the top plate the caster is bolted up to
        const plate = new THREE.Mesh(roundedBox(62, 10, 62, 3), MAT.mach);
        plate.position.set(lx, LEG_Y0 - 5, lz);
        plate.castShadow = true; scene.add(plate);
        // the swivel, which is why a caster can be steered at all
        const swivel = new THREE.Mesh(
            new THREE.CylinderGeometry(20, 26, 30, 16), MAT.mach);
        swivel.position.set(lx, LEG_Y0 - 24, lz);
        swivel.castShadow = true; scene.add(swivel);
        // the fork, offset from the swivel axis - that trail is what makes
        // a caster fall into line behind the direction it is pushed
        const OFF = 26;
        [-1, 1].forEach(s2 => {
            const arm = new THREE.Mesh(roundedBox(12, 72, 10, 3), MAT.mach);
            arm.position.set(lx - OFF, LEG_Y0 - 62, lz + s2 * (CAST_W / 2 + 7));
            arm.castShadow = true; scene.add(arm);
        });
        const yoke = new THREE.Mesh(roundedBox(56, 12, CAST_W + 28, 3), MAT.mach);
        yoke.position.set(lx - OFF / 2, LEG_Y0 - 30, lz);
        yoke.castShadow = true; scene.add(yoke);
        // the wheel: a black tyre on a lighter hub, lying across the machine
        const tyre = new THREE.Mesh(
            new THREE.CylinderGeometry(CAST_R, CAST_R, CAST_W, 26).rotateX(Math.PI / 2),
            MAT.handle);
        tyre.position.set(lx - OFF, CAST_R, lz);
        tyre.castShadow = true; scene.add(tyre);
        const hubc = new THREE.Mesh(
            new THREE.CylinderGeometry(CAST_R * 0.44, CAST_R * 0.44, CAST_W + 6, 20)
                .rotateX(Math.PI / 2), MAT.mach);
        hubc.position.set(lx - OFF, CAST_R, lz);
        hubc.castShadow = true; scene.add(hubc);
        // and the brake lever on the two at the front
        if (c[0] < 0) {
            const lev = new THREE.Mesh(roundedBox(40, 10, 12, 3),
                new THREE.MeshStandardMaterial({ color: 0xb5301f, roughness: 0.45 }));
            lev.position.set(lx - OFF - 34, CAST_R * 0.5, lz);
            lev.rotation.z = 0.4; lev.castShadow = true; scene.add(lev);
        }
    });
    const rail = (w, d, y, x, z) => {
        const m = new THREE.Mesh(roundedBox(w, 16, d, 3), MAT.mach);
        m.position.set(x, y, CAB_CZ + z);
        m.castShadow = true; scene.add(m); return m;
    };
    [frameTop - 26, CAB_Y0 + 30].forEach(y => {
        rail(CAB_X - LEG, 14, y, 0, -legZ);      // across the tilt side
        rail(CAB_X - LEG, 14, y, 0, legZ);       // and the far side
        rail(14, CAB_Z - LEG, y, -legX, 0);      // along the front
        rail(14, CAB_Z - LEG, y, legX, 0);       // and the back
    });

    // --- the cabinet skins ----------------------------------------
    // Sheet steel hung on the frame. These are the only things the
    // Cabinet switch takes away, and nothing structural is among them.
    const skin = (w, h, d, x, y, z) => {
        const m = new THREE.Mesh(roundedBox(w, h, d, 4), MAT.acrylic);
        m.position.set(x, y, z);
        m.castShadow = m.receiveShadow = true;
        scene.add(m); cabSkins.push(m); return m;
    };
    const cy = CAB_Y0 + CAB_H / 2;
    skin(8, CAB_H, CAB_Z, -CAB_X / 2, cy, CAB_CZ);           // front
    skin(8, CAB_H, CAB_Z,  CAB_X / 2, cy, CAB_CZ);           // back
    skin(CAB_X, CAB_H, 8, 0, cy, CAB_CZ - CAB_Z / 2);        // left, the tilt side
    skin(CAB_X, CAB_H, 8, 0, cy, CAB_CZ + CAB_Z / 2);        // right
    // The badge, centred on the tilt-side panel - the one the bevel
    // wheel stands on. Facing -z: a viewer on that side has their right
    // at -x, so the lettering runs that way and reads across rather than
    // backwards. Centred on the panel's own span, not on the origin,
    // because the cabinet is offset in z and the two are not the same.
    const badge = new THREE.Mesh(new THREE.PlaneGeometry(196, 65),
        new THREE.MeshStandardMaterial({ map: badgeTexture(), transparent: true,
                                         roughness: 0.2, metalness: 0.1,
                                         depthWrite: false }));
    badge.rotation.y = Math.PI;
    badge.position.set(0, CAB_Y0 + CAB_H / 2, CAB_CZ - CAB_Z / 2 - 6);
    scene.add(badge); cabSkins.push(badge);

    // the access door, and the red band along its top edge — the same
    // stripe the lathe wears where its castings meet

    const band = new THREE.Mesh(roundedBox(CAB_X, 9, CAB_Z + 4, 2),
        new THREE.MeshStandardMaterial({ color: 0xb5301f, roughness: 0.45, metalness: 0.12 }));
    band.position.set(0, CAB_Y0 + CAB_H - 22, CAB_CZ);
    band.castShadow = true; scene.add(band); cabSkins.push(band);

    // --- the cast top --------------------------------------------
    // Ground flat, and flat is the whole job: everything the saw does
    // for accuracy is referenced off this one surface.
    const topY = TABLE_Y - TABLE_T / 2;
    const midX = (TABLE_X0 + TABLE_X1) / 2, midZ = (TABLE_Z0 + TABLE_Z1) / 2;
    const spanX = TABLE_X1 - TABLE_X0, spanZ = TABLE_Z1 - TABLE_Z0;
    // The top is built as four planks around the throat rather than as
    // one slab with a hole, because a hole through a box is not
    // something an extruded shape can have. Two run the full length
    // either side of the opening; two more close the ends of it.
    const mkTop = (w, d, x, z) => {
        const m = new THREE.Mesh(roundedBox(w, TABLE_T, d, 3), MAT.top);
        m.position.set(x, topY, z);
        m.castShadow = m.receiveShadow = true; scene.add(m); return m;
    };
    const pz0 = -PLATE_W / 2, pz1 = PLATE_W / 2;
    const px0 = -PLATE_L / 2, px1 = PLATE_L / 2;
    mkTop(spanX, pz0 - TABLE_Z0, midX, (TABLE_Z0 + pz0) / 2);      // left of the throat
    mkTop(spanX, TABLE_Z1 - pz1, midX, (pz1 + TABLE_Z1) / 2);      // right of it
    mkTop(px0 - TABLE_X0, PLATE_W, (TABLE_X0 + px0) / 2, 0);       // in front of the plate
    mkTop(TABLE_X1 - px1, PLATE_W, (px1 + TABLE_X1) / 2, 0);       // and behind it

    // The rim cast down round the outside. This is what makes a thin web
    // stiff enough to be a reference surface, and it is why the edge of a
    // real saw table is deep while the middle of it is not - which is the
    // clearance the arbor and its pulley need with the blade wound up.
    const rimY = TABLE_Y - TABLE_T - (TABLE_RIM - TABLE_T) / 2;
    const skirt = (w, d, x, z) => {
        const m = new THREE.Mesh(roundedBox(w, TABLE_RIM - TABLE_T, d, 3), MAT.top);
        m.position.set(x, rimY, z);
        m.castShadow = m.receiveShadow = true; scene.add(m);
    };
    skirt(spanX, 26, midX, TABLE_Z0 + 13);
    skirt(spanX, 26, midX, TABLE_Z1 - 13);
    skirt(26, spanZ, TABLE_X0 + 13, midZ);
    skirt(26, spanZ, TABLE_X1 - 13, midZ);
    // and two ribs across the underside, kept clear of the drive
    skirt(20, spanZ * 0.5, -300, TABLE_Z0 + spanZ * 0.26);
    skirt(20, spanZ * 0.5, 300, TABLE_Z0 + spanZ * 0.26);

    // the maker's name, cast into the infeed corner of the top
    const brand = new THREE.Mesh(new THREE.PlaneGeometry(300, 75),
        new THREE.MeshStandardMaterial({ map: brandTexture(), transparent: true,
                                         roughness: 0.55, metalness: 0.3 }));
    brand.rotation.x = -Math.PI / 2;    // flat on the iron, reading along the
                                        // feed - the way the timber travels
    brand.rotation.z = Math.PI;         // and facing out, not back at itself
    brand.position.set(TABLE_X0 + 220, TABLE_Y + 0.6, TABLE_Z0 + 80);
    scene.add(brand);

    // the throat plate: a drop-in insert with the blade slot through it,
    // in two halves either side of the slot
    throatPlate = new THREE.Group(); scene.add(throatPlate);
    [-1, 1].forEach(s => {
        const w = (PLATE_W - SLOT_W) / 2;
        const p = new THREE.Mesh(roundedBox(PLATE_L - 6, TABLE_T - 6, w - 2, 2), MAT.tray);
        p.position.set(0, topY + 2, s * (SLOT_W / 2 + w / 2));
        p.castShadow = p.receiveShadow = true; throatPlate.add(p);
    });

    // the miter slot, milled the length of the top on the left of the blade
    [-1, 1].forEach(s => {
        const z = s < 0 ? MITER_Z : 190;
        const sl = new THREE.Mesh(roundedBox(spanX + 4, MITER_D, MITER_W, 1), MAT.dark);
        sl.position.set(midX, TABLE_Y - MITER_D / 2 + 0.4, z);
        scene.add(sl);
    });

    // --- the trunnions --------------------------------------------
    // Two curved brackets bolted to the underside of the table. These do
    // NOT move: they are the track, and the cradle carrying the arbor
    // slides round them. Getting this the right way round matters,
    // because it is the whole reason a saw can tilt at all while the
    // blade stays in its own slot in the table.
    // The arcs run from 15 degrees the far side of straight down round to
    // 60 degrees the near side, so the cradle has track under it across
    // the whole 0-45 the tilt wheel can ask for, with a little to spare
    // at each end for the stops.
    const TRUN_R = 205, TRUN_X = [-135, 175];
    const PSI0 = -15 * Math.PI / 180, PSI1 = 60 * Math.PI / 180;
    trunFixed = new THREE.Group();
    trunFixed.position.set(0, TABLE_Y, 0);
    scene.add(trunFixed);
    TRUN_X.forEach(tx => {
        trunFixed.add(arcTube(TRUN_R, PSI0, PSI1, 13, tx, MAT.cast2));
        // the ears it is bolted up to the underside of the table by
        [PSI0, PSI1].forEach(psi => {
            const p = arcPoint(TRUN_R, psi, tx);
            const ear = new THREE.Mesh(roundedBox(38, 34, 26, 3), MAT.cast2);
            ear.position.copy(p);
            ear.castShadow = true; trunFixed.add(ear);
            // and the web tying that end back up to the table
            const web = new THREE.Mesh(roundedBox(20, Math.abs(p.y) + 10, 14, 2), MAT.cast2);
            web.position.set(tx, p.y / 2, p.z);
            trunFixed.add(web);
        });
    });

    // Everything that tilts. On the real machine one casting swings and
    // takes the arbor, the motor and the belt with it, which is why the
    // belt never has to change length.
    tiltGrp = new THREE.Group();
    tiltGrp.position.set(0, TABLE_Y, 0);
    scene.add(tiltGrp);

    // The cradle: two shoes that ride the trunnion arcs. They sit on the
    // same radius as the brackets and start centred on straight down, so
    // as the cradle swings they travel along the track rather than
    // through it.
    TRUN_X.forEach(tx => {
        tiltGrp.add(arcTube(TRUN_R, -12 * Math.PI / 180, 12 * Math.PI / 180, 18, tx, MAT.mach));
    });
    const cradle = new THREE.Mesh(roundedBox(360, 30, 132, 5), MAT.cast2);
    cradle.position.set(20, -196, -30); cradle.castShadow = true; tiltGrp.add(cradle);
    // the uprights the arbor carriage slides up and down between
    [-1, 1].forEach(s => {
        const post = new THREE.Mesh(roundedBox(26, 210, 22, 3), MAT.mach);
        post.position.set(-70, -90, s * 54); post.castShadow = true; tiltGrp.add(post);
    });

    // --- the arbor and the blade ----------------------------------
    arborGrp = new THREE.Group();
    tiltGrp.add(arborGrp);

    const arbor = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 300, 18), MAT.shaft);
    arbor.rotation.x = Math.PI / 2; arbor.position.z = 30;
    arbor.castShadow = true; arborGrp.add(arbor);
    // the bearing housing the arbor runs in
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(26, 26, 96, 20), MAT.mach);
    housing.rotation.x = Math.PI / 2; housing.position.z = 70;
    housing.castShadow = true; arborGrp.add(housing);

    bladeGrp = new THREE.Group();
    arborGrp.add(bladeGrp);

    // The plate, cut with real teeth and real gullets.
    //
    // Drawn as a plain disc with little blocks stuck round the rim, it
    // read as a wheel with studs in it. A saw blade is not that shape:
    // between one tooth and the next the steel is scooped away into a
    // gullet, and that gullet is not decoration either - it is the space
    // the chip has to sit in until it comes back out of the cut, which
    // is the whole reason a rip blade has fewer, bigger teeth than a
    // crosscut one. So the plate is extruded from a profile that has the
    // teeth and the gullets in it, and the carbide is brazed on top.
    bladeMesh = new THREE.Mesh(bladePlate(teeth()), MAT.plate);
    bladeMesh.castShadow = true;
    bladeGrp.add(bladeMesh);
    buildTeeth();
    // the arbor flange and the nut that holds it all on
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 9, 22), MAT.mach);
    flange.rotation.x = Math.PI / 2; flange.position.z = -6;
    bladeGrp.add(flange);
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, 12, 6), MAT.shaft);
    nut.rotation.x = Math.PI / 2; nut.position.z = 9;
    nut.castShadow = true; bladeGrp.add(nut);

    // --- the motor, the pulleys and the belt ----------------------
    motorGrp = new THREE.Group();
    arborGrp.add(motorGrp);                  // it rises AND tilts with the arbor
    motorGrp.position.set(MOTOR_X, MOTOR_Y, MOTOR_Z);

    const can = new THREE.Mesh(new THREE.CylinderGeometry(68, 68, 190, 30), MAT.motor);
    can.rotation.x = Math.PI / 2; can.castShadow = true; motorGrp.add(can);
    // the cooling fins down the barrel, which is how you know it is a
    // motor and not a drum
    for (let k = 0; k < 20; k++) {
        const a = k / 20 * Math.PI * 2;
        const f = new THREE.Mesh(roundedBox(8, 11, 176, 1), MAT.motor);
        f.position.set(Math.cos(a) * 70, Math.sin(a) * 70, 0);
        f.rotation.z = a; motorGrp.add(f);
    }
    [-1, 1].forEach(s => {
        const end = new THREE.Mesh(new THREE.CylinderGeometry(62, 55, 24, 26), MAT.motor);
        end.rotation.x = Math.PI / 2; end.position.z = s * 100;
        end.castShadow = true; motorGrp.add(end);
    });
    // the terminal box on its back, where the supply comes in
    const tbox = new THREE.Mesh(roundedBox(70, 44, 60, 3), MAT.motor);
    tbox.position.set(0, 78, -20); tbox.castShadow = true; motorGrp.add(tbox);
    // The rating plate, which is the only thing on a motor anybody reads.
    //
    // It was floating: aimed with lookAt at a point picked by eye, so it
    // hung in space near the barrel at an angle that belonged to nothing.
    // A real nameplate is riveted to a flat pad cast into the housing -
    // which is also the honest way to put a flat rectangle on a round
    // body. The pad is machined flat, the plate sits on the pad, and both
    // are turned together to whatever point of the barrel they live on.
    const NP_A = 1.05;                       // up and toward the front
    const npad = new THREE.Group();
    npad.rotation.z = NP_A;
    motorGrp.add(npad);
    const boss = new THREE.Mesh(roundedBox(8, 56, 108, 2), MAT.motor);
    boss.position.set(65, 0, 6);             // sunk into the barrel, flush at 68
    boss.castShadow = true; npad.add(boss);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(100, 48),
        new THREE.MeshStandardMaterial({ map: platePlateTexture(),
                                         roughness: 0.52, metalness: 0.35 }));
    plate.position.set(69.4, 0, 6);
    plate.rotation.y = Math.PI / 2;          // its face out along the radius
    npad.add(plate);
    // the four rivets holding it on
    [[-44, -18], [-44, 18], [44, -18], [44, 18]].forEach(r => {
        const rv = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 6), MAT.steel);
        rv.position.set(69.8, r[1], 6 - r[0]);
        npad.add(rv);
    });

    // the motor's own pulley, out on the shaft toward the blade
    moPulley = timingPulley(MOT_PULLEY / 2, 22);
    moPulley.position.set(0, 0, BELT_Z - MOTOR_Z);
    motorGrp.add(moPulley);
    const mshaft = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 74, 14), MAT.shaft);
    mshaft.rotation.x = Math.PI / 2; mshaft.position.set(0, 0, BELT_Z - MOTOR_Z);
    motorGrp.add(mshaft);

    // the arbor's pulley, on the far end of the same shaft as the blade
    arbPulley = timingPulley(ARB_PULLEY / 2, 22);
    arbPulley.position.set(0, 0, BELT_Z);
    arborGrp.add(arbPulley);

    buildBelt();

    // --- the height mechanism -------------------------------------
    // Wheel, shaft, bevel pair, screw, nut. Every one of those is drawn,
    // because a wheel on the outside of a box with nothing joining it to
    // the blade teaches the student that height is magic. It is not: it
    // is a screw, and one turn of the wheel is worth a fixed number of
    // millimetres up the screw.
    //
    // The wheel is on the front, where you reach it standing at the
    // machine. The screw is inside the cradle, so it goes over with the
    // tilt and keeps driving the carriage square to the blade whatever
    // angle the saw is set to.
    const WHEEL_Y = TABLE_Y - 268;
    liftWheel = handwheel(74, 8);
    liftWheel.position.set(-CAB_X / 2 - 30, WHEEL_Y, CAB_CZ);
    liftWheel.rotation.y = Math.PI / 2;
    scene.add(liftWheel);
    const lhub = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 40, 18), MAT.mach);
    lhub.rotation.z = Math.PI / 2;
    lhub.position.set(-CAB_X / 2 - 10, WHEEL_Y, CAB_CZ);
    scene.add(lhub);
    // The shaft running back from the wheel to the screw. It is drawn as
    // a single length here and then AIMED every frame in update3D, for a
    // reason that is not a shortcut: the screw is inside the cradle and
    // goes over with the tilt, while the wheel is bolted to the cabinet
    // and does not. Something has to take up the difference, and on a
    // real saw it is a universal joint on a splined shaft. Re-aiming the
    // drawn shaft is that joint - without it the drive visibly comes
    // apart the moment the blade leaves square, which is exactly the
    // thing a student should not be shown.
    liftShaft = new THREE.Mesh(
        new THREE.CylinderGeometry(11, 11, 1, 14).translate(0, 0.5, 0), MAT.shaft);
    liftShaft.castShadow = true; scene.add(liftShaft);
    // The spline groove down it. A plain cylinder turning looks like a
    // plain cylinder standing still, and this shaft is the one part of
    // the height drive the student can see from outside the machine.
    liftShaft.add(new THREE.Mesh(
        new THREE.BoxGeometry(4, 1, 20).translate(0, 0.5, 0), MAT.dark));
    // the universal joint at the wheel end, which is where the angle is taken
    liftBevelA = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 34, 14), MAT.iron);
    liftBevelA.rotation.z = Math.PI / 2;
    liftBevelA.position.set(-CAB_X / 2 + 34, WHEEL_Y, CAB_CZ);
    liftBevelA.castShadow = true; scene.add(liftBevelA);

    // Inside the cradle: the screw the carriage rides, and the nut block
    // bolted to the carriage that rides it.
    // Where the screw stands has three things to clear and they leave
    // only a narrow slot for it: the trunnion bracket at x = -135, the
    // quadrant at x = -40, and the blade itself, which sweeps the whole
    // disc at z = 0. So it goes at x = -80, offset in z clear of the
    // blade - and it stops short of the table, or it comes up through
    // the top when the cradle tilts.
    const SCREW_X = -80, SCREW_Z = 20;
    liftBevelB = new THREE.Mesh(new THREE.CylinderGeometry(34, 26, 20, 20), MAT.iron);
    liftBevelB.position.set(SCREW_X, -125, SCREW_Z);
    liftBevelB.castShadow = true; tiltGrp.add(liftBevelB);
    liftScrew = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 150, 16), MAT.shaft);
    liftScrew.position.set(SCREW_X, -212, SCREW_Z);
    liftScrew.castShadow = true; tiltGrp.add(liftScrew);
    // The thread, as a stack of collars. Without it the screw is a plain
    // cylinder and a plain cylinder turning looks like nothing at all -
    // there is no feature on it for the eye to follow.
    for (let k = 0; k <= 20; k++) {
        const t = new THREE.Mesh(new THREE.TorusGeometry(13, 2.6, 6, 14), MAT.shaft);
        t.rotation.x = Math.PI / 2;
        t.position.set(0, -66 + k * 6.6, 0);   // the screw's own frame
        liftScrew.add(t);
    }
    // the nut block, bolted to the arbor carriage: this is the part the
    // screw actually pushes, and it is what the height reading is of
    liftNut = new THREE.Mesh(roundedBox(46, 40, 46, 4), MAT.mach);
    liftNut.castShadow = true; tiltGrp.add(liftNut);
    // the arm tying the nut back to the arbor carriage
    liftArm = new THREE.Mesh(roundedBox(Math.abs(SCREW_X) + 10, 18, 20, 3), MAT.mach);
    liftArm.castShadow = true; tiltGrp.add(liftArm);
    // the post up from that arm to the arbor housing: this is the piece
    // that actually carries the blade up when the nut is driven
    liftPost = new THREE.Mesh(roundedBox(22, 130, 20, 3), MAT.mach);
    liftPost.castShadow = true; tiltGrp.add(liftPost);

    // --- the tilt mechanism ---------------------------------------
    // A worm on the wheel shaft, driving the toothed quadrant that is
    // part of the cradle. A worm because it will not be driven backwards:
    // the weight of the motor hanging off the trunnion would otherwise
    // wind the blade back to upright the moment you let go of the wheel.
    const TZ = CAB_CZ - CAB_Z / 2;
    // The quadrant: a toothed arc that is part of the cradle, so it is
    // the cradle that swings when the worm turns it. Same centre as the
    // trunnions, because it has to turn about the same axis they do.
    const QUAD_R = 262, QUAD_X = -215;
    const QP0 = -30 * Math.PI / 180, QP1 = 35 * Math.PI / 180;
    tiltGrp.add(arcTube(QUAD_R, QP0, QP1, 15, QUAD_X, MAT.cast2));
    // its teeth, standing off the outer rim
    const NQT = 22;
    for (let k = 0; k <= NQT; k++) {
        const psi = QP0 + (QP1 - QP0) * k / NQT;
        const p = arcPoint(QUAD_R + 15, psi, QUAD_X);
        const t = new THREE.Mesh(roundedBox(30, 15, 11, 2), MAT.cast2);
        t.position.copy(p);
        t.rotation.x = psi;                // lying along the rim it grows from
        tiltGrp.add(t);
    }
    // The worm that drives it, sitting tangent to the quadrant at the
    // angle the cradle is at when the blade is upright. A worm, because
    // it cannot be driven backwards: the weight of the motor hanging off
    // the trunnion would otherwise wind the blade back to square the
    // moment you let go of the wheel.
    const WORM_PSI = 26 * Math.PI / 180;
    const wp = arcPoint(QUAD_R + 48, WORM_PSI, QUAD_X);
    tiltWorm = new THREE.Group();
    tiltWorm.position.set(QUAD_X, TABLE_Y + wp.y, wp.z);
    scene.add(tiltWorm);
    const wcore = new THREE.Mesh(
        new THREE.CylinderGeometry(19, 19, 74, 16).rotateX(Math.PI / 2), MAT.iron);
    wcore.castShadow = true; tiltWorm.add(wcore);
    for (let k = 0; k < 10; k++) {                       // the worm's own thread
        const t = new THREE.Mesh(new THREE.TorusGeometry(21, 3.4, 6, 16), MAT.iron);
        t.position.z = -32 + k * 7.2;
        t.rotation.y = 0.28;                             // the lead of the thread
        tiltWorm.add(t);
    }
    // the shaft from the wheel out on the cabinet side, in to the worm
    const wz = TABLE_Y + wp.y, shaftZ0 = TZ - 18, shaftZ1 = wp.z - 40;
    tiltShaft = new THREE.Mesh(
        new THREE.CylinderGeometry(10, 10, shaftZ1 - shaftZ0, 14).rotateX(Math.PI / 2), MAT.shaft);
    tiltShaft.position.set(QUAD_X, wz, (shaftZ0 + shaftZ1) / 2);
    tiltShaft.castShadow = true; scene.add(tiltShaft);
    // its outboard bearing, bolted to the cabinet side
    const wbear = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 26, 16).rotateX(Math.PI / 2), MAT.mach);
    wbear.position.set(QUAD_X, wz, shaftZ0 + 14);
    scene.add(wbear);
    // and the wheel on the end of it, out on the tilt side of the cabinet.
    // It sits at the shaft's height, not at some height of its own, or the
    // wheel and the shaft it is supposed to be turning do not meet.
    tiltWheel = handwheel(66, 7);
    tiltWheel.position.set(QUAD_X, wz, TZ - 34);
    scene.add(tiltWheel);
    const thub = new THREE.Mesh(
        new THREE.CylinderGeometry(20, 20, 36, 18).rotateX(Math.PI / 2), MAT.mach);
    thub.position.set(QUAD_X, wz, TZ - 12);
    scene.add(thub);

    // --- the rails and the fence ----------------------------------
    // The rail is the datum the fence measures from, which is why it is
    // a ground steel tube and not a piece of angle: the fence has to
    // land in the same place every time it is moved.
    const railGeo = new THREE.Mesh(roundedBox(56, 46, spanZ, 4), MAT.mach);
    railGeo.position.set(RAIL_X, RAIL_Y, midZ);
    railGeo.castShadow = true; scene.add(railGeo);
    const rail2 = new THREE.Mesh(roundedBox(44, 36, spanZ, 4), MAT.mach);
    rail2.position.set(RAIL_X2, RAIL_Y, midZ);
    rail2.castShadow = true; scene.add(rail2);
    // the scale, read against a cursor on the fence head
    const RULE_W = spanZ - 20, RULE_H = 34;
    const scale = new THREE.Mesh(new THREE.PlaneGeometry(RULE_W, RULE_H),
        new THREE.MeshStandardMaterial({ map: scaleTexture(RULE_W, RULE_H, 320),
                                         roughness: 0.6, metalness: 0.05 }));
    scale.position.set(RAIL_X - 29, RAIL_Y + 2, midZ);
    scale.rotation.y = -Math.PI / 2;
    scene.add(scale);
    // and the legs that carry the rail out past the table
    [-1, 1].forEach(s => {
        const leg = new THREE.Mesh(roundedBox(40, 90, 18, 3), MAT.mach);
        leg.position.set(RAIL_X, RAIL_Y - 60, midZ + s * (spanZ / 2 - 60));
        scene.add(leg);
    });

    fenceGrp = new THREE.Group(); scene.add(fenceGrp);
    // the body: an extruded box section standing on the table
    const fbody = new THREE.Mesh(roundedBox(spanX, 78, 34, 3), MAT.mach);
    fbody.position.set(midX, TABLE_Y + 39, 0);
    fbody.castShadow = true; fenceGrp.add(fbody);
    // the laminate face the timber actually rubs on
    const fface = new THREE.Mesh(roundedBox(spanX - 4, 70, 6, 1),
        new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.42, metalness: 0.05 }));
    fface.position.set(midX, TABLE_Y + 39, -18); fenceGrp.add(fface);
    // the head that clamps it to the front rail, and its lever
    const fhead = new THREE.Mesh(roundedBox(96, 96, 66, 4), MAT.mach);
    fhead.position.set(RAIL_X + 8, RAIL_Y + 18, 0);
    fhead.castShadow = true; fenceGrp.add(fhead);
    const lever = new THREE.Mesh(roundedBox(20, 70, 14, 4), MAT.handle);
    lever.position.set(RAIL_X - 26, RAIL_Y + 54, 0);
    lever.rotation.z = -0.5; lever.castShadow = true; fenceGrp.add(lever);

    // --- the miter gauge ------------------------------------------
    // For the cut across the grain. It runs in the slot, so the timber
    // is pushed square instead of being steered by hand — and the fence
    // must not be used at the same time, which is what the operation
    // switch is really choosing between.
    miterGrp = new THREE.Group(); scene.add(miterGrp);
    const bar = new THREE.Mesh(roundedBox(300, MITER_D - 1, MITER_W - 1, 1), MAT.mach);
    bar.position.set(0, TABLE_Y - MITER_D / 2 + 1, MITER_Z);
    miterGrp.add(bar);
    const prot = new THREE.Mesh(new THREE.CylinderGeometry(74, 74, 16, 30, 1, false, 0, Math.PI), MAT.cast2);
    prot.position.set(-40, TABLE_Y + 8, MITER_Z);
    prot.rotation.x = -Math.PI / 2; prot.rotation.z = Math.PI / 2;
    prot.castShadow = true; miterGrp.add(prot);
    const mfence = new THREE.Mesh(roundedBox(26, 62, 300, 2), MAT.mach);
    mfence.position.set(-40, TABLE_Y + 31, MITER_Z + 60);
    mfence.castShadow = true; miterGrp.add(mfence);
    const mknob = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 22, 16), MAT.handle);
    mknob.position.set(-96, TABLE_Y + 24, MITER_Z);
    mknob.rotation.z = Math.PI / 2; miterGrp.add(mknob);

    // --- guard, riving knife and pawls ----------------------------
    // The knife is the important one and it is the one people take off.
    // It sits in the kerf behind the blade, the same thickness as the
    // plate and thinner than the teeth, and it holds the cut open so the
    // timber cannot close on the back of the blade and be thrown.
    // The hood is gone, and with it the switch that took it off. It sat
    // over the blade, which is exactly where you need to be looking, and
    // half of what a student came to see was behind it.
    //
    // The riving knife stays, and it is NOT the guard. It is a fixed part
    // of the machine: the same thickness as the plate and thinner than
    // the teeth, sitting in the kerf right behind the blade so the two
    // halves of the board cannot close on it. It follows the blade up,
    // down and over because it is carried on the same cradle.
    guardGrp = new THREE.Group(); arborGrp.add(guardGrp);
    // A riving knife is not a rectangle. Its leading edge follows the
    // blade at a constant few millimetres, so it stays the same distance
    // behind the teeth at every height the blade is wound to - that
    // constant gap is the entire trick, and a slab of plate does not
    // have it. Cut as a profile, it reads as the part it is.
    const kshape = new THREE.Shape();
    const KG = 8;                              // the gap it holds off the blade
    kshape.moveTo(4, -150);
    kshape.lineTo(74, -150);                   // the trailing edge, straight
    kshape.lineTo(74, 6);
    kshape.lineTo(30, 46);                     // the top, swept down behind the blade
    kshape.lineTo(6, 40);
    for (let i = 0; i <= 16; i++) {            // and the leading edge, on the arc
        const a = Math.PI * 0.46 - i / 16 * Math.PI * 0.86;
        kshape.lineTo(Math.cos(a) * (BLADE_R + KG) - BLADE_R + 4,
                      Math.sin(a) * (BLADE_R + KG) - 15);
    }
    kshape.closePath();
    knifeMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(kshape, {
        depth: PLATE_T, bevelEnabled: false, curveSegments: 2
    }).translate(0, 0, -PLATE_T / 2), MAT.steel);
    knifeMesh.position.set(BLADE_R - 4, 0, 0);
    knifeMesh.castShadow = true; guardGrp.add(knifeMesh);

    // --- dust extraction ------------------------------------------
    const shroud = new THREE.Mesh(roundedBox(210, 160, 130, 8), MAT.tray);
    shroud.position.set(50, -330, -20);
    tiltGrp.add(shroud);

    // --- the supply -----------------------------------------------
    // A saw of this size is not switched with a toggle. It has a
    // magnetic starter: press to run, and any interruption to the supply
    // drops it out, so the machine cannot restart itself when the power
    // comes back with someone's hand still in it.
    const box = new THREE.Mesh(roundedBox(56, 150, 120, 5), MAT.tray);
    box.position.set(RAIL_X - 30, RAIL_Y - 96, 210);
    box.castShadow = true; scene.add(box);
    const paddle = new THREE.Mesh(roundedBox(14, 78, 100, 6), MAT.cast2);
    paddle.position.set(RAIL_X - 62, RAIL_Y - 118, 210);
    paddle.castShadow = true; scene.add(paddle);
    // The supply lamp. Red the moment the starter is in - because live
    // and not cutting is the dangerous state, the one where the blade is
    // still turning and nobody is thinking about it. Green only while it
    // is actually working, which is when everyone IS thinking about it.
    MAT.lamp = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.3,
                  emissive: 0x000000, emissiveIntensity: 1 });
    const bezel = new THREE.Mesh(new THREE.CylinderGeometry(23, 23, 12, 20), MAT.mach);
    bezel.rotation.z = Math.PI / 2;
    bezel.position.set(RAIL_X - 56, RAIL_Y - 116, 210);
    bezel.castShadow = true; scene.add(bezel);
    lampMesh = new THREE.Mesh(new THREE.SphereGeometry(17, 20, 14), MAT.lamp);
    lampMesh.position.set(RAIL_X - 66, RAIL_Y - 116, 210);
    scene.add(lampMesh);

    const stopBtn = new THREE.Mesh(new THREE.CylinderGeometry(19, 19, 14, 20),
        new THREE.MeshStandardMaterial({ color: 0xb5301f, roughness: 0.4 }));
    stopBtn.rotation.z = Math.PI / 2;
    stopBtn.position.set(RAIL_X - 62, RAIL_Y - 58, 210);
    scene.add(stopBtn);
    // the flex, down the leg and away across the floor
    const cordPts = [
        new THREE.Vector3(RAIL_X - 30, RAIL_Y - 170, 210),
        new THREE.Vector3(RAIL_X - 40, 260, 260),
        new THREE.Vector3(RAIL_X - 90, 40, 330),
        new THREE.Vector3(RAIL_X - 300, 8, 520)
    ];
    const cord = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cordPts), 26, 7, 8), MAT.dark);
    scene.add(cord);

    // Two panel instruments. They are only telling you what the physics
    // already says — the volts sag under load and the current is the
    // power the cut is taking divided by them — but a motor with no
    // meters on it does not look like a machine.
    function meterFace(unit, max) {
        const S = 256, c = document.createElement('canvas');
        c.width = c.height = S;
        const g = c.getContext('2d'), Mid = S / 2;
        g.fillStyle = '#f2efe4'; g.beginPath(); g.arc(Mid, Mid, Mid - 2, 0, 7); g.fill();
        g.strokeStyle = '#c9c3b0'; g.lineWidth = 4;
        g.beginPath(); g.arc(Mid, Mid, Mid - 6, 0, 7); g.stroke();
        for (let i = 0; i <= 10; i++) {
            const f = i / 10, a = (150 + f * 240) * Math.PI / 180;
            const big = i % 2 === 0, r0 = Mid - 22, r1 = Mid - (big ? 44 : 34);
            g.strokeStyle = f > 0.82 ? '#b5301f' : '#22262c';
            g.lineWidth = big ? 5 : 2.5;
            g.beginPath();
            g.moveTo(Mid + Math.cos(a) * r0, Mid + Math.sin(a) * r0);
            g.lineTo(Mid + Math.cos(a) * r1, Mid + Math.sin(a) * r1);
            g.stroke();
            if (big) {
                g.fillStyle = '#22262c';
                g.font = 'bold 22px Inter, sans-serif';
                g.textAlign = 'center'; g.textBaseline = 'middle';
                g.fillText(String(Math.round(max * f)),
                           Mid + Math.cos(a) * (r1 - 18), Mid + Math.sin(a) * (r1 - 18));
            }
        }
        g.fillStyle = '#22262c';
        g.font = 'bold 34px Inter, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(unit, Mid, Mid + 52);
        return new THREE.CanvasTexture(c);
    }
    function meter(unit, max, pz) {
        const grp = new THREE.Group();
        grp.position.set(RAIL_X - 60, RAIL_Y - 62, pz);
        grp.rotation.y = -Math.PI / 2;
        scene.add(grp);
        const can2 = new THREE.Mesh(new THREE.CylinderGeometry(25, 25, 10, 26), MAT.mach);
        can2.rotation.x = Math.PI / 2; can2.castShadow = true; grp.add(can2);
        const face = new THREE.Mesh(new THREE.CircleGeometry(22, 30),
            new THREE.MeshStandardMaterial({ map: meterFace(unit, max), roughness: 0.55, metalness: 0.05 }));
        face.position.z = 5.2; grp.add(face);
        const needle = new THREE.Group(); needle.position.z = 6; grp.add(needle);
        const n = new THREE.Mesh(roundedBox(1.8, 19, 1.4, 0.5), MAT.dark);
        n.position.y = 8; needle.add(n);
        const hub2 = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 3, 12), MAT.dark);
        hub2.rotation.x = Math.PI / 2; hub2.position.z = 6.4; grp.add(hub2);
        const bez = new THREE.Mesh(new THREE.TorusGeometry(23.5, 2.2, 8, 28), MAT.mach);
        bez.position.z = 5.6; grp.add(bez);
        return needle;
    }
    voltNeedle = meter('V', 300, 268);
    ampNeedle  = meter('A', 12, 152);

    dustGrp = new THREE.Group(); scene.add(dustGrp);
}

// The plate profile: Z teeth, each with a flat top land, a raked face,
// and a gullet scooped out behind it. Gullet depth goes with the tooth
// count, because that is how blades are actually made - 24 big teeth
// need somewhere to put a long rip chip, 80 small ones do not.
function bladePlate(z) {
    const step = Math.PI * 2 / z;
    const GD = clamp(180 / z, 3.5, 11);        // how deep the gullet is cut
    const Rr = BLADE_R - 9 - GD;               // the gullet root
    const Rp = BLADE_R - 9;                    // where the carbide sits on
    const sh = new THREE.Shape();
    const at = (r, a) => new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
    let p = at(Rp, 0);
    sh.moveTo(p.x, p.y);
    for (let k = 0; k < z; k++) {
        const a = k * step;
        // the top land, then the back of the tooth falling away
        p = at(Rp, a + step * 0.30); sh.lineTo(p.x, p.y);
        p = at(Rr, a + step * 0.62); sh.lineTo(p.x, p.y);
        // the gullet floor, rounded rather than a vee - a sharp corner is
        // where a blade cracks
        const c = at(Rr, a + step * 0.80);
        p = at(Rp, a + step * 1.0);
        sh.quadraticCurveTo(c.x, c.y, p.x, p.y);
    }
    sh.closePath();
    // the arbor hole, and the two expansion slots that stop a hot plate
    // buckling into an S and wandering out of its own cut
    const bore = new THREE.Path();
    bore.absarc(0, 0, 16, 0, Math.PI * 2, true);
    sh.holes.push(bore);
    for (let k = 0; k < 3; k++) {
        const a = k / 3 * Math.PI * 2 + 0.5, sr = Rr - 26;
        const h = new THREE.Path();
        const w = 0.030;
        h.absarc(0, 0, sr, a - w, a + w, false);
        h.absarc(0, 0, sr - 13, a + w, a - w, true);
        h.closePath();
        sh.holes.push(h);
    }
    return new THREE.ExtrudeGeometry(sh, {
        depth: PLATE_T, bevelEnabled: false, curveSegments: 3
    }).translate(0, 0, -PLATE_T / 2);
}

// The carbide, brazed onto the top land of every tooth. It is WIDER than
// the plate, and that difference is the kerf itself - the only reason
// the plate behind it does not bind in its own cut.
function buildTeeth() {
    bladeTeeth.forEach(t => bladeGrp.remove(t));
    bladeTeeth = [];
    if (bladeMesh) {
        bladeGrp.remove(bladeMesh);
        bladeMesh.geometry.dispose();
        bladeMesh = new THREE.Mesh(bladePlate(teeth()), MAT.plate);
        bladeMesh.castShadow = true;
        bladeGrp.add(bladeMesh);
    }
    const z = teeth(), hook = B().hook * Math.PI / 180;
    const step = Math.PI * 2 / z;
    const wide = Math.min(step * (BLADE_R - 5) * 0.55, 13);
    for (let k = 0; k < z; k++) {
        const a = k * step + step * 0.15;
        const t = new THREE.Mesh(roundedBox(wide, 10, KERF, 0.6), MAT.carbide);
        t.position.set(Math.cos(a) * (BLADE_R - 4.5), Math.sin(a) * (BLADE_R - 4.5), 0);
        // the hook: the face leans forward into the cut, and a rip blade
        // leans a lot further than a crosscut one
        t.rotation.z = a + Math.PI / 2 - hook;
        bladeGrp.add(t); bladeTeeth.push(t);
    }
}

// The vee belt, as a loop of segments that travel round it. A belt drawn
// as a static band tells you the motor is connected; a belt whose marks
// move tells you which way round and how fast, which is the thing worth
// showing.
const _bp = new THREE.Vector3(), _bt = new THREE.Vector3();
function buildBelt() {
    beltTeethM.forEach(t => arborGrp.remove(t));
    beltTeethM = [];
    // The pitch line sits half the strap clear of the pulley outside, so
    // the back of the belt is outside the teeth and its own teeth reach
    // back in to the grooves.
    const r1 = MOT_PULLEY / 2 + 1.6, r2 = ARB_PULLEY / 2 + 1.6;
    // Built straight in the cradle's own frame, in the plane both
    // pulleys run in. An earlier version built it flat and then turned
    // the whole thing a quarter turn to stand it up, which put the belt
    // on the far side of the machine from the pulleys it was supposed to
    // be driving - so there is no rotation here at all.
    const c1 = new THREE.Vector2(MOTOR_X, MOTOR_Y);   // motor pulley centre
    const c2 = new THREE.Vector2(0, 0);               // arbor centre
    const d = new THREE.Vector2().subVectors(c2, c1);
    const D = d.length();
    const ang = Math.atan2(d.y, d.x);

    // A belt WRAPS its pulleys. The previous version took half a turn
    // round each, but it took the WRONG half - the side facing the other
    // pulley - so the loop cut straight through the middle of both and
    // only grazed them where it crossed. From outside it read as a band
    // resting against two wheels rather than one driven by them.
    //
    // The wrap is the far side of each, and the two are joined by the
    // common tangents. Because the pulleys are not the same size those
    // tangents are not parallel to the line of centres: they lean by
    // alpha, which is what gives the larger pulley pi + 2a of wrap and
    // the smaller one pi - 2a. It is a degree and a half here, but it is
    // the difference between a belt that is drawn and one that is built.
    const alpha = Math.asin(clamp((r1 - r2) / D, -1, 1));
    const beta = Math.PI / 2 - alpha;                 // touch angle, either side
    const pts = [];
    const N = 56, S = 14;
    const on = (c, r, t) =>
        new THREE.Vector3(c.x + Math.cos(t) * r, c.y + Math.sin(t) * r, BELT_Z);

    // round the back of the motor pulley: pi + 2a
    for (let i = 0; i <= N; i++) {
        pts.push(on(c1, r1, ang + beta + (2 * Math.PI - 2 * beta) * i / N));
    }
    // the taut side, down to the arbor pulley
    const a1 = on(c1, r1, ang - beta), b1 = on(c2, r2, ang - beta);
    for (let i = 1; i < S; i++) pts.push(a1.clone().lerp(b1, i / S));
    // round the front of the arbor pulley: pi - 2a
    for (let i = 0; i <= N; i++) {
        pts.push(on(c2, r2, ang - beta + 2 * beta * i / N));
    }
    // and the slack side, back to where it started
    const a2 = on(c2, r2, ang + beta), b2 = on(c1, r1, ang + beta);
    for (let i = 1; i < S; i++) pts.push(a2.clone().lerp(b2, i / S));

    // centripetal, or the spline overshoots where an arc meets a straight
    beltPath = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    beltLen = beltPath.getLength();
    beltPitchR = r2;
    beltMidX = (c1.x + c2.x) / 2; beltMidY = (c1.y + c2.y) / 2;

    // The belt itself, swept along the loop by hand.
    //
    // Two earlier attempts were both wrong and both instructive. A round
    // tube scaled flat threw the whole belt 690 mm out of the machine,
    // because scale multiplies POSITION as well as thickness. Extruding
    // a rectangle along the path put it back, but three builds that
    // frame from the curve's own torsion, and on a flat loop that frame
    // rolls - so the strap arrived twisted, with its corners catching the
    // light like a length of bent angle iron.
    //
    // The loop is flat, so the frame never has to be guessed: the belt's
    // thickness always lies in the plane of the loop and its width always
    // lies across it. Written out that way there is no twist to get.
    const strap = new THREE.Mesh(beltRibbon(beltPath, 3.0, 21, 260), MAT.belt);
    strap.castShadow = true;
    arborGrp.add(strap);
    beltHolder = strap;

    // and its teeth, spaced at the belt pitch all the way round. They
    // travel with the belt, so the drive reads as teeth going into teeth
    // rather than as a band sliding over a wheel - which is the whole
    // difference between a timing belt and a friction one.
    const nT = Math.max(8, Math.round(beltLen / BELT_PITCH));
    for (let i = 0; i < nT; i++) {
        const m = new THREE.Mesh(roundedBox(BELT_PITCH * 0.44, 2.6, 20, 0.5), MAT.belt);
        m.userData.s = i / nT * beltLen;
        arborGrp.add(m); beltTeethM.push(m);
    }
}
let beltHolder = null;

function runBelt() {
    if (!beltPath || !beltTeethM.length) return;
    const adv = state.spinShown * beltPitchR;
    for (const t of beltTeethM) {
        let s = (t.userData.s + adv) % beltLen;
        if (s < 0) s += beltLen;
        const u = s / beltLen;
        beltPath.getPointAt(u, _bp);
        beltPath.getTangentAt(u, _bt);
        // the tooth lies along the belt and stands INTO the loop, so it
        // meets the pulley teeth instead of floating off the back of the belt
        let nx = _bt.y, ny = -_bt.x;
        if ((beltMidX - _bp.x) * nx + (beltMidY - _bp.y) * ny < 0) { nx = -nx; ny = -ny; }
        t.position.set(_bp.x + nx * 2.9, _bp.y + ny * 2.9, _bp.z);
        t.rotation.z = Math.atan2(_bt.y, _bt.x);
    }
}

// =============================================================
//  The board
// =============================================================
// Three pieces, not one. Ahead of the blade the board is whole; behind
// it there are two, held apart by the width of the slot the teeth have
// taken out. Building it this way means the saw is visibly making two
// things out of one, which is what a saw is for.
function buildBoard() {
    if (boardGrp) scene.remove(boardGrp);
    boardGrp = new THREE.Group(); scene.add(boardGrp);

    const L = boardLen(), T = P.thick;
    const W = state.op === 'rip' ? P.rip + 190 : 420;
    // where the board sits across the machine: ripping, its right edge
    // is against the fence, so the offcut side is what P.rip sets
    const zHi = state.op === 'rip' ? P.rip : W / 2;
    const zLo = zHi - W;

    // metalness has to be said out loud. Three defaults it to 0.5, and a
    // half-metallic board under a bright environment renders as a sheet
    // of polished tin rather than as timber.
    const tex = woodTexture(state.mat, state.op === 'rip');
    const face = new THREE.MeshStandardMaterial({ map: tex, roughness: M().rough,
                                                  metalness: 0 });
    boardTex = new THREE.CanvasTexture(boardCan);
    const cut = new THREE.MeshStandardMaterial({ map: boardTex, metalness: 0,
                                                 roughness: M().rough * 0.9 });
    face.envMapIntensity = cut.envMapIntensity = 0.35;
    const mats = [face, face, face, face, face, face];

    // the piece still in one lump, ahead of the blade
    boardWhole = new THREE.Mesh(new THREE.BoxGeometry(1, T, W), mats);
    boardWhole.castShadow = boardWhole.receiveShadow = true;
    boardGrp.add(boardWhole);

    // and the two behind it. Their inner faces carry the cut texture,
    // which is where the scorching and the tearout are recorded.
    const side = [face, face, face, face, cut, cut];
    boardLeft = new THREE.Mesh(new THREE.BoxGeometry(1, T, Math.max(1, -zLo - KERF / 2)), side);
    boardRight = new THREE.Mesh(new THREE.BoxGeometry(1, T, Math.max(1, zHi - KERF / 2)), side);
    [boardLeft, boardRight].forEach(m => {
        m.castShadow = m.receiveShadow = true; boardGrp.add(m);
    });
    boardGrp.userData = { L: L, W: W, T: T, zLo: zLo, zHi: zHi };
    layoutBoard();
}

// Where the pieces stand, given how far the board has been fed. The
// blade first touches the timber at x = -halfChord, so everything that
// has travelled past that point is behind the teeth and in two pieces;
// everything short of it is still one board.
function layoutBoard() {
    if (!boardGrp) return;
    const u = boardGrp.userData, L = u.L, T = u.T;
    const hc = halfChord();
    const lead = -hc - LEAD_IN + state.fed;   // the leading edge, in machine x
    const trail = lead - L;                   // and the trailing one
    const sawn = clamp(lead + hc, 0, L);      // how much has been through
    const whole = L - sawn;
    const y = TABLE_Y + T / 2;

    // A cut that does not clear the top of the board leaves a groove in
    // one piece rather than two, so the board is left whole and only a
    // through cut is allowed to separate it.
    const split = throughCut() && sawn > 0.5;

    boardWhole.visible = !split || whole > 0.5;
    if (boardWhole.visible) {
        const len = split ? whole : L;
        boardWhole.scale.x = Math.max(0.5, len);
        boardWhole.position.set(split ? trail + len / 2 : trail + L / 2, y,
                                (u.zLo + u.zHi) / 2);
    }
    boardLeft.visible = boardRight.visible = split;
    if (split) {
        // the offcut side, left of the blade
        boardLeft.scale.x = sawn;
        boardLeft.position.set(lead - sawn / 2, y, (u.zLo - KERF / 2) / 2);
        // and the piece against the fence, which is the one you keep
        boardRight.scale.x = sawn;
        boardRight.position.set(lead - sawn / 2, y, (u.zHi + KERF / 2) / 2);
    }
    boardGrp.visible = state.setupT > 0.02;
    boardGrp.position.y = (1 - ease(state.setupT)) * 220;
}

function newBoard() {
    freshBoard();
    state.fed = 0; state.done = false; state.cutting = false;
    state.setupT = 0;
    buildBoard();
}

// =============================================================
//  Dust
// =============================================================
// Sawdust, not chips. A saw does not curl a chip off the way a lathe
// does — every tooth takes a crumb, and there are four thousand of them
// a second, so what comes off is a spray.
function spawnDust(n) {
    if (!state.dust || !dustGrp) return;
    const hc = halfChord();
    for (let i = 0; i < n; i++) {
        const g = new THREE.Mesh(
            new THREE.BoxGeometry(1.4 + Math.random() * 2.4, 1.2, 1.2 + Math.random() * 2),
            new THREE.MeshStandardMaterial({ color: M().grain, roughness: 0.95, metalness: 0 }));
        g.position.set(-hc * (0.2 + Math.random() * 0.8),
                       TABLE_Y + Math.random() * 8, (Math.random() - 0.5) * KERF * 3);
        // Thrown UP and FORWARD at the front of the blade, because that is
        // the way the teeth are travelling there. Anyone who has stood at
        // one knows which way the dust comes.
        const v = 60 + Math.random() * 190;
        g.userData.v = new THREE.Vector3(
            -v * (0.5 + Math.random() * 0.7), v * (0.5 + Math.random()),
            (Math.random() - 0.5) * 90);
        g.userData.life = 0.8 + Math.random() * 0.9;
        dustGrp.add(g); dust.push(g);
    }
    while (dust.length > 420) { const d = dust.shift(); dustGrp.remove(d); }
}
function stepDust(dt) {
    for (let i = dust.length - 1; i >= 0; i--) {
        const d = dust[i];
        d.userData.life -= dt;
        if (d.userData.life <= 0) { dustGrp.remove(d); dust.splice(i, 1); continue; }
        d.userData.v.y -= 1500 * dt;
        d.position.addScaledVector(d.userData.v, dt);
        d.rotation.x += dt * 9; d.rotation.z += dt * 7;
        if (d.position.y < TABLE_Y + 1) {           // it lands on the table
            d.position.y = TABLE_Y + 1;
            d.userData.v.set(0, 0, 0);
            d.userData.life = Math.min(d.userData.life, 0.5);
        }
    }
}
function clearDust() { dust.forEach(d => dustGrp.remove(d)); dust = []; }

// =============================================================
//  Cutting
// =============================================================
function startCut() {
    if (!state.power) { flash('No power.', 'The starter has not been pressed.'); return; }
    if (state.done) { newBoard(); return; }
    if (projection() <= 0.5) {
        flash('Blade below the table.', 'Wind it up until it stands proud of the timber.');
        return;
    }
    state.running = true;
    state.paused = false;
}

function step(dt) {
    state.elapsed += dt;

    // the board being laid on the table
    if (state.setupT < 1) {
        state.setupT = Math.min(1, state.setupT + dt / 0.55);
        layoutBoard();
    }
    // and the motor coming up to speed. An induction motor takes a
    // second or two to run up and it coasts for a good while after,
    // which is exactly why the guard matters after the switch is off.
    const want = state.power ? 1 : 0;
    state.startT += (want - state.startT) * Math.min(1, dt / (state.power ? 0.8 : 2.6));

    // The blade's speed. Free-running it is fixed; loaded past what the
    // motor has, it droops — and a saw bogging down is a sound before it
    // is a reading.
    const free = freeRpm() * state.startT;
    let droop = 1;
    if (state.cutting && cutPower() > 1) {
        droop = clamp(availPower() / Math.max(1, cutPower()), 0.18, 1);
        droop = 1 - (1 - droop) * 0.85;         // slip, not a dead stop
    }
    const target = free * droop;
    state.rpm += (target - state.rpm) * Math.min(1, dt / 0.55);
    if (state.rpm < 2) state.rpm = 0;
    state.stalled = state.cutting && overloaded();

    state.spin += 2 * Math.PI * state.rpm / 60 * dt;
    state.spinShown = state.spin;

    // --- the feed -------------------------------------------------
    if (state.running && !state.done) {
        const hc = halfChord();
        state.fed += P.feed * dt;
        const lead = -hc - LEAD_IN + state.fed;
        const trail = lead - boardLen();
        const inCut = lead > -hc && trail < hc && projection() > 0.5;
        state.cutting = inCut && state.rpm > 200;

        if (state.cutting) {
            state.cutIdle = 0;
            // Record what this stretch of the cut was given. The station
            // is measured from the board's own leading edge, so the marks
            // stay with the timber rather than with the machine - change
            // the feed halfway down a board and you can see where.
            const s = clamp(lead + hc, 0, boardLen());
            const i = segAt(s);
            const fz = chipLoad();
            if (fz < FZ_RUB) {
                // rubbing. How fast it scorches goes with how far under
                // the band it is and how long the blade dwells there.
                const under = clamp((FZ_RUB - fz) / FZ_RUB, 0, 1);
                burn[i] = clamp(burn[i] + under * M().burn * dt * 2.6, 0, 1);
            }
            if (fz > FZ_TEAR) {
                const over = clamp((fz - FZ_TEAR) / FZ_TEAR, 0, 1.4);
                tear[i] = clamp(tear[i] + over * M().tear * B().tear * dt * 4, 0, 1);
            }
            if (state.elapsed % 0.12 < dt) paintBoard();
            spawnDust(Math.round((2 + loadFrac() * 7) * M().dust));
        } else if (state.cutIdle < 9) {
            state.cutIdle += dt;
        }
        state.kickRisk = kickback();

        layoutBoard();
        if (state.fed >= passLength()) finishCut();
    } else if (state.cutIdle < 9) {
        state.cutIdle += dt;
        state.cutting = false;
    }

    stepDust(dt);

    // the two wheels wind toward where they have been set
    state.liftShown += (P.lift - state.liftShown) * Math.min(1, dt / 0.42);
    state.tiltShown += (P.tilt - state.tiltShown) * Math.min(1, dt / 0.55);
    state.ripShown += (P.rip - state.ripShown) * Math.min(1, dt / 0.4);
}

function finishCut() {
    state.running = false;
    state.done = true;
    state.cutting = false;
    paintBoard();
}

function resetAll() {
    state.running = false; state.done = false; state.cutting = false;
    state.fed = 0; state.elapsed = 0; state.kickRisk = 0;
    clearDust();
    newBoard();
}

// =============================================================
//  Drawing one frame
// =============================================================
function update3D() {
    if (!gl) return;

    // the blade, where the two wheels have put it
    const b = tiltRad();
    tiltGrp.rotation.x = b;
    arborGrp.position.y = -(BLADE_R - state.liftShown);
    bladeGrp.rotation.z = -state.spinShown;

    // --- the height train -----------------------------------------
    // Wheel, shaft, bevel, bevel, screw, nut, carriage. Every one of them
    // turns by the amount the one before it turned, so the student can
    // follow the drive with their eye from the hand on the wheel all the
    // way to the blade coming up out of the table. LEAD_LIFT is how many
    // millimetres one turn of the wheel is worth.
    const LEAD_LIFT = 6;
    const turns = state.liftShown / LEAD_LIFT;
    if (liftWheel) liftWheel.userData.spin.rotation.z = -turns;
    if (liftBevelA) liftBevelA.rotation.x = turns;
    // through the bevel pair the axis stands up, and the screw turns with it
    if (liftBevelB) liftBevelB.rotation.y = turns;
    if (liftScrew) liftScrew.rotation.y = turns;
    // and the nut walks up the screw, carrying the arbor with it
    if (liftNut) liftNut.position.set(-80, arborGrp.position.y - 120, 20);
    if (liftArm) liftArm.position.set(-40, arborGrp.position.y - 120, 20);
    if (liftPost) { liftPost.position.set(-6, arborGrp.position.y - 60, 20);
                    liftPost.scale.y = 1; }
    // The shaft is stretched and aimed from the joint at the wheel to the
    // bevel down in the cradle, wherever the tilt has put it. This is the
    // splined half of the drive, and it is what keeps the train joined up
    // through the whole bevel range.
    if (liftShaft && liftBevelA && liftBevelB) {
        const a = liftBevelA.getWorldPosition(_va);
        const b = liftBevelB.getWorldPosition(_vb);
        liftShaft.position.copy(a);
        liftShaft.scale.y = Math.max(1, a.distanceTo(b));
        liftShaft.quaternion.setFromUnitVectors(_up, _vc.subVectors(b, a).normalize());
        // aimed first, then spun about its own length - so it both points
        // at the screw and visibly drives it
        _qs.setFromAxisAngle(_up, turns);
        liftShaft.quaternion.multiply(_qs);
    }

    // --- the tilt train -------------------------------------------
    // The worm turns; the quadrant it is cut into is part of the cradle,
    // so the cradle is what swings. LEAD_TILT is degrees per turn.
    const LEAD_TILT = 12;
    const tTurns = state.tiltShown / LEAD_TILT;
    if (tiltWheel) tiltWheel.userData.spin.rotation.z = tTurns * 2 * Math.PI / 6;
    if (tiltShaft) tiltShaft.rotation.z = tTurns * 2 * Math.PI / 6;
    if (tiltWorm) tiltWorm.rotation.z = tTurns * 2 * Math.PI / 6;

    // --- the drive ------------------------------------------------
    // Never direct. The motor turns its pulley, the belt carries it to
    // the smaller pulley on the arbor, and the arbor runs faster than
    // the motor by exactly the ratio of the two - which is how a 3450
    // rpm motor gives a 4025 rpm blade.
    if (arbPulley) arbPulley.rotation.z = state.spinShown;
    if (moPulley) moPulley.rotation.z = state.spinShown / BELT_RATIO;
    runBelt();

    // the fence, out where the rip width says
    if (fenceGrp) fenceGrp.position.z = state.ripShown + 17;
    if (fenceGrp) fenceGrp.visible = state.op === 'rip';
    if (miterGrp) {
        miterGrp.visible = state.op === 'crosscut';
        // the miter gauge travels with the timber, since it is what is
        // pushing it
        miterGrp.position.x = state.running || state.done
            ? clamp(state.fed - 180, -260, 420) : -260;
    }

    if (guardGrp) guardGrp.visible = true;
    cabSkins.forEach(m => { m.visible = state.cabinet; });
    if (throatPlate) throatPlate.visible = true;

    // the meters. Volts sag with load; amps are what the cut is drawing.
    const load = state.cutting ? loadFrac() : 0;
    const volts = 238 - load * 26 - (state.power ? 4 : 0);
    const amps = state.power ? 1.1 + load * 8.4 : 0;
    shownVolts += (volts - shownVolts) * 0.08;
    shownAmps += (amps - shownAmps) * 0.10;
    if (voltNeedle) voltNeedle.rotation.z = -(150 + shownVolts / 300 * 240) * Math.PI / 180 - Math.PI / 2;
    if (ampNeedle) ampNeedle.rotation.z = -(150 + shownAmps / 12 * 240) * Math.PI / 180 - Math.PI / 2;

    if (state.parts) layoutParts();
    renderer.render(scene, camera);
}

// Whole stands at the machine rather than above it: the camera is near
// enough to working height that the cast top reads as a surface you feed
// timber across, not as a plan drawing of one. It costs some of the
// cabinet, which is what the other presets are for.
//
// Blade comes in from the far side, behind the machine on the right. It
// is the side the blade leans AWAY from, so a bevel opens toward the
// camera instead of rolling away behind its own guard.
const VIEWS = {
    whole:  { pos: [-2142, 1631, -3606], tgt: [-30, TABLE_Y - 160, 40] },
    blade:  { pos: [295, 1000, -375],  tgt: [0, TABLE_Y - 50, 0] },
    motor:  { pos: [640, 700, 700],    tgt: [MOTOR_X * 0.6, TABLE_Y - 330, -60] },
    drive:  { pos: [-120, 690, 760],   tgt: [70, TABLE_Y - 300, -60] },
    trunnion:{ pos: [-560, 640, 560],  tgt: [-30, TABLE_Y - 250, 10] },
    fence:  { pos: [-780, 1080, 640],  tgt: [-120, TABLE_Y + 30, 150] },
    power:  { pos: [-820, 830, 700],   tgt: [RAIL_X - 40, RAIL_Y - 80, 210] }
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
    floor3.material.color.setHex(dark ? 0x131c2e : 0xdbe1ea);
    grid3.material.color.setHex(dark ? 0x1e293b : 0xcbd5e1);
}
function resizeView() {
    const r = $('view3d').getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    if (gl) { camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); }
}
window.addEventListener('resize', resizeView);

// =============================================================
//  Readings
// =============================================================
function updateStats() {
    const fz = chipLoad();
    $('stat-rpm').textContent = Math.round(state.rpm);
    $('stat-rim').textContent = rimSpeed().toFixed(0);
    $('stat-fz').textContent = fz.toFixed(3);
    $('stat-teeth').textContent = teethIn().toFixed(1);
    $('stat-force').textContent = Math.round(cutForce());
    $('stat-power').textContent = Math.round(state.cutting ? cutPower() : 0);
    $('stat-depth').textContent = cutDepth().toFixed(1);

    const el = $('stat-fz');
    el.classList.toggle('text-rose-600', fz < FZ_RUB || fz > FZ_TEAR);
    el.classList.toggle('text-emerald-600', fz >= FZ_RUB && fz <= FZ_TEAR);

    const pw = $('stat-power');
    pw.classList.toggle('text-rose-600', overloaded());
    pw.classList.toggle('text-amber-600', !overloaded());

    $('v-feed').textContent = P.feed;
    $('v-lift').textContent = P.lift;
    $('v-tilt').textContent = P.tilt;
    $('v-thick').textContent = P.thick;
    $('v-rip').textContent = P.rip;
    $('lbl-proj').textContent = projection().toFixed(0);

    paintAlarm();
    paintLamp();
}

const ALARMS = {
    danger: ['bg-rose-600', 'text-white', 'border-rose-700'],
    warn:   ['bg-amber-500', 'text-white', 'border-amber-600'],
    info:   ['bg-white', 'text-slate-700', 'border-slate-200']
};
let lastAlarm = null, flashUntil = 0, flashMsg = null;
function flash(title, body) {
    flashMsg = { title: title, body: body };
    flashUntil = state.elapsed + 3.2;
}
function setAlarm(kind, title, body) {
    const key = kind + '|' + title + '|' + body;
    if (key === lastAlarm) return;
    lastAlarm = key;
    const el = $('alarm');
    Object.keys(ALARMS).forEach(k => el.classList.remove.apply(el.classList, ALARMS[k]));
    if (!title) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.classList.add.apply(el.classList, ALARMS[kind]);
    $('alarm-title').textContent = title;
    $('alarm-body').textContent = body;
}

// Worst first. Only one of these is shown, and it should be the thing
// that matters most rather than the most recent.
function paintAlarm() {
    if (flashMsg && state.elapsed < flashUntil) {
        setAlarm('warn', flashMsg.title, flashMsg.body); return;
    }
    flashMsg = null;
    const fz = chipLoad();
    if (state.kickRisk > 0.55) {
        setAlarm('danger', 'Kickback risk.',
            'The cut is loaded hard enough to snatch. Ease the feed, or take less '
            + 'depth - the riving knife holds the kerf open but it cannot stop a '
            + 'board being driven faster than the teeth can clear it.');
    } else if (state.cutting && overloaded()) {
        setAlarm('danger', 'Bogging down.',
            'This cut wants ' + Math.round(cutPower()) + ' W and the motor has '
            + Math.round(availPower()) + '. Slow the feed, take a shallower cut, or use a '
            + 'blade with fewer teeth.');
    } else if (state.cutting && fz < FZ_RUB) {
        setAlarm('warn', 'Burning.',
            'Only ' + fz.toFixed(3) + ' mm a tooth — under ' + FZ_RUB + ' the teeth stop cutting '
            + 'and start rubbing. Feed faster, or fit a blade with fewer teeth.');
    } else if (state.cutting && fz > FZ_TEAR) {
        setAlarm('warn', 'Tearing out.',
            fz.toFixed(3) + ' mm a tooth is more than the gullet can carry. Ease off, or put '
            + 'more teeth in the cut.');
    } else if (state.power && projection() <= 0.5) {
        setAlarm('info', 'Blade below the table.', 'Wind the height wheel up.');
    } else if (state.paused) {
        setAlarm('warn', 'Paused.', 'Nothing is moving. Press Resume to carry on.');
    } else if (state.done) {
        setAlarm('info', 'Cut finished.', 'Reset to lay a fresh board on.');
    } else if (!state.power) {
        setAlarm('info', 'No power.', 'Press the starter.');
    } else {
        setAlarm('info', '', '');
    }
}

// =============================================================
//  Sound
// =============================================================
let aMotor = null, aCut = null, aPlace = null;
function initAudio() {
    aMotor = $('a-motor'); aCut = $('a-cut'); aPlace = $('a-place');
}
// A looping sound is FADED, never paused.
//
// Pausing and playing again is what made the motor cut out mid-spin: the
// element stops, and the next play() restarts the buffer, so every time
// the volume passed through the threshold the loop began again with an
// audible seam. Worse, a paused element loses its place, so the loop
// point moved around and the gap landed somewhere different each time.
//
// Kept running with the volume taken to zero, the loop never breaks and
// the seam never happens. It is only paused when it has been silent for
// a while, which nobody can hear.
const FADE = 6;                       // volume units a second, roughly
function loopOn(el, vol, rate, dt) {
    if (!el) return;
    const want = clamp(vol, 0, 1);
    const k = Math.min(1, (dt || 0.016) * FADE);
    el.volume = clamp(el.volume + (want - el.volume) * k, 0, 1);
    // the rate is eased too: stepping it frame to frame is a pitch jump
    const wr = clamp(rate || 1, 0.5, 2.4);
    el.playbackRate = clamp(el.playbackRate + (wr - el.playbackRate) * k, 0.5, 2.4);
    if (el.paused && el.volume > 0.001) el.play().catch(() => {});
}
function loopFade(el, dt) {
    if (!el || el.paused) return;
    const k = Math.min(1, (dt || 0.016) * FADE);
    el.volume = clamp(el.volume * (1 - k), 0, 1);
    if (el.volume < 0.004) { try { el.pause(); } catch (e) {} }
}
function loopOff(el) {
    if (el && !el.paused) { try { el.pause(); el.volume = 0; } catch (e) {} }
}
function cue(el) {
    if (!el || !state.sound) return;
    try { el.currentTime = 0; } catch (e) {}
    el.volume = 0.5; el.play().catch(() => {});
}
function soundUpdate(dt) {
    if (!aMotor) return;
    const f = state.rpm / Math.max(1, freeRpm());
    if (state.sound && f > 0.02) {
        // the note falls with the blade when the cut loads it, which is
        // the sound every woodworker listens for
        loopOn(aMotor, 0.10 + 0.16 * f, 0.72 + 0.62 * f, dt);
    } else loopFade(aMotor, dt);

    if (state.sound && state.cutting && state.cutIdle < 0.2) {
        loopOn(aCut, 0.16 + 0.3 * clamp(loadFrac(), 0, 1), 0.9 + 0.35 * f, dt);
    } else loopFade(aCut, dt);
}
function soundStop() { [aMotor, aCut].forEach(loopOff); }

// =============================================================
//  Loop
// =============================================================
const DT = 1 / 120;
let last = performance.now(), acc = 0;
function frame(now) {
    const real = Math.min((now - last) / 1000, 0.05); last = now;
    advanceCamera(real);
    // Paused freezes the machine but not the camera: the point of
    // stopping it is to go and look, so orbiting has to keep working.
    if (!state.paused) {
        acc += real;
        let guard = 0;
        while (acc >= DT && guard++ < 400) { step(DT); acc -= DT; }
    } else acc = 0;
    if (controls) controls.update();
    soundUpdate(real);
    updateStats();
    update3D();
    requestAnimationFrame(frame);
}

// =============================================================
//  Part names
// =============================================================
// Anchors are real points in the scene, taken through each part's own
// transform, so a label follows the blade as it rises and tilts rather
// than being pinned to a spot on the glass. `pri` decides who survives
// when the window is too short to list everybody.
const PARTS = [
    { n: 'Cast iron table', pri: 9, p: () => new THREE.Vector3(-180, TABLE_Y, 230) },
    { n: 'Throat plate',   pri: 5, p: () => new THREE.Vector3(-120, TABLE_Y + 4, 0) },
    { n: 'Miter slot',     pri: 5, p: () => new THREE.Vector3(-250, TABLE_Y, MITER_Z) },
    { n: 'Saw blade',      pri: 10, p: () => tiltGrp
            ? tiltGrp.localToWorld(new THREE.Vector3(0, -(BLADE_R - state.liftShown) + BLADE_R - 6, 0))
            : null },
    { n: 'Carbide teeth',  pri: 7, p: () => bladeTeeth.length
            ? bladeTeeth[0].getWorldPosition(new THREE.Vector3()) : null },
    { n: 'Arbor & flange', pri: 8, p: () => arborGrp
            ? arborGrp.localToWorld(new THREE.Vector3(0, 0, 24)) : null },
    { n: 'Arbor pulley',   pri: 8, p: () => arbPulley
            ? arbPulley.getWorldPosition(new THREE.Vector3()) : null },
    { n: 'Timing belt',    pri: 9, p: () => arborGrp
            ? arborGrp.localToWorld(new THREE.Vector3(MOTOR_X / 2, MOTOR_Y / 2, BELT_Z)) : null },
    { n: 'Motor pulley',   pri: 8, p: () => moPulley
            ? moPulley.getWorldPosition(new THREE.Vector3()) : null },
    { n: 'Induction motor', pri: 10, p: () => motorGrp
            ? motorGrp.localToWorld(new THREE.Vector3(0, 76, 0)) : null },
    { n: 'Motor rating plate', pri: 3, p: () => motorGrp
            ? motorGrp.localToWorld(new THREE.Vector3(-50, 50, 54)) : null },
    { n: 'Trunnion bracket', pri: 7, p: () => new THREE.Vector3(-135, TABLE_Y - 190, -78) },
    { n: 'Tilting cradle', pri: 7, p: () => tiltGrp
            ? tiltGrp.localToWorld(new THREE.Vector3(20, -196, -30)) : null },
    { n: 'Height wheel',   pri: 10, p: () => liftWheel
            ? liftWheel.getWorldPosition(new THREE.Vector3()) : null },
    { n: 'Height shaft',   pri: 4, p: () => liftShaft
            ? liftShaft.getWorldPosition(new THREE.Vector3()) : null },
    { n: 'Bevel gears',    pri: 5, p: () => liftBevelB
            ? liftBevelB.getWorldPosition(new THREE.Vector3()) : null },
    { n: 'Elevation screw', pri: 8, p: () => liftScrew
            ? liftScrew.getWorldPosition(new THREE.Vector3()) : null },
    { n: 'Carriage nut',   pri: 5, p: () => liftNut
            ? liftNut.getWorldPosition(new THREE.Vector3()) : null },
    { n: 'Tilt wheel',     pri: 10, p: () => tiltWheel
            ? tiltWheel.getWorldPosition(new THREE.Vector3()) : null },
    { n: 'Tilt worm',      pri: 6, p: () => tiltWorm
            ? tiltWorm.getWorldPosition(new THREE.Vector3()) : null },
    { n: 'Tilt quadrant',  pri: 6, p: () => tiltGrp
            ? tiltGrp.localToWorld(arcPoint(277, 30 * Math.PI / 180, -215)) : null },
    { n: 'Frame leg',      pri: 4, p: () => new THREE.Vector3(
            -(CAB_X / 2 - 10), 400, CAB_CZ - (CAB_Z / 2 - 10)) },
    { n: 'Swivel caster',  pri: 5, p: () => new THREE.Vector3(
            -(CAB_X / 2 - 10) - 26, 62, CAB_CZ - (CAB_Z / 2 - 10)) },
    { n: 'Rip fence',      pri: 9, p: () => fenceGrp && fenceGrp.visible
            ? fenceGrp.localToWorld(new THREE.Vector3(midXConst, TABLE_Y + 78, 0)) : null },
    { n: 'Fence rail',     pri: 8, p: () => new THREE.Vector3(RAIL_X, RAIL_Y + 24, 240) },
    { n: 'Rear rail',      pri: 4, p: () => new THREE.Vector3(RAIL_X2, RAIL_Y + 18, 240) },
    { n: 'Rip scale',      pri: 3, p: () => new THREE.Vector3(RAIL_X - 30, RAIL_Y + 8, 130) },
    { n: 'Miter gauge',    pri: 8, p: () => miterGrp && miterGrp.visible
            ? miterGrp.localToWorld(new THREE.Vector3(-40, TABLE_Y + 62, MITER_Z + 60)) : null },
    { n: 'Riving knife',   pri: 9, p: () => arborGrp
            ? arborGrp.localToWorld(new THREE.Vector3(BLADE_R + 40, 30, 0)) : null },
    { n: 'Magnetic starter', pri: 7, p: () => new THREE.Vector3(RAIL_X - 46, RAIL_Y - 96, 210) },
    { n: 'Panel meters',   pri: 4, p: () => new THREE.Vector3(RAIL_X - 60, RAIL_Y - 62, 210) },
    { n: 'Supply lamp',    pri: 6, p: () => lampMesh
            ? lampMesh.getWorldPosition(new THREE.Vector3()) : null },
    { n: 'Supply cord',    pri: 3, p: () => new THREE.Vector3(RAIL_X - 90, 40, 330) },
    { n: 'Dust shroud',    pri: 5, p: () => tiltGrp
            ? tiltGrp.localToWorld(new THREE.Vector3(50, -330, -20)) : null },
    { n: 'Cabinet',        pri: 5, p: () => state.cabinet
            ? new THREE.Vector3(-CAB_X / 2 - 10, CAB_Y0 + CAB_H * 0.45, 180) : null },
    { n: 'Workpiece',      pri: 10, p: () => boardGrp && boardGrp.visible && boardWhole.visible
            ? boardWhole.getWorldPosition(new THREE.Vector3()) : null }
];
const PART_INK = '#ea7317';
let partEls = null;
function buildPartLabels() {
    const host = $('parts'), svg = $('parts-svg'), NS = 'http://www.w3.org/2000/svg';
    partEls = PARTS.map(pt => {
        const d = document.createElement('div');
        d.className = 'plab'; d.textContent = pt.n; host.appendChild(d);
        const ln = document.createElementNS(NS, 'line');
        ln.setAttribute('stroke', PART_INK);
        ln.setAttribute('stroke-width', '1.5');
        ln.setAttribute('stroke-linecap', 'round');
        svg.appendChild(ln);
        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('r', '3.4');
        dot.setAttribute('fill', PART_INK);
        svg.appendChild(dot);
        return { d: d, ln: ln, dot: dot, w: 0 };
    });
}
function layoutParts() {
    if (!partEls) buildPartLabels();
    const W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight;
    const PAD = 17, ROW = 34;
    const hide = E => { E.d.style.display = 'none';
                        E.ln.style.display = 'none'; E.dot.style.display = 'none'; };
    const live = [];
    PARTS.forEach((pt, i) => {
        let v = null;
        try { v = pt.p(); } catch (e) { v = null; }
        if (!v) { hide(partEls[i]); return; }
        const q = v.project(camera);
        if (q.z > 1) { hide(partEls[i]); return; }
        const sx = (q.x * 0.5 + 0.5) * W, sy = (-q.y * 0.5 + 0.5) * H;
        if (sx < -60 || sx > W + 60 || sy < -30 || sy > H + 30) { hide(partEls[i]); return; }
        live.push({ i: i, sx: sx, sy: sy, pri: pt.pri, side: 0 });
    });
    const xs = live.map(o => o.sx).sort((a, b) => a - b);
    const mid = xs.length ? xs[xs.length >> 1] : W * 0.5;
    live.forEach(o => o.side = o.sx < mid ? 0 : 1);
    const placed = {};
    [0, 1].forEach(side => {
        let col = live.filter(o => o.side === side).sort((a, b) => a.sy - b.sy);
        const cap = Math.max(1, Math.floor((H - 2 * PAD) / ROW));
        if (col.length > cap) {
            const keep = col.slice().sort((a, b) => b.pri - a.pri || a.sy - b.sy)
                            .slice(0, cap).map(o => o.i);
            col.filter(o => keep.indexOf(o.i) < 0).forEach(o => hide(partEls[o.i]));
            col = col.filter(o => keep.indexOf(o.i) >= 0);
        }
        let y = PAD;
        col.forEach(o => { o.ly = Math.max(y, Math.min(o.sy, H - PAD)); y = o.ly + ROW; });
        if (y - ROW > H - PAD) {
            let yy = H - PAD;
            for (let i = col.length - 1; i >= 0; i--) {
                col[i].ly = Math.min(col[i].ly, yy);
                yy = col[i].ly - ROW;
            }
        }
        col.forEach(o => placed[o.i] = o);
    });
    let wide = 0;
    live.forEach(o => { const E = partEls[o.i];
                        if (!E.w) E.w = E.d.offsetWidth;
                        if (E.w > wide) wide = E.w; });
    const GUT = 44;
    let bx0 = W, bx1 = 0;
    live.forEach(o => { if (o.sx < bx0) bx0 = o.sx; if (o.sx > bx1) bx1 = o.sx; });
    const lEdge = clamp(bx0 - GUT, PAD + wide, W * 0.55);
    const rEdge = clamp(bx1 + GUT, W * 0.45, W - PAD - wide);
    live.forEach(o => {
        const E = partEls[o.i], put = placed[o.i];
        if (!put) return;
        E.d.style.display = ''; E.ln.style.display = ''; E.dot.style.display = '';
        E.d.classList.toggle('r', o.side === 0);
        E.d.style.top = put.ly + 'px';
        E.d.style.left = (o.side ? rEdge : lEdge) + 'px';
        const from = o.side ? rEdge - 6 : lEdge + 6;
        E.ln.setAttribute('x1', from); E.ln.setAttribute('y1', put.ly);
        E.ln.setAttribute('x2', o.sx); E.ln.setAttribute('y2', o.sy);
        E.dot.setAttribute('cx', o.sx); E.dot.setAttribute('cy', o.sy);
    });
}

// =============================================================
//  Controls
// =============================================================
const SLIDERS = ['feed', 'lift', 'tilt', 'thick', 'rip'];
function bindSlider(key, after) {
    const s = $('s-' + key), out = $('v-' + key);
    if (!s) return;
    s.addEventListener('input', () => {
        P[key] = parseFloat(s.value);
        if (out) out.textContent = P[key];
        if (after) after();
    });
}
SLIDERS.forEach(k => bindSlider(k, k === 'thick' || k === 'rip' ? () => {
    // the board itself changed, so it has to be rebuilt — but only when
    // the blade is out of it, or the geometry would change mid-cut
    if (!state.running) { state.fed = 0; state.done = false; buildBoard(); }
} : null));

function paintSeg(sel, attr, val) {
    document.querySelectorAll(sel).forEach(b => {
        const on = b.dataset[attr] === String(val);
        b.classList.toggle('bg-slate-900', on);
        b.classList.toggle('text-white', on);
        b.classList.toggle('bg-white', !on);
        b.classList.toggle('text-slate-900', !on);
    });
}
document.querySelectorAll('.mseg').forEach(b => b.addEventListener('click', () => {
    state.mat = b.dataset.mat;
    paintSeg('.mseg', 'mat', state.mat);
    cue(aPlace);
    if (!state.running) { state.fed = 0; state.done = false; freshBoard(); buildBoard(); }
}));
document.querySelectorAll('.oseg').forEach(b => b.addEventListener('click', () => {
    state.op = b.dataset.op;
    paintSeg('.oseg', 'op', state.op);
    if (!state.running) { state.fed = 0; state.done = false; freshBoard(); buildBoard(); }
}));
document.querySelectorAll('.bseg').forEach(b => b.addEventListener('click', () => {
    state.blade = parseInt(b.dataset.blade, 10);
    paintSeg('.bseg', 'blade', state.blade);
    buildTeeth();
}));
document.querySelectorAll('.vseg').forEach(b => b.addEventListener('click', () => {
    setView(b.dataset.view);
    document.querySelectorAll('.vseg').forEach(x => x.classList.toggle('on', x === b));
}));

$('btn-power').addEventListener('click', () => {
    state.power = !state.power;
    // no soundStop here: the blade coasts for seconds after the switch
    // and the motor loop has to fade with it, not be cut and restarted
    if (!state.power) { state.running = false; }
    paintRun();
});
$('btn-start').addEventListener('click', () => { startCut(); paintRun(); });
// Hold stops the FEED, not the blade - which is what a hand coming off
// the timber does. It always worked; what it did not do was say so, and
// a control that changes nothing you can see is a control that is not
// working as far as anyone using it is concerned. Now the board stops
// with a line to explain why it has.
$('btn-stop').addEventListener('click', () => {
    state.paused = !state.paused;
    if (state.paused) {
        flash('Paused.', 'The whole machine is stopped where it stands - blade, feed '
                       + 'and all. Turn the model round and look at the cut, then '
                       + 'press Resume.');
        soundStop();
    }
    paintRun();
});
$('btn-reset').addEventListener('click', () => { resetAll(); paintRun(); });

function paintRun() {
    const p = $('btn-power');
    p.classList.toggle('bg-rose-600', state.power);
    p.classList.toggle('text-white', state.power);
    p.classList.toggle('border-rose-700', state.power);
    p.classList.toggle('bg-white', !state.power);
    p.classList.toggle('text-slate-900', !state.power);
    $('txt-power').textContent = state.power ? 'Stop' : 'Start';
    const s = $('btn-start');
    s.disabled = !state.power || state.running;
    s.classList.toggle('opacity-40', s.disabled);
    s.classList.toggle('cursor-not-allowed', s.disabled);
    // and it reads as paused while it is
    const h = $('btn-stop'), on = state.paused;
    h.classList.toggle('bg-amber-500', on);
    h.classList.toggle('text-white', on);
    h.classList.toggle('border-amber-600', on);
    h.classList.toggle('bg-white', !on);
    $('txt-hold').textContent = on ? 'Resume' : 'Pause';
}

// The supply lamp, the way the lathe carries one. Three states and they
// are not decoration: off is no supply, amber is live but not cutting -
// the state people forget the blade is still turning in - and green is
// actually working. The blade coasts for seconds after the switch, and
// the lamp is what says so.
function paintLamp() {
    if (!MAT.lamp) return;
    const spinning = state.rpm > 60;
    if (state.cutting) {                      // working
        MAT.lamp.color.setHex(0x1c8f4a);
        MAT.lamp.emissive.setHex(0x22c55e);
        MAT.lamp.emissiveIntensity = 1.6;
    } else if (state.power || spinning) {     // live - and that is the warning
        MAT.lamp.color.setHex(0x8f1c1c);
        MAT.lamp.emissive.setHex(0xef4444);
        MAT.lamp.emissiveIntensity = 1.4;
    } else {                                  // dead
        MAT.lamp.color.setHex(0x2b3038);
        MAT.lamp.emissive.setHex(0x000000);
    }
}

function paintChip(chip, on) {
    chip.classList.toggle('bg-slate-100', !on);
    chip.classList.toggle('text-slate-400', !on);
    chip.classList.toggle('bg-white', on);
    chip.classList.toggle('text-slate-900', on);
}
function bindChip(id, key, after) {
    const chk = $('chk-' + id), chip = $('chip-' + id);
    if (!chk) return;
    chk.addEventListener('change', () => {
        state[key] = chk.checked;
        paintChip(chip, chk.checked);
        if (after) after();
    });
    paintChip(chip, chk.checked);
}
bindChip('dust', 'dust', () => { if (!state.dust) clearDust(); });
bindChip('sound', 'sound', () => { if (!state.sound) soundStop(); });
bindChip('cabinet', 'cabinet');
bindChip('mesh', 'mesh', applyMesh);
bindChip('spin', 'turntable');
bindChip('parts', 'parts', () => {
    $('parts').classList.toggle('hidden', !state.parts);
});
const vm = $('chk-view-mode');
if (vm) vm.addEventListener('change', () => {
    state.viewMode = vm.checked ? 'blueprint' : 'light';
    $('txt-view-mode').textContent = vm.checked ? 'Dark' : 'Light';
    paintChip($('chip-view-mode'), vm.checked);
    applyTheme();
});

// the info sheet
const info = $('info-modal');
if (info) {
    $('btn-info').addEventListener('click', () => info.classList.remove('hidden'));
    $('btn-info-close').addEventListener('click', () => info.classList.add('hidden'));
    info.addEventListener('click', e => { if (e.target === info) info.classList.add('hidden'); });
}

// =============================================================
//  Show and hide the control panel
// =============================================================
const panel = $('panel');
function measurePanel() {
    if (!panel) return;
    document.documentElement.style.setProperty('--panel-h',
        (document.body.classList.contains('controls-off') ? 0 : panel.offsetHeight) + 'px');
}
$('btn-hide').addEventListener('click', () => {
    document.body.classList.add('controls-off'); measurePanel(); resizeView();
});
$('btn-show').addEventListener('click', () => {
    document.body.classList.remove('controls-off'); measurePanel(); resizeView();
});
window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        if (info && !info.classList.contains('hidden')) { info.classList.add('hidden'); return; }
        document.body.classList.toggle('controls-off'); measurePanel(); resizeView();
    }
    // Press C to read the camera off the screen. Turning the machine to a
    // view you like and then having to work out where the camera ended up
    // means opening the console; this prints it in the message bar and
    // copies it, so a view worth keeping can just be written down.
    if ((e.key === 'c' || e.key === 'C') && gl) {
        const r = v => Math.round(v);
        const txt = '{ pos: [' + r(camera.position.x) + ', ' + r(camera.position.y)
                  + ', ' + r(camera.position.z) + '], tgt: [' + r(controls.target.x)
                  + ', ' + r(controls.target.y) + ', ' + r(controls.target.z) + '] }';
        lastAlarm = null;                       // say it even if it repeats
        setAlarm('info', 'Camera', txt);
        flashMsg = { title: 'Camera', body: txt };
        flashUntil = state.elapsed + 20;
        try { navigator.clipboard.writeText(txt); } catch (err) {}
        console.log(txt);
    }
});
window.addEventListener('resize', measurePanel);

function hideLoader() {
    const el = $('loader');
    if (el) el.classList.add('gone');
}
setTimeout(hideLoader, 8000);

window.onload = function () {
    try {
        init3D();
        gl = true;
        controls.addEventListener('start', () =>
            document.querySelectorAll('.vseg').forEach(b => b.classList.remove('on')));
    } catch (e) {
        console.warn('3D unavailable:', e);
        const n = $('nogl');
        n.classList.remove('hidden'); n.classList.add('flex');
    }
    initAudio();
    SLIDERS.forEach(k => {
        const s = $('s-' + k), o = $('v-' + k);
        if (s) s.value = P[k];
        if (o) o.textContent = P[k];
    });
    paintSeg('.mseg', 'mat', state.mat);
    paintSeg('.oseg', 'op', state.op);
    paintSeg('.bseg', 'blade', state.blade);
    paintRun();
    applyMesh();
    applyTheme();
    resizeView();
    measurePanel();
    requestAnimationFrame(hideLoader);
    setTimeout(hideLoader, 400);
    requestAnimationFrame(frame);
};
