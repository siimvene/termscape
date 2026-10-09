// Types for scripts/build-server.mjs, so src/server/server-build.test.ts (type-checked under
// tsconfig.node.json) can import the exact options the Server Edition is built with.
export declare const serverBuildOptions: {
  entryPoints: string[]
  bundle: true
  platform: 'node'
  format: 'cjs'
  outfile: string
  external: string[]
  tsconfig: string
}
