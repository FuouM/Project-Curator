/**
 * Barrel export for the Project Curator plugin shared utility library.
 *
 * Import from this file in plugin source modules:
 *
 *   import { createLogger, setupDropZone, navigateToTab } from "../../lib";
 *
 * esbuild tree-shakes unused exports so only the utilities a plugin actually
 * imports end up in its bundled index.js.
 */

export { createLogger } from "./log";
export type { LogKind, Logger } from "./log";

export { formatBytes } from "./format";

export { checkFileExists, getUniqueOutputPath } from "./ipc-utils";

export { navigateToTab, closeInfoModal } from "./navigation";

export { setupDropZone } from "./drop-zone";

export { pollTranscodeProgress } from "./poll";
export type { TranscodeProgress, PollOptions } from "./poll";
