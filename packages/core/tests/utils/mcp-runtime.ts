/**
 * MCP integration test harness.
 *
 * Builds a real `EmDashRuntime` against a pre-migrated test database, wires
 * its handlers into a real `McpServer`, and connects a real `Client` over
 * `InMemoryTransport`. No mocks. Production code paths run end-to-end —
 * MCP tool dispatch, runtime handler logic (incl. draft revision flow),
 * `ApiResult` error envelopes, repositories, and SQL.
 *
 * Use this for any test that asserts behavior of an MCP tool against real
 * data. Use the unit-level mocked-handler suite (`tests/unit/mcp`) only
 * for pure authorization/scope gating where a real DB adds nothing.
 */

import type { RoleLevel } from "@emdash-cms/auth";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Kysely } from "kysely";

import type { EmDashConfig } from "../../src/astro/integration/runtime.js";
import type { EmDashHandlers } from "../../src/astro/types.js";
import type { Database } from "../../src/database/types.js";
import { EmDashRuntime } from "../../src/emdash-runtime.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createHookPipeline } from "../../src/plugins/hooks.js";
import type { ResolvedPlugin } from "../../src/plugins/types.js";

// ---------------------------------------------------------------------------
// Auth-injecting transport
//
// Mirrors the production HTTP transport: every client send carries authInfo
// with the user's role + scopes + emdash handle. The MCP server pulls these
// out of `extra.authInfo.extra` to authorize the request.
// ---------------------------------------------------------------------------

class AuthInjectingTransport extends InMemoryTransport {
	constructor(private authInfo: Record<string, unknown>) {
		super();
	}

	override async send(
		message: Parameters<InMemoryTransport["send"]>[0],
		options?: Parameters<InMemoryTransport["send"]>[1],
	): Promise<void> {
		const existingExtra =
			options?.authInfo && typeof options.authInfo === "object" && "extra" in options.authInfo
				? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- narrowed by typeof + 'in' check
					(options.authInfo.extra as Record<string, unknown>)
				: {};
		return super.send(message, {
			...options,
			authInfo: {
				token: "",
				clientId: "test",
				scopes: [],
				...options?.authInfo,
				extra: {
					...this.authInfo,
					...existingExtra,
				},
			},
		});
	}
}

function createAuthenticatedPair(authInfo: {
	emdash: EmDashHandlers;
	userId: string;
	userRole: RoleLevel;
	tokenScopes?: string[];
}): [AuthInjectingTransport, InMemoryTransport] {
	const clientTransport = new AuthInjectingTransport(authInfo);
	const serverTransport = new InMemoryTransport();
	// Link them — InMemoryTransport's pairing uses `_otherTransport`.
	(clientTransport as unknown as Record<string, unknown>)._otherTransport = serverTransport;
	(serverTransport as unknown as Record<string, unknown>)._otherTransport = clientTransport;
	return [clientTransport, serverTransport];
}

// ---------------------------------------------------------------------------
// Real runtime construction
//
// Builds a runtime around a pre-migrated DB without spinning up cron,
// marketplace, sandboxed plugins, or a media provider. Every code path the
// MCP tools exercise — content handlers, repositories, schema registry,
// draft revisions, FTS — runs through the real runtime methods.
//
// Note: this constructs `EmDashRuntime` directly via its public constructor.
// The runtime never reads `runtimeDeps` after construction except in
// `rebuildHookPipeline`, which tests do not call. cron/scheduler are null.
// ---------------------------------------------------------------------------

export interface TestRuntimeOptions {
	/** Optional plugins to participate in the hook pipeline. Default: none. */
	plugins?: ResolvedPlugin[];
	/** Optional partial config override. Default: empty config. */
	config?: Partial<EmDashConfig>;
}

/**
 * Build a real `EmDashRuntime` for a test database.
 *
 * The DB must already have migrations + collections set up (use
 * `setupTestDatabaseWithCollections()` or equivalent).
 */
export function createTestRuntime(
	db: Kysely<Database>,
	opts: TestRuntimeOptions = {},
): EmDashRuntime {
	const plugins = opts.plugins ?? [];
	const config: EmDashConfig = { ...opts.config };

	const pipelineFactoryOptions = { db } as const;
	const hooks = createHookPipeline(plugins, pipelineFactoryOptions);
	const pipelineRef = { current: hooks };

	// runtimeDeps is only consumed by `rebuildHookPipeline()`, which is not
	// invoked by any MCP tool path. We pass a minimal stub so the field
	// satisfies the type. If a future test ever touches plugin toggling, this
	// stub will need expanding (and that's a useful failure to hit, not
	// silent dead code).
	const runtimeDeps = {
		config,
		plugins,
		// eslint-disable-next-line typescript-eslint(no-explicit-any) -- match RuntimeDependencies signature
		createDialect: (() => {
			throw new Error("createDialect not available in test runtime");
		}) as any,
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};

	return new EmDashRuntime({
		db,
		storage: null,
		configuredPlugins: plugins,
		sandboxedPlugins: new Map(),
		sandboxedPluginEntries: [],
		hooks,
		enabledPlugins: new Set(plugins.map((p) => p.id)),
		pluginStates: new Map(),
		config,
		mediaProviders: new Map(),
		mediaProviderEntries: [],
		cronExecutor: null,
		cronScheduler: null,
		emailPipeline: null,
		allPipelinePlugins: plugins,
		pipelineFactoryOptions,
		runtimeDeps,
		pipelineRef,
		manifestCacheKey: "test",
	});
}

/**
 * Build the `EmDashHandlers` shape the MCP server consumes from a runtime.
 *
 * Mirrors the wiring in `astro/middleware.ts` so the same code paths run
 * under test as in production.
 */
export function handlersFromRuntime(runtime: EmDashRuntime): EmDashHandlers {
	const handlers: EmDashHandlers = {
		// Content
		handleContentList: runtime.handleContentList.bind(runtime),
		handleContentGet: runtime.handleContentGet.bind(runtime),
		handleContentGetIncludingTrashed: runtime.handleContentGetIncludingTrashed.bind(runtime),
		handleContentCreate: runtime.handleContentCreate.bind(runtime),
		handleContentUpdate: runtime.handleContentUpdate.bind(runtime),
		handleContentDelete: runtime.handleContentDelete.bind(runtime),
		handleContentDuplicate: runtime.handleContentDuplicate.bind(runtime),
		handleContentRestore: runtime.handleContentRestore.bind(runtime),
		handleContentPermanentDelete: runtime.handleContentPermanentDelete.bind(runtime),
		handleContentListTrashed: runtime.handleContentListTrashed.bind(runtime),
		handleContentCountTrashed: runtime.handleContentCountTrashed.bind(runtime),
		handleContentPublish: runtime.handleContentPublish.bind(runtime),
		handleContentUnpublish: runtime.handleContentUnpublish.bind(runtime),
		handleContentSchedule: runtime.handleContentSchedule.bind(runtime),
		handleContentUnschedule: runtime.handleContentUnschedule.bind(runtime),
		handleContentCountScheduled: runtime.handleContentCountScheduled.bind(runtime),
		handleContentDiscardDraft: runtime.handleContentDiscardDraft.bind(runtime),
		handleContentCompare: runtime.handleContentCompare.bind(runtime),
		handleContentTranslations: runtime.handleContentTranslations.bind(runtime),

		// Media
		handleMediaList: runtime.handleMediaList.bind(runtime),
		handleMediaGet: runtime.handleMediaGet.bind(runtime),
		handleMediaCreate: runtime.handleMediaCreate.bind(runtime),
		handleMediaUpdate: runtime.handleMediaUpdate.bind(runtime),
		handleMediaDelete: runtime.handleMediaDelete.bind(runtime),

		// Revisions
		handleRevisionList: runtime.handleRevisionList.bind(runtime),
		handleRevisionGet: runtime.handleRevisionGet.bind(runtime),
		handleRevisionRestore: runtime.handleRevisionRestore.bind(runtime),

		// Direct access (MCP tools use db for schema/menu/taxonomy/search)
		storage: runtime.storage,
		db: runtime.db,
		hooks: runtime.hooks,
		email: runtime.email,
		configuredPlugins: runtime.configuredPlugins,
		config: runtime.config,
		invalidateManifest: runtime.invalidateManifest.bind(runtime),

		// Fields the MCP server doesn't currently call. Stub so the type
		// checks; if a tool ever reaches for one, the test will throw a
		// clear error rather than silently no-op.
		handlePluginApiRoute: () => {
			throw new Error("handlePluginApiRoute not implemented in test runtime");
		},
		getPluginRouteMeta: () => null,
		getMediaProvider: runtime.getMediaProvider.bind(runtime),
		getMediaProviderList: runtime.getMediaProviderList.bind(runtime),
		getSandboxRunner: runtime.getSandboxRunner.bind(runtime),
		syncMarketplacePlugins: () => Promise.resolve(),
		setPluginStatus: runtime.setPluginStatus.bind(runtime),
		collectPageMetadata: runtime.collectPageMetadata.bind(runtime),
		collectPageFragments: runtime.collectPageFragments.bind(runtime),
		ensureSearchHealthy: runtime.ensureSearchHealthy.bind(runtime),
	};
	return handlers;
}

// ---------------------------------------------------------------------------
// MCP client/server pair
// ---------------------------------------------------------------------------

export interface McpHarness {
	/** The connected MCP client — call `client.callTool({ name, arguments })`. */
	client: Client;
	/** The runtime backing the harness. Use to make direct DB writes/reads in setup. */
	runtime: EmDashRuntime;
	/** The handlers wired into the MCP server. */
	handlers: EmDashHandlers;
	/** Tear down both client and server. */
	cleanup: () => Promise<void>;
}

export interface ConnectMcpOptions {
	db: Kysely<Database>;
	userId: string;
	userRole: RoleLevel;
	tokenScopes?: string[];
	runtimeOptions?: TestRuntimeOptions;
}

/**
 * Connect a real MCP client/server pair against a real runtime + DB.
 *
 * No mocks. The MCP tool dispatch, the runtime handlers, and the database
 * are all production code. Anything that goes wrong in this harness is
 * something users will hit too.
 */
export async function connectMcpHarness(opts: ConnectMcpOptions): Promise<McpHarness> {
	const runtime = createTestRuntime(opts.db, opts.runtimeOptions);
	const handlers = handlersFromRuntime(runtime);

	const server = createMcpServer();
	const [clientTransport, serverTransport] = createAuthenticatedPair({
		emdash: handlers,
		userId: opts.userId,
		userRole: opts.userRole,
		tokenScopes: opts.tokenScopes,
	});

	const client = new Client({ name: "test", version: "1.0" });

	await server.connect(serverTransport);
	await client.connect(clientTransport);

	return {
		client,
		runtime,
		handlers,
		cleanup: async () => {
			await client.close();
			await server.close();
		},
	};
}

// ---------------------------------------------------------------------------
// Result helpers
//
// MCP tool results are an array of `{ type: "text", text: string }` blocks,
// with `isError: true` on failure. Tests almost always need either the
// parsed JSON of the success payload or the raw error text. These helpers
// make both readable.
// ---------------------------------------------------------------------------

interface ToolResult {
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
	[key: string]: unknown;
}

/** Extract the first text block's content from a tool result. */
export function extractText(result: unknown): string {
	const r = result as ToolResult;
	const block = r.content?.[0];
	return typeof block?.text === "string" ? block.text : "";
}

/** Parse the JSON success payload of a tool result. Throws if the call errored. */
export function extractJson<T = unknown>(result: unknown): T {
	const r = result as ToolResult;
	if (r.isError) {
		throw new Error(`Expected success but got error: ${extractText(result)}`);
	}
	const text = extractText(result);
	if (!text) {
		throw new Error("Tool result had no text content");
	}
	return JSON.parse(text) as T;
}

/** Whether the result is an MCP error response. */
export function isErrorResult(result: unknown): boolean {
	return (result as ToolResult).isError === true;
}
