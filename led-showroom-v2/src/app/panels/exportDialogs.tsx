/**
 * Export dialogs: save image, record video, export glTF. Built on the shared Modal.
 * v1 references: save image 8091-8409, video recording 8410-8892.
 *
 * Only the *setup* half of Record video is modal. Once a take is running the dialog is replaced by
 * a floating chip (a portal whose wrapper is pointer-transparent), because in v1 the whole app kept
 * working while recording — orbiting the camera, dragging a wall or riding the brightness slider
 * mid-take is the main reason to record at all, and a Modal scrim would swallow all of it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleStop } from 'lucide-react';
import { useEngine, useStore } from '@/app/store';
import { Button } from '@/app/components/Button';
import { Modal } from '@/app/components/Modal';
import { Segmented } from '@/app/components/Segmented';
import { ToggleRow } from '@/app/components/Toggle';
import { Prop } from '@/app/components/Section';
import { saveImage } from '@/engine/export/image';
import { recordVideo, isMp4Supported } from '@/engine/export/video';
import { exportGltf } from '@/engine/export/gltf';
import { downloadBlob } from '@/engine/export/composite';

/* ───────── dialog frame ───────── */

interface DialogProps { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; noClose?: boolean }

/** Shared Modal with a body column and a right-aligned action row. */
function Dialog({ title, onClose, children, footer, noClose }: DialogProps) {
  return (
    <Modal open title={title} onClose={onClose} width="min(440px, 92vw)" noClose={noClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {children}
        {footer && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>{footer}</div>}
      </div>
    </Modal>
  );
}

const fmtElapsed = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/* ───────── recording chip (non-modal) ───────── */

interface ChipProps { elapsed: number; badge: string; note: string; saving: boolean; onStop(): void }

/**
 * Floating "recording" chip: fixed above the status bar, out of the way of the viewport islands.
 * The wrapper is `pointer-events: none` so every pointer event still reaches the canvas, the docks
 * and the inspector — only Stop is clickable.
 */
function RecordingChip({ elapsed, badge, note, saving, onStop }: ChipProps) {
  return createPortal(
    <div
      style={{ position: 'fixed', right: 16, bottom: 'calc(var(--statusbar-h, 28px) + 16px)', zIndex: 95, pointerEvents: 'none' }}
      role="status" aria-live="polite" aria-label={saving ? 'Encoding the recording' : 'Recording'}
    >
      <div className="vp-toolbar" style={{ position: 'static', transform: 'none', gap: 10, padding: '5px 6px 5px 14px' }} title={note}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flex: 'none', background: 'var(--danger)',
          animation: saving ? undefined : 'fade 1s var(--ease) infinite alternate',
        }} />
        <span className="num" style={{ fontSize: 'var(--fs-md)', color: 'var(--fg-0)', fontVariantNumeric: 'tabular-nums' }}>
          {saving ? 'Encoding…' : fmtElapsed(elapsed)}
        </span>
        <span className="label" style={{ color: 'var(--fg-2)' }}>{badge}</span>
        <span style={{ pointerEvents: 'auto' }}>
          <Button size="sm" variant="primary" icon={<CircleStop size={14} strokeWidth={1.5} />} disabled={saving} onClick={onStop}>Stop</Button>
        </span>
      </div>
    </div>,
    document.body,
  );
}

/* ───────── Save image ───────── */

type Scale = '1' | '2' | '4';
type Crop = 'auto' | 'none';

export function SaveImageDialog({ onClose }: { onClose(): void }) {
  const engine = useEngine();
  const hasPhoto = useStore(s => !!s.doc?.environment.backdrop.photo);
  const [scale, setScale] = useState<Scale>('2');
  const [crop, setCrop] = useState<Crop>('auto');
  const [transparent, setTransparent] = useState(false);
  const [grid, setGrid] = useState(true);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await saveImage(engine, { scale: Number(scale), crop, transparent, includeGrid: grid });
      engine.toast('success', 'Image saved');
      onClose();
    } catch (err) {
      engine.toast('error', `Save image failed: ${(err as Error).message}`);
    } finally { setBusy(false); }
  };

  return (
    <Dialog title="Save image" onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Rendering…' : 'Save PNG'}</Button>
    </>}>
      <Prop label="Resolution">
        <Segmented<Scale> value={scale} onChange={setScale} options={[{ value: '1', label: '1×' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }]} />
      </Prop>
      <Prop label="Crop" title="Auto crops to the objects with padding when no venue photo is staged">
        <Segmented<Crop> value={crop} onChange={setCrop} options={[{ value: 'auto', label: 'Auto' }, { value: 'none', label: 'Full frame' }]} />
      </Prop>
      <ToggleRow label="Transparent background" checked={transparent} onChange={setTransparent} hint="Skip the backdrop and keep the alpha channel" />
      <ToggleRow label="Include pixel grid" checked={grid} onChange={setGrid} />
      <div className="hint">{hasPhoto ? 'The venue photo is staged, so the full frame is kept.' : 'With no venue photo the image is cropped to the objects plus padding.'}</div>
    </Dialog>
  );
}

/* ───────── Record video ───────── */

type Duration = '5' | '10' | '15' | '30' | 'manual';
type Fps = '30' | '60';
type RecScale = '1' | '1.5' | '2';
type Phase = 'setup' | 'recording' | 'saving';

export function RecordVideoDialog({ onClose }: { onClose(): void }) {
  const engine = useEngine();
  const [duration, setDuration] = useState<Duration>('10');
  const [fps, setFps] = useState<Fps>('30');
  const [recScale, setRecScale] = useState<RecScale>('1');
  const [turntable, setTurntable] = useState(false);
  const [crop, setCrop] = useState<Crop>('auto');
  const [live, setLive] = useState(engine.settings.liveWebsiteInRecordings);
  const [mp4, setMp4] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>('setup');
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<{ stop(): Promise<Blob>; promise: Promise<Blob> } | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let on = true;
    isMp4Supported().then(v => { if (on) setMp4(v); }).catch(() => { if (on) setMp4(false); });
    return () => { on = false; };
  }, []);
  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);

  const clearTimer = () => { if (timer.current) { window.clearInterval(timer.current); timer.current = null; } };

  const finish = useCallback(async (p: Promise<Blob>) => {
    try {
      const blob = await p;   // recordVideo downloads the file itself
      clearTimer();
      engine.toast('success', `Video saved (${(blob.type || '').includes('mp4') ? 'mp4' : 'webm'})`);
      onClose();
    } catch (err) {
      clearTimer();
      engine.toast('error', `Recording failed: ${(err as Error).message}`);
      setPhase('setup');
    }
  }, [engine, onClose]);

  const start = () => {
    engine.setLiveWebsite(live);
    const r = recordVideo(engine, {
      durationSec: duration === 'manual' ? undefined : Number(duration),
      fps: Number(fps),
      scale: Number(recScale),
      turntable,
      crop,
      liveWebsites: live,
    });
    rec.current = r;
    setPhase('recording');
    setElapsed(0);
    const t0 = performance.now();
    clearTimer();
    timer.current = window.setInterval(() => setElapsed((performance.now() - t0) / 1000), 250);
    void finish(r.promise);
  };

  const stop = () => { const r = rec.current; if (r && phase === 'recording') { setPhase('saving'); void r.stop(); } };

  const badge = mp4 === null ? '…' : mp4 ? 'MP4 · H.264' : 'WebM';

  if (phase !== 'setup') {
    // No Modal here: the app stays live so the take can capture camera moves, drags and slider rides.
    const note = `${duration === 'manual'
      ? (turntable ? 'Recording one full turn (12 s) — stop early at any time.' : 'Recording until you stop.')
      : `Recording for ${duration} s — stop early at any time.`}${turntable ? ' The camera orbits the scene.' : ' The scene stays live — orbit, drag and edit while it records.'}`;
    return <RecordingChip elapsed={elapsed} badge={badge} note={note} saving={phase === 'saving'} onStop={stop} />;
  }

  return (
    <Dialog title="Record video" onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={start}>Start recording</Button>
    </>}>
      <Prop label="Duration">
        <Segmented<Duration> value={duration} onChange={setDuration} options={[
          { value: '5', label: '5 s' }, { value: '10', label: '10 s' }, { value: '15', label: '15 s' }, { value: '30', label: '30 s' }, { value: 'manual', label: 'Manual' },
        ]} />
      </Prop>
      <Prop label="Frame rate">
        <Segmented<Fps> value={fps} onChange={setFps} options={[{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }]} />
      </Prop>
      <Prop label="Resolution" title="Supersample the take relative to the viewport">
        <Segmented<RecScale> value={recScale} onChange={setRecScale} options={[{ value: '1', label: '1×' }, { value: '1.5', label: '1.5×' }, { value: '2', label: '2×' }]} />
      </Prop>
      <Prop label="Crop">
        <Segmented<Crop> value={crop} onChange={setCrop} options={[{ value: 'auto', label: 'Auto' }, { value: 'none', label: 'Full frame' }]} />
      </Prop>
      <ToggleRow label="Turntable" checked={turntable} onChange={setTurntable} hint="Orbit the camera around the scene while recording" />
      <ToggleRow label="Live websites" checked={live} onChange={setLive} hint="Re-rasterise website content each frame (slower; best on a discrete GPU)" />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="hint">Container</span>
        <span className="label">{badge}</span>
      </div>
    </Dialog>
  );
}

/* ───────── Export glTF ───────── */

export function ExportGltfDialog({ onClose }: { onClose(): void }) {
  const engine = useEngine();
  const hasSelection = useStore(s => s.selection.length > 0);
  const docName = useStore(s => s.doc?.name ?? 'showroom');
  const [binary, setBinary] = useState(true);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const file = await exportGltf(engine, { binary, selectionOnly: selectionOnly && hasSelection });
      const base = docName.replace(/[^\w\- ]+/g, '').trim() || 'showroom';
      downloadBlob(file, file.name || `${base}.${binary ? 'glb' : 'gltf'}`);
      engine.toast('success', `Exported ${binary ? 'GLB' : 'glTF'}`);
      onClose();
    } catch (err) {
      engine.toast('error', `Export failed: ${(err as Error).message}`);
    } finally { setBusy(false); }
  };

  return (
    <Dialog title="Export glTF" onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={run} disabled={busy}>{busy ? 'Exporting…' : 'Export'}</Button>
    </>}>
      <ToggleRow label="Binary (.glb)" checked={binary} onChange={setBinary} hint="Single-file binary container; off writes a .gltf with embedded buffers" />
      <ToggleRow label="Selection only" checked={selectionOnly} onChange={setSelectionOnly} disabled={!hasSelection} hint={hasSelection ? 'Export only the selected objects' : 'Select objects first to export a subset'} />
      <div className="hint">Geometry is exported in inches. Content textures are baked as still frames.</div>
    </Dialog>
  );
}
