/** The viewer page's script, bundled on its own by the `viewer-runtime` plugin in vite.config.ts. */
declare module 'virtual:viewer-runtime' {
  const code: string;
  export default code;
}

/** package.json's version, set by vite.config.ts. */
declare const __APP_VERSION__: string;
