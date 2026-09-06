/**
 * Inspectors for the non-LED entity types: stage decks, equipment, rooms (venue space), imported
 * models, Gaussian splats and measurements. Each takes the entity as a prop and writes through the
 * engine (continuous edits carry a mergeKey so scrubbing collapses into one undo entry).
 */
import { useEffect, useState } from 'react';
import { Trash, Upload, X } from 'lucide-react';
import type {
  ContentSource, DimensionEntity, EquipmentEntity, ModelEntity, RoomEntity, SplatEntity, StageEntity, SurfaceMedia,
} from '@/engine/document/types';
import type { Vec3 } from '@/engine/math';
import { v3dist, v3eq } from '@/engine/math';
import { DEG, UNITS, formatDims, formatLength, fromInches, unitDecimals } from '@/engine/units';
import { STAGE_HEIGHTS_IN } from '@/engine/ledwall/specs';
import { createStage, ledWallDatum } from '@/engine/document/defaults';
import { uniqueName } from '@/engine/document/Document';
import { equipmentDef } from '@/engine/catalog/equipment';
import { useDoc, useEngine, useStore } from '@/app/store';
import { Button, IconButton } from '@/app/components/Button';
import { LengthField, NumberField } from '@/app/components/NumberField';
import { Prop, Section, Stat } from '@/app/components/Section';
import { Select } from '@/app/components/Select';
import { Slider } from '@/app/components/Slider';
import { ToggleRow } from '@/app/components/Toggle';
import { DropZone } from '@/app/components/DropZone';

/* ───────── shared: colour field ───────── */

const safeHex = (v: string): string => (/^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '#000000');

export interface ColorFieldProps { value: string; onChange(v: string): void; onCommit?(): void; disabled?: boolean }

/** Swatch + hex text. The swatch fires continuously (pair with a mergeKey); the text commits on blur/Enter. */
export function ColorField({ value, onChange, onCommit, disabled }: ColorFieldProps) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  const commit = () => {
    const t = text.trim().toLowerCase();
    const full = /^#?[0-9a-f]{6}$/.test(t) ? (t.startsWith('#') ? t : `#${t}`) : null;
    if (full) { if (full !== value.toLowerCase()) onChange(full); onCommit?.(); }
    else setText(value);
  };
  return (
    <div className="field color grow">
      <input type="color" value={safeHex(value)} disabled={disabled} onChange={e => onChange(e.target.value)} onBlur={() => onCommit?.()} />
      <input
        type="text" value={text} disabled={disabled} spellCheck={false} maxLength={7}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', letterSpacing: 0 }}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }}
      />
    </div>
  );
}

const upIcon = <Upload size={14} strokeWidth={1.5} />;

/* ───────── Stage deck ───────── */

const FT = 12;

export function StageInspector({ entity }: { entity: StageEntity }) {
  const engine = useEngine();
  const doc = useDoc();
  const unit = doc.settings.units;
  const [customH, setCustomH] = useState(false);
  // Inspector reuses this instance across selections, so the 'Custom' choice must not leak to another deck.
  useEffect(() => setCustomH(false), [entity.id]);
  const up = (patch: Partial<StageEntity>, mergeKey?: string, label?: string) => engine.update<StageEntity>(entity.id, patch, { mergeKey, label });

  const std = (STAGE_HEIGHTS_IN as readonly number[]).includes(entity.heightIn);
  const heightSel = std && !customH ? String(entity.heightIn) : 'custom';
  const heightOptions = [...STAGE_HEIGHTS_IN.map(h => ({ value: String(h), label: formatLength(h, unit) })), { value: 'custom', label: 'Custom' }];

  /** Add a deck of the same size flush against this one along its local ±X / ±Z (v1 7358-7373, simplified to flush placement). */
  const addAdjacent = (dx: number, dz: number) => {
    const ry = entity.transform.rotation[1] * DEG;
    const ox = dx * entity.widthIn, oz = dz * entity.depthIn;
    const wx = ox * Math.cos(ry) + oz * Math.sin(ry);
    const wz = -ox * Math.sin(ry) + oz * Math.cos(ry);
    const p = entity.transform.position;
    const deck = createStage(entity.heightIn, [p[0] + wx, p[1], p[2] + wz], uniqueName(doc, 'Stage deck'));
    deck.widthIn = entity.widthIn;
    deck.depthIn = entity.depthIn;
    deck.color = entity.color;
    deck.transform.rotation = [...entity.transform.rotation] as Vec3;
    deck.parentId = entity.parentId ?? null;
    engine.add(deck);
  };

  return (
    <>
      <Section title="Deck">
        <Prop label="Size">
          <LengthField inches={entity.widthIn} unit={unit} min={6} scrub="W" onChange={v => up({ widthIn: v }, 'stage:w')} />
          <LengthField inches={entity.depthIn} unit={unit} min={6} scrub="D" onChange={v => up({ depthIn: v }, 'stage:d')} />
        </Prop>
        <Prop label="Height">
          <Select value={heightSel} options={heightOptions} onChange={v => { if (v === 'custom') setCustomH(true); else { setCustomH(false); up({ heightIn: Number(v) }, undefined, 'Deck height'); } }} />
        </Prop>
        {heightSel === 'custom' && (
          <Prop label="Custom height">
            <LengthField inches={entity.heightIn} unit={unit} min={1} max={240} scrub="H" onChange={v => up({ heightIn: v }, 'stage:h')} />
          </Prop>
        )}
        <Prop label="Colour">
          <ColorField value={entity.color ?? '#1a1a1c'} onChange={v => up({ color: v }, 'stage:color')} />
        </Prop>
        <Stat label="Top at" value={formatLength(entity.transform.position[1] + entity.heightIn, unit)} />
      </Section>
      <Section title="Adjacent decks">
        <div className="hint">Add another deck of the same size flush against this one.</div>
        <div className="grid-2">
          <Button size="sm" onClick={() => addAdjacent(1, 0)}>Add +X</Button>
          <Button size="sm" onClick={() => addAdjacent(-1, 0)}>Add −X</Button>
          <Button size="sm" onClick={() => addAdjacent(0, 1)}>Add +Z</Button>
          <Button size="sm" onClick={() => addAdjacent(0, -1)}>Add −Z</Button>
        </div>
      </Section>
    </>
  );
}

/* ───────── Equipment ───────── */

const SCREEN_GEOMETRIES: EquipmentEntity['geometry'][] = ['kiosk', 'totem', 'screen'];

export function EquipmentInspector({ entity }: { entity: EquipmentEntity }) {
  const engine = useEngine();
  const unit = useDoc().settings.units;
  const def = equipmentDef(entity.catalogId);
  const up = (patch: Partial<EquipmentEntity>, mergeKey?: string, label?: string) => engine.update<EquipmentEntity>(entity.id, patch, { mergeKey, label });

  const setDim = (i: 0 | 1 | 2, v: number) => { const d = [...entity.dims] as Vec3; d[i] = v; up({ dims: d }, `eq:dims:${i}`); };
  const variantValue = def?.variants?.find(v => v3eq(v.dims, entity.dims))?.name ?? 'custom';
  const variantOptions = def?.variants ? [...def.variants.map(v => ({ value: v.name, label: v.name })), ...(variantValue === 'custom' ? [{ value: 'custom', label: 'Custom' }] : [])] : [];

  const hasScreen = SCREEN_GEOMETRIES.includes(entity.geometry);
  const setScreen = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    try {
      const id = await engine.assets.put(f);
      const isVideo = f.type.startsWith('video');
      const source: ContentSource = { type: isVideo ? 'video' : 'image', assetId: id, name: f.name, mimeType: f.type, loop: true, muted: true };
      up({ screen: source }, undefined, 'Set screen media');
    } catch (err) { engine.toast('error', `Could not load media: ${(err as Error).message}`); }
  };

  return (
    <>
      <Section title="Item">
        <Stat label="Catalog" value={def?.name ?? entity.catalogId} />
        {def?.description && <div className="hint">{def.description}</div>}
        {/* Published spec sheet for the real rental products, shown as Veloxity's label/value rows. */}
        {def?.specs?.map(s => <Stat key={s.label} label={s.label} value={s.value} />)}
        {variantOptions.length > 0 && (
          <Prop label="Variant">
            <Select value={variantValue} options={variantOptions} onChange={n => { const v = def?.variants?.find(x => x.name === n); if (v) up({ dims: [...v.dims] as Vec3 }, undefined, 'Change variant'); }} />
          </Prop>
        )}
        <Prop label="Size">
          <LengthField inches={entity.dims[0]} unit={unit} min={1} scrub="W" onChange={v => setDim(0, v)} />
          <LengthField inches={entity.dims[1]} unit={unit} min={1} scrub="H" onChange={v => setDim(1, v)} />
          <LengthField inches={entity.dims[2]} unit={unit} min={1} scrub="D" onChange={v => setDim(2, v)} />
        </Prop>
        <Prop label="Colour">
          <ColorField value={entity.color} onChange={v => up({ color: v }, 'eq:color')} />
        </Prop>
        <Prop label="Accent">
          <ColorField value={entity.accent ?? entity.color} onChange={v => up({ accent: v }, 'eq:accent')} />
        </Prop>
      </Section>
      {hasScreen && (
        <Section title="Screen">
          {entity.screen ? (
            <div className="row">
              <span className="truncate grow" style={{ fontSize: 'var(--fs-xs)' }} title={entity.screen.name}>{entity.screen.name ?? entity.screen.type}</span>
              <span className="label">{entity.screen.type}</span>
              <IconButton size="sm" tip="Clear screen media" onClick={() => up({ screen: null }, undefined, 'Clear screen media')}><X /></IconButton>
            </div>
          ) : (
            <DropZone accept="image/*,video/*" onFiles={files => void setScreen(files)} icon={upIcon}
              label={<>Drop an image or video or <b>browse</b></>} hint="Shown on the screen at its native aspect" />
          )}
        </Section>
      )}
    </>
  );
}

/* ───────── Room (venue space) ───────── */

type Side = keyof RoomEntity['show'];
const SIDES: { key: Side; label: string }[] = [
  { key: 'back', label: 'Back wall' }, { key: 'floor', label: 'Floor' }, { key: 'ceiling', label: 'Ceiling' }, { key: 'left', label: 'Left wall' }, { key: 'right', label: 'Right wall' },
];

export function RoomInspector({ entity }: { entity: RoomEntity }) {
  const engine = useEngine();
  const doc = useDoc();
  const unit = doc.settings.units;
  const up = (patch: Partial<RoomEntity>, mergeKey?: string, label?: string) => engine.update<RoomEntity>(entity.id, patch, { mergeKey, label });

  // "Wall from back" is derived from the transform (v1 `#vsWallFromBack`): the gap between the
  // rear face of the LED walls and the room's back wall, which is the room's local origin.
  const rearZ = ledWallDatum(doc.entities).rearZ;
  const wallFromBack = rearZ - entity.transform.position[2];
  const setWallFromBack = (v: number) => {
    const p = entity.transform.position;
    up({ transform: { ...entity.transform, position: [p[0], p[1], rearZ - v] as Vec3 } }, 'room:back', 'Move room');
  };

  const setMedia = async (side: Side, files: File[]) => {
    const f = files[0];
    if (!f) return;
    try {
      const id = await engine.assets.put(f);
      const media: SurfaceMedia = { assetId: id, name: f.name, kind: f.type.startsWith('video') ? 'video' : 'image' };
      up({ surfaces: { ...entity.surfaces, [side]: media } }, undefined, `Set ${side} media`);
    } catch (err) { engine.toast('error', `Could not load media: ${(err as Error).message}`); }
  };
  const clearMedia = (side: Side) => up({ surfaces: { ...entity.surfaces, [side]: null } }, undefined, `Clear ${side} media`);

  return (
    <>
      <Section title="Room size">
        <Prop label="Width"><LengthField inches={entity.widthIn} unit={unit} min={4 * FT} max={500 * FT} scrub="W" onChange={v => up({ widthIn: v }, 'room:w')} /></Prop>
        <Prop label="Height"><LengthField inches={entity.heightIn} unit={unit} min={4 * FT} max={100 * FT} scrub="H" onChange={v => up({ heightIn: v }, 'room:h')} /></Prop>
        <Prop label="Depth"><LengthField inches={entity.depthIn} unit={unit} min={4 * FT} max={500 * FT} scrub="D" onChange={v => up({ depthIn: v }, 'room:d')} /></Prop>
        <Prop label="Wall from back"><LengthField inches={wallFromBack} unit={unit} min={0} max={100 * FT} scrub="Z" onChange={setWallFromBack} onCommit={() => engine.history.commit()} /></Prop>
        <div className="hint">A proportional room at real scale, placed around the LED walls. Wall from back is the gap between the walls' back face and the back wall.</div>
      </Section>
      <Section title="Surfaces">
        {SIDES.map(s => (
          <ToggleRow key={s.key} label={s.label} checked={entity.show[s.key]} onChange={v => up({ show: { ...entity.show, [s.key]: v } }, undefined, `${v ? 'Show' : 'Hide'} ${s.label.toLowerCase()}`)} />
        ))}
      </Section>
      <Section title="Appearance">
        <Prop label="Colour"><ColorField value={entity.color} onChange={v => up({ color: v }, 'room:color')} /></Prop>
        <Prop label="Opacity">
          <Slider value={entity.opacity} min={0.1} max={1} step={0.05} onChange={v => up({ opacity: v }, 'room:opacity')} />
          <span className="num muted" style={{ fontSize: 'var(--fs-2xs)', minWidth: 32, textAlign: 'right' }}>{Math.round(entity.opacity * 100)}%</span>
        </Prop>
      </Section>
      <Section title="Surface media" defaultOpen={false}>
        <div className="hint">Photos or videos map onto each surface at real scale.</div>
        {SIDES.map(s => {
          const m = entity.surfaces[s.key];
          return (
            <div key={s.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="label">{s.label}</span>
              {m ? (
                <div className="row">
                  <span className="truncate grow" style={{ fontSize: 'var(--fs-xs)' }} title={m.name}>{m.name ?? m.kind}</span>
                  <span className="label">{m.kind}</span>
                  <IconButton size="sm" tip="Clear" onClick={() => clearMedia(s.key)}><X /></IconButton>
                </div>
              ) : (
                <DropZone accept="image/*,video/mp4,video/webm" onFiles={files => void setMedia(s.key, files)} icon={upIcon}
                  label={<>Drop image or video or <b>browse</b></>} />
              )}
            </div>
          );
        })}
      </Section>
    </>
  );
}

/* ───────── Imported model ───────── */

export function ModelInspector({ entity }: { entity: ModelEntity }) {
  const engine = useEngine();
  const unit = useDoc().settings.units;
  // re-render when the model finishes loading so the measured dims appear
  const loading = useStore(s => s.loading.has(entity.id));
  const up = (patch: Partial<ModelEntity>, mergeKey?: string, label?: string) => engine.update<ModelEntity>(entity.id, patch, { mergeKey, label });

  const root = engine.scene.get(entity.id)?.root;
  const measured = (root?.userData.measuredDims as Vec3 | undefined) ?? entity.dims ?? null;
  const scale = entity.transform.scale;
  const currentH = measured ? measured[1] * scale[1] : 0;
  const fitToHeight = (h: number) => {
    if (!measured || measured[1] <= 0) return;
    const s = h / measured[1];
    up({ transform: { ...entity.transform, scale: [s, s, s] } }, 'model:fit', 'Fit to height');
  };

  return (
    <>
      <Section title="Model">
        <Stat label="File" value={<span className="truncate" style={{ maxWidth: 170, display: 'inline-block' }} title={entity.fileName}>{entity.fileName}</span>} />
        <Stat label="Format" value={entity.format.toUpperCase()} />
        <Stat label="Measured" value={loading ? 'Loading…' : measured ? formatDims(measured, unit) : '—'} />
        {measured && (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1) && (
          <Stat label="Scaled" value={formatDims([measured[0] * scale[0], measured[1] * scale[1], measured[2] * scale[2]], unit)} />
        )}
        <Prop label="Source unit">
          <Select value={entity.sourceUnit} options={UNITS.map(u => ({ value: u.id, label: u.long }))} onChange={v => up({ sourceUnit: v }, undefined, 'Model source unit')} />
        </Prop>
        <div className="hint">Choose the unit the model was authored in. The engine converts it to inches.</div>
      </Section>
      <Section title="Scale">
        <Prop label="Fit to height">
          <LengthField inches={currentH} unit={unit} min={1} scrub="H" disabled={!measured} onChange={fitToHeight} />
        </Prop>
        <div className="hint">Sets a uniform scale so the model's measured height matches.</div>
      </Section>
    </>
  );
}

/* ───────── Gaussian splat ───────── */

export function SplatInspector({ entity }: { entity: SplatEntity }) {
  const engine = useEngine();
  const unit = useDoc().settings.units;
  const t = entity.transform;
  const setT = (patch: Partial<SplatEntity['transform']>, key: string) =>
    engine.update<SplatEntity>(entity.id, { transform: { ...t, ...patch } }, { mergeKey: `splat:${key}`, label: 'Align splat' });
  const setRot = (i: 0 | 1 | 2, v: number) => { const r = [...t.rotation] as Vec3; r[i] = v; setT({ rotation: r }, `rot${i}`); };
  const setPos = (i: 0 | 1 | 2, v: number) => { const p = [...t.position] as Vec3; p[i] = v; setT({ position: p }, `pos${i}`); };

  return (
    <>
      <Section title="Splat">
        <Stat label="File" value={<span className="truncate" style={{ maxWidth: 170, display: 'inline-block' }} title={entity.fileName}>{entity.fileName}</span>} />
        <Stat label="Format" value={entity.format.toUpperCase()} />
      </Section>
      <Section title="Alignment">
        <Prop label="Scale">
          <NumberField value={t.scale[0] * 100} min={1} max={10000} step={5} decimals={0} unit="%" scrub="S"
            onChange={v => { const s = Math.max(0.01, v / 100); setT({ scale: [s, s, s] }, 'scale'); }} />
        </Prop>
        <Prop label="Rotate Y">
          <NumberField value={t.rotation[1]} step={5} decimals={1} unit="°" scrub="Y" axis="y" onChange={v => setRot(1, v)} />
        </Prop>
        <Prop label="Level">
          <NumberField value={t.rotation[0]} step={1} decimals={1} unit="°" scrub="X" axis="x" onChange={v => setRot(0, v)} />
          <NumberField value={t.rotation[2]} step={1} decimals={1} unit="°" scrub="Z" axis="z" onChange={v => setRot(2, v)} />
        </Prop>
        <Prop label="Position">
          <LengthField inches={t.position[0]} unit={unit} stepIn={6} scrub="X" axis="x" onChange={v => setPos(0, v)} />
          <LengthField inches={t.position[2]} unit={unit} stepIn={6} scrub="Z" axis="z" onChange={v => setPos(2, v)} />
        </Prop>
        <Prop label="Height">
          <LengthField inches={t.position[1]} unit={unit} stepIn={6} scrub="Y" axis="y" onChange={v => setPos(1, v)} />
        </Prop>
        <div className="hint">Align the reconstruction to real scale: set the scale so a known feature measures true (a 13 ft back wall, say), then level and position it.</div>
      </Section>
    </>
  );
}

/* ───────── Measurement ───────── */

export function DimensionInspector({ entity }: { entity: DimensionEntity }) {
  const engine = useEngine();
  const unit = useDoc().settings.units;
  const d = unitDecimals(unit);
  const pt = (p: Vec3) => p.map(v => (unit === 'ft' ? formatLength(v, 'ft') : `${+fromInches(v, unit).toFixed(d)}`)).join(', ') + (unit === 'ft' || unit === 'in' ? '' : ` ${unit}`);
  return (
    <Section title="Measurement">
      <Stat label="Length" value={formatLength(v3dist(entity.a, entity.b), unit)} />
      <Stat label="Point A" value={<span className="mono" style={{ fontSize: 'var(--fs-2xs)' }}>{pt(entity.a)}</span>} />
      <Stat label="Point B" value={<span className="mono" style={{ fontSize: 'var(--fs-2xs)' }}>{pt(entity.b)}</span>} />
      {entity.label && <Stat label="Label" value={entity.label} />}
      <div className="hint">Endpoints are set with the measure tool; drag the endpoints in the viewport to adjust.</div>
      <Button variant="danger" size="sm" icon={<Trash size={14} strokeWidth={1.5} />} onClick={() => engine.remove([entity.id])}>Delete measurement</Button>
    </Section>
  );
}
