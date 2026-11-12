// Copies the models the game uses out of the unpacked asset packs in asset-source/ into public/models.
// A .gltf is copied together with the .bin buffers and textures it references; a .glb is copied as is.
// Run: node scripts/import-assets.mjs
import fs from 'node:fs';
import path from 'node:path';

const ADV = 'asset-source/adventurers/unpacked/KayKit_Adventurers_2.0_FREE';
const SKEL = 'asset-source/skeletons/unpacked/KayKit_Skeletons_1.1_FREE';
const HEX = 'asset-source/medieval-hexagon/unpacked/KayKit_Medieval_Hexagon_Pack_1.0_FREE/Assets/gltf';
const CASTLE = 'asset-source/castle-kit/unpacked/Models/GLB format';

/** Finds a file by name anywhere under a directory. */
function locate(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const hit = locate(p, name); if (hit) return hit; }
    else if (entry.name === name) return p;
  }
  return null;
}

let copied = 0;
function copyModel(src, dstDir) {
  if (!src || !fs.existsSync(src)) { console.warn('missing:', src); return; }
  fs.mkdirSync(dstDir, { recursive: true });
  const files = [path.basename(src)];
  if (src.endsWith('.gltf')) {
    const json = JSON.parse(fs.readFileSync(src, 'utf8'));
    for (const b of json.buffers ?? []) if (b.uri && !b.uri.startsWith('data:')) files.push(b.uri);
    for (const im of json.images ?? []) if (im.uri && !im.uri.startsWith('data:')) files.push(im.uri);
  }
  for (const f of files) {
    const to = path.join(dstDir, f);
    if (fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(path.dirname(src), f), to);
    copied++;
    console.log('copied', to);
  }
}

// Heroes and their weapons (KayKit Adventurers 2.0, CC0).
for (const c of ['Knight', 'Barbarian', 'Rogue', 'Rogue_Hooded', 'Ranger', 'Mage']) copyModel(`${ADV}/Characters/gltf/${c}.glb`, 'public/models/chars');
for (const w of ['arrow_bow', 'crossbow_1handed', 'crossbow_2handed', 'bow_withString', 'axe_2handed', 'staff', 'wand', 'dagger', 'sword_1handed', 'shield_round', 'smokebomb', 'spellbook_open'])
  copyModel(`${ADV}/Assets/gltf/${w}.gltf`, 'public/models/props');
copyModel(locate(ADV, 'Rig_Medium_General.glb'), 'public/models/anim');
copyModel(locate(ADV, 'Rig_Medium_MovementBasic.glb'), 'public/models/anim');

// Skeletons and their gear (KayKit Skeletons 1.1, CC0).
for (const c of ['Skeleton_Minion', 'Skeleton_Rogue', 'Skeleton_Warrior', 'Skeleton_Mage']) copyModel(locate(SKEL, `${c}.glb`), 'public/models/chars');
for (const g of ['Skeleton_Crossbow', 'Skeleton_Shield_Large_A', 'Skeleton_Shield_Small_A', 'Skeleton_Axe', 'Skeleton_Staff', 'Skeleton_Blade', 'Skeleton_Arrow'])
  copyModel(locate(SKEL, `${g}.gltf`), 'public/models/props');

// Hexagon pack: neutral bridges for the river map (the coloured buildings are already in place).
for (const b of ['building_bridge_A', 'building_bridge_B']) copyModel(`${HEX}/buildings/neutral/${b}.gltf`, 'public/models/hex');

// Kenney castle kit: siege engines and ruins as set dressing.
for (const m of ['siege-ram', 'siege-ram-demolished', 'siege-trebuchet', 'siege-trebuchet-demolished', 'siege-tower-demolished', 'bridge-straight'])
  copyModel(`${CASTLE}/${m}.glb`, 'public/models/castle');

console.log(`done, ${copied} new files`);
