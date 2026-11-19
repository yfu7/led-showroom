/**
 * Builds saved on this computer: the browser for the folder of `.showroom.json` files the local
 * server keeps (`server/scenes.cjs`, client in `engine/persistence/sceneStore.ts`).
 *
 * The app's own memory is browser storage — one autosaved document, fifty presets — held per browser
 * profile and per origin, and gone with the site data. This dialog is the copy that survives all of
 * that: files in a folder, backed up with everything else on the disk.
 *
 * The folder's real path is on show in the standard view, not just the diagnostic one. It is the
 * literal answer to "where did my build go", and `Documents` is not always the Documents that
 * Explorer shows — OneDrive folder redirection moves it, and only the resolved path says where.
 *
 * Overwriting is safe and the dialog says so before you do it: the server moves the previous file
 * into `versions/` first, and those copies are listed under the scene they came from. Deleting is
 * the opposite, and is armed before it fires: the file is unlinked, not sent to the Recycle Bin.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, HardDrive, History, Save, Trash2 } from 'lucide-react';
import { useEngine, useStore } from '@/app/store';
import { Button } from '@/app/components/Button';
import { Modal } from '@/app/components/Modal';
import { TextField } from '@/app/components/TextField';
import { Raw } from '@/app/shell/GodMode';
import {
  deleteStoredScene, listStoredScenes, readStoredScene, writeStoredScene,
  type SceneStoreListing, type StoredSceneMeta,
} from '@/engine/persistence/sceneStore';

const fmtWhen = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const fmtSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

/** How long a primed Delete stays primed. Long enough to mean it, short enough not to lie in wait. */
const ARM_MS = 5000;

export function SavedBuildsDialog({ onClose }: { onClose(): void }) {
  const engine = useEngine();
  const doc = useStore(s => s.doc);
  const god = useStore(s => s.godMode);

  // undefined while the first listing is in flight; null once the server has answered that it is
  // not there (it can stop while the dialog is open).
  const [listing, setListing] = useState<SceneStoreListing | null | undefined>(undefined);
  const [name, setName] = useState(doc?.name ?? 'Showroom');
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(async () => {
    const next = await listStoredScenes();
    if (alive.current) setListing(next);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // A primed Delete disarms itself, so a dialog left open does not keep a loaded button.
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(null), ARM_MS);
    return () => window.clearTimeout(t);
  }, [armed]);

  const scenes = listing?.scenes ?? [];
  const trimmed = name.trim();
  const existing = useMemo(
    () => scenes.find(s => s.name.toLowerCase() === trimmed.toLowerCase()) ?? null,
    [scenes, trimmed],
  );

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      engine.toast('error', (err as Error).message || String(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const save = () => run('save', async () => {
    const snap = engine.snapshot();
    const { saved, missing } = await writeStoredScene(trimmed, snap, engine.assets);
    await refresh();
    setArmed(null);
    if (missing.length) {
      engine.toast('error', `Saved ${saved.name}, but ${missing.length} asset${missing.length === 1 ? '' : 's'} were too large to embed`);
    } else {
      engine.toast('success', `Saved ${saved.name} to this computer`);
    }
  });

  const load = (meta: StoredSceneMeta) => run(meta.file, async () => {
    const { doc: loaded, missing } = await readStoredScene(meta.file, engine.assets);
    engine.loadDocument(loaded);
    if (missing.length) engine.toast('error', `Opened with ${missing.length} missing asset${missing.length === 1 ? '' : 's'}`);
    else engine.toast('success', `Opened ${loaded.name}`);
    onClose();
  });

  const remove = (meta: StoredSceneMeta) => {
    if (armed !== meta.file) { setArmed(meta.file); return; }
    setArmed(null);
    void run(meta.file, async () => {
      await deleteStoredScene(meta.file);
      await refresh();
      engine.toast('info', `Deleted ${meta.name}`);
    });
  };

  const toggle = (file: string) => setOpen(prev => {
    const next = new Set(prev);
    if (!next.delete(file)) next.add(file);
    return next;
  });

  const row = (meta: StoredSceneMeta, isVersion: boolean, versionCount = 0) => {
    const isArmed = armed === meta.file;
    const working = busy === meta.file;
    return (
      <div key={meta.file} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0', borderTop: '1px solid var(--line)' }}>
        <div className="row" style={{ alignItems: 'center', gap: 8, paddingLeft: isVersion ? 18 : 0 }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ fontSize: 'var(--fs-sm)' }}>{isVersion ? fmtWhen(meta.savedAt) : meta.name}</span>
            {!isVersion && <span className="hint" style={{ fontSize: 'var(--fs-2xs)', marginLeft: 8 }}>{fmtWhen(meta.savedAt)}</span>}
            <span className="hint" style={{ fontSize: 'var(--fs-2xs)', marginLeft: 8 }}>{fmtSize(meta.sizeBytes)}</span>
          </span>
          <Button size="sm" variant="ghost" icon={<FolderOpen size={13} strokeWidth={1.5} />} disabled={working} onClick={() => void load(meta)}>Open</Button>
          <Button size="sm" variant={isArmed ? 'danger' : 'ghost'} icon={<Trash2 size={13} strokeWidth={1.5} />} disabled={working} onClick={() => remove(meta)}>
            {isArmed ? 'Delete for good' : 'Delete'}
          </Button>
        </div>
        {isArmed && (
          <div className="hint" style={{ fontSize: 'var(--fs-2xs)', paddingLeft: isVersion ? 18 : 0 }}>
            {versionCount > 0
              ? `Removes this build and the ${versionCount} earlier ${versionCount === 1 ? 'version' : 'versions'} kept for it. The files are deleted, not sent to the Recycle Bin.`
              : 'The file is deleted, not sent to the Recycle Bin.'}
          </div>
        )}
        {god && <div style={{ paddingLeft: isVersion ? 18 : 0 }}><Raw label={meta.file} value={`${meta.sizeBytes} B · savedAt ${meta.savedAt}`} /></div>}
      </div>
    );
  };

  return (
    <Modal open title="Builds on this computer" onClose={onClose} width="min(560px, 94vw)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {listing === undefined && <div className="hint" style={{ fontSize: 'var(--fs-sm)' }}>Looking…</div>}

        {listing === null && (
          <div className="hint" style={{ fontSize: 'var(--fs-sm)' }}>
            The local server is not running, so there is nowhere on this computer to save to. Start it
            with <code>npm run server</code> and reopen this dialog. The browser keeps its own copy of
            the current scene either way, and File → Save .showroom.json always works.
          </div>
        )}

        {listing && (
          <>
            {/* Where the files are. In the standard view too: it is the whole question being answered. */}
            <div className="hint" style={{ fontSize: 'var(--fs-2xs)', wordBreak: 'break-all' }}>
              <HardDrive size={11} strokeWidth={1.5} style={{ verticalAlign: '-1px', marginRight: 4 }} />
              {listing.dir}
            </div>

            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <TextField
                value={name} onChange={setName} onCommit={() => { if (trimmed) save(); }}
                placeholder="Name this build" aria-label="Build name" className="grow"
              />
              <Button
                variant="primary" icon={<Save size={14} strokeWidth={1.5} />}
                disabled={!trimmed || busy === 'save'} onClick={save}
              >
                {busy === 'save' ? 'Saving…' : 'Save'}
              </Button>
            </div>
            {existing && (
              <div className="hint" style={{ fontSize: 'var(--fs-2xs)' }}>
                “{existing.name}” is already saved. Saving again keeps the current file as a version —
                nothing is lost.
              </div>
            )}

            {scenes.length === 0
              ? <div className="hint" style={{ fontSize: 'var(--fs-sm)', marginTop: 4 }}>Nothing saved here yet.</div>
              : (
                <div style={{ maxHeight: '46vh', overflowY: 'auto', marginTop: 4 }}>
                  {scenes.map(scene => (
                    <div key={scene.file}>
                      {row(scene, false, scene.versions.length)}
                      {scene.versions.length > 0 && (
                        <div style={{ paddingLeft: 18 }}>
                          <Button size="sm" variant="ghost" icon={<History size={13} strokeWidth={1.5} />} onClick={() => toggle(scene.file)}>
                            {open.has(scene.file) ? 'Hide' : 'Show'} {scene.versions.length} earlier {scene.versions.length === 1 ? 'version' : 'versions'}
                          </Button>
                        </div>
                      )}
                      {open.has(scene.file) && scene.versions.map(v => row(v, true))}
                    </div>
                  ))}
                </div>
              )}

            {god && (
              <div style={{ marginTop: 8 }}>
                <Raw label="scenesDir" value={listing.dir} />
                <Raw label="scenes" value={String(scenes.length)} />
                <Raw label="versions" value={String(scenes.reduce((n, s) => n + s.versions.length, 0))} />
                <Raw label="bytes on disk" value={String(scenes.reduce((n, s) => n + s.sizeBytes + s.versions.reduce((m, v) => m + v.sizeBytes, 0), 0))} />
              </div>
            )}
          </>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}
