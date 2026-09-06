/**
 * Per-frame viewport statistics for the HUD and status bar: an EMA frame rate and the camera's
 * distance to the primary selection. For LED walls the distance is the perpendicular distance to
 * the screen face (v1 `distanceToSelectedWall`, 3651-3662); for everything else it is the distance
 * to the bounds centre. Publishes to the store at ~10 Hz so React never re-renders per frame.
 */
import { useEffect } from 'react';
import * as THREE from 'three';
import { useEngine, useStore } from '@/app/store';
import type { LedWallRenderer } from '@/engine/entities/LedWallRenderer';
import { perpendicularDistanceToFace } from '@/engine/ledwall/pixelGrid';

const PUBLISH_INTERVAL_MS = 100;
const FPS_SMOOTHING = 0.12;

const _local = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _center = new THREE.Vector3();
const _box = new THREE.Box3();

/** Round like v1's distance meter: tenths under 10 ft, whole inches beyond — avoids store churn. */
function roundDistance(inches: number): number {
  return inches < 120 ? Math.round(inches * 10) / 10 : Math.round(inches);
}

export function useViewportStats(): void {
  const engine = useEngine();

  useEffect(() => {
    let ema = 0;
    let lastPublish = 0;

    const off = engine.on('frame', dt => {
      const inst = dt > 0 ? 1 / dt : 0;
      ema = ema > 0 ? ema + (inst - ema) * FPS_SMOOTHING : inst;

      const now = performance.now();
      if (now - lastPublish < PUBLISH_INTERVAL_MS) return;
      lastPublish = now;

      const state = useStore.getState();
      const fps = Math.round(ema);
      if (fps !== state.fps) state.setFps(fps);

      const id = engine.selection[engine.selection.length - 1];
      let dist: number | null = null;
      if (id) {
        const r = engine.scene.get(id);
        if (r) {
          const cam = engine.camera.camera;
          const wall = r as Partial<LedWallRenderer>;
          if (wall.dims && typeof wall.dims.panelD === 'number') {
            r.root.updateWorldMatrix(true, false);
            r.root.worldToLocal(_local.copy(cam.position));
            // World scale, not the local one: a wall parented under a scaled group would otherwise read wrong.
            const sz = r.root.getWorldScale(_scale).z || 1;
            dist = perpendicularDistanceToFace(_local.z, wall.dims.panelD, sz);
          } else {
            const b = r.bounds(_box);
            if (!b.isEmpty()) dist = cam.position.distanceTo(b.getCenter(_center));
          }
        }
      }
      const rounded = dist === null ? null : roundDistance(dist);
      if (rounded !== state.distanceToSelection) state.setDistance(rounded);
    });

    return () => {
      off();
      const s = useStore.getState();
      if (s.distanceToSelection !== null) s.setDistance(null);
    };
  }, [engine]);
}
