/**
 * The one place a hand-painted shape is turned into a wall patch — shared by the viewport's
 * ShapeTool and the inspector's ShapeEditor panel, which must leave the wall in the same state.
 *
 * Three things follow a paint, and all three are easy to get subtly wrong:
 *  - the cell set is re-normalised to the origin, which can renumber every column;
 *  - a fold recorded as "after column 2" has to follow that renumbering to stay on the same
 *    physical joint, and is pruned if the shape no longer has that joint;
 *  - content windows are re-clamped to the wall's new pixel size.
 *
 * **Call it before the update and put the captured result in the patch** — `const f =
 * shapeEditFields(live, cells); update(id, w => ({ ...w, ...f }))` — never compute it from the `w`
 * the patch receives. The fields are a finished state, and a merged history entry keeps the FIRST
 * command's undo with the LAST command's redo: a patch that re-derived the corner shift from `w`
 * would, on redo, apply the last step's shift alone to the pre-gesture corners and leave every
 * fold short by the rest of the gesture.
 */
import type { Corner, ContentWindow, LedWallEntity, WallShape } from '../document/types';
import { normalizeShape, shiftCorners, wallDims } from './layout';
import { reclampWindows } from './contentWindows';

/** The wall fields a shape edit owns. Everything else on the entity is left untouched. */
export interface ShapeEditFields {
  cols: number;
  rows: number;
  shape: WallShape;
  corners: Corner[];
  contentWindows: ContentWindow[];
}

/**
 * Absolute wall fields for `wall` repainted to `cells`. `wall` is the state the gesture started
 * from for the corners and windows, and `cells` is the final cell set — pass the live entity and
 * the live cell set and a mid-gesture step is as correct as a one-shot edit.
 */
export function shapeEditFields(wall: LedWallEntity, cells: Iterable<string>): ShapeEditFields {
  const norm = normalizeShape(cells);
  const next = { cols: norm.cols, rows: norm.rows };
  return {
    ...next,
    shape: { mode: 'custom', cells: Array.from(norm.cells) },
    corners: shiftCorners(wall.corners, norm.shiftC, norm.cols),
    contentWindows: reclampWindows(wall.contentWindows, wallDims({ ...wall, ...next })),
  };
}
