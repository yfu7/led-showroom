/**
 * Presets: named snapshots of the whole document (v1 2047-2100, 8893-9110).
 * Save with a thumbnail of the current view, load on click, rename on double-click, delete.
 */
import { useCallback, useEffect, useState } from 'react';
import { Trash } from 'lucide-react';
import type { Engine } from '@/engine/Engine';
import { useEngine } from '@/app/store';
import { Button, IconButton } from '@/app/components/Button';
import { TextField } from '@/app/components/TextField';
import { V1_IMPORTED_KEY, deletePreset, importV1Presets, listPresets, loadPreset, renamePreset, savePreset, type PresetMeta } from '@/engine/persistence/presets';

const V1_KEY = 'led-showroom-presets';
const THUMB_W = 160;

/** Downscaled JPEG of the current WebGL frame (rendered synchronously so the buffer is fresh). */
function captureThumbnail(engine: Engine): string | undefined {
  try {
    engine.renderNow();
    const src = engine.renderer.gl.domElement;
    if (src.width < 1 || src.height < 1) return undefined;
    const h = Math.max(1, Math.round(THUMB_W * src.height / src.width));
    const c = document.createElement('canvas');
    c.width = THUMB_W; c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = engine.doc.environment.backdrop.color || '#000';
    ctx.fillRect(0, 0, THUMB_W, h);
    ctx.drawImage(src, 0, 0, THUMB_W, h);
    return c.toDataURL('image/jpeg', 0.5);
  } catch { return undefined; }
}

/** Legacy presets exist and have not been imported yet (the legacy key is never removed, so check the import marker too). */
const hasV1Presets = (): boolean => { try { return !!localStorage.getItem(V1_KEY) && !localStorage.getItem(V1_IMPORTED_KEY); } catch { return false; } };

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function PresetsPanel() {
  const engine = useEngine();
  const [presets, setPresets] = useState<PresetMeta[]>(() => listPresets());
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [v1, setV1] = useState(hasV1Presets);

  const refresh = useCallback(() => setPresets(listPresets()), []);
  useEffect(() => { refresh(); }, [refresh]);

  const save = () => {
    const n = name.trim();
    if (!n) return;
    // writeAll() throws once nothing fits in storage even after dropping thumbnails / old presets.
    try {
      savePreset(n, engine.snapshot(), captureThumbnail(engine));
      setName('');
      refresh();
      engine.toast('success', `Saved preset "${n}"`);
    } catch (err) {
      engine.toast('error', `Could not save preset: ${(err as Error).message}`);
    }
  };

  const load = (p: PresetMeta) => {
    const doc = loadPreset(p.id);
    if (!doc) { engine.toast('error', 'Preset could not be read'); refresh(); return; }
    engine.loadDocument(doc, `Load preset ${p.name}`);
    engine.toast('info', `Loaded "${p.name}"`);
  };

  const remove = (p: PresetMeta) => {
    try { deletePreset(p.id); } catch (err) { engine.toast('error', `Could not delete preset: ${(err as Error).message}`); }
    refresh();
  };

  const commitRename = () => {
    if (!renaming) return;
    const t = renaming.text.trim();
    if (t) { try { renamePreset(renaming.id, t); } catch (err) { engine.toast('error', `Could not rename preset: ${(err as Error).message}`); } }
    setRenaming(null);
    refresh();
  };

  const importV1 = () => {
    const n = importV1Presets();
    refresh();
    setV1(false);
    engine.toast(n ? 'success' : 'info', n ? `Imported ${n} v1 preset${n === 1 ? '' : 's'}` : 'No v1 presets to import');
  };

  return (
    <>
      <div className="row">
        <TextField className="grow" placeholder="Preset name" value={name} maxLength={40} onChange={setName} onCommit={save} onKeyDown={e => e.stopPropagation()} />
        <Button size="sm" variant="primary" onClick={save} disabled={!name.trim()}>Save</Button>
      </div>

      {presets.length === 0 ? (
        <div className="hint">No saved presets yet. Name the current scene and save it to come back to it later.</div>
      ) : (
        <div className="list" style={{ margin: '0 -8px 0 -12px' }}>
          {presets.map(p => (
            <div key={p.id} className="list-row" onClick={() => { if (renaming?.id !== p.id) load(p); }} title={p.summary}>
              {p.thumbnail ? (
                <img src={p.thumbnail} alt="" style={{ width: 40, height: 26, objectFit: 'cover', borderRadius: 3, flex: 'none', background: 'var(--bg-3)' }} draggable={false} />
              ) : (
                <span style={{ width: 40, height: 26, borderRadius: 3, flex: 'none', background: 'var(--bg-3)' }} />
              )}
              {renaming?.id === p.id ? (
                <input
                  className="rename" autoFocus value={renaming.text}
                  onClick={e => e.stopPropagation()}
                  onChange={e => setRenaming({ id: p.id, text: e.target.value })}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenaming(null); }}
                  onBlur={commitRename}
                />
              ) : (
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, padding: '4px 0' }}
                  onDoubleClick={e => { e.stopPropagation(); setRenaming({ id: p.id, text: p.name }); }}>
                  <span className="name" title="Double-click to rename">{p.name}</span>
                  <span className="meta truncate">{p.summary} · {fmtDate(p.savedAt)}</span>
                </span>
              )}
              <span className="actions">
                <IconButton size="sm" tip="Delete preset" onClick={e => { e.stopPropagation(); remove(p); }}><Trash /></IconButton>
              </span>
            </div>
          ))}
        </div>
      )}

      {v1 && (
        <div className="hint">
          Presets from the previous version were found. <a href="#import-v1" onClick={e => { e.preventDefault(); importV1(); }}>Import v1 presets</a>
        </div>
      )}
    </>
  );
}
