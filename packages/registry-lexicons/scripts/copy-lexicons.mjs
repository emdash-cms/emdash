#!/usr/bin/env node
/**
 * Copy the source lexicon JSON files from the repo root into this package
 * so they ship with it. The lexicons are authored once at the repo root
 * (currently on the `wip/plugin-rfc` branch) and copied into each consumer
 * package that needs them.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");

const src = resolve(repoRoot, "lexicons", "com", "emdashcms", "experimental");
const dst = resolve(pkgRoot, "lexicons", "com", "emdashcms", "experimental");

await rm(resolve(pkgRoot, "lexicons"), { recursive: true, force: true });
await mkdir(dirname(dst), { recursive: true });
await cp(src, dst, { recursive: true });

console.log(`copied lexicons from ${src} -> ${dst}`);
