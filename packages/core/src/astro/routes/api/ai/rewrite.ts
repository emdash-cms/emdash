/**
 * AI rewrite endpoint
 *
 * POST /_emdash/api/ai/rewrite
 * Body: { text: string, count?: number, style?: string }
 * Response: { alternatives: string[] }
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { AiError, AiService } from "#ai/index.js";
import { z } from "zod";

export const prerender = false;

const rewriteSchema = z.object({
	text: z.string().min(1).max(10_000),
	count: z.number().int().min(1).max(5).optional(),
	style: z.string().optional(),
});

export const POST: APIRoute = async ({ request, locals }) => {
	const { user } = locals;

	const denied = requirePerm(user, "content:write");
	if (denied) return denied;

	const body = await parseBody(request, rewriteSchema);
	if (isParseError(body)) return body;

	// Get AI config from settings
	const emdash = locals.emdash;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	try {
		const aiConfig = await getAiConfig(emdash.db);
		if (!aiConfig) {
			return apiError("AI_NOT_CONFIGURED", "AI is not configured. Add your API key in Settings > AI.", 400);
		}

		const ai = new AiService();
		ai.configure(aiConfig);

		const result = await ai.rewrite({
			text: body.text,
			count: body.count,
			style: body.style,
		});

		return apiSuccess(result);
	} catch (error) {
		if (error instanceof AiError) {
			const status =
				error.code === "AI_NOT_CONFIGURED"
					? 400
					: error.code === "AI_RATE_LIMITED"
						? 429
						: error.code === "AI_TIMEOUT"
							? 504
							: error.code === "AI_INVALID_KEY"
								? 401
								: 502;
			return apiError(error.code, error.message, status);
		}
		return handleError(error, "AI rewrite failed", "AI_REWRITE_ERROR");
	}
};

/**
 * Read AI configuration from the settings table.
 * Returns null if not configured.
 */
async function getAiConfig(
	db: import("kysely").Kysely<unknown>,
): Promise<import("#ai/types.js").AiConfig | null> {
	try {
		const row = (await db
			.selectFrom("_emdash_settings" as never)
			.select(["value" as never])
			.where("key" as never, "=", "ai" as never)
			.executeTakeFirst()) as { value: string } | undefined;

		if (!row?.value) return null;

		const parsed = JSON.parse(row.value) as Record<string, string>;
		if (!parsed.apiKey) return null;

		return {
			provider: (parsed.provider as "openai" | "anthropic" | "openai-compatible") ?? "openai",
			apiKey: parsed.apiKey,
			baseUrl: parsed.baseUrl,
			model: parsed.model,
		};
	} catch {
		return null;
	}
}
