import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeFileAtomic, createPresetSaver } = require('../electron/atomic-file.cjs');

test('atomic save replaces a complete file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolume-atomic-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'preset.xml');
  await fs.writeFile(target, 'old', 'utf8');

  await writeFileAtomic(target, 'new-complete', { nonce: 'success' });

  assert.equal(await fs.readFile(target, 'utf8'), 'new-complete');
});

test('rename failure preserves the old preset instead of directly truncating it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolume-atomic-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'preset.xml');
  await fs.writeFile(target, 'known-good-old-preset', 'utf8');
  const blockedFs = {
    ...fs,
    async rename() {
      const err = new Error('target held open');
      err.code = 'EPERM';
      throw err;
    },
  };

  await assert.rejects(
    writeFileAtomic(target, 'replacement', { fsImpl: blockedFs, nonce: 'blocked' }),
    { code: 'EPERM' },
  );

  assert.equal(await fs.readFile(target, 'utf8'), 'known-good-old-preset');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['preset.xml']);
});

test('staging write failure preserves the old preset and removes the temp file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolume-atomic-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'preset.xml');
  await fs.writeFile(target, 'known-good-old-preset', 'utf8');
  const failingFs = {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      return {
        async writeFile() { throw new Error('simulated disk full'); },
        sync: handle.sync.bind(handle),
        close: handle.close.bind(handle),
      };
    },
  };

  await assert.rejects(
    writeFileAtomic(target, 'replacement', { fsImpl: failingFs, nonce: 'write-failed' }),
    /simulated disk full/,
  );

  assert.equal(await fs.readFile(target, 'utf8'), 'known-good-old-preset');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['preset.xml']);
});

test('overlapping saves keep the original backup and write in order', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolume-backup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'preset.xml');
  await fs.writeFile(target, 'original');
  const save = createPresetSaver();
  await Promise.all([save(target, 'first'), save(target, 'last')]);
  assert.equal(await fs.readFile(target + '.bak', 'utf8'), 'original');
  assert.equal(await fs.readFile(target, 'utf8'), 'last');
});

test('a failed backup preserves the preset and previous backup and permits retry', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolume-backup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'preset.xml');
  await fs.writeFile(target, 'original');
  await fs.writeFile(target + '.bak', 'previous backup');
  let fail = true;
  const save = createPresetSaver({
    ...fs,
    async rename(from, to) {
      if (fail && to === target + '.bak') throw new Error('backup failed');
      return fs.rename(from, to);
    },
  });
  await assert.rejects(save(target, 'edited'), /backup failed/);
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
  assert.equal(await fs.readFile(target + '.bak', 'utf8'), 'previous backup');
  fail = false;
  await save(target, 'edited');
  assert.equal(await fs.readFile(target, 'utf8'), 'edited');
  assert.equal(await fs.readFile(target + '.bak', 'utf8'), 'original');
});
