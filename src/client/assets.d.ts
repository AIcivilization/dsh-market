/**
 * Ambient module declarations for assets the client bundle inlines.
 *
 * `*.module.css` is compiled by the build's CSS Modules loader, which injects a
 * tagged <style> at factory execution and exports the hashed class map. tsc only
 * needs the shape of that default export.
 *
 * `*.css?inline` exports compiled stylesheet text for a plugin-owned lifecycle
 * effect (inserted/removed by the caller rather than at factory execution).
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css?inline' {
  const css: string
  export default css
}

declare module '*.css' {
  const css: string
  export default css
}
