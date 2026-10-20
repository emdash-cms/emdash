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
} from "./shared.js";

const RATE_LIMIT_MESSAGE = /rate limit/i;
const NOT_FOUND_MESSAGE = /ai_search_not_found/;

/** AI Search through an `ai_search_namespaces` binding on Cloudflare Workers. */
export class BindingAiSearch implements AiSearchProvider {
	readonly kind = "binding";

	constructor(
		private readonly namespace: AiSearchNamespace,
		private readonly name: string,
	) {}

	private get instance(): AiSearchInstance {
		return this.namespace.get(this.name);
	}

	ensureInstance() {
		return ensureInstance(
			() => this.info(),
			() => call(() => this.namespace.create(instanceConfig(this.name))),
		);
	}

	async info() {
		const info = await call(() => this.instance.info());
		return { id: info.id, namespace: info.namespace ?? null };
	}

	async stats() {
		return toStats(await call(() => this.instance.stats()));
	}

	async search(query: SearchQuery) {
		return toChunks(await call(() => this.instance.search(searchRequest(query))));
	}

	async listItems(query: ItemQuery = {}) {
		return toPage(await call(() => this.instance.items.list(listParams(query))));
	}

	async uploadItem(key: string, body: string, metadata: Record<string, string>) {
		return toItem(await call(() => this.instance.items.upload(key, body, { metadata })));
	}

	async deleteItem(id: string) {
		await call(() => this.instance.items.delete(id));
	}
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		let reason: ProviderError["reason"] = "failed";
		if (RATE_LIMIT_MESSAGE.test(message)) reason = "rate-limited";
		else if (NOT_FOUND_MESSAGE.test(message)) reason = "not-found";
		throw new ProviderError(reason, message, { cause: error });
	}
}
