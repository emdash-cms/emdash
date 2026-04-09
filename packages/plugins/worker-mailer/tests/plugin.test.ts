import { describe, expect, it } from "vitest";

import { createPlugin, workerMailerPlugin } from "../src/index.js";

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
});

describe("createPlugin", () => {
	it("declares the email provider capability and delivery hook", () => {
		const plugin = createPlugin();

		expect(plugin.capabilities).toContain("email:provide");
		expect(plugin.hooks).toHaveProperty("email:deliver");
		expect(plugin.hooks).toHaveProperty("plugin:install");
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
});
