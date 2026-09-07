import type { HostnameResolver } from "@emdash-cms/registry-verification/fetch";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_DNS_RESPONSE_BYTES = 64 * 1024;
const DNS_TIMEOUT_MS = 10_000;

export function createDohHostnameResolver(
	fetchImplementation: typeof fetch = globalThis.fetch,
): HostnameResolver {
	return async (hostname) => {
		const [ipv4, ipv6] = await Promise.all([
			queryDns(fetchImplementation, hostname, "A", 1),
			queryDns(fetchImplementation, hostname, "AAAA", 28),
		]);
		const addresses = [...new Set([...ipv4, ...ipv6])];
		if (addresses.length > 16) throw new Error("DNS query returned too many addresses");
		return addresses;
	};
}

async function queryDns(
	fetchImplementation: typeof fetch,
	hostname: string,
	recordType: "A" | "AAAA",
	numericType: 1 | 28,
): Promise<string[]> {
	const url = new URL(DOH_ENDPOINT);
	url.searchParams.set("name", hostname);
	url.searchParams.set("type", recordType);
	const response = await fetchImplementation(url, {
		method: "GET",
		redirect: "manual",
		headers: { accept: "application/dns-json" },
		signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error("DNS query failed");
	const body = await readBoundedResponse(response, MAX_DNS_RESPONSE_BYTES);
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
	} catch {
		throw new Error("DNS query returned an invalid response");
	}
	if (!isRecord(parsed) || parsed["Status"] !== 0) {
		throw new Error("DNS query failed");
	}
	const answers = parsed["Answer"];
	if (answers === undefined || answers === null) return [];
	if (!Array.isArray(answers)) throw new Error("DNS query failed");
	return answers.flatMap((answer) => {
		if (!isRecord(answer) || answer["type"] !== numericType || typeof answer["data"] !== "string") {
			return [];
		}
		return [answer["data"]];
	});
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
		await response.body?.cancel();
		throw new Error("DNS response exceeds its byte limit");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("DNS response body is missing");
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maximumBytes) {
				await reader.cancel();
				throw new Error("DNS response exceeds its byte limit");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
