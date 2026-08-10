const RETRYABLE_FONT_HOSTS = new Set(["fonts.gstatic.com"]);
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 250;

const originalFetch = globalThis.fetch.bind(globalThis);

function getUrl(input) {
	try {
		if (typeof input === "string" || input instanceof URL) return new URL(input);
		if (input instanceof Request) return new URL(input.url);
	} catch {
		return undefined;
	}
	return undefined;
}

function getMethod(input, init) {
	return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function retryDelay(attempt) {
	const jitter = Math.floor(Math.random() * 100);
	return BASE_DELAY_MS * 2 ** attempt + jitter;
}

globalThis.fetch = async function retryFontFetch(input, init) {
	const url = getUrl(input);
	const method = getMethod(input, init);
	if (!url || !RETRYABLE_FONT_HOSTS.has(url.hostname) || !["GET", "HEAD"].includes(method)) {
		return originalFetch(input, init);
	}

	let lastError;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			const response = await originalFetch(input, init);
			if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === MAX_ATTEMPTS - 1) {
				return response;
			}
			lastError = new Error(`Font fetch returned HTTP ${response.status}`);
			await response.body?.cancel();
		} catch (error) {
			lastError = error;
			if (attempt === MAX_ATTEMPTS - 1) throw error;
		}

		await sleep(retryDelay(attempt));
	}

	throw lastError;
};
