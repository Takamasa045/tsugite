declare module '@xterm/xterm/lib/xterm.mjs?url' {
  const url: string
  export default url
}

interface ImportMetaEnv {
  readonly MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
