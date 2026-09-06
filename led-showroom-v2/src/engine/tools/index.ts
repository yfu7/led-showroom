/** Registers the default tool set on an engine. */
import type { Engine } from '../Engine';
import { SelectTool } from './SelectTool';
import { TransformTool } from './TransformTool';
import { MeasureTool } from './MeasureTool';
import { CalibrateTool } from './CalibrateTool';
import { ContentDragTool } from './ContentDragTool';
import { ShapeTool } from './ShapeTool';

export function registerDefaultTools(engine: Engine): void {
  const t = engine.tools;
  t.register(new SelectTool(engine));
  t.register(new TransformTool(engine, 'move'));
  t.register(new TransformTool(engine, 'rotate'));
  t.register(new TransformTool(engine, 'scale'));
  t.register(new MeasureTool(engine));
  t.register(new CalibrateTool(engine));
  t.register(new ContentDragTool(engine));
  t.register(new ShapeTool(engine));
}

export type { ToolId, Tool } from './Tool';
export { SelectTool, TransformTool, MeasureTool, CalibrateTool, ContentDragTool, ShapeTool };
