import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist the mock runtime so it can be used in mocks
const { mockRuntime } = vi.hoisted(() => {
	const mock: any = {
		getManifest: vi.fn().mockResolvedValue({}),
		collectPageMetadata: vi.fn(),
		collectPageFragments: vi.fn(),
		// Add some properties that are accessed directly
		storage: {},
		db: {},
		hooks: {},
		email: {},
		configuredPlugins: [],
		// Add missing handlers to prevent .bind errors
		handleContentList: vi.fn(),
		handleContentGet: vi.fn(),
		handleContentCreate: vi.fn(),
		handleContentUpdate: vi.fn(),
		handleContentDelete: vi.fn(),
		handleContentListTrashed: vi.fn(),
		handleContentRestore: vi.fn(),
		handleContentPermanentDelete: vi.fn(),
		handleContentCountTrashed: vi.fn(),
		handleContentGetIncludingTrashed: vi.fn(),
		handleContentDuplicate: vi.fn(),
		handleContentPublish: vi.fn(),
		handleContentUnpublish: vi.fn(),
		handleContentSchedule: vi.fn(),
		handleContentUnschedule: vi.fn(),
		handleContentCountScheduled: vi.fn(),
		handleContentDiscardDraft: vi.fn(),
		handleContentCompare: vi.fn(),
		handleContentTranslations: vi.fn(),
		handleMediaList: vi.fn(),
		handleMediaGet: vi.fn(),
		handleMediaCreate: vi.fn(),
		handleMediaUpdate: vi.fn(),
		handleMediaDelete: vi.fn(),
		handleRevisionList: vi.fn(),
		handleRevisionGet: vi.fn(),
		handleRevisionRestore: vi.fn(),
		handlePluginApiRoute: vi.fn(),
		getPluginRouteMeta: vi.fn(),
		getMediaProvider: vi.fn(),
		getMediaProviderList: vi.fn(),
		invalidateManifest: vi.fn(),
		getSandboxRunner: vi.fn(),
		syncMarketplacePlugins: vi.fn(),
		setPluginStatus: vi.fn(),
	};

	return { mockRuntime: mock };
});

// Mock virtual modules
vi.mock("virtual:emdash/config", () => ({
	default: {
		database: { config: {} },
		plugins: [],
	},
}));

vi.mock("virtual:emdash/dialect", () => ({
	createDialect: vi.fn(),
	isSessionEnabled: vi.fn().mockReturnValue(false),
	getD1Binding: vi.fn(),
	getDefaultConstraint: vi.fn(),
	getBookmarkCookieName: vi.fn(),
	createSessionDialect: vi.fn(),
}));

vi.mock("virtual:emdash/media-providers", () => ({
	mediaProviders: [],
}));

vi.mock("virtual:emdash/plugins", () => ({
	plugins: [],
}));

vi.mock("virtual:emdash/sandbox-runner", () => ({
	createSandboxRunner: vi.fn(),
	sandboxEnabled: false,
}));

vi.mock("virtual:emdash/sandboxed-plugins", () => ({
	sandboxedPlugins: [],
}));

vi.mock("virtual:emdash/storage", () => ({
	createStorage: vi.fn(),
}));

// Mock astro:middleware
vi.mock("astro:middleware", () => ({
	defineMiddleware: (fn: any) => fn,
}));

// Mock EmDashRuntime
vi.mock("../../../src/emdash-runtime.js", () => ({
	EmDashRuntime: {
		create: vi.fn().mockResolvedValue(mockRuntime),
	},
}));

// Import the middleware
import { onRequest } from "../../../src/astro/middleware.js";

describe("EmDash Middleware", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("initializes runtime and attaches methods for all pages", async () => {
		const context = {
			request: new Request("https://example.com/some-page"),
			url: new URL("https://example.com/some-page"),
			locals: {} as any,
			cookies: {
				get: vi.fn().mockReturnValue({ value: undefined }),
			},
			redirect: vi.fn(),
		};

		const next = vi.fn().mockResolvedValue(new Response());

		await onRequest(context as any, next);

		expect(context.locals.emdash).toBeDefined();
		expect(context.locals.emdash.collectPageMetadata).toBeDefined();
		expect(context.locals.emdash.collectPageFragments).toBeDefined();

		// Verify they are bound to the runtime
		const pageCtx = {} as any;
		await context.locals.emdash.collectPageMetadata(pageCtx);
		expect(mockRuntime.collectPageMetadata).toHaveBeenCalledWith(pageCtx);

		await context.locals.emdash.collectPageFragments(pageCtx);
		expect(mockRuntime.collectPageFragments).toHaveBeenCalledWith(pageCtx);
	});
});
