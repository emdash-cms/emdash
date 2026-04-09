import type { PluginContext } from "emdash";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({
	sendMock: vi.fn(),
}));

vi.mock("@workermailer/smtp", () => ({
	WorkerMailer: {
		send: sendMock,
	},
}));

import { workerMailerPlugin } from "../src/index.js";
import sandboxEntry from "../src/sandbox-entry.js";

function createMockContext(initial: Record<string, unknown> = {}) {
	const store = new Map<string, unknown>(Object.entries(initial));
	const kv = {
		get: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
		set: vi.fn(async (key: string, value: unknown) => {
			store.set(key, value);
		}),
		delete: vi.fn(async (key: string) => store.delete(key)),
		list: vi.fn(async (prefix = "") =>
			[...store.entries()]
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, value]) => ({ key, value })),
		),
	};
	const log = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};

	return {
		store,
		kv,
		log,
		ctx: {
			kv,
			log,
		} as unknown as PluginContext,
	};
}

function getHook(name: "plugin:install" | "email:deliver") {
	const hook = sandboxEntry.hooks?.[name];
	if (!hook) {
		throw new Error(`Expected hook ${name} to be defined`);
	}
	return hook as {
		exclusive?: boolean;
		handler: (event: unknown, ctx: PluginContext) => Promise<void>;
	};
}

function getAdminRoute() {
	const route = sandboxEntry.routes?.admin;
	if (!route) {
		throw new Error("Expected admin route to be defined");
	}
	return route.handler as (
		routeCtx: { input: unknown; request?: { url: string } },
		ctx: PluginContext,
	) => Promise<{
		blocks: Array<Record<string, unknown>>;
		toast?: { message: string; type: string };
	}>;
}

describe("workerMailerPlugin descriptor", () => {
	it("returns a valid standard plugin descriptor", () => {
		const descriptor = workerMailerPlugin();

		expect(descriptor).toMatchObject({
			id: "worker-mailer",
			version: "0.1.0",
			format: "standard",
			entrypoint: "@emdash-cms/plugin-worker-mailer/sandbox",
			capabilities: ["email:provide"],
		});
		expect(descriptor.adminPages).toHaveLength(1);
	});
});

describe("sandbox entry hooks", () => {
	beforeEach(() => {
		sendMock.mockReset();
		sendMock.mockResolvedValue(undefined);
	});

	it("declares install and exclusive delivery hooks", () => {
		const deliverHook = getHook("email:deliver");

		expect(sandboxEntry.hooks).toHaveProperty("email:deliver");
		expect(sandboxEntry.hooks).toHaveProperty("plugin:install");
		expect(deliverHook.exclusive).toBe(true);
	});

	it("seeds install defaults and removes legacy transport settings", async () => {
		const { ctx, kv, store } = createMockContext({
			"settings:transportSecurity": "starttls",
			"settings:transportSecurityMode": "legacy",
			"settings:startTls": true,
			"settings:secure": true,
		});

		await getHook("plugin:install").handler({}, ctx);

		expect(store.has("settings:transportSecurity")).toBe(false);
		expect(store.get("settings:port")).toBe(465);
		expect(store.get("settings:authType")).toBe("plain");
		expect(store.has("settings:host")).toBe(false);
		expect(store.has("settings:username")).toBe(false);
		expect(store.has("settings:password")).toBe(false);
		expect(store.has("settings:fromEmail")).toBe(false);
		expect(store.has("settings:fromName")).toBe(false);
		expect(store.has("settings:transportSecurity")).toBe(false);
		expect(store.has("settings:transportSecurityMode")).toBe(false);
		expect(store.has("settings:startTls")).toBe(false);
		expect(store.has("settings:secure")).toBe(false);
		expect(kv.delete).toHaveBeenCalledWith("settings:transportSecurity");
		expect(kv.delete).toHaveBeenCalledWith("settings:transportSecurityMode");
		expect(kv.delete).toHaveBeenCalledWith("settings:startTls");
		expect(kv.delete).toHaveBeenCalledWith("settings:secure");
	});

	it("does not overwrite existing settings during install", async () => {
		const { ctx, store } = createMockContext({
			"settings:host": "smtp.saved.example.com",
			"settings:port": 2525,
			"settings:authType": "cram-md5",
			"settings:username": "saved-user",
			"settings:password": "saved-pass",
			"settings:fromEmail": "saved@example.com",
			"settings:fromName": "Saved Name",
		});

		await getHook("plugin:install").handler({}, ctx);

		expect(store.get("settings:host")).toBe("smtp.saved.example.com");
		expect(store.get("settings:port")).toBe(2525);
		expect(store.get("settings:authType")).toBe("cram-md5");
		expect(store.get("settings:username")).toBe("saved-user");
		expect(store.get("settings:password")).toBe("saved-pass");
		expect(store.get("settings:fromEmail")).toBe("saved@example.com");
		expect(store.get("settings:fromName")).toBe("Saved Name");
	});

	it("delivers secure SMTP email and falls back fromEmail to the username", async () => {
		const { ctx, log } = createMockContext({
			"settings:host": "smtp.example.com",
			"settings:username": "mailer@example.com",
			"settings:password": "secret",
		});

		await getHook("email:deliver").handler(
			{
				message: {
					to: "hello@example.com",
					subject: "Hello",
					text: "Plain text body",
				},
			},
			ctx,
		);

		expect(sendMock).toHaveBeenCalledOnce();
		expect(sendMock).toHaveBeenCalledWith(
			{
				host: "smtp.example.com",
				port: 465,
				secure: true,
				startTls: false,
				authType: "plain",
				credentials: {
					username: "mailer@example.com",
					password: "secret",
				},
			},
			{
				from: "mailer@example.com",
				to: "hello@example.com",
				subject: "Hello",
				text: "Plain text body",
				html: undefined,
			},
		);
		expect(log.info).toHaveBeenCalledWith(
			"Delivered email to hello@example.com via Worker Mailer (implicit TLS)",
		);
	});

	it("delivers implicit TLS email with stored settings", async () => {
		const { ctx } = createMockContext({
			"settings:host": "smtp.saved.example.com",
			"settings:port": "465",
			"settings:authType": "login",
			"settings:username": "saved-user",
			"settings:password": "saved-pass",
			"settings:fromEmail": "sender@example.com",
			"settings:fromName": "Support Team",
		});

		await getHook("email:deliver").handler(
			{
				message: {
					to: "hello@example.com",
					subject: "Hello",
					text: "Plain text body",
					html: "<p>Hello</p>",
				},
			},
			ctx,
		);

		expect(sendMock).toHaveBeenCalledOnce();
		expect(sendMock).toHaveBeenCalledWith(
			{
				host: "smtp.saved.example.com",
				port: 465,
				secure: true,
				startTls: false,
				authType: "login",
				credentials: {
					username: "saved-user",
					password: "saved-pass",
				},
			},
			{
				from: {
					name: "Support Team",
					email: "sender@example.com",
				},
				to: "hello@example.com",
				subject: "Hello",
				text: "Plain text body",
				html: "<p>Hello</p>",
			},
		);
	});

	it("fails fast when required SMTP settings are missing", async () => {
		const { ctx } = createMockContext({
			"settings:host": "smtp.example.com",
		});

		await expect(
			getHook("email:deliver").handler(
				{
					message: {
						to: "hello@example.com",
						subject: "Hello",
						text: "Plain text body",
					},
				},
				ctx,
			),
		).rejects.toThrow(
			"Worker Mailer is not configured. Missing/invalid setting(s): username, password, fromEmail (or username).",
		);
		expect(sendMock).not.toHaveBeenCalled();
	});

	it("fails fast when the configured port is invalid", async () => {
		const { ctx } = createMockContext({
			"settings:host": "smtp.example.com",
			"settings:username": "mailer@example.com",
			"settings:password": "secret",
			"settings:port": 70000,
		});

		await expect(
			getHook("email:deliver").handler(
				{
					message: {
						to: "hello@example.com",
						subject: "Hello",
						text: "Plain text body",
					},
				},
				ctx,
			),
		).rejects.toThrow("Worker Mailer is not configured. Missing/invalid setting(s): port.");
		expect(sendMock).not.toHaveBeenCalled();
	});
});

describe("sandbox entry admin route", () => {
	it("renders the SMTP settings page via Block Kit", async () => {
		const { ctx } = createMockContext({
			"settings:host": "smtp.example.com",
			"settings:port": 465,
			"settings:authType": "login",
			"settings:username": "mailer@example.com",
			"settings:fromEmail": "sender@example.com",
			"settings:password": "secret",
		});

		const result = await getAdminRoute()(
			{
				input: {
					type: "page_load",
					page: "/settings",
				},
			},
			ctx,
		);

		expect(result.blocks[0]).toMatchObject({
			type: "header",
			text: "SMTP Settings",
		});
		expect(result.blocks).toContainEqual(
			expect.objectContaining({
				type: "form",
				submit: {
					label: "Save Settings",
					action_id: "save_settings",
				},
			}),
		);
		expect(result.blocks).toContainEqual(
			expect.objectContaining({
				type: "fields",
				fields: expect.arrayContaining([
					{ label: "Connection", value: "Implicit TLS / SMTPS" },
					{ label: "Password", value: "Stored" },
				]),
			}),
		);
		const formBlock = result.blocks.find((block) => block.type === "form") as {
			fields?: Array<{ action_id?: string }>;
		};
		expect(formBlock.fields).not.toContainEqual(
			expect.objectContaining({ action_id: "transportSecurity" }),
		);
	});

	it("saves SMTP settings from a Block Kit form submission", async () => {
		const { ctx, store } = createMockContext({
			"settings:transportSecurity": "starttls",
			"settings:transportSecurityMode": "legacy",
			"settings:startTls": true,
			"settings:secure": true,
			"settings:password": "existing-secret",
		});

		const result = await getAdminRoute()(
			{
				input: {
					type: "form_submit",
					action_id: "save_settings",
					values: {
						host: "smtp.example.com",
						port: "465",
						authType: "login",
						username: "mailer@example.com",
						password: "",
						fromEmail: "",
						fromName: "Support",
					},
				},
			},
			ctx,
		);

		expect(store.get("settings:host")).toBe("smtp.example.com");
		expect(store.has("settings:transportSecurity")).toBe(false);
		expect(store.has("settings:transportSecurityMode")).toBe(false);
		expect(store.has("settings:startTls")).toBe(false);
		expect(store.has("settings:secure")).toBe(false);
		expect(store.get("settings:port")).toBe(465);
		expect(store.get("settings:authType")).toBe("login");
		expect(store.get("settings:username")).toBe("mailer@example.com");
		expect(store.get("settings:password")).toBe("existing-secret");
		expect(store.has("settings:fromEmail")).toBe(false);
		expect(store.get("settings:fromName")).toBe("Support");
		expect(result.toast).toEqual({
			message: "Settings saved",
			type: "success",
		});
	});
});
