/**
 * Axis widget (top-right of the viewport). Three axis spheres are projected from the camera's
 * orientation every time the view changes: filled discs with letters at the positive ends, hollow
 * rings at the negative ends. Click a sphere to look down that axis, drag to orbit, double-click
 * to return home.
 */
import {
  useCallback, useEffect, useRef, useState,
  type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import * as THREE from 'three';
import { useEngine, useStore } from '@/app/store';
import type { ViewPreset } from '@/engine/scene/CameraRig';
import { clamp } from '@/engine/math';

const SIZE = 92;
const C = SIZE / 2;
/** Radius of the sphere orbit in the widget, px. */
const R = 30;
const POS_RADIUS = 8;
const NEG_RADIUS = 4.5;
const DRAG_THRESHOLD_PX = 3;
const ORBIT_RAD_PER_PX = 0.01;
const MIN_POLAR = 0.02;
const MAX_POLAR = Math.PI * 0.495;

interface AxisDef { key: 'x' | 'y' | 'z'; dir: THREE.Vector3; color: string; letter: string; posView: ViewPreset; negView: ViewPreset }

const AXES: AxisDef[] = [
  { key: 'x', dir: new THREE.Vector3(1, 0, 0), color: 'var(--axis-x)', letter: 'X', posView: 'right', negView: 'left' },
  { key: 'y', dir: new THREE.Vector3(0, 1, 0), color: 'var(--axis-y)', letter: 'Y', posView: 'top', negView: 'bottom' },
  { key: 'z', dir: new THREE.Vector3(0, 0, 1), color: 'var(--axis-z)', letter: 'Z', posView: 'front', negView: 'back' },
];

interface Marker { id: string; x: number; y: number; depth: number; positive: boolean; axis: AxisDef }

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** World axis ends → widget-space markers, back-to-front so the nearest ones paint last. */
function projectAxes(camera: THREE.Camera): Marker[] {
  _q.copy(camera.quaternion).invert();
  const out: Marker[] = [];
  for (const axis of AXES) {
    for (const sign of [1, -1]) {
      _v.copy(axis.dir).multiplyScalar(sign).applyQuaternion(_q);
      out.push({ id: `${axis.key}${sign > 0 ? '+' : '-'}`, x: C + _v.x * R, y: C - _v.y * R, depth: _v.z, positive: sign > 0, axis });
    }
  }
  return out.sort((a, b) => a.depth - b.depth);
}

export function ViewCube() {
  const engine = useEngine();
  const locked = useStore(s => s.viewLocked);
  const [markers, setMarkers] = useState<Marker[]>(() => projectAxes(engine.camera.camera));
  /** Marker id showing a keyboard focus ring (`:focus-visible` only, so mouse clicks stay quiet). */
  const [focused, setFocused] = useState<string | null>(null);
  const raf = useRef(0);
  const drag = useRef<{ x: number; y: number; moved: boolean; spherical: THREE.Spherical; target: THREE.Vector3 } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const schedule = () => {
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        setMarkers(projectAxes(engine.camera.camera));
      });
    };
    const off = engine.on('view', schedule);
    schedule();
    return () => { off(); if (raf.current) cancelAnimationFrame(raf.current); raf.current = 0; };
  }, [engine]);

  const onPointerDown = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    // A fresh gesture: a previous drag that ended off a marker must not swallow this click.
    suppressClick.current = false;
    const cam = engine.camera;
    const target = cam.controls.target.clone();
    const offset = new THREE.Vector3().subVectors(cam.camera.position, target);
    drag.current = { x: e.clientX, y: e.clientY, moved: false, spherical: new THREE.Spherical().setFromVector3(offset), target };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [engine]);

  const onPointerMove = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    if (locked || engine.camera.flyMode) return;
    const s = d.spherical;
    s.theta -= dx * ORBIT_RAD_PER_PX;
    s.phi = clamp(s.phi - dy * ORBIT_RAD_PER_PX, MIN_POLAR, MAX_POLAR);
    d.x = e.clientX; d.y = e.clientY;
    const pos = new THREE.Vector3().setFromSpherical(s).add(d.target);
    engine.camera.userMoved = true;
    engine.camera.moveTo(pos, d.target, false);
  }, [engine, locked]);

  const onPointerUp = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) suppressClick.current = true;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  const onAxisClick = useCallback((m: Marker) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (locked) return;
    engine.setView(m.positive ? m.axis.posView : m.axis.negView);
  }, [engine, locked]);

  const onDoubleClick = useCallback(() => { if (!locked) engine.setView('home'); }, [engine, locked]);

  const onAxisKeyDown = useCallback((e: ReactKeyboardEvent<SVGGElement>, m: Marker) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    suppressClick.current = false;
    onAxisClick(m);
  }, [onAxisClick]);

  const onAxisFocus = useCallback((e: ReactFocusEvent<SVGGElement>, m: Marker) => {
    let visible = true;
    try { visible = e.currentTarget.matches(':focus-visible'); } catch { /* older engines: always ring */ }
    setFocused(visible ? m.id : null);
  }, []);
  const onAxisBlur = useCallback(() => setFocused(null), []);

  return (
    <svg
      className="viewcube"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      width={SIZE}
      height={SIZE}
      role="group"
      aria-label="View orientation"
      // The overlay root is pointer-transparent; opt back in here so clicks and drags reach the widget.
      style={{ cursor: locked ? 'default' : 'grab', touchAction: 'none', opacity: locked ? 0.55 : 1, pointerEvents: 'auto' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <circle cx={C} cy={C} r={R + POS_RADIUS + 2} fill="var(--glass)" stroke="var(--line)" strokeWidth={1} />
      {markers.map(m => {
        const front = m.depth >= 0;
        const stroke = m.axis.color;
        const view = m.positive ? m.axis.posView : m.axis.negView;
        const hitRadius = m.positive ? POS_RADIUS : NEG_RADIUS + 4;
        return (
          <g key={m.id}>
            {m.positive && (
              <line x1={C} y1={C} x2={m.x} y2={m.y} stroke={stroke} strokeWidth={1.25} opacity={front ? 0.85 : 0.3} pointerEvents="none" />
            )}
            <g
              role="button"
              tabIndex={locked ? -1 : 0}
              aria-label={`Look from ${view}`}
              aria-disabled={locked || undefined}
              style={{ cursor: locked ? 'default' : 'pointer', outline: 'none' }}
              onClick={() => onAxisClick(m)}
              onKeyDown={e => onAxisKeyDown(e, m)}
              onFocus={e => onAxisFocus(e, m)}
              onBlur={onAxisBlur}
            >
              <title>{`Look from ${view}`}</title>
              {focused === m.id && (
                <circle cx={m.x} cy={m.y} r={hitRadius + 2.5} fill="none" stroke="var(--accent)" strokeWidth={1.5} pointerEvents="none" />
              )}
              {m.positive ? (
                <>
                  <circle cx={m.x} cy={m.y} r={POS_RADIUS} fill={stroke} opacity={front ? 1 : 0.45} />
                  {/* --bg-0 is dark on the dark theme's lighter discs and light on the light theme's darker ones. */}
                  <text x={m.x} y={m.y + 3.4} textAnchor="middle" fontSize={9.5} fontWeight={500} fontFamily="var(--font-ui)" fill="var(--bg-0)" opacity={front ? 0.9 : 0.55} pointerEvents="none">{m.axis.letter}</text>
                </>
              ) : (
                <>
                  <circle cx={m.x} cy={m.y} r={hitRadius} fill="transparent" />
                  <circle cx={m.x} cy={m.y} r={NEG_RADIUS} fill="var(--bg-1)" stroke={stroke} strokeWidth={1.25} opacity={front ? 0.9 : 0.4} />
                </>
              )}
            </g>
          </g>
        );
      })}
    </svg>
  );
}
