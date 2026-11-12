// Shrinks every model under public/models in place with glTF-Transform and meshoptimizer, keeping file names,
// formats and external resources exactly as they are so that no URL in the game changes:
//   - a .gltf stays a .gltf next to its own .bin (same name) and its external .png textures, which are never
//     rewritten, re-encoded or embedded (hex/*.gltf share hexagons_medieval.png, props reference *_texture.png);
//   - a .glb stays a .glb; the castle kit GLBs keep referencing Textures/colormap.png externally, the character
//     GLBs keep their embedded texture.
// The two rigs in anim/ only contribute animation clips to the game (it reads gltf.animations and matches tracks
// to node names), so their dummy meshes, skin, material and textures are stripped while the node hierarchy and
// every animation are kept.
//
// Every model then gets dedup + prune + EXT_meshopt_compression (which quantizes vertex attributes with
// KHR_mesh_quantization). Positions are quantized against the whole scene's bounds ('scene' volume) rather than
// per mesh: the skinned characters are several meshes sharing one skin, and the game merges those meshes'
// geometries at runtime and binds the result to the first mesh's skeleton, so all of them must live on the same
// quantization grid with the same inverse bind matrices. glTF-Transform clones the shared skin once per mesh
// node, applies the grid transform to the clone's inverse bind matrices (never touching the original twice) and,
// because every clone is identical under the 'scene' volume, its cleanup pass merges them back into one skin.
// The verification step below asserts exactly that (one skin, and a uniform attribute layout across the body
// parts that share a material, since the game merges per material).
//
// Inputs are read from asset-source/models-original/, a gitignored backup of public/models created on the first
// run; outputs go to public/models, so re-running regenerates the same outputs from the same originals. Backed-up
// files are never overwritten; files that are new in public/models (fresh imports) are added to the backup and
// optimized like the rest.
//
// Run: node scripts/optimize-assets.mjs [filter]   (an optional substring restricts which models are processed)
//
// Loading the output in three.js needs GLTFLoader.setMeshoptDecoder(MeshoptDecoder) from
// 'three/addons/libs/meshopt_decoder.module.js'; KHR_mesh_quantization and KHR_texture_transform are built in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Format, Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'models');
const BACKUP_DIR = path.join(ROOT, 'asset-source', 'models-original');
/** Models the game only reads `gltf.animations` from. */
const ANIMATION_ONLY = new Set(['anim/Rig_Medium_General.glb', 'anim/Rig_Medium_MovementBasic.glb']);
/** Extensions the outputs may require; anything else is a bug (and would need loader work). */
const ALLOWED_REQUIRED = new Set(['KHR_mesh_quantization', 'EXT_meshopt_compression']);
const MODEL_RE = /\.(glb|gltf)$/i;
const SAMPLE_OUTPUTS = ['hex/barrel.gltf', 'chars/Knight.glb', 'castle/wall.glb', 'anim/Rig_Medium_General.glb'];

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder })
  .setLogger(new Logger(Logger.Verbosity.WARN));

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const kb = (bytes) => (bytes / 1024).toFixed(1);
const change = (before, after) => { const p = before ? Math.round((1 - after / before) * 100) : 0; return `${p < 0 ? '+' : '-'}${Math.abs(p)}%`; };
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Backs up the originals. A file that exists in public/models but not in the backup is an original the script
 * has never written (new imports, or a first run that was interrupted), so it is copied in; files already in
 * the backup are never overwritten, because public/models may hold optimized output by then.
 */
function ensureBackup() {
  const fresh = !fs.existsSync(BACKUP_DIR);
  if (fresh && !fs.existsSync(OUT_DIR)) throw new Error(`Neither ${rel(OUT_DIR)} nor ${rel(BACKUP_DIR)} exists.`);
  let added = 0;
  for (const file of fs.existsSync(OUT_DIR) ? listFiles(OUT_DIR) : []) {
    const dst = path.join(BACKUP_DIR, file);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(OUT_DIR, file), dst);
    added++;
  }
  if (fresh) console.log(`Backed up ${rel(OUT_DIR)} to ${rel(BACKUP_DIR)} (${added} files).`);
  else console.log(`Reading originals from the existing backup ${rel(BACKUP_DIR)}${added ? ` (${added} new files added to it)` : ''}.`);
}

/** Lists every file under `dir` as a sorted, forward-slash path relative to it. */
function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(p, base));
    else files.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return files.sort();
}

/** Bytes per top-level directory (anim, castle, chars, ...) over every file in the tree. */
function sizesByDirectory(base) {
  const sizes = new Map();
  for (const file of listFiles(base)) {
    const dir = file.includes('/') ? file.split('/')[0] : '.';
    sizes.set(dir, (sizes.get(dir) ?? 0) + fs.statSync(path.join(base, file)).size);
  }
  return sizes;
}

/** Returns the JSON of a .gltf, or the JSON chunk of a .glb (chunk length is the uint32 at byte 12, data starts at 20). */
function readModelJson(file) {
  const bytes = fs.readFileSync(file);
  if (/\.glb$/i.test(file)) return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
  return JSON.parse(bytes.toString('utf8'));
}

/** The facts about a document that the game depends on, captured before and after optimizing. */
function snapshot(doc) {
  const root = doc.getRoot();
  // prune() may drop TANGENT and the TEXCOORD_n no texture samples; everything else must survive untouched.
  const describe = (prim, typed = false, all = false) => prim.listSemantics().sort()
    .filter((s) => all || (s !== 'TANGENT' && !s.startsWith('TEXCOORD_')))
    .map((s) => (typed ? `${s}:${prim.getAttribute(s).getArray().constructor.name}:${prim.getAttribute(s).getNormalized() ? 'norm' : 'raw'}` : s))
    .join('+');
  const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
  // Skinned primitives grouped by material: the game merges each group's geometries into one SkinnedMesh at
  // runtime, which needs identical attribute layouts (semantics, component types, normalization) within a group.
  const skinnedLayouts = new Map();
  for (const node of root.listNodes()) {
    if (!node.getSkin() || !node.getMesh()) continue;
    for (const prim of node.getMesh().listPrimitives()) {
      const group = skinnedLayouts.get(prim.getMaterial()) ?? new Set();
      skinnedLayouts.set(prim.getMaterial(), group.add(describe(prim, true, true)));
    }
  }
  // Primitives whose material samples a texture through a TEXCOORD_n attribute they no longer have.
  let missingUVs = 0;
  for (const prim of prims) {
    const m = prim.getMaterial();
    if (!m) continue;
    const infos = [m.getBaseColorTextureInfo(), m.getEmissiveTextureInfo(), m.getNormalTextureInfo(), m.getOcclusionTextureInfo(), m.getMetallicRoughnessTextureInfo()];
    for (const info of infos) if (info && !prim.getAttribute(`TEXCOORD_${info.getTexCoord()}`)) missingUVs++;
  }
  return {
    nodeNames: root.listNodes().map((n) => n.getName()).filter(Boolean).sort(),
    skins: root.listSkins().length,
    meshes: root.listMeshes().length,
    animations: root.listAnimations().map((a) => `${a.getName()}:${a.listChannels().length}`).sort(),
    bufferURIs: root.listBuffers().map((b) => b.getURI()).filter(Boolean),
    imageURIs: root.listTextures().map((t) => t.getURI()).sort(), // '' for an embedded image
    layouts: [...new Set(prims.map((p) => describe(p)))].sort(),
    unmergeable: [...skinnedLayouts.values()].filter((group) => group.size > 1).map((group) => [...group].join(' | ')),
    missingUVs,
  };
}

/** Removes everything but the node hierarchy and the animations; prune() then drops the orphaned accessors. */
function stripToAnimations(doc) {
  const root = doc.getRoot();
  for (const skin of root.listSkins()) skin.dispose();
  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const material of root.listMaterials()) material.dispose();
  for (const texture of root.listTextures()) texture.dispose();
}

/** Every image must still be an external file with its original uri (never embedded, never renamed). */
function assertExternalImages(json, before, outPath) {
  for (const image of json.images ?? []) {
    if (image.uri === undefined || image.bufferView !== undefined) throw new Error(`${rel(outPath)}: a texture was embedded`);
    if (!before.imageURIs.includes(image.uri)) throw new Error(`${rel(outPath)}: texture uri changed to "${image.uri}"`);
  }
}

/** Writes a .gltf whose .bin keeps its original name; textures are left untouched on disk. Returns the files written. */
async function writeGltf(doc, outPath, before) {
  const { json, resources } = await io.writeJSON(doc, { format: Format.GLTF, basename: path.basename(outPath, '.gltf') });
  const buffers = (json.buffers ?? []).filter((b) => b.uri); // the meshopt fallback buffer has neither uri nor data
  if (buffers.length !== 1 || before.bufferURIs.length !== 1) throw new Error(`${rel(outPath)}: expected exactly one .bin`);
  const [buffer] = buffers;
  const [binURI] = before.bufferURIs;
  if (buffer.uri !== binURI) { // the writer reuses a buffer's uri; if it ever renames, put the original name back
    resources[binURI] = resources[buffer.uri];
    delete resources[buffer.uri];
    buffer.uri = binURI;
  }
  assertExternalImages(json, before, outPath);
  for (const image of json.images ?? []) delete resources[image.uri]; // identical bytes, but never rewrite textures
  if (!sameList(Object.keys(resources), [binURI])) throw new Error(`${rel(outPath)}: unexpected resources ${Object.keys(resources)}`);
  fs.writeFileSync(outPath, JSON.stringify(json, null, 2));
  const binPath = path.join(path.dirname(outPath), decodeURIComponent(binURI));
  fs.writeFileSync(binPath, resources[binURI]);
  return [outPath, binPath];
}

/** Packs glTF JSON and its binary buffer into the GLB container (buffer 0 is the BIN chunk). */
function encodeGlb(json, bin) {
  const pad = (bytes, fill) => { const out = Buffer.alloc(Math.ceil(bytes.byteLength / 4) * 4, fill); out.set(bytes); return out; };
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.byteLength, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  const chunks = [chunk(0x4e4f534a, pad(Buffer.from(JSON.stringify(json)), 0x20))];
  if (bin.byteLength) chunks.push(chunk(0x004e4942, pad(bin, 0x00)));
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.byteLength, 8);
  return Buffer.concat([header, body]);
}

/**
 * Writes a .glb whose textures stay external. glTF-Transform's own GLB writer always embeds images, so this
 * takes the .gltf-style output (where images keep their uri) and packs it into a GLB container by hand.
 */
async function writeGlbKeepingExternalTextures(doc, outPath, before) {
  const { json, resources } = await io.writeJSON(doc, { format: Format.GLTF, basename: path.basename(outPath, '.glb') });
  const buffers = json.buffers ?? [];
  const dataBuffers = buffers.filter((b) => b.uri);
  if (dataBuffers.length > 1 || (dataBuffers.length === 1 && dataBuffers[0] !== buffers[0])) {
    throw new Error(`${rel(outPath)}: a GLB needs its single binary buffer at index 0`);
  }
  let bin = new Uint8Array(0);
  if (dataBuffers.length === 1) {
    bin = resources[buffers[0].uri];
    delete buffers[0].uri;
  }
  assertExternalImages(json, before, outPath);
  fs.writeFileSync(outPath, encodeGlb(json, bin));
}

/** Writes the document in the input's own format. Returns the output files (model plus .bin for a .gltf). */
async function writeModel(doc, relPath, before) {
  const outPath = path.join(OUT_DIR, relPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (/\.gltf$/i.test(relPath)) return writeGltf(doc, outPath, before);
  const textures = doc.getRoot().listTextures();
  const external = textures.filter((t) => t.getURI()).length;
  if (external === 0) {
    await io.write(outPath, doc); // embedded images stay embedded
  } else if (external === textures.length) {
    await writeGlbKeepingExternalTextures(doc, outPath, before);
  } else {
    throw new Error(`${relPath}: mixing external and embedded textures in one GLB is not supported`);
  }
  return [outPath];
}

/** Compares before/after snapshots; returns a list of problems (empty when the output is as expected). */
function check(before, after, animationOnly, outPath) {
  const problems = [];
  if (!sameList(before.nodeNames, after.nodeNames)) problems.push('named nodes changed');
  if (!sameList(before.animations, after.animations)) problems.push('animations changed');
  if (!sameList(before.imageURIs, after.imageURIs)) problems.push('texture uris changed');
  if (animationOnly) {
    if (after.skins || after.meshes) problems.push('rig still carries meshes or a skin');
  } else {
    if (before.skins !== after.skins) problems.push(`skins ${before.skins} -> ${after.skins}`);
    if (!sameList(before.layouts, after.layouts)) problems.push(`attributes changed: ${before.layouts} -> ${after.layouts}`);
    if (after.missingUVs) problems.push(`${after.missingUVs} primitives lost the UVs their texture samples`);
    if (after.unmergeable.length) problems.push(`skinned meshes sharing a material differ in layout: ${after.unmergeable.join(' ; ')}`);
  }
  const json = readModelJson(outPath);
  const dir = path.dirname(outPath);
  for (const ext of json.extensionsRequired ?? []) if (!ALLOWED_REQUIRED.has(ext)) problems.push(`requires ${ext}`);
  for (const buffer of json.buffers ?? []) if (buffer.uri && !fs.existsSync(path.join(dir, buffer.uri))) problems.push(`missing ${buffer.uri}`);
  for (const image of json.images ?? []) if (image.uri && !fs.existsSync(path.join(dir, image.uri))) problems.push(`missing ${image.uri}`);
  return problems;
}

/** Optimizes one model from the backup into public/models and verifies the result. */
async function optimizeModel(relPath) {
  const doc = await io.read(path.join(BACKUP_DIR, relPath));
  const before = snapshot(doc);
  const animationOnly = ANIMATION_ONLY.has(relPath);
  if (animationOnly) stripToAnimations(doc);
  const compression = { encoder: MeshoptEncoder, level: 'medium' };
  if (doc.getRoot().listMeshes().length) compression.quantizationVolume = 'scene'; // the 'scene' volume needs a mesh to measure
  await doc.transform(
    dedup(),
    prune({ keepLeaves: true, keepSolidTextures: true }), // keep empty nodes (e.g. sockets) and leave textures alone
    meshopt(compression),
  );
  const outputs = await writeModel(doc, relPath, before);
  const outPath = path.join(OUT_DIR, relPath);
  const after = snapshot(await io.read(outPath)); // re-read: the output must parse (and decode) with NodeIO
  const problems = check(before, after, animationOnly, outPath);
  const sizeBefore = outputs.reduce((n, p) => n + fs.statSync(path.join(BACKUP_DIR, path.relative(OUT_DIR, p))).size, 0);
  const sizeAfter = outputs.reduce((n, p) => n + fs.statSync(p).size, 0);
  const status = problems.length ? `  PROBLEMS: ${problems.join('; ')}` : '';
  console.log(`${relPath.padEnd(42)} ${kb(sizeBefore).padStart(8)} KB -> ${kb(sizeAfter).padStart(7)} KB  (${change(sizeBefore, sizeAfter)})${status}`);
  return { relPath, problems, json: readModelJson(outPath) };
}

/** Prints the per-directory size table, the extensions the outputs use, and any file-set differences. */
function printReport(results) {
  const before = sizesByDirectory(BACKUP_DIR);
  const after = sizesByDirectory(OUT_DIR);
  const row = (dir, files, b, a) => console.log(`${dir.padEnd(10)} ${String(files).padStart(5)} ${kb(b).padStart(11)} ${kb(a).padStart(10)} ${change(b, a).padStart(7)}`);
  console.log('\nAll files under public/models (textures are unchanged and included)');
  console.log(`${'directory'.padEnd(10)} ${'files'.padStart(5)} ${'before KB'.padStart(11)} ${'after KB'.padStart(10)} ${'change'.padStart(7)}`);
  let totalBefore = 0;
  let totalAfter = 0;
  for (const dir of [...before.keys()].sort()) {
    row(dir, listFiles(path.join(OUT_DIR, dir)).length, before.get(dir), after.get(dir) ?? 0);
    totalBefore += before.get(dir);
    totalAfter += after.get(dir) ?? 0;
  }
  row('total', listFiles(OUT_DIR).length, totalBefore, totalAfter);

  const used = new Set();
  const required = new Set();
  for (const { json } of results) {
    for (const e of json.extensionsUsed ?? []) used.add(e);
    for (const e of json.extensionsRequired ?? []) required.add(e);
  }
  console.log(`\nextensionsUsed across outputs:     ${[...used].sort().join(', ') || '(none)'}`);
  console.log(`extensionsRequired across outputs: ${[...required].sort().join(', ') || '(none)'}`);
  for (const sample of SAMPLE_OUTPUTS) {
    const r = results.find((x) => x.relPath === sample);
    if (r) console.log(`  ${sample.padEnd(30)} used=[${(r.json.extensionsUsed ?? []).join(', ')}] required=[${(r.json.extensionsRequired ?? []).join(', ')}]`);
  }

  const sourceFiles = listFiles(BACKUP_DIR);
  const outputFiles = listFiles(OUT_DIR);
  const missing = sourceFiles.filter((f) => !outputFiles.includes(f));
  const extra = outputFiles.filter((f) => !sourceFiles.includes(f));
  if (missing.length) console.log(`\nWARNING files in the backup but not in public/models: ${missing.join(', ')}`);
  if (extra.length) console.log(`\nNOTE files in public/models that are not in the backup (left alone): ${extra.join(', ')}`);
  const failed = results.filter((r) => r.problems.length);
  console.log(`\n${results.length} models processed, ${failed.length} with problems.`);
  return failed.length === 0 && missing.length === 0;
}

async function main() {
  const filter = process.argv[2] ?? '';
  ensureBackup();
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const sourceFiles = listFiles(BACKUP_DIR);
  // Textures and anything else that is neither a model nor a model's .bin are copied, never modified.
  for (const file of sourceFiles) {
    if (MODEL_RE.test(file) || /\.bin$/i.test(file)) continue;
    const dst = path.join(OUT_DIR, file);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(BACKUP_DIR, file), dst);
  }
  const results = [];
  for (const file of sourceFiles) {
    if (MODEL_RE.test(file) && file.includes(filter)) results.push(await optimizeModel(file));
  }
  if (!printReport(results)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
