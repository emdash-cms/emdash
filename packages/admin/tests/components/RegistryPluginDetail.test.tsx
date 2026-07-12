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
// Vitest's browser mode can't `vi.spyOn` a real ESM module namespace ("Module
// namespace is not configurable in ESM"), so overriding `evaluateReleaseViews`
// per-test goes through this mock-prefixed wrapper instead, same as the other
// network-facing exports below. Falls through to the real implementation by
// default (set once the factory resolves `actual`) so most tests exercise
// genuine label evaluation.
const mockEvaluateReleaseViews = vi.fn();

vi.mock("../../src/lib/api/registry", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/registry")>(
		"../../src/lib/api/registry",
	);
	mockEvaluateReleaseViews.mockImplementation(actual.evaluateReleaseViews);
	return {
		...actual,
		getRegistryPackage: (...a: unknown[]) => mockGetRegistryPackage(...a),
		resolveRegistryPackage: (...a: unknown[]) => mockResolveRegistryPackage(...a),
		listRegistryReleases: (...a: unknown[]) => mockListRegistryReleases(...a),
		resolveDidToHandle: vi.fn(async () => ({ status: "ok", handle: "acme.dev" })),
		evaluateReleaseViews: (...a: Parameters<typeof actual.evaluateReleaseViews>) =>
			mockEvaluateReleaseViews(...a),
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

/** A raw (unsigned) ATProto label, as the aggregator hydrates onto a package/release view. */
interface RawLabel {
	ver?: number;
	src: string;
	uri: string;
	val: string;
	cts?: string;
	cid?: string;
}

interface PkgOverrides {
	sections?: Record<string, unknown>;
	lastUpdated?: string;
	labels?: { val?: string; src?: string }[] | RawLabel[];
	uri?: string;
	cid?: string;
}

const PACKAGE_URI = "at://did:plc:acme/com.emdashcms.experimental.package.profile/myplugin";

function makePackage(overrides: PkgOverrides = {}): RegistryPackageView {
	return {
		uri: overrides.uri ?? PACKAGE_URI,
		cid: overrides.cid ?? "bafypkgcid",
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
	version?: string;
	uri?: string;
	cid?: string;
	labels?: RawLabel[];
}

function releaseUriFor(version: string): string {
	return `at://did:plc:acme/com.emdashcms.experimental.package.release/myplugin:${version}`;
}

function makeRelease(overrides: ReleaseOverrides = {}): RegistryReleaseView {
	const version = overrides.version ?? "1.2.3";
	return {
		uri: overrides.uri ?? releaseUriFor(version),
		cid: overrides.cid ?? "bafyrelcid",
		version,
		indexedAt: "2025-03-01T00:00:00Z",
		labels: overrides.labels ?? [],
		release: {
			sbom: overrides.sbom,
			extensions: overrides.extensions,
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture cast to the validated view shape
	} as any;
}

/** A well-formed `security-yanked` label applying release-wide (no `cid` -- forbidden by policy). */
function securityYankedLabel(version: string, src = "did:plc:labeler"): RawLabel {
	return {
		ver: 1,
		src,
		uri: releaseUriFor(version),
		val: "security-yanked",
		cts: "2025-01-01T00:00:00Z",
	};
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

	it("exposes the labeler DID through the verified shield trigger", async () => {
		setup(makePackage({ labels: [{ val: "verified", src: "did:plc:labeler" }] }), [makeRelease()]);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);
		// The shield trigger is a focusable button whose accessible name names the labeler.
		const trigger = screen.getByRole("button", { name: /Verified publisher/ });
		await expect.element(trigger).toBeInTheDocument();
		await expect.element(trigger).toHaveAccessibleName(/did:plc:labeler/);
	});
});

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

function makeModeration(
	overrides: Partial<import("../../src/lib/api/registry").ReleaseModeration> = {},
): import("../../src/lib/api/registry").ReleaseModeration {
	return {
		eligibility: "eligible",
		reasonCodes: [],
		blockingLabels: [],
		stateLabels: [],
		warningLabels: [],
		suppressedLabels: [],
		applicableLabels: [],
		redacted: false,
		...overrides,
	};
}

describe("RegistryPluginDetail moderation", () => {
	// `vi.clearAllMocks()` only, not `resetAllMocks`/`restoreAllMocks` --
	// those would also wipe `mockEvaluateReleaseViews`'s base implementation
	// (the real `evaluateReleaseViews`, set once when the mock factory
	// resolves), breaking every test after the first that doesn't call
	// `mockImplementationOnce` itself.
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders an error panel, disables Install, and annotates the blocked option", async () => {
		setup(makePackage(), [makeRelease(), makeRelease({ version: "1.2.2" })]);
		mockEvaluateReleaseViews
			.mockImplementationOnce(() =>
				makeModeration({
					eligibility: "blocked",
					reasonCodes: ["automated-block"],
					blockingLabels: ["malware"],
					applicableLabels: [
						{
							ver: 1,
							src: "did:plc:labeler",
							uri: releaseUriFor("1.2.3"),
							val: "malware",
							cts: "2025-01-01T00:00:00Z",
						},
					],
				}),
			)
			.mockImplementationOnce(() => makeModeration({ reasonCodes: ["eligible-assessment-pass"] }));

		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);

		await expect.element(screen.getByText("This release is blocked")).toBeInTheDocument();
		await expect.element(screen.getByText("Malware")).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: /Issued by labeler did:plc:labeler/ }))
			.toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Install" })).toBeDisabled();

		screen.getByRole("combobox", { name: "Version" }).element().click();
		const blockedOption = screen.getByRole("option", { name: /1\.2\.3/ });
		await expect.element(blockedOption).toBeInTheDocument();
		expect(blockedOption.element().textContent).toContain("blocked");
		const cleanOption = screen.getByRole("option", { name: /1\.2\.2/ });
		await expect.element(cleanOption).toBeInTheDocument();
		expect(cleanOption.element().textContent).not.toContain("blocked");
	});

	it("renders a warning panel, keeps Install enabled, and lists the warning in the consent dialog", async () => {
		setup(makePackage(), [makeRelease()]);
		mockEvaluateReleaseViews.mockImplementationOnce(() =>
			makeModeration({
				reasonCodes: ["eligible-assessment-pass", "warning-labels"],
				warningLabels: ["suspicious-code"],
				applicableLabels: [
					{
						ver: 1,
						src: "did:plc:labeler",
						uri: releaseUriFor("1.2.3"),
						val: "suspicious-code",
						cts: "2025-01-01T00:00:00Z",
					},
				],
			}),
		);

		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);

		await expect
			.element(screen.getByText("This release has moderation warnings"))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Suspicious code")).toBeInTheDocument();
		const installButton = screen.getByRole("button", { name: "Install" });
		await expect.element(installButton).toBeInTheDocument();
		await expect.element(installButton).not.toBeDisabled();

		installButton.element().click();
		await expect.element(screen.getByRole("dialog")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Moderation warnings", { exact: true }))
			.toBeInTheDocument();
		// Two occurrences: the page's own warning banner (still rendered behind
		// the modal) plus the consent dialog's warnings section.
		await expect.element(screen.getByText("Suspicious code").nth(1)).toBeInTheDocument();
		await expect.element(screen.getByText(/Issued by did:plc:labeler/).nth(0)).toBeInTheDocument();
	});

	it("renders no moderation panel and keeps Install enabled for a clean release", async () => {
		setup(makePackage(), [makeRelease()]);
		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);

		expect(screen.getByText("This release is blocked").query()).toBeNull();
		expect(screen.getByText("This release has moderation warnings").query()).toBeNull();
		await expect.element(screen.getByRole("button", { name: "Install" })).not.toBeDisabled();
	});

	it("falls back to the raw value for a label this admin build doesn't have display text for", async () => {
		setup(makePackage(), [makeRelease()]);
		mockEvaluateReleaseViews.mockImplementationOnce(() =>
			makeModeration({
				eligibility: "blocked",
				reasonCodes: ["manual-block"],
				blockingLabels: ["some-future-block-value"],
				applicableLabels: [
					{
						ver: 1,
						src: "did:plc:labeler",
						uri: releaseUriFor("1.2.3"),
						val: "some-future-block-value",
						cts: "2025-01-01T00:00:00Z",
					},
				],
			}),
		);

		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={CONFIG} />
			</Wrapper>,
		);

		await expect.element(screen.getByText("This release is blocked")).toBeInTheDocument();
		await expect.element(screen.getByText("some-future-block-value")).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Install" })).toBeDisabled();
	});

	it("keeps a security-yanked release visible in the picker but blocks it (regression vs the old silent filter)", async () => {
		// Real evaluation pipeline end to end -- no `evaluateReleaseViews` mock
		// override -- to prove the deleted `isYanked` colon-value filter isn't
		// silently hiding this release from the picker anymore.
		const configWithLabeler: RegistryClientConfig = {
			aggregatorUrl: "https://aggregator.test",
			acceptLabelers: "did:plc:labeler",
		};
		setup(makePackage(), [
			makeRelease({ version: "2.0.0", labels: [securityYankedLabel("2.0.0")] }),
			makeRelease({ version: "1.0.0" }),
		]);

		const screen = await render(
			<Wrapper>
				<RegistryPluginDetail pluginId="acme.dev/myplugin" config={configWithLabeler} />
			</Wrapper>,
		);

		await expect.element(screen.getByText("This release is blocked")).toBeInTheDocument();
		await expect.element(screen.getByText("Security yanked")).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Install" })).toBeDisabled();

		screen.getByRole("combobox", { name: "Version" }).element().click();
		const yankedOption = screen.getByRole("option", { name: /2\.0\.0/ });
		await expect.element(yankedOption).toBeInTheDocument();
		expect(yankedOption.element().textContent).toContain("blocked");
		const otherOption = screen.getByRole("option", { name: /1\.0\.0/ });
		await expect.element(otherOption).toBeInTheDocument();
		expect(otherOption.element().textContent).not.toContain("blocked");
	});
});
