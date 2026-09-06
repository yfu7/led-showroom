import { useEffect, useRef } from 'react';
import { Engine } from '@/engine/Engine';
import { registerDefaultRenderers } from '@/engine/entities';
import { registerDefaultTools } from '@/engine/tools';
import { useStore } from './store';
import { TopBar } from './shell/TopBar';
import { LeftDock } from './shell/LeftDock';
import { RightDock } from './shell/RightDock';
import { StatusBar } from './shell/StatusBar';
import { ViewportOverlay } from './shell/ViewportOverlay';
import { Toasts } from './components/Toasts';
import { ShortcutsSheet } from './shell/ShortcutsSheet';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { installSceneBehaviours } from '@/engine/behaviours';
import { preloadAccessoryGeometry } from '@/engine/ledwall/geometry';
import { getCalibrationSession } from './shell/CalibrationOverlay';

/**
 * Boot framing decision (v1 `__userViewDirty`, Alg A33): the scene is auto-fitted only when there
 * is no viewpoint worth keeping — a camera restored from the last session, or a locked view, wins
 * over automatic framing. A fresh or newly seeded scene clears the guard, so it still fits.
 */
export function shouldAutoFrame(o: { restoredView: boolean; locked: boolean }): boolean {
  return !o.restoredView && !o.locked;
}

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engine = useStore(s => s.engine);
  const attach = useStore(s => s.attach);
  const presentation = useStore(s => s.presentation);
  const leftOpen = useStore(s => s.leftOpen);
  const rightOpen = useStore(s => s.rightOpen);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const eng = new Engine(host);
    // Warm the accessory CAD so the first wall's base plates and brackets arrive with it, rather
    // than a beat later in place of the extruded placeholders.
    void preloadAccessoryGeometry();
    registerDefaultRenderers(eng);
    eng.resync();
    installSceneBehaviours(eng);
    registerDefaultTools(eng);
    eng.tools.activate('select');
    const detach = attach(eng);
    // Dev-only debug handle. `import.meta.env.DEV` is a compile-time constant, so the whole
    // branch is dead code in a production build and never reaches a visitor's window.
    if (import.meta.env.DEV) (window as unknown as { showroom?: Engine }).showroom = eng;
    // fresh document → seed a wall so the first impression isn't an empty floor
    if (eng.doc.entities.length === 0) eng.seedDefaultScene();
    // a saved perspective calibration re-applies the solved photo camera and lock
    if (eng.doc.environment.backdrop.calibration?.solved) getCalibrationSession(eng).restoreFromDocument(eng);
    else if (shouldAutoFrame({ restoredView: eng.restoredView, locked: eng.camera.locked })) eng.frameAll(false);
    return () => {
      detach(); eng.dispose();
      if (import.meta.env.DEV) delete (window as unknown as { showroom?: Engine }).showroom;
    };
  }, [attach]);

  useGlobalShortcuts(engine);

  const ready = !!engine;
  return (
    <div className={`app${presentation ? ' presentation' : ''}`}>
      <TopBar />
      <aside className={`dock dock-left${leftOpen ? '' : ' collapsed'}`}>{ready && <LeftDock />}</aside>
      <main className="viewport-area">
        <div ref={hostRef} className="sr-viewport" />
        {ready && <ViewportOverlay />}
        <Toasts />
      </main>
      <aside className={`dock dock-right${rightOpen ? '' : ' collapsed'}`}>{ready && <RightDock />}</aside>
      <StatusBar />
      {ready && <ShortcutsSheet />}
    </div>
  );
}
