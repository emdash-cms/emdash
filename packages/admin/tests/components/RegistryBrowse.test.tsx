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
		Link: ({ children, to, params, ...props }: any) => {
			let href = String(to ?? "");
			for (const [key, value] of Object.entries(params ?? {})) {
				href = href.replace(`$${key}`, String(value));
			}
			return (
				<a href={href} {...props}>
					{children}
				</a>
			);
		},
	};
});

const mockSearchRegistryPackages = vi.fn();
const mockResolveRegistryPackageStatus = vi.fn();
const mockResolveDidToHandle = vi.fn();

vi.mock("../../src/lib/api/registry", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/registry")>(
		"../../src/lib/api/registry",
	);
	return {
		...actual,
		searchRegistryPackages: (...args: unknown[]) => mockSearchRegistryPackages(...args),
		resolveRegistryPackageStatus: (...args: unknown[]) => mockResolveRegistryPackageStatus(...args),
		resolveDidToHandle: (...args: unknown[]) => mockResolveDidToHandle(...args),
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
		mockResolveDidToHandle.mockResolvedValue({ status: "ok", handle: "example.com" });
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

	it("shows the canonical public name and links through the handle", async () => {
		mockSearchRegistryPackages.mockResolvedValue({ packages: [packageView("My Gallery")] });
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<RegistryBrowse config={CONFIG} />
			</QueryClientProvider>,
		);

		await expect.element(screen.getByText("@example.com/unsafe")).toBeInTheDocument();
		const link = screen.getByRole("link", { name: /My Gallery/ }).element() as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("/plugins/registry/@example.com/unsafe");
	});

	it("shows a conspicuous invalid-handle state without rendering an unverified handle", async () => {
		mockSearchRegistryPackages.mockResolvedValue({ packages: [packageView("Unsafe Publisher")] });
		mockResolveDidToHandle.mockResolvedValue({ status: "invalid" });
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<RegistryBrowse config={CONFIG} />
			</QueryClientProvider>,
		);

		await expect.element(screen.getByText("INVALID HANDLE")).toBeInTheDocument();
		await expect
			.element(screen.getByText("The publisher identity cannot be verified."))
			.toBeInTheDocument();
		expect(screen.container.textContent).not.toContain("mutable.example");
	});

	it("does not report a temporary or missing handle as invalid", async () => {
		mockSearchRegistryPackages.mockResolvedValue({ packages: [packageView("Offline Publisher")] });
		mockResolveDidToHandle.mockResolvedValue({ status: "missing" });
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<RegistryBrowse config={CONFIG} />
			</QueryClientProvider>,
		);

		await expect.element(screen.getByText("Handle unavailable")).toBeInTheDocument();
		expect(screen.getByText("INVALID HANDLE").query()).toBeNull();
	});

	it("resolves an exact canonical-name search without sending it to free-text search", async () => {
		mockSearchRegistryPackages.mockResolvedValue({ packages: [] });
		mockResolveRegistryPackageStatus.mockResolvedValue({
			status: "passed",
			value: packageView("Exact Gallery"),
		});
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<RegistryBrowse config={CONFIG} />
			</QueryClientProvider>,
		);

		await screen.getByRole("searchbox").fill("@example.com/unsafe");
		await expect
			.element(screen.getByRole("heading", { name: "Exact Gallery" }))
			.toBeInTheDocument();
		expect(mockResolveRegistryPackageStatus).toHaveBeenCalledWith(CONFIG, "example.com", "unsafe");
		expect(mockSearchRegistryPackages).toHaveBeenCalledTimes(1);
	});
});
