/*
 * Saved scenes on disk — the durable half of "where do my builds live".
 *
 * The app's own memory is browser storage: one autosaved document and up to 50 presets in
 * localStorage. That is per browser profile AND per origin, so a build made on localhost is
 * invisible on the deployed site, and clearing site data takes all of it. This module is the other
 * half: real .showroom.json files in a folder that can be backed up, copied to another machine or
 * opened by hand.
 *
 * It is part of the local server only. On the deploy these routes do not exist, the client's probe
 * fails, and the menu hides itself.
 *
 * Overwriting never destroys what was there: the previous file is moved into `versions/` under its
 * own name and a timestamp first, so "previous builds" means previous builds and not just the last
 * one. Nothing prunes that folder by age or by count — they are files on a disk, and the person
 * whose disk it is can decide — but deleting a scene does take the copies kept for it, because
 * versions nothing can reach are an invisible pile rather than a backup.
 */
const fs = require('fs');
const path = require('path');

const EXT = '.showroom.json';
const VERSIONS = 'versions';
/**
 * `<name>-<stamp>` as `write` spells it. The stamp is matched in FULL rather than split on the last
 * dash, which would land inside the stamp's own dashes and file the version under a scene that does
 * not exist. `(.*)` is greedy, so a scene whose own name ends in something stamp-shaped still gives
 * up only its trailing stamp.
 */
const VERSION_STAMP = /^(.*)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(?:-\d+)?$/;

/** The scene a version's stem belongs to. */
const ownerOf = (stem) => (VERSION_STAMP.exec(stem) || [, stem])[1];
/*
 * Refuse a body larger than this.
 *
 * MAX_EMBED_BYTES caps a scene's assets at 150 MB of RAW bytes, but they travel as base64 data URLs
 * - four characters per three bytes - so 150 MB of assets reaches this server as roughly 200 MB of
 * JSON, before the document itself. A cap near the raw figure would reject precisely the scenes the
 * exporter is willing to build. src/server/scenes.test.ts holds the two numbers to that relation.
 */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/**
 * A human name → the file it is stored as, or null if nothing usable is left.
 *
 * Everything outside the allowed set goes, which includes every separator and every dot run, so a
 * traversal cannot survive this even before the containment check below.
 */
function fileNameFor(name) {
  const base = String(name == null ? '' : name)
    .replace(/\.showroom\.json$/i, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s-]+|[.\s]+$/g, '')
    .slice(0, 80);
  return base ? base + EXT : null;
}

/** The display name a stored file came from. */
function nameOf(file) {
  return file.slice(0, -EXT.length);
}

function createSceneStore(dir) {
  const versionsDir = path.join(dir, VERSIONS);

  /**
   * Resolve a client-supplied path inside the store. Accepts `<file>` and `versions/<file>` and
   * nothing else; the result is re-checked against the store root, so even a name that slipped
   * through {@link fileNameFor} cannot address a file outside it.
   */
  function resolve(rel) {
    const raw = String(rel == null ? '' : rel);
    const m = /^(versions\/)?([^/\\]+)$/.exec(raw);
    if (!m) return null;
    const file = fileNameFor(m[2]);
    if (!file) return null;
    const full = path.resolve(m[1] ? versionsDir : dir, file);
    const root = path.resolve(dir) + path.sep;
    return full.startsWith(root) ? full : null;
  }

  /**
   * A free name in `versions/` for the copy being displaced. The stamp keeps MILLISECONDS, and a
   * counter is appended if even that is taken. Seconds alone are not enough: two saves inside one
   * tick - a double-click is enough - would rename the first straight over the second, and this
   * folder exists precisely so that overwriting never destroys what was there.
   */
  function versionName(stem, mtimeMs) {
    const stamp = new Date(mtimeMs).toISOString().replace(/[:.]/g, '-').slice(0, 23);
    for (let n = 1; ; n++) {
      const file = stem + '-' + stamp + (n === 1 ? '' : '-' + n) + EXT;
      if (!fs.existsSync(path.join(versionsDir, file))) return file;
    }
  }

  function statOf(full, file) {
    const st = fs.statSync(full);
    return { file, name: nameOf(path.basename(full)), sizeBytes: st.size, savedAt: st.mtimeMs };
  }

  function readDirSafe(d) {
    try { return fs.readdirSync(d).filter(f => f.endsWith(EXT)); } catch (_) { return []; }
  }

  /** Every saved scene, newest first, each with the earlier versions kept for it. */
  function list() {
    const olderBy = new Map();
    for (const f of readDirSafe(versionsDir)) {
      const owner = ownerOf(nameOf(f));
      const entry = statOf(path.join(versionsDir, f), VERSIONS + '/' + f);
      const got = olderBy.get(owner);
      if (got) got.push(entry); else olderBy.set(owner, [entry]);
    }
    const scenes = readDirSafe(dir).map(f => {
      const meta = statOf(path.join(dir, f), f);
      const older = olderBy.get(meta.name) || [];
      older.sort((a, b) => b.savedAt - a.savedAt);
      return { ...meta, versions: older };
    });
    scenes.sort((a, b) => b.savedAt - a.savedAt);
    return { dir, scenes };
  }

  function read(rel) {
    const full = resolve(rel);
    if (!full || !fs.existsSync(full)) return null;
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  }

  /**
   * Write `scene` as `name`, keeping whatever was there as a version. The new file lands by rename
   * from a temp beside it, so a crash mid-write cannot leave a half-written scene under a name that
   * used to hold a good one.
   */
  function write(name, scene) {
    const file = fileNameFor(name);
    if (!file) throw new Error('That name has no characters a file can be called.');
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, file);

    if (fs.existsSync(full)) {
      fs.mkdirSync(versionsDir, { recursive: true });
      fs.renameSync(full, path.join(versionsDir, versionName(nameOf(file), fs.statSync(full).mtimeMs)));
    }

    const tmp = full + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(scene), 'utf8');
    fs.renameSync(tmp, full);
    return statOf(full, file);
  }

  /**
   * Delete a scene, or one version of one.
   *
   * Deleting a SCENE takes the copies kept for it. `versions/` exists so that overwriting never
   * destroys anything silently; a delete is neither silent nor accidental, and once the scene is
   * gone nothing in the app can reach its versions again — they would be disk nobody can see,
   * still holding a build someone asked to be rid of.
   */
  function remove(rel) {
    const full = resolve(rel);
    if (!full || !fs.existsSync(full)) return false;
    fs.unlinkSync(full);
    if (!String(rel).startsWith(VERSIONS + '/')) {
      const owner = nameOf(path.basename(full));
      for (const f of readDirSafe(versionsDir)) {
        if (ownerOf(nameOf(f)) !== owner) continue;
        try { fs.unlinkSync(path.join(versionsDir, f)); } catch (_) { /* already gone, or not ours */ }
      }
    }
    return true;
  }

  return { dir, list, read, write, remove, fileNameFor, resolve };
}

module.exports = { createSceneStore, fileNameFor, EXT, MAX_BODY_BYTES };
