/**
 * Window-level keyboard shortcuts. One table (`SHORTCUTS`) drives both the handler and the
 * shortcuts sheet, so what the sheet lists is exactly what the handler does.
 *
 * Tools own Delete / Ctrl+D / arrow nudges (dispatched by ToolManager on the viewport element);
 * Escape inside the viewport is handled by tools too, except presentation mode and the sheet.
 */
import { useEffect } from 'react';
import type { Engine } from '@/engine/Engine';
import { isLedWall } from '@/engine/document/types';
import { isModalOpen } from '@/app/components/Modal';
import { requestEntityRename } from '@/app/menus/entityMenu';
import { useStore } from '@/app/store';

export type ShortcutGroup = 'Objects' | 'Editing' | 'View' | 'Navigation' | 'Tools';

export interface ShortcutDef {
  group: ShortcutGroup;
  label: string;
  /** Display keys, e.g. ["V", "1"] or ["Ctrl+Shift+Z", "Ctrl+Y"]. */
  keys: string[];
}

/** Shown in the shortcuts sheet, in this order. */
export const SHORTCUTS: ShortcutDef[] = [
  { group: 'Tools', label: 'Select', keys: ['V', '1'] },
  { group: 'Tools', label: 'Move', keys: ['W', '2'] },
  { group: 'Tools', label: 'Rotate', keys: ['E', '3'] },
  { group: 'Tools', label: 'Scale', keys: ['R', '4'] },
  { group: 'Tools', label: 'Measure', keys: ['M'] },
  { group: 'Tools', label: 'Drag content', keys: ['C'] },
  { group: 'Tools', label: 'Edit wall shape', keys: ['Shift+S'] },
  { group: 'Tools', label: 'Walk mode', keys: ['Shift+W'] },

  { group: 'Objects', label: 'Deselect', keys: ['Esc'] },
  { group: 'Objects', label: 'Delete selection', keys: ['Delete', 'Backspace'] },
  { group: 'Objects', label: 'Duplicate', keys: ['Ctrl+D'] },
  { group: 'Objects', label: 'Rename', keys: ['F2'] },
  { group: 'Objects', label: 'Copy', keys: ['Ctrl+C'] },
  { group: 'Objects', label: 'Cut', keys: ['Ctrl+X'] },
  { group: 'Objects', label: 'Paste', keys: ['Ctrl+V'] },
  { group: 'Objects', label: 'Context menu', keys: ['Right-click'] },
  { group: 'Objects', label: 'Select all', keys: ['Ctrl+A'] },
  { group: 'Objects', label: 'Nudge selection', keys: ['Arrows'] },
  { group: 'Objects', label: 'Nudge by 12 steps', keys: ['Shift+Arrows'] },
  { group: 'Objects', label: 'Nudge up / down', keys: ['PageUp', 'PageDown'] },

  { group: 'Editing', label: 'Undo', keys: ['Ctrl+Z'] },
  { group: 'Editing', label: 'Redo', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'] },

  { group: 'View', label: 'Frame selection', keys: ['F'] },
  { group: 'View', label: 'Frame all', keys: ['Shift+F'] },
  { group: 'View', label: 'Home view', keys: ['H'] },
  { group: 'View', label: 'Front / Back', keys: ['Alt+1', 'Alt+Ctrl+1'] },
  { group: 'View', label: 'Right / Left', keys: ['Alt+3', 'Alt+Ctrl+3'] },
  { group: 'View', label: 'Top / Bottom', keys: ['Alt+7', 'Alt+Ctrl+7'] },
  { group: 'View', label: 'Perspective / Orthographic', keys: ['Alt+5', 'Numpad 5'] },
  { group: 'View', label: 'Toggle grid', keys: ['G'] },

  { group: 'Navigation', label: 'Toggle side panels', keys: ['Tab'] },
  { group: 'Navigation', label: 'Presentation mode', keys: ['Ctrl+\\'] },
  { group: 'Navigation', label: 'Leave presentation / walk mode', keys: ['Esc'] },
  { group: 'Navigation', label: 'Keyboard shortcuts', keys: ['?'] },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = ['Tools', 'Objects', 'Editing', 'View', 'Navigation'];

/** True when the key event originates in an editable control (never steal keys from inputs). */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return !!el.closest('[contenteditable="true"], [contenteditable=""]');
}

export function useGlobalShortcuts(engine: Engine | null): void {
  useEffect(() => {
    if (!engine) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const st = useStore.getState();
      const ctrl = e.ctrlKey || e.metaKey;

      // Walk mode: the rig preventDefaults every W / Shift keydown on the focused viewport, so the
      // Shift+W toggle must be checked before the defaultPrevented guard or it could never leave.
      if (engine.camera.flyMode && e.shiftKey && !ctrl && !e.altKey && e.key.toLowerCase() === 'w' && !isModalOpen() && !st.shortcutsOpen) {
        engine.camera.setFlyMode(false); e.preventDefault(); return;
      }
      if (e.defaultPrevented) return;

      // Escape: leave presentation, close the sheet; otherwise tools handle it on the viewport.
      if (e.key === 'Escape') {
        if (st.shortcutsOpen) { st.setShortcutsOpen(false); e.preventDefault(); return; }
        if (isModalOpen()) return;
        if (st.presentation) { st.setPresentation(false); e.preventDefault(); return; }
        if (engine.camera.flyMode) { engine.camera.setFlyMode(false); e.preventDefault(); return; }
        return;
      }
      if (isModalOpen() || st.shortcutsOpen) return;
      // Walk mode owns WASD / QE on the viewport (the rig preventDefaults them there); leave the rest alone too.
      if (engine.camera.flyMode && !ctrl && !e.altKey && !e.shiftKey && /^[wasdqe]$/i.test(e.key)) return;

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const code = e.code;
      const numpad = code.startsWith('Numpad');
      const handled = (): void => { e.preventDefault(); e.stopPropagation(); };

      /* ───── editing ───── */
      if (ctrl && !e.altKey && key === 'z') { if (e.shiftKey) engine.redo(); else engine.undo(); return handled(); }
      if (ctrl && !e.altKey && !e.shiftKey && key === 'y') { engine.redo(); return handled(); }
      // Clipboard: the app's own, not the system one — `isEditableTarget` above already let a
      // text field keep its native copy/paste. The key is only claimed when the app actually
      // acts on it, so selecting a status-bar or inspector readout and pressing Ctrl+C still
      // reaches the browser instead of being eaten for a no-op.
      if (ctrl && !e.altKey && !e.shiftKey && key === 'c') { if (engine.copy()) return handled(); return; }
      if (ctrl && !e.altKey && !e.shiftKey && key === 'x') { if (engine.cut()) return handled(); return; }
      if (ctrl && !e.altKey && !e.shiftKey && key === 'v') { if (engine.canPaste) { engine.paste(); return handled(); } return; }
      if (ctrl && !e.altKey && !e.shiftKey && (key === '\\' || code === 'Backslash')) { st.setPresentation(!st.presentation); return handled(); }

      /* ───── axis views: Alt+1/3/7 (Ctrl for the opposite side), numpad without Alt ───── */
      const digit = /^Digit[1357]$/.test(code) ? code.slice(5) : /^Numpad[1357]$/.test(code) ? code.slice(6) : null;
      if (digit && (e.altKey || numpad) && !e.shiftKey) {
        const opposite = ctrl;
        const preset = digit === '1' ? (opposite ? 'back' : 'front') : digit === '3' ? (opposite ? 'left' : 'right') : digit === '7' ? (opposite ? 'bottom' : 'top') : null;
        if (preset) { engine.setView(preset); return handled(); }
      }
      if ((code === 'Numpad5' || (e.altKey && code === 'Digit5')) && !ctrl && !e.shiftKey) { engine.camera.toggleProjection(); return handled(); }

      // F2 renames the primary selection wherever the focus is — the menus advertise it, and the
      // viewport keeps focus after a right-click menu closes. The panels bind it themselves for
      // the row under the cursor; this is the fallback for everywhere else.
      if (!ctrl && !e.altKey && !e.shiftKey && key === 'F2') {
        const p = engine.primarySelection;
        if (p) { requestEntityRename(p.id); return handled(); }
        return;
      }
      if (ctrl || e.altKey) return; // nothing else uses modifiers

      /* ───── tools ───── */
      if (e.shiftKey) {
        if (key === 's') {
          const sel = engine.primarySelection;
          if (isLedWall(sel)) { engine.tools.activate(engine.tools.activeId === 'shape' ? 'select' : 'shape'); return handled(); }
          return;
        }
        if (key === 'w') { engine.camera.setFlyMode(!engine.camera.flyMode); return handled(); }
        if (key === 'f') { engine.frameAll(); return handled(); }
        if (key === '?') { st.setShortcutsOpen(true); return handled(); }
        return;
      }
      switch (key) {
        case 'v': case '1': engine.tools.activate('select'); return handled();
        case 'w': case '2': engine.tools.activate('move'); return handled();
        case 'e': case '3': engine.tools.activate('rotate'); return handled();
        case 'r': case '4': engine.tools.activate('scale'); return handled();
        case 'm': engine.tools.activate(engine.tools.activeId === 'measure' ? 'select' : 'measure'); return handled();
        case 'c': engine.tools.activate(engine.tools.activeId === 'content' ? 'select' : 'content'); return handled();
        case 'f': engine.frameSelection(); return handled();
        case 'h': engine.setView('home'); return handled();
        case 'g': engine.patchEnvironment(env => ({ ...env, grid: { ...env.grid, visible: !env.grid.visible } }), 'Toggle grid'); return handled();
        case '?': st.setShortcutsOpen(true); return handled();
        case 'Tab': {
          const both = st.leftOpen || st.rightOpen;
          st.setLeftOpen(!both); st.setRightOpen(!both);
          return handled();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);
}
