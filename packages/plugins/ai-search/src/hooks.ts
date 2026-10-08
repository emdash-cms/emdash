import type { PluginContext, PluginHooks } from "emdash";

import { runBuild } from "./build.js";
import { AUTHORS } from "./config.js";
import { openSession } from "./context.js";
import { failureOf } from "./indexer.js";
import type { AiSearchOptions } from "./options.js";
import { clearRetry, queueRetries, runRetries } from "./retry.js";

/** Cron runs are cut off after 30 seconds; stop starting new work well before that. */
const CRON_BUDGET_MS = 15_000;

/**
 * A sync makes several database and AI Search calls. Timing out abandons it
 * before a failure can be queued for retry, so allow as long as the platform
 * keeps deferred work alive.
 */
const SYNC_TIMEOUT_MS = 30_000;

export function createHooks(options: AiSearchOptions): PluginHooks {
	/** Indexes or removes a record according to its current state, queueing a retry if that fails. */
	const sync = async (ctx: PluginContext, source: string, id: string) => {
		const session = await openSession(ctx, options);
		if (!session) return;
		try {
			await session.indexer.syncRecord(source, id);
			await clearRetry(ctx, { source, id });
		} catch (error) {
			const failure = failureOf(error);
			ctx.log.warn(`[ai-search] could not sync ${source}/${id}; will retry: ${failure.error}`);
			await queueRetries(ctx, [{ source, id, ...failure }]);
		}
	};

	return {
		"content:afterPublish": {
			timeout: SYNC_TIMEOUT_MS,
			handler: (event, ctx) => sync(ctx, event.collection, idOf(event.content)),
		},
		"content:afterUnpublish": {
			timeout: SYNC_TIMEOUT_MS,
			handler: (event, ctx) => sync(ctx, event.collection, idOf(event.content)),
		},
		"content:afterDelete": {
			timeout: SYNC_TIMEOUT_MS,
			handler: (event, ctx) => sync(ctx, event.collection, event.id),
		},
		"content:afterSave": {
			timeout: SYNC_TIMEOUT_MS,
			handler: async (event, ctx) => {
				if (event.content.status === "published") {
					await sync(ctx, event.collection, idOf(event.content));
				}
			},
		},
		// Entries keep a renamed or deleted author's old name until they are next saved or the index is rebuilt.
		"byline:afterSave": {
			timeout: SYNC_TIMEOUT_MS,
			handler: (event, ctx) => sync(ctx, AUTHORS, event.byline.id),
		},
		"byline:afterDelete": {
			timeout: SYNC_TIMEOUT_MS,
			handler: (event, ctx) => sync(ctx, AUTHORS, event.byline.id),
		},
		cron: {
			timeout: 30_000,
			handler: async (event, ctx) => {
				if (event.name !== "build" && event.name !== "retry") return;
				const session = await openSession(ctx, options);
				if (!session) return;
				if (event.name === "build") await runBuild(ctx, session.indexer, CRON_BUDGET_MS);
				else await runRetries(ctx, session.indexer, CRON_BUDGET_MS);
			},
		},
	};
}

function idOf(content: Record<string, unknown>): string {
	if (typeof content.id !== "string") throw new Error("[ai-search] content event without an id");
	return content.id;
}
