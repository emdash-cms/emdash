import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	DidHandleResolution,
	RegistryClientConfig,
	RegistryInstallResult,
	RegistryPackageView,
	RegistryReleaseView,
} from "../../src/lib/api/registry";
import { registryQueryPolicyKey } from "../../src/lib/api/registry";
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

const mockGetRegistryPackageStatus = vi.fn();
const mockResolveRegistryPackageStatus = vi.fn();
const mockListRegistryReleases = vi.fn();
const mockVerifyRegistryPlugin = vi.fn();
const mockInstallRegistryPlugin = vi.fn();
const mockResolveDidToHandle = vi.fn<(did: string) => Promise<DidHandleResolution>>(async () => ({
	status: "ok",
	handle: "acme.dev",
}));

vi.mock("../../src/lib/api/registry", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/registry")>(
		"../../src/lib/api/registry",
	);
	return {
		...actual,
		getRegistryPackageStatus: (...a: unknown[]) => mockGetRegistryPackageStatus(...a),
		resolveRegistryPackageStatus: (...a: unknown[]) => mockResolveRegistryPackageStatus(...a),
		listRegistryReleases: (...a: unknown[]) => mockListRegistryReleases(...a),
		verifyRegistryPlugin: (...a: unknown[]) => mockVerifyRegistryPlugin(...a),
		installRegistryPlugin: (...a: unknown[]) => mockInstallRegistryPlugin(...a),
		resolveDidToHandle: (did: string) => mockResolveDidToHandle(did),
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
	labels?: unknown[];
}

function makeRelease(overrides: ReleaseOverrides = {}): RegistryReleaseView {
	const cid = `bafyrei${"a".repeat(52)}`;
	return {
		uri: "at://did:plc:acme/com.emdashcms.experimental.package.release/myplugin:1.2.3",
		cid,
		did: "did:plc:acme",
		package: "myplugin",
		version: "1.2.3",
		indexedAt: "2025-03-01T00:00:00Z",
		labels: overrides.labels ?? [],
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
	mockGetRegistryPackageStatus.mockResolvedValue({ status: "passed", value: pkg });
	mockResolveRegistryPackageStatus.mockResolvedValue({ status: "passed", value: pkg });
	mockListRegistryReleases.mockResolvedValue({ releases });
}

function verificationPreview(): RegistryInstallResult {
	return {
		pluginId: "r_verified",
		publisherDid: "did:plc:acme",
		slug: "myplugin",
		version: "1.2.3",
		capabilities: ["users:read"],
		declaredAccess: { users: { read: {} } },
		mcpTools: [],
		verification: {
			profileCid: "bafy-profile",
			releaseCid: "bafy-release",
			provenance: "verified",
			policy: {
				requireProvenance: true,
				confirmation: "always",
				approvers: ["did:plc:approver"],
			},
		},
	};
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

describe("RegistryPluginDetail release withdrawal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("filters a withdrawn release even though its listing metadata passed", async () => {
		const release = makeRelease();
		setup(makePackage(), [
			makeRelease({
				labels: [
					{
						ver: 1,
						src: "did:plc:labeler",
						uri: release.uri,
						cid: release.cid,
						val: "security:yanked",
						cts: "2026-08-24T10:00:00.000Z",
					},
				],
			}),
		]);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);

		await expect.element(screen.getByText("No installable releases")).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Install" })).toBeDisabled();
	});
});

describe("RegistryPluginDetail independent install consent", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("opens consent from the server's verified bundle and provenance report", async () => {
		setup(makePackage(), [
			makeRelease({
				extensions: {
					[RELEASE_EXTENSION_NSID]: {
						declaredAccess: { content: { read: {} } },
					},
				},
			}),
		]);
		mockVerifyRegistryPlugin.mockResolvedValue(verificationPreview());
		mockInstallRegistryPlugin.mockResolvedValue(verificationPreview());
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);

		await screen.getByRole("button", { name: "Install" }).click();

		expect(mockVerifyRegistryPlugin).toHaveBeenCalledWith({
			did: "did:plc:acme",
			slug: "myplugin",
			version: "1.2.3",
		});
		await expect.element(screen.getByText("Independent verification")).toBeInTheDocument();
		await expect.element(screen.getByText("Read user accounts")).toBeInTheDocument();
		await expect.element(screen.getByText("bafy-profile")).toBeInTheDocument();
		await expect.element(screen.getByText("bafy-release")).toBeInTheDocument();
		await screen.getByRole("button", { name: "Accept & Install" }).click();
		expect(mockInstallRegistryPlugin).toHaveBeenCalledWith(
			expect.objectContaining({
				acknowledgedProfileCid: "bafy-profile",
				acknowledgedReleaseCid: "bafy-release",
			}),
		);
	});

	it("shows a verification failure without opening consent", async () => {
		setup(makePackage(), [makeRelease()]);
		mockVerifyRegistryPlugin.mockRejectedValue(new Error("Repository proof invalid"));
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);

		await screen.getByRole("button", { name: "Install" }).click();

		await expect.element(screen.getByRole("alert")).toHaveTextContent("Repository proof invalid");
		expect(screen.getByRole("dialog").query()).toBeNull();
	});

	it("blocks install when the publisher's claimed handle does not resolve back to its DID", async () => {
		mockResolveDidToHandle.mockResolvedValueOnce({ status: "invalid" });
		setup(makePackage(), [makeRelease()]);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);

		await expect
			.element(screen.getByText("We couldn't verify this publisher's identity"))
			.toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Install" })).toBeDisabled();
		expect(mockVerifyRegistryPlugin).not.toHaveBeenCalled();
	});
});

describe("RegistryPluginDetail lastUpdated and approved publisher identity", () => {
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

	it("renders an approved author name without resolving a mutable handle", async () => {
		setup(makePackage(), [makeRelease()]);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);
		await expect.element(screen.getByText(/Published by/)).toHaveTextContent("Published by Acme");
		expect(screen.container.querySelector("bdi")?.textContent).toBe("Acme");
		expect(screen.container.textContent).not.toContain("acme.dev");
	});

	it("renders a fixed unavailable state without publisher content or media requests", async () => {
		const unsafe = "UNSAFE_PUBLISHER_SENTINEL";
		mockResolveRegistryPackageStatus.mockResolvedValue({
			status: "unavailable",
			reason: "listing-unavailable",
			ignoredPublisherText: unsafe,
			mediaUrl: `https://publisher.invalid/${unsafe}.png`,
		});
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("This plugin is not available yet")).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(unsafe);
		expect(screen.container.querySelector("img")).toBeNull();
		expect(mockListRegistryReleases).not.toHaveBeenCalled();
	});

	it("suppresses cached approved content until a fresh safety result succeeds", async () => {
		const unsafe = "STALE_APPROVED_CONTENT_MUST_NOT_FLASH";
		let resolveFresh!: (value: { status: "unavailable"; reason: "listing-unavailable" }) => void;
		mockResolveRegistryPackageStatus.mockReturnValue(
			new Promise((resolve) => {
				resolveFresh = resolve;
			}),
		);
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		});
		queryClient.setQueryData(
			[
				"registry",
				"package",
				CONFIG.aggregatorUrl,
				registryQueryPolicyKey(CONFIG),
				"acme.dev",
				"myplugin",
				false,
			],
			{
				status: "passed",
				value: makePackage({ sections: { description: unsafe } }),
			},
		);

		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</QueryClientProvider>,
		);

		expect(screen.container.textContent).not.toContain(unsafe);
		resolveFresh({ status: "unavailable", reason: "listing-unavailable" });
		await expect.element(screen.getByText("This plugin is not available yet")).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(unsafe);
	});

	it("keeps approved package and release data visible during background refreshes", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		});
		setup(makePackage(), [makeRelease()]);
		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</QueryClientProvider>,
		);

		await expect.element(screen.getByRole("heading", { name: "My Plugin" })).toBeInTheDocument();
		mockResolveRegistryPackageStatus.mockReturnValue(new Promise(() => {}));
		mockListRegistryReleases.mockReturnValue(new Promise(() => {}));
		void queryClient.refetchQueries({ queryKey: ["registry"] });
		await vi.waitFor(() => {
			expect(mockResolveRegistryPackageStatus).toHaveBeenCalledTimes(2);
			expect(mockListRegistryReleases).toHaveBeenCalledTimes(2);
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(screen.getByRole("heading", { name: "My Plugin" }).query()).not.toBeNull();
		expect(screen.getByText("1.2.3").query()).not.toBeNull();
	});

	it("renders an approved package that has no releases", async () => {
		setup(makePackage(), []);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);

		await expect.element(screen.getByRole("heading", { name: "My Plugin" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Install" })).toBeDisabled();
		expect(screen.getByText("This plugin is not available yet").query()).toBeNull();
	});
});
