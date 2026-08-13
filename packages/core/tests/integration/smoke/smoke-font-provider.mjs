import { fileURLToPath } from "node:url";

import { fontProviders } from "astro/config";

const fontPath = fileURLToPath(new URL("./fixtures/codicon.ttf", import.meta.url));

function parseWeight(weight) {
	const stringWeight = String(weight);
	if (!stringWeight.includes(" ")) return stringWeight;
	return stringWeight.split(" ").map(Number);
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
