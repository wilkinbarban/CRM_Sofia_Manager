// js-yaml ships as ESM without bundled type declarations and the package is not
// installed with @types. Only the surface this repository uses is declared, and the
// parsed value is `unknown` so every consumer must narrow it before use.
declare module 'js-yaml' {
  export interface LoadOptions {
    filename?: string
    json?: boolean
    schema?: unknown
  }

  export function load(input: string, options?: LoadOptions): unknown

  const yaml: {
    load: typeof load
  }

  export default yaml
}
