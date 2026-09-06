import { describe, expect, it } from 'vitest';
import {
  BOOTH_HEIGHT_FT, BOOTH_PRESETS, DEFAULT_ROOM_NAME, DEFAULT_WALL_FROM_BACK_IN, boothRoomPatch, createBoothForScene, createLedWall, createRoom,
  createRoomForScene, createStage, findBoothPreset, ledWallDatum, roomPosition,
} from './defaults';
import { IPOSTER } from '../ledwall/specs';
import { wallDims } from '../ledwall/layout';

const HALF_D = IPOSTER.depthIn / 2; // rear face of a wall standing at the origin (z = -0.885)

describe('venue room placement', () => {
  it('puts the back wall 2 ft behind the rear face of a wall at the origin (v1 backZ = -25)', () => {
    const room = createRoom();
    expect(room.transform.position).toEqual([0, 0, -(HALF_D + DEFAULT_WALL_FROM_BACK_IN)]);
    // v1 read -25 from its 2 in panel depth; the CAD's 1.77 in depth makes it -24.885.
    expect(room.transform.position[2]).toBeCloseTo(-24.885, 9);
    // The room's floor stays on the ground plane and it extends towards +Z, in front of the wall.
    expect(room.transform.position[1]).toBe(0);
    expect(room.depthIn).toBe(30 * 12);
  });

  it('honours a custom wall-from-back clearance', () => {
    expect(createRoom(40, 13, 30, 0).transform.position[2]).toBeCloseTo(-HALF_D);
    expect(createRoom(40, 13, 30, 120).transform.position[2]).toBeCloseTo(-(HALF_D + 120));
  });

  it('falls back to the origin when the scene has no LED walls', () => {
    const d = ledWallDatum([createStage()]);
    expect(d).toEqual({ centreX: 0, rearZ: -HALF_D });
    expect(createRoomForScene([]).transform.position).toEqual(createRoom().transform.position);
  });

  it('centres the room on the walls and pushes it behind the rear-most one', () => {
    const a = createLedWall({ cols: 2, rows: 2, position: [-100, 0, 40] });
    const b = createLedWall({ cols: 2, rows: 2, position: [60, 0, 10] });
    const half = wallDims(a).totalW / 2;
    const d = ledWallDatum([a, createStage(), b]);
    expect(d.centreX).toBeCloseTo((-100 - half + 60 + half) / 2); // -20
    expect(d.rearZ).toBeCloseTo(10 - HALF_D); // the rear face of the wall furthest back
    const room = createRoomForScene([a, b]);
    expect(room.transform.position[0]).toBeCloseTo(-20);
    expect(room.transform.position[2]).toBeCloseTo(10 - HALF_D - DEFAULT_WALL_FROM_BACK_IN);
  });

  it('accounts for a wall yawed 90 degrees (its width runs along Z)', () => {
    const w = createLedWall({ cols: 3, rows: 2, position: [12, 0, 5] });
    w.transform.rotation = [0, 90, 0];
    const half = wallDims(w).totalW / 2;
    const d = ledWallDatum([w]);
    expect(d.centreX).toBeCloseTo(12);
    expect(d.rearZ).toBeCloseTo(5 - half);
    expect(roomPosition([w])[2]).toBeCloseTo(5 - half - DEFAULT_WALL_FROM_BACK_IN);
  });

  it('scales the wall bounds with the wall transform', () => {
    const w = createLedWall({ cols: 2, rows: 2 });
    w.transform.scale = [2, 1, 3];
    const d = ledWallDatum([w]);
    expect(d.centreX).toBeCloseTo(0);
    expect(d.rearZ).toBeCloseTo(-HALF_D * 3);
    expect(roomPosition([w], 0)[2]).toBeCloseTo(-HALF_D * 3);
  });
});

describe('trade-show booth presets', () => {
  const byId = (id: string) => {
    const p = findBoothPreset(id);
    if (!p) throw new Error(`missing preset ${id}`);
    return p;
  };

  it('offers the three standard footprints, smallest first', () => {
    expect(BOOTH_PRESETS.map(p => p.id)).toEqual(['booth-10x10', 'booth-20x10', 'booth-20x20']);
    expect(BOOTH_PRESETS.map(p => p.label)).toEqual(['10 × 10 booth', '20 × 10 booth', '20 × 20 booth']);
    expect(findBoothPreset('booth-30x30')).toBeUndefined();
  });

  it('keeps every preset at the 8 ft back-drape height', () => {
    expect(BOOTH_HEIGHT_FT).toBe(8);
    for (const p of BOOTH_PRESETS) {
      expect(p.heightFt).toBe(BOOTH_HEIGHT_FT);
      expect(createBoothForScene(p).heightIn).toBe(96);
    }
  });

  it('builds exact inch dimensions for all three', () => {
    const dims = (id: string) => {
      const r = createBoothForScene(byId(id));
      return [r.widthIn, r.heightIn, r.depthIn];
    };
    expect(dims('booth-10x10')).toEqual([120, 96, 120]);
    expect(dims('booth-20x10')).toEqual([240, 96, 120]);
    expect(dims('booth-20x20')).toEqual([240, 96, 240]);
  });

  it('does not transpose width and depth (20 × 10 is 20 ft wide, 10 ft deep)', () => {
    const p = byId('booth-20x10');
    expect([p.widthFt, p.depthFt]).toEqual([20, 10]);
    const room = createBoothForScene(p);
    expect(room.widthIn).toBe(20 * 12);
    expect(room.depthIn).toBe(10 * 12);
    expect(room.widthIn).toBeGreaterThan(room.depthIn);
    // The square presets stay square, so a transposition elsewhere cannot hide behind them.
    for (const id of ['booth-10x10', 'booth-20x20']) {
      const r = createBoothForScene(byId(id));
      expect(r.widthIn).toBe(r.depthIn);
    }
  });

  it('names the room after the preset and leaves it visible and unlocked', () => {
    const room = createBoothForScene(byId('booth-10x10'));
    expect(room.type).toBe('room');
    expect(room.name).toBe('10 × 10 booth');
    expect(room.name).not.toBe(DEFAULT_ROOM_NAME);
    expect(room.visible).toBe(true);
    expect(room.locked).toBe(false);
    expect(room.show.ceiling).toBe(false); // 8 ft walls must never box in a taller build
  });

  it('renders as a footprint, not a room: outline on, floor on, every wall and the ceiling off', () => {
    // A plain venue space is untouched by the new flag.
    expect(createRoom().outlineWalls).toBe(false);
    expect(createRoomForScene([]).outlineWalls).toBe(false);
    for (const p of BOOTH_PRESETS) {
      const r = createBoothForScene(p);
      expect(r.outlineWalls).toBe(true);
      // The entity says what it is: the walls are OFF, not merely hidden by the renderer.
      expect(r.show).toEqual({ back: false, floor: true, ceiling: false, left: false, right: false });
    }
  });

  it('gives the same patch to a new booth and to a room resized into one', () => {
    // The Venue panel patches the room already in the scene with boothRoomPatch while the catalog
    // card builds a fresh entity: both must land on identical geometry and show flags, or clicking
    // "20 × 10" would mean one thing in the catalog and another in the panel.
    for (const p of BOOTH_PRESETS) {
      const patch = boothRoomPatch(p);
      expect(patch).toEqual({
        widthIn: p.widthFt * 12, heightIn: p.heightFt * 12, depthIn: p.depthFt * 12,
        outlineWalls: true, show: { back: false, floor: true, ceiling: false, left: false, right: false },
      });
      // Applying it to a plain venue space (solid walls, hall proportions) yields the booth a card
      // would have added, right down to the flags.
      const resized = Object.assign(createRoom(), boothRoomPatch(p));
      const fresh = createBoothForScene(p);
      for (const k of ['widthIn', 'heightIn', 'depthIn', 'outlineWalls'] as const) expect(resized[k]).toEqual(fresh[k]);
      expect(resized.show).toEqual(fresh.show);
    }
  });

  it('positions a booth against the scene exactly like roomPosition', () => {
    const a = createLedWall({ cols: 2, rows: 2, position: [-100, 0, 40] });
    const b = createLedWall({ cols: 2, rows: 2, position: [60, 0, 10] });
    const entities = [a, createStage(), b];
    for (const p of BOOTH_PRESETS) {
      expect(createBoothForScene(p, entities).transform.position).toEqual(roomPosition(entities));
      expect(createBoothForScene(p, entities, 0).transform.position).toEqual(roomPosition(entities, 0));
    }
    // No walls: same fallback as a plain venue space.
    expect(createBoothForScene(byId('booth-20x20')).transform.position).toEqual(createRoomForScene([]).transform.position);
    expect(createBoothForScene(byId('booth-20x20'), entities).transform.position[1]).toBe(0);
  });
});
