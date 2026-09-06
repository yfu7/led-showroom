/**
 * Scene-wide behaviours that sit between the document and the renderers:
 *
 *  - attachment / riding: entities with `attachedTo = <stageId>` follow their stage (v1
 *    `syncWallPlatform`, index.html 7277-7345, generalised to any entity type and any number
 *    of riders), sit on the deck top when ground-lock is on, and drop to the floor when the
 *    stage is deleted. Riding happens in WORLD space: a rider or a stage that lives inside a
 *    group (`parentId`) is carried through the composed group transforms;
 *  - dimension entities are non-transformable (their transform is normalised to identity);
 *  - auto-rotate (turntable) drives the camera every frame;
 *  - the content-window selection defaults to a wall's first window;
 *  - `spanSource(doc)` — the source used by every wall in span-content mode.
 *
 * The document-shaping parts are PURE (`syncRiders`, `normaliseDimensions`, `applyBehaviours`)
 * and run inside `engine.addPostChange`, never through `engine.run`.
 */
import * as THREE from 'three';
import type { Engine } from './Engine';
import type { ContentSource, Document, Entity, StageEntity, Transform } from './document/types';
import { isDimension, isLedWall, isStage } from './document/types';
import { walls } from './document/Document';
import { jsonEq, round, type Vec3 } from './math';

export const AUTO_ROTATE_SPEED = 0.8;

/* ───────────────────────────── span content ───────────────────────────── */

/**
 * The content source shared by every wall in span mode: the first window of the first wall
 * that carries a source (`null` when no wall has content).
 */
export function spanSource(doc: Document): ContentSource | null {
  const first = walls(doc)[0];
  if (!first) return null;
  for (const w of first.contentWindows) if (w.source) return w.source;
  return null;
}

/* ───────────────────────────── riding ───────────────────────────── */

/** Deck-top y of a stage in the frame its transform is expressed in (stage origin = bottom centre of the deck). */
export function stageTopY(stage: StageEntity): number {
  return stage.transform.position[1] + stage.heightIn * stage.transform.scale[1];
}

const EPS = 1e-9;
const near = (a: number, b: number, eps = EPS): boolean => Math.abs(a - b) <= eps;
const DEG = Math.PI / 180;

function rotateY(v: Vec3, deg: number): Vec3 {
  if (deg === 0) return [v[0], v[1], v[2]];
  const r = deg * DEG, c = Math.cos(r), s = Math.sin(r);
  // three.js right-handed Y rotation: x' = x cos + z sin, z' = -x sin + z cos
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

/**
 * Horizontal offset of `position` from a leader that moved `p0` → `p1`, kept in the leader's own
 * frame: unrotated by the leader's old yaw, optionally scaled with the leader's horizontal scale
 * ratio, re-rotated by its new yaw. Returns the follower's new (x, z).
 */
function carryXZ(position: Vec3, p0: Transform, p1: Transform, withScale: boolean): [number, number] {
  const yaw0 = p0.rotation[1], yaw1 = p1.rotation[1];
  const world0: Vec3 = [position[0] - p0.position[0], 0, position[2] - p0.position[2]];
  const local = rotateY(world0, -yaw0);
  const sx = withScale && p0.scale[0] ? p1.scale[0] / p0.scale[0] : 1;
  const sz = withScale && p0.scale[2] ? p1.scale[2] / p0.scale[2] : 1;
  const scaled: Vec3 = [local[0] * sx, 0, local[2] * sz];
  const world1 = rotateY(scaled, yaw1);
  return [p1.position[0] + world1[0], p1.position[2] + world1[2]];
}

/**
 * Carry `rider` along with a stage that moved from `prev` to `next` (all three transforms
 * expressed in the same frame): the rider keeps its offset in the stage's local frame (yawed
 * and scaled horizontally with the deck), gains the stage's yaw delta and, unless `groundLock`
 * pins it to the deck top, the stage's vertical delta.
 */
export function rideTransform(rider: Transform, prev: StageEntity, next: StageEntity, groundLock: boolean): Transform {
  const p0 = prev.transform, p1 = next.transform;
  const yaw0 = p0.rotation[1], yaw1 = p1.rotation[1];
  const [x, z] = carryXZ(rider.position, p0, p1, true);
  const y = groundLock ? stageTopY(next) : rider.position[1] + (p1.position[1] - p0.position[1]);
  return {
    position: [x, y, z],
    rotation: [rider.rotation[0], rider.rotation[1] + (yaw1 - yaw0), rider.rotation[2]],
    scale: [rider.scale[0], rider.scale[1], rider.scale[2]],
  };
}

/**
 * The mirror of `rideTransform` (v1 `syncWallPlatform('wall')`, index.html 7277-7345 / A21): carry
 * a `stage` along with a rider that moved from `prev` to `next` (all three transforms in the same
 * frame). The deck keeps its offset in the rider's frame and gains the rider's yaw delta, so a
 * wall dragged or gizmo-moved on a deck takes the deck with it instead of sliding across it.
 *
 * Unlike riding, this is horizontal only: the deck keeps its own y (it rests on the floor, and a
 * rider lifted off the deck must not drag it up) and its own scale (v1 ignored wall scale too).
 */
export function carryTransform(stage: Transform, prev: Transform, next: Transform): Transform {
  const [x, z] = carryXZ(stage.position, prev, next, false);
  return {
    position: [x, stage.position[1], z],
    rotation: [stage.rotation[0], stage.rotation[1] + (next.rotation[1] - prev.rotation[1]), stage.rotation[2]],
    scale: [stage.scale[0], stage.scale[1], stage.scale[2]],
  };
}

/* ───────── hierarchy (parentId chains) ───────── */

/** Matrix of a document transform (same convention as `applyTransform`: degrees, Euler order YXZ). */
export function matrixOf(t: Transform): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'YXZ'));
  return new THREE.Matrix4().compose(new THREE.Vector3(t.position[0], t.position[1], t.position[2]), q, new THREE.Vector3(t.scale[0], t.scale[1], t.scale[2]));
}

/** Document transform of a matrix (decomposed; values rounded to a millionth to keep the JSON stable). */
export function transformOf(m: THREE.Matrix4): Transform {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
  const r = (v: number): number => round(v, 6) + 0; // + 0 folds -0 into 0
  return { position: [r(p.x), r(p.y), r(p.z)], rotation: [r(e.x / DEG), r(e.y / DEG), r(e.z / DEG)], scale: [r(s.x), r(s.y), r(s.z)] };
}

/** Composed matrix of an entity's parent chain (identity for top-level entities; cycles and dangling ids stop the chain). */
export function parentMatrix(e: Entity, byId: Map<string, Entity>): THREE.Matrix4 {
  const chain: Entity[] = [];
  const seen = new Set<string>([e.id]);
  for (let p = e.parentId ? byId.get(e.parentId) : undefined; p && !seen.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) {
    seen.add(p.id);
    chain.push(p);
  }
  const m = new THREE.Matrix4();
  for (let i = chain.length - 1; i >= 0; i--) m.multiply(matrixOf(chain[i].transform));
  return m;
}

/** World matrix of an entity (parent chain × own transform). */
export function worldMatrix(e: Entity, byId: Map<string, Entity>): THREE.Matrix4 {
  return parentMatrix(e, byId).multiply(matrixOf(e.transform));
}

const matEq = (a: THREE.Matrix4, b: THREE.Matrix4, eps = 1e-7): boolean => {
  const x = a.elements, y = b.elements;
  for (let i = 0; i < 16; i++) if (Math.abs(x[i] - y[i]) > eps) return false;
  return true;
};

const transformNear = (a: Transform, b: Transform, eps = 1e-6): boolean =>
  a.position.every((v, i) => near(v, b.position[i], eps)) &&
  a.rotation.every((v, i) => near(v, b.rotation[i], eps)) &&
  a.scale.every((v, i) => near(v, b.scale[i], eps));

/** Express a world matrix in `e`'s parent frame and read it back as a document transform. */
function localTransformFromWorld(e: Entity, world: THREE.Matrix4, byId: Map<string, Entity>): Transform {
  return transformOf(parentMatrix(e, byId).invert().multiply(world));
}

/** Set the translation y of a matrix in place. */
function setMatrixY(m: THREE.Matrix4, y: number): THREE.Matrix4 { m.elements[13] = y; return m; }

/**
 * Deck-follows-rider (v1 A21, `syncWallPlatform('wall')`): a rider that moved on its own this
 * step — its stage did not move, so this is not a multi-select drag / group move / undo of a
 * stage move — carries its stage along horizontally. Returns the stages' new transforms, keyed by
 * stage id, in the frame each stage's transform is expressed in.
 *
 * The first rider (document order) of a stage wins; a rider that was attached in this very step
 * (dropped onto the deck) does not drag the deck to itself.
 */
function carriedStages(doc: Document, prevById: Map<string, Entity>, byId: Map<string, Entity>, stages: Map<string, StageEntity>): Map<string, Transform> {
  const out = new Map<string, Transform>();
  for (const e of doc.entities) {
    if (isStage(e) || !e.attachedTo) continue;
    const stage = stages.get(e.attachedTo);
    if (!stage || stage.locked || out.has(stage.id)) continue; // a locked deck stays put; the rider slides across it
    const before = prevById.get(e.id);
    const prevStage = prevById.get(stage.id);
    if (!before || !isStage(prevStage) || before.attachedTo !== e.attachedTo) continue;

    const pe = e.parentId ?? null, ps = stage.parentId ?? null;
    const sameFrame = pe === ps && (before.parentId ?? null) === pe && (prevStage.parentId ?? null) === ps;
    let t: Transform | null = null;
    if (sameFrame) {
      if (!jsonEq(before.transform, e.transform) && jsonEq(prevStage.transform, stage.transform)) {
        t = carryTransform(stage.transform, before.transform, e.transform);
      }
    } else {
      // world-space path: the rider and the stage live in different frames (groups)
      const ws1 = worldMatrix(stage, byId);
      const wr0 = worldMatrix(before, prevById), wr1 = worldMatrix(e, byId);
      if (!matEq(wr0, wr1) && matEq(worldMatrix(prevStage, prevById), ws1)) {
        t = localTransformFromWorld(stage, matrixOf(carryTransform(transformOf(ws1), transformOf(wr0), transformOf(wr1))), byId);
      }
    }
    if (t && !transformNear(t, stage.transform)) out.set(stage.id, t);
  }
  return out;
}

/**
 * Pure post-change step: keep riders on their stages.
 *
 *  - A stage whose (world) transform changed carries every rider whose own world transform did
 *    NOT change in the same step (a rider moved together with its stage — multi-select drag,
 *    group move, whole-document undo — is already where it should be).
 *  - The symmetric case, behind `snap.deckFollowsRider`: a rider that moved while its stage stood
 *    still carries the stage horizontally (v1's bidirectional wall/deck sync), and the stage then
 *    carries its other riders as usual.
 *  - With ground-lock, every rider sits exactly on its stage top (covers deck height changes,
 *    stage scaling and fresh attachments). A rider re-attached to a stage that (re)appeared in
 *    this step (undo of a delete, paste) is lifted onto the deck even without ground-lock, so
 *    that the drop-to-floor below is symmetric under undo.
 *  - An entity whose stage disappeared (attachedTo already cleared by `removeEntities`) drops
 *    to the floor (world y = 0).
 *
 * Riders and stages that share a parent frame use the exact local maths; otherwise the rider
 * is carried in world space through the composed group transforms (`parentId` chains).
 *
 * Returns `doc` itself when nothing changed.
 */
export function syncRiders(doc: Document, prev: Document): Document {
  const prevById = new Map<string, Entity>();
  for (const e of prev.entities) prevById.set(e.id, e);
  const byId = new Map<string, Entity>();
  const stages = new Map<string, StageEntity>();
  for (const e of doc.entities) { byId.set(e.id, e); if (isStage(e)) stages.set(e.id, e); }
  const groundLock = doc.settings.snap.groundLock;

  // decks follow the rider that moved them, before the riders are synced against their stages:
  // the moved rider then sits still relative to its (carried) deck and the deck's other riders ride along
  const carried = doc.settings.snap.deckFollowsRider ? carriedStages(doc, prevById, byId, stages) : null;
  for (const [id, transform] of carried ?? []) {
    const next: StageEntity = { ...stages.get(id)!, transform };
    stages.set(id, next);
    byId.set(id, next);
  }

  let changed = !!carried?.size;
  const entities = doc.entities.map(e => {
    if (isStage(e)) return stages.get(e.id) ?? e;
    const before = prevById.get(e.id);

    // stage deleted (it existed in `prev`, is gone from `doc`, and removeEntities cleared the link) → rider drops to the floor
    if (!e.attachedTo && before?.attachedTo && prevById.has(before.attachedTo) && !byId.has(before.attachedTo)) {
      let t = e.transform;
      if (e.parentId && byId.has(e.parentId)) {
        const w = worldMatrix(e, byId);
        if (!near(w.elements[13], 0, 1e-6)) t = localTransformFromWorld(e, setMatrixY(w, 0), byId);
      } else if (!near(t.position[1], 0)) {
        t = { ...t, position: [t.position[0], 0, t.position[2]] };
      }
      if (t === e.transform) return e;
      changed = true;
      return { ...e, transform: t };
    }
    if (!e.attachedTo) return e;
    const stage = stages.get(e.attachedTo);
    if (!stage) return e;

    const prevStageRaw = prevById.get(stage.id);
    const prevStage = isStage(prevStageRaw) ? prevStageRaw : undefined;
    // stage (re)appeared in this step and the rider was (re)attached to it → lift onto the deck even without ground-lock
    const pin = groundLock || (!prevStageRaw && before?.attachedTo !== e.attachedTo);

    const pe = e.parentId ?? null, ps = stage.parentId ?? null;
    const sameFrame = pe === ps && (before?.parentId ?? null) === pe && (prevStage?.parentId ?? null) === ps;

    let t = e.transform;
    if (sameFrame) {
      const riderMoved = !before || !jsonEq(before.transform, e.transform);
      if (prevStage && !riderMoved && !jsonEq(prevStage.transform, stage.transform)) t = rideTransform(t, prevStage, stage, groundLock);
      if (pin) {
        const top = stageTopY(stage);
        if (!near(t.position[1], top)) t = { ...t, position: [t.position[0], top, t.position[2]] };
      }
    } else {
      // world-space path: the rider and the stage live in different frames (groups)
      const ws1 = worldMatrix(stage, byId);
      let wr: THREE.Matrix4 | null = null;
      if (prevStage && before) {
        const ws0 = worldMatrix(prevStage, prevById);
        const wr1 = worldMatrix(e, byId);
        if (!matEq(ws0, ws1) && matEq(worldMatrix(before, prevById), wr1)) {
          const s0: StageEntity = { ...prevStage, transform: transformOf(ws0) };
          const s1: StageEntity = { ...stage, transform: transformOf(ws1) };
          wr = matrixOf(rideTransform(transformOf(wr1), s0, s1, groundLock));
        }
      }
      if (pin) {
        const sw = transformOf(ws1);
        const top = sw.position[1] + stage.heightIn * sw.scale[1];
        wr ??= worldMatrix(e, byId);
        if (!near(wr.elements[13], top, 1e-6)) setMatrixY(wr, top);
      }
      if (wr) {
        const local = localTransformFromWorld(e, wr, byId);
        if (!transformNear(local, e.transform)) t = local;
      }
    }
    if (t === e.transform) return e;
    changed = true;
    return { ...e, transform: t };
  });
  return changed ? { ...doc, entities } : doc;
}

/* ───────────────────────────── dimensions ───────────────────────────── */

const IDENTITY: Transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

/** Dimension entities live in world space through their `a`/`b` points; their transform is always identity. */
export function normaliseDimensions(doc: Document): Document {
  let changed = false;
  const entities = doc.entities.map(e => {
    if (!isDimension(e) || jsonEq(e.transform, IDENTITY)) return e;
    changed = true;
    return { ...e, transform: { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 } };
  });
  return changed ? { ...doc, entities } : doc;
}

/** All pure post-change behaviours in order. Returns `doc` itself when nothing changed. */
export function applyBehaviours(doc: Document, prev: Document): Document {
  return normaliseDimensions(syncRiders(doc, prev));
}

/* ───────────────────────────── auto-rotate ───────────────────────────── */

/** Turntable step for one frame: the angle OrbitControls would apply at `speed` (one turn per 60/speed s). */
export const autoRotateAngle = (dt: number, speed = AUTO_ROTATE_SPEED): number => ((2 * Math.PI) / 60) * speed * dt;

/** How often the turntable emits 'view' for HUD subscribers (ms). */
const VIEW_EMIT_INTERVAL_MS = 250;

/* ───────────────────────────── install ───────────────────────────── */

export function installSceneBehaviours(engine: Engine): () => void {
  const disposers: (() => void)[] = [];

  // a. / e. document post-processing (pure)
  disposers.push(engine.addPostChange((doc, prev) => {
    const next = applyBehaviours(doc, prev);
    return next === doc ? undefined : next;
  }));

  // b. auto-rotate. The turntable is driven here, per rendered frame, instead of through
  // `controls.autoRotate`: OrbitControls dispatches 'change' on every auto-rotate step, and the
  // engine answers each 'change' with emit('view') + a re-armed autosave debounce, so the
  // document would never autosave (and every 'view' subscriber would re-render at 60 fps) for
  // as long as the turntable runs. Moving the camera ourselves and syncing OrbitControls'
  // last-seen pose keeps its 'change' quiet; 'view' is emitted at a low rate instead.
  const rig = engine.camera;
  const controls = rig.controls;
  let interacting = false;
  let lastViewEmit = 0;
  const onStart = (): void => { interacting = true; };
  const onEnd = (): void => { interacting = false; };
  controls.addEventListener('start', onStart);
  controls.addEventListener('end', onEnd);
  disposers.push(() => { controls.removeEventListener('start', onStart); controls.removeEventListener('end', onEnd); });
  const up = new THREE.Vector3(0, 1, 0);
  const offset = new THREE.Vector3();
  disposers.push(engine.on('frame', dt => {
    if (!engine.doc.settings.autoRotate) return;
    // somebody else owns the turntable (video export sets controls.autoRotate), or the user can't orbit right now
    if (controls.autoRotate || !controls.enabled || rig.flyMode || rig.locked || interacting) return;
    if (!(dt > 0)) return;
    const cam = controls.object;
    offset.subVectors(cam.position, controls.target).applyAxisAngle(up, -autoRotateAngle(dt));
    cam.position.copy(controls.target).add(offset);
    cam.lookAt(controls.target);
    rig.target.copy(controls.target);
    // keep OrbitControls from reporting this move as a user change on its next update()
    const c = controls as unknown as { _lastPosition?: THREE.Vector3; _lastQuaternion?: THREE.Quaternion; _lastTargetPosition?: THREE.Vector3 };
    c._lastPosition?.copy(cam.position);
    c._lastQuaternion?.copy(cam.quaternion);
    c._lastTargetPosition?.copy(controls.target);
    engine.invalidate();
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastViewEmit >= VIEW_EMIT_INTERVAL_MS) { lastViewEmit = now; engine.emit('view', undefined); }
  }));
  disposers.push(engine.on('document', doc => { if (doc.settings.autoRotate) engine.invalidate(); }));

  // d. content-window selection defaults to the first window of a selected wall
  const ensureWindowSelection = (): void => {
    for (const id of engine.selection) {
      const e = engine.entity(id);
      if (!isLedWall(e) || !e.contentWindows.length) continue;
      const cur = engine.selectedWindow.get(id);
      if (cur && e.contentWindows.some(w => w.id === cur)) continue;
      engine.selectedWindow.set(id, e.contentWindows[0].id);
    }
  };
  ensureWindowSelection();
  disposers.push(engine.on('selection', ensureWindowSelection));
  disposers.push(engine.on('document', ensureWindowSelection));

  return () => {
    for (const d of disposers.splice(0)) d();
  };
}
