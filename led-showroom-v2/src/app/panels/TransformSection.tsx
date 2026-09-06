/**
 * Transform section: position / rotation / scale, name, visibility, lock, attachment and the
 * quick actions (drop to floor, centre — v1 7690ff — and reset rotation).
 *
 * With one id the fields edit that entity directly. With several, the fields show the primary
 * (last-selected) entity and every edit is applied as a delta to all of them.
 *
 * Attachment (v1's per-deck "LED" button, index.html 7277-7345): a single entity can be put on a
 * stage deck from the Deck select — it is centred on the deck, yawed with it and moved back until
 * its rear face sits on the deck's rear edge, then lifted onto the deck top. "None" detaches and
 * drops it to the floor. While an object rides a deck, moving it horizontally or yawing it here
 * carries the deck along (v1's bidirectional wall ↔ deck sync).
 */
import { useEffect, useState } from 'react';
import { ArrowDownToLine, Crosshair, RotateCcw } from 'lucide-react';
import { useEngine, useStore } from '@/app/store';
import { LengthField, NumberField } from '@/app/components/NumberField';
import { Prop, Section, Stat } from '@/app/components/Section';
import { Select } from '@/app/components/Select';
import { ToggleRow } from '@/app/components/Toggle';
import { Button } from '@/app/components/Button';
import type { Entity, StageEntity, Transform } from '@/engine/document/types';
import { isLedWall, isStage } from '@/engine/document/types';
import type { Vec3 } from '@/engine/math';
import type { Engine } from '@/engine/Engine';
import { cmdUpdateEntities } from '@/engine/commands/entity';
import { stageTopY } from '@/engine/behaviours';
import { wallDims } from '@/engine/ledwall/layout';

interface Props { ids: string[] }

type Field = 'position' | 'rotation' | 'scale';
const AXES: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
const DEG = Math.PI / 180;
/** Sentinel value of the deck select when nothing is attached. */
const NO_DECK = '';

function setAxis(v: Vec3, i: number, value: number): Vec3 {
  const out: Vec3 = [v[0], v[1], v[2]];
  out[i] = value;
  return out;
}

/** Rotate a world XZ point about `c` by `deg` (same handedness as `applyTransform` / `rideTransform`). */
function orbitY(p: Vec3, c: Vec3, deg: number): Vec3 {
  const r = deg * DEG, cos = Math.cos(r), sin = Math.sin(r);
  const x = p[0] - c[0], z = p[2] - c[2];
  return [c[0] + x * cos + z * sin, p[1], c[2] - x * sin + z * cos];
}

/**
 * Half the entity's depth along its own local Z. LED walls use the panel depth so the *screen's*
 * back face lands on the deck edge (v1 used the equivalent constant `halfDeck − 1`); anything else
 * falls back to its rendered bounds.
 */
function halfDepthOf(engine: Engine, e: Entity): number {
  if (isLedWall(e)) return (wallDims(e).spec.depthIn / 2) * Math.abs(e.transform.scale[2] || 1);
  const b = engine.scene.get(e.id)?.bounds();
  return b && !b.isEmpty() && Number.isFinite(b.min.z) ? (b.max.z - b.min.z) / 2 : 0;
}

/** Y the entity origin must take so its rendered bottom rests on `supportY`. */
function restY(engine: Engine, e: Entity, supportY: number): number {
  const b = engine.scene.get(e.id)?.bounds();
  const offset = b && !b.isEmpty() && Number.isFinite(b.min.y) ? b.min.y - e.transform.position[1] : 0;
  return supportY - offset;
}

export function TransformSection({ ids }: Props) {
  const engine = useEngine();
  const doc = useStore(s => s.doc);
  const unit = doc?.settings.units ?? 'in';
  const entities = ids.map(id => doc?.entities.find(e => e.id === id)).filter(Boolean) as Entity[];
  const primary = entities[entities.length - 1];
  const [uniform, setUniform] = useState(true);
  const [name, setName] = useState(primary?.name ?? '');
  useEffect(() => { setName(primary?.name ?? ''); }, [primary?.id, primary?.name]);

  if (!primary) return null;
  const multi = entities.length > 1;
  const t = primary.transform;
  const locked = entities.some(e => e.locked);
  const attached = primary.attachedTo ? doc?.entities.find(e => e.id === primary.attachedTo) : undefined;

  /* ───── deck attachment ───── */
  const deck = isStage(attached) ? attached : undefined;
  // Decks that can be ridden: visible, top level (riding maths is world space) and not selected.
  const decks: StageEntity[] = (doc?.entities.filter(isStage) ?? []).filter(s => s.visible && !s.parentId && !ids.includes(s.id));
  const canAttach = !multi && !isStage(primary) && !primary.parentId && (decks.length > 0 || !!deck);

  /** Run one command over a fixed patch list (keeps the merge key's id set stable while scrubbing). */
  const runPatches = (patches: { id: string; patch: Partial<Entity> }[], label: string, mergeKey?: string) => {
    if (patches.length === 1) engine.update(patches[0].id, patches[0].patch, { label, mergeKey });
    else engine.run(cmdUpdateEntities(engine, patches, { label, mergeKey }));
  };

  /**
   * Patch that carries the deck under `primary`: the same horizontal delta, plus a yaw delta
   * applied about the rider's new position so the pair stays rigid (v1 `deck.rotation.y = wall.rotY`).
   * Returns null when there is nothing to carry.
   */
  const carryDeck = (dx: number, dz: number, dYaw: number): { id: string; patch: Partial<Entity> } | null => {
    if (multi || !deck || deck.locked) return null;
    const st = deck.transform;
    let position: Vec3 = [st.position[0] + dx, st.position[1], st.position[2] + dz];
    if (dYaw) position = orbitY(position, [t.position[0] + dx, st.position[1], t.position[2] + dz], dYaw);
    return { id: deck.id, patch: { transform: { ...st, position, rotation: setAxis(st.rotation, 1, st.rotation[1] + dYaw) } } };
  };

  /** Write a transform field. Single: absolute. Multi: apply (value − primary value) to everyone. */
  const write = (field: Field, axis: number, value: number, label: string, merge: boolean) => {
    const mergeKey = merge ? `transform:${primary.id}:${field}${axis}` : undefined;
    const delta = value - t[field][axis];
    const patchFor = (e: Entity): Partial<Entity> => {
      const cur = e.transform;
      let next: Vec3;
      if (field === 'scale' && uniform) {
        const base = e.id === primary.id ? value : cur.scale[axis] + delta;
        next = [base, base, base].map(v => Math.max(0.01, v)) as Vec3;
      } else {
        const v = e.id === primary.id ? value : cur[field][axis] + delta;
        next = setAxis(cur[field], axis, field === 'scale' ? Math.max(0.01, v) : v);
      }
      const transform: Transform = { ...cur, [field]: next };
      return { transform };
    };
    if (multi) {
      engine.run(cmdUpdateEntities(engine, entities.map(e => ({ id: e.id, patch: patchFor(e) })), { label: `${label} (${entities.length})`, mergeKey }));
      return;
    }
    // A rider's horizontal move / yaw takes its deck along, so the pair never slides apart.
    const carries = field === 'position' ? axis === 0 || axis === 2 : field === 'rotation' && axis === 1;
    const carry = carries ? carryDeck(field === 'position' && axis === 0 ? delta : 0, field === 'position' && axis === 2 ? delta : 0, field === 'rotation' ? delta : 0) : null;
    runPatches(carry ? [{ id: primary.id, patch: patchFor(primary) }, carry] : [{ id: primary.id, patch: patchFor(primary) }], label, mergeKey);
  };
  const commit = () => engine.history.commit();

  const patchAll = (fn: (e: Entity) => Partial<Entity>, label: string, extra: { id: string; patch: Partial<Entity> }[] = []) => {
    if (!multi) runPatches([{ id: primary.id, patch: fn(primary) }, ...extra], label);
    else engine.run(cmdUpdateEntities(engine, entities.map(e => ({ id: e.id, patch: fn(e) })), { label: `${label} (${entities.length})` }));
  };

  /** Floor (or the deck top when attached), corrected for the renderer's bottom offset. */
  const dropToFloor = () => patchAll(e => {
    const support = e.attachedTo ? doc?.entities.find(s => s.id === e.attachedTo) : undefined;
    const supportY = isStage(support) ? stageTopY(support) : 0;
    return { transform: { ...e.transform, position: setAxis(e.transform.position, 1, restY(engine, e, supportY)) } };
  }, 'Drop to floor');
  const centre = () => {
    const carry = carryDeck(-t.position[0], -t.position[2], 0);
    patchAll(e => ({ transform: { ...e.transform, position: [0, e.transform.position[1], 0] } }), 'Centre', carry ? [carry] : []);
  };
  const resetRotation = () => {
    const carry = carryDeck(0, 0, -t.rotation[1]);
    patchAll(e => ({ transform: { ...e.transform, rotation: [0, 0, 0] } }), 'Reset rotation', carry ? [carry] : []);
  };

  /**
   * Put `primary` on a deck: centred on it, yawed with it, pushed back until its rear face sits on
   * the deck's rear edge (world −Z of the deck's local frame — the side away from the front view)
   * and lifted onto the deck top. `syncRiders` keeps it there from now on.
   */
  const attachToDeck = (stageId: string) => {
    if (stageId === NO_DECK) {
      if (!primary.attachedTo) return;
      engine.update(primary.id, {
        attachedTo: null,
        transform: { ...t, position: setAxis(t.position, 1, restY(engine, primary, 0)) },
      }, { label: 'Detach from deck' });
      return;
    }
    const stage = decks.find(s => s.id === stageId);
    if (!stage || stage.id === primary.attachedTo) return;
    const st = stage.transform;
    const yaw = st.rotation[1];
    const halfDeck = (Math.max(0, stage.depthIn) * Math.abs(st.scale[2] || 1)) / 2;
    const back = -Math.max(0, halfDeck - halfDepthOf(engine, primary));
    // stage-local (0, ·, back) → world
    const r = yaw * DEG;
    const position: Vec3 = [st.position[0] + back * Math.sin(r), restY(engine, primary, stageTopY(stage)), st.position[2] + back * Math.cos(r)];
    engine.update(primary.id, {
      attachedTo: stage.id,
      transform: { ...t, position, rotation: [t.rotation[0], yaw, t.rotation[2]] },
    }, { label: `Attach to ${stage.name}` });
  };

  const commitName = () => {
    const n = name.trim();
    if (!n || n === primary.name) { setName(primary.name); return; }
    engine.update(primary.id, { name: n }, { label: 'Rename' });
  };

  return (
    <Section title="Transform" id="transform">
      {!multi && (
        <Prop label="Name">
          <div className="field text grow">
            <input value={name} maxLength={40} aria-label="Name" onChange={e => setName(e.target.value)} onBlur={commitName}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(primary.name); (e.target as HTMLInputElement).blur(); } }} />
          </div>
        </Prop>
      )}
      <Prop label="Position" wide>
        <div className="grid-3 grow">
          {AXES.map((a, i) => (
            <LengthField key={a} inches={t.position[i]} unit={unit} scrub={a.toUpperCase()} axis={a} disabled={locked}
              onChange={v => write('position', i, v, 'Move', true)} onCommit={commit} />
          ))}
        </div>
      </Prop>
      <Prop label="Rotation" wide>
        <div className="grid-3 grow">
          {AXES.map((a, i) => (
            <NumberField key={a} value={t.rotation[i]} step={1} coarseStep={15} decimals={1} unit="°" scrub={a.toUpperCase()} axis={a} disabled={locked}
              title={`Rotation ${a.toUpperCase()} · arrows or drag the label to step 1°, Shift 15°, Alt 0.1°`}
              onChange={v => write('rotation', i, v, 'Rotate', true)} onCommit={commit} />
          ))}
        </div>
      </Prop>
      <Prop label="Scale" wide>
        <div className="grid-3 grow">
          {AXES.map((a, i) => (
            <NumberField key={a} value={t.scale[i]} step={0.01} decimals={2} min={0.01} scrub={a.toUpperCase()} axis={a} disabled={locked}
              onChange={v => write('scale', i, v, 'Scale', true)} onCommit={commit} />
          ))}
        </div>
      </Prop>
      <ToggleRow label="Uniform scale" checked={uniform} onChange={setUniform} hint="Scaling one axis scales all three" />
      <div className="divider" />
      <ToggleRow label="Visible" checked={entities.every(e => e.visible)} onChange={v => patchAll(() => ({ visible: v }), v ? 'Show' : 'Hide')} />
      <ToggleRow label="Locked" checked={locked} onChange={v => patchAll(() => ({ locked: v }), v ? 'Lock' : 'Unlock')} />
      {canAttach ? (
        <>
          <Prop label="Deck" title="Stand this object on a stage deck: centred, yawed with the deck and flush with its back edge">
            <Select<string>
              value={deck?.id ?? NO_DECK} disabled={locked} className="grow"
              options={[
                { value: NO_DECK, label: 'None (floor)' },
                ...(deck && !decks.some(s => s.id === deck.id) ? [{ value: deck.id, label: deck.name }] : []),
                ...decks.map(s => ({ value: s.id, label: s.name })),
              ]}
              onChange={attachToDeck}
            />
          </Prop>
          {deck && <div className="hint">Moving or yawing this object carries {deck.name} with it. Choose none to detach and drop to the floor.</div>}
        </>
      ) : attached && <Stat label="Attached to" value={attached.name} />}
      <div className="row" style={{ marginTop: 4 }}>
        <Button size="sm" icon={<ArrowDownToLine size={14} strokeWidth={1.5} />} onClick={dropToFloor} disabled={locked} tip="Rest on the floor or the deck beneath">Drop to floor</Button>
        <Button size="sm" icon={<Crosshair size={14} strokeWidth={1.5} />} onClick={centre} disabled={locked} tip="Move to x = 0, z = 0">Centre</Button>
        <Button size="sm" icon={<RotateCcw size={14} strokeWidth={1.5} />} onClick={resetRotation} disabled={locked} tip="Reset rotation to 0°">Reset</Button>
      </div>
    </Section>
  );
}
