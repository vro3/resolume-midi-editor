// Read and write Resolume Arena MIDI shortcut preset .xml files.
// Updated: 2026-06-09 v1.1 (audit) — unknown child elements (<Subtarget>,
// <ValueRange>, anything Resolume adds later) are now preserved verbatim on
// round-trip; previously they were silently dropped on save, which changed
// binding behaviour in Resolume (e.g. a range-limited fader went full-range).
// Also: paramNodeName is no longer invented as "" for presets that omit it,
// and malformed numeric attributes can no longer serialize as "NaN".
//
// We use fast-xml-parser in attribute-mode and reconstruct only the fields
// we care about. Anything we don't recognize is captured under `_extra` /
// `_extraChildren` so a parse-then-serialize round-trip stays semantically
// equivalent for fields the editor doesn't expose.

import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import type {
  ResolumePreset,
  ResolumeShortcut,
  ResolumeShortcutPath,
  ResolumeRawInputMessage,
  ResolumeNamedValue,
  ResolumeVersionInfo,
} from './types';

const ATTR_PREFIX = '@_';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  parseAttributeValue: false, // keep all attrs as strings — preserves bigints, booleans, etc.
  preserveOrder: false,
  allowBooleanAttributes: true,
  trimValues: false,
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  format: true,
  indentBy: '\t',
  suppressEmptyNode: true,
  preserveOrder: false,
});

const KNOWN_PATH_ATTRS = new Set(['name', 'path', 'translationType', 'allowedTranslationTypes']);
const KNOWN_RAW_ATTRS = new Set(['name', 'key', 'value', 'numSteps']);
const KNOWN_SHORTCUT_ATTRS = new Set([
  'name', 'uniqueId', 'paramNodeName', 'behaviour', 'inputDeviceName', 'outputDeviceName',
]);
const KNOWN_PRESET_ATTRS = new Set(['name', 'presetId']);
const KNOWN_VERSION_ATTRS = new Set([
  'name', 'majorVersion', 'minorVersion', 'microVersion', 'revision',
]);

const KNOWN_SHORTCUT_CHILDREN = new Set(['ShortcutPath', 'RawInputMessage', 'NamedValues']);
const KNOWN_PRESET_CHILDREN = new Set(['versionInfo', 'ShortcutManager']);
const KNOWN_MANAGER_CHILDREN = new Set(['Shortcut']);

function asArray<T>(x: T | T[] | undefined): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function extractExtraAttrs(node: Record<string, unknown>, known: Set<string>): Record<string, string> | undefined {
  const extra: Record<string, string> = {};
  for (const k of Object.keys(node)) {
    if (!k.startsWith(ATTR_PREFIX)) continue;
    const name = k.slice(ATTR_PREFIX.length);
    if (known.has(name)) continue;
    extra[name] = String(node[k]);
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

// Capture child elements the editor doesn't model, verbatim. The parser node
// is reattached as-is on serialize, so attributes (kept as strings) and any
// nesting survive untouched. `#text` keys (inter-element whitespace from
// trimValues:false) are formatting, not data — skipped.
function extractExtraChildren(node: Record<string, unknown>, known: Set<string>): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(node)) {
    if (k.startsWith(ATTR_PREFIX)) continue;
    if (k === '#text') continue;
    if (known.has(k)) continue;
    extra[k] = node[k];
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function attr(node: Record<string, unknown>, name: string): string | undefined {
  const v = node[ATTR_PREFIX + name];
  return v == null ? undefined : String(v);
}

function attrInt(node: Record<string, unknown>, name: string): number | undefined {
  const v = attr(node, name);
  if (v == null) return undefined;
  const n = Number(v);
  // A malformed attribute must not become the string "NaN" on re-serialize —
  // treat it as absent instead.
  return Number.isFinite(n) ? n : undefined;
}

function parseVersionInfo(node: Record<string, unknown> | undefined): ResolumeVersionInfo | undefined {
  if (!node) return undefined;
  return {
    name: attr(node, 'name') ?? '',
    majorVersion: attrInt(node, 'majorVersion') ?? 0,
    minorVersion: attrInt(node, 'minorVersion') ?? 0,
    microVersion: attrInt(node, 'microVersion'),
    revision: attrInt(node, 'revision'),
    _extra: extractExtraAttrs(node, KNOWN_VERSION_ATTRS),
  };
}

function parsePath(node: Record<string, unknown>): ResolumeShortcutPath {
  return {
    name: attr(node, 'name') ?? '',
    path: attr(node, 'path') ?? '',
    translationType: attrInt(node, 'translationType'),
    allowedTranslationTypes: attrInt(node, 'allowedTranslationTypes'),
    _extra: extractExtraAttrs(node, KNOWN_PATH_ATTRS),
  };
}

function parseRawInput(node: Record<string, unknown>): ResolumeRawInputMessage {
  return {
    keyRaw: attr(node, 'key') ?? '0',
    // Verbatim: Resolume writes 20-digit fixed-point floats here.
    valueRaw: attr(node, 'value') ?? '0',
    numSteps: attrInt(node, 'numSteps'),
    _extra: extractExtraAttrs(node, KNOWN_RAW_ATTRS),
  };
}

// `node` can be a Record (has Value children), or '' — fast-xml-parser
// parses an empty <NamedValues/> as the empty string. Empty must round-trip
// as an empty element, not vanish.
function parseNamedValues(node: unknown): ResolumeNamedValue[] | undefined {
  if (node == null) return undefined;
  if (typeof node !== 'object') return [];
  const values = asArray((node as Record<string, unknown>).Value as Record<string, unknown> | Record<string, unknown>[]);
  return values.map(v => ({
    first: attr(v, 'first') ?? '',
    second: attr(v, 'second') ?? '',
  }));
}

function parseShortcut(node: Record<string, unknown>): ResolumeShortcut {
  const paths = asArray(node.ShortcutPath as Record<string, unknown> | Record<string, unknown>[]).map(parsePath);
  const rawInput = node.RawInputMessage
    ? parseRawInput(node.RawInputMessage as Record<string, unknown>)
    : undefined;
  const namedValues = parseNamedValues(node.NamedValues);

  return {
    uniqueId: attr(node, 'uniqueId'),
    paramNodeName: attr(node, 'paramNodeName'),
    behaviour: attrInt(node, 'behaviour') ?? 0,
    inputDeviceName: attr(node, 'inputDeviceName'),
    outputDeviceName: attr(node, 'outputDeviceName'),
    paths,
    rawInput,
    namedValues,
    _extra: extractExtraAttrs(node, KNOWN_SHORTCUT_ATTRS),
    _extraChildren: extractExtraChildren(node, KNOWN_SHORTCUT_CHILDREN),
  };
}

export function parsePreset(xml: string): ResolumePreset {
  const tree = parser.parse(xml) as Record<string, unknown>;
  const presetNode = tree.MidiShortcutPreset as Record<string, unknown> | undefined;
  if (!presetNode) {
    throw new Error('Not a Resolume MIDI shortcut preset (missing <MidiShortcutPreset>)');
  }

  const versionInfo = parseVersionInfo(presetNode.versionInfo as Record<string, unknown> | undefined);
  const managerNode = presetNode.ShortcutManager as Record<string, unknown> | undefined;
  const shortcutManagerName = managerNode ? (attr(managerNode, 'name') ?? '') : '';
  const shortcutNodes = asArray(managerNode?.Shortcut as Record<string, unknown> | Record<string, unknown>[]);

  return {
    name: attr(presetNode, 'name') ?? '',
    presetId: attr(presetNode, 'presetId') ?? '',
    versionInfo,
    shortcutManagerName,
    shortcuts: shortcutNodes.map(parseShortcut),
    _extra: extractExtraAttrs(presetNode, KNOWN_PRESET_ATTRS),
    _extraChildren: extractExtraChildren(presetNode, KNOWN_PRESET_CHILDREN),
    _managerExtraChildren: managerNode ? extractExtraChildren(managerNode, KNOWN_MANAGER_CHILDREN) : undefined,
  };
}

// --- serialization -------------------------------------------------------

function withExtra(obj: Record<string, unknown>, extra?: Record<string, string>): Record<string, unknown> {
  if (!extra) return obj;
  for (const [k, v] of Object.entries(extra)) {
    obj[ATTR_PREFIX + k] = v;
  }
  return obj;
}

function withExtraChildren(obj: Record<string, unknown>, extra?: Record<string, unknown>): Record<string, unknown> {
  if (!extra) return obj;
  for (const [tag, node] of Object.entries(extra)) {
    obj[tag] = node;
  }
  return obj;
}

function serializePath(p: ResolumeShortcutPath): Record<string, unknown> {
  const out: Record<string, unknown> = {
    [ATTR_PREFIX + 'name']: p.name,
    [ATTR_PREFIX + 'path']: p.path,
  };
  if (p.translationType != null) out[ATTR_PREFIX + 'translationType'] = String(p.translationType);
  if (p.allowedTranslationTypes != null) out[ATTR_PREFIX + 'allowedTranslationTypes'] = String(p.allowedTranslationTypes);
  return withExtra(out, p._extra);
}

function serializeRawInput(r: ResolumeRawInputMessage): Record<string, unknown> {
  // NOTE: Do NOT emit a `name` attribute. Resolume's own files never include
  // one on <RawInputMessage>, and adding it makes Resolume abort when it
  // tries to construct the binding (crash in MidiOutputShortcutManager).
  const out: Record<string, unknown> = {
    [ATTR_PREFIX + 'key']: r.keyRaw,
    [ATTR_PREFIX + 'value']: r.valueRaw,
  };
  if (r.numSteps != null) out[ATTR_PREFIX + 'numSteps'] = String(r.numSteps);
  return withExtra(out, r._extra);
}

function serializeShortcut(s: ResolumeShortcut): Record<string, unknown> {
  const out: Record<string, unknown> = {
    [ATTR_PREFIX + 'name']: 'Shortcut',
  };
  // Omit when absent — Resolume's controller-template presets have no
  // uniqueId, older presets no paramNodeName, and we must not invent empty
  // ones (Resolume's reaction to "" is untested).
  if (s.uniqueId != null) out[ATTR_PREFIX + 'uniqueId'] = s.uniqueId;
  if (s.paramNodeName != null) out[ATTR_PREFIX + 'paramNodeName'] = s.paramNodeName;
  out[ATTR_PREFIX + 'behaviour'] = String(s.behaviour);
  if (s.inputDeviceName != null) out[ATTR_PREFIX + 'inputDeviceName'] = s.inputDeviceName;
  if (s.outputDeviceName != null) out[ATTR_PREFIX + 'outputDeviceName'] = s.outputDeviceName;
  withExtra(out, s._extra);

  if (s.paths.length > 0) {
    out.ShortcutPath = s.paths.length === 1 ? serializePath(s.paths[0]) : s.paths.map(serializePath);
  }
  // Unknown children (Subtarget, ValueRange, …) go here — between the paths
  // and RawInputMessage, matching where Resolume writes them.
  withExtraChildren(out, s._extraChildren);
  if (s.rawInput) {
    out.RawInputMessage = serializeRawInput(s.rawInput);
  }
  if (s.namedValues) {
    // [] re-emits the empty <NamedValues/> element it came from.
    out.NamedValues = s.namedValues.length > 0
      ? {
          Value: s.namedValues.map(v => ({
            [ATTR_PREFIX + 'first']: v.first,
            [ATTR_PREFIX + 'second']: v.second,
          })),
        }
      : {};
  }
  return out;
}

export function serializePreset(preset: ResolumePreset): string {
  const presetNode: Record<string, unknown> = {
    [ATTR_PREFIX + 'name']: preset.name,
    [ATTR_PREFIX + 'presetId']: preset.presetId,
  };
  withExtra(presetNode, preset._extra);

  if (preset.versionInfo) {
    const v = preset.versionInfo;
    const vNode: Record<string, unknown> = {
      [ATTR_PREFIX + 'name']: v.name,
      [ATTR_PREFIX + 'majorVersion']: String(v.majorVersion),
      [ATTR_PREFIX + 'minorVersion']: String(v.minorVersion),
    };
    if (v.microVersion != null) vNode[ATTR_PREFIX + 'microVersion'] = String(v.microVersion);
    if (v.revision != null) vNode[ATTR_PREFIX + 'revision'] = String(v.revision);
    presetNode.versionInfo = withExtra(vNode, v._extra);
  }

  withExtraChildren(presetNode, preset._extraChildren);

  const shortcutNodes = preset.shortcuts.map(serializeShortcut);
  const managerNode: Record<string, unknown> = {
    [ATTR_PREFIX + 'name']: preset.shortcutManagerName,
    Shortcut: shortcutNodes.length === 1 ? shortcutNodes[0] : shortcutNodes,
  };
  withExtraChildren(managerNode, preset._managerExtraChildren);
  presetNode.ShortcutManager = managerNode;

  const tree: Record<string, unknown> = {
    '?xml': { [ATTR_PREFIX + 'version']: '1.0', [ATTR_PREFIX + 'encoding']: 'utf-8' },
    MidiShortcutPreset: presetNode,
  };

  // Resolume-written files end with a trailing blank line (\n\n). Matching it
  // makes an unedited round-trip byte-identical to Resolume's own output.
  return builder.build(tree).replace(/\n*$/, '\n\n');
}
