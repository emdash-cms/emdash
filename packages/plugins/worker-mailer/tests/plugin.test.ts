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

import {
	createPlugin,
	workerMailerPlugin,
	workerMailerSandboxedPlugin,
} from "../src/index.js";
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

function getHook(
	plugin: ReturnType<typeof createPlugin>,
	name: "plugin:install" | "email:deliver",
) {
	const hook = plugin.hooks[name];
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
	it("returns a valid plugin descriptor", () => {
		const descriptor = workerMailerPlugin();

		expect(descriptor.id).toBe("worker-mailer");
		expect(descriptor.version).toBe("0.1.0");
		expect(descriptor.entrypoint).toBe("@emdash-cms/plugin-worker-mailer");
		expect(descriptor.adminPages).toHaveLength(1);
	});

	it("passes plugin options through", () => {
		const descriptor = workerMailerPlugin({
			host: "smtp.example.com",
			transportSecurity: "implicit_tls",
		});

		expect(descriptor.options).toEqual({
			host: "smtp.example.com",
			transportSecurity: "implicit_tls",
		});
	});

	it("exposes a standard sandboxed descriptor", () => {
		const descriptor = workerMailerSandboxedPlugin();

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

describe("createPlugin", () => {
	beforeEach(() => {
		sendMock.mockReset();
		sendMock.mockResolvedValue(undefined);
	});

	it("declares the email provider capability and delivery hook", () => {
		const plugin = createPlugin();
		const deliverHook = getHook(plugin, "email:deliver");

		expect(plugin.capabilities).toContain("email:provide");
		expect(plugin.hooks).toHaveProperty("email:deliver");
		expect(plugin.hooks).toHaveProperty("plugin:install");
		expect(deliverHook.exclusive).toBe(true);
	});

	it("defaults to STARTTLS configuration", () => {
		const plugin = createPlugin();
		const schema = plugin.admin!.settingsSchema!;

		expect(schema.transportSecurity).toMatchObject({
			type: "select",
			default: "starttls",
		});
		expect(schema.port).toMatchObject({
			type: "number",
			default: 587,
		});
	});

	it("switches the default port for implicit TLS", () => {
		const plugin = createPlugin({ transportSecurity: "implicit_tls" });
		const schema = plugin.admin!.settingsSchema!;

		expect(schema.transportSecurity!.default).toBe("implicit_tls");
		expect(schema.port!.default).toBe(465);
	});

	it("seeds install defaults and removes legacy transport settings", async () => {
		const plugin = createPlugin({
			host: "smtp.example.com",
			port: 2465,
			transportSecurity: "implicit_tls",
			authType: "login",
			username: "mailer",
			password: "secret",
			fromEmail: "from@example.com",
			fromName: "Site Mailer",
		});
		const { ctx, kv, store } = createMockContext({
			"settings:transportSecurityMode": "legacy",
			"settings:startTls": true,
			"settings:secure": true,
		});

		await getHook(plugin, "plugin:install").handler({}, ctx);

		expect(store.get("settings:host")).toBe("smtp.example.com");
		expect(store.get("settings:port")).toBe(2465);
		expect(store.get("settings:transportSecurity")).toBe("implicit_tls");
		expect(store.get("settings:authType")).toBe("login");
		expect(store.get("settings:username")).toBe("mailer");
		expect(store.get("settings:password")).toBe("secret");
		expect(store.get("settings:fromEmail")).toBe("from@example.com");
		expect(store.get("settings:fromName")).toBe("Site Mailer");
		expect(store.has("settings:transportSecurityMode")).toBe(false);
		expect(store.has("settings:startTls")).toBe(false);
		expect(store.has("settings:secure")).toBe(false);
		expect(kv.delete).toHaveBeenCalledWith("settings:transportSecurityMode");
		expect(kv.delete).toHaveBeenCalledWith("settings:startTls");
		expect(kv.delete).toHaveBeenCalledWith("settings:secure");
	});

	it("does not overwrite existing settings during install", async () => {
		const plugin = createPlugin({
			host: "smtp.default.example.com",
			port: 587,
			transportSecurity: "starttls",
			authType: "plain",
			username: "default-user",
			password: "default-pass",
			fromEmail: "default@example.com",
			fromName: "Default Name",
		});
		const { ctx, store } = createMockContext({
			"settings:host": "smtp.saved.example.com",
			"settings:port": 2525,
			"settings:transportSecurity": "implicit_tls",
			"settings:authType": "cram-md5",
			"settings:username": "saved-user",
			"settings:password": "saved-pass",
			"settings:fromEmail": "saved@example.com",
			"settings:fromName": "Saved Name",
		});

		await getHook(plugin, "plugin:install").handler({}, ctx);

		expect(store.get("settings:host")).toBe("smtp.saved.example.com");
		expect(store.get("settings:port")).toBe(2525);
		expect(store.get("settings:transportSecurity")).toBe("implicit_tls");
		expect(store.get("settings:authType")).toBe("cram-md5");
		expect(store.get("settings:username")).toBe("saved-user");
		expect(store.get("settings:password")).toBe("saved-pass");
		expect(store.get("settings:fromEmail")).toBe("saved@example.com");
		expect(store.get("settings:fromName")).toBe("Saved Name");
	});

	it("delivers STARTTLS email and falls back fromEmail to the username", async () => {
		const plugin = createPlugin({
			host: "smtp.example.com",
			username: "mailer@example.com",
			password: "secret",
		});
		const { ctx, log } = createMockContext();

		await getHook(plugin, "email:deliver").handler(
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
				port: 587,
				secure: false,
				startTls: true,
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
			"Delivered email to hello@example.com via Worker Mailer (starttls)",
		);
	});

	it("delivers implicit TLS email with stored settings overriding defaults", async () => {
		const plugin = createPlugin({
			host: "smtp.default.example.com",
			port: 587,
			transportSecurity: "starttls",
			authType: "plain",
			username: "default-user",
			password: "default-pass",
			fromEmail: "default@example.com",
		});
		const { ctx } = createMockContext({
			"settings:host": "smtp.saved.example.com",
			"settings:port": "465",
			"settings:transportSecurity": "implicit_tls",
			"settings:authType": "login",
			"settings:username": "saved-user",
			"settings:password": "saved-pass",
			"settings:fromEmail": "sender@example.com",
			"settings:fromName": "Support Team",
		});

		await getHook(plugin, "email:deliver").handler(
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
		const plugin = createPlugin({
			host: "smtp.example.com",
		});
		const { ctx } = createMockContext();

		await expect(
			getHook(plugin, "email:deliver").handler(
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
		const plugin = createPlugin({
			host: "smtp.example.com",
			username: "mailer@example.com",
			password: "secret",
		});
		const { ctx } = createMockContext({
			"settings:port": 70000,
		});

		await expect(
			getHook(plugin, "email:deliver").handler(
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

describe("sandbox entry", () => {
	it("renders the SMTP settings page via Block Kit", async () => {
		const { ctx } = createMockContext({
			"settings:host": "smtp.example.com",
			"settings:transportSecurity": "implicit_tls",
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
					{ label: "Security", value: "Implicit TLS" },
					{ label: "Password", value: "Stored" },
				]),
			}),
		);
	});

	it("saves SMTP settings from a Block Kit form submission", async () => {
		const { ctx, store } = createMockContext({
			"settings:password": "existing-secret",
		});

		const result = await getAdminRoute()(
			{
				input: {
					type: "form_submit",
					action_id: "save_settings",
					values: {
						host: "smtp.example.com",
						transportSecurity: "implicit_tls",
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
		expect(store.get("settings:transportSecurity")).toBe("implicit_tls");
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
