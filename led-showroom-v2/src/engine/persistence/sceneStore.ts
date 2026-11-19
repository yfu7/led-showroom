/**
 * Saved scenes on the local server's disk — the durable half of "where do my builds live".
 *
 * The app's own memory is browser storage: one autosaved document and up to 50 presets. That is per
 * browser profile AND per origin, so a build made on localhost is invisible on the deployed site,
 * and clearing site data takes all of it. This module is the other half: real `.showroom.json` files
 * in a folder that can be backed up, copied to another machine or opened by hand, written by the
 * local server (`server/scenes.cjs`), which also keeps whatever it overwrites as a version.
 *
 * It exists only where that server does. On the deploy the routes are not there, {@link listStoredScenes}
 * returns null, and the menu that depends on it hides itself.
 *
 * `null` therefore has to mean exactly "no store here" and nothing else. A static host that answers
 * an unknown path with its own index.html, or a dev server proxying to a process that is not up,
 * must not read as an empty store — the app would offer to save builds into nowhere. Hence the
 * listing is accepted only when it parses as JSON AND has the shape the server promises.
 */
import { buildSceneFile, parseSceneFile, type AssetReader, type AssetWriter } from './sceneFile';
import type { Document } from '../document/types';

const ROOT = '/api/scenes';

/** One file in the store: a saved scene, or an earlier version of one. */
export interface StoredSceneMeta {
  /** Its address for read and delete: `<name>.showroom.json`, or `versions/<name>-<stamp>.showroom.json`. */
  file: string;
  name: string;
  sizeBytes: number;
  /** Last written, as epoch milliseconds. */
  savedAt: number;
}

export interface StoredScene extends StoredSceneMeta {
  /** Copies kept when this scene was overwritten, newest first. */
  versions: StoredSceneMeta[];
}

export interface SceneStoreListing {
  /** The folder on disk, shown to the user: it is the answer to "where did my build go". */
  dir: string;
  /** Newest first. */
  scenes: StoredScene[];
}

const isMeta = (v: unknown): v is StoredSceneMeta => {
  const m = v as StoredSceneMeta | null;
  return !!m && typeof m === 'object'
    && typeof m.file === 'string' && typeof m.name === 'string'
    && typeof m.sizeBytes === 'number' && typeof m.savedAt === 'number';
};

/** The listing, or null if this is not actually a scene store answering. */
function asListing(v: unknown): SceneStoreListing | null {
  const l = v as SceneStoreListing | null;
  if (!l || typeof l !== 'object' || typeof l.dir !== 'string' || !Array.isArray(l.scenes)) return null;
  for (const s of l.scenes) if (!isMeta(s) || !Array.isArray(s.versions) || !s.versions.every(isMeta)) return null;
  return l;
}

const isJson = (res: Response): boolean => (res.headers.get('content-type') ?? '').includes('json');

/** The server's own account of what went wrong, or a plain one when it did not give a message. */
async function failure(res: Response, fallback: string): Promise<Error> {
  if (isJson(res)) {
    try {
      const body = await res.json() as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return new Error(body.error);
    } catch { /* fall through to the plain message */ }
  }
  return new Error(`${fallback} (${res.status})`);
}

/** `GET`, or null for anything that means there is no store at this origin. */
export async function listStoredScenes(signal?: AbortSignal): Promise<SceneStoreListing | null> {
  let res: Response;
  try {
    res = await fetch(ROOT, { headers: { Accept: 'application/json' }, signal });
  } catch {
    return null; // nothing listening, or the dev proxy has no one to proxy to
  }
  if (!res.ok || !isJson(res)) return null;
  try {
    return asListing(await res.json());
  } catch {
    return null;
  }
}

/** The address of one file inside the store, encoded as a single path segment. */
const fileUrl = (file: string): string => `${ROOT}/file/${encodeURIComponent(file)}`;

/** Load a saved scene (or one of its versions) into a document, restoring its assets. */
export async function readStoredScene(
  file: string,
  assets: AssetWriter & Partial<AssetReader>,
): Promise<{ doc: Document; missing: string[] }> {
  const res = await fetch(fileUrl(file), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw await failure(res, 'Could not read that saved build');
  return parseSceneFile(await res.json(), assets);
}

/**
 * Save `doc` to disk as `name`, keeping whatever was there as a version.
 *
 * `missing` lists assets that could not be embedded — the same report {@link buildSceneFile} makes
 * for a downloaded file, and worth passing on: a build saved without its own media looks complete
 * in the listing and is not.
 */
export async function writeStoredScene(
  name: string,
  doc: Document,
  assets: AssetReader,
): Promise<{ dir: string; saved: StoredSceneMeta; missing: string[] }> {
  const scene = await buildSceneFile(doc, assets);
  const res = await fetch(ROOT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, scene }),
  });
  if (!res.ok) throw await failure(res, 'Could not save to this computer');
  const body = await res.json() as { dir?: unknown; saved?: unknown };
  if (!isMeta(body?.saved)) throw new Error('The server did not say what it saved.');
  return {
    dir: typeof body.dir === 'string' ? body.dir : '',
    saved: body.saved,
    missing: scene.missing ?? [],
  };
}

/** Delete a saved scene, or one version of one. The file is removed, not sent to the recycle bin. */
export async function deleteStoredScene(file: string): Promise<void> {
  const res = await fetch(fileUrl(file), { method: 'DELETE', headers: { Accept: 'application/json' } });
  if (!res.ok) throw await failure(res, 'Could not delete that saved build');
}
