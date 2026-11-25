#!/usr/bin/env node
// Resolume preset round-trip test suite.
// Updated: 2026-06-09 v2.0 (audit) — the old suite only compared shortcut
// ids and keys, which let parse→serialize silently drop <Subtarget> and
// <ValueRange> children (147 + 48 of them across the fixture corpus). This
// version deep-compares the full XML structure, so ANY dropped element,
// attribute, or changed value fails the run. Also adds unit tests for the
// key codec edge cases, top-byte mapping, and MIDI byte reconstruction.
//
// Run: npm run test:resolume   (npx tsx scripts/test-resolume-roundtrip.mjs)

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { XMLParser } from 'fast-xml-parser';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const fixturesDir = join(root, 'test-fixtures', 'resolume');
const require = createRequire(import.meta.url);

// Dynamic import() needs a file:// URL, not a bare path: on Windows an absolute
// path like C:\... is read as URL scheme "c:" and rejected (ERR_UNSUPPORTED_ESM_URL_SCHEME).
const { parsePreset, serializePreset } = await import(pathToFileURL(join(root, 'src/resolume/preset-io.ts')).href);
const { decodeRawInputKey, encodeRawInputKey, tryDecodeRawInputKey, describeKey, topByteForStatus } =
  await import(pathToFileURL(join(root, 'src/resolume/raw-input-key.ts')).href);
const { toRawBytes } = require(join(root, 'electron/midi-bytes.cjs'));

let failures = 0;
function check(ok, label, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
    failures++;
  }
}

// --- structural comparison helpers ---------------------------------------

// Neutral parser (same options as the codec) for raw-tree comparison.
const neutralParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  preserveOrder: false,
  allowBooleanAttributes: true,
  trimValues: false,
});

// Normalize a parsed tree for comparison: drop whitespace-only #text nodes
// (pretty-printing artifacts) and sort object keys so attribute/child order
// doesn't matter — Resolume addresses children by name, not position.
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node).sort()) {
      if (k === '#text') {
        const t = node[k];
        const allWs = (Array.isArray(t) ? t : [t]).every((s) => typeof s === 'string' && s.trim() === '');
        if (allWs) continue;
      }
      out[k] = normalize(node[k]);
    }
    return out;
  }
  return node;
}

// The single intentional output difference: the editor strips the `name`
// attribute from <RawInputMessage> (emitting it crashes Resolume — see
// preset-io.ts). Remove it from the ORIGINAL tree before comparing.
function stripRawInputNames(node) {
  if (Array.isArray(node)) { node.forEach(stripRawInputNames); return node; }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'RawInputMessage') {
        for (const r of Array.isArray(v) ? v : [v]) {
          if (r && typeof r === 'object') delete r['@_name'];
        }
      }
      stripRawInputNames(v);
    }
  }
  return node;
}

// Report the path of the first difference between two normalized trees.
function firstDiff(a, b, path = '') {
  if (a === b) return null;
  const ta = Object.prototype.toString.call(a);
  const tb = Object.prototype.toString.call(b);
  if (ta !== tb) return `${path}: ${ta} vs ${tb}`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: array length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a !== null && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) return `${path}.${k}: missing in original`;
      if (!(k in b)) return `${path}.${k}: missing in re-serialized output`;
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

function countTags(xml) {
  const counts = {};
  for (const m of xml.matchAll(/<([A-Za-z][\w]*)\b/g)) {
    counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return counts;
}

// --- fixture round-trips ---------------------------------------------------

const files = readdirSync(fixturesDir).filter(f => f.endsWith('.xml'));
console.log(`Round-tripping ${files.length} presets (full structural compare)...\n`);

for (const file of files) {
  const original = readFileSync(join(fixturesDir, file), 'utf8');
  try {
    const preset = parsePreset(original);
    const reserialized = serializePreset(preset);

    // 1. Element counts must survive (catches dropped Subtarget/ValueRange/…).
    const beforeCounts = countTags(original);
    const afterCounts = countTags(reserialized);
    const countDiffs = [];
    for (const tag of new Set([...Object.keys(beforeCounts), ...Object.keys(afterCounts)])) {
      if ((beforeCounts[tag] ?? 0) !== (afterCounts[tag] ?? 0)) {
        countDiffs.push(`${tag}: ${beforeCounts[tag] ?? 0} -> ${afterCounts[tag] ?? 0}`);
      }
    }

    // 2. Full structural equality modulo the intentional RawInputMessage
    //    name-attr strip and whitespace.
    const treeA = normalize(stripRawInputNames(neutralParser.parse(original)));
    const treeB = normalize(neutralParser.parse(reserialized));
    const diff = firstDiff(treeA, treeB);

    // 3. Every key round-trips through the codec.
    let keyMismatch = 0;
    for (const s of preset.shortcuts) {
      if (!s.rawInput) continue;
      if (encodeRawInputKey(decodeRawInputKey(s.rawInput.keyRaw)).toString() !== s.rawInput.keyRaw) keyMismatch++;
    }

    const ok = countDiffs.length === 0 && !diff && keyMismatch === 0;
    check(ok, `${file}  (${preset.shortcuts.length} shortcuts)`,
      [countDiffs.length ? `element counts changed: ${countDiffs.join(', ')}` : '',
       diff ? `structural diff at ${diff}` : '',
       keyMismatch ? `${keyMismatch} key codec mismatches` : ''].filter(Boolean).join('; '));
  } catch (err) {
    check(false, file, err.message);
  }
}

// --- byte-identical round-trip on current-format fixtures --------------------
// The synthetic current-format fixtures (no `name` attr on
// RawInputMessage) must survive parse→serialize with ZERO byte changes —
// attribute order, indentation, self-closing forms, and the trailing blank
// line all included. The structural compare above can't see whitespace, so
// this is the assertion that catches formatting drift.

{
  const byteIdenticalFixtures = ['current.xml', 'minimal.xml'];
  for (const file of byteIdenticalFixtures) {
    const original = readFileSync(join(fixturesDir, file), 'utf8');
    const out = serializePreset(parsePreset(original));
    let detail = '';
    if (out !== original) {
      let i = 0;
      while (i < Math.min(out.length, original.length) && out[i] === original[i]) i++;
      detail = `first byte diff at offset ${i}: ${JSON.stringify(original.slice(i, i + 30))} vs ${JSON.stringify(out.slice(i, i + 30))} (lengths ${original.length}/${out.length})`;
    }
    check(out === original, `byte-identical round-trip (${file})`, detail);
  }
}

// Editing a mapped row must preserve the synthetic target and range metadata.
{
  const original = readFileSync(join(fixturesDir, 'current.xml'), 'utf8');
  const preset = parsePreset(original);
  preset.shortcuts[0].inputDeviceName = 'Replacement Controller';
  const xml = serializePreset(preset);
  const row = neutralParser.parse(xml).MidiShortcutPreset.ShortcutManager.Shortcut;
  check(row['@_inputDeviceName'] === 'Replacement Controller' &&
    row.Subtarget?.['@_name'] === 'Example' && row.Subtarget?.['@_index'] === '0' &&
    row.ValueRange?.['@_min'] === '0' && row.ValueRange?.['@_max'] === '1',
    'editing the controller preserves synthetic Subtarget and ValueRange');
}

// --- paramNodeName must not be invented ------------------------------------

{
  const file = 'minimal.xml'; // contains shortcuts without paramNodeName
  const original = readFileSync(join(fixturesDir, file), 'utf8');
  const out = serializePreset(parsePreset(original));
  const before = (original.match(/paramNodeName=/g) ?? []).length;
  const after = (out.match(/paramNodeName=/g) ?? []).length;
  check(before === after, `paramNodeName count preserved (${file}: ${before})`,
    before !== after ? `${before} -> ${after} (empty paramNodeName="" must not be invented)` : '');
}

// --- synthetic add-shortcut flow --------------------------------------------

{
  const seedFile = files[0];
  const seed = parsePreset(readFileSync(join(fixturesDir, seedFile), 'utf8'));
  const synthetic = {
    uniqueId: '9999999999',
    paramNodeName: 'ParamEvent',
    behaviour: 1028,
    paths: [
      { name: 'InputPath', path: '/composition/synthetic/test', translationType: 2, allowedTranslationTypes: 7 },
      { name: 'OutputPath', path: '/composition/synthetic/test', translationType: 2, allowedTranslationTypes: 7 },
    ],
    rawInput: {
      keyRaw: encodeRawInputKey({ topByte: 1, deviceHash: 0n, data1: 42, status: 0x90 }).toString(),
      valueRaw: '0',
      numSteps: 128,
    },
    namedValues: [{ first: 'Off', second: '0' }, { first: 'On', second: '1' }],
  };
  const xml = serializePreset({ ...seed, shortcuts: [synthetic, ...seed.shortcuts] });
  const found = parsePreset(xml).shortcuts.find(s => s.uniqueId === synthetic.uniqueId);
  check(
    !!found
      && found.rawInput?.keyRaw === synthetic.rawInput.keyRaw
      && found.rawInput?.valueRaw === '0'
      && found.paths.find(p => p.name === 'InputPath')?.path === '/composition/synthetic/test',
    'add-shortcut synthetic (uniqueId, keyRaw, value, InputPath survive round-trip)',
  );
}

// --- escaping: XML metacharacters in attribute values ------------------------

{
  const seed = parsePreset(readFileSync(join(fixturesDir, files[0]), 'utf8'));
  seed.name = 'Drums & "Bass" <live>';
  const reparsed = parsePreset(serializePreset(seed));
  check(reparsed.name === 'Drums & "Bass" <live>', 'attribute escaping round-trip (& " < >)');
}

// --- key codec edge cases ----------------------------------------------------

{
  check(tryDecodeRawInputKey('12abc') === null, 'tryDecodeRawInputKey returns null on garbage');
  check(tryDecodeRawInputKey('144115188075856304') !== null, 'tryDecodeRawInputKey decodes a real key');
  let threw = false;
  let desc = '';
  try { desc = describeKey('not-a-number'); } catch { threw = true; }
  check(!threw && desc.startsWith('invalid key'), 'describeKey degrades gracefully on garbage');
}

// --- top byte family mapping (from fixture corpus: note->1, cc->2) -----------

{
  check(topByteForStatus(0x90, 7) === 1 && topByteForStatus(0x83, 7) === 1, 'topByteForStatus: note family -> 0x01');
  check(topByteForStatus(0xB5, 7) === 2, 'topByteForStatus: cc family -> 0x02');
  check(topByteForStatus(0xE0, 7) === 7, 'topByteForStatus: unobserved family keeps fallback');
}

// --- MIDI byte reconstruction (Learn path) ------------------------------------

{
  // easymidi pitch value is UNSIGNED 0..16383 (center 8192).
  const center = toRawBytes('pitch', { value: 8192, channel: 0 });
  const min = toRawBytes('pitch', { value: 0, channel: 0 });
  const max = toRawBytes('pitch', { value: 16383, channel: 2 });
  check(center[0] === 0xE0 && center[1] === 0x00 && center[2] === 0x40,
    'pitch center 8192 -> E0 00 40', `got ${center.map(b => b.toString(16)).join(' ')}`);
  check(min[1] === 0x00 && min[2] === 0x00, 'pitch min 0 -> 00 00');
  check(max[0] === 0xE2 && max[1] === 0x7F && max[2] === 0x7F, 'pitch max 16383 ch3 -> E2 7F 7F');
  const note = toRawBytes('noteon', { note: 60, velocity: 100, channel: 1 });
  check(note[0] === 0x91 && note[1] === 60 && note[2] === 100, 'noteon ch2 note60 vel100 -> 91 3C 64');
  const cc = toRawBytes('cc', { controller: 7, value: 127, channel: 15 });
  check(cc[0] === 0xBF && cc[1] === 7 && cc[2] === 127, 'cc ch16 #7 val127 -> BF 07 7F');
}

console.log();
if (failures === 0) {
  console.log('OK  all checks passed.');
  process.exit(0);
} else {
  console.log(`FAIL  ${failures} checks failed.`);
  process.exit(1);
}
