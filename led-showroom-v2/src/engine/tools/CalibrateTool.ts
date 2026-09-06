/**
 * Calibrate tool: a modal mode. The React CalibrationOverlay draws over the viewport and drives a
 * CalibrationSession; this tool only parks the viewport (no orbit) and handles Escape.
 */
import type { Engine } from '../Engine';
import type { Tool } from './Tool';

export class CalibrateTool implements Tool {
  readonly id = 'calibrate' as const;
  hint = 'Trace two width lines (red) and two depth lines (green) on the venue photo · Esc to cancel';
  cursor = 'crosshair';
  private engine: Engine;
  private wasLocked = false;

  constructor(engine: Engine) { this.engine = engine; }

  onActivate(): void {
    if (!this.engine.env.hasPhoto) {
      this.engine.toast('info', 'Add a venue photo first (Scene › Venue)');
    }
    this.wasLocked = this.engine.camera.locked;
    this.engine.camera.setRotateEnabled(false);
    this.engine.camera.setPanEnabled(false);
    this.engine.camera.setZoomEnabled(false);
  }

  onDeactivate(): void {
    // a successful solve locks the view; otherwise restore interactivity
    if (!this.engine.camera.locked) {
      this.engine.camera.setRotateEnabled(true);
      this.engine.camera.setPanEnabled(true);
      this.engine.camera.setZoomEnabled(true);
    }
    if (this.wasLocked) this.engine.camera.setLocked(true);
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') { this.engine.tools.activate('select'); return true; }
    return false;
  }
}
