import { describe, expect, it, vi } from "vitest";

import { deliverSmtp, type SmtpConfig } from "../../../src/plugins/email-smtp.js";
import type { PluginContext } from "../../../src/plugins/types.js";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("virtual:emdash/sockets", () => ({ connect }));

function fakeSocket(replies: string[]) {
	const writes: string[] = [];
	let writableClosed = false;
	const encoder = new TextEncoder();
	return {
		writes,
		isWritableClosed: () => writableClosed,
		socket: {
			opened: Promise.resolve({}),
			readable: new ReadableStream<Uint8Array>({
				start(controller) {
					for (const reply of replies) controller.enqueue(encoder.encode(reply));
				},
			}),
			writable: new WritableStream<Uint8Array>({
				write(chunk) {
					writes.push(new TextDecoder().decode(chunk));
				},
				close() {
					writableClosed = true;
				},
			}),
			close: async () => {},
			startTls: vi.fn(),
		},
	};
}

const config: SmtpConfig = {
	host: "smtp.example.com",
	port: 587,
	secure: "starttls",
	user: "user@example.com",
	pass: "secret",
	fromEmail: "noreply@example.com",
};

const ctx = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as PluginContext;

describe("SMTP over Cloudflare sockets", () => {
	it("upgrades with STARTTLS without closing the plaintext writable", async () => {
		const plain = fakeSocket(["220 ready\r\n", "250 ok\r\n", "220 go ahead\r\n"]);
		const tls = fakeSocket([
			"250 ok\r\n",
			"334 Username\r\n",
			"334 Password\r\n",
			"235 ok\r\n",
			"250 ok\r\n",
			"250 ok\r\n",
			"354 go\r\n",
			"250 queued\r\n",
		]);
		plain.socket.startTls.mockImplementation(() => {
			expect(plain.isWritableClosed()).toBe(false);
			return tls.socket;
		});
		connect.mockReturnValue(plain.socket);

		await deliverSmtp(config, { to: "a@example.com", subject: "Hi", text: "Hello" }, ctx);

		expect(connect).toHaveBeenCalledWith("smtp.example.com:587", {
			secureTransport: "starttls",
			allowHalfOpen: false,
		});
		expect(plain.socket.startTls).toHaveBeenCalledOnce();
		expect(plain.writes.join("")).toBe("EHLO emdash\r\nSTARTTLS\r\n");
		expect(tls.writes.join("")).toContain("AUTH LOGIN\r\n");
		expect(tls.writes.at(-1)).toBe("QUIT\r\n");
	});
});
