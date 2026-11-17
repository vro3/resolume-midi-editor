// Typed model of a Resolume Arena MIDI shortcut preset (.xml).
// Updated: 2026-06-09 v1.1 (audit) — _extraChildren now carries real parser
// nodes (Subtarget, ValueRange, …); paramNodeName optional to match files
// that omit it.
//
// The shape mirrors the XML closely so the parser can walk it directly. We
// preserve unknown fields under `_extra` (attributes) and `_extraChildren`
// (child elements) so future Resolume versions don't strip data on round-trip.

export interface ResolumeVersionInfo {
  name: string;
  majorVersion: number;
  minorVersion: number;
  microVersion?: number;
  revision?: number;
  _extra?: Record<string, string>;
}

export interface ResolumeShortcutPath {
  // <ShortcutPath name="InputPath" path="..." translationType="2" allowedTranslationTypes="7"/>
  name: 'InputPath' | 'OutputPath' | 'InputSiblingPath' | string;
  path: string;
  translationType?: number;
  allowedTranslationTypes?: number;
  _extra?: Record<string, string>;
}

export interface ResolumeNamedValue {
  first: string;
  second: string; // value is stored as string in XML even for ints
}

// The 64-bit `key` is preserved as a string for fidelity (BigInt in JSON
// doesn't survive serialization in some toolchains) and decoded on demand.
export interface ResolumeRawInputMessage {
  keyRaw: string;        // exact original digits — used for byte-equivalent round-trip
  // Verbatim string: Resolume stores the last captured control value here as
  // a 20-digit fixed-point float (e.g. "0.13385826771653544509"); routing it
  // through Number would reformat and lose precision.
  valueRaw: string;
  numSteps?: number;
  _extra?: Record<string, string>;
}

export interface ResolumeShortcut {
  // Optional: Resolume's controller-template presets (e.g. APC MINI) carry
  // NO uniqueId on any shortcut. We must not invent one on save, and the UI
  // must not key row identity on it — that's what _rowId is for.
  uniqueId?: string;
  // Editor-local row identity, assigned on load and never serialized. Always
  // present and unique within a loaded preset; survives duplicate or missing
  // uniqueIds in the file.
  _rowId?: string;
  // Optional: older presets omit it entirely — we must not invent an empty
  // one on save (Resolume's reaction to paramNodeName="" is untested).
  paramNodeName?: string; // 'ParamEvent' | 'ParamRange' | 'ParamChoice[Color]' | 'RangedParam[bool]' | 'ParamTrigger' | ...
  behaviour: number;
  inputDeviceName?: string;
  outputDeviceName?: string;
  paths: ResolumeShortcutPath[];
  rawInput?: ResolumeRawInputMessage;
  // [] means an empty <NamedValues/> element was present (preserved as-is);
  // undefined means the element was absent.
  namedValues?: ResolumeNamedValue[];
  _extra?: Record<string, string>;       // unknown attrs on <Shortcut>
  // Unknown child elements keyed by tag name, raw parser nodes preserved
  // verbatim (e.g. <Subtarget>, <ValueRange> — both occur in real presets and
  // change binding behaviour; dropping them corrupts the preset).
  _extraChildren?: Record<string, unknown>;
}

export interface ResolumePreset {
  name: string;
  presetId: string;
  versionInfo?: ResolumeVersionInfo;
  shortcutManagerName: string;           // typically "MIDIShortcutManagerShortcuts"
  shortcuts: ResolumeShortcut[];
  _extra?: Record<string, string>;       // unknown attrs on <MidiShortcutPreset>
  _extraChildren?: Record<string, unknown>;        // unknown top-level children
  _managerExtraChildren?: Record<string, unknown>; // unknown <ShortcutManager> children
}

// (BehaviourFlags removed 2026-06-09: it was unused and disagreed with
// BehaviourBit in behaviour.ts — e.g. Scrubber 2113544 there is a combined
// value, not a bit. behaviour.ts is the single source of truth.)
