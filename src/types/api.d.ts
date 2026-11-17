export interface MidiMessagePayload {
  inputName: string;
  eventType: string;
  msg: Record<string, number>;
  rawBytes: number[] | null;
  timestamp: number;
}

export interface WatcherEvent {
  path: string;
  kind: 'change' | 'add' | 'unlink';
  timestamp: number;
}

export interface PresetListEntry {
  name: string;
  path: string;
}

export interface PresetListing {
  folder: string;
  presets: PresetListEntry[];
}

export interface ResolumeFileResult {
  path: string;
  text: string;
}

export interface ResolumeSaveResult {
  path: string;
}

export interface SidecarData {
  labels?: Record<string, string>;
  // Future: per-row notes, color tags, group memberships, etc.
}

export interface PlatformBridge {
  os: 'darwin' | 'win32' | 'linux' | string;
}

export interface ResolumeEditorApi {
  openResolumeFile(): Promise<ResolumeFileResult | null>;
  openResolumePath(path: string): Promise<ResolumeFileResult | null>;
  saveResolumeFile(path: string | null, text: string): Promise<ResolumeSaveResult | null>;
  listPresets(): Promise<PresetListing>;

  readSidecar(presetPath: string): Promise<SidecarData | null>;
  writeSidecar(presetPath: string, data: SidecarData): Promise<boolean>;

  watchFolder(folder: string): Promise<boolean>;
  unwatchFolder(): Promise<boolean>;
  defaultPresetsFolder(): Promise<string>;
  onWatcherChange(callback: (evt: WatcherEvent) => void): () => void;

  listMidiInputs(): Promise<string[]>;
  openMidiInput(name: string): Promise<boolean>;
  closeMidiInput(name: string): Promise<boolean>;
  onMidiMessage(callback: (payload: MidiMessagePayload) => void): () => void;


  onMenuCommand(callback: (channel: string) => void): () => void;

  setDirty(dirty: boolean): void;

  logError(payload: { message: string; stack?: string }): void;
}

declare global {
  interface Window {
    api?: ResolumeEditorApi;
    platform?: PlatformBridge;
  }
  // Injected at build time by vite (define) from package.json.
  const __APP_VERSION__: string;
}

export {};
