import { describe, expect, it } from 'vitest';
import type { Engine } from '@/engine/Engine';
import { isWindowLoading, useStore } from '@/app/store';

/** Minimal engine stand-in: only what `attach` reads plus the `loading` event. */
function fakeEngine() {
  const handlers = new Map<string, ((v: unknown) => void)[]>();
  const on = (ev: string, fn: (v: never) => void) => {
    const list = handlers.get(ev) ?? [];
    list.push(fn as (v: unknown) => void);
    handlers.set(ev, list);
    return () => { handlers.set(ev, (handlers.get(ev) ?? []).filter(f => f !== fn)); };
  };
  const engine = {
    doc: null, selection: [], tools: { activeId: null }, settings: { theme: 'dark' },
    camera: { projection: 'perspective', flyMode: false, locked: false, on },
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    on,
  };
  const emit = (ev: string, v: unknown) => (handlers.get(ev) ?? []).forEach(f => f(v));
  return { engine: engine as unknown as Engine, emit };
}

describe('store loading mirror', () => {
  it('keeps the per-key detail and re-publishes a fresh map', () => {
    const { engine, emit } = fakeEngine();
    const detach = useStore.getState().attach(engine);
    const live = new Map<string, Set<string>>([['wall', new Set(['winA', 'upload:winB'])]]);

    emit('loading', live);
    const first = useStore.getState().loading;
    expect([...(first.get('wall') ?? [])].sort()).toEqual(['upload:winB', 'winA']);

    // The engine mutates its own map in place, so the store must hold a copy.
    live.get('wall')!.delete('winA');
    expect(first.get('wall')!.has('winA')).toBe(true);

    emit('loading', live);
    const second = useStore.getState().loading;
    expect(second).not.toBe(first);
    expect(second.get('wall')!.has('winA')).toBe(false);
    detach();
  });

  it('isWindowLoading is per window, not per wall', () => {
    const loading = new Map<string, Set<string>>([['wall', new Set(['winA', 'upload:winC'])]]);
    expect(isWindowLoading(loading, 'wall', 'winA')).toBe(true);
    expect(isWindowLoading(loading, 'wall', 'winB')).toBe(false);
    expect(isWindowLoading(loading, 'wall', 'winC')).toBe(true);
    expect(isWindowLoading(loading, 'other', 'winA')).toBe(false);
  });
});
