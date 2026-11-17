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

export function removeLabel(data: SidecarData | null, uniqueId: string): SidecarData {
  return setLabel(data, uniqueId, '');
}
