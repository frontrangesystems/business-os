import { createRequire } from 'node:module';

/**
 * The running framework version, read from this package's own package.json at
 * load time. `version.ts` compiles to `dist/version.js`, so `../package.json`
 * resolves to the package root's package.json both in-repo and when core is
 * installed as a dependency in a client shell.
 */
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

/** `@frontrangesystems/business-os-core`'s semver. */
export const CORE_VERSION: string = pkg.version;

/**
 * The version string surfaced to the operator UI (footer). Defaults to the core
 * framework version; a client shell can override it via the `APP_VERSION` env
 * (e.g. to show its own app semver or a git build tag) without a code change.
 */
export const APP_VERSION: string = process.env.APP_VERSION?.trim() || CORE_VERSION;
