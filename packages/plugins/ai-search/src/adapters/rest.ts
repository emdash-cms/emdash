import {
	type AiSearchProvider,
	type ItemQuery,
	ProviderError,
	type SearchQuery,
} from "../ports/ai-search.js";
import {
	ensureInstance,
	instanceConfig,
	listParams,
	searchRequest,
	toChunks,
	toItem,
	toPage,
	toStats,
	type WireItem,
	type WireSearch,
	type WireStats,
} from "./shared.js";

const API = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 15_000;

/** Cloudflare API error codes for a missing, malformed, or rejected token. */
const AUTH_ERROR_CODES = new Set([9106, 9109, 10000]);

export interface RestCredentials {
	accountId: string;
	apiToken: string;
	namespace: string;
}

interface Envelope<T> {
	success?: boolean;
	errors?: Array<{ code?: number; message?: string }>;
	result: T;
	result_info?: { total_count?: number };
}

/** AI Search through the Cloudflare REST API, authenticated with an API token. */
export class RestAiSearch implements AiSearchProvider {
	readonly kind = "rest";
	requests = 0;
	private requestLimit = Infinity;

	constructor(
		private readonly credentials: RestCredentials,
		private readonly name: string,
		// Workers rejects `fetch` called as a method of another object.
		private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
	) {}

	limitRequests(remaining: number): void {
		this.requestLimit = this.requests + remaining;
	}

	/** Throws `unauthorized` for a token without AI Search access, `not-found` for a missing namespace. */
	async verify(): Promise<void> {
		await this.request("GET", "/instances?per_page=1");
	}

	ensureInstance() {
		return ensureInstance(
			() => this.info(),
			() => this.request("POST", "/instances", instanceConfig(this.name)),
		);
	}

	async info() {
		const { result } = await this.request<{ id: string; namespace?: string }>("GET", this.path());
		return { id: result.id, namespace: result.namespace ?? this.credentials.namespace };
	}

	async stats() {
		return toStats((await this.request<WireStats>("GET", this.path("/stats"))).result);
	}

	async search(query: SearchQuery) {
		const { result } = await this.request<WireSearch>(
			"POST",
			this.path("/search"),
			searchRequest(query),
		);
		return toChunks(result);
	}

	async listItems(query: ItemQuery = {}) {
		const params = new URLSearchParams(
			Object.entries(listParams(query)).map(([name, value]) => [name, String(value)]),
		);
		return toPage(await this.request<WireItem[]>("GET", this.path(`/items?${params}`)));
	}

	async uploadItem(key: string, body: string, metadata: Record<string, string>) {
		const form = new FormData();
		form.append("file", new Blob([body], { type: "text/markdown" }), key);
		form.append("metadata", JSON.stringify(metadata));
		return toItem((await this.request<WireItem>("POST", this.path("/items"), form)).result);
	}

	async deleteItem(id: string) {
		await this.request("DELETE", this.path(`/items/${encodeURIComponent(id)}`));
	}

	async tokenRejected(): Promise<boolean> {
		const { accountId, apiToken } = this.credentials;
		// Account-owned and user-owned tokens each verify only at their own endpoint.
		for (const path of [
			`/accounts/${encodeURIComponent(accountId)}/tokens/verify`,
			"/user/tokens/verify",
		]) {
			if (this.requests >= this.requestLimit) return false;
			this.requests++;
			const response = await this.fetcher(`${API}${path}`, {
				headers: { authorization: `Bearer ${apiToken}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			}).catch(() => null);
			if (!response) return false;
			if (response.ok) {
				const envelope = (await response.json().catch(() => null)) as Envelope<{
					status?: string;
				}> | null;
				if (envelope?.result?.status === "active") return false;
			} else if (response.status !== 401) {
				return false;
			}
		}
		return true;
	}

	private path(suffix = ""): string {
		return `/instances/${encodeURIComponent(this.name)}${suffix}`;
	}

	private async request<T = unknown>(
		method: string,
		path: string,
		payload?: object,
	): Promise<Envelope<T>> {
		if (this.requests >= this.requestLimit) {
			throw new ProviderError(
				"rate-limited",
				"The build's Cloudflare API request budget is exhausted",
			);
		}
		const { accountId, apiToken, namespace } = this.credentials;
		const url = `${API}/accounts/${encodeURIComponent(accountId)}/ai-search/namespaces/${encodeURIComponent(namespace)}${path}`;
		const form = payload instanceof FormData;
		this.requests++;
		const response = await this.fetcher(url, {
			method,
			headers: {
				authorization: `Bearer ${apiToken}`,
				...(payload && !form ? { "content-type": "application/json" } : {}),
			},
			body: payload && !form ? JSON.stringify(payload) : payload,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		}).catch((error: unknown) => {
			throw new ProviderError("failed", "Could not reach the Cloudflare API", { cause: error });
		});
		const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;
		if (response.ok && envelope?.success !== false && envelope) return envelope;

		const message =
			envelope?.errors?.find((error) => error.message)?.message ??
			`Cloudflare API responded with HTTP ${response.status}`;
		throw new ProviderError(reasonFor(response.status, envelope?.errors ?? []), message);
	}
}

function reasonFor(status: number, errors: Array<{ code?: number }>): ProviderError["reason"] {
	if (status === 401 || status === 403) return "unauthorized";
	if (errors.some((error) => AUTH_ERROR_CODES.has(error.code ?? 0))) return "unauthorized";
	if (status === 429) return "rate-limited";
	if (status === 404) return "not-found";
	return "failed";
}
