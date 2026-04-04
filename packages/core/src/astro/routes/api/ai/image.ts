/**
 * AI image generation and alt-text endpoint
 *
 * POST /_emdash/api/ai/image
 *
 * Actions:
 * - { action: "generate", prompt, size? } - Generate an image via DALL-E
 * - { action: "alt-text", imageUrl } - Generate alt text via vision model
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";

import { generateAltText, generateImage, getAiConfig } from "../../../../ai/service.js";
import { AiError } from "../../../../ai/types.js";

export const prerender = false;

const generateSchema = z.object({
	action: z.literal("generate"),
	prompt: z.string().min(1).max(4000),
	size: z.string().optional(),
});

const altTextSchema = z.object({
	action: z.literal("alt-text"),
	imageUrl: z.string().url(),
});

const aiImageBody = z.discriminatedUnion("action", [generateSchema, altTextSchema]);

export const POST: APIRoute = async ({ request, locals }) => {
	const { user } = locals;

	const denied = requirePerm(user, "media:upload");
	if (denied) return denied;

	const config = getAiConfig();
	if (!config) {
		return apiError(
			"AI_NOT_CONFIGURED",
			"AI provider is not configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.",
			501,
		);
	}

	const body = await parseBody(request, aiImageBody);
	if (isParseError(body)) return body;

	try {
		if (body.action === "generate") {
			const result = await generateImage(config, {
				prompt: body.prompt,
				size: body.size,
			});
			return apiSuccess(result);
		}

		const result = await generateAltText(config, {
			imageUrl: body.imageUrl,
		});
		return apiSuccess(result);
	} catch (error) {
		if (error instanceof AiError) {
			return apiError(error.code, error.message, 502);
		}
		return handleError(error, "AI request failed", "AI_ERROR");
	}
};
