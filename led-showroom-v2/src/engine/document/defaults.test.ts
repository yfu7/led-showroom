import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WALL_FROM_BACK_IN, createLedWall, createRoom, createRoomForScene, createStage, ledWallDatum, roomPosition,
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
