const DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_DNS_RESPONSE_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readBoundedJson(response: Response): Promise<unknown> {
	if (!response.ok || !response.body) throw new Error("DNS resolution failed");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_DNS_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("DNS response exceeded limit");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}

async function resolveType(
	hostname: string,
	type: "A" | "AAAA",
	fetchImplementation: typeof fetch,
): Promise<readonly string[]> {
	const url = new URL(DNS_ENDPOINT);
	url.searchParams.set("name", hostname);
	url.searchParams.set("type", type);
	const response = await fetchImplementation(url, {
		headers: { accept: "application/dns-json" },
		redirect: "error",
		signal: AbortSignal.timeout(5_000),
	});
	const parsed = await readBoundedJson(response);
	if (!isRecord(parsed) || parsed["Status"] !== 0 || !Array.isArray(parsed["Answer"])) return [];
	const expectedType = type === "A" ? 1 : 28;
	return parsed["Answer"].flatMap((answer): string[] => {
		if (
			!isRecord(answer) ||
			answer["type"] !== expectedType ||
			typeof answer["data"] !== "string"
		) {
			return [];
		}
		return [answer["data"]];
	});
}

export async function resolvePublicHostname(
	hostname: string,
	fetchImplementation: typeof fetch = fetch,
): Promise<readonly string[]> {
	if (hostname.length === 0 || hostname.length > 253) return [];
	const [ipv4, ipv6] = await Promise.all([
		resolveType(hostname, "A", fetchImplementation),
		resolveType(hostname, "AAAA", fetchImplementation),
	]);
	return [...ipv4, ...ipv6];
}
