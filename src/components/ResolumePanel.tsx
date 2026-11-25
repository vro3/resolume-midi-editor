// Standalone Preset Editor for Resolume — main view of the app.
// Updated: 2026-06-09 v1.1 (audit) — type/learn edits keep the key's top
// byte in sync with the message family; learn no longer stores junk data1
// for pitch-bend/channel-pressure; corrupt keys degrade per-row instead of
// crashing the view; our own saves no longer bounce back through the
// folder watcher; Add Shortcut ids are collision-proof.
//
// Differences from the MidiBrain-embedded version:
// - Renders as the page itself, not as a modal overlay.
// - Uses `window.api` (this app's contextBridge) instead of `window.midi`.
// - Has a clerical "Label" column persisted to a sidecar JSON file alongside
//   the .xml — never written into the Resolume preset itself.
// - Recent-presets dropdown for fast switching between user files.
// - Hot-reload toast when chokidar sees the open preset change on disk
//   (i.e., the user just clicked Save in Resolume).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, Save, FilePlus2, Plus, Trash2, Target, RefreshCw, Files, AlertTriangle, HelpCircle, Undo2, Redo2 } from 'lucide-react';
import { parsePreset, serializePreset } from '../resolume/preset-io';
import {
  tryDecodeRawInputKey,
  encodeRawInputKey,
  statusToMessage,
  messageToStatus,
  topByteForStatus,
  describeKey,
  type MidiMessageType,
} from '../resolume/raw-input-key';
import { describeBehaviour, COMMON_BEHAVIOURS } from '../resolume/behaviour';
import { KNOWN_RESOLUME_PATHS } from '../resolume/known-paths';
import { emptySidecar, getLabel, setLabel, editorLabelKey as labelKeyOf, labelsForDisk } from '../resolume/sidecar';
import type { ResolumePreset, ResolumeShortcut } from '../resolume/types';
import type { SidecarData, PresetListEntry } from '../types/api';
import ControllerPicker from './ControllerPicker';

const MESSAGE_TYPES: MidiMessageType[] = [
  'noteOn', 'noteOff', 'cc', 'pitchBend', 'programChange', 'aftertouch', 'channelPressure',
];

// Param Node types observed in real Resolume presets. The paramNodeName MUST
// match the parameter type at the target path — `ParamEvent` for trigger
// buttons, `ParamRange` for sliders/faders, `RangedParam[bool]` for boolean
// toggles, `ParamChoice[*]` for dropdowns/color pickers. Mismatch = Resolume
// silently rejects the binding (or crashes on load).
const PARAM_NODE_OPTIONS = [
  'ParamEvent',
  'ParamRange',
  'ParamTrigger',
  'RangedParam[bool]',
  'ParamChoice[Color]',
] as const;

const SIDECAR_AUTOSAVE_MS = 500;

type SortableCol = 'type' | 'ch' | 'note' | 'behavior' | 'path';
const COL_DEFS: Array<{ key: string; label: string; defaultW: number; sort: SortableCol | null }> = [
  { key: 'label',    label: 'Label',        defaultW: 180, sort: null },
  { key: 'type',     label: 'Type',         defaultW: 100, sort: 'type' },
  { key: 'ch',       label: 'Ch',           defaultW: 56,  sort: 'ch' },
  { key: 'note',     label: 'Note/CC',      defaultW: 76,  sort: 'note' },
  { key: 'device',   label: 'Input Device', defaultW: 160, sort: null },
  { key: 'behavior', label: 'Behavior',     defaultW: 140, sort: 'behavior' },
  { key: 'param',    label: 'Param Node',   defaultW: 110, sort: null },
  { key: 'path',     label: 'Input Path',   defaultW: 240, sort: 'path' },
];

// Row identity for the UI. uniqueId is NOT reliable: Resolume's controller-
// template presets (e.g. APC MINI) have no uniqueId on any shortcut, and
// keying edits on it made one edit apply to every such row at once. _rowId
// is editor-local, assigned on load, never saved.
const rowIdOf = (s: ResolumeShortcut): string => s._rowId ?? s.uniqueId ?? '';

function mutateShortcutKey(s: ResolumeShortcut, patch: { type?: MidiMessageType; channel?: number; data1?: number }): ResolumeShortcut {
  if (!s.rawInput) return s;
  const decoded = tryDecodeRawInputKey(s.rawInput.keyRaw);
  if (!decoded) return s; // corrupt key — leave the row untouched rather than compounding
  const m = statusToMessage(decoded.status);
  const nextType = patch.type ?? m.type;
  const nextChannel = patch.channel ?? m.channel;
  // data1 is meaningless for channel-wide messages — store the canonical 0
  // instead of a stale note/CC number that would make the key never match.
  const channelWide = nextType === 'pitchBend' || nextType === 'channelPressure';
  const rawData1 = patch.data1 ?? decoded.data1;
  const nextData1 = channelWide ? 0 : Math.max(0, Math.min(127, Math.round(rawData1) || 0));
  const nextStatus = messageToStatus(nextType, nextChannel);
  const nextKey = encodeRawInputKey({
    // Keep the family byte consistent with the new status — Resolume never
    // writes e.g. a note-family top byte with a CC status.
    topByte: topByteForStatus(nextStatus, decoded.topByte),
    deviceHash: decoded.deviceHash,
    data1: nextData1,
    status: nextStatus,
  });
  return {
    ...s,
    rawInput: { ...s.rawInput, keyRaw: nextKey.toString() },
  };
}

export default function ResolumePanel() {
  const [preset, setPreset] = useState<ResolumePreset | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedInput, setSelectedInput] = useState<string | null>(null);
  const [recentPresets, setRecentPresets] = useState<PresetListEntry[]>([]);
  const [reloadAvailable, setReloadAvailable] = useState<{ path: string } | null>(null);
  const [savedHint, setSavedHint] = useState(false);
  const [firstSaveHint, setFirstSaveHint] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [recentlyAdded, setRecentlyAdded] = useState<Set<string>>(() => new Set());
  const [sidecar, setSidecar] = useState<SidecarData>(() => emptySidecar());
  const [undoHint, setUndoHint] = useState<'undo' | 'redo' | null>(null);

  // MIDI Learn target — captures the next incoming MIDI message into the row's
  // keyRaw. One-shot. Used when the user wants to add/edit a row offline
  // (Resolume isn't running, or they want to capture a controller message
  // without binding it in Resolume). For the common case of "map in Resolume,
  // see it appear here," the file-watcher does the work — no Learn click needed.
  const [learnTargetId, setLearnTargetId] = useState<string | null>(null);
  const learnTargetRef = useRef<string | null>(null);
  useEffect(() => { learnTargetRef.current = learnTargetId; }, [learnTargetId]);

  // Multi-row selection for bulk actions (Resolume's UI doesn't multi-select;
  // ours does). Holds shortcut uniqueIds.
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(() => new Set());
  const [sortCol, setSortCol] = useState<SortableCol | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [colWidths, setColWidths] = useState<Record<string, number>>(
    () => Object.fromEntries(COL_DEFS.map(c => [c.key, c.defaultW]))
  );
  const resizingRef = useRef<{ key: string; startX: number; startW: number } | null>(null);

  // Live list of MIDI inputs detected by the engine — populates the per-row
  // and bulk Input device dropdowns alongside whatever names are already
  // referenced in the loaded preset.
  const [detectedInputs, setDetectedInputs] = useState<string[]>([]);
  const [polling, setPolling] = useState(false);
  const pollInFlight = useRef(false);
  const refreshInputs = useCallback(async () => {
    if (!window.api || pollInFlight.current) return;
    pollInFlight.current = true;
    setPolling(true);
    try {
      const list = await window.api.listMidiInputs();
      setDetectedInputs(list);
      setSelectedInput(current => current && list.includes(current) ? current : list.length === 1 ? list[0] : null);
    } catch (err) {
      setError(String(err));
    } finally {
      pollInFlight.current = false;
      setPolling(false);
    }
  }, []);
  useEffect(() => {
    refreshInputs();
    const interval = window.setInterval(refreshInputs, 3000);
    window.addEventListener('focus', refreshInputs);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshInputs);
    };
  }, [refreshInputs]);

  const filePathRef = useRef<string | null>(null);
  useEffect(() => { filePathRef.current = filePath; }, [filePath]);

  const presetRef = useRef<ResolumePreset | null>(null);
  useEffect(() => { presetRef.current = preset; }, [preset]);

  const operationPending = useRef(false);
  const [fileBusy, setFileBusy] = useState(false);
  const sidecarDirtyRef = useRef(false);
  const runFileOperation = useCallback(async (operation: () => Promise<void>) => {
    if (operationPending.current) return;
    operationPending.current = true;
    setFileBusy(true);
    try {
      await operation();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      operationPending.current = false;
      setFileBusy(false);
    }
  }, []);
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
    // Mirror to main so window close / Cmd+Q can prompt (beforeunload alone
    // can't cover app quit, and Electron blocks cancelled closes silently).
    window.api?.setDirty(dirty || sidecarDirtyRef.current);
  }, [dirty]);

  // Prevent closing the window with unsaved edits. Reads dirtyRef (not dirty
  // state) so this handler is registered once and never goes stale.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current || sidecarDirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const knownIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    knownIdsRef.current = new Set(
      (preset?.shortcuts ?? []).map((s) => s.uniqueId).filter((id): id is string => id != null),
    );
  }, [preset]);

  useEffect(() => {
    for (const row of preset?.shortcuts ?? []) knownLabelRows.current.set(rowIdOf(row), row);
    const ids = new Set(preset?.shortcuts.map(rowIdOf));
    setSelectedRowIds(current => [...current].every(id => ids.has(id)) ? current : new Set([...current].filter(id => ids.has(id))));
    setLearnTargetId(current => current && ids.has(current) ? current : null);
  }, [preset]);

  // --- Recent presets list (from the default Resolume folder) ---

  const refreshRecent = useCallback(async () => {
    if (!window.api) return;
    const listing = await window.api.listPresets();
    setRecentPresets(listing.presets);
  }, []);

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  // --- Sidecar autosave (debounced) ---

  // Label edits don't set the XML dirty flag (labels never touch the preset),
  // so they need their own dirty tracking: a watcher auto-reload or a file
  // switch inside the 500ms debounce window would otherwise silently discard
  // a just-typed label. Any transition away from the current file must flush
  // pending label edits to disk first (flushSidecar below).
  const sidecarRef = useRef(sidecar);
  useEffect(() => { sidecarRef.current = sidecar; }, [sidecar]);
  const markSidecarDirty = useCallback((value: boolean) => {
    sidecarDirtyRef.current = value;
    window.api?.setDirty(value || dirtyRef.current);
  }, []);

  const sidecarSaveTimer = useRef<number | null>(null);
  const knownLabelRows = useRef(new Map<string, ResolumeShortcut>());
  const diskRows = useRef<ResolumeShortcut[]>([]);
  const lastWritten = useRef<SidecarData | null>(null);
  const writes = useRef(Promise.resolve());
  const persist = useCallback((path: string, data: SidecarData, newPath = false) => {
    const next = writes.current.then(async () => {
      const previous = newPath ? await window.api!.readSidecar(path) : lastWritten.current;
      const empty = !Object.keys(data.labels ?? {}).length && Object.keys(data).every(key => key === 'labels');
      if ((previous || !empty) && JSON.stringify(previous) !== JSON.stringify(data)) {
        if (!await window.api!.writeSidecar(path, data)) throw new Error('Could not save preset labels.');
      }
      lastWritten.current = data;
    });
    writes.current = next.catch(() => {});
    return next;
  }, []);
  const flushSidecar = useCallback(async () => {
    if (sidecarSaveTimer.current) window.clearTimeout(sidecarSaveTimer.current);
    while (sidecarDirtyRef.current && filePathRef.current) {
      const snap = sidecarRef.current;
      await persist(filePathRef.current, labelsForDisk(snap, knownLabelRows.current.values(), diskRows.current));
      if (sidecarRef.current === snap) markSidecarDirty(false);
    }
  }, [persist]);
  useEffect(() => {
    if (!filePath || !sidecarDirtyRef.current) return;
    sidecarSaveTimer.current = window.setTimeout(() => {
      flushSidecar().catch(err => setError(String(err)));
    }, SIDECAR_AUTOSAVE_MS);
    return () => { if (sidecarSaveTimer.current) window.clearTimeout(sidecarSaveTimer.current); };
  }, [sidecar, filePath, flushSidecar]);

  // --- Undo / redo (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z) ---

  // Snapshot stack over the two pieces of editable state that make up "the
  // preset as the user sees it": the shortcut rows (preset.shortcuts) and
  // the label sidecar. Both travel together in one snapshot so undoing a
  // Learn capture doesn't leave a label pointing at the wrong row, etc.
  type UndoSnapshot = { preset: ResolumePreset; sidecar: SidecarData };
  const UNDO_STACK_CAP = 100;
  const undoStackRef = useRef<UndoSnapshot[]>([]);
  const redoStackRef = useRef<UndoSnapshot[]>([]);
  // Rapid-fire edits (typing into the Label or Input Path text cells fire an
  // onChange per keystroke) are coalesced into a single undo step by
  // skipping pushes that land within this window of the previous one — the
  // first keystroke of a burst still gets its own "before" snapshot.
  const UNDO_COALESCE_MS = 350;
  const lastPushAtRef = useRef(0);

  const showUndoHint = useCallback((kind: 'undo' | 'redo') => {
    setUndoHint(kind);
    window.setTimeout(() => setUndoHint((cur) => (cur === kind ? null : cur)), 1200);
  }, []);

  const pushUndoSnapshot = useCallback(() => {
    if (!presetRef.current) return;
    // Any new edit invalidates whatever was available to redo.
    redoStackRef.current = [];
    const now = Date.now();
    if (now - lastPushAtRef.current < UNDO_COALESCE_MS) return;
    lastPushAtRef.current = now;
    undoStackRef.current.push({ preset: presetRef.current, sidecar: sidecarRef.current });
    if (undoStackRef.current.length > UNDO_STACK_CAP) undoStackRef.current.shift();
  }, []);

  const clearUndoHistory = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    lastPushAtRef.current = 0;
  }, []);

  const undo = useCallback(() => {
    if (operationPending.current || undoStackRef.current.length === 0 || !presetRef.current) return;
    const snap = undoStackRef.current.pop()!;
    redoStackRef.current.push({ preset: presetRef.current, sidecar: sidecarRef.current });
    if (redoStackRef.current.length > UNDO_STACK_CAP) redoStackRef.current.shift();
    setPreset(snap.preset);
    setSidecar(snap.sidecar);
    // Undoing edits from a previous save would ideally clear dirty when it
    // lands back on the last-saved snapshot; we don't track a "clean"
    // snapshot marker today, so we conservatively leave dirty=true rather
    // than risk under-reporting unsaved changes. See PR notes.
    setDirty(true);
    markSidecarDirty(true);
    showUndoHint('undo');
  }, [showUndoHint]);

  const redo = useCallback(() => {
    if (operationPending.current || redoStackRef.current.length === 0 || !presetRef.current) return;
    const snap = redoStackRef.current.pop()!;
    undoStackRef.current.push({ preset: presetRef.current, sidecar: sidecarRef.current });
    if (undoStackRef.current.length > UNDO_STACK_CAP) undoStackRef.current.shift();
    setPreset(snap.preset);
    setSidecar(snap.sidecar);
    setDirty(true);
    markSidecarDirty(true);
    showUndoHint('redo');
  }, [showUndoHint]);

  useEffect(() => window.api?.onMenuCommand((channel) => {
    if (channel !== 'menu:undo' && channel !== 'menu:redo') return;
    const command = channel === 'menu:undo' ? 'undo' : 'redo';
    const focused = document.activeElement;
    if (focused instanceof HTMLElement &&
        (focused.matches('input, textarea') || focused.isContentEditable)) {
      document.execCommand(command);
    } else if (command === 'undo') undo();
    else redo();
  }), [undo, redo]);

  // --- Open / Save / Save As ---

  const openFromResult = useCallback(async (result: { path: string; text: string } | null, opts?: { highlightNew?: boolean }) => {
    if (!result) return;
    // Flush any pending label edits to the OLD file's sidecar before the
    // React state transition — cancelling alone would silently drop a label
    // typed within the autosave debounce window.
    try {
      await flushSidecar();
      const parsed = parsePreset(result.text);
      // Editor-local row identity — see rowIdOf.
      parsed.shortcuts = parsed.shortcuts.map((s, i) => ({ ...s, _rowId: `r${i}` }));
      // Detect rows that didn't exist before this reload (Resolume just bound
      // them) so we can flash-highlight them briefly.
      if (opts?.highlightNew) {
        const before = knownIdsRef.current;
        const added = new Set<string>();
        for (const s of parsed.shortcuts) {
          if (s.uniqueId != null && !before.has(s.uniqueId)) added.add(s.uniqueId);
        }
        if (added.size > 0) {
          setRecentlyAdded(added);
          window.setTimeout(() => setRecentlyAdded(new Set()), 2500);
        }
      }
      // Read sidecar before touching filePath so the autosave effect never
      // sees (newFilePath + oldSidecar) and silently writes stale labels.
      const loaded = await window.api?.readSidecar(result.path);
      await flushSidecar();
      knownLabelRows.current.clear();
      diskRows.current = parsed.shortcuts;
      lastWritten.current = loaded ?? null;
      markSidecarDirty(false);
      setPreset(parsed);
      setSidecar(loaded ?? emptySidecar());
      setFilePath(result.path);
      setDirty(false);
      setError(null);
      setLearnTargetId(null);
      setSelectedRowIds(new Set());
      setReloadAvailable(null);
      // A fresh load (open/reload) is a new baseline — undo history from the
      // previous file (or previous version of this file) no longer applies.
      clearUndoHistory();
      refreshRecent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshRecent, flushSidecar, clearUndoHistory]);

  const confirmDiscard = useCallback((): boolean => {
    if (!dirtyRef.current) return true;
    return window.confirm('You have unsaved changes. Discard them and open a new preset?');
  }, []);

  const open = useCallback(async () => {
    if (!window.api) return;
    if (!confirmDiscard()) return;
    await runFileOperation(async () => openFromResult(await window.api!.openResolumeFile()));
  }, [openFromResult, confirmDiscard]);

  const openByPath = useCallback(async (path: string) => {
    if (!window.api) return;
    if (!confirmDiscard()) return;
    await runFileOperation(async () => openFromResult(await window.api!.openResolumePath(path)));
  }, [openFromResult, confirmDiscard]);

  // Resolume crashes on shortcuts with empty InputPaths (it strips the path
  // slots on load, then the binding has nothing to attach to and the
  // MidiOutputShortcutManager segfaults). We refuse to save any such rows —
  // either the user fills them in, drops them, or cancels.
  const brokenShortcuts = useMemo(() => {
    if (!preset) return [];
    return preset.shortcuts.filter((s) => {
      const ip = s.paths.find((p) => p.name === 'InputPath');
      return !ip || !ip.path || ip.path.trim().length === 0;
    });
  }, [preset]);

  // Our own saves change the watched file's mtime, so the watcher reports
  // them back to us ~0.5–1.5s later. Without suppression that round-trip
  // either silently reloads (clobbering a label typed right after save) or
  // shows a misleading "Resolume just saved this preset" banner.
  const selfSaveRef = useRef<{ path: string; at: number } | null>(null);
  const SELF_SAVE_SUPPRESS_MS = 2500;

  // One-shot: the first successful save of the session gets the fuller
  // "heads-up" banner (see README's cache gotcha); later saves in the same
  // session get the terser recurring banner instead of repeating it.
  const firstSaveShownRef = useRef(false);

  const save = useCallback(async (saveAs: boolean) => {
    if (!window.api || !preset) return;
    if (brokenShortcuts.length > 0) {
      const ok = confirm(
        `${brokenShortcuts.length} shortcut row(s) have empty Input Paths.\n\n` +
        `Resolume can crash on these. They will be dropped on save.\n\n` +
        `Save without them?`,
      );
      if (!ok) return;
    }
    await runFileOperation(async () => {
      const cleaned = brokenShortcuts.length > 0
        ? { ...preset, shortcuts: preset.shortcuts.filter((s) => !brokenShortcuts.includes(s)) }
        : preset;
      const xml = serializePreset(cleaned);
      const result = await window.api!.saveResolumeFile(saveAs ? null : filePath, xml);
      if (!result) return;
      selfSaveRef.current = { path: result.path, at: Date.now() };
      if (sidecarSaveTimer.current) window.clearTimeout(sidecarSaveTimer.current);
      if (result.path !== filePath) await flushSidecar();
      const snap = sidecarRef.current;
      const diskData = labelsForDisk(snap, knownLabelRows.current.values(), cleaned.shortcuts);
      diskRows.current = cleaned.shortcuts;
      filePathRef.current = result.path;
      setFilePath(result.path);
      if (brokenShortcuts.length) setPreset(cleaned);
      markSidecarDirty(true);
      await persist(result.path, diskData, result.path !== filePath);
      if (sidecarRef.current === snap) markSidecarDirty(false);
      setDirty(false);
      refreshRecent();
      // Resolume reads its shortcut presets into memory once and never
      // re-reads from disk. After saving, the user has to switch presets in
      // Resolume's dropdown and switch back to see the changes there. Surface
      // that reminder — the fuller wording once per session, a terser recall
      // on subsequent saves.
      if (!firstSaveShownRef.current) {
        firstSaveShownRef.current = true;
        setFirstSaveHint(true);
      } else {
        setSavedHint(true);
        window.setTimeout(() => setSavedHint(false), 8000);
      }
    });
  }, [preset, filePath, sidecar, refreshRecent, brokenShortcuts, persist, flushSidecar]);

  // --- Menu wiring (Cmd+O / Cmd+S / Cmd+Shift+S) ---

  // Imperative refs so the menu listener (mounted once) hits the latest closures.
  const opsRef = useRef<{ open: () => void; save: (saveAs: boolean) => void } | null>(null);
  opsRef.current = { open, save };

  useEffect(() => {
    const off = window.api?.onMenuCommand((channel) => {
      const ops = opsRef.current;
      if (!ops) return;
      if (channel === 'menu:open') ops.open();
      else if (channel === 'menu:save') ops.save(false);
      else if (channel === 'menu:save-as') ops.save(true);
    });
    return off;
  }, []);

  // --- File-watcher: hot-reload when Resolume saves the open preset ---

  useEffect(() => {
    const off = window.api?.onWatcherChange(async (evt) => {
      if (evt.kind === 'unlink') {
        refreshRecent();
        return;
      }
      // Refresh recent list on any change so the dropdown stays current.
      refreshRecent();
      // Only react to changes for the file the user has open.
      if (!filePathRef.current || evt.path !== filePathRef.current) return;
      // Ignore the echo of our own save — it isn't "Resolume just saved".
      const self = selfSaveRef.current;
      if (self && self.path === evt.path && Date.now() - self.at < SELF_SAVE_SUPPRESS_MS) return;
      // Auto-reload when there are no unsaved local edits — this is the
      // "map in Resolume → see it appear here" workflow. If the user has
      // dirty in-flight edits, fall back to the banner so we don't clobber
      // them.
      if (!dirtyRef.current && !operationPending.current) {
        // openFromResult flushes pending label edits before it re-reads the
        // sidecar, so a label typed just before Resolume's save survives.
        await runFileOperation(async () => openFromResult(await window.api!.openResolumePath(evt.path), { highlightNew: true }));
        return;
      }
      setReloadAvailable({ path: evt.path });
    });
    return off;
  }, [refreshRecent, openFromResult]);

  const acceptReload = useCallback(async () => {
    if (!reloadAvailable) return;
    // The banner only appears when there are dirty local edits (the clean
    // case auto-reloads), so reloading here always discards them — confirm.
    if (!window.confirm('Reloading will discard your unsaved changes. Reload anyway?')) return;
    await runFileOperation(async () => openFromResult(await window.api!.openResolumePath(reloadAvailable.path), { highlightNew: true }));
  }, [reloadAvailable, openFromResult]);

  // --- Per-row MIDI Learn (one-shot capture) ---

  useEffect(() => {
    const off = window.api?.onMidiMessage((payload) => {
      const targetId = learnTargetRef.current;
      if (operationPending.current || !targetId) return;
      const bytes = payload.rawBytes;
      if (!bytes || bytes.length < 1) return;
      const status = bytes[0];
      const data1 = bytes.length >= 2 ? bytes[1] : 0;
      learnTargetRef.current = null;
      pushUndoSnapshot();
      setPreset((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          shortcuts: prev.shortcuts.map((s) => {
            if (rowIdOf(s) !== targetId) return s;
            const decoded = (s.rawInput ? tryDecodeRawInputKey(s.rawInput.keyRaw) : null)
              ?? { topByte: 1, deviceHash: 0n, data1: 0, status: 0x90 };
            // Pitch bend / channel pressure carry no identity in their second
            // byte (it's the live value) — the binding's data1 is 0.
            const family = (status >> 4) & 0xf;
            const channelWide = family === 0xd || family === 0xe;
            const nextKey = encodeRawInputKey({
              topByte: topByteForStatus(status, decoded.topByte),
              deviceHash: decoded.deviceHash,
              data1: channelWide ? 0 : data1,
              status,
            });
            return {
              ...s,
              // Resolume’s device hash algorithm is unknown. Preserve the hash.
              inputDeviceName: payload.inputName?.trim() ? payload.inputName : s.inputDeviceName,
              rawInput: {
                keyRaw: nextKey.toString(),
                valueRaw: s.rawInput?.valueRaw ?? '0',
                numSteps: s.rawInput?.numSteps,
                _extra: s.rawInput?._extra,
              },
            };
          }),
        };
      });
      setDirty(true);
      setLearnTargetId(null);
    });
    return off;
  }, []);

  // --- Mutation helpers ---

  const updateShortcut = useCallback((id: string, mutate: (s: ResolumeShortcut) => ResolumeShortcut) => {
    pushUndoSnapshot();
    setPreset((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        shortcuts: prev.shortcuts.map((s) => (rowIdOf(s) === id ? mutate(s) : s)),
      };
    });
    setDirty(true);
  }, [pushUndoSnapshot]);

  const deleteShortcut = useCallback((id: string) => {
    pushUndoSnapshot();
    setPreset((prev) => {
      if (!prev) return prev;
      return { ...prev, shortcuts: prev.shortcuts.filter((s) => rowIdOf(s) !== id) };
    });
    setDirty(true);
  }, [pushUndoSnapshot]);

  // Like updateShortcut but fans the mutation out to every selected row when
  // the edited row is part of the current selection (bulk-edit via checkboxes).
  const updateSelected = useCallback((id: string, mutate: (s: ResolumeShortcut) => ResolumeShortcut) => {
    const applyToAll = selectedRowIds.has(id) && selectedRowIds.size > 1;
    pushUndoSnapshot();
    setPreset((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        shortcuts: prev.shortcuts.map((s) => {
          const rid = rowIdOf(s);
          return (applyToAll ? selectedRowIds.has(rid) : rid === id) ? mutate(s) : s;
        }),
      };
    });
    setDirty(true);
  }, [selectedRowIds, pushUndoSnapshot]);

  const startResize = useCallback((key: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startW = ((e.currentTarget as HTMLElement).parentElement as HTMLElement).offsetWidth;
    resizingRef.current = { key, startX: e.clientX, startW };
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const { key: k, startX, startW: sw } = resizingRef.current;
      setColWidths(prev => ({ ...prev, [k]: Math.max(50, sw + ev.clientX - startX) }));
    };
    const onUp = () => {
      resizingRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const addShortcut = useCallback(() => {
    pushUndoSnapshot();
    setPreset((prev) => {
      if (!prev) return prev;
      // Millisecond timestamps collide on rapid adds (and could collide with
      // an existing row); duplicated uniqueIds make every per-row edit apply
      // to all twins. Bump until free.
      const existing = new Set(prev.shortcuts.map((s) => s.uniqueId).filter((id): id is string => id != null));
      let idNum = Date.now();
      while (existing.has(String(idNum))) idNum++;
      const newShortcut: ResolumeShortcut = {
        uniqueId: String(idNum),
        _rowId: `new-${idNum}`,
        paramNodeName: 'ParamEvent',
        behaviour: 1028,
        paths: [
          { name: 'InputPath', path: '', translationType: 2, allowedTranslationTypes: 7 },
          { name: 'OutputPath', path: '', translationType: 2, allowedTranslationTypes: 7 },
        ],
        rawInput: {
          keyRaw: encodeRawInputKey({ topByte: 1, deviceHash: 0n, data1: 0, status: 0x90 }).toString(),
          valueRaw: '0',
          numSteps: 128,
        },
        namedValues: [
          { first: 'Off', second: '0' },
          { first: 'On', second: '1' },
        ],
      };
      return { ...prev, shortcuts: [newShortcut, ...prev.shortcuts] };
    });
    setDirty(true);
  }, [pushUndoSnapshot]);

  // --- Path autocomplete (baseline + preset-discovered) ---

  // Available Input device options for the per-row dropdown and the bulk-set
  // action. "Any device" is the sentinel — selecting it clears the
  // inputDeviceName attribute (Resolume's "any input device" semantic).
  const ANY_DEVICE_SENTINEL = '__any__';
  const inputDeviceOptions = useMemo(() => {
    const set = new Set<string>();
    if (preset) {
      for (const s of preset.shortcuts) {
        if (s.inputDeviceName) set.add(s.inputDeviceName);
      }
    }
    for (const name of detectedInputs) set.add(name);
    return Array.from(set).sort();
  }, [preset, detectedInputs]);

  const setInputDeviceOnShortcut = useCallback((s: ResolumeShortcut, value: string | null): ResolumeShortcut => {
    if (value === null || value === '') {
      const { inputDeviceName: _drop, ...rest } = s;
      return rest as ResolumeShortcut;
    }
    return { ...s, inputDeviceName: value };
  }, []);

  const bulkSetInputDevice = useCallback((value: string | null) => {
    if (selectedRowIds.size === 0) return;
    pushUndoSnapshot();
    setPreset((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        shortcuts: prev.shortcuts.map((s) =>
          selectedRowIds.has(rowIdOf(s)) ? setInputDeviceOnShortcut(s, value) : s,
        ),
      };
    });
    setDirty(true);
  }, [selectedRowIds, setInputDeviceOnShortcut, pushUndoSnapshot]);

  const pathSuggestions = useMemo(() => {
    const set = new Set<string>(KNOWN_RESOLUME_PATHS);
    if (preset) {
      for (const s of preset.shortcuts) {
        for (const p of s.paths) {
          if (p.path) set.add(p.path);
        }
      }
    }
    return Array.from(set).sort();
  }, [preset]);

  // --- Filter, including the clerical Label so users can search by their own naming ---

  const filtered = useMemo(() => {
    if (!preset) return [];
    const q = filter.trim().toLowerCase();
    const base = !q ? preset.shortcuts : preset.shortcuts.filter((s) => {
      const inputPath = s.paths.find(p => p.name === 'InputPath')?.path ?? '';
      const desc = s.rawInput ? describeKey(s.rawInput.keyRaw) : '';
      const label = getLabel(sidecar, labelKeyOf(s));
      return (
        label.toLowerCase().includes(q) ||
        inputPath.toLowerCase().includes(q) ||
        desc.toLowerCase().includes(q) ||
        (s.inputDeviceName ?? '').toLowerCase().includes(q) ||
        (s.outputDeviceName ?? '').toLowerCase().includes(q)
      );
    });
    if (!sortCol) return base;
    return [...base].sort((a, b) => {
      const aDec = a.rawInput ? tryDecodeRawInputKey(a.rawInput.keyRaw) : null;
      const bDec = b.rawInput ? tryDecodeRawInputKey(b.rawInput.keyRaw) : null;
      let av: string | number;
      let bv: string | number;
      switch (sortCol) {
        case 'type':    av = aDec ? statusToMessage(aDec.status).type : ''; bv = bDec ? statusToMessage(bDec.status).type : ''; break;
        case 'ch':      av = aDec ? (aDec.status & 0xF) + 1 : 0;            bv = bDec ? (bDec.status & 0xF) + 1 : 0;            break;
        case 'note':    av = aDec?.data1 ?? 0;                               bv = bDec?.data1 ?? 0;                               break;
        case 'behavior':av = a.behaviour ?? 0;                               bv = b.behaviour ?? 0;                               break;
        case 'path':    av = a.paths.find(p => p.name === 'InputPath')?.path ?? ''; bv = b.paths.find(p => p.name === 'InputPath')?.path ?? ''; break;
      }
      const dir = sortDir === 'asc' ? 1 : -1;
      return typeof av === 'string' ? dir * av.localeCompare(bv as string) : dir * (av - (bv as number));
    });
  }, [preset, filter, sidecar, labelKeyOf, sortCol, sortDir]);

  return (
    <div inert={fileBusy} aria-busy={fileBusy} className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-950 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-lg font-semibold text-zinc-100 whitespace-nowrap" title={`Version ${__APP_VERSION__}`}>
            Preset Editor for Resolume
            <span className="ml-2 text-[10px] font-normal text-zinc-500 align-middle">v{__APP_VERSION__}</span>
          </h1>
          {filePath && (
            <span className="text-xs text-zinc-500 truncate" title={filePath}>
              {filePath.split(/[\\/]/).pop()}
              {dirty && <span className="ml-1 text-amber-400">●</span>}
            </span>
          )}
          {undoHint && (
            <span className="flex items-center gap-1 text-[10px] text-cyan-400/90 animate-pulse">
              {undoHint === 'undo' ? <Undo2 size={11} /> : <Redo2 size={11} />}
              {undoHint === 'undo' ? 'Undone' : 'Redone'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setShowHelp(true)}
            className="flex items-center justify-center w-7 h-7 rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700"
            title="Help"
          >
            <HelpCircle size={14} />
          </button>
          <ControllerPicker inputs={detectedInputs} busy={polling} refresh={refreshInputs} selectedInput={selectedInput} onSelectInput={setSelectedInput} />
          <div className="w-px h-6 bg-zinc-800 mx-1" />
          {recentPresets.length > 0 && (
            <select
              value={filePath ?? ''}
              onChange={(e) => { if (e.target.value) openByPath(e.target.value); }}
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 max-w-[200px]"
              title="Recent presets in your Resolume Shortcuts folder"
            >
              <option value="">— Recent presets —</option>
              {recentPresets.map((p) => (
                <option key={p.path} value={p.path}>{p.name}</option>
              ))}
            </select>
          )}
          <button
            onClick={open}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700"
            title="Open a Resolume MIDI shortcut preset (.xml)"
          >
            <FileUp size={14} /> Open
          </button>
          <button
            onClick={() => save(false)}
            disabled={!preset || !filePath}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white disabled:bg-zinc-800 disabled:text-zinc-500 border border-cyan-500 disabled:border-zinc-700"
          >
            <Save size={14} /> Save
          </button>
          <button
            onClick={() => save(true)}
            disabled={!preset}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 disabled:text-zinc-500 border border-zinc-700"
          >
            <FilePlus2 size={14} /> Save As
          </button>
        </div>
      </header>

      {error && (
        <div className="px-4 py-2 text-sm bg-red-900/40 text-red-200 border-b border-red-700 flex-shrink-0">
          {error}
          <button className="ml-3 text-red-300 hover:text-white" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      {brokenShortcuts.length > 0 && (
        <div className="px-4 py-2 text-sm bg-red-900/40 text-red-100 border-b border-red-700 flex items-center gap-2 flex-shrink-0">
          <AlertTriangle size={14} className="flex-shrink-0" />
          <span>
            <strong>{brokenShortcuts.length}</strong> row{brokenShortcuts.length === 1 ? ' has' : 's have'} an empty Input Path.
            Resolume will crash on these — fill them in or they'll be dropped on save.
          </span>
        </div>
      )}
      {firstSaveHint && (
        <div className="px-4 py-2 text-xs bg-emerald-900/30 text-emerald-100 border-b border-emerald-700/50 flex items-center justify-between flex-shrink-0">
          <span>Saved. Heads-up: Resolume caches presets — re-select the preset in Resolume's Shortcuts menu to load your changes.</span>
          <button onClick={() => setFirstSaveHint(false)} className="text-emerald-300 hover:text-white">dismiss</button>
        </div>
      )}
      {savedHint && (
        <div className="px-4 py-2 text-xs bg-emerald-900/30 text-emerald-100 border-b border-emerald-700/50 flex items-center justify-between flex-shrink-0">
          <span>Saved. Resolume only re-reads shortcut presets when you switch them — pick a different preset in Resolume's dropdown and switch back to see your changes there.</span>
          <button onClick={() => setSavedHint(false)} className="text-emerald-300 hover:text-white">dismiss</button>
        </div>
      )}
      {reloadAvailable && (
        <div className="px-4 py-2 text-sm bg-amber-900/40 text-amber-100 border-b border-amber-700 flex items-center justify-between flex-shrink-0">
          <span>Resolume just saved this preset on disk. Reload to see the latest?</span>
          <div className="flex items-center gap-2">
            <button
              onClick={acceptReload}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-amber-500 text-black hover:bg-amber-400"
            >
              <RefreshCw size={12} /> Reload
            </button>
            <button onClick={() => setReloadAvailable(null)} className="text-amber-300 hover:text-white text-xs">dismiss</button>
          </div>
        </div>
      )}

      {!preset ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md">
            <Files size={48} className="mx-auto mb-4 text-zinc-700" />
            <p className="text-zinc-300 mb-1 text-lg font-medium">No preset loaded.</p>
            <p className="text-zinc-500 text-sm mb-6">
              Open one of your Resolume MIDI shortcut presets to get started.
            </p>
            <button
              onClick={open}
              className="flex items-center gap-2 mx-auto text-sm px-4 py-2 rounded bg-cyan-600 hover:bg-cyan-500 text-white border border-cyan-500"
            >
              <FileUp size={14} /> Open Preset
            </button>
            {recentPresets.length > 0 && (
              <div className="mt-6 text-left">
                <p className="text-[10px] uppercase tracking-widest text-zinc-600 mb-2">Recent</p>
                <div className="space-y-1">
                  {recentPresets.slice(0, 8).map((p) => (
                    <button
                      key={p.path}
                      onClick={() => openByPath(p.path)}
                      className="block w-full text-left px-3 py-1.5 rounded text-xs text-zinc-300 hover:bg-zinc-900 border border-zinc-900 hover:border-zinc-700"
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="mt-6 text-xs text-zinc-600">
              Resolume stores presets at<br/>
              <code className="text-zinc-500">~/Documents/Resolume Arena/Shortcuts/MIDI/*.xml</code>
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 bg-zinc-900/40 text-xs text-zinc-400 flex-shrink-0">
            <span>
              <span className="font-medium text-zinc-200">{preset.name}</span>
              <span className="ml-2 text-zinc-500">({preset.shortcuts.length} shortcuts)</span>
            </span>
            <button
              onClick={addShortcut}
              className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white border border-cyan-500"
            >
              <Plus size={12} /> Add Shortcut
            </button>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by label, path, or message…"
              className="px-2 py-1 bg-zinc-900 border border-zinc-700 rounded text-zinc-100 text-xs w-72"
            />
          </div>

          {selectedRowIds.size > 0 && (
            <div className="flex items-center gap-3 px-4 py-2 border-b border-cyan-700/40 bg-cyan-900/20 text-xs text-cyan-100 flex-shrink-0">
              <span><strong>{selectedRowIds.size}</strong> row{selectedRowIds.size === 1 ? '' : 's'} selected</span>
              <span className="text-cyan-300/70">Bulk set Input Device:</span>
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  const v = e.target.value === ANY_DEVICE_SENTINEL ? null : e.target.value;
                  bulkSetInputDevice(v);
                  setSelectedRowIds(new Set());
                }}
                className="bg-zinc-900 border border-cyan-700/40 rounded px-2 py-1 text-xs text-zinc-100"
              >
                <option value="">— pick a device —</option>
                <option value={ANY_DEVICE_SENTINEL}>Any device</option>
                {inputDeviceOptions.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <button
                onClick={() => setSelectedRowIds(new Set())}
                className="ml-auto px-2 py-1 rounded text-xs text-cyan-300 hover:text-white border border-cyan-700/40 hover:border-cyan-500"
              >
                Clear selection
              </button>
            </div>
          )}

          <div className="flex-1 overflow-auto">
            <table className="text-xs text-zinc-200" style={{ tableLayout: 'fixed' }}>
              <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800 z-10">
                <tr className="text-left text-zinc-400">
                  <th className="px-2 py-2" style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      title={selectedRowIds.size === filtered.length && filtered.length > 0 ? 'Clear selection' : 'Select all visible rows'}
                      checked={filtered.length > 0 && selectedRowIds.size === filtered.length}
                      ref={(el) => {
                        if (el) el.indeterminate = selectedRowIds.size > 0 && selectedRowIds.size < filtered.length;
                      }}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedRowIds(new Set(filtered.map((s) => rowIdOf(s))));
                        else setSelectedRowIds(new Set());
                      }}
                    />
                  </th>
                  {COL_DEFS.map(({ key, label, sort }) => {
                    const active = sort !== null && sortCol === sort;
                    return (
                      <th
                        key={key}
                        className={`px-3 py-2 font-medium relative select-none overflow-hidden ${sort ? 'cursor-pointer hover:text-zinc-200' : ''} ${active ? 'text-zinc-100' : ''}`}
                        style={{ width: colWidths[key] }}
                        onClick={sort ? () => { if (active) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortCol(sort); setSortDir('asc'); } } : undefined}
                      >
                        {label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                        <div
                          className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-zinc-500"
                          onMouseDown={(e) => startResize(key, e)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </th>
                    );
                  })}
                  <th className="px-3 py-2 font-medium" style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const rowId = rowIdOf(s);
                  const labelKey = labelKeyOf(s);
                  const decoded = s.rawInput ? tryDecodeRawInputKey(s.rawInput.keyRaw) : null;
                  const msg = decoded ? statusToMessage(decoded.status) : null;
                  const inputPath = s.paths.find(p => p.name === 'InputPath')?.path ?? '';
                  const label = getLabel(sidecar, labelKey);
                  const isBroken = inputPath.trim().length === 0;
                  const isNew = s.uniqueId != null && recentlyAdded.has(s.uniqueId);
                  const isSelected = selectedRowIds.has(rowId);
                  return (
                    <tr key={rowId} className={`border-b border-zinc-900 hover:bg-zinc-900/40 ${isSelected ? 'bg-cyan-950/30' : ''} ${isBroken ? 'bg-red-950/20' : ''} ${isNew ? 'animate-flash-emerald' : ''}`}>
                      <td className="px-2 py-1">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            setSelectedRowIds((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(rowId);
                              else next.delete(rowId);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td className="px-3 py-1">
                        <input
                          type="text"
                          value={label}
                          onChange={(e) => {
                            pushUndoSnapshot();
                            markSidecarDirty(true);
                            const next = setLabel(sidecarRef.current, labelKey, e.target.value);
                            sidecarRef.current = next;
                            setSidecar(next);
                          }}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-xs text-zinc-100 placeholder:text-zinc-700"
                          placeholder="(label)"
                          title="Clerical label — saved to a sidecar JSON, never written to the Resolume preset"
                        />
                      </td>
                      <td className="px-3 py-1">
                        {msg ? (
                          <select
                            value={msg.type}
                            onChange={(e) => updateSelected(rowId, (s2) => mutateShortcutKey(s2, { type: e.target.value as MidiMessageType }))}
                            className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-xs"
                          >
                            {MESSAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        ) : <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="px-3 py-1">
                        {msg ? (
                          <input
                            type="number" min={1} max={16} value={msg.channel}
                            onChange={(e) => updateSelected(rowId, (s2) => mutateShortcutKey(s2, { channel: Number(e.target.value) }))}
                            className="w-12 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-xs text-center"
                          />
                        ) : <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="px-3 py-1">
                        {decoded && msg && msg.type !== 'pitchBend' && msg.type !== 'channelPressure' ? (
                          <input
                            type="number" min={0} max={127} value={decoded.data1}
                            onChange={(e) => updateSelected(rowId, (s2) => mutateShortcutKey(s2, { data1: Number(e.target.value) }))}
                            className="w-16 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-xs text-center"
                          />
                        ) : <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="px-3 py-1">
                        <select
                          value={s.inputDeviceName ?? ANY_DEVICE_SENTINEL}
                          onChange={(e) => {
                            const v = e.target.value === ANY_DEVICE_SENTINEL ? null : e.target.value;
                            updateSelected(rowId, (s2) => setInputDeviceOnShortcut(s2, v));
                          }}
                          className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-xs max-w-[160px]"
                          title={s.inputDeviceName ?? 'Any device — no inputDeviceName written, accepts any controller'}
                        >
                          <option value={ANY_DEVICE_SENTINEL}>Any device</option>
                          {inputDeviceOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                          {s.inputDeviceName && !inputDeviceOptions.includes(s.inputDeviceName) && (
                            <option value={s.inputDeviceName}>{s.inputDeviceName}</option>
                          )}
                        </select>
                      </td>
                      <td className="px-3 py-1">
                        <select
                          value={COMMON_BEHAVIOURS.some(b => b.value === s.behaviour) ? String(s.behaviour) : 'custom'}
                          onChange={(e) => {
                            const v = e.target.value === 'custom' ? s.behaviour : Number(e.target.value);
                            updateSelected(rowId, (s2) => ({ ...s2, behaviour: v }));
                          }}
                          className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-xs"
                          title={describeBehaviour(s.behaviour) + ` (${s.behaviour})`}
                        >
                          {COMMON_BEHAVIOURS.map(b => (
                            <option key={b.value} value={b.value}>{b.label}</option>
                          ))}
                          {!COMMON_BEHAVIOURS.some(b => b.value === s.behaviour) && (
                            <option value="custom">{describeBehaviour(s.behaviour)}</option>
                          )}
                        </select>
                      </td>
                      <td className="px-3 py-1">
                        <select
                          value={s.paramNodeName != null && PARAM_NODE_OPTIONS.includes(s.paramNodeName as typeof PARAM_NODE_OPTIONS[number]) ? s.paramNodeName : '__custom__'}
                          onChange={(e) => {
                            if (e.target.value === '__custom__') return;
                            updateSelected(rowId, (s2) => ({ ...s2, paramNodeName: e.target.value }));
                          }}
                          className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[10px]"
                          title="Must match the parameter type at the target path. ParamEvent = trigger buttons, ParamRange = sliders/faders, RangedParam[bool] = boolean toggles."
                        >
                          {PARAM_NODE_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                          {(s.paramNodeName == null || !PARAM_NODE_OPTIONS.includes(s.paramNodeName as typeof PARAM_NODE_OPTIONS[number])) && (
                            <option value="__custom__">{s.paramNodeName ?? '(not set)'}</option>
                          )}
                        </select>
                      </td>
                      <td className="px-3 py-1">
                        <input
                          type="text"
                          list="resolume-paths"
                          value={inputPath}
                          onChange={(e) => {
                            const newPath = e.target.value;
                            updateSelected(rowId, (s2) => {
                              const hasInput = s2.paths.some((p) => p.name === 'InputPath');
                              const paths = hasInput
                                ? s2.paths.map((p) => p.name === 'InputPath' ? { ...p, path: newPath } : p)
                                : [...s2.paths, { name: 'InputPath', path: newPath, translationType: 2, allowedTranslationTypes: 7 }];
                              return { ...s2, paths };
                            });
                          }}
                          className={`w-full bg-zinc-900 border rounded px-2 py-0.5 text-[10px] font-mono text-zinc-300 ${isBroken ? 'border-red-600 placeholder:text-red-700' : 'border-zinc-700'}`}
                          placeholder={isBroken ? 'required — Resolume will crash without this' : '/composition/layers/1/video/opacity'}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setLearnTargetId(learnTargetId === rowId ? null : rowId)}
                            disabled={!selectedInput}
                            className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors ${learnTargetId === rowId ? 'bg-amber-500 text-black border-amber-400 animate-pulse' : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:border-amber-500/50 hover:text-amber-300 disabled:opacity-30 disabled:cursor-not-allowed'}`}
                            title={!selectedInput
                              ? 'Pick a controller in "Listen on:" first'
                              : learnTargetId === rowId
                                ? 'Listening… trigger a hardware control to capture the MIDI message into this row. Click to cancel.'
                                : 'MIDI Learn — capture the next MIDI message from your controller into this row.'}
                          >
                            <Target size={10} className="inline" />
                          </button>
                          <button
                            onClick={() => deleteShortcut(rowId)}
                            className="text-zinc-600 hover:text-red-400"
                            title="Delete shortcut"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <datalist id="resolume-paths">
            {pathSuggestions.map((p) => <option key={p} value={p} />)}
          </datalist>
        </>
      )}

      {showHelp && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="max-w-lg w-full bg-[#1a1c23] border border-zinc-800 rounded-2xl p-6 text-sm text-zinc-300"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-zinc-100">Help</h2>
              <button onClick={() => setShowHelp(false)} className="text-zinc-500 hover:text-zinc-200">✕</button>
            </div>
            <ul className="space-y-3 leading-relaxed">
              <li>
                <strong className="text-zinc-100">Resolume caches presets.</strong> After saving here, re-select
                the preset in Resolume's Shortcuts menu (pick a different one, then switch back) to load your
                changes — Resolume only reads shortcut presets from disk when you switch to them.
              </li>
              <li>
                <strong className="text-zinc-100">Backups.</strong> The first time a session overwrites a preset,
                the editor copies the original alongside it as <code className="text-zinc-400">&lt;filename&gt;.bak</code> in
                the same folder, before writing your changes.
              </li>
              <li>
                <strong className="text-zinc-100">Empty Input Paths.</strong> Resolume can crash on a shortcut with
                a blank Input Path. Saving with any such rows present asks for confirmation and drops them from
                the saved file rather than risk writing something Resolume can't load.
              </li>
              <li>
                <strong className="text-zinc-100">MIDI Learn.</strong> Pick your controller in "Listen on:", click
                the target icon on a row, then trigger the control on your hardware — the row's message type,
                channel, and note/CC update to match.
              </li>
              <li>
                <strong className="text-zinc-100">Undo / redo.</strong> Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z undo and
                redo edits to the table and labels (up to the last 100 changes). Text fields keep their own
                native undo while you're typing in them.
              </li>
              <li>
                <strong className="text-zinc-100">Error log.</strong> Unexpected errors are appended to
                {' '}<code className="text-zinc-400">error.log</code> in the app's data folder (macOS: <code className="text-zinc-400">~/Library/Application Support/Preset Editor for Resolume/error.log</code>;
                Windows: <code className="text-zinc-400">%APPDATA%\Preset Editor for Resolume\error.log</code>) —
                useful to attach if you file a bug report.
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
