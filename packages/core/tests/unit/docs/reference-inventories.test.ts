import { readFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { generateOpenApiDocument } from "../../../src/api/openapi/document.js";
import { createMcpServer } from "../../../src/mcp/server.js";

const mcpReferenceUrl = new URL(
	"../../../../../docs/src/content/docs/reference/mcp-server.mdx",
	import.meta.url,
);
const restReferenceUrl = new URL(
	"../../../../../docs/src/content/docs/reference/rest-api.mdx",
	import.meta.url,
);
const mcpServerSourceUrl = new URL("../../../src/mcp/server.ts", import.meta.url);

function inventoryBlock(source: string, name: "mcp-tool" | "rest-endpoint"): string {
	const match = source.match(
		new RegExp(
			`\\{/\\* ${name}-inventory:start \\*/}([\\s\\S]*?)\\{/\\* ${name}-inventory:end \\*/}`,
		),
	);
	if (!match?.[1]) throw new Error(`Missing ${name} inventory markers`);
	return match[1];
}

describe("documentation reference inventories", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
	});

	it("lists every static MCP tool with its registered title", async () => {
		const source = await readFile(mcpReferenceUrl, "utf8");
		const documented = Array.from(
			inventoryBlock(source, "mcp-tool").matchAll(/^\| `([^`]+)` \| ([^|]+?) \| `([^`]+)` \|/gm),
			(match) => ({ name: match[1], title: match[2]?.trim(), scope: match[3] }),
		).toSorted((a, b) => a.name.localeCompare(b.name));
		const serverSource = await readFile(mcpServerSourceUrl, "utf8");
		const registrations = [...serverSource.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)];
		const scopes = new Map<string, string>();
		for (const [index, registration] of registrations.entries()) {
			const registrationName = registration[1];
			const block = serverSource.slice(
				registration.index,
				registrations[index + 1]?.index ?? serverSource.length,
			);
			// Core registrations declare one literal scope guard. Fail if that source shape changes
			// instead of guessing which scope the reference should publish.
			const scopeMatches = [...block.matchAll(/requireScope\(extra, "([^"]+)"\)/g)];
			const scope = scopeMatches[0]?.[1];
			if (!registrationName || scopeMatches.length !== 1 || !scope) {
				throw new Error(
					`Expected one literal scope for MCP registration ${registrationName ?? "unknown"}`,
				);
			}
			scopes.set(registrationName, scope);
		}

		const server = createMcpServer();
		const client = new Client({ name: "docs-reference-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		cleanups.push(async () => {
			await client.close();
			await server.close();
		});

		const listed = await client.listTools();
		const registered = listed.tools
			.map((tool) => ({ name: tool.name, title: tool.title, scope: scopes.get(tool.name) }))
			.toSorted((a, b) => a.name.localeCompare(b.name));

		expect(documented).toEqual(registered);
	});

	it("lists every operation in the public OpenAPI document", async () => {
		const source = await readFile(restReferenceUrl, "utf8");
		const documented = Array.from(
			inventoryBlock(source, "rest-endpoint").matchAll(
				/^\| `([A-Z]+)` \| `([^`]+)` \| `([^`]+)` \| ([^|]+?) \|/gm,
			),
			(match) => ({
				method: match[1],
				path: match[2],
				operationId: match[3],
				summary: match[4]?.trim(),
			}),
		).toSorted((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));

		const document = generateOpenApiDocument();
		const generated = Object.entries(document.paths ?? {})
			.flatMap(([path, pathItem]) =>
				["get", "post", "put", "patch", "delete"].flatMap((method) => {
					const operation = (pathItem as Record<string, unknown>)[method] as
						| { operationId?: string; summary?: string }
						| undefined;
					return operation
						? [
								{
									method: method.toUpperCase(),
									path,
									operationId: operation.operationId,
									summary: operation.summary,
								},
							]
						: [];
				}),
			)
			.toSorted((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));

		expect(documented).toEqual(generated);
	});
});
