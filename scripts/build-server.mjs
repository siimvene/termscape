// Build the Server Edition bundle (out/server/main.cjs).
//
// This used to be an inline esbuild command in package.json. It became a script for one reason:
// the SELF-HOST UNGATE flag (src/core/license.ts) is baked in at build time, and interpolating
// `$TERMSCAPE_UNGATE` into a shell command word-splits — a crafted value could append esbuild
// arguments (e.g. `--banner:js=...`) and plant code in the bundle. Here the value is normalized to
// exactly '1' or '' in JavaScript and handed to esbuild's API, so no shell sees it. It also makes
// the server build agree byte-for-byte with the desktop build's `define` in electron.vite.config.ts
// (only the exact string '1' opts in) and works on Windows shells, which never expanded `${VAR:-}`.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/server/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'out/server/main.cjs',
  external: ['node-pty', 'ws', 'smart-whisper'],
  tsconfig: 'tsconfig.node.json',
  define: {
    // SELF-HOST UNGATE: build-time opt-in, default OFF — see src/core/license.ts.
    'process.env.TERMSCAPE_UNGATE': JSON.stringify(process.env.TERMSCAPE_UNGATE === '1' ? '1' : '')
  }
})
