/// <reference types="vite/client" />

// Build-time constants injected by vite.config.ts from package.json, so the About screen and the
// engine report the owner and version without reading package.json at run time.
interface ImportMetaEnv {
  readonly VITE_OWNER: string;
  readonly VITE_APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
