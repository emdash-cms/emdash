/**
 * Unit tests for the built-in SMTP email transport.
 *
 * Mocks the socket layer to verify protocol flow (EHLO → STARTTLS → AUTH →
 * MAIL FROM → RCPT TO → DATA → QUIT), error handling on bad reply codes,
 * and config parsing from env vars.
 */

import type { Kysely } from "kysely";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import {
	createSmtpEmailDeliver,
	deliverSmtp,
	loadSmtpConfig,
	loadSmtpConfigFromDb,
	loadSmtpConfigFromEnv,
	saveSmtpConfigToDb,
	clearSmtpConfigFromDb,
	type SmtpConfig,
} from "../../../src/plugins/email-smtp.js";
import type { EmailDeliverEvent, PluginContext } from "../../../src/plugins/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// ---------------------------------------------------------------------------
// Mock socket helpers
// ---------------------------------------------------------------------------

function makeReply(code: number, message = "OK"): string {
	return `${code} ${message}\r\n`;
}

/** Build a mock SmtpSocket that replays a scripted server conversation. */
function mockSocket(script: string[]): {
	socket: import("../../../src/plugins/email-smtp.js").SmtpSocket;
	written: string[];
} {
	const written: string[] = [];
	const incoming = script.map((s) => new TextEncoder().encode(s));
	let readIndex = 0;

	const makeReader = () => ({
		read: async () => {
			if (readIndex >= incoming.length) return { done: true };
			return { value: incoming[readIndex++], done: false };
		},
	});

	const socket: import("../../../src/plugins/email-smtp.js").SmtpSocket = {
		writer: {
			write: async (data: Uint8Array) => {
				written.push(new TextDecoder().decode(data));
			},
			close: async () => {},
		},
		reader: makeReader(),
		startTls: async () => {
			// TLS upgrade: same underlying stream, continue with same reader queue
			return {
				writer: socket.writer,
				reader: makeReader(),
				close: socket.close,
			};
		},
		close: async () => {},
	};

	return { written, socket };
}

const baseConfig: SmtpConfig = {
	host: "smtp.example.com",
	port: 587,
	secure: "starttls",
	user: "user@example.com",
	pass: "secret",
	from: "Site <noreply@example.com>",
};

const mockCtx = {
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
} as unknown as PluginContext;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadSmtpConfigFromEnv", () => {
	it("returns null when EMAIL_SMTP_HOST is unset", () => {
		delete process.env.EMAIL_SMTP_HOST;
		expect(loadSmtpConfigFromEnv()).toBeNull();
	});

	it("parses a complete config", () => {
		process.env.EMAIL_SMTP_HOST = "smtp-relay.brevo.com";
		process.env.EMAIL_SMTP_PORT = "587";
		process.env.EMAIL_SMTP_USER = "u";
		process.env.EMAIL_SMTP_PASS = "p";
		process.env.EMAIL_SMTP_FROM = "Site <noreply@example.com>";

		const config = loadSmtpConfigFromEnv();
		expect(config).toEqual({
			host: "smtp-relay.brevo.com",
			port: 587,
			secure: "starttls",
			user: "u",
			pass: "p",
			from: "Site <noreply@example.com>",
		});
	});

	it("infers secure=tls for port 465", () => {
		process.env.EMAIL_SMTP_HOST = "smtp.example.com";
		process.env.EMAIL_SMTP_PORT = "465";
		process.env.EMAIL_SMTP_USER = "u";
		process.env.EMAIL_SMTP_PASS = "p";
		delete process.env.EMAIL_SMTP_SECURE;

		const config = loadSmtpConfigFromEnv();
		expect(config?.secure).toBe("tls");
	});

	it("refuses port 25", () => {
		process.env.EMAIL_SMTP_HOST = "smtp.example.com";
		process.env.EMAIL_SMTP_PORT = "25";
		process.env.EMAIL_SMTP_USER = "u";
		process.env.EMAIL_SMTP_PASS = "p";

		expect(() => loadSmtpConfigFromEnv()).toThrow(/port 25/);
	});

	it("throws when credentials are missing", () => {
		process.env.EMAIL_SMTP_HOST = "smtp.example.com";
		process.env.EMAIL_SMTP_PORT = "587";
		delete process.env.EMAIL_SMTP_USER;
		delete process.env.EMAIL_SMTP_PASS;

		expect(() => loadSmtpConfigFromEnv()).toThrow(/EMAIL_SMTP_USER/);
	});
});

describe("deliverSmtp", () => {
	const message: EmailDeliverEvent["message"] = {
		to: "recipient@example.com",
		subject: "Hello",
		text: "Plain body",
		html: "<p>HTML body</p>",
	};

	it("completes a full STARTTLS session", async () => {
		const script = [
			makeReply(220, "smtp.example.com ESMTP ready"),
			makeReply(250, "smtp.example.com greets emdash"),
			makeReply(220, "Go ahead with TLS"),
			makeReply(250, "smtp.example.com greets emdash"),
			makeReply(334, "VXNlciBOYW1lAA=="),
			makeReply(334, "UGFzc3dvcmQA"),
			makeReply(235, "Authentication successful"),
			makeReply(250, "Sender OK"),
			makeReply(250, "Recipient OK"),
			makeReply(354, "End data with <CR><LF>.<CR><LF>"),
			makeReply(250, "Message accepted"),
		];

		const { socket, written } = mockSocket(script);
		const connectFn = vi.fn(async () => socket);

		await deliverSmtp(baseConfig, message, mockCtx, connectFn);

		expect(connectFn).toHaveBeenCalledWith("smtp.example.com", 587, "starttls");

		const transcript = written.join("");
		expect(transcript).toContain("EHLO emdash\r\n");
		expect(transcript).toContain("STARTTLS\r\n");
		expect(transcript).toContain("AUTH LOGIN\r\n");
		expect(transcript).toContain("MAIL FROM:<noreply@example.com>\r\n");
		expect(transcript).toContain("RCPT TO:<recipient@example.com>\r\n");
		expect(transcript).toContain("DATA\r\n");
		expect(transcript).toContain("Subject: Hello\r\n");
		expect(transcript).toContain("QUIT\r\n");

		expect(mockCtx.log.info).toHaveBeenCalledWith(
			"email delivered via SMTP",
			expect.objectContaining({ to: "recipient@example.com", subject: "Hello" }),
		);
	});

	it("throws on AUTH failure", async () => {
		const script = [
			makeReply(220, "ready"),
			makeReply(250, "EHLO ok"),
			makeReply(220, "TLS go"),
			makeReply(250, "EHLO ok"),
			makeReply(334, "Username"),
			makeReply(334, "Password"),
			makeReply(535, "Authentication failed"),
		];

		const { socket } = mockSocket(script);
		const connectFn = vi.fn(async () => socket);

		await expect(deliverSmtp(baseConfig, message, mockCtx, connectFn)).rejects.toThrow(
			/AUTH password failed.*535/,
		);
	});

	it("throws on bad greeting", async () => {
		const script = [makeReply(554, "Service unavailable")];
		const { socket } = mockSocket(script);
		const connectFn = vi.fn(async () => socket);

		await expect(deliverSmtp(baseConfig, message, mockCtx, connectFn)).rejects.toThrow(
			/greeting failed.*554/,
		);
	});

	it("dot-stuffs lines starting with a period", async () => {
		const script = [
			makeReply(220, "ready"),
			makeReply(250, "EHLO ok"),
			makeReply(220, "TLS go"),
			makeReply(250, "EHLO ok"),
			makeReply(334, "Username"),
			makeReply(334, "Password"),
			makeReply(235, "Auth ok"),
			makeReply(250, "Sender OK"),
			makeReply(250, "Recipient OK"),
			makeReply(354, "Go ahead"),
			makeReply(250, "Accepted"),
		];

		const { socket, written } = mockSocket(script);
		const connectFn = vi.fn(async () => socket);

		await deliverSmtp(
			baseConfig,
			{ ...message, text: "Line one\n.Line two starts with dot\nLine three" },
			mockCtx,
			connectFn,
		);

		const transcript = written.join("");
		expect(transcript).toContain("..Line two starts with dot");
	});
});

describe("createSmtpEmailDeliver", () => {
	it("returns a handler that calls deliverSmtp", async () => {
		const script = [
			makeReply(220, "ready"),
			makeReply(250, "EHLO ok"),
			makeReply(220, "TLS go"),
			makeReply(250, "EHLO ok"),
			makeReply(334, "Username"),
			makeReply(334, "Password"),
			makeReply(235, "Auth ok"),
			makeReply(250, "Sender OK"),
			makeReply(250, "Recipient OK"),
			makeReply(354, "Go ahead"),
			makeReply(250, "Accepted"),
		];

		const { socket } = mockSocket(script);
		const connectFn = vi.fn(async () => socket);
		const handler = createSmtpEmailDeliver(baseConfig, connectFn);

		const event: EmailDeliverEvent = {
			message: { to: "a@b.com", subject: "S", text: "T" },
			source: "test",
		};

		await expect(handler(event, mockCtx)).resolves.toBeUndefined();
		expect(connectFn).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// DB-backed config
// ---------------------------------------------------------------------------

const TEST_ENCRYPTION_KEY = "emdash_enc_v1_SWmb1wDbtOn-lO8UJgsKIdNps4cwuN8IulWSqsspuM";

describe("loadSmtpConfigFromDb / saveSmtpConfigToDb / clearSmtpConfigFromDb", () => {
	let db: Kysely<DatabaseSchema>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("returns null when no config is stored", async () => {
		const config = await loadSmtpConfigFromDb(db, TEST_ENCRYPTION_KEY);
		expect(config).toBeNull();
	});

	it("saves and loads a full config", async () => {
		const input: SmtpConfig = {
			host: "smtp.example.com",
			port: 587,
			secure: "starttls",
			user: "user@example.com",
			pass: "super-secret",
			from: "Site <noreply@example.com>",
		};

		await saveSmtpConfigToDb(db, TEST_ENCRYPTION_KEY, input);
		const loaded = await loadSmtpConfigFromDb(db, TEST_ENCRYPTION_KEY);

		expect(loaded).toEqual(input);
	});

	it("encrypts the password in the database", async () => {
		const input: SmtpConfig = {
			host: "smtp.example.com",
			port: 587,
			secure: "starttls",
			user: "user@example.com",
			pass: "super-secret",
		};

		await saveSmtpConfigToDb(db, TEST_ENCRYPTION_KEY, input);

		const repo = new (
			await import("../../../src/database/repositories/options.js")
		).OptionsRepository(db);
		const raw = await repo.get<string>("emdash:email:smtp:password");
		expect(raw).toBeDefined();
		expect(raw).not.toBe("super-secret");
		expect(typeof raw).toBe("string");
	});

	it("clears all config", async () => {
		const input: SmtpConfig = {
			host: "smtp.example.com",
			port: 587,
			secure: "starttls",
			user: "user@example.com",
			pass: "super-secret",
		};

		await saveSmtpConfigToDb(db, TEST_ENCRYPTION_KEY, input);
		await clearSmtpConfigFromDb(db);

		const loaded = await loadSmtpConfigFromDb(db, TEST_ENCRYPTION_KEY);
		expect(loaded).toBeNull();
	});
});

describe("loadSmtpConfig", () => {
	let db: Kysely<DatabaseSchema>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("prefers DB config over env vars", async () => {
		// Set env vars
		process.env.EMAIL_SMTP_HOST = "env-smtp.example.com";
		process.env.EMAIL_SMTP_PORT = "587";
		process.env.EMAIL_SMTP_USER = "env-user";
		process.env.EMAIL_SMTP_PASS = "env-pass";

		// Set DB config
		const dbConfig: SmtpConfig = {
			host: "db-smtp.example.com",
			port: 465,
			secure: "tls",
			user: "db-user",
			pass: "db-pass",
		};
		await saveSmtpConfigToDb(db, TEST_ENCRYPTION_KEY, dbConfig);

		const loaded = await loadSmtpConfig(db, TEST_ENCRYPTION_KEY);
		expect(loaded?.host).toBe("db-smtp.example.com");
		expect(loaded?.port).toBe(465);

		// Cleanup env
		delete process.env.EMAIL_SMTP_HOST;
		delete process.env.EMAIL_SMTP_PORT;
		delete process.env.EMAIL_SMTP_USER;
		delete process.env.EMAIL_SMTP_PASS;
	});

	it("falls back to env vars when DB is empty", async () => {
		process.env.EMAIL_SMTP_HOST = "env-smtp.example.com";
		process.env.EMAIL_SMTP_PORT = "587";
		process.env.EMAIL_SMTP_USER = "env-user";
		process.env.EMAIL_SMTP_PASS = "env-pass";

		const loaded = await loadSmtpConfig(db, TEST_ENCRYPTION_KEY);
		expect(loaded?.host).toBe("env-smtp.example.com");

		delete process.env.EMAIL_SMTP_HOST;
		delete process.env.EMAIL_SMTP_PORT;
		delete process.env.EMAIL_SMTP_USER;
		delete process.env.EMAIL_SMTP_PASS;
	});

	it("returns null when neither DB nor env is configured", async () => {
		delete process.env.EMAIL_SMTP_HOST;
		const loaded = await loadSmtpConfig(db, TEST_ENCRYPTION_KEY);
		expect(loaded).toBeNull();
	});
});
