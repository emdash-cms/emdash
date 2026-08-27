import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RegistryClientConfig, RegistryPackageView } from "../../src/lib/api/registry";
import { registryQueryPolicyKey } from "../../src/lib/api/registry";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
	};
});

const mockSearchRegistryPackages = vi.fn();

vi.mock("../../src/lib/api/registry", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/registry")>(
		"../../src/lib/api/registry",
	);
	return {
		...actual,
		searchRegistryPackages: (...args: unknown[]) => mockSearchRegistryPackages(...args),
	};
});

const { RegistryBrowse } = await import("../../src/components/RegistryBrowse");

const CONFIG: RegistryClientConfig = { aggregatorUrl: "https://aggregator.test" };

function packageView(name: string): RegistryPackageView {
	return {
		did: "did:plc:publisher",
		handle: "mutable.example",
		slug: "unsafe",
		labels: [],
		profile: {
			name,
			description: name,
			license: "MIT",
			authors: [{ name: "Approved author" }],
			security: [],
			keywords: [],
		},
	} as RegistryPackageView;
}

describe("RegistryBrowse listing safety", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not flash cached publisher metadata while the required fresh search is pending", async () => {
		const unsafe = "STALE_UNAPPROVED_BROWSE_CONTENT";
		let resolveFresh!: (value: { packages: RegistryPackageView[] }) => void;
		mockSearchRegistryPackages.mockReturnValue(
			new Promise((resolve) => {
				resolveFresh = resolve;
			}),
		);
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		queryClient.setQueryData(
			["registry", "search", CONFIG.aggregatorUrl, registryQueryPolicyKey(CONFIG), ""],
			{ pages: [{ packages: [packageView(unsafe)] }], pageParams: [undefined] },
		);

		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<RegistryBrowse config={CONFIG} />
			</QueryClientProvider>,
		);

		expect(screen.container.textContent).not.toContain(unsafe);
		expect(screen.container.textContent).not.toContain("mutable.example");
		resolveFresh({ packages: [] });
		await expect
			.element(screen.getByText("No plugins have been published to this registry yet."))
			.toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(unsafe);
	});

	it("keeps approved results visible during a background refresh", async () => {
		const approved = "Approved browse result";
		mockSearchRegistryPackages.mockResolvedValueOnce({ packages: [packageView(approved)] });
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<RegistryBrowse config={CONFIG} />
			</QueryClientProvider>,
		);

		await expect.element(screen.getByRole("heading", { name: approved })).toBeInTheDocument();
		mockSearchRegistryPackages.mockReturnValue(new Promise(() => {}));
		void queryClient.refetchQueries({
			queryKey: ["registry", "search", CONFIG.aggregatorUrl, registryQueryPolicyKey(CONFIG), ""],
		});
		await vi.waitFor(() => {
			expect(mockSearchRegistryPackages).toHaveBeenCalledTimes(2);
			expect(
				queryClient.getQueryState([
					"registry",
					"search",
					CONFIG.aggregatorUrl,
					registryQueryPolicyKey(CONFIG),
					"",
				])?.fetchStatus,
			).toBe("fetching");
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(screen.getByRole("heading", { name: approved }).query()).not.toBeNull();
	});
});
