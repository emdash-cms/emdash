import type { PluginContext } from "emdash";
import type { EmailDeliverEvent } from "emdash/plugin";
import { describe, it, expect, vi } from "vitest";

import {
	cloudflareEmail,
	createCloudflareEmailDeliver,
	createPlugin,
	type CloudflareEmailConfig,
} from "../src/plugins/cloudflare-email.js";

const message = {
	to: "user@example.com",
	subject: "Your magic link",
	text: "Click here",
};

const event: EmailDeliverEvent = { message, source: "system" };

function fakeCtx(): PluginContext {
	return { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as PluginContext;
}

function fakeEnv(sendImpl?: () => Promise<{ messageId?: string }>) {
	const send = vi.fn(sendImpl ?? (async () => ({ messageId: "msg-1" })));
	return { env: { EMAIL: { send } }, send };
}

describe("cloudflareEmail()", () => {
	it("returns a descriptor with a bundlable entrypoint (not an in-process definition)", () => {
		// The astro integration rejects `plugins: []` entries without an
		// `entrypoint` (#1721), so the documented usage must produce a
		// descriptor the integration can statically import at build time.
		const descriptor = cloudflareEmail({ from: "cms@mails.example.com" });
		expect(descriptor.id).toBe("cloudflare-email");
		expect(descriptor.entrypoint).toBe("@emdash-cms/cloudflare/plugins/cloudflare-email");
		expect(descriptor.format).toBe("native");
		expect(descriptor.options).toEqual({ from: "cms@mails.example.com" });
		expect(descriptor.capabilities).toEqual(["hooks.email-transport:register"]);
	});

	it("rejects a missing or invalid from address", () => {
		expect(() => cloudflareEmail({ from: "" })).toThrow(/config\.from is required/);
		expect(() =>
			cloudflareEmail({ from: { email: "not-an-address" } } as CloudflareEmailConfig),
		).toThrow(/config\.from is required/);
	});
});

describe("createPlugin()", () => {
	it("returns a resolved plugin with an exclusive email:deliver hook", () => {
		const plugin = createPlugin({ from: "cms@mails.example.com" });
		expect(plugin.id).toBe("cloudflare-email");
		expect(plugin.capabilities).toEqual(["hooks.email-transport:register"]);
		const hook = plugin.hooks["email:deliver"];
		expect(hook).toBeDefined();
		expect(hook).toMatchObject({ exclusive: true });
	});

	it("rejects a missing or invalid from address", () => {
		expect(() => createPlugin({ from: "" })).toThrow(/config\.from is required/);
	});

	it("round-trips the descriptor options the virtual plugins module passes back", async () => {
		const descriptor = cloudflareEmail({ from: "cms@mails.example.com" });
		// Simulate what the generated virtual:emdash/plugins module does:
		// `createPlugin(descriptor.options)`.
		const plugin = createPlugin(descriptor.options as CloudflareEmailConfig);
		const hook = plugin.hooks["email:deliver"];
		expect(hook).toBeDefined();

		// The handler resolves the env via cloudflare:workers, which is not
		// available in vitest — assert it fails with the runtime-guard error
		// rather than a config error, proving the wiring is intact.
		await expect(hook?.handler(event, fakeCtx())).rejects.toThrow(
			/cloudflare:workers is not available/,
		);
	});
});

describe("createCloudflareEmailDeliver()", () => {
	it("sends through the binding with from/replyTo applied", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: { email: "cms@mails.example.com", name: "CMS" }, replyTo: "hello@example.com" },
			async () => env,
		);

		await deliver(event, fakeCtx());

		expect(send).toHaveBeenCalledWith({
			from: { email: "cms@mails.example.com", name: "CMS" },
			to: "user@example.com",
			subject: "Your magic link",
			text: "Click here",
			replyTo: "hello@example.com",
		});
	});

	it("accepts a bare string from and omits optional fields", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com" },
			async () => env,
		);

		await deliver(event, fakeCtx());

		expect(send).toHaveBeenCalledWith({
			from: { email: "cms@mails.example.com" },
			to: "user@example.com",
			subject: "Your magic link",
			text: "Click here",
		});
	});

	it("passes html through when present", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com" },
			async () => env,
		);

		await deliver(
			{ message: { ...message, html: "<p>Click here</p>" }, source: "system" },
			fakeCtx(),
		);

		expect(send).toHaveBeenCalledWith(expect.objectContaining({ html: "<p>Click here</p>" }));
	});

	it("resolves the binding by its configured name", async () => {
		const send = vi.fn(async () => ({ messageId: "msg-2" }));
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com", binding: "MAILER" },
			async () => ({ MAILER: { send } }),
		);

		await deliver(event, fakeCtx());

		expect(send).toHaveBeenCalledOnce();
	});

	it("throws a descriptive error when the binding is missing", async () => {
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com" },
			async () => ({}),
		);

		await expect(deliver(event, fakeCtx())).rejects.toThrow(/binding "EMAIL" not found/);
	});

	it("propagates provider errors so the pipeline can surface them", async () => {
		const { env } = fakeEnv(async () => {
			throw new Error("sender domain not verified");
		});
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com" },
			async () => env,
		);

		await expect(deliver(event, fakeCtx())).rejects.toThrow("sender domain not verified");
	});
});
