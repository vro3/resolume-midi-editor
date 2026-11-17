// Minimal "Listen on:" input picker. Replaces MidiBrain's full Live Routing
// sidebar — the standalone editor only needs to know which controller to
// listen to for the per-row Learn feature.

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

interface Props {
  selectedInput: string | null;
  onSelectInput: (name: string | null) => void;
}

export default function ControllerPicker({ selectedInput, onSelectInput }: Props) {
  const [inputs, setInputs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!window.api?.listMidiInputs) return;
    setBusy(true);
    try {
      const list = await window.api.listMidiInputs();
      setInputs(list);
      // Auto-select if there's exactly one input and the user hasn't picked yet.
      if (list.length === 1 && !selectedInput) {
        onSelectInput(list[0]);
      }
      // If the previously-selected input vanished, clear the selection.
      if (selectedInput && !list.includes(selectedInput)) {
        onSelectInput(null);
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    refresh();
    // Hotplug: poll every 3s for new/removed devices.
    const interval = window.setInterval(refresh, 3000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open the selected input on the Electron side so the engine subscribes.
  useEffect(() => {
    const api = window.api;
    if (!api || !selectedInput) return;
    api.openMidiInput(selectedInput);
    return () => {
      api.closeMidiInput(selectedInput);
    };
  }, [selectedInput]);

  return (
    <div className="flex items-center gap-2">
      <label className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">
        Listen on
      </label>
      <select
        value={selectedInput ?? ''}
        onChange={(e) => onSelectInput(e.target.value || null)}
        className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 min-w-[180px]"
      >
        <option value="">— No controller —</option>
        {inputs.map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
      <button
        onClick={refresh}
        disabled={busy}
        className="w-7 h-7 flex items-center justify-center rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-400 disabled:opacity-50"
        title="Refresh device list"
      >
        <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
      </button>
    </div>
  );
}
