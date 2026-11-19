/**
 * Scene inspector — the right-dock body when nothing is selected. Venue, floor & grid, lighting,
 * units & snapping, scene actions, presets and exports. (InspectorDock supplies the panel head and
 * the scrolling body; this renders a display-font intro block plus the sections.)
 */
import { Eraser, Maximize } from 'lucide-react';
import type { Document, LightingPreset, SnapSettings } from '@/engine/document/types';
import { UNITS } from '@/engine/units';
import { GRID_THRESHOLD_OPTIONS_IN } from '@/engine/ledwall/pixelGrid';
import { useDoc, useEngine } from '@/app/store';
import { Button } from '@/app/components/Button';
import { LengthField, NumberField } from '@/app/components/NumberField';
import { Prop, Section } from '@/app/components/Section';
import { Segmented } from '@/app/components/Segmented';
import { Select } from '@/app/components/Select';
import { Slider } from '@/app/components/Slider';
import { ToggleRow } from '@/app/components/Toggle';
import { requestClearScene } from '@/app/shell/ClearSceneDialog';
import { VenuePanel } from './VenuePanel';
import { PresetsPanel } from './PresetsPanel';
import { ExportPanel } from './ExportPanel';
import { SceneSpecsSection } from './SpecsSection';

type Env = Document['environment'];

/* The per-type tally that used to live here now comes from `sceneSpecs` in the engine, so the
   canvas is described by the same pure derivation every item uses. */

export function SceneInspector() {
  const engine = useEngine();
  const doc = useDoc();
  const unit = doc.settings.units;
  const env = doc.environment;
  const settings = doc.settings;

  const patchEnv = (fn: (e: Env) => Env, label: string, mergeKey?: string) => engine.patchEnvironment(fn, label, mergeKey);
  const patchSnap = (p: Partial<SnapSettings>, label = 'Snapping') => engine.patchSettings({ snap: { ...settings.snap, ...p } }, label);

  const total = doc.entities.length;
  const unitLong = UNITS.find(u => u.id === unit)?.long.toLowerCase() ?? unit;

  return (
    <>
      <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--line)' }}>
        <div className="display" style={{ fontSize: 'var(--fs-2xl)', lineHeight: 1.1, color: 'var(--fg-0)' }}>Scene</div>
        <div className="subhead num" style={{ marginTop: 2 }}>{total === 0 ? 'Empty scene' : `${total} ${total === 1 ? 'object' : 'objects'}`} · {unitLong}</div>
      </div>

      <Section title="Venue"><VenuePanel /></Section>

      <Section title="Floor & grid">
        <ToggleRow label="Grid" checked={env.grid.visible} onChange={v => patchEnv(e => ({ ...e, grid: { ...e.grid, visible: v } }), v ? 'Show grid' : 'Hide grid')} />
        {/* Wide: "minor"/"major" are words, not one-glyph scrub handles, and with a unit suffix
            too the pair cannot fit beside a 92px label — in mm the value was clipped to 2 digits. */}
        <Prop label="Spacing" wide>
          <LengthField inches={env.grid.minorIn} unit={unit} min={1} max={env.grid.majorIn} scrub="minor" title="Minor grid spacing"
            onChange={v => patchEnv(e => ({ ...e, grid: { ...e.grid, minorIn: v } }), 'Grid spacing', 'env:grid.minor')} />
          <LengthField inches={env.grid.majorIn} unit={unit} min={env.grid.minorIn} max={1200} scrub="major" title="Major grid spacing"
            onChange={v => patchEnv(e => ({ ...e, grid: { ...e.grid, majorIn: v } }), 'Grid spacing', 'env:grid.major')} />
        </Prop>
        <ToggleRow label="Floor" checked={env.floor.visible} onChange={v => patchEnv(e => ({ ...e, floor: { ...e.floor, visible: v } }), v ? 'Show floor' : 'Hide floor')} />
        <Prop label="Floor size">
          <LengthField inches={env.floor.sizeIn} unit={unit} min={120} max={12000} scrub="S"
            onChange={v => patchEnv(e => ({ ...e, floor: { ...e.floor, sizeIn: v } }), 'Floor size', 'env:floor.size')} />
        </Prop>
        {/* Pixel grid fade is document-wide: it used to sit inside one wall's Display section,
            where changing it silently moved every other wall's threshold. */}
        <Prop label="Pixel grid fade" title="Camera distance inside which LED pixel structure appears, on every wall">
          <Select value={settings.pixelGridDistIn} options={GRID_THRESHOLD_OPTIONS_IN.map(v => ({ value: v, label: `${v / 12} ft` }))}
            onChange={v => engine.patchSettings({ pixelGridDistIn: v }, 'Pixel grid distance')} className="grow" />
        </Prop>
        <ToggleRow label="Reflective floor" checked={env.floor.reflective} onChange={v => patchEnv(e => ({ ...e, floor: { ...e.floor, reflective: v } }), 'Reflective floor')} />
      </Section>

      <Section title="Lighting">
        <Segmented<LightingPreset> block value={env.lighting.preset}
          options={[{ value: 'showroom', label: 'Showroom' }, { value: 'studio', label: 'Studio' }, { value: 'dark', label: 'Dark' }, { value: 'venue', label: 'Venue' }]}
          onChange={v => patchEnv(e => ({ ...e, lighting: { ...e.lighting, preset: v } }), 'Lighting preset')} />
        <Prop label="Intensity">
          <Slider value={env.lighting.intensity} min={0.2} max={2} step={0.05}
            onChange={v => patchEnv(e => ({ ...e, lighting: { ...e.lighting, intensity: v } }), 'Light intensity', 'env:lighting.intensity')} />
          <span className="num muted" style={{ fontSize: 'var(--fs-2xs)', minWidth: 32, textAlign: 'right' }}>{env.lighting.intensity.toFixed(2)}</span>
        </Prop>
        <ToggleRow label="Shadows" checked={env.lighting.shadows} onChange={v => patchEnv(e => ({ ...e, lighting: { ...e.lighting, shadows: v } }), v ? 'Enable shadows' : 'Disable shadows')} />
      </Section>

      <Section title="Units & snapping">
        <Prop label="Units">
          <Select value={settings.units} options={UNITS.map(u => ({ value: u.id, label: u.long }))} onChange={v => engine.patchSettings({ units: v }, 'Units')} />
        </Prop>
        <ToggleRow label="Snap" checked={settings.snap.enabled} onChange={v => patchSnap({ enabled: v }, v ? 'Enable snapping' : 'Disable snapping')} />
        <Prop label="Move step">
          <LengthField inches={settings.snap.translateIn} unit={unit} min={0.0625} max={120} scrub="T" onChange={v => patchSnap({ translateIn: v })} />
        </Prop>
        <Prop label="Rotate step">
          <NumberField value={settings.snap.rotateDeg} min={0.5} max={90} step={0.5} decimals={1} unit="°" scrub="R" onChange={v => patchSnap({ rotateDeg: v })} />
        </Prop>
        <Prop label="Scale step">
          <NumberField value={settings.snap.scale} min={0.01} max={1} step={0.01} decimals={2} scrub="S" onChange={v => patchSnap({ scale: v })} />
        </Prop>
        <ToggleRow label="Ground lock" checked={settings.snap.groundLock} onChange={v => patchSnap({ groundLock: v }, 'Ground lock')}
          hint="Keep objects resting on the floor or their support while moving" />
        <ToggleRow label="Deck follows" checked={settings.snap.deckFollowsRider} onChange={v => patchSnap({ deckFollowsRider: v }, 'Deck follows')}
          hint="Moving or rotating an object that rides a deck carries the deck with it" />
        <ToggleRow label="Auto-rotate" checked={settings.autoRotate} onChange={v => engine.patchSettings({ autoRotate: v }, 'Auto-rotate')} />
        <ToggleRow label="Show HUD" checked={settings.showHud} onChange={v => engine.patchSettings({ showHud: v }, 'Show HUD')} />
      </Section>

      <Section title="Scene">
        <div className="grid-2">
          <Button size="sm" icon={<Maximize size={14} strokeWidth={1.5} />} onClick={() => engine.frameAll()}>Frame all</Button>
          <Button size="sm" variant="ghost" icon={<Eraser size={14} strokeWidth={1.5} />} onClick={requestClearScene}>Clear scene</Button>
        </div>
      </Section>

      <Section title="Presets" defaultOpen={false}><PresetsPanel /></Section>
      <Section title="Export"><ExportPanel /></Section>

      {/* The canvas's own tally closes the panel, the way an item's specs close its inspector. */}
      <SceneSpecsSection />
    </>
  );
}
