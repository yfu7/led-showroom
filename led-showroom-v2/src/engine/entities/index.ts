/** Registers one renderer factory per entity type. */
import type { Engine } from '../Engine';
import type { RendererFactory } from './EntityRenderer';
import { createLedWallRenderer } from './LedWallRenderer';
import { createStageRenderer } from './StageRenderer';
import { createEquipmentRenderer } from './EquipmentRenderer';
import { createModelRenderer } from './ModelRenderer';
import { createSplatRenderer } from './SplatRenderer';
import { createRoomRenderer } from './RoomRenderer';
import { createDimensionRenderer } from './DimensionRenderer';
import { createGroupRenderer } from './GroupRenderer';
import type { ModelEntity, SplatEntity } from '../document/types';

export function registerDefaultRenderers(engine: Engine): void {
  const s = engine.scene;
  s.register('led-wall', createLedWallRenderer);
  s.register('stage', createStageRenderer);
  s.register('equipment', createEquipmentRenderer);
  s.register('model', ((e, ctx) => createModelRenderer(e as ModelEntity, ctx)) as RendererFactory);
  s.register('splat', ((e, ctx) => createSplatRenderer(e as SplatEntity, ctx)) as RendererFactory);
  s.register('room', createRoomRenderer);
  s.register('dimension', createDimensionRenderer);
  s.register('group', createGroupRenderer);
}

export { LedWallRenderer } from './LedWallRenderer';
