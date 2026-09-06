/**
 * Venue: backdrop colour and photo (with EXIF focal-length → camera FOV), perspective calibration
 * hand-off, the 3D venue space (room entity) and Gaussian splats (load a file or generate one from
 * a video through the local server pipeline).
 * v1 references: 1804-1941 (markup), 6497-6772 (photo + calibration), 6774-7012 (venue space),
 * 7013-7183 (splats + generation).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Crosshair, Image, Plus, Sparkles, Upload } from 'lucide-react';
import type { Engine } from '@/engine/Engine';
import { isRoom } from '@/engine/document/types';
import { BOOTH_PRESETS, type BoothPreset, createBoothForScene, createRoomForScene, createSplat } from '@/engine/document/defaults';
import { fovFromFocal35, readExifFocal35 } from '@/engine/calibration/perspective';
import { useDoc, useEngine, useStore } from '@/app/store';
import { Button } from '@/app/components/Button';
import { DropZone } from '@/app/components/DropZone';
import { LengthField, NumberField } from '@/app/components/NumberField';
import { Prop, Stat } from '@/app/components/Section';
import { Select } from '@/app/components/Select';
import { Slider } from '@/app/components/Slider';
import { ToggleRow } from '@/app/components/Toggle';
import { getCalibrationSession } from '@/app/shell/CalibrationOverlay';
import { ColorField } from './EntityInspectors';

/* ───────── helpers ───────── */

/** Live perspective FOV (the store does not mirror it; subscribe to the camera's view events). */
function useCameraFov(engine: Engine): number {
  const [fov, setFov] = useState(() => engine.camera.fov);
  useEffect(() => engine.on('view', () => setFov(engine.camera.fov)), [engine]);
  return fov;
}

function imageSize(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise(resolve => {
    const img = new window.Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/* ───────── splat generation (local server pipeline) ───────── */

interface SplatVideo { rel: string; sizeMB: number }
interface SplatJob { stage: string; pct?: number; elapsedSec?: number; ply?: string | null; error?: string | null }

/** v1 7121-7150. */
const STAGE_LABELS: Record<string, string> = {
  starting: 'Starting…', frames: 'Extracting frames',
  features: 'COLMAP: detecting features', match: 'COLMAP: matching frames',
  map: 'COLMAP: solving camera poses', train: 'Training splat',
  done: 'Done', error: 'Failed',
};

const POLL_MS = 2000;

function SplatGenerator({ videos }: { videos: SplatVideo[] }) {
  const engine = useEngine();
  const [file, setFile] = useState(videos[0]?.rel ?? '');
  const [steps, setSteps] = useState(20000);
  const [job, setJob] = useState<SplatJob | null>(null);
  const [running, setRunning] = useState(false);
  const timer = useRef<number | null>(null);
  /** Set once a job has finished so an overlapping (slow) status response cannot add the splat twice. */
  const finished = useRef(false);

  const stopPolling = useCallback(() => { if (timer.current) { window.clearInterval(timer.current); timer.current = null; } }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(async () => {
    try {
      const r = await fetch('/api/splat/status');
      const { job: j } = (await r.json()) as { job: SplatJob | null };
      if (!j) return;
      setJob(j);
      if (j.stage === 'done' && j.ply) {
        if (finished.current) return;
        finished.current = true;
        stopPolling();
        setRunning(false);
        const name = j.ply.split('/').pop() || 'splat.ply';
        engine.add(createSplat(name, { url: j.ply }));
        engine.toast('success', 'Splat generated and added to the scene');
      } else if (j.stage === 'error') {
        if (finished.current) return;
        finished.current = true;
        stopPolling();
        setRunning(false);
        if (j.error !== 'cancelled') engine.toast('error', `Splat generation failed: ${j.error || 'unknown'}`);
      }
    } catch { /* server hiccup; keep polling */ }
  }, [engine, stopPolling]);

  const start = async () => {
    if (!file) return;
    finished.current = false;
    setRunning(true);
    setJob({ stage: 'starting', pct: 0, elapsedSec: 0 });
    try {
      const r = await fetch('/api/splat/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, steps }) });
      const resp = (await r.json()) as { error?: string };
      if (resp.error) { engine.toast('error', resp.error); setRunning(false); setJob(null); return; }
      stopPolling();
      timer.current = window.setInterval(() => void poll(), POLL_MS);
    } catch (err) {
      engine.toast('error', `Could not start: ${(err as Error).message}`);
      setRunning(false);
      setJob(null);
    }
  };

  const cancel = () => { void fetch('/api/splat/cancel', { method: 'POST' }).catch(() => { /* ignore */ }); };

  const pct = Math.max(0, Math.min(100, job?.pct ?? 0));
  const elapsed = job?.elapsedSec ?? 0;
  const progressText = job ? `${STAGE_LABELS[job.stage] ?? job.stage} — ${pct}% · ${Math.floor(elapsed / 60)}m${String(Math.floor(elapsed % 60)).padStart(2, '0')}s` : '';

  return (
    <>
      <div className="divider" />
      <span className="label">Generate splat from video</span>
      {videos.length === 0 ? (
        <div className="hint">No videos found in led-showroom-spaces.</div>
      ) : (
        <>
          <Prop label="Video">
            <Select<string> value={file} options={videos.map(v => ({ value: v.rel, label: `${v.rel} (${v.sizeMB} MB)` }))} onChange={v => setFile(String(v))} disabled={running} />
          </Prop>
          <Prop label="Training steps" title="More steps give a sharper splat and take longer">
            <NumberField value={steps} min={2000} max={60000} step={1000} decimals={0} disabled={running} onChange={v => setSteps(Math.round(v))} />
          </Prop>
          {running ? (
            <>
              <div style={{ height: 2, background: 'var(--line-strong)', borderRadius: 1, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width var(--t-med) var(--ease)' }} />
              </div>
              <div className="hint num">{progressText}</div>
              <Button size="sm" onClick={cancel}>Cancel</Button>
            </>
          ) : (
            <Button block icon={<Sparkles size={14} strokeWidth={1.5} />} onClick={() => void start()} disabled={!file}>Start generation</Button>
          )}
          <div className="hint">Runs ffmpeg, COLMAP and Brush locally on this machine's GPU; typically 10–40 minutes.</div>
        </>
      )}
    </>
  );
}

/* ───────── panel ───────── */

export function VenuePanel() {
  const engine = useEngine();
  const doc = useDoc();
  const unit = doc.settings.units;
  const env = doc.environment;
  const photo = env.backdrop.photo ?? null;
  const calib = env.backdrop.calibration ?? null;
  const viewLocked = useStore(s => s.viewLocked);
  const tool = useStore(s => s.tool);
  const fov = useCameraFov(engine);
  const room = doc.entities.find(isRoom);
  const splatInput = useRef<HTMLInputElement>(null);
  /** Resize the existing room to a booth footprint, or add one if the scene has no room yet. */
  const setBoothFootprint = (p: BoothPreset) => {
    if (!room) { engine.add(createBoothForScene(p, engine.doc.entities)); return; }
    engine.update(room.id, { widthIn: p.widthFt * 12, heightIn: p.heightFt * 12, depthIn: p.depthFt * 12 }, { label: 'Booth footprint' });
  };
  const [genVideos, setGenVideos] = useState<SplatVideo[] | null>(null);

  useEffect(() => {
    let on = true;
    fetch('/api/splat/videos')
      .then(r => (r.ok ? (r.json() as Promise<{ available: boolean; videos: SplatVideo[] }>) : null))
      .then(info => { if (on && info?.available) setGenVideos(info.videos ?? []); })
      .catch(() => { /* static deploy: no pipeline */ });
    return () => { on = false; };
  }, []);

  /** FOV is view state like the rest of the camera: the rig's 'change' event schedules the autosave that merges it into doc.view. */
  const setFov = (v: number) => engine.camera.setFov(Math.round(v));

  /**
   * The stored photo url is a session `blob:` URL; after a reload, preset load or scene import it is dead
   * (or absent — scene files keep only the assetId). Re-resolve it from the asset store and write it back
   * outside history so Environment.apply gets a live URL.
   */
  useEffect(() => {
    const id = photo?.assetId;
    if (!id) return;
    const live = engine.assets.urlIfLoaded(id);
    if (live && photo.url === live) return;
    let on = true;
    void engine.assets.getUrl(id).then(url => {
      if (!on || !url) return;
      const d = engine.doc;
      const cur = d.environment.backdrop.photo;
      if (cur?.assetId !== id || cur.url === url) return;
      engine.setDoc({ ...d, environment: { ...d.environment, backdrop: { ...d.environment.backdrop, photo: { ...cur, url } } } });
      engine.invalidate();
    }).catch(() => { /* asset missing: leave the document as is */ });
    return () => { on = false; };
  }, [engine, photo?.assetId, photo?.url]);

  const onPhoto = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    try {
      const [buf, id] = await Promise.all([file.arrayBuffer(), engine.assets.put(file)]);
      const url = (await engine.assets.getUrl(id)) ?? undefined;
      let fovDeg: number | undefined;
      const f35 = readExifFocal35(buf);
      if (f35 && url) {
        const size = await imageSize(url);
        const f = size ? fovFromFocal35(f35, size.w >= size.h) : null;
        if (f) fovDeg = Math.round(f);
      }
      engine.patchEnvironment(e => ({ ...e, backdrop: { ...e.backdrop, photo: { assetId: id, url, name: file.name, fovDeg }, calibration: null } }), 'Set venue photo');
      if (fovDeg !== undefined) {
        setFov(fovDeg);
        engine.toast('info', `Camera FOV set to ${fovDeg}° from the photo's focal length`);
      }
    } catch (err) {
      engine.toast('error', `Could not load photo: ${(err as Error).message}`);
    }
  };

  const clearPhoto = () => {
    const session = getCalibrationSession(engine);
    session.disposeGrid();
    session.reset();
    engine.patchEnvironment(e => ({ ...e, backdrop: { ...e.backdrop, photo: null, calibration: null } }), 'Clear venue photo');
    if (engine.camera.locked) engine.camera.setLocked(false);
    if (tool === 'calibrate') engine.tools.activate('select');
  };

  const patchCalib = (patch: Partial<NonNullable<typeof calib>>, label: string, mergeKey?: string) =>
    engine.patchEnvironment(e => (e.backdrop.calibration
      ? { ...e, backdrop: { ...e.backdrop, calibration: { ...e.backdrop.calibration, ...patch } } }
      : e), label, mergeKey);

  const setViewLocked = (v: boolean) => {
    engine.camera.setLocked(v);
    if (calib) patchCalib({ locked: v }, v ? 'Lock view' : 'Unlock view', 'calibration:locked');
  };

  const onSplatFile = async (file: File) => {
    try {
      const id = await engine.assets.put(file);
      engine.add(createSplat(file.name, { assetId: id }));
    } catch (err) { engine.toast('error', `Splat load failed: ${(err as Error).message}`); }
  };

  return (
    <>
      <Prop label="Backdrop">
        <ColorField value={env.backdrop.color} onChange={v => engine.patchEnvironment(e => ({ ...e, backdrop: { ...e.backdrop, color: v } }), 'Backdrop colour', 'env:backdrop.color')} />
      </Prop>

      {photo ? (
        <div className="row">
          <Image size={14} strokeWidth={1.5} style={{ color: 'var(--fg-2)', flex: 'none' }} />
          <span className="truncate grow" style={{ fontSize: 'var(--fs-xs)' }} title={photo.name}>{photo.name}</span>
          <Button size="sm" variant="ghost" onClick={clearPhoto}>Clear</Button>
        </div>
      ) : (
        <DropZone accept="image/*" onFiles={files => void onPhoto(files)} icon={<Upload />}
          label={<>Drop a venue photo or <b>browse</b></>} hint="A photo of where the wall will be placed" />
      )}

      {photo && (
        <>
          <Prop label="Camera FOV" title="Match the 3D camera's field of view to the photo's focal length so wall perspective lines up with the photo's sightlines">
            <Slider value={fov} min={8} max={110} step={1} onChange={setFov} />
            <span className="num muted" style={{ fontSize: 'var(--fs-2xs)', minWidth: 30, textAlign: 'right' }}>{Math.round(fov)}°</span>
          </Prop>
          <ToggleRow label="Lock view" checked={viewLocked} onChange={setViewLocked}
            hint="Freeze orbit and zoom so the matched perspective can't be disturbed — use the move tool to place the wall" />
          <div className="hint">FOV auto-sets from the photo's EXIF focal length when available. Fine-tune until the wall's perspective matches the photo's sightlines, then lock the view and position the wall with the move tool.</div>

          <Button block active={tool === 'calibrate'} icon={<Crosshair size={14} strokeWidth={1.5} />} onClick={() => engine.tools.activate('calibrate')}
            title="Trace four sightlines on the photo; the camera solves to match its exact perspective">
            Calibrate perspective (trace sightlines)
          </Button>
          <Stat label="Calibration" value={calib?.solved ? `Solved · ${Math.round(calib.solved.fovDeg)}° FOV` : 'Not calibrated'} />

          {calib && (
            <ToggleRow label="Show sightline grid" checked={calib.showGrid} onChange={v => getCalibrationSession(engine).toggleGrid(engine, v)}
              hint="Ground grid drawn in the solved perspective — wall movements track these lines" />
          )}
          {calib?.solved && (
            <>
              <Prop label="Camera height" title="Height of the camera that took the photo, above the venue floor — pins the solved perspective to real scale">
                <LengthField inches={calib.cameraHeightIn ?? 60} unit={unit} min={6} max={480} scrub="H"
                  onChange={v => getCalibrationSession(engine).applyMeasurements(engine, v, calib.cameraDistanceIn ?? 300)}
                  onCommit={() => engine.history.commit()} />
              </Prop>
              <Prop label="Camera distance" title="Horizontal distance from the camera to the world origin (where the wall starts)">
                <LengthField inches={calib.cameraDistanceIn ?? 300} unit={unit} min={12} max={3000} stepIn={6} scrub="D"
                  onChange={v => getCalibrationSession(engine).applyMeasurements(engine, calib.cameraHeightIn ?? 60, v)}
                  onCommit={() => engine.history.commit()} />
              </Prop>
            </>
          )}
        </>
      )}

      <div className="divider" />
      <span className="label">Venue space (3D room)</span>
      {room ? (
        <div className="hint">
          <a href="#select-room" onClick={e => { e.preventDefault(); engine.select([room.id]); }}>Select room</a>
          {' '}— its surface photos and colour are edited in the room inspector.
        </div>
      ) : (
        <>
          <Button block icon={<Plus size={14} strokeWidth={1.5} />} onClick={() => engine.add(createRoomForScene(engine.doc.entities))}>Add venue space</Button>
          <div className="hint">A proportional room built around the wall — navigate it like a floating camera.</div>
        </>
      )}
      {/* Footprints stay available once a room exists: trying one size and then another is the
          obvious next move, so an existing room is resized in place (one undo step, its position,
          photos and colour kept) instead of the panel asking for it to be deleted first. */}
      <div className="row">
        {BOOTH_PRESETS.map(p => (
          <Button key={p.id} size="sm" className="grow" onClick={() => setBoothFootprint(p)}
            tip={`${p.label} — ${room ? 'resize the room to this footprint' : 'a room at this footprint'}, walls at the 8 ft drape height`}>
            {p.widthFt} × {p.depthFt}
          </Button>
        ))}
      </div>
      <div className="hint">Trade-show booth footprints in feet, walls on the 8 ft drape line.</div>

      <div className="divider" />
      <span className="label">Gaussian splat</span>
      <Button block icon={<Upload size={14} strokeWidth={1.5} />} onClick={() => splatInput.current?.click()}>Load splat…</Button>
      <input ref={splatInput} type="file" accept=".ply,.splat,.ksplat" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onSplatFile(f); }} />
      <div className="hint">A photoreal 3D capture (.ply, .splat or .ksplat). Align its scale and position in the splat inspector.</div>
      {genVideos && <SplatGenerator videos={genVideos} />}
    </>
  );
}
