// Runs on the disposable Windows installer CI runner.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');

async function main() {
  const folder = path.join(os.homedir(), 'Documents', 'Resolume Arena', 'Shortcuts', 'MIDI');
  await fs.mkdir(folder, { recursive: true });
  const name = 'CI-' + process.pid;
  const preset = path.join(folder, name + '.xml');
  const labels = path.join(folder, name + '.midibrain.json');
  const source = await fs.readFile(path.join(__dirname, '../test-fixtures/resolume/current.xml'), 'utf8');
  await fs.writeFile(preset, source, { flag: 'wx' });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-editor-profile-'));
  const app = await _electron.launch({ executablePath: process.env.EDITOR_TEST_EXE, args: ['--user-data-dir=' + profile] });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: name + '.xml', exact: true }).click();
    const type = page.locator('tbody tr select').first();
    assert.equal(await type.inputValue(), 'noteOn');
    await new Promise(resolve => setTimeout(resolve, 800));
    await assert.rejects(fs.access(labels), { code: 'ENOENT' });
    await type.selectOption('cc');
    await page.getByPlaceholder('(label)').fill('Windows edit');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('header span[title$=".xml"]')?.textContent?.includes('●') === false);
    assert.equal(await fs.readFile(preset + '.bak', 'utf8'), source);
    assert.equal(JSON.parse(await fs.readFile(labels, 'utf8')).labels['1'], 'Windows edit');
    assert.notEqual(await fs.readFile(preset, 'utf8'), source);
    await page.getByTitle('Recent presets in your Resolume Shortcuts folder').selectOption(preset);
    const midi = await page.evaluate(() => window.api.listMidiInputs());
    assert.ok(Array.isArray(midi));
    console.log('Installed editor opened the preset, edited the MIDI type, saved XML, preserved the original backup and wrote the label. MIDI enumeration returned', midi.length, 'inputs.');
  } finally {
    await app.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
