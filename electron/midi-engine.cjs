// Slimmed MIDI engine for the standalone Preset Editor for Resolume.
// Updated: 2026-06-09 v1.1 (audit) — byte reconstruction moved to
// midi-bytes.cjs (and its pitch-bend math fixed there); this file keeps the
// device/subscription lifecycle only.
// We only need to *listen* — no outputs, no virtual ports, no sendRaw.
// The editor uses incoming MIDI exclusively to power per-row Learn capture.

// The native `midi` binding under easymidi can fail to load in a packaged
// build (ABI mismatch, asar unpack issue). Degrade to "no MIDI inputs" so
// the app still opens and file editing works — a windowless startup crash
// would look like the app is simply broken.
let easymidi = null;
try {
  easymidi = require('easymidi');
} catch (err) {
  console.error('[midi-engine] easymidi failed to load — MIDI Learn disabled', err);
}
const { toRawBytes } = require('./midi-bytes.cjs');

const SUBSCRIBED_EVENTS = [
  'noteon',
  'noteoff',
  'cc',
  'program',
  'pitch',
  'poly aftertouch',
  'channel aftertouch',
];

const state = {
  inputs: new Map(), // name -> easymidi.Input
  onMessage: null,
};

function listInputs() {
  if (!easymidi) return [];
  try {
    return easymidi.getInputs();
  } catch {
    return [];
  }
}

function openInput(name) {
  if (!easymidi) return false;
  if (state.inputs.has(name)) return true;
  try {
    const input = new easymidi.Input(name);
    for (const ev of SUBSCRIBED_EVENTS) {
      input.on(ev, (msg) => handleMessage(name, ev, msg));
    }
    state.inputs.set(name, input);
    return true;
  } catch {
    return false;
  }
}

function closeInput(name) {
  const input = state.inputs.get(name);
  if (!input) return false;
  try { input.close(); } catch { /* noop */ }
  state.inputs.delete(name);
  return true;
}

function setMessageListener(fn) {
  state.onMessage = fn;
}

function handleMessage(inputName, eventType, msg) {
  const rawBytes = toRawBytes(eventType, msg);
  if (state.onMessage) {
    state.onMessage({ inputName, eventType, msg, rawBytes, timestamp: Date.now() });
  }
}

function shutdown() {
  for (const input of state.inputs.values()) {
    try { input.close(); } catch { /* noop */ }
  }
  state.inputs.clear();
  state.onMessage = null;
}

module.exports = {
  listInputs,
  openInput,
  closeInput,
  setMessageListener,
  shutdown,
  toRawBytes, // exported for tests
};
