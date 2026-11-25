// Read/write the per-preset sidecar JSON that holds clerical Labels (and any
// future editor-only metadata). Lives next to the preset as
// `<presetname>.midibrain.json` so it's portable when users copy preset
// folders between machines.
//
// Schema is intentionally permissive — unknown fields survive a round-trip
// so we can add features later without breaking older sidecar files.

import type { SidecarData } from '../types/api';

const EMPTY: SidecarData = { labels: {} };

export function emptySidecar(): SidecarData {
  return { labels: {} };
}

export function getLabel(data: SidecarData | null, uniqueId: string): string {
  if (!data?.labels) return '';
  return data.labels[uniqueId] ?? '';
}

export function setLabel(data: SidecarData | null, uniqueId: string, label: string): SidecarData {
  const base = data ?? EMPTY;
  const labels = { ...(base.labels ?? {}) };
  if (label.trim().length === 0) {
    delete labels[uniqueId];
  } else {
    labels[uniqueId] = label;
  }
  return { ...base, labels };
}

// Loaded rows keep their original index as their editor-local identity. This
// lets labels follow edits and history while the on-disk layout can change.
type LabelRow = { uniqueId?: string; _rowId?: string };
export function editorLabelKey(row: LabelRow): string {
  return row.uniqueId ?? '#' + row._rowId!.slice(1);
}

export function labelsForDisk(data: SidecarData, original: Iterable<LabelRow>, target: LabelRow[]): SidecarData {
  const labels = { ...data.labels };
  for (const row of original) delete labels[editorLabelKey(row)];
  for (const [index, row] of target.entries()) {
    const key = editorLabelKey(row);
    const value = data.labels?.[key];
    if (value !== undefined) labels[row.uniqueId ?? `#${index}`] = value;
  }
  return { ...data, labels };
}
