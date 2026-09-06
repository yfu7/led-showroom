#!/usr/bin/env node
/**
 * step-to-glb — convert the manufacturer's SolidWorks STEP files into binary glTF
 * for the showroom renderer.
 *
 *   node scripts/step-to-glb.cjs                     # convert every part in PARTS
 *   node scripts/step-to-glb.cjs panel base          # convert just those parts
 *   node scripts/step-to-glb.cjs --in a.STEP --out public/models/a.glb --origin panel
 *
 * What it does
 *   1. reads the STEP with occt-import-js (OCCT's own tessellator),
 *   2. merges every solid in the file into ONE mesh (POSITION + NORMAL + indices),
 *   3. converts millimetres to inches (÷ 25.4) — the app's world unit is 1 inch,
 *   4. rotates/translates the mesh into the frame the renderer expects (`--origin`),
 *   5. writes a self-contained .glb (JSON chunk + BIN chunk) with one PBR material.
 *
 * No glTF library: the container is ~80 lines at the bottom of this file.
 *
 * Origin conventions (all in INCHES, Y up, matching src/engine/ledwall):
 *
 *   panel    x,y centred on the face; z is the cabinet depth with the SCREEN (the
 *            +z-most face) at +depth/2 and the back at −depth/2.
 *            → matches `panelGeometry` (a BoxGeometry centred on the origin).
 *
 *   base     origin is the panel's BOTTOM CENTRE; the plate hangs BELOW it, so
 *            y ∈ [−thick, 0] with its top face on y = 0 and its bottom on the same
 *            ground line as the support feet. x and z are centred, wide/notched end
 *            towards +Z (the viewer).
 *            → matches `basePlateGeometry` / `accessoryPlacements`.
 *
 *   support  origin is at GROUND LEVEL on the panel's BACK FACE: y ∈ [0, totalH]
 *            (foot on the floor), the vertical bar on z = 0 and the foot running
 *            back to z = −footD, width centred on x.
 *            → matches `supportBracketGeometry`.
 *
 *   table    origin on the floor, centred on x and z: y ∈ [0, height].
 *
 * STEP source axes, as measured from the supplied files (see the notes on each PART):
 *   panel/table already use the app's axes (X width, Y height, Z depth);
 *   base uses Y for its 0.25" thickness and X/Z for the plan, so it is axis-aligned too;
 *   the back supports are authored lying on their side — CAD X is the foot depth,
 *   CAD Y the height, CAD Z the 2" width — so they get a real rotation.
 */

const fs = require('fs');
const path = require('path');
const occtImport = require('occt-import-js');

const MM_PER_IN = 25.4;

const ROOT = path.resolve(__dirname, '..');
const CAD = path.resolve(ROOT, '..', 'cad', 'step');
const OUT = path.join(ROOT, 'public', 'models');

/** The five parts this project ships. `key` is what you pass on the command line. */
const PARTS = [
  { key: 'panel', step: 'LED iPoster - Panel.STEP', out: 'iposter-panel.glb', origin: 'panel', name: 'LED iPoster Panel' },
  { key: 'base', step: 'LED iPoster - Base.STEP', out: 'iposter-base.glb', origin: 'base', name: 'LED iPoster Base' },
  { key: 'support-lh', step: 'LED iPoster -LH Back Support.STEP', out: 'iposter-support-lh.glb', origin: 'support', name: 'LED iPoster LH Back Support' },
  { key: 'support-rh', step: 'LED iPoster -RH Back Support.STEP', out: 'iposter-support-rh.glb', origin: 'support', name: 'LED iPoster RH Back Support' },
];

/** Neutral PBR so the renderer can light it; STEP part colours are meaningless defaults. */
const MATERIAL = { color: [0.72, 0.73, 0.75, 1], metallic: 0.25, roughness: 0.55 };

/* ────────────────────────────────────────────────────────────────────────── */
/* STEP -> one merged mesh                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Read a STEP file and merge every solid into a single indexed mesh.
 * Positions come back in the STEP's own units (millimetres for these files).
 * @returns {{ position: Float64Array, normal: Float32Array, index: Uint32Array, solids: number }}
 */
function readStep(occt, file) {
  const result = occt.ReadStepFile(new Uint8Array(fs.readFileSync(file)), null);
  if (!result.success) throw new Error(`occt failed to read ${file}`);
  if (!result.meshes.length) throw new Error(`${file} contains no meshes`);

  let vertexCount = 0;
  let indexCount = 0;
  for (const m of result.meshes) {
    vertexCount += m.attributes.position.array.length / 3;
    indexCount += m.index.array.length;
  }

  const position = new Float64Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const index = new Uint32Array(indexCount);
  let vOff = 0; // in vertices
  let iOff = 0; // in indices

  for (const m of result.meshes) {
    const p = m.attributes.position.array;
    position.set(p, vOff * 3);
    if (m.attributes.normal && m.attributes.normal.array.length === p.length) {
      normal.set(m.attributes.normal.array, vOff * 3);
    } else {
      computeNormals(p, m.index.array, normal, vOff * 3);
    }
    const src = m.index.array;
    for (let i = 0; i < src.length; i++) index[iOff + i] = src[i] + vOff;
    vOff += p.length / 3;
    iOff += src.length;
  }

  return { position, normal, index, solids: result.meshes.length };
}

/** Area-weighted vertex normals, written into `out` starting at `outOffset`. */
function computeNormals(position, index, out, outOffset) {
  const acc = new Float64Array(position.length);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3;
    const b = index[t + 1] * 3;
    const c = index[t + 2] * 3;
    const ux = position[b] - position[a];
    const uy = position[b + 1] - position[a + 1];
    const uz = position[b + 2] - position[a + 2];
    const vx = position[c] - position[a];
    const vy = position[c + 1] - position[a + 1];
    const vz = position[c + 2] - position[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      acc[o] += nx;
      acc[o + 1] += ny;
      acc[o + 2] += nz;
    }
  }
  for (let i = 0; i < acc.length; i += 3) {
    const len = Math.hypot(acc[i], acc[i + 1], acc[i + 2]) || 1;
    out[outOffset + i] = acc[i] / len;
    out[outOffset + i + 1] = acc[i + 1] / len;
    out[outOffset + i + 2] = acc[i + 2] / len;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Geometry helpers                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/** Axis-aligned bounds of an interleaved xyz array. */
function bounds(position) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = position[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * Apply `p' = R·p` in place to positions and normals. `R` is given as the images of
 * the source basis vectors, i.e. `axes[i]` is where source axis i lands, as a signed
 * target axis: `[targetIndex, sign]`. Only signed permutations are used here, and every
 * one of them below is a proper rotation (det = +1), so triangle winding is preserved.
 */
function permute(position, normal, axes) {
  const apply = (arr) => {
    for (let i = 0; i < arr.length; i += 3) {
      const v = [arr[i], arr[i + 1], arr[i + 2]];
      const o = [0, 0, 0];
      for (let s = 0; s < 3; s++) o[axes[s][0]] = v[s] * axes[s][1];
      arr[i] = o[0];
      arr[i + 1] = o[1];
      arr[i + 2] = o[2];
    }
  };
  apply(position);
  apply(normal);
}

/** Scale positions (not normals) by `k`, then translate by `t`. */
function scaleTranslate(position, k, t) {
  for (let i = 0; i < position.length; i += 3) {
    position[i] = position[i] * k + t[0];
    position[i + 1] = position[i + 1] * k + t[1];
    position[i + 2] = position[i + 2] * k + t[2];
  }
}

/**
 * Move the mesh (already in inches) into the renderer's frame for `origin`.
 * Returns a short note describing what was done, for the log.
 */
function placeOrigin(origin, position, normal) {
  switch (origin) {
    case 'panel': {
      // CAD frame already matches the app: X width, Y height, Z depth, screen on +Z.
      const b = bounds(position);
      const depth = b.size[2];
      // x,y centred; z shifted so the +z-most plane (the screen) lands on +depth/2.
      scaleTranslate(position, 1, [
        -(b.min[0] + b.max[0]) / 2,
        -(b.min[1] + b.max[1]) / 2,
        -b.max[2] + depth / 2,
      ]);
      return `screen face on z = +${(depth / 2).toFixed(4)}"`;
    }

    case 'base': {
      // CAD frame already matches: X/Z are the plan, Y is the 0.25" thickness.
      const b = bounds(position);
      // The plan outline is mirror-symmetric in Z (a notch at BOTH ends), so the
      // "wide end towards +Z" requirement is satisfied either way round; assert it
      // rather than guess, and only flip if a future revision is asymmetric.
      const flip = !zSymmetric(position) && frontHalfWidth(position, +1) < frontHalfWidth(position, -1);
      if (flip) permute(position, normal, [[0, -1], [1, 1], [2, -1]]); // 180° about Y
      const b2 = flip ? bounds(position) : b;
      scaleTranslate(position, 1, [
        -(b2.min[0] + b2.max[0]) / 2,
        -b2.max[1], // top face on y = 0, plate hangs below
        -(b2.min[2] + b2.max[2]) / 2,
      ]);
      return `top face on y = 0, plate hangs to y = ${(b2.min[1] - b2.max[1]).toFixed(4)}"${flip ? ', flipped 180° about Y' : ', plan is Z-symmetric (no flip needed)'}`;
    }

    case 'support': {
      // CAD: X = foot depth, Y = height, Z = the 2" extrusion width. Identify the axes
      // by extent so a re-exported part cannot silently come out sideways.
      const b = bounds(position);
      const order = [0, 1, 2].sort((a, c) => b.size[a] - b.size[c]);
      const [wAxis, dAxis, hAxis] = order; // smallest = width, middle = depth, largest = height
      // Which end of the depth axis is the vertical bar? The one that reaches the top.
      const barAtMin = barEnd(position, dAxis, hAxis, b);
      // Source depth axis -> target −Z (foot runs behind the panel); height -> +Y; width -> +X.
      const axes = [];
      axes[wAxis] = [0, 1];
      axes[hAxis] = [1, 1];
      axes[dAxis] = [2, barAtMin ? -1 : 1];
      // Keep the mapping a proper rotation (det = +1) so winding and normals survive.
      if (determinant(axes) < 0) axes[wAxis] = [0, -1];
      permute(position, normal, axes);
      const b2 = bounds(position);
      scaleTranslate(position, 1, [
        -(b2.min[0] + b2.max[0]) / 2, // width centred on x
        -b2.min[1], // foot on the floor
        -b2.max[2], // vertical bar on z = 0, foot to −Z
      ]);
      return `bar on z = 0, foot to z = ${(b2.min[2] - b2.max[2]).toFixed(4)}", foot on y = 0`;
    }

    case 'table': {
      // CAD frame already matches: the 16:9 display face is the XY plane, Z is depth.
      const b = bounds(position);
      scaleTranslate(position, 1, [
        -(b.min[0] + b.max[0]) / 2,
        -b.min[1], // sits on the floor
        -(b.min[2] + b.max[2]) / 2,
      ]);
      return 'floor at y = 0, centred on x and z';
    }

    default:
      throw new Error(`unknown --origin "${origin}" (panel | base | support | table)`);
  }
}

/** True if the vertex set is mirror-symmetric about z = (min+max)/2. */
function zSymmetric(position) {
  const b = bounds(position);
  const mid = (b.min[2] + b.max[2]) / 2;
  const key = (x, y, z) => `${x.toFixed(3)}|${y.toFixed(3)}|${z.toFixed(3)}`;
  const set = new Set();
  for (let i = 0; i < position.length; i += 3) set.add(key(position[i], position[i + 1], position[i + 2]));
  for (let i = 0; i < position.length; i += 3) {
    if (!set.has(key(position[i], position[i + 1], 2 * mid - position[i + 2]))) return false;
  }
  return true;
}

/** X extent of the material in the outer 20 % of the given z half — "how wide is that end". */
function frontHalfWidth(position, sign) {
  const b = bounds(position);
  const cut = sign > 0 ? b.max[2] - b.size[2] * 0.2 : b.min[2] + b.size[2] * 0.2;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < position.length; i += 3) {
    const z = position[i + 2];
    if (sign > 0 ? z >= cut : z <= cut) {
      lo = Math.min(lo, position[i]);
      hi = Math.max(hi, position[i]);
    }
  }
  return hi - lo;
}

/** True if the tall vertical bar sits at the MIN end of `dAxis`. */
function barEnd(position, dAxis, hAxis, b) {
  const cut = b.size[dAxis] * 0.15;
  let loTop = -Infinity;
  let hiTop = -Infinity;
  for (let i = 0; i < position.length; i += 3) {
    const d = position[i + dAxis];
    const h = position[i + hAxis];
    if (d <= b.min[dAxis] + cut) loTop = Math.max(loTop, h);
    if (d >= b.max[dAxis] - cut) hiTop = Math.max(hiTop, h);
  }
  return loTop >= hiTop;
}

/** Determinant of a signed-permutation given as source-axis images. */
function determinant(axes) {
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let s = 0; s < 3; s++) m[axes[s][0]][s] = axes[s][1];
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* GLB container                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'
const UNSIGNED_INT = 5125;
const FLOAT = 5126;
const ELEMENT_ARRAY_BUFFER = 34963;
const ARRAY_BUFFER = 34962;

const pad4 = (n) => (n + 3) & ~3;

/**
 * Write one indexed mesh as a binary glTF: a single node, mesh, primitive and
 * PBR material, with the index/position/normal buffers packed into the BIN chunk.
 */
function writeGlb(file, name, { position, normal, index }) {
  const positions = Float32Array.from(position);
  const normals = Float32Array.from(normal);
  const indices = Uint32Array.from(index);
  const b = bounds(positions);

  // BIN chunk: indices, then positions, then normals — each aligned to 4 bytes,
  // which every one of these component types already is.
  const idxLen = indices.byteLength;
  const posOff = pad4(idxLen);
  const posLen = positions.byteLength;
  const nrmOff = pad4(posOff + posLen);
  const nrmLen = normals.byteLength;
  const binLen = pad4(nrmOff + nrmLen);

  const bin = Buffer.alloc(binLen);
  Buffer.from(indices.buffer, indices.byteOffset, idxLen).copy(bin, 0);
  Buffer.from(positions.buffer, positions.byteOffset, posLen).copy(bin, posOff);
  Buffer.from(normals.buffer, normals.byteOffset, nrmLen).copy(bin, nrmOff);

  const gltf = {
    asset: { version: '2.0', generator: 'veloxity step-to-glb' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 1, NORMAL: 2 }, indices: 0, material: 0 }] }],
    materials: [
      {
        name: `${name} material`,
        doubleSided: false,
        pbrMetallicRoughness: {
          baseColorFactor: MATERIAL.color,
          metallicFactor: MATERIAL.metallic,
          roughnessFactor: MATERIAL.roughness,
        },
      },
    ],
    accessors: [
      { bufferView: 0, componentType: UNSIGNED_INT, count: indices.length, type: 'SCALAR' },
      { bufferView: 1, componentType: FLOAT, count: positions.length / 3, type: 'VEC3', min: b.min, max: b.max },
      { bufferView: 2, componentType: FLOAT, count: normals.length / 3, type: 'VEC3' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: idxLen, target: ELEMENT_ARRAY_BUFFER },
      { buffer: 0, byteOffset: posOff, byteLength: posLen, target: ARRAY_BUFFER },
      { buffer: 0, byteOffset: nrmOff, byteLength: nrmLen, target: ARRAY_BUFFER },
    ],
    buffers: [{ byteLength: binLen }],
  };

  const jsonRaw = Buffer.from(JSON.stringify(gltf), 'utf8');
  const json = Buffer.alloc(pad4(jsonRaw.length), 0x20); // pad JSON with spaces
  jsonRaw.copy(json);

  const total = 12 + 8 + json.length + 8 + bin.length;
  const glb = Buffer.alloc(total);
  let o = 0;
  glb.writeUInt32LE(GLB_MAGIC, o); o += 4;
  glb.writeUInt32LE(2, o); o += 4;
  glb.writeUInt32LE(total, o); o += 4;
  glb.writeUInt32LE(json.length, o); o += 4;
  glb.writeUInt32LE(CHUNK_JSON, o); o += 4;
  json.copy(glb, o); o += json.length;
  glb.writeUInt32LE(bin.length, o); o += 4;
  glb.writeUInt32LE(CHUNK_BIN, o); o += 4;
  bin.copy(glb, o);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, glb);
  return { bytes: total, bounds: b };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Driver                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const opts = { keys: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') opts.in = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--origin') opts.origin = argv[++i];
    else if (a === '--name') opts.name = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else opts.keys.push(a);
  }
  return opts;
}

const f4 = (v) => (v < 0 ? '' : ' ') + v.toFixed(4);

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  /** @type {{step:string,out:string,origin:string,name:string}[]} */
  let jobs;
  if (opts.in) {
    if (!opts.origin) throw new Error('--in requires --origin');
    jobs = [{
      step: path.resolve(opts.in),
      out: path.resolve(opts.out || path.join(OUT, path.basename(opts.in).replace(/\.ste?p$/i, '.glb'))),
      origin: opts.origin,
      name: opts.name || path.basename(opts.in).replace(/\.ste?p$/i, ''),
    }];
  } else {
    const wanted = opts.keys.length ? opts.keys : PARTS.map((p) => p.key);
    jobs = wanted.map((k) => {
      const p = PARTS.find((q) => q.key === k);
      if (!p) throw new Error(`unknown part "${k}" (${PARTS.map((q) => q.key).join(', ')})`);
      return { step: path.join(CAD, p.step), out: path.join(OUT, p.out), origin: p.origin, name: p.name };
    });
  }

  const occt = await occtImport();

  for (const job of jobs) {
    const mesh = readStep(occt, job.step);
    const mm = bounds(mesh.position);
    scaleTranslate(mesh.position, 1 / MM_PER_IN, [0, 0, 0]); // mm -> inches
    const note = placeOrigin(job.origin, mesh.position, mesh.normal);
    const { bytes, bounds: b } = writeGlb(job.out, job.name, mesh);

    console.log(`${path.basename(job.out)}  (${job.origin})`);
    console.log(`  from   ${path.basename(job.step)} — ${mesh.solids} solid(s), ${mesh.position.length / 3} verts, ${mesh.index.length / 3} tris, ${(bytes / 1024).toFixed(0)} KB`);
    console.log(`  mm     ${mm.size.map((v) => v.toFixed(2)).join(' x ')}`);
    console.log(`  in     x [${f4(b.min[0])}, ${f4(b.max[0])}]   y [${f4(b.min[1])}, ${f4(b.max[1])}]   z [${f4(b.min[2])}, ${f4(b.max[2])}]`);
    console.log(`  size   ${(b.max[0] - b.min[0]).toFixed(4)} x ${(b.max[1] - b.min[1]).toFixed(4)} x ${(b.max[2] - b.min[2]).toFixed(4)} in`);
    console.log(`  origin ${note}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
