// Build the Server Edition bundle (out/server/main.cjs).
//
// This used to be an inline esbuild command in package.json. It became a script for one reason:
// the SELF-HOST UNGATE flag (src/core/license.ts) is baked in at build time, and interpolating
// `$TERMSCAPE_UNGATE` into a shell command word-splits — a crafted value could append esbuild
// arguments (e.g. `--banner:js=...`) and plant code in the bundle. Here the value is normalized to
// exactly '1' or '' in JavaScript and handed to esbuild's API, so no shell sees it. It also makes
// the server build agree byte-for-byte with the desktop build's `define` in electron.vite.config.ts
// (only the exact string '1' opts in) and works on Windows shells, which never expanded `${VAR:-}`.
//
// The options are EXPORTED and the build only runs when this file is executed directly, so
// src/server/server-build.test.ts can import the exact entry/externals/tsconfig instead of parsing
// a package.json command string (upstream's version of that test tokenizes an inline esbuild
// command, which this fork no longer has). Importing this module never builds anything.
import { build } from 'esbuild'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const serverBuildOptions = {
  entryPoints: ['src/server/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'out/server/main.cjs',
  // Native addons the Server Edition reaches stay external: hosts build after
  // `npm ci --ignore-scripts`, so no addon is compiled there (see CONTRIBUTING.md).
  external: ['node-pty', 'ws', 'smart-whisper', 'ssh2'],
  tsconfig: 'tsconfig.node.json'
}

// Compared as REAL paths: Node resolves an ESM entry's symlinks for import.meta.url but leaves
// process.argv[1] as typed, so a plain URL compare would skip the build (silently, exit 0) for a
// checkout reached through a symlinked directory.
const realOrSelf = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
const isMain = process.argv[1] !== undefined && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url))

if (isMain) {
  await build({
    ...serverBuildOptions,
    define: {
      // SELF-HOST UNGATE: build-time opt-in, default OFF — see src/core/license.ts.
      'process.env.TERMSCAPE_UNGATE': JSON.stringify(process.env.TERMSCAPE_UNGATE === '1' ? '1' : '')
    }
  })
}
