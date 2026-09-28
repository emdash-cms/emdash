const IPV4_ADDRESS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_MAPPED_IPV6 = /::ffff:(\d+\.\d+\.\d+\.\d+)$/;
const PRIVATE_IPV6 = /^f[cd]/;
const LINK_LOCAL_IPV6 = /^fe[89ab]/;
const EGRESS_TIMEOUT_MS = 2 * 60_000;
const CREDENTIAL_HEADERS = [
	"authorization",
	"cookie",
	"proxy-authorization",
	"x-emdash-push-capability",
];

export type AnonymousReadPreparation =
	| { allowed: true; request: Request }
	| { allowed: false; reason: string };

export function prepareAnonymousRead(request: Request): AnonymousReadPreparation {
	const method = request.method.toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		return { allowed: false, reason: "anonymous egress permits only GET and HEAD" };
	}
	const url = new URL(request.url);
	if (url.protocol !== "https:") {
		return { allowed: false, reason: "anonymous egress requires HTTPS" };
	}
	if (isPrivateNetworkHost(url.hostname)) {
		return { allowed: false, reason: "anonymous egress denies private network targets" };
	}

	const forwarded = new Request(request);
	for (const header of CREDENTIAL_HEADERS) forwarded.headers.delete(header);
	forwarded.headers.set("user-agent", "emdash-bot");
	return { allowed: true, request: forwarded };
}

export async function forwardAnonymousRead(request: Request): Promise<Response> {
	return forwardAnonymousReadWith(request, fetch);
}

export async function forwardAnonymousReadWith(
	request: Request,
	fetchImpl: typeof fetch,
): Promise<Response> {
	const prepared = prepareAnonymousRead(request);
	if (!prepared.allowed) return new Response(`forbidden: ${prepared.reason}`, { status: 403 });
	try {
		return await fetchImpl(prepared.request, { signal: AbortSignal.timeout(EGRESS_TIMEOUT_MS) });
	} catch (error) {
		console.error("[sandbox/outbound] anonymous forward failed", {
			host: new URL(prepared.request.url).host,
			error: error instanceof Error ? error.message : String(error),
		});
		return new Response("forward failed", { status: 502 });
	}
}

function isPrivateNetworkHost(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized === "metadata.google.internal"
	) {
		return true;
	}

	const ipv4 = IPV4_ADDRESS.exec(normalized);
	if (ipv4) {
		const octets = ipv4.slice(1).map(Number);
		if (octets.some((octet) => octet > 255)) return true;
		const [first = 0, second = 0] = octets;
		return (
			first === 0 ||
			first === 10 ||
			first === 127 ||
			(first === 100 && second >= 64 && second <= 127) ||
			(first === 169 && second === 254) ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && (second === 0 || second === 168)) ||
			(first === 198 && (second === 18 || second === 19)) ||
			first >= 224
		);
	}

	if (!normalized.includes(":")) return false;
	if (normalized === "::" || normalized === "::1") return true;
	if (PRIVATE_IPV6.test(normalized) || LINK_LOCAL_IPV6.test(normalized)) return true;
	const mappedIpv4 = normalized.match(IPV4_MAPPED_IPV6)?.[1];
	return mappedIpv4 ? isPrivateNetworkHost(mappedIpv4) : false;
}
