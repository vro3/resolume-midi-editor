const path = require('node:path');
const fs = require('node:fs/promises');

// Write-to-temp-then-rename so the target is either the old content or the
// complete new content. If replacement is blocked (for example Resolume holds
// the file open on Windows), fail the save and preserve the old file. A direct
// overwrite fallback would reintroduce the truncation hazard this helper exists
// to prevent.
async function writeFileAtomic(outPath, text, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const pid = options.pid ?? process.pid;
  const nonce = options.nonce ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.dirname(outPath);
  const tmp = path.join(dir, `.${path.basename(outPath)}.${pid}.${nonce}.tmp`);

  const handle = await fsImpl.open(tmp, 'wx');
  try {
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (err) {
    // A disk-full, sync, or close failure must not leave a stale staging file
    // that looks recoverable or consumes space indefinitely.
    await fsImpl.unlink(tmp).catch(() => {});
    throw err;
  }

  try {
    await fsImpl.rename(tmp, outPath);
  } catch (err) {
    await fsImpl.unlink(tmp).catch(() => {});
    throw err;
  }
}

module.exports = { writeFileAtomic };
