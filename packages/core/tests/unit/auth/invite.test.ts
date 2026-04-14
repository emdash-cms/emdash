import type { AuthAdapter, EmailSendFn } from "@emdash-cms/auth";
import type { EmailMessage } from "@emdash-cms/auth";
import {
	Role,
	createInvite,
	createInviteToken,
	validateInvite,
	completeInvite,
	InviteError,
	escapeHtml,
	generateToken,
} from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// Regex patterns for token validation
const TOKEN_PARAM_REGEX = /token=/;
const TOKEN_EXTRACT_REGEX = /token=([a-zA-Z0-9_-]+)/;

describe("Invite", () => {
	let db: Kysely<Database>;
	let adapter: AuthAdapter;
	let adminId: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		adapter = createKyselyAdapter(db);

		// Create an admin user (required for the invitedBy FK)
		const admin = await adapter.createUser({
			email: "admin@example.com",
			name: "Admin",
			role: Role.ADMIN,
			emailVerified: true,
		});
		adminId = admin.id;
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("createInviteToken", () => {
		it("should create a token and return url + email", async () => {
			const result = await createInviteToken(
				{ baseUrl: "https://example.com" },
				adapter,
				"new@example.com",
				Role.AUTHOR,
				adminId,
			);

			expect(result.email).toBe("new@example.com");
			expect(result.url).toContain("https://example.com");
			expect(result.url).toContain("/admin/invite/accept?token=");
			expect(result.url).toMatch(TOKEN_PARAM_REGEX);
			// Should NOT have a token field on the result
			expect("token" in result).toBe(false);
		});

		it("should preserve baseUrl path prefix in invite URL", async () => {
			const result = await createInviteToken(
				{ baseUrl: "https://example.com/_emdash" },
				adapter,
				"path@example.com",
				Role.AUTHOR,
				adminId,
			);

			expect(result.url).toContain("https://example.com/_emdash/admin/invite/accept");
		});

		it("should throw user_exists if email is already registered", async () => {
			await adapter.createUser({
				email: "existing@example.com",
				name: "Existing",
				role: Role.AUTHOR,
				emailVerified: true,
			});

			await expect(
				createInviteToken(
					{ baseUrl: "https://example.com" },
					adapter,
					"existing@example.com",
					Role.AUTHOR,
					adminId,
				),
			).rejects.toThrow(InviteError);

			try {
				await createInviteToken(
					{ baseUrl: "https://example.com" },
					adapter,
					"existing@example.com",
					Role.AUTHOR,
					adminId,
				);
			} catch (error) {
				expect(error).toBeInstanceOf(InviteError);
				expect((error as InviteError).code).toBe("user_exists");
			}
		});
	});

	describe("createInvite", () => {
		let mockEmailSend: EmailSendFn & ReturnType<typeof vi.fn>;
		let sentEmails: Array<EmailMessage>;

		beforeEach(() => {
			sentEmails = [];
			mockEmailSend = vi.fn(async (email: EmailMessage) => {
				sentEmails.push(email);
			});
		});

		it("should send email when email sender is provided", async () => {
			const result = await createInvite(
				{
					baseUrl: "https://example.com",
					siteName: "Test Site",
					email: mockEmailSend,
				},
				adapter,
				"invite@example.com",
				Role.EDITOR,
				adminId,
			);

			expect(mockEmailSend).toHaveBeenCalledOnce();
			expect(sentEmails).toHaveLength(1);
			expect(sentEmails[0]!.to).toBe("invite@example.com");
			expect(sentEmails[0]!.subject).toContain("Test Site");
			expect(sentEmails[0]!.html).toContain("Accept Invite");
			expect(sentEmails[0]!.text).toContain(result.url);
		});

		it("should return url without sending email when no sender", async () => {
			const result = await createInvite(
				{
					baseUrl: "https://example.com",
					siteName: "Test Site",
					// No email sender — copy-link fallback
				},
				adapter,
				"noemail@example.com",
				Role.AUTHOR,
				adminId,
			);

			expect(result.url).toContain("https://example.com");
			expect(result.url).toMatch(TOKEN_PARAM_REGEX);
			expect(result.email).toBe("noemail@example.com");
		});

		it("should HTML-escape siteName in email HTML body", async () => {
			await createInvite(
				{
					baseUrl: "https://example.com",
					siteName: '<script>alert("xss")</script>',
					email: mockEmailSend,
				},
				adapter,
				"xss@example.com",
				Role.AUTHOR,
				adminId,
			);

			expect(sentEmails).toHaveLength(1);
			const html = sentEmails[0]!.html!;
			// HTML body should be escaped
			expect(html).not.toContain("<script>");
			expect(html).toContain("&lt;script&gt;");
			// Plain text subject should NOT be escaped (it's not HTML)
			expect(sentEmails[0]!.subject).toContain("<script>");
		});
	});

	describe("validateInvite", () => {
		let capturedToken: string | null;

		beforeEach(() => {
			capturedToken = null;
		});

		async function createTestInvite(email: string, role: number = Role.AUTHOR): Promise<string> {
			const mockSend = vi.fn(async (msg: EmailMessage) => {
				const match = msg.text.match(TOKEN_EXTRACT_REGEX);
				capturedToken = match ? (match[1] ?? null) : null;
			});

			await createInvite(
				{
					baseUrl: "https://example.com",
					siteName: "Test",
					email: mockSend,
				},
				adapter,
				email,
				role,
				adminId,
			);

			if (!capturedToken) throw new Error("Token not captured from email");
			return capturedToken;
		}

		it("should validate a valid token and return email + role", async () => {
			const token = await createTestInvite("valid@example.com", Role.EDITOR);

			const result = await validateInvite(adapter, token);

			expect(result.email).toBe("valid@example.com");
			expect(result.role).toBe(Role.EDITOR);
		});

		it("should throw invalid_token for a nonexistent token", async () => {
			// Use a valid base64url token that doesn't exist in the DB
			const fakeToken = generateToken();

			await expect(validateInvite(adapter, fakeToken)).rejects.toThrow(InviteError);

			try {
				await validateInvite(adapter, fakeToken);
			} catch (error) {
				expect(error).toBeInstanceOf(InviteError);
				expect((error as InviteError).code).toBe("invalid_token");
			}
		});

		it("should throw invalid_token for an already-used token", async () => {
			const token = await createTestInvite("used@example.com");

			// Complete the invite (consumes the token)
			await completeInvite(adapter, token, { name: "Used User" });

			// Token should now be invalid
			await expect(validateInvite(adapter, token)).rejects.toThrow(InviteError);
		});
	});

	describe("completeInvite", () => {
		async function createTestInvite(email: string, role: number = Role.AUTHOR): Promise<string> {
			let token: string | null = null;
			const mockSend = vi.fn(async (msg: EmailMessage) => {
				const match = msg.text.match(TOKEN_EXTRACT_REGEX);
				token = match ? (match[1] ?? null) : null;
			});

			await createInvite(
				{
					baseUrl: "https://example.com",
					siteName: "Test",
					email: mockSend,
				},
				adapter,
				email,
				role,
				adminId,
			);

			if (!token) throw new Error("Token not captured from email");
			return token;
		}

		it("should create user with correct email and role", async () => {
			const token = await createTestInvite("new@example.com", Role.EDITOR);

			const user = await completeInvite(adapter, token, { name: "New User" });

			expect(user.email).toBe("new@example.com");
			expect(user.role).toBe(Role.EDITOR);
			expect(user.name).toBe("New User");
			expect(user.emailVerified).toBe(true);
		});

		it("should delete token after use (single-use)", async () => {
			const token = await createTestInvite("oneuse@example.com");

			await completeInvite(adapter, token, { name: "One Use" });

			// Second use should fail
			await expect(completeInvite(adapter, token, { name: "Second Use" })).rejects.toThrow(
				InviteError,
			);
		});

		it("should throw invalid_token for nonexistent token", async () => {
			const fakeToken = generateToken();

			await expect(completeInvite(adapter, fakeToken, { name: "Fake" })).rejects.toThrow(
				InviteError,
			);
		});
	});

	describe("escapeHtml", () => {
		it("should escape angle brackets", () => {
			expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
		});

		it("should escape ampersands", () => {
			expect(escapeHtml("a & b")).toBe("a &amp; b");
		});

		it("should escape double quotes", () => {
			expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
		});

		it("should handle strings with no special characters", () => {
			expect(escapeHtml("My Site")).toBe("My Site");
		});

		it("should handle empty string", () => {
			expect(escapeHtml("")).toBe("");
		});
	});
});
