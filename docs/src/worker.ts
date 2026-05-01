import { handle } from "@astrojs/cloudflare/handler";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

/**
 * Build a fresh McpServer per request. createMcpHandler is stateless, and the
 * underlying transport asserts that the server is not already connected, so we
 * cannot reuse a single server instance across requests.
 */
function buildMcpServer(env: Env): McpServer {
	const server = new McpServer({
		name: "emdash-docs",
		version: "1.0.0",
	});

	server.registerTool(
		"search_docs",
		{
			title: "Search EmDash documentation",
			description:
				"Search the EmDash CMS documentation. Returns relevant chunks with source URLs and similarity scores.",
			inputSchema: {
				query: z
					.string()
					.min(1)
					.max(1000)
					.describe("Natural-language query against the EmDash docs."),
				max_results: z
					.number()
					.int()
					.min(1)
					.max(20)
					.optional()
					.describe("Maximum number of chunks to return. Defaults to 8."),
			},
		},
		async ({ query, max_results }) => {
			const limit = max_results ?? 8;

			const results = await env.AI_SEARCH.search({
				messages: [{ role: "user", content: query }],
				ai_search_options: {
					retrieval: { max_num_results: limit },
				},
			});

			if (!results.chunks.length) {
				return {
					content: [
						{
							type: "text",
							text: "No matching docs found.",
						},
					],
				};
			}

			return {
				content: results.chunks.map((chunk) => {
					const source = chunk.item.key;
					const score = typeof chunk.score === "number" ? chunk.score.toFixed(3) : "n/a";
					return {
						type: "text" as const,
						text: `<result source="${source}" score="${score}">\n${chunk.text}\n</result>`,
					};
				}),
			};
		},
	);

	return server;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			const handler = createMcpHandler(buildMcpServer(env), { route: "/mcp" });
			return handler(request, env, ctx);
		}

		return handle(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
