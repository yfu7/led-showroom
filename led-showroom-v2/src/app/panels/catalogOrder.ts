/**
 * User ordering of the catalog.
 *
 * The catalog ships in a curated order, but which products someone reaches for depends on the show
 * they are building, so cards can be dragged into whatever order they like. The order is a per-group
 * list of item ids kept in localStorage: ids that are not listed keep their catalog order and sort
 * after the ones that are, so adding a product to the catalog later never disturbs a saved layout
 * and never silently disappears.
 */

const KEY = 'showroom-v2:catalog-order';

/** group title → ordered item ids. */
export type CatalogOrder = Record<string, string[]>;

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const defaultStorage = (): StorageLike | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

export function loadOrder(storage: StorageLike | null = defaultStorage()): CatalogOrder {
  if (!storage) return {};
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: CatalogOrder = {};
    for (const [group, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) out[group] = ids.filter((v): v is string => typeof v === 'string');
    }
    return out;
  } catch { return {}; }
}

export function saveOrder(order: CatalogOrder, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try { storage.setItem(KEY, JSON.stringify(order)); } catch { /* quota or private mode: ordering is a convenience */ }
}

export function clearOrder(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try { storage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * Apply a saved order to one group's items. Listed ids come first in their saved order; anything
 * unlisted (a newly added product, or one whose id changed) keeps its catalog order behind them.
 */
export function applyOrder<T extends { id: string }>(items: readonly T[], ids: readonly string[] | undefined): T[] {
  if (!ids || ids.length === 0) return [...items];
  const rank = new Map<string, number>();
  ids.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id), rb = rank.get(b.id);
    if (ra === undefined && rb === undefined) return 0;   // both unlisted: keep catalog order
    if (ra === undefined) return 1;                        // unlisted sorts after listed
    if (rb === undefined) return -1;
    return ra - rb;
  });
}

/**
 * Move `fromId` so it sits before `toId` (or at the end when `toId` is null), returning the new id
 * list for that group. `items` is the group's items in their *current* displayed order.
 */
export function reorder<T extends { id: string }>(items: readonly T[], fromId: string, toId: string | null): string[] {
  const ids = items.map(i => i.id);
  const from = ids.indexOf(fromId);
  if (from < 0) return ids;
  ids.splice(from, 1);
  if (toId === null) { ids.push(fromId); return ids; }
  const to = ids.indexOf(toId);
  if (to < 0) { ids.splice(from, 0, fromId); return ids; }
  ids.splice(to, 0, fromId);
  return ids;
}

/** True when this group has been hand-ordered (so the UI can offer "Reset order"). */
export function isCustomised(order: CatalogOrder, group: string): boolean {
  return Array.isArray(order[group]) && order[group].length > 0;
}
