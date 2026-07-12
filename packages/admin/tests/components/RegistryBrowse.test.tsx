import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RegistryClientConfig, RegistryPackageView } from "../../src/lib/api/registry";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, props shape mirrors TanStack's Link
		Link: ({ children, to, params, ...props }: any) => {
			const pluginId = params && typeof params === "object" ? params.pluginId : undefined;
			const href = pluginId ? `${String(to)}/${pluginId}` : String(to ?? "");
			return (
				<a href={href} {...props}>
					{children}
				</a>
			);
		},
	};
});

const mockSearchRegistryPackages = vi.fn();

vi.mock("../../src/lib/api/registry", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/registry")>(
		"../../src/lib/api/registry",
	);
	return {
		...actual,
		searchRegistryPackages: (...a: unknown[]) => mockSearchRegistryPackages(...a),
		resolveDidToHandle: vi.fn(async () => ({ status: "ok", handle: "acme.dev" })),
	};
});

const { RegistryBrowse } = await import("../../src/components/RegistryBrowse");

function makePackage(overrides: Partial<RegistryPackageView> = {}): RegistryPackageView {
	return {
		uri: "at://did:plc:acme/com.emdashcms.experimental.package.profile/myplugin",
		cid: "bafypkgcid",
		did: "did:plc:acme",
		handle: "acme.dev",
		slug: "myplugin",
		labels: [],
		profile: { name: "My Plugin", description: "A short description.", license: "MIT" },
		...overrides,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture cast to the validated view shape
	} as any;
}

function Wrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const CONFIG_WITH_LABELER: RegistryClientConfig = {
	aggregatorUrl: "https://aggregator.test",
	acceptLabelers: "did:plc:labeler",
};

describe("RegistryBrowse moderation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shows a blocked indicator on a package a package-scope label blocks", async () => {
		const blockedPkg = makePackage({
			slug: "blocked-plugin",
			uri: "at://did:plc:acme/com.emdashcms.experimental.package.profile/blocked-plugin",
			profile: { name: "Blocked Plugin" },
			labels: [
				{
					ver: 1,
					src: "did:plc:labeler",
					uri: "at://did:plc:acme/com.emdashcms.experimental.package.profile/blocked-plugin",
					val: "!takedown",
					cts: "2025-01-01T00:00:00Z",
				},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw label fixture
			] as any,
		});
		const cleanPkg = makePackage({ slug: "clean-plugin", profile: { name: "Clean Plugin" } });
		mockSearchRegistryPackages.mockResolvedValue({
			packages: [blockedPkg, cleanPkg],
			cursor: undefined,
		});

		const screen = await render(
			<Wrapper>
				<RegistryBrowse config={CONFIG_WITH_LABELER} />
			</Wrapper>,
		);

		await expect.element(screen.getByText("Blocked Plugin")).toBeInTheDocument();
		await expect.element(screen.getByText("Blocked", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Clean Plugin")).toBeInTheDocument();
		// Only one "Blocked" indicator -- the clean package doesn't get one.
		expect(screen.getByText("Blocked", { exact: true }).all().length).toBe(1);
	});

	it("carries the configured acceptLabelers in the search query key", async () => {
		mockSearchRegistryPackages.mockResolvedValue({ packages: [], cursor: undefined });
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<RegistryBrowse config={CONFIG_WITH_LABELER} />
			</QueryClientProvider>,
		);

		await expect
			.element(screen.getByText("No plugins have been published to this registry yet."))
			.toBeInTheDocument();

		const keys = queryClient
			.getQueryCache()
			.getAll()
			.map((q) => q.queryKey);
		expect(
			keys.some((key) => Array.isArray(key) && key.includes(CONFIG_WITH_LABELER.acceptLabelers)),
		).toBe(true);
	});
});
