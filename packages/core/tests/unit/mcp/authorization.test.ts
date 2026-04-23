/**
 * MCP Authorization Tests
 *
 * Verifies that MCP tools enforce ownership checks and role requirements,
 * mirroring the REST API's authorization patterns.
 *
 * Tests use the MCP Client/Server SDK with InMemoryTransport, injecting
 * authInfo to simulate different users and roles.
 */

import { Role } from "@emdash-cms/auth";
import type { RoleLevel } from "@emdash-cms/auth";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EmDashHandlers } from "../../../src/astro/types.js";
import { createMcpServer } from "../../../src/mcp/server.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const INSUFFICIENT_PERMISSIONS_RE = /Insufficient permissions/i;
const INSUFFICIENT_SCOPE_RE = /Insufficient scope/i;
const NO_AUTHOR_ID_RE = /content has no authorId/i;

const AUTHOR_USER_ID = "user_author";
const OTHER_USER_ID = "user_other";
const CONTENT_ID = "01CONTENT";
const CONTENT_SLUG = "test-post";
const REVISION_ID = "01REVISION";
const MEDIA_ID = "01MEDIA";

// ---------------------------------------------------------------------------
// Mock EmDashHandlers
// ---------------------------------------------------------------------------

/** Create a minimal mock EmDashHandlers that returns content owned by `ownerId`. */
function createMockHandlers(ownerId: string = AUTHOR_USER_ID): EmDashHandlers {
	const contentItem = {
		id: CONTENT_ID,
		slug: "test-post",
		authorId: ownerId,
		status: "draft",
		title: "Test",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	const mediaItem = {
		id: MEDIA_ID,
		filename: "test.png",
		authorId: ownerId,
		mimeType: "image/png",
		size: 1024,
	};

	return {
		db: {} as EmDashHandlers["db"],
		invalidateManifest: vi.fn(),
		handleContentGet: vi.fn().mockResolvedValue({
			success: true,
			data: { item: contentItem, _rev: "rev1" },
		}),
		handleContentGetIncludingTrashed: vi.fn().mockResolvedValue({
			success: true,
			data: { item: { ...contentItem, status: "trashed" } },
		}),
		handleContentList: vi.fn().mockResolvedValue({
			success: true,
			data: { items: [contentItem] },
		}),
		handleContentCreate: vi.fn().mockResolvedValue({
			success: true,
			data: { item: contentItem },
		}),
		handleContentUpdate: vi.fn().mockResolvedValue({
			success: true,
			data: { item: contentItem },
		}),
		handleContentDelete: vi.fn().mockResolvedValue({
			success: true,
			data: { item: contentItem },
		}),
		handleContentRestore: vi.fn().mockResolvedValue({
			success: true,
			data: { item: contentItem },
		}),
		handleContentPermanentDelete: vi.fn().mockResolvedValue({
			success: true,
			data: { deleted: true },
		}),
		handleContentPublish: vi.fn().mockResolvedValue({
			success: true,
			data: { item: { ...contentItem, status: "published" } },
		}),
		handleContentUnpublish: vi.fn().mockResolvedValue({
			success: true,
			data: { item: contentItem },
		}),
		handleContentSchedule: vi.fn().mockResolvedValue({
			success: true,
			data: { item: { ...contentItem, status: "scheduled" } },
		}),
		handleContentCompare: vi.fn().mockResolvedValue({
			success: true,
			data: { live: null, draft: contentItem, hasChanges: false },
		}),
		handleContentDiscardDraft: vi.fn().mockResolvedValue({
			success: true,
			data: { item: contentItem },
		}),
		handleContentListTrashed: vi.fn().mockResolvedValue({
			success: true,
			data: { items: [] },
		}),
		handleContentDuplicate: vi.fn().mockResolvedValue({
			success: true,
			data: { item: contentItem },
		}),
		handleContentTranslations: vi.fn().mockResolvedValue({
			success: true,
			data: { translations: [] },
		}),
		handleMediaGet: vi.fn().mockResolvedValue({
			success: true,
			data: { item: mediaItem },
		}),
		handleMediaList: vi.fn().mockResolvedValue({
			success: true,
			data: { items: [mediaItem] },
		}),
		handleMediaUpdate: vi.fn().mockResolvedValue({
			success: true,
			data: { item: mediaItem },
		}),
		handleMediaDelete: vi.fn().mockResolvedValue({
			success: true,
			data: { deleted: true },
		}),
		handleRevisionList: vi.fn().mockResolvedValue({
			success: true,
			data: { items: [] },
		}),
		handleRevisionGet: vi.fn().mockResolvedValue({
			success: true,
			data: {
				item: {
					id: REVISION_ID,
					collection: "post",
					entryId: CONTENT_ID,
					authorId: ownerId,
					data: {},
				},
			},
		}),
		handleRevisionRestore: vi.fn().mockResolvedValue({
			success: true,
			data: { item: contentItem },
		}),
	} as unknown as EmDashHandlers;
}

// ---------------------------------------------------------------------------
// Transport helper
//
// InMemoryTransport supports passing authInfo on send(). We create a
// subclass that automatically injects authInfo on every message sent from
// the client side, simulating the HTTP transport's auth injection.
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
				? (options.authInfo.extra as Record<string, unknown>)
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

/**
 * Create a linked transport pair where the client side injects authInfo.
 */
function createAuthenticatedPair(authInfo: {
	emdash: EmDashHandlers;
	userId: string;
	userRole: RoleLevel;
	tokenScopes?: string[];
}): [AuthInjectingTransport, InMemoryTransport] {
	const clientTransport = new AuthInjectingTransport(authInfo);
	const serverTransport = new InMemoryTransport();
	// Link them (accessing private field)
	(clientTransport as unknown as Record<string, unknown>)._otherTransport = serverTransport;
	(serverTransport as unknown as Record<string, unknown>)._otherTransport = clientTransport;
	return [clientTransport, serverTransport];
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

async function setupMcpPair(opts: {
	userId: string;
	userRole: RoleLevel;
	handlers?: EmDashHandlers;
	tokenScopes?: string[];
}): Promise<{ client: Client; cleanup: () => Promise<void> }> {
	const handlers = opts.handlers ?? createMockHandlers();
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
		cleanup: async () => {
			await client.close();
			await server.close();
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP Authorization", () => {
	let client: Client;
	let cleanup: () => Promise<void>;

	afterEach(async () => {
		if (cleanup) await cleanup();
	});

	// -----------------------------------------------------------------------
	// Ownership checks: CONTRIBUTOR cannot modify others' content
	// -----------------------------------------------------------------------

	describe("content ownership enforcement", () => {
		it("CONTRIBUTOR cannot update another user's content", async () => {
			// Content owned by AUTHOR_USER_ID, caller is OTHER_USER_ID with CONTRIBUTOR role
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.CONTRIBUTOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_update",
				arguments: {
					collection: "post",
					id: CONTENT_ID,
					data: { title: "Hacked" },
				},
			});

			// CONTRIBUTOR role is below AUTHOR minimum
			expect(result.isError).toBe(true);
			const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
			expect(text).toMatch(INSUFFICIENT_PERMISSIONS_RE);
		});

		it("AUTHOR can update their own content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: AUTHOR_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_update",
				arguments: {
					collection: "post",
					id: CONTENT_ID,
					data: { title: "My update" },
				},
			});

			expect(result.isError).toBeFalsy();
			expect(handlers.handleContentUpdate).toHaveBeenCalled();
		});

		it("AUTHOR cannot update another user's content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_update",
				arguments: {
					collection: "post",
					id: CONTENT_ID,
					data: { title: "Hacked" },
				},
			});

			expect(result.isError).toBe(true);
			expect(handlers.handleContentUpdate).not.toHaveBeenCalled();
		});

		it("EDITOR can update any user's content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.EDITOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_update",
				arguments: {
					collection: "post",
					id: CONTENT_ID,
					data: { title: "Editor update" },
				},
			});

			expect(result.isError).toBeFalsy();
			expect(handlers.handleContentUpdate).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// content_delete ownership
	// -----------------------------------------------------------------------

	describe("content_delete ownership", () => {
		it("AUTHOR can delete their own content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: AUTHOR_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_delete",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBeFalsy();
			expect(handlers.handleContentDelete).toHaveBeenCalled();
		});

		it("AUTHOR cannot delete another user's content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_delete",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBe(true);
			expect(handlers.handleContentDelete).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// content_permanent_delete: ADMIN only
	// -----------------------------------------------------------------------

	describe("content_permanent_delete requires ADMIN", () => {
		it("EDITOR cannot permanently delete content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.EDITOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_permanent_delete",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBe(true);
			expect(handlers.handleContentPermanentDelete).not.toHaveBeenCalled();
		});

		it("ADMIN can permanently delete content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.ADMIN,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_permanent_delete",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBeFalsy();
			expect(handlers.handleContentPermanentDelete).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// content_publish ownership
	// -----------------------------------------------------------------------

	describe("content_publish ownership", () => {
		it("AUTHOR can publish their own content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: AUTHOR_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_publish",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBeFalsy();
			expect(handlers.handleContentPublish).toHaveBeenCalled();
		});

		it("AUTHOR cannot publish another user's content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_publish",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBe(true);
			expect(handlers.handleContentPublish).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// content_restore ownership
	// -----------------------------------------------------------------------

	describe("content_restore ownership", () => {
		it("AUTHOR cannot restore another user's trashed content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_restore",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBe(true);
			expect(handlers.handleContentRestore).not.toHaveBeenCalled();
		});

		it("EDITOR can restore any user's trashed content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.EDITOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_restore",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBeFalsy();
			expect(handlers.handleContentRestore).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// revision_restore ownership
	// -----------------------------------------------------------------------

	describe("revision_restore ownership", () => {
		it("AUTHOR cannot restore revision on another user's content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "revision_restore",
				arguments: { revisionId: REVISION_ID },
			});

			expect(result.isError).toBe(true);
			expect(handlers.handleRevisionRestore).not.toHaveBeenCalled();
		});

		it("EDITOR can restore revision on any content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.EDITOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "revision_restore",
				arguments: { revisionId: REVISION_ID },
			});

			expect(result.isError).toBeFalsy();
			expect(handlers.handleRevisionRestore).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// Media ownership
	// -----------------------------------------------------------------------

	describe("media ownership enforcement", () => {
		it("AUTHOR can update their own media", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: AUTHOR_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "media_update",
				arguments: { id: MEDIA_ID, alt: "Updated alt" },
			});

			expect(result.isError).toBeFalsy();
			expect(handlers.handleMediaUpdate).toHaveBeenCalled();
		});

		it("AUTHOR cannot update another user's media", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "media_update",
				arguments: { id: MEDIA_ID, alt: "Hacked" },
			});

			expect(result.isError).toBe(true);
			expect(handlers.handleMediaUpdate).not.toHaveBeenCalled();
		});

		it("AUTHOR cannot delete another user's media", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "media_delete",
				arguments: { id: MEDIA_ID },
			});

			expect(result.isError).toBe(true);
			expect(handlers.handleMediaDelete).not.toHaveBeenCalled();
		});

		it("EDITOR can delete any user's media", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.EDITOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "media_delete",
				arguments: { id: MEDIA_ID },
			});

			expect(result.isError).toBeFalsy();
			expect(handlers.handleMediaDelete).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// Token scope enforcement
	// -----------------------------------------------------------------------

	describe("token scope enforcement", () => {
		it("rejects content_update without content:write scope", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: AUTHOR_USER_ID,
				userRole: Role.ADMIN,
				handlers,
				tokenScopes: ["content:read"],
			}));

			const result = await client.callTool({
				name: "content_update",
				arguments: {
					collection: "post",
					id: CONTENT_ID,
					data: { title: "No scope" },
				},
			});

			expect(result.isError).toBe(true);
			const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
			expect(text).toMatch(INSUFFICIENT_SCOPE_RE);
		});

		it("allows content_update with content:write scope", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: AUTHOR_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
				tokenScopes: ["content:read", "content:write"],
			}));

			const result = await client.callTool({
				name: "content_update",
				arguments: {
					collection: "post",
					id: CONTENT_ID,
					data: { title: "Valid scope" },
				},
			});

			expect(result.isError).toBeFalsy();
		});

		it("session auth (no tokenScopes) allows all scopes", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: AUTHOR_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
				// No tokenScopes = session auth
			}));

			const result = await client.callTool({
				name: "content_update",
				arguments: {
					collection: "post",
					id: CONTENT_ID,
					data: { title: "Session auth" },
				},
			});

			expect(result.isError).toBeFalsy();
		});
	});

	// -----------------------------------------------------------------------
	// content_schedule ownership
	// -----------------------------------------------------------------------

	describe("content_schedule ownership", () => {
		it("AUTHOR cannot schedule another user's content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_schedule",
				arguments: {
					collection: "post",
					id: CONTENT_ID,
					scheduledAt: "2030-01-01T00:00:00Z",
				},
			});

			expect(result.isError).toBe(true);
			expect(handlers.handleContentSchedule).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// content_unpublish ownership
	// -----------------------------------------------------------------------

	describe("content_unpublish ownership", () => {
		it("AUTHOR cannot unpublish another user's content", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_unpublish",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBe(true);
			expect(handlers.handleContentUnpublish).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// resolvedId: slug -> ULID resolution before handler calls
	// -----------------------------------------------------------------------

	describe("resolvedId passthrough", () => {
		it("content_restore passes resolvedId (not slug) to handler", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: AUTHOR_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_restore",
				arguments: { collection: "post", id: CONTENT_SLUG },
			});

			expect(result.isError).toBeFalsy();
			// The mock returns item.id = CONTENT_ID. The tool should resolve
			// the slug to CONTENT_ID via extractContentId and pass that to the handler.
			expect(handlers.handleContentRestore).toHaveBeenCalledWith("post", CONTENT_ID);
		});

		it("content_discard_draft passes resolvedId (not slug) to handler", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: AUTHOR_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_discard_draft",
				arguments: { collection: "post", id: CONTENT_SLUG },
			});

			expect(result.isError).toBeFalsy();
			expect(handlers.handleContentDiscardDraft).toHaveBeenCalledWith("post", CONTENT_ID);
		});

		it("content_update passes resolvedId (not slug) to handler", async () => {
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			({ client, cleanup } = await setupMcpPair({
				userId: AUTHOR_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_update",
				arguments: {
					collection: "post",
					id: CONTENT_SLUG,
					data: { title: "Updated" },
				},
			});

			expect(result.isError).toBeFalsy();
			expect(handlers.handleContentUpdate).toHaveBeenCalledWith(
				"post",
				CONTENT_ID,
				expect.objectContaining({ data: { title: "Updated" } }),
			);
		});
	});

	// -----------------------------------------------------------------------
	// extractContentAuthorId: missing authorId
	// -----------------------------------------------------------------------

	describe("missing authorId handling", () => {
		it("returns clear error when content has no authorId", async () => {
			// Create handlers where content has no authorId (e.g. imported content)
			const handlers = createMockHandlers(AUTHOR_USER_ID);
			const contentWithoutAuthor = {
				id: CONTENT_ID,
				slug: "imported-post",
				status: "draft",
				title: "Imported",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				// no authorId
			};
			handlers.handleContentGet = vi.fn().mockResolvedValue({
				success: true,
				data: { item: contentWithoutAuthor },
			});

			({ client, cleanup } = await setupMcpPair({
				userId: AUTHOR_USER_ID,
				userRole: Role.AUTHOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_update",
				arguments: {
					collection: "post",
					id: CONTENT_ID,
					data: { title: "Should fail" },
				},
			});

			expect(result.isError).toBe(true);
			const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
			expect(text).toMatch(NO_AUTHOR_ID_RE);
		});
	});

	// -----------------------------------------------------------------------
	// Draft visibility — SUBSCRIBER must not see non-published content
	// -----------------------------------------------------------------------

	describe("draft visibility", () => {
		it("forces status=published on content_list for SUBSCRIBER", async () => {
			const handlers = createMockHandlers();
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.SUBSCRIBER,
				handlers,
			}));

			await client.callTool({
				name: "content_list",
				arguments: { collection: "post" },
			});

			expect(handlers.handleContentList).toHaveBeenCalledWith(
				"post",
				expect.objectContaining({ status: "published" }),
			);
		});

		it("ignores caller-supplied status=draft from SUBSCRIBER on content_list", async () => {
			const handlers = createMockHandlers();
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.SUBSCRIBER,
				handlers,
			}));

			await client.callTool({
				name: "content_list",
				arguments: { collection: "post", status: "draft" },
			});

			// Even though caller asked for "draft", route forces "published"
			expect(handlers.handleContentList).toHaveBeenCalledWith(
				"post",
				expect.objectContaining({ status: "published" }),
			);
		});

		it("respects caller-supplied status filter for CONTRIBUTOR on content_list", async () => {
			const handlers = createMockHandlers();
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.CONTRIBUTOR,
				handlers,
			}));

			await client.callTool({
				name: "content_list",
				arguments: { collection: "post", status: "draft" },
			});

			expect(handlers.handleContentList).toHaveBeenCalledWith(
				"post",
				expect.objectContaining({ status: "draft" }),
			);
		});

		it("hides draft items from SUBSCRIBER on content_get", async () => {
			// Default mock returns status: "draft"
			const handlers = createMockHandlers();
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.SUBSCRIBER,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_get",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBe(true);
			const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
			expect(text).toMatch(/not found/i);
		});

		it("allows SUBSCRIBER to read published items via content_get", async () => {
			const handlers = createMockHandlers();
			// Override to return published content
			handlers.handleContentGet = vi.fn().mockResolvedValue({
				success: true,
				data: {
					item: {
						id: CONTENT_ID,
						slug: CONTENT_SLUG,
						authorId: AUTHOR_USER_ID,
						status: "published",
					},
					_rev: "rev1",
				},
			});
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.SUBSCRIBER,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_get",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBeFalsy();
		});

		it("allows CONTRIBUTOR to read drafts via content_get", async () => {
			const handlers = createMockHandlers();
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.CONTRIBUTOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_get",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBeFalsy();
		});

		it("denies SUBSCRIBER on content_compare", async () => {
			const handlers = createMockHandlers();
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.SUBSCRIBER,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_compare",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBe(true);
			const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
			expect(text).toMatch(INSUFFICIENT_PERMISSIONS_RE);
			expect(handlers.handleContentCompare).not.toHaveBeenCalled();
		});

		it("denies SUBSCRIBER on content_list_trashed", async () => {
			const handlers = createMockHandlers();
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.SUBSCRIBER,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_list_trashed",
				arguments: { collection: "post" },
			});

			expect(result.isError).toBe(true);
			const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
			expect(text).toMatch(INSUFFICIENT_PERMISSIONS_RE);
			expect(handlers.handleContentListTrashed).not.toHaveBeenCalled();
		});

		it("denies SUBSCRIBER on revision_list", async () => {
			const handlers = createMockHandlers();
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.SUBSCRIBER,
				handlers,
			}));

			const result = await client.callTool({
				name: "revision_list",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBe(true);
			const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
			expect(text).toMatch(INSUFFICIENT_PERMISSIONS_RE);
			expect(handlers.handleRevisionList).not.toHaveBeenCalled();
		});

		it("filters non-published translations for SUBSCRIBER", async () => {
			const handlers = createMockHandlers();
			handlers.handleContentTranslations = vi.fn().mockResolvedValue({
				success: true,
				data: {
					translationGroup: "tg-1",
					translations: [
						{ id: "t-en", locale: "en", slug: "p", status: "published", updatedAt: "" },
						{ id: "t-fr", locale: "fr", slug: "p", status: "draft", updatedAt: "" },
					],
				},
			});
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.SUBSCRIBER,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_translations",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBeFalsy();
			const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
			expect(text).toContain("t-en");
			expect(text).not.toContain("t-fr");
		});

		it("allows CONTRIBUTOR to see all translations", async () => {
			const handlers = createMockHandlers();
			handlers.handleContentTranslations = vi.fn().mockResolvedValue({
				success: true,
				data: {
					translationGroup: "tg-1",
					translations: [
						{ id: "t-en", locale: "en", slug: "p", status: "published", updatedAt: "" },
						{ id: "t-fr", locale: "fr", slug: "p", status: "draft", updatedAt: "" },
					],
				},
			});
			({ client, cleanup } = await setupMcpPair({
				userId: OTHER_USER_ID,
				userRole: Role.CONTRIBUTOR,
				handlers,
			}));

			const result = await client.callTool({
				name: "content_translations",
				arguments: { collection: "post", id: CONTENT_ID },
			});

			expect(result.isError).toBeFalsy();
			const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
			expect(text).toContain("t-en");
			expect(text).toContain("t-fr");
		});
	});
});
