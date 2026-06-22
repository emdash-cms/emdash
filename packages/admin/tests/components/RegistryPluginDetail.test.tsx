import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RegistryClientConfig,
	RegistryPackageView,
	RegistryReleaseView,
} from "../../src/lib/api/registry";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
		useNavigate: () => vi.fn(),
	};
});

const mockGetRegistryPackage = vi.fn();
const mockResolveRegistryPackage = vi.fn();
const mockListRegistryReleases = vi.fn();

vi.mock("../../src/lib/api/registry", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/registry")>(
		"../../src/lib/api/registry",
	);
	return {
		...actual,
		getRegistryPackage: (...a: unknown[]) => mockGetRegistryPackage(...a),
		resolveRegistryPackage: (...a: unknown[]) => mockResolveRegistryPackage(...a),
		listRegistryReleases: (...a: unknown[]) => mockListRegistryReleases(...a),
		resolveDidToHandle: vi.fn(async () => ({ status: "ok", handle: "acme.dev" })),
	};
});

vi.mock("../../src/lib/api/client", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/client")>(
		"../../src/lib/api/client",
	);
	return {
		...actual,
		fetchManifest: vi.fn(async () => ({ version: "1.0.0", astroVersion: "5.0.0" })),
	};
});

vi.mock("../../src/lib/api/plugins", () => ({
	fetchPlugins: vi.fn(async () => []),
}));

const { RegistryPluginDetail } = await import("../../src/components/RegistryPluginDetail");

const CONFIG: RegistryClientConfig = { aggregatorUrl: "https://aggregator.test" };

interface PkgOverrides {
	sections?: Record<string, unknown>;
	lastUpdated?: string;
	labels?: { val?: string; src?: string }[];
}

function makePackage(overrides: PkgOverrides = {}): RegistryPackageView {
	return {
		did: "did:plc:acme",
		handle: "acme.dev",
		slug: "myplugin",
		labels: overrides.labels ?? [],
		profile: {
			name: "My Plugin",
			description: "A short description.",
			license: "MIT",
			authors: [{ name: "Acme" }],
			security: [],
			keywords: [],
			sections: overrides.sections,
			lastUpdated: overrides.lastUpdated,
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture cast to the validated view shape
	} as any;
}

interface ReleaseOverrides {
	sbom?: { format?: string; url?: string; checksum?: string };
	extensions?: Record<string, unknown>;
}

function makeRelease(overrides: ReleaseOverrides = {}): RegistryReleaseView {
	return {
		version: "1.2.3",
		indexedAt: "2025-03-01T00:00:00Z",
		labels: [],
		release: {
			sbom: overrides.sbom,
			extensions: overrides.extensions,
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture cast to the validated view shape
	} as any;
}

const RELEASE_EXTENSION_NSID = "com.emdashcms.experimental.package.releaseExtension";

function Wrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function setup(pkg: RegistryPackageView, releases: RegistryReleaseView[]) {
	mockGetRegistryPackage.mockResolvedValue(pkg);
	mockResolveRegistryPackage.mockResolvedValue(pkg);
	mockListRegistryReleases.mockResolvedValue({ releases });
}

describe("RegistryPluginDetail sections", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders one pane per non-empty section and suppresses empty ones", async () => {
		setup(
			makePackage({
				sections: {
					description: "Description body text.",
					installation: "Installation body text.",
					faq: "   ",
					security: "",
				},
			}),
			[makeRelease()],
		);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);

		// Tabs for present sections.
		await expect.element(screen.getByRole("tab", { name: "Description" })).toBeInTheDocument();
		await expect.element(screen.getByRole("tab", { name: "Installation" })).toBeInTheDocument();
		// Empty/whitespace sections produce no tab.
		expect(screen.getByRole("tab", { name: "FAQ" }).query()).toBeNull();
		expect(screen.getByRole("tab", { name: "Security" }).query()).toBeNull();
		// Default pane is the first present section (description).
		await expect.element(screen.getByText("Description body text.")).toBeInTheDocument();
	});

	it("renders sanitized markdown — a <script> in a section never reaches the DOM", async () => {
		setup(
			makePackage({
				sections: {
					description: "Safe paragraph.\n\n<script>window.__pwned = true</script>",
				},
			}),
			[makeRelease()],
		);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Safe paragraph.")).toBeInTheDocument();
		expect(screen.container.querySelector("script")).toBeNull();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe for the XSS side-effect
		expect((window as any).__pwned).toBeUndefined();
	});

	it("renders nothing (no tab bar) when there are no sections", async () => {
		setup(makePackage({ sections: undefined }), [makeRelease()]);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);
		await expect.element(screen.getByRole("heading", { name: "My Plugin" })).toBeInTheDocument();
		expect(screen.container.querySelector('[role="tab"]')).toBeNull();
	});
});

describe("RegistryPluginDetail SBOM", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shows the SBOM badge and a download link for an https url", async () => {
		setup(makePackage(), [
			makeRelease({ sbom: { format: "cyclonedx", url: "https://x/sbom.json" } }),
		]);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("SBOM · cyclonedx")).toBeInTheDocument();
		const link = screen.getByRole("link", { name: "Download SBOM" });
		await expect.element(link).toBeInTheDocument();
		await expect.element(link).toHaveAttribute("href", "https://x/sbom.json");
	});

	it("renders the badge but no download link for an unsafe (javascript:) url", async () => {
		setup(makePackage(), [makeRelease({ sbom: { format: "spdx", url: "javascript:alert(1)" } })]);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("SBOM · spdx")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Download SBOM" }).query()).toBeNull();
	});
});

describe("RegistryPluginDetail declared permissions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("derives the consent list faithfully from declaredAccess, including hook facets", async () => {
		// declaredAccess carries the hook facets; the consent list must show the
		// canonical capability strings the install handler enforces, derived via
		// the shared converter rather than a component-local flattener.
		setup(makePackage(), [
			makeRelease({
				extensions: {
					[RELEASE_EXTENSION_NSID]: {
						declaredAccess: {
							network: { request: { allowedHosts: ["api.cloudflare.com"] } },
							email: { transport: {}, events: {} },
						},
					},
				},
			}),
		]);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("hooks.email-transport:register")).toBeInTheDocument();
		await expect.element(screen.getByText("hooks.email-events:register")).toBeInTheDocument();
		await expect.element(screen.getByText("network:request")).toBeInTheDocument();
	});
});

describe("RegistryPluginDetail lastUpdated + verified tooltip", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders the publisher lastUpdated label when present", async () => {
		setup(makePackage({ lastUpdated: "2025-02-15T00:00:00Z" }), [makeRelease()]);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Updated")).toBeInTheDocument();
		await expect.element(screen.getByText("Indexed")).toBeInTheDocument();
	});

	it("exposes the labeller DID through the verified shield trigger", async () => {
		setup(makePackage({ labels: [{ val: "verified", src: "did:plc:labeller" }] }), [makeRelease()]);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);
		// The shield trigger is a focusable button whose accessible name names the labeller.
		const trigger = screen.getByRole("button", { name: /Verified publisher/ });
		await expect.element(trigger).toBeInTheDocument();
		await expect.element(trigger).toHaveAccessibleName(/did:plc:labeller/);
	});
});
