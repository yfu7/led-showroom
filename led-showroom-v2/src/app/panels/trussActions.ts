/**
 * The wall's truss rig, as the right-click menu and the inspector's Truss section both offer it, so
 * the two ask the same question, run the same code and say the same thing.
 */
import type { Engine } from '@/engine/Engine';
import type { GroupEntity, LedWallEntity } from '@/engine/document/types';
import { cmdPatchDocument } from '@/engine/commands/entity';
import { rigEntityIds } from '@/engine/ledwall/trussRig';
import { autoTrussRig } from '@/engine/ledwall/trussBuilder';
import { requestConfirm } from '@/app/shell/ConfirmDialog';

/** What the last Auto truss came to, planned against built, for God Mode. */
export interface AutoTrussReport {
  wallId: string;
  ms: number;
  fail: string | null;
  /** Legs / span sticks / couplers, as planned and as put up. */
  planned: [number, number, number];
  built: [number, number, number];
  /** Wall shim, in inches, as planned and as put up. */
  shim: [number, number];
  /** Columns with couplers of their own, and held, as planned and as put up; then how many there are. */
  held: [number, number];
  supported: [number, number];
  columns: number;
  /** Gaps F closed, planned sticks put up as planned, planned pieces that would not go up. */
  filled: number;
  kept: number;
  refused: string[];
}

let last: AutoTrussReport | null = null;
const listeners = new Set<() => void>();
/** The last Auto truss run's report, as an external store for `useSyncExternalStore`. */
export const autoTrussReport = {
  get: (): AutoTrussReport | null => last,
  subscribe: (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
};
function report(r: AutoTrussReport): void {
  last = r;
  for (const fn of listeners) fn();
}

/** What the Auto truss action is called on `wall`: it replaces a rig the wall has. */
export const autoTrussLabel = (engine: Engine, wall: LedWallEntity): string =>
  rigEntityIds(engine.doc, wall.id).size ? 'Rebuild with Auto truss' : 'Auto truss';

/**
 * Plan the rig behind `wall` and put it up with one command, through the truss builder, so it
 * opens in Build truss piece by piece. A rig put up by hand is asked about first.
 *
 * One `cmdPatchDocument`, because a rig is one thing: the group, every leg, span and coupler, the
 * wall set down on the base plates, and the floor-stand kit coming off where the legs stand. A
 * single undo takes all of it back out, which is what makes trying it safe. The next document is
 * computed once rather than inside the command: a redo that planned again would mint fresh ids
 * and strand anything holding the old ones.
 */
export function autoTruss(engine: Engine, wall: LedWallEntity): void {
  const rig = engine.doc.entities.find((e): e is GroupEntity => e.type === 'group' && e.rigFor === wall.id);
  if (!rig?.rigHand) { planAndApply(engine, wall); return; }
  // A rig put up by hand is work Auto truss would throw away: ask first.
  requestConfirm({
    title: 'Replace the rig built by hand?',
    body: 'Auto truss plans the rig over from scratch, so every piece put up by hand comes down. Undo puts them back.',
    confirm: 'Replace with Auto truss',
    onConfirm: () => {
      const live = engine.entity<LedWallEntity>(wall.id);
      if (live) planAndApply(engine, live);
    },
  });
}

function planAndApply(engine: Engine, wall: LedWallEntity): void {
  const t0 = performance.now();
  const got = autoTrussRig(engine.doc, wall);
  const ms = performance.now() - t0;
  if ('fail' in got) {
    report({
      wallId: wall.id, ms, fail: got.fail, planned: [0, 0, 0], built: [0, 0, 0], shim: [0, 0], held: [0, 0], supported: [0, 0],
      columns: 0, filled: 0, kept: 0, refused: [],
    });
    engine.toast('error', got.fail);
    return;
  }
  const { plan, auto, summary } = got;
  const c = summary.coupling;
  report({
    wallId: wall.id, ms, fail: null,
    planned: [plan.legs.length, plan.spans.length, plan.clamps.length],
    built: [got.legs, got.spans, c.clamps.length],
    shim: [plan.shimIn, c.shim],
    held: [plan.held, c.held.size],
    supported: [plan.supported, c.supported.size],
    columns: summary.columns,
    filled: auto.filled, kept: auto.kept,
    refused: auto.refused.map(r => `${r.piece.catalogId} @ ${r.piece.position.map(v => v.toFixed(2)).join(', ')}: ${r.why.join(' ')}`),
  });

  const rebuild = rigEntityIds(engine.doc, wall.id).size > 0;
  engine.run(cmdPatchDocument(engine, { entities: got.next.entities }, { label: rebuild ? 'Rebuild truss rig' : 'Auto truss' }));

  const n = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`;
  const parts = [
    plan.frames ? n(plan.frames, 'frame', 'frames') : '',
    n(got.legs, 'leg', 'legs'),
    // Sticks, not spans: one spliced span across a doorway can take several.
    got.spans ? n(got.spans, 'span stick', 'span sticks') : '',
    n(c.clamps.length, 'half coupler', 'half couplers'),
  ].filter(Boolean);
  const head = `${parts.join(', ')} - ${c.supported.size} of ${n(summary.columns, 'column', 'columns')} held, ${c.held.size} by couplers of their own`;
  engine.toast(summary.ghosts || auto.refused.length ? 'info' : 'success', [head, ...got.notes].join(' - '));
}

/** Take the rig off a wall. The wall stays where the rig left it. */
export function removeTrussRig(engine: Engine, wall: LedWallEntity): void {
  const ids = [...rigEntityIds(engine.doc, wall.id)];
  if (ids.length) engine.remove(ids);
}
