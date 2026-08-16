/**
 * Ambient module declaration for `.css` imports.
 *
 * `plugins/build.js` configures esbuild with `loader: { ".css": "text" }`,
 * so importing a stylesheet yields the raw CSS text as a string. This lets
 * the plugin inject a single <style> element with all its styles without a
 * separate runtime CSS loading step.
 */
declare module "*.css" {
  const cssText: string;
  export default cssText;
}