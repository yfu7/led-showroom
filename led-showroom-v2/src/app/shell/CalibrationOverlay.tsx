/**
 * Perspective-calibration overlay (v1 index.html 2101-2112, 6497-6772). A full-viewport canvas
 * bound to a CalibrationSession: the session owns the lines and the drawing, this component owns
 * the <canvas>, forwards pointer events in viewport pixels and hosts the step panel.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ImageOff } from 'lucide-react';
import { Button } from '@/app/components/Button';
import { useDoc, useEngine } from '@/app/store';
import type { Engine } from '@/engine/Engine';
import { CalibrationSession, DEPTH_LINE_COLOR, WIDTH_LINE_COLOR, type CalibrationStep } from '@/engine/calibration/CalibrationSession';

/**
 * One CalibrationSession per engine. The session owns the sightline grid it adds to the scene
 * (toggleGrid / disposeGrid / restoreFromDocument all live on the instance), so a per-mount
 * instance would orphan that grid on unmount. VenuePanel's grid toggle and the document-load
 * restore should use this same accessor.
 */
const sessions = new WeakMap<Engine, CalibrationSession>();
export function getCalibrationSession(engine: Engine): CalibrationSession {
  let s = sessions.get(engine);
  if (!s) { s = new CalibrationSession(); sessions.set(engine, s); }
  return s;
}

/** Font and box geometry of the instruction box `CalibrationSession.drawOverlay` paints top-left. */
const SESSION_TEXT_FONT = '600 13px system-ui, -apple-system, "Segoe UI", sans-serif';
const SESSION_BOX = { x: 16, y: 16, h: 30, padX: 12 };

/**
 * The session paints its own instruction box, but the panel above the canvas is the single source
 * of copy (and the box's font, weight and colours sit outside the design tokens). Repaint the photo,
 * its dim, and any sightline crossing that box so only the panel copy is visible. This mirrors the
 * session's geometry and can go once the session exposes a `drawOverlay(ctx, { instructions: false })`.
 */
function coverSessionInstruction(ctx: CanvasRenderingContext2D, session: CalibrationSession, img: HTMLImageElement | null): void {
  const text = session.lastError ?? session.instruction;
  ctx.save();
  ctx.font = SESSION_TEXT_FONT;
  const { x, y, h, padX } = SESSION_BOX;
  const bx = x - 1, by = y - 1, bw = ctx.measureText(text).width + padX * 2 + 2, bh = h + 2;
  ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
  ctx.clearRect(bx, by, bw, bh);
  if (img && img.naturalWidth > 0) { const f = session.fit; ctx.drawImage(img, f.x, f.y, f.w, f.h); }
  ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(bx, by, bw, bh);
  for (const { seg, color } of session.linesForDisplay()) {
    const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1, len = Math.hypot(dx, dy) || 1;
    const ex = dx / len * 4000, ey = dy / len * 4000;
    ctx.strokeStyle = color; ctx.globalAlpha = 0.28; ctx.setLineDash([6, 6]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(seg.x1 - ex, seg.y1 - ey); ctx.lineTo(seg.x2 + ex, seg.y2 + ey); ctx.stroke();
    ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(seg.x1, seg.y1); ctx.lineTo(seg.x2, seg.y2); ctx.stroke();
  }
  ctx.restore();
}

const STEP_COPY: Record<CalibrationStep, string> = {
  1: 'Trace two red lines along edges that run left-to-right in the photo (width) — 0 of 2',
  2: 'Trace two red lines along edges that run left-to-right in the photo (width) — 1 of 2',
  3: 'Now two green lines along edges that recede into the room (depth) — 0 of 2',
  4: 'Now two green lines along edges that recede into the room (depth) — 1 of 2',
  done: 'Adjust the endpoints if needed, then solve and lock the view',
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the venue photo'));
    img.src = url;
  });
}

export function CalibrationOverlay() {
  const engine = useEngine();
  const doc = useDoc();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<CalibrationSession | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<CalibrationStep>(1);
  const [canSolve, setCanSolve] = useState(false);
  const [lineCount, setLineCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const photo = doc.environment.backdrop.photo;
  const photoUrl = engine.env.photo ?? photo?.url ?? null;
  const photoAssetId = photo?.assetId ?? null;
  const calibration = doc.environment.backdrop.calibration ?? null;

  /** Size the canvas to the overlay (device-pixel aware) and redraw. */
  const draw = useCallback(() => {
    const canvas = canvasRef.current, root = rootRef.current, session = sessionRef.current;
    if (!canvas || !root || !session) return;
    const w = Math.max(1, root.clientWidth), h = Math.max(1, root.clientHeight);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    if (session.snapshot.viewW !== w || session.snapshot.viewH !== h) session.resize(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    session.drawOverlay(ctx);
    coverSessionInstruction(ctx, session, imageRef.current);
  }, []);

  // Session lifecycle: bind the engine's shared session, load the photo, begin, subscribe, observe resizes.
  useEffect(() => {
    let cancelled = false;
    const session = getCalibrationSession(engine);
    sessionRef.current = session;
    let offChange = () => {};
    let ro: ResizeObserver | null = null;

    (async () => {
      let url = photoUrl;
      if (!url && photoAssetId) url = await engine.assets.getUrl(photoAssetId);
      if (!url) { setReady(false); return; }
      let img: HTMLImageElement;
      try { img = await loadImage(url); } catch (e) { if (!cancelled) setError((e as Error).message); return; }
      if (cancelled) return;
      imageRef.current = img;
      const root = rootRef.current;
      const vw = root?.clientWidth ?? 1, vh = root?.clientHeight ?? 1;
      offChange = session.onChange(() => {
        setStep(session.step);
        setCanSolve(session.canSolve);
        setLineCount(session.lineCount);
        setError(session.lastError);
        draw();
      });
      session.begin(img.naturalWidth, img.naturalHeight, vw, vh, calibration, img);
      if (root && typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => draw()); ro.observe(root); }
      setReady(true);
      draw();
    })();

    return () => {
      cancelled = true;
      offChange();
      ro?.disconnect();
      // Only detach: the session (and the grid it may own) stays with the engine.
      sessionRef.current = null;
      imageRef.current = null;
    };
    // The session is deliberately tied to the photo, not to every document change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, photoUrl, photoAssetId, draw]);

  const localPoint = (e: ReactPointerEvent<HTMLElement>): { x: number; y: number } => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !sessionRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = localPoint(e);
    sessionRef.current.pointerDown(p.x, p.y);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = sessionRef.current;
    if (!s) return;
    const p = localPoint(e);
    if (s.isDrawing || s.isDragging) s.pointerMove(p.x, p.y);
    else e.currentTarget.style.cursor = s.handleAt(p) ? 'grab' : 'crosshair';
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = sessionRef.current;
    if (!s) return;
    const p = localPoint(e);
    s.pointerUp(p.x, p.y);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const cancel = () => engine.tools.activate('select');

  // Escape leaves calibration even when the viewport input element is not focused (the canvas covers it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      engine.tools.activate('select');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);
  const reset = () => sessionRef.current?.reset();
  const undoLine = () => sessionRef.current?.undoLine();
  const solve = () => {
    const s = sessionRef.current;
    if (!s || !s.canSolve) return;
    const res = s.solve(engine.camera.fov);
    if (!res.ok) { engine.toast('error', res.reason ?? 'Could not solve the sightlines'); return; }
    if (!s.apply(engine, res)) return;
    engine.toast('success', `Perspective locked · ${Math.round(res.fovDeg)}° field of view`);
    engine.tools.activate('select');
  };

  const stopKeys = (e: ReactKeyboardEvent) => { if (e.key !== 'Escape') e.stopPropagation(); };

  if (!photoUrl && !photoAssetId) {
    return (
      <div className="calib" ref={rootRef} onKeyDown={stopKeys} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--scrim)', cursor: 'default' }}>
        <div className="empty" style={{ background: 'var(--glass)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-island)', backdropFilter: 'blur(14px)' }}>
          <ImageOff />
          <div className="title">No venue photo</div>
          <div className="hint">Add a photo of the venue in Scene › Venue, then trace its edges to match the camera.</div>
          <Button size="sm" onClick={cancel} style={{ marginTop: 8 }}>Close</Button>
        </div>
      </div>
    );
  }

  const dotFor = (i: number) => {
    const colour = i < 2 ? WIDTH_LINE_COLOR : DEPTH_LINE_COLOR;
    const done = i < lineCount;
    return <span key={i} className="dot" style={{ background: done ? colour : 'transparent', boxShadow: `inset 0 0 0 1.5px ${colour}`, opacity: done ? 1 : 0.7 }} />;
  };

  return (
    <div className="calib" ref={rootRef} onKeyDown={stopKeys}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={e => e.preventDefault()}
        style={{ touchAction: 'none' }}
      />
      <div className="calib-panel" role="toolbar" aria-label="Perspective calibration">
        <span className="row" style={{ gap: 4 }}>{[0, 1, 2, 3].map(dotFor)}</span>
        <span style={{ color: error ? 'var(--danger)' : 'var(--fg-1)', maxWidth: 520 }}>
          {!ready ? 'Loading the venue photo…' : error ?? STEP_COPY[step]}
        </span>
        <span className="sep" style={{ width: 1, height: 18, background: 'var(--line-strong)' }} />
        <Button size="sm" variant="ghost" onClick={undoLine} disabled={!ready || lineCount === 0}>Undo line</Button>
        <Button size="sm" variant="ghost" onClick={reset} disabled={!ready || lineCount === 0}>Reset</Button>
        <Button size="sm" variant="primary" onClick={solve} disabled={!ready || !canSolve}>Solve & lock</Button>
        <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
      </div>
    </div>
  );
}
