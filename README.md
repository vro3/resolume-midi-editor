# Resolume MIDI Editor

A standalone desktop editor for Resolume Arena and Avenue MIDI shortcut XML presets, built with Electron, React and TypeScript.

- Browse, sort and filter MIDI shortcut bindings.
- Edit message types, channels, notes, behaviors and target paths.
- Capture controls with per-row MIDI Learn.
- Apply bulk edits and undo/redo changes.
- Watch the shortcuts folder for changes saved by Resolume.
- Store row labels in a separate `.midibrain.json` sidecar.
- Save through temporary files and keep a first-save `.bak` backup.

Not affiliated with or endorsed by Resolume B.V. Resolume is a trademark of Resolume B.V.

## Run from source

Use Node.js 22.12 or newer and npm. MIDI support uses a native dependency; a compiler toolchain may be needed if no prebuilt binary is available.

```sh
npm ci
npm run dev:electron
```

## Check and build

```sh
npm run lint
npm test
npm run build
npm run build:electron       # macOS DMG
npm run build:electron:win   # Windows installer
```

Packaged builds are unsigned unless you configure your own signing credentials. This repository contains source code; it does not include prebuilt installers.

## Presets

The editor looks under your Documents folder for `Resolume Arena/Shortcuts/MIDI`, `Resolume Arena 7/Shortcuts/MIDI`, or `Resolume Avenue/Shortcuts/MIDI`. You can also open a preset through the file picker.

Work on a copy first. After saving, reselect the preset in Resolume's shortcut menu so Resolume reloads it. Test the result with your controller before using it in a show.

The tests use synthetic XML examples and check structural preservation, selected byte-identical round trips, MIDI key encoding, and atomic-save failures. They do not establish compatibility with every Resolume version or controller.

## Privacy

Preset editing runs locally. There is no configured telemetry service, automatic update check, or external product link. Error logs stay in the app's local data folder. Development and dependency installation require network access.

## License

Anyone may use, modify, and redistribute this editor, including commercially, under the [MIT License](LICENSE). Include the copyright and permission notices with copies or substantial portions of the software.

## Verification notes

Run `npm audit --omit=dev` for runtime dependencies and `npm audit` for the full dependency tree. Advisory results depend on the lockfile and the registry data available when the command runs.
