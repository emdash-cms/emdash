/**
 * Copy compiled locale catalogs (.mjs) from src/locales to dist/locales.
 * Run after `lingui compile` to include catalogs in the published package.
 */
import { readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "..", "src", "locales");
const distDir = join(__dirname, "..", "dist", "locales");

for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const destDir = join(distDir, entry.name);
	mkdirSync(destDir, { recursive: true });
	copyFileSync(join(srcDir, entry.name, "messages.mjs"), join(destDir, "messages.mjs"));
}
