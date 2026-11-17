/**
 * The SMTP transport against real local sockets: the STARTTLS upgrade, a
 * failed upgrade and an aborted handshake, which a scripted socket cannot
 * reproduce.
 */

import { once } from "node:events";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { TLSSocket } from "node:tls";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deliverSmtp, type SmtpConfig } from "../../../src/plugins/email-smtp.js";
import type { PluginContext } from "../../../src/plugins/types.js";

// openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 36500
//   -subj /CN=localhost -addext subjectAltName=DNS:localhost
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBlTCCATugAwIBAgIUChQ2QtCzXZnNna1Gg2hcjV9H+EswCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAwOTE2MTQzNloYDzIxMjYwOTE1
MTYxNDM2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATqPFuUDZx3gsE0UA4veEB1OLlyA6YC9o1G8+/GYszceBJk8No9GRVX
zlmEmqilhpqlwMJwGNHHSCvxU7p04DcWo2kwZzAdBgNVHQ4EFgQUpHu8l086eUOe
i5WdV1A/9nia4RswHwYDVR0jBBgwFoAUpHu8l086eUOei5WdV1A/9nia4RswDwYD
VR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3QwCgYIKoZIzj0EAwID
SAAwRQIhAIqFDDFQmflrezEFOwjccoG7K/aeuEtW11OrJhAQsjmSAiAPBmFWpic+
5AUTKSNXEEoBpCnLkF7sKcxsdYx8sXcCCA==
-----END CERTIFICATE-----`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg4/JubtYWbpgL2rFC
OM8YP9cLc6sf+2oO5UN1jJeDD9ChRANCAATqPFuUDZx3gsE0UA4veEB1OLlyA6YC
9o1G8+/GYszceBJk8No9GRVXzlmEmqilhpqlwMJwGNHHSCvxU7p04DcW
-----END PRIVATE KEY-----`;

const ctx = {
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as PluginContext;

const message = { to: "recipient@example.com", subject: "Hello", text: "Hi" };

let server: Server | undefined;

async function listen(onConnection: (socket: Socket) => void): Promise<number> {
	server = createServer(onConnection);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return (server.address() as AddressInfo).port;
}

function config(port: number, overrides: Partial<SmtpConfig> = {}): SmtpConfig {
	return {
		host: "localhost",
		port,
		secure: "starttls",
		user: "mailer@example.com",
		pass: "s3cret",
		fromEmail: "noreply@example.com",
		...overrides,
	};
}

/** Call `onLine` for every CRLF-terminated line the socket receives. */
function onLines(socket: Socket, onLine: (line: string) => void): void {
	let buffered = "";
	socket.on("data", (chunk: Buffer) => {
		buffered += chunk.toString("utf8");
		let idx = buffered.indexOf("\r\n");
		while (idx >= 0) {
			const line = buffered.slice(0, idx);
			buffered = buffered.slice(idx + 2);
			onLine(line);
			idx = buffered.indexOf("\r\n");
		}
	});
}

/** Plaintext greeting and EHLO, then `onStartTls` once the client sends STARTTLS. */
function plaintextUntilStartTls(socket: Socket, onStartTls: () => void): void {
	socket.write("220 localhost ESMTP\r\n");
	onLines(socket, (line) => {
		if (line.startsWith("EHLO"))
			socket.write("250-localhost\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n");
		if (line === "STARTTLS") {
			socket.removeAllListeners("data");
			onStartTls();
		}
	});
}

beforeEach(() => {
	// The test certificate is self-signed.
	vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
});

afterEach(async () => {
	vi.unstubAllEnvs();
	if (server) {
		server.close();
		server = undefined;
	}
});

describe("SMTP over real sockets", () => {
	it("upgrades to TLS after STARTTLS and continues the session encrypted", async () => {
		const received: string[] = [];
		let servername: string | false | undefined;
		const port = await listen((socket) => {
			plaintextUntilStartTls(socket, () => {
				socket.write("220 Ready to start TLS\r\n");
				const secure = new TLSSocket(socket, { isServer: true, key: TEST_KEY, cert: TEST_CERT });
				secure.on("secure", () => {
					servername = secure.servername;
				});
				let inData = false;
				onLines(secure as unknown as Socket, (line) => {
					received.push(line);
					if (inData) {
						if (line === ".") {
							inData = false;
							secure.write("250 Queued\r\n");
						}
					} else if (line.startsWith("EHLO")) secure.write("250-localhost\r\n250 AUTH PLAIN\r\n");
					else if (line.startsWith("AUTH PLAIN")) secure.write("235 Authenticated\r\n");
					else if (line === "DATA") {
						inData = true;
						secure.write("354 Go ahead\r\n");
					} else if (line === "QUIT") secure.end("221 Bye\r\n");
					else secure.write("250 OK\r\n");
				});
			});
		});

		await deliverSmtp(config(port), message, ctx);

		expect(servername).toBe("localhost");
		expect(received[0]).toBe("EHLO example.com");
		const auth = received.find((line) => line.startsWith("AUTH PLAIN "));
		expect(Buffer.from(auth!.slice("AUTH PLAIN ".length), "base64").toString()).toBe(
			"\0mailer@example.com\0s3cret",
		);
		expect(received).toContain("MAIL FROM:<noreply@example.com>");
		expect(received).toContain("Subject: Hello");
		await vi.waitFor(() => expect(received.at(-1)).toBe("QUIT"));
	});

	it("fails without waiting for the timeout when the TLS upgrade fails", async () => {
		const port = await listen((socket) => {
			plaintextUntilStartTls(socket, () => {
				socket.write("220 Ready to start TLS\r\n");
				setTimeout(() => socket.write("this is not a TLS record\r\n"), 50);
			});
		});

		const started = Date.now();
		await expect(deliverSmtp(config(port, { timeoutMs: 10_000 }), message, ctx)).rejects.toThrow(
			/SMTP delivery via localhost:\d+ failed/,
		);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("refuses an untrusted server certificate", async () => {
		vi.unstubAllEnvs();
		let authAttempted = false;
		const port = await listen((socket) => {
			plaintextUntilStartTls(socket, () => {
				socket.write("220 Ready to start TLS\r\n");
				const secure = new TLSSocket(socket, { isServer: true, key: TEST_KEY, cert: TEST_CERT });
				secure.on("error", () => {});
				onLines(secure as unknown as Socket, (line) => {
					if (line.startsWith("AUTH")) authAttempted = true;
				});
			});
		});

		await expect(deliverSmtp(config(port), message, ctx)).rejects.toThrow(/SELF_SIGNED_CERT/);
		expect(authAttempted).toBe(false);
	});

	it("rejects bytes the server sends after accepting STARTTLS", async () => {
		const port = await listen((socket) => {
			plaintextUntilStartTls(socket, () => {
				socket.write("220 Ready to start TLS\r\n250 injected\r\n");
			});
		});

		await expect(deliverSmtp(config(port), message, ctx)).rejects.toThrow(/data after STARTTLS/);
	});

	it("closes the socket when an implicit TLS handshake stalls past the timeout", async () => {
		let closed = false;
		const port = await listen((socket) => {
			socket.resume();
			socket.on("close", () => {
				closed = true;
			});
		});

		await expect(
			deliverSmtp(config(port, { secure: "tls", timeoutMs: 200 }), message, ctx),
		).rejects.toThrow(/timed out after 200ms/);

		await vi.waitFor(() => expect(closed).toBe(true));
	});
});
