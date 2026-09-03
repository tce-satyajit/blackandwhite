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
const TH_MAX = 68 * Math.PI / 180;

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

const DEFAULTS = { load: 600, offset: 0, bore: 80, flow: 8, relief: 250 };
const P = Object.assign({}, DEFAULTS);

const state = {
    th: TH_MIN,                        // the one variable the machine has
    cmd: 0,                            // -1 lowering, 0 holding, +1 raising
    crate: true, forces: true, sound: true, mesh: false, turntable: false,
    warn: 0,                           // seconds of warning still to sound
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
const WHEEL_R = 95;
const BASE_Y0 = 50;                   // the chassis hangs low between the wheels
const BASE_H = 190;
const PIVOT_Y = BASE_Y0 + BASE_H;     // the line the scissor is pinned on
const FIX_X = -ARM_L / 2;             // the fixed pivots, which never move
const DECK_T = 90;
const BASE_X = 640, BASE_Z = 430;
const DECK_X = 750, DECK_Z = 450;
const ARM_Z_OUT = 355, ARM_Z_IN = 295;
const RAM_Z = 150;
const ARM_W = 96, ARM_T = 26;         // the flat bar an arm is cut from

let scene, camera, renderer, controls;
let floor3, grid3, liftGrp;
let armsL = [], armsU = [], deckGrp, crateGrp;
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

// The maker's plate on the skirt. Every lift table in the world carries
// one, usually with the things you are not allowed to forget on it.
let badgeTex = null;
function badgeTexture() {
    if (badgeTex) return badgeTex;
    const c = document.createElement('canvas');
    c.width = 680; c.height = 124;
    const g = c.getContext('2d');
    g.fillStyle = '#1d2024'; g.fillRect(0, 0, 680, 124);
    g.strokeStyle = '#d7dde4'; g.lineWidth = 4; g.strokeRect(8, 8, 664, 108);
    g.textBaseline = 'middle';
    g.fillStyle = '#f2f5f9';
    g.font = 'bold 58px Inter, Helvetica, Arial, sans-serif';
    g.fillText('TCE', 34, 58);
    g.fillStyle = '#7ed957';
    g.fillText('LIFT', 140, 58);
    g.fillStyle = '#aebdcc';
    g.font = '22px Inter, Helvetica, Arial, sans-serif';
    g.fillText('2000 kg  \u00b7  2.0 m  \u00b7  250 bar', 34, 98);
    badgeTex = new THREE.CanvasTexture(c);
    return badgeTex;
}

// The name, big enough to read off the front of the machine.
let logoTex = null;
function logoTexture() {
    if (logoTex) return logoTex;
    const c = document.createElement('canvas');
    c.width = 720; c.height = 152;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 720, 152);
    g.textBaseline = 'middle';
    g.font = 'bold 96px Inter, Helvetica, Arial, sans-serif';
    g.fillStyle = 'rgba(24,16,4,0.5)';
    g.fillText('TCE', 30, 82);
    g.fillStyle = '#16181c';
    g.fillText('TCE', 26, 78);
    const w = g.measureText('TCE').width;
    g.fillStyle = 'rgba(24,16,4,0.5)';
    g.fillText('-LABS', 30 + w, 82);
    g.fillStyle = '#7ed957';
    g.fillText('-LABS', 26 + w, 78);
    logoTex = new THREE.CanvasTexture(c);
    logoTex.anisotropy = 8;
    return logoTex;
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
    key.shadow.camera.top = 2600; key.shadow.camera.bottom = -400;
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

    // Plant yellow over steel - the colour anything that moves under a
    // load in a yard gets painted, for the same reason a hi-vis jacket is.
    MAT.body     = new THREE.MeshStandardMaterial({ color: 0xd9a516, metalness: 0.30, roughness: 0.42 });
    MAT.bodyDark = new THREE.MeshStandardMaterial({ color: 0xa87c0c, metalness: 0.32, roughness: 0.48 });
    MAT.steel    = new THREE.MeshStandardMaterial({ color: 0x99a2ad, metalness: 0.90, roughness: 0.26 });
    MAT.chrome   = new THREE.MeshStandardMaterial({ color: 0xc9cfd7, metalness: 0.98, roughness: 0.055 });
    MAT.rubber   = new THREE.MeshStandardMaterial({ color: 0x22252a, metalness: 0.04, roughness: 0.88 });
    // Solid polyurethane, not rubber: pale, hard and slightly glossy.
    MAT.tyre     = new THREE.MeshStandardMaterial({ color: 0xc6c9cc, metalness: 0.05, roughness: 0.55 });
    MAT.panel    = new THREE.MeshStandardMaterial({ color: 0x8f3226, metalness: 0.25, roughness: 0.52 });
    MAT.motor    = new THREE.MeshStandardMaterial({ color: 0x2d323a, metalness: 0.52, roughness: 0.44 });
    MAT.tank     = new THREE.MeshStandardMaterial({ color: 0x3c434c, metalness: 0.62, roughness: 0.34 });
    MAT.deck     = new THREE.MeshStandardMaterial({ color: 0xb4bac2, metalness: 0.66, roughness: 0.36 });
    MAT.crate    = new THREE.MeshStandardMaterial({ color: 0xa87a42, metalness: 0.05, roughness: 0.62 });
    MAT.hose     = new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.2, roughness: 0.7 });
    // Hazard striping only works as a pair. On a yellow machine the
    // stripes are the black half.
    MAT.warn     = new THREE.MeshStandardMaterial({ color: 0x191b1e, metalness: 0.2, roughness: 0.55 });
    MAT.logo     = new THREE.MeshStandardMaterial({ color: 0xffffff, map: logoTexture(),
                                                    metalness: 0.15, roughness: 0.5,
                                                    transparent: true, alphaTest: 0.25,
                                                    side: THREE.DoubleSide });
    MAT.badge    = new THREE.MeshStandardMaterial({ color: 0xffffff, map: badgeTexture(),
                                                    metalness: 0.2, roughness: 0.5,
                                                    transparent: true, side: THREE.DoubleSide });
    MAT.forceRam = new THREE.MeshStandardMaterial({ color: 0x8b5cf6, metalness: 0.2, roughness: 0.4,
                                                    emissive: 0x4c1d95, emissiveIntensity: 0.35 });
    MAT.forceW   = new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.2, roughness: 0.4,
                                                    emissive: 0x92400e, emissiveIntensity: 0.35 });
    MAT.beacon   = new THREE.MeshStandardMaterial({ color: 0xb01810, roughness: 0.25, metalness: 0.1,
                                                    emissive: 0xff2a12, emissiveIntensity: 0.1,
                                                    transparent: true, opacity: 0.92 });

    MAT.body.envMapIntensity = 0.85;
    MAT.bodyDark.envMapIntensity = 0.75;
    MAT.steel.envMapIntensity = 1.5;
    MAT.chrome.envMapIntensity = 2.4;
    MAT.deck.envMapIntensity = 1.2;
    MAT.motor.envMapIntensity = 0.8;
    MAT.tank.envMapIntensity = 1.0;
    MAT.rubber.envMapIntensity = 0.2;
    MAT.tyre.envMapIntensity = 0.5;
    MAT.panel.envMapIntensity = 0.7;

    buildLift();
}

// =============================================================
//  Building it
// =============================================================
function buildLift() {
    liftGrp = new THREE.Group();
    scene.add(liftGrp);
    buildBase();
    buildWheels();
    buildPowerPack();
    buildBeacon();
    buildScissor();
    buildRams();
    buildDeck();
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

        // The access panel, let into the side. Everything that ever needs
        // a spanner on it is behind one of these.
        const panel = new THREE.Mesh(roundedBox(540, BASE_H - 62, 12, 8), MAT.panel);
        panel.position.set(60, yMid, s2 * (BASE_Z + 1));
        g.add(panel);
        [-1, 1].forEach(sx => {
            const screw = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 10, 12), MAT.steel);
            screw.rotation.x = Math.PI / 2;
            screw.position.set(60 + sx * 240, yMid, s2 * (BASE_Z + 8));
            g.add(screw);
        });

        const logo = new THREE.Mesh(new THREE.PlaneGeometry(360, 76), MAT.logo);
        logo.position.set(-390, yMid + 6, s2 * (BASE_Z + 3));
        logo.rotation.y = s2 > 0 ? 0 : Math.PI;
        g.add(logo);

        // a rubbing strip along the bottom, which is what actually meets
        // the pallet, the kerb and everything else it gets pushed into
        const bump = new THREE.Mesh(roundedBox(BASE_X * 2 + 30, 34, 26, 8), MAT.bodyDark);
        bump.position.set(0, BASE_Y0 + 18, s2 * (BASE_Z + 10));
        bump.castShadow = true;
        g.add(bump);

        // the track the lower roller runs along
        const track = new THREE.Mesh(roundedBox(BASE_X * 1.7, 22, 34, 5), MAT.steel);
        track.position.set(60, PIVOT_Y - 10, s2 * (BASE_Z - 75));
        g.add(track);
    });

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
function buildWheels() {
    [-1, 1].forEach(sx => [-1, 1].forEach(sz => {
        const g = new THREE.Group();

        const tyre = new THREE.Mesh(new THREE.LatheGeometry([
            new THREE.Vector2(34, -34), new THREE.Vector2(WHEEL_R - 16, -34),
            new THREE.Vector2(WHEEL_R - 3, -26), new THREE.Vector2(WHEEL_R, -12),
            new THREE.Vector2(WHEEL_R, 12), new THREE.Vector2(WHEEL_R - 3, 26),
            new THREE.Vector2(WHEEL_R - 16, 34), new THREE.Vector2(34, 34)
        ], 34), MAT.tyre);
        tyre.rotation.x = Math.PI / 2;
        tyre.castShadow = true;
        g.add(tyre);

        const rim = new THREE.Mesh(new THREE.CylinderGeometry(38, 38, 72, 26), MAT.motor);
        rim.rotation.x = Math.PI / 2;
        rim.castShadow = true;
        g.add(rim);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(19, 19, 80, 18), MAT.steel);
        cap.rotation.x = Math.PI / 2;
        g.add(cap);
        for (let i = 0; i < 5; i++) {            // the bolts round the hub
            const a = i * Math.PI * 2 / 5;
            const b = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 78, 10), MAT.steel);
            b.rotation.x = Math.PI / 2;
            b.position.set(Math.cos(a) * 27, Math.sin(a) * 27, 0);
            g.add(b);
        }

        // the stub axle back into the chassis, and its mounting boss
        const stub = new THREE.Mesh(new THREE.CylinderGeometry(26, 26, 90, 16), MAT.steel);
        stub.rotation.x = Math.PI / 2;
        stub.position.z = -sz * 62;
        g.add(stub);
        const boss = new THREE.Mesh(roundedBox(120, 120, 26, 12), MAT.bodyDark);
        boss.position.z = -sz * 100;
        boss.castShadow = true;
        g.add(boss);

        g.position.set(sx * WHEEL_X, WHEEL_R, sz * (BASE_Z + 62));
        liftGrp.add(g);
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
function makeArm(mat) {
    const g = new THREE.Group();
    const b = new THREE.Mesh(roundedBox(ARM_L, ARM_W, ARM_T, 18), mat);
    b.castShadow = b.receiveShadow = true;
    g.add(b);
    [-1, 1].forEach(s => {                 // a boss at each pin
        const boss = new THREE.Mesh(new THREE.CylinderGeometry(ARM_W / 2, ARM_W / 2, ARM_T + 6, 22), mat);
        boss.rotation.x = Math.PI / 2;
        boss.position.x = s * ARM_L / 2;
        boss.castShadow = true;
        g.add(boss);
        const hole = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, ARM_T + 14, 16), MAT.steel);
        hole.rotation.x = Math.PI / 2;
        hole.position.x = s * ARM_L / 2;
        g.add(hole);
    });
    return g;
}

function makeRoller() {
    const g = new THREE.Group();
    const w = new THREE.Mesh(new THREE.CylinderGeometry(38, 38, 44, 22), MAT.steel);
    w.rotation.x = Math.PI / 2;
    w.castShadow = true;
    g.add(w);
    const t = new THREE.Mesh(new THREE.TorusGeometry(38, 7, 8, 24), MAT.rubber);
    g.add(t);
    return g;
}

// The flashing beacon. Every lift and every crane carries one, and it
// says one thing only: this machine is about to move, or is moving.
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
    // a real light too, so the flash lands on the machine around it
    beaconLight = new THREE.PointLight(0xff3018, 0, 1400, 2);
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
            [['A', zA, MAT.body], ['B', zB, MAT.bodyDark]].forEach(([kind, z, mat]) => {
                const m = makeArm(mat);
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
            const pn = pin(0, 0, s * (ARM_Z_OUT + ARM_Z_IN) / 2, 20, ARM_T * 2 + 26, MAT.steel);
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
    const badge = new THREE.Mesh(new THREE.PlaneGeometry(340, 62), MAT.badge);
    badge.position.set(-380, 42, DECK_Z + 2);
    deckGrp.add(badge);
    // hazard striping on the deck edge, which is what these actually wear
    for (let i = 0; i < 9; i++) {
        const st = new THREE.Mesh(roundedBox(46, 22, 6, 2), MAT.warn);
        st.position.set(300 + i * 52, 74, DECK_Z + 2);
        st.rotation.z = -0.5;
        deckGrp.add(st);
    }
    liftGrp.add(deckGrp);

    crateGrp = new THREE.Group();
    const box = new THREE.Mesh(roundedBox(560, 420, 560, 10), MAT.crate);
    box.position.y = 210;
    box.castShadow = box.receiveShadow = true;
    crateGrp.add(box);
    [-1, 1].forEach(s => {
        const strap = new THREE.Mesh(roundedBox(566, 34, 60, 4), MAT.steel);
        strap.position.set(0, 210, s * 200);
        crateGrp.add(strap);
    });
    liftGrp.add(crateGrp);
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
    crateGrp.position.set(P.offset, y2 + DECK_T, 0);
    crateGrp.visible = state.crate;

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
        arrowLoad.position.set(P.offset, y2 + DECK_T + (state.crate ? 430 : 0) + len + 80, 0);
        arrowLoad.rotation.z = 0;
    }

    // The beacon: on through the warning and all the while it moves,
    // dark the moment it is holding. Two flashes a second, which is what
    // these actually run at.
    if (beaconLamp) {
        const live = state.cmd !== 0 || state.warn > 0;
        const on = live && Math.sin(performance.now() / 1000 * Math.PI * 4) > 0;
        beaconLamp.material.emissiveIntensity = on ? 2.4 : 0.08;
        beaconLight.intensity = on ? 2.2 : 0;
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
    wheel:   { pos: [820, 330, 800],    tgt: [420, 100, 400] },
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
    $('stat-v').textContent = (state.cmd > 0 && !stalled() ? deckSpeed()
                             : state.cmd < 0 ? -LOWER_SPEED * ratio(state.th) : 0).toFixed(0);
    $('stat-w').textContent = (state.cmd > 0 && !stalled() ? motorPower() / 1000 : 0).toFixed(1);
    paintAlarm();
}

function paintAlarm() {
    const el = $('alarm');
    let title = '', body = '', cls = '';
    if (tipping()) {
        title = 'Going over.';
        body = 'The load and the machine together now balance ' + Math.abs(cgX()).toFixed(0) +
               ' mm off centre, and the wheels are only ' + WHEEL_X + ' mm out. Bring the load in.';
        cls = 'bg-rose-50 border-rose-200 text-rose-800';
    } else if (state.cmd > 0 && stalled()) {
        title = 'Relief valve blowing off.';
        body = 'It needs ' + pressure().toFixed(0) + ' bar and the valve opens at ' + P.relief +
               '. The oil is going straight back to tank and the lift is not moving. It is worst ' +
               'down here - try a wider bore, or less load.';
        cls = 'bg-rose-50 border-rose-200 text-rose-800';
    } else if (state.th >= TH_MAX - 1e-4) {
        title = 'Fully up.';
        body = 'The deck is at ' + heightM().toFixed(2) + ' m and the arms have run out of angle.';
        cls = 'bg-sky-50 border-sky-200 text-sky-800';
    } else if (state.th <= TH_MIN + 1e-4 && state.cmd === 0) {
        title = 'Down and stowed.';
        body = 'The arms are nearly flat, which is where the rams have the least to work with. ' +
               'Watch the pressure as you start it up.';
        cls = 'bg-slate-50 border-slate-200 text-slate-700';
    }
    if (!title) { el.classList.add('hidden'); return; }
    el.className = 'absolute top-3 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-xl border shadow-md ' +
        'text-[calc(13px*var(--fs))] text-center max-w-lg ' + cls;
    $('alarm-title').textContent = title;
    $('alarm-body').textContent = body;
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

// Sounded the moment a direction is asked for, before any of it moves.
function warnAndGo(dir) {
    state.cmd = dir;
    state.warn = WARN_TIME;
    loopOff(aRaise); loopOff(aLower);
    oneShot(aBeep, 0.7);
}

function soundUpdate() {
    if (!aRaise) return;
    const moving = state.sound && state.warn <= 0;
    if (moving && state.cmd > 0 && !stalled()) {
        // The note rides with the pressure the load is asking for.
        loopOn(aRaise, 0.30 + 0.25 * clamp(pressure() / P.relief, 0, 1), 1);
    } else loopOff(aRaise);
    if (moving && state.cmd < 0) loopOn(aLower, 0.32, 1);
    else loopOff(aLower);
}
function soundStop() {
    [aBeep, aRaise, aLower].forEach(loopOff);
}

// =============================================================
//  Loop
// =============================================================
function step(dt) {
    // The warning runs first and the machine waits for it. This is the
    // order a real one does it in, and it is not decoration: people
    // stand next to these things.
    if (state.warn > 0) { state.warn = Math.max(0, state.warn - dt); return; }
    if (state.cmd > 0) {
        // Past the relief setting the valve opens and the oil goes round
        // in a circle. The motor works just as hard and nothing moves.
        if (stalled()) return;
        const dth = deckSpeed() * dt / (STAGES * ARM_L * Math.cos(state.th));
        state.th = Math.min(TH_MAX, state.th + dth);
        if (state.th >= TH_MAX) state.cmd = 0;
    } else if (state.cmd < 0) {
        // Coming down needs no pump at all: the load does the work and a
        // valve only decides how fast it is allowed to give it back.
        const dth = LOWER_SPEED * ratio(state.th) * dt / (STAGES * ARM_L * Math.cos(state.th));
        state.th = Math.max(TH_MIN, state.th - dth);
        if (state.th <= TH_MIN) state.cmd = 0;
    }
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
    soundStop();
    ['load', 'offset', 'bore', 'flow', 'relief'].forEach(k => {
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
['load', 'offset', 'bore', 'flow', 'relief'].forEach(k => bindSlider('s-' + k, k));

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
