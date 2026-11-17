// Reconstruct raw MIDI bytes from easymidi's parsed event objects.
// Created: 2026-06-09 v1.1 (audit) — split out of midi-engine.cjs so the
// test suite can exercise it without loading the native easymidi bindings
// (which are built for Electron's ABI, not plain Node's).
//
// easymidi semantics (verified against easymidi/index.js):
//   noteon/noteoff:       { note, velocity, channel }
//   cc:                   { controller, value, channel }
//   program:              { number, channel }
//   pitch:                { value: 0..16383 UNSIGNED (bytes[1] + bytes[2]*128), channel }
//   poly aftertouch:      { note, pressure, channel }
//   channel aftertouch:   { pressure, channel }

function toRawBytes(eventType, msg) {
  const ch = typeof msg.channel === 'number' ? (msg.channel & 0x0F) : 0;
  switch (eventType) {
    case 'noteon':         return [0x90 | ch, msg.note & 0x7F, msg.velocity & 0x7F];
    case 'noteoff':        return [0x80 | ch, msg.note & 0x7F, msg.velocity & 0x7F];
    case 'cc':             return [0xB0 | ch, msg.controller & 0x7F, msg.value & 0x7F];
    case 'program':        return [0xC0 | ch, msg.number & 0x7F];
    case 'pitch': {
      // easymidi value is already unsigned 14-bit (0..16383, center 8192) —
      // do NOT re-center. The previous "+8192" wrapped every value half a
      // range off (center 8192 produced the bytes for full-down).
      const v = (msg.value | 0) & 0x3FFF;
      return [0xE0 | ch, v & 0x7F, (v >> 7) & 0x7F];
    }
    case 'poly aftertouch': return [0xA0 | ch, msg.note & 0x7F, msg.pressure & 0x7F];
    case 'channel aftertouch': return [0xD0 | ch, msg.pressure & 0x7F];
    default: return null;
  }
}

module.exports = { toRawBytes };
