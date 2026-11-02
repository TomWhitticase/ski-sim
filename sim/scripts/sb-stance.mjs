// Snowboard stance capture + joint measurement harness.
// Drives SkierModel.apply() directly on les-2-alpes (webgl), reads named joints in the
// slope-aligned skier frame, computes stance metrics, and shoots 4 angles per situation.
//   node scripts/sb-stance.mjs <label>     (label = before | after)
// Writes PNGs + measure-<label>.json to ~/reports/snowboard/stance-shots/.
import pkg from '@playwright/test';
const { chromium } = pkg;
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.env.SIM_PORT ?? 5195;
const LABEL = process.argv[2] ?? 'before';
const dir = `/home/tom0101001/reports/snowboard/stance-shots`;
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=vulkan'],
});
const page = await browser.newPage({ viewport: { width: 860, height: 860 } });
page.on('console', (m) => {
  const t = m.text();
  if (/error|fail|exception/i.test(t)) console.log('  [page]', t);
});
await page.addInitScript(() => {
  Object.defineProperty(Document.prototype, 'pointerLockElement', {
    get: () => document.querySelector('#scene'),
  });
  localStorage.setItem('ski-sim.mode', 'ski');
  localStorage.setItem('ski-sim.view', 'chase');
  localStorage.setItem('ski-sim.discipline', 'snowboard');
  localStorage.setItem(
    'ski-sim.labels',
    JSON.stringify({ lift: false, peak: false, restaurant: false, pistes: false }),
  );
});
await page.goto(
  `http://localhost:${PORT}/?resort=les-2-alpes&webgl=1&at=45.00895,6.17065,2583&heading=0&pitch=-8`,
);
await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 20, null, { timeout: 90_000 });
await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.__sim.renderer.setAnimationLoop(null);
  const hud = document.querySelector('#hud');
  if (hud) hud.style.display = 'none';
});

// up = balance line in the slope-aligned frame; +x leans toward the toe edge (regular).
const d2r = Math.PI / 180;
const lean = (deg) => ({ x: Math.sin(deg * d2r), y: Math.cos(deg * d2r), z: 0 });
const base = {
  crouch: 0.25,
  foreAft: 0,
  twist: 0,
  armReach: 0,
  lean: 0,
  poleSweep: 0,
  skatePhase: 0,
  polePhase: 0,
  grip: null,
  sit: null,
  left: { x: 0, y: 0, z: 0, yaw: 0, roll: 0, lift: 0 },
  right: { x: 0, y: 0, z: 0, yaw: 0, roll: 0, lift: 0 },
};
const AM = {
  stance: 'regular',
  length: 156,
  waist: 252,
  radius: 8,
  flex: 6,
  angleFront: 15,
  angleBack: -6,
};
const DUCK = { ...AM, angleFront: 15, angleBack: -15 };
const CARVE = {
  stance: 'regular',
  length: 160,
  waist: 244,
  radius: 7,
  flex: 9,
  angleFront: 27,
  angleBack: 15,
};

const SITUATIONS = [
  { name: 'neutral', setup: AM, stance: { ...base, crouch: 0.25 }, up: lean(3) },
  { name: 'neutral-duck', setup: DUCK, stance: { ...base, crouch: 0.25 }, up: lean(3) },
  { name: 'traverse-heelside', setup: AM, stance: { ...base, crouch: 0.3 }, up: lean(-22) },
  { name: 'traverse-toeside', setup: AM, stance: { ...base, crouch: 0.3 }, up: lean(22) },
  { name: 'carve-heelside', setup: AM, stance: { ...base, crouch: 0.55 }, up: lean(-48) },
  { name: 'carve-toeside', setup: AM, stance: { ...base, crouch: 0.55 }, up: lean(48) },
  { name: 'carve-heelside-duck', setup: DUCK, stance: { ...base, crouch: 0.55 }, up: lean(-48) },
  { name: 'carve-alpine', setup: CARVE, stance: { ...base, crouch: 0.5 }, up: lean(52) },
  {
    name: 'ollie',
    setup: AM,
    stance: { ...base, crouch: 0.2, foreAft: -0.9, armReach: 0.4 },
    up: lean(0),
  },
  { name: 'air-tuck', setup: AM, stance: { ...base, crouch: 0.8, armReach: 0.1 }, up: lean(6) },
  {
    name: 'lift',
    setup: AM,
    stance: { ...base, crouch: 0.1, sit: { amount: 1, height: 0.5, back: -0.15 } },
    up: { x: 0, y: 1, z: 0 },
  },
];

// Camera offsets in the rider's local (slope-aligned) frame. Nose at -z (regular); the rider
// faces the toe edge at +x. front = from the toe/downhill side; behind = heel edge.
const ANGLES = {
  side: [0.15, 0.3, -1.0], // down the board from the nose
  front: [1.0, 0.25, -0.12], // from the toe edge (rider's chest)
  behind: [-1.0, 0.3, -0.12], // from the heel edge (rider's back)
  threeq: [0.85, 0.32, -0.62], // 3/4 from the nose-toe corner
};

const measurements = {};

for (const sit of SITUATIONS) {
  // Configure the board setup, apply the pose, read joints, compute metrics.
  const m = await page.evaluate(
    ({ sit }) => {
      const sim = window.__sim;
      const model = sim.ski.model;
      model.setSnowboard(true, sit.setup.stance === 'regular');
      model.setBoardSetup(sit.setup);
      model.apply(sit.stance, sit.up);
      model.root.updateMatrixWorld(true);

      // Everything into the root-local (slope-aligned) frame.
      const Vec = model.root.position.constructor;
      const Quat = model.root.quaternion.constructor;
      const rootInv = model.root.matrixWorld.clone().invert();
      const V = (x, y, z) => new Vec(x, y, z);
      const byName = {};
      model.root.traverse((o) => {
        if (o.name) byName[o.name] = o;
      });
      const localPos = (o) => o.getWorldPosition(new Vec()).applyMatrix4(rootInv);
      // local rotation-only: world quat then strip root's world rotation
      const rootQ = new Quat();
      model.root.getWorldQuaternion(rootQ);
      const rootQi = rootQ.clone().invert();
      const localAxis = (o, ax) => {
        const q = new Quat();
        o.getWorldQuaternion(q);
        return ax.clone().applyQuaternion(q).applyQuaternion(rootQi).normalize();
      };
      // A stretched bone: midpoint, dir = +Y rotated, length = scale.y. from = mid - dir*L/2.
      const boneEnds = (mesh) => {
        const mid = localPos(mesh);
        const dir = localAxis(mesh, V(0, 1, 0));
        const L = mesh.scale.y;
        return {
          from: mid.clone().addScaledVector(dir, -L / 2),
          to: mid.clone().addScaledVector(dir, L / 2),
          L,
        };
      };
      const deg = (r) => (r * 180) / Math.PI;
      const angleBetween = (a, b) => deg(a.angleTo(b));
      const azimuth = (v) => deg(Math.atan2(v.x, -v.z)); // 0 = nose(-z), +90 = toe edge(+x)

      const out = { situation: sit.name, legs: {}, torso: {}, arms: {}, misc: {} };
      const ankles = {};
      const knees = {};
      const hips = {};
      for (const sfx of ['left', 'right']) {
        const thigh = boneEnds(byName[`thigh-${sfx}`]);
        const shin = boneEnds(byName[`shin-${sfx}`]);
        const hip = thigh.from;
        const knee = localPos(byName[`knee-${sfx}`]);
        const ankle = shin.to;
        hips[sfx] = hip;
        knees[sfx] = knee;
        ankles[sfx] = ankle;
        // Foot toe (forward) direction from the ski/boot group.
        const ski = byName[`ski-${sfx}`];
        const toeDir = localAxis(ski, V(0, 0, -1)); // boot local -z = toe
        const toeFlat = V(toeDir.x, 0, toeDir.z).normalize();
        // Knee tracking: horizontal direction of the shin lean (ankle -> knee).
        const shinVec = knee.clone().sub(ankle);
        const shinFlat = V(shinVec.x, 0, shinVec.z);
        const kneeFlex = angleBetween(hip.clone().sub(knee), ankle.clone().sub(knee)); // 180 = straight
        out.legs[sfx] = {
          kneeFlexDeg: +kneeFlex.toFixed(1),
          shinLeanAzimuth: +azimuth(shinFlat).toFixed(1),
          footToeAzimuth: +azimuth(toeFlat).toFixed(1),
          kneeOverToeErrDeg: +(azimuth(shinFlat) - azimuth(toeFlat)).toFixed(1),
          kneeHeight: +knee.y.toFixed(3),
          ankleHeight: +ankle.y.toFixed(3),
          hip: [hip.x, hip.y, hip.z].map((n) => +n.toFixed(3)),
          knee: [knee.x, knee.y, knee.z].map((n) => +n.toFixed(3)),
          ankle: [ankle.x, ankle.y, ankle.z].map((n) => +n.toFixed(3)),
        };
      }
      // Knee separation: are knees splayed apart (toward edges) or tracking? x = toe/heel axis.
      out.misc.stanceWidth = +ankles.left.distanceTo(ankles.right).toFixed(3);
      out.misc.ankleWidthXZ = +Math.hypot(
        ankles.left.x - ankles.right.x,
        ankles.left.z - ankles.right.z,
      ).toFixed(3);
      out.misc.kneeGapX = +(knees.left.x - knees.right.x).toFixed(3); // toe/heel spread between knees
      out.misc.kneeGapZ = +(knees.left.z - knees.right.z).toFixed(3); // nose/tail spread between knees
      // Torso.
      const chest = byName['chest'];
      const chestUp = localAxis(chest, V(0, 1, 0));
      const chestFwd = localAxis(chest, V(0, 0, -1)); // chest-forward = toe/downhill
      const shoulderVec = V(-1, 0, 0)
        .applyQuaternion(
          (() => {
            const q = new Quat();
            chest.getWorldQuaternion(q);
            return q;
          })(),
        )
        .applyQuaternion(rootQi); // +x chest = tail shoulder, -x = nose shoulder; line across
      out.torso = {
        chestPitchFromVertical: +angleBetween(chestUp, V(0, 1, 0)).toFixed(1),
        chestForwardAzimuth: +azimuth(V(chestFwd.x, 0, chestFwd.z)).toFixed(1),
        shoulderLineAzimuth: +azimuth(V(shoulderVec.x, 0, shoulderVec.z)).toFixed(1),
      };
      const head = byName['head'];
      const headFwd = localAxis(head, V(0, 0, -1));
      out.misc.headForwardAzimuth = +azimuth(V(headFwd.x, 0, headFwd.z)).toFixed(1);
      // Arms.
      for (const sfx of ['left', 'right']) {
        const ua = boneEnds(byName[`upperarm-${sfx}`]);
        const fa = boneEnds(byName[`forearm-${sfx}`]);
        const shoulder = ua.from;
        const elbow = localPos(byName[`elbow-${sfx}`]);
        const wrist = fa.to;
        const elbowFlex = angleBetween(shoulder.clone().sub(elbow), wrist.clone().sub(elbow));
        out.arms[sfx] = {
          elbowFlexDeg: +elbowFlex.toFixed(1),
          handHeightAboveAnkle: +(wrist.y - ankles[sfx].y).toFixed(3),
          hand: [wrist.x, wrist.y, wrist.z].map((n) => +n.toFixed(3)),
        };
      }
      return out;
    },
    { sit },
  );
  measurements[sit.name] = m;

  // Screenshots from each angle.
  for (const [an, cd] of Object.entries(ANGLES)) {
    await page.evaluate(
      async ({ cd }) => {
        const sim = window.__sim;
        const model = sim.ski.model;
        const Vec = model.root.position.constructor;
        model.root.updateMatrixWorld(true);
        const DIST = 2.4;
        const TARGET_Y = 0.6;
        const centreLocal = new Vec(0, TARGET_Y, 0);
        const centre = centreLocal.clone().applyMatrix4(model.root.matrixWorld);
        const n = Math.hypot(cd[0], cd[1], cd[2]);
        const offLocal = new Vec(
          (cd[0] / n) * DIST,
          TARGET_Y + (cd[1] / n) * DIST,
          (cd[2] / n) * DIST,
        );
        const camPos = offLocal.applyMatrix4(model.root.matrixWorld);
        const cam = sim.camera;
        cam.position.copy(camPos);
        cam.lookAt(centre);
        cam.updateMatrixWorld(true);
        await sim.renderer.renderAsync(sim.scene, sim.camera);
      },
      { cd },
    );
    await page.waitForTimeout(60);
    await page.screenshot({ path: `${dir}/${LABEL}-${sit.name}-${an}.png` });
  }
  console.log('shot', sit.name);
}

writeFileSync(`${dir}/measure-${LABEL}.json`, JSON.stringify(measurements, null, 2));
console.log('wrote measurements for', Object.keys(measurements).length, 'situations');
await browser.close();
console.log('done', LABEL);
