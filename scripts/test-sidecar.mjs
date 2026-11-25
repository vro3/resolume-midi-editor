import assert from 'node:assert/strict';
import test from 'node:test';
import { labelsForDisk } from '../src/resolume/sidecar.ts';

test('template labels follow their original rows across prepend, deletion and undo', () => {
  const a = { _rowId: 'r0' }, b = { _rowId: 'r1' }, added = { uniqueId: '123', _rowId: 'new-123' };
  const all = [a, b, added];
  const data = { labels: { '#0': 'kick', '#1': 'snare', '123': 'new', other: 'unknown' }, version: 2 };
  assert.deepEqual(labelsForDisk(data, all, [a, b]), { labels: { '#0': 'kick', '#1': 'snare', other: 'unknown' }, version: 2 });
  assert.deepEqual(labelsForDisk(data, all, [added, b]), { labels: { '123': 'new', '#1': 'snare', other: 'unknown' }, version: 2 });
  assert.equal(labelsForDisk(data, all, [added, a, b]).labels['#2'], 'snare');
});
