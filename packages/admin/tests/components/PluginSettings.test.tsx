/**
 * PluginSettings: auto-generated settings form from a plugin's
 * settingsSchema (#341). Covers field rendering per type, the
 * write-only secret contract, and the save payload.
 */

import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { PluginInfo, PluginSettingsResponse } from "../../src/lib/api/plugins";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={String(to ?? "")} {...props}>
				{children}
			</a>
		),
		useNavigate: () => vi.fn(),
	};
});

const mockFetchPlugin = vi.fn<() => Promise<PluginInfo>>();
const mockFetchPluginSettings = vi.fn<() => Promise<PluginSettingsResponse>>();
const mockUpdatePluginSettings =
	vi.fn<(pluginId: string, values: Record<string, unknown>) => Promise<PluginSettingsResponse>>();

vi.mock("../../src/lib/api/plugins", async () => {
	const actual = await vi.importActual("../../src/lib/api/plugins");
	return {
		...actual,
		fetchPlugin: (...args: unknown[]) => mockFetchPlugin(...(args as [])),
		fetchPluginSettings: (...args: unknown[]) => mockFetchPluginSettings(...(args as [])),
		updatePluginSettings: (...args: unknown[]) =>
			mockUpdatePluginSettings(...(args as [string, Record<string, unknown>])),
	};
});

const { PluginSettings } = await import("../../src/components/PluginSettings");

const SETTINGS: PluginSettingsResponse = {
	schema: {
		siteKey: { type: "string", label: "Turnstile Site Key", description: "Public key" },
		retries: { type: "number", label: "Retries", min: 0, max: 10 },
		enabled: { type: "boolean", label: "Enable checks" },
		mode: {
			type: "select",
			label: "Mode",
			options: [
				{ value: "fast", label: "Fast" },
				{ value: "safe", label: "Safe" },
			],
			default: "safe",
		},
		secretKey: { type: "secret", label: "Turnstile Secret Key" },
	},
	values: { siteKey: "0xAAA", retries: 3, enabled: true, mode: "safe" },
	secretsSet: { secretKey: true },
};

function Wrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<QueryClientProvider client={qc}>
			<Toasty>{children}</Toasty>
		</QueryClientProvider>
	);
}

describe("PluginSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchPlugin.mockResolvedValue({
			id: "emdash-forms",
			name: "Forms",
			version: "1.0.0",
			enabled: true,
			status: "active",
			capabilities: [],
			hasAdminPages: true,
			hasDashboardWidgets: false,
			hasHooks: false,
			hasSettings: true,
		});
		mockFetchPluginSettings.mockResolvedValue(SETTINGS);
		mockUpdatePluginSettings.mockResolvedValue(SETTINGS);
	});

	it("renders a field for every schema entry with current values", async () => {
		const screen = await render(
			<Wrapper>
				<PluginSettings pluginId="emdash-forms" />
			</Wrapper>,
		);

		const siteKey = screen.getByLabelText("Turnstile Site Key");
		await expect.element(siteKey).toBeInTheDocument();
		expect((siteKey.element() as HTMLInputElement).value).toBe("0xAAA");

		const retries = screen.getByLabelText("Retries");
		await expect.element(retries).toBeInTheDocument();
		expect((retries.element() as HTMLInputElement).value).toBe("3");

		await expect.element(screen.getByRole("switch", { name: "Enable checks" })).toBeInTheDocument();
		await expect.element(screen.getByText("Mode")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Turnstile Secret Key")).toBeInTheDocument();
	});

	it("masks stored secrets: empty input with a 'currently set' hint", async () => {
		const screen = await render(
			<Wrapper>
				<PluginSettings pluginId="emdash-forms" />
			</Wrapper>,
		);

		const secret = screen.getByLabelText("Turnstile Secret Key");
		await expect.element(secret).toBeInTheDocument();
		const input = secret.element() as HTMLInputElement;
		expect(input.value).toBe("");
		expect(input.type).toBe("password");
		expect(input.placeholder).toContain("Currently set");
		await expect.element(screen.getByText("Clear stored value")).toBeInTheDocument();
	});

	it("saves edited values but omits untouched secrets", async () => {
		const screen = await render(
			<Wrapper>
				<PluginSettings pluginId="emdash-forms" />
			</Wrapper>,
		);

		const siteKey = screen.getByLabelText("Turnstile Site Key");
		await expect.element(siteKey).toBeInTheDocument();
		await siteKey.fill("0xBBB");

		await screen.getByRole("button", { name: "Save Settings" }).first().click();

		await vi.waitFor(() => {
			expect(mockUpdatePluginSettings).toHaveBeenCalledTimes(1);
		});
		const [pluginId, values] = mockUpdatePluginSettings.mock.calls[0]!;
		expect(pluginId).toBe("emdash-forms");
		expect(values).toEqual({
			siteKey: "0xBBB",
			retries: 3,
			enabled: true,
			mode: "safe",
		});
		// Untouched secret is not sent — the stored value stays as-is.
		expect("secretKey" in values).toBe(false);
	});

	it("sends null (not empty string) for a cleared field so it reverts to the default", async () => {
		const screen = await render(
			<Wrapper>
				<PluginSettings pluginId="emdash-forms" />
			</Wrapper>,
		);

		const siteKey = screen.getByLabelText("Turnstile Site Key");
		await expect.element(siteKey).toBeInTheDocument();
		await siteKey.fill("");

		await screen.getByRole("button", { name: "Save Settings" }).first().click();

		await vi.waitFor(() => {
			expect(mockUpdatePluginSettings).toHaveBeenCalledTimes(1);
		});
		const [, values] = mockUpdatePluginSettings.mock.calls[0]!;
		// Storing "" would shadow the schema default forever; null deletes
		// the stored value server-side so the default applies again.
		expect(values.siteKey).toBeNull();
	});

	it("sends null for a cleared secret", async () => {
		const screen = await render(
			<Wrapper>
				<PluginSettings pluginId="emdash-forms" />
			</Wrapper>,
		);

		await expect.element(screen.getByLabelText("Turnstile Secret Key")).toBeInTheDocument();
		await screen.getByText("Clear stored value").click();
		await screen.getByRole("button", { name: "Save Settings" }).first().click();

		await vi.waitFor(() => {
			expect(mockUpdatePluginSettings).toHaveBeenCalledTimes(1);
		});
		const [, values] = mockUpdatePluginSettings.mock.calls[0]!;
		expect(values.secretKey).toBeNull();
	});

	it("sends a typed secret value", async () => {
		const screen = await render(
			<Wrapper>
				<PluginSettings pluginId="emdash-forms" />
			</Wrapper>,
		);

		const secret = screen.getByLabelText("Turnstile Secret Key");
		await expect.element(secret).toBeInTheDocument();
		await secret.fill("new-secret");
		await screen.getByRole("button", { name: "Save Settings" }).first().click();

		await vi.waitFor(() => {
			expect(mockUpdatePluginSettings).toHaveBeenCalledTimes(1);
		});
		const [, values] = mockUpdatePluginSettings.mock.calls[0]!;
		expect(values.secretKey).toBe("new-secret");
	});

	it("shows an empty state for a plugin without settings", async () => {
		mockFetchPluginSettings.mockResolvedValue({ schema: {}, values: {}, secretsSet: {} });
		const screen = await render(
			<Wrapper>
				<PluginSettings pluginId="emdash-forms" />
			</Wrapper>,
		);
		await expect
			.element(screen.getByText("This plugin has no configurable settings."))
			.toBeInTheDocument();
	});
});
