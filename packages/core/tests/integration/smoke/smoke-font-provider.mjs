import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { fontProviders } from "astro/config";

const workspaceRequire = createRequire(new URL("../../../../../package.json", import.meta.url));
const playwrightRequire = createRequire(workspaceRequire.resolve("@playwright/test/package.json"));
const playwrightRoot = dirname(playwrightRequire.resolve("playwright-core/package.json"));
const fontDirectory = join(playwrightRoot, "lib/vite/traceViewer");
const fontFile = readdirSync(fontDirectory).find((file) => file.endsWith(".ttf"));

if (!fontFile) {
	throw new Error(`Smoke font fixture was not found in ${fontDirectory}`);
}

const fontPath = join(fontDirectory, fontFile);

function parseWeight(weight) {
	if (!weight.includes(" ")) return weight;
	return weight.split(" ").map(Number);
}

fontProviders.google = function smokeGoogleFontProvider() {
	return {
		name: "smoke-local-google-font",
		resolveFont({ weights = ["400"], styles = ["normal"] }) {
			return {
				fonts: styles.flatMap((style) =>
					weights.map((weight) => ({
						style,
						weight: parseWeight(weight),
						src: [{ url: fontPath }],
					})),
				),
			};
		},
	};
};

const GOOGLE_FONT_HOSTS = new Set([
	"fonts.google.com",
	"fonts.googleapis.com",
	"fonts.gstatic.com",
]);
const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = function rejectGoogleFontFetch(input, init) {
	const rawUrl = input instanceof Request ? input.url : input;
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return originalFetch(input, init);
	}

	if (GOOGLE_FONT_HOSTS.has(url.hostname)) {
		throw new Error(`Smoke tests must not fetch Google Fonts: ${url.href}`);
	}

	return originalFetch(input, init);
};
