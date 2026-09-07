/**
 * Registry Plugin Detail
 *
 * Detail view for a plugin from the experimental decentralized plugin
 * registry. Resolves `(handle, slug)` directly against the configured
 * aggregator. Consent and installation route through the EmDash server,
 * which independently verifies publisher records, artifact, manifest, and
 * provenance before any write.
 *
 * Identified in the URL by a `pluginId` that is `${handle}/${slug}`.
 * The router wraps this component when `manifest.registry` is set on
 * the same route the marketplace detail uses, so existing bookmarks /
 * sidebar entries stay stable.
 */

import { Badge, Button, LinkButton, Select, Tabs } from "@cloudflare/kumo";
import type { TabsItem } from "@cloudflare/kumo";
import { declaredAccessToCapabilities, type DeclaredAccess } from "@emdash-cms/plugin-types";
import { checkEnvCompatibility } from "@emdash-cms/registry-client/env";
import { evaluateRegistryReleaseWithdrawal } from "@emdash-cms/registry-client/withdrawal";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Warning } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { fetchManifest } from "../lib/api/client.js";
import {
	PluginMcpConsentRequiredError,
	type PluginMcpConsentTool,
} from "../lib/api/marketplace.js";
import {
	artifactProxyUrl,
	canonicalCapabilitiesForDriftCheck,
	extractMediaArtifacts,
	extractSbom,
	effectiveRegistryLabelerPolicy,
	getRegistryPackageStatus,
	hostEnvFromManifest,
	installRegistryPlugin,
	listRegistryReleases,
	presentSections,
	registryQueryPolicyKey,
	releasePassesPolicy,
	resolveRegistryPackageStatus,
	resolveDidToHandle,
	sbomDownloadHref,
	verifyRegistryPlugin,
	type RegistryClientConfig,
	type RegistryInstallResult,
	type RegistryReleaseView,
	type SectionKey,
} from "../lib/api/registry.js";
import { renderMarkdown } from "../lib/markdown.js";
import { ArrowPrev } from "./ArrowIcons.js";
import { CapabilityConsentDialog } from "./CapabilityConsentDialog.js";
import { getMutationError } from "./DialogError.js";
import { PublisherIdentity } from "./PublisherHandle.js";

export interface RegistryPluginDetailProps {
	/** `${handle}/${slug}` -- the pluginId param from the route. */
	pluginId: string;
	/** Resolved manifest.registry block. Caller is responsible for the null check. */
	config: RegistryClientConfig;
}

export function RegistryPluginDetail({ pluginId, config }: RegistryPluginDetailProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [showConsent, setShowConsent] = React.useState(false);
	const [mcpConsentTools, setMcpConsentTools] = React.useState<PluginMcpConsentTool[]>([]);
	const [verificationPreview, setVerificationPreview] =
		React.useState<RegistryInstallResult | null>(null);

	// Plugins list — used to compute whether this package is already
	// installed. Same query key as elsewhere so the install mutation's
	// invalidate hook updates the install button without a manual
	// refresh.
	const { data: installedPlugins } = useQuery({
		queryKey: ["plugins"],
		queryFn: async () => {
			const { fetchPlugins } = await import("../lib/api/plugins.js");
			return fetchPlugins();
		},
	});

	// Host environment versions (`env:emdash`, `env:astro`) — used to evaluate
	// the selected release's `requires` constraints before offering install.
	// Derived from the admin manifest the shell already fetches under the same
	// query key, so this view adds no extra round-trip.
	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});
	const hostEnv = React.useMemo(() => hostEnvFromManifest(manifest), [manifest]);

	// Parse `<publisher>/<slug>` out of the route param. The publisher
	// segment is either a handle (`example.dev`) or a DID
	// (`did:plc:abc...`). Slugs are `[A-Za-z][A-Za-z0-9_-]*` (no `/`),
	// so the *last* `/` is the split (a handle could contain a `/`
	// historically, though atproto handles don't; the DID form
	// definitely doesn't).
	const slashIdx = pluginId.lastIndexOf("/");
	const publisher = slashIdx > 0 ? pluginId.slice(0, slashIdx) : "";
	const slug = slashIdx > 0 ? pluginId.slice(slashIdx + 1) : "";
	const isDid = publisher.startsWith("did:");

	// When linked by handle, resolve via `resolvePackage(handle, slug)`.
	// When linked by DID, go straight to `getPackage(did, slug)`. Either
	// way we end up with the same `RegistryPackageView` shape.
	const packageQueryEnabled = Boolean(publisher && slug);
	const {
		data: cachedPackageStatus,
		isLoading: isLoadingPkg,
		isFetchedAfterMount: isPackageFetchedAfterMount,
		error: packageQueryError,
	} = useQuery({
		queryKey: [
			"registry",
			"package",
			config.aggregatorUrl,
			registryQueryPolicyKey(config),
			publisher,
			slug,
			isDid,
		],
		queryFn: () =>
			isDid
				? getRegistryPackageStatus(config, publisher, slug)
				: resolveRegistryPackageStatus(config, publisher, slug),
		enabled: packageQueryEnabled,
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		refetchInterval: 30_000,
	});
	const packageStatus =
		isPackageFetchedAfterMount && !packageQueryError ? cachedPackageStatus : undefined;
	const pkg = packageStatus?.status === "passed" ? packageStatus.value : undefined;
	const listingUnavailable = packageStatus?.status === "unavailable";
	const { data: publisherHandleResolution } = useQuery({
		queryKey: ["registry", "publisher-handle", pkg?.did],
		queryFn: () => resolveDidToHandle(pkg!.did),
		enabled: Boolean(pkg?.did),
	});
	const publisherHandlePending = Boolean(pkg?.did) && publisherHandleResolution === undefined;
	// A conclusive round-trip mismatch blocks the UI. Indeterminate lookup failures
	// do not participate in trust decisions; the server verifies DID-bound records.
	const publisherHandleInvalid = publisherHandleResolution?.status === "invalid";

	// `listReleases` returns releases in descending semver order. The aggregator
	// contains only the aggregator's approved projection. Lexicon-invalid records
	// (`release === null`) are filtered because they carry
	// no actionable metadata and can't be installed.
	// `limit: 100` is the lexicon ceiling; one page covers the long tail of
	// real packages without needing cursor follow-up. Packages with more than
	// 100 releases would still lose access to the oldest, but that's far past
	// what a single plugin would ever ship in the experimental phase.
	const releasesQueryEnabled = Boolean(pkg?.did && slug);
	const {
		data: cachedReleasesData,
		isFetchedAfterMount: areReleasesFetchedAfterMount,
		error: releasesQueryError,
	} = useQuery({
		queryKey: [
			"registry",
			"releases",
			config.aggregatorUrl,
			registryQueryPolicyKey(config),
			pkg?.did,
			slug,
		],
		queryFn: () => listRegistryReleases(config, pkg!.did, slug, { limit: 100 }),
		enabled: releasesQueryEnabled,
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		refetchInterval: 30_000,
	});
	const releasesData =
		areReleasesFetchedAfterMount && !releasesQueryError ? cachedReleasesData : undefined;
	const labelerPolicy = React.useMemo(
		() => effectiveRegistryLabelerPolicy(config),
		[config.acceptLabelers],
	);

	const releases = React.useMemo<RegistryReleaseView[]>(
		() =>
			(releasesData?.releases ?? []).filter(
				(r) => r.release !== null && !evaluateRegistryReleaseWithdrawal(r, labelerPolicy).withdrawn,
			),
		[releasesData, labelerPolicy],
	);
	const hasFilteredAllReleases = (releasesData?.releases.length ?? 0) > 0 && releases.length === 0;

	// Default to the highest semver that passes the policy holdback. When every
	// release is still inside the holdback window, fall back to the highest
	// listed version — installation stays disabled (with the holdback banner)
	// but the picker has something selected and the per-release metadata stays
	// visible.
	const defaultVersion = React.useMemo(() => {
		if (!pkg || releases.length === 0) return undefined;
		const passes = releases.find((r) =>
			releasePassesPolicy(r, { did: pkg.did, slug }, config.policy),
		);
		return (passes ?? releases[0])?.version;
	}, [pkg, releases, slug, config.policy]);

	const [selectedVersion, setSelectedVersion] = React.useState<string | undefined>(undefined);
	// Reset during render (not after commit) when navigating between packages —
	// the component instance survives route changes, and an `effect` reset would
	// let a stale selection from package A briefly resolve against package B's
	// release list before the effect fires. Enables an "install the wrong version
	// on a fast click after a route change" race.
	const [prevPluginId, setPrevPluginId] = React.useState(pluginId);
	if (prevPluginId !== pluginId) {
		setPrevPluginId(pluginId);
		setSelectedVersion(undefined);
	}
	// Reconcile when the release list changes underneath an explicit selection
	// (the selected version got yanked between visits, the labeller config
	// changed, etc.). Dropping back to the default avoids the Select trigger
	// rendering a value with no matching option.
	if (
		selectedVersion !== undefined &&
		releases.length > 0 &&
		!releases.some((r) => r.version === selectedVersion)
	) {
		setSelectedVersion(undefined);
	}

	const effectiveVersion = selectedVersion ?? defaultVersion;
	const release = React.useMemo(
		() => releases.find((r) => r.version === effectiveVersion),
		[releases, effectiveVersion],
	);
	const isPreRelease = release ? isPreReleaseVersion(release.version) : false;

	// `release.extensions[com.emdashcms.experimental.package.releaseExtension]`
	// carries the aggregator's copy of `declaredAccess`. This list is only a
	// preliminary detail-page preview. The consent dialog uses the server's
	// direct-PDS verification response and the manifest extracted from the
	// checksum-verified bundle.
	//
	// NSID is exact-matched, not prefix-matched. RFC 0001 fixes the NSID for
	// this extension; accepting variants like `…releaseExtensionV2` would let a
	// publisher render a different permissions list than another would for the
	// same RFC-0001 fields.
	const RELEASE_EXTENSION_NSID = "com.emdashcms.experimental.package.releaseExtension";
	// `release` is lexicon-validated at the boundary; `extensions` is the
	// lexicon's open `unknown` map, so its inner shape still needs narrowing.
	const extensions = release?.release?.extensions as
		| Record<string, { declaredAccess?: DeclaredAccess }>
		| undefined;
	const ext = extensions?.[RELEASE_EXTENSION_NSID];

	const capabilities: string[] = ext?.declaredAccess
		? canonicalCapabilitiesForDriftCheck(
				declaredAccessToCapabilities(ext.declaredAccess).capabilities,
			)
		: [];

	// `profile` / `release` are validated against their lexicons at the
	// DiscoveryClient boundary, so the shape here is trustworthy (or `null`).
	// URLs still need a scheme allow-list: the lexicon's `uri` format permits
	// non-HTTP schemes (incl. `javascript:`), so an author/repo `url` going
	// straight into an `href` would be stored XSS in the authenticated admin
	// origin. `safeExternalHref` / `safeEmail` are that gate, not shape-parsing.
	const pkgProfile = pkg?.profile ?? null;
	const displayName = pkgProfile?.name;
	const description = pkgProfile?.description;
	const licenseText = pkgProfile?.license;
	const keywordList = pkgProfile?.keywords ?? [];
	const authorList = (pkgProfile?.authors ?? []).map((a) => ({
		name: a.name,
		url: safeExternalHref(a.url),
		email: safeEmail(a.email),
	}));
	const securityList = (pkgProfile?.security ?? []).flatMap((c) => {
		const url = safeExternalHref(c.url);
		const email = safeEmail(c.email);
		return url || email ? [{ url, email }] : [];
	});
	// `repo` is a release-level field (`release.repo`), not a profile field.
	const repoHref = safeExternalHref(release?.release?.repo);

	// Long-form profile sections (description / installation / faq / changelog /
	// security). Empty / whitespace-only entries are dropped by `presentSections`;
	// each surviving value goes through the shared sanitizing `renderMarkdown`.
	const sections = presentSections(pkgProfile);

	// Active section tab. Defaults to the first present section (description-first
	// by `SECTION_ORDER`). `activeSection` falls back to the default when the
	// selected section isn't present (e.g. after navigating to a different
	// package), so the Tabs trigger never renders a value with no matching pane.
	const [selectedSection, setSelectedSection] = React.useState<SectionKey | undefined>(undefined);
	const defaultSection = sections[0]?.key;
	const activeSection =
		selectedSection && sections.some((s) => s.key === selectedSection)
			? selectedSection
			: defaultSection;
	const activePane = sections.find((s) => s.key === activeSection);

	// SBOM reference on the signed release record. The download link points
	// directly at the publisher's URL (the browser fetches it client-side on
	// click), so the URL is gated through `sbomDownloadHref` before it reaches an
	// `href` — same scheme allow-list as every other publisher URL.
	const sbom = extractSbom(release?.release?.sbom);
	const sbomHref = sbom ? sbomDownloadHref(sbom.url) : null;

	// `lastUpdated` is the publisher-asserted update time on the profile;
	// `release.indexedAt` is when the aggregator indexed the release. They answer
	// different questions, so both are labelled distinctly below.
	const lastUpdated = typeof pkgProfile?.lastUpdated === "string" ? pkgProfile.lastUpdated : null;

	// Media artifacts (icon / screenshot / banner) live on the release record's
	// `artifacts` map. The publisher-supplied URLs never reach the client — we
	// address each image by its `(did, slug, version, kind, index)` coordinates,
	// and the server resolves the declared URL from the release record before
	// fetching it through its SSRF-defended, content-type-allowlisted proxy.
	const mediaArtifacts = extractMediaArtifacts(release?.release?.artifacts);
	const artifactDid = pkg?.did;
	const artifactVersion = release?.version;
	const artifactCid = release?.cid;
	const iconSrc =
		mediaArtifacts.icon && artifactDid && artifactCid
			? artifactProxyUrl({
					did: artifactDid,
					slug,
					version: artifactVersion,
					cid: artifactCid,
					kind: "icon",
				})
			: null;
	const bannerSrc =
		mediaArtifacts.banner && artifactDid && artifactCid
			? artifactProxyUrl({
					did: artifactDid,
					slug,
					version: artifactVersion,
					cid: artifactCid,
					kind: "banner",
				})
			: null;
	const screenshots =
		artifactDid && artifactCid
			? mediaArtifacts.screenshots.map((shot) => ({
					...shot,
					src: artifactProxyUrl({
						did: artifactDid,
						slug,
						version: artifactVersion,
						cid: artifactCid,
						kind: "screenshot",
						index: shot.index,
					}),
				}))
			: [];

	const policyOk =
		release && pkg ? releasePassesPolicy(release, { did: pkg.did, slug }, config.policy) : true;

	// Environment compatibility: compare the selected release's `requires`
	// constraints against the running host. `requires` is the lexicon's open
	// `unknown` value; `checkEnvCompatibility` guards its shape. Mirrors the
	// server-side install gate so the admin can't offer an install the server
	// would reject. While the manifest is still loading `hostEnv` is empty, so
	// every constraint is skipped (fail-open until the data arrives; the server
	// gate is the authority either way).
	const envMismatches = React.useMemo(() => {
		if (!release) return [];
		return checkEnvCompatibility(release.release?.requires, hostEnv);
	}, [release, hostEnv]);
	const envOk = envMismatches.length === 0;

	// Is this package already installed? Match on (publisher DID,
	// slug) -- the same key the install handler writes to plugin_states.
	const installedEntry = React.useMemo(() => {
		if (!pkg || !installedPlugins) return undefined;
		return installedPlugins.find(
			(p) =>
				p.source === "registry" && p.registryPublisherDid === pkg.did && p.registrySlug === slug,
		);
	}, [pkg, installedPlugins, slug]);
	const isInstalled = Boolean(installedEntry);
	const activeVerification =
		verificationPreview !== null &&
		verificationPreview.publisherDid === pkg?.did &&
		verificationPreview.slug === slug &&
		verificationPreview.version === release?.version
			? verificationPreview
			: null;

	const verificationMutation = useMutation({
		mutationFn: () => {
			if (!pkg || !release) throw new Error(t`Select a release before verifying it`);
			return verifyRegistryPlugin({
				did: pkg.did,
				slug,
				version: release.version,
			});
		},
		onSuccess: (result) => {
			setVerificationPreview(result);
			setMcpConsentTools(result.mcpTools);
			setShowConsent(true);
		},
	});

	const installMutation = useMutation({
		mutationFn: () => {
			if (!pkg) throw new Error("Package not loaded");
			if (!activeVerification) throw new Error(t`Verify the plugin before installing it`);
			return installRegistryPlugin({
				did: pkg.did,
				slug,
				version: activeVerification.version,
				// The server re-fetches the signed records and bundle, then
				// requires these permissions, tools, and CIDs to match the
				// evidence shown in the dialog.
				acknowledgedDeclaredAccess: activeVerification.capabilities,
				acknowledgedMcpTools: mcpConsentTools,
				acknowledgedProfileCid: activeVerification.verification.profileCid,
				acknowledgedReleaseCid: activeVerification.verification.releaseCid,
			});
		},
		onSuccess: () => {
			setShowConsent(false);
			setMcpConsentTools([]);
			setVerificationPreview(null);
			verificationMutation.reset();
			void queryClient.invalidateQueries({ queryKey: ["plugins"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			void queryClient.invalidateQueries({ queryKey: ["registry"] });
		},
		onError: (error) => {
			if (error instanceof PluginMcpConsentRequiredError) {
				setMcpConsentTools(error.tools);
				setShowConsent(true);
			}
		},
	});

	if (
		(packageQueryEnabled && (isLoadingPkg || !isPackageFetchedAfterMount)) ||
		(releasesQueryEnabled && !areReleasesFetchedAfterMount)
	) {
		return (
			<div className="space-y-6">
				<BackLink />
				<div className="animate-pulse space-y-4">
					<div className="flex items-center gap-4">
						<div className="h-16 w-16 rounded-xl bg-kumo-subtle" />
						<div className="space-y-2">
							<div className="h-6 w-48 rounded bg-kumo-subtle" />
							<div className="h-4 w-32 rounded bg-kumo-subtle" />
						</div>
					</div>
					<div className="h-4 w-full rounded bg-kumo-subtle" />
					<div className="h-4 w-3/4 rounded bg-kumo-subtle" />
				</div>
			</div>
		);
	}

	if (listingUnavailable || packageQueryError || releasesQueryError) {
		return (
			<div className="space-y-6">
				<BackLink />
				<div
					className="rounded-md border border-kumo-border bg-kumo-subtle p-4 text-kumo-default"
					role="status"
				>
					<p className="font-medium">{t`This plugin is not available yet`}</p>
					<p className="mt-1 text-sm text-kumo-subtle">
						{t`Its listing has not been approved for display. Check back later.`}
					</p>
				</div>
			</div>
		);
	}

	if (!pkg) {
		return (
			<div className="space-y-6">
				<BackLink />
				<div
					className="rounded-md border border-kumo-error bg-kumo-error/10 p-4 text-kumo-error"
					role="alert"
				>
					{t`Plugin not found. The publisher or slug may be incorrect.`}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<BackLink />

			{/* Banner */}
			{bannerSrc ? (
				<img
					src={bannerSrc}
					alt={t`${displayName ?? slug} banner`}
					className="h-40 w-full rounded-xl object-cover"
					loading="lazy"
				/>
			) : null}

			{/* Header */}
			<div className="flex flex-wrap items-start gap-4">
				<div className="overflow-hidden rounded-xl bg-kumo-subtle text-kumo-subtle">
					{iconSrc ? (
						<img
							src={iconSrc}
							alt={t`${displayName ?? slug} icon`}
							className="block h-16 w-16 object-cover"
							loading="lazy"
						/>
					) : (
						<span aria-hidden className="block h-16 w-16" />
					)}
				</div>
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-2xl font-semibold">{displayName ?? slug}</h1>
					<p className="text-sm text-kumo-subtle">
						<Trans>
							Published by{" "}
							<PublisherIdentity did={pkg.did} profile={pkg.profile} variant="detail" />
						</Trans>
					</p>
					{release ? (
						<div className="mt-1 flex flex-wrap items-center gap-2">
							<p className="text-xs text-kumo-subtle">{t`Version ${release.version}`}</p>
							{isPreRelease ? <Badge>{t`Pre-release`}</Badge> : null}
							{sbom?.format ? (
								<Badge>{t`SBOM · ${sbom.format}`}</Badge>
							) : sbom ? (
								<Badge>{t`SBOM`}</Badge>
							) : null}
							{sbomHref ? (
								<a
									href={sbomHref}
									target="_blank"
									rel="noopener noreferrer"
									download
									className="text-xs text-kumo-link hover:underline"
								>
									{t`Download SBOM`}
								</a>
							) : null}
						</div>
					) : null}
					{release ? (
						<dl className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-kumo-subtle">
							{lastUpdated ? (
								<div className="flex items-center gap-1">
									<dt className="font-medium">{t`Updated`}</dt>
									<dd>{formatDate(lastUpdated)}</dd>
								</div>
							) : null}
							<div className="flex items-center gap-1">
								<dt className="font-medium">{t`Indexed`}</dt>
								<dd>{formatDate(release.indexedAt)}</dd>
							</div>
						</dl>
					) : null}
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					{releases.length > 1 ? (
						<Select
							aria-label={t`Version`}
							className="w-full max-w-[220px]"
							value={effectiveVersion ?? ""}
							onValueChange={(v) => setSelectedVersion(v ?? undefined)}
							renderValue={(v) => (typeof v === "string" ? v : "")}
						>
							{releases.map((r) => {
								const preRelease = isPreReleaseVersion(r.version);
								const policyBlocked = !releasePassesPolicy(
									r,
									{ did: pkg.did, slug },
									config.policy,
								);
								return (
									<Select.Option key={r.version} value={r.version}>
										<span className="flex items-center gap-2">
											<span>{r.version}</span>
											{preRelease ? (
												<span className="text-xs text-kumo-subtle">{t`(pre-release)`}</span>
											) : null}
											{policyBlocked ? (
												<span className="text-xs text-kumo-subtle">{t`(too new)`}</span>
											) : null}
										</span>
									</Select.Option>
								);
							})}
						</Select>
					) : null}
					{isInstalled ? (
						<Button variant="secondary" disabled>
							{t`Installed`}
						</Button>
					) : (
						<Button
							variant="primary"
							disabled={
								!release ||
								!policyOk ||
								!envOk ||
								publisherHandlePending ||
								publisherHandleInvalid ||
								verificationMutation.isPending
							}
							onClick={() => verificationMutation.mutate()}
						>
							{verificationMutation.isPending ? t`Verifying...` : t`Install`}
						</Button>
					)}
				</div>
			</div>
			{verificationMutation.error ? (
				<div
					className="rounded-md border border-kumo-error bg-kumo-error/10 p-4 text-sm text-kumo-error"
					role="alert"
				>
					{getMutationError(verificationMutation.error)}
				</div>
			) : null}

			{publisherHandleInvalid ? (
				<div
					className="flex items-start gap-3 rounded-md border border-kumo-error bg-kumo-error/10 p-4 text-kumo-error"
					role="alert"
				>
					<Warning className="mt-0.5 h-5 w-5 shrink-0" />
					<div>
						<p className="font-medium">{t`We couldn't verify this publisher's identity`}</p>
						<p className="mt-1 text-sm text-kumo-default">
							{t`This publisher claims a name they couldn't prove they own — possibly impersonating someone else. Install is disabled. If you know the publisher and trust them, ask them to fix their identity setup before retrying.`}
						</p>
					</div>
				</div>
			) : null}

			{hasFilteredAllReleases ? (
				<div
					className="flex items-start gap-3 rounded-md border border-kumo-warning bg-kumo-warning/10 p-4 text-kumo-warning"
					role="status"
				>
					<Warning className="mt-0.5 h-5 w-5 shrink-0" />
					<div>
						<p className="font-medium">{t`No installable releases`}</p>
						<p className="mt-1 text-sm text-kumo-default">
							{t`Every published release of this plugin has been withdrawn or could not be verified. Check back later, or contact the publisher.`}
						</p>
					</div>
				</div>
			) : null}

			{/* Policy holdback notice */}
			{release && !policyOk ? (
				<div
					className="flex items-start gap-3 rounded-md border border-kumo-warning bg-kumo-warning/10 p-4 text-kumo-warning"
					role="status"
				>
					<Warning className="mt-0.5 h-5 w-5 shrink-0" />
					<div>
						<p className="font-medium">{t`Release is too new to install`}</p>
						<p className="mt-1 text-sm text-kumo-default">
							{t`Your site requires releases to be at least ${formatHoldback(config.policy?.minimumReleaseAgeSeconds ?? 0)} old before they can be installed. This release will become installable later.`}
						</p>
					</div>
				</div>
			) : null}

			{/* Environment compatibility notice. Mirrors the server install gate
			    (ENV_INCOMPATIBLE): the selected release declares `requires`
			    constraints the running host doesn't satisfy. Install is
			    disabled until the host is upgraded. */}
			{release && !envOk ? (
				<div
					className="flex items-start gap-3 rounded-md border border-kumo-warning bg-kumo-warning/10 p-4 text-kumo-warning"
					role="status"
				>
					<Warning className="mt-0.5 h-5 w-5 shrink-0" />
					<div>
						<p className="font-medium">{t`Not compatible with this environment`}</p>
						<p className="mt-1 text-sm text-kumo-default">
							{t`This release requires a newer environment than your site currently runs. Upgrade before installing.`}
						</p>
						<ul className="mt-2 space-y-1 text-sm text-kumo-default">
							{envMismatches.map((m) => (
								<li key={m.key}>
									{t`${envLabel(m.key)} ${m.required} required — you have ${m.host}.`}
								</li>
							))}
						</ul>
					</div>
				</div>
			) : null}

			{/* Description */}
			{description ? <p className="text-base text-kumo-default">{description}</p> : null}

			{/* Screenshot gallery */}
			{screenshots.length > 0 ? (
				<section aria-label={t`Screenshots`}>
					<ul className="flex snap-x gap-3 overflow-x-auto pb-2">
						{screenshots.map((shot, i) => (
							<li key={shot.index} className="shrink-0 snap-start">
								<img
									src={shot.src}
									alt={t`Screenshot ${i + 1}`}
									width={shot.width}
									height={shot.height}
									className="h-48 w-auto rounded-lg border border-kumo-default object-cover"
									loading="lazy"
								/>
							</li>
						))}
					</ul>
				</section>
			) : null}

			{/* License / keywords / repository */}
			{licenseText || repoHref || keywordList.length > 0 ? (
				<section className="flex flex-wrap items-center gap-2">
					{licenseText ? <LicenseBadge license={licenseText} /> : null}
					{keywordList.map((k) => (
						<Badge key={k}>{k}</Badge>
					))}
					{repoHref ? (
						<LinkButton href={repoHref} external variant="secondary">
							{t`View source`}
						</LinkButton>
					) : null}
				</section>
			) : null}

			{/* Authors */}
			{authorList.length > 0 ? (
				<section>
					<h2 className="text-sm font-semibold text-kumo-subtle">{t`Authors`}</h2>
					<ul className="mt-2 space-y-1">
						{authorList.map((a, i) => (
							<li
								// eslint-disable-next-line react/no-array-index-key -- authors have no stable id; index is stable within a render
								key={`${a.name}-${i}`}
								className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
							>
								<span className="font-medium text-kumo-default">{a.name}</span>
								{a.url ? (
									<a
										href={a.url}
										target="_blank"
										rel="noreferrer"
										className="text-kumo-link hover:underline"
									>
										{t`Website`}
									</a>
								) : null}
								{a.email ? (
									<a href={`mailto:${a.email}`} className="text-kumo-link hover:underline">
										{a.email}
									</a>
								) : null}
							</li>
						))}
					</ul>
				</section>
			) : null}

			{/* Security contacts */}
			{securityList.length > 0 ? (
				<section>
					<h2 className="text-sm font-semibold text-kumo-subtle">{t`Security contacts`}</h2>
					<ul className="mt-2 space-y-1">
						{securityList.map((c, i) => (
							<li
								// eslint-disable-next-line react/no-array-index-key -- contacts have no stable id; index is stable within a render
								key={`${c.email ?? c.url ?? "contact"}-${i}`}
								className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
							>
								{c.email ? (
									<a href={`mailto:${c.email}`} className="text-kumo-link hover:underline">
										{c.email}
									</a>
								) : null}
								{c.url ? (
									<a
										href={c.url}
										target="_blank"
										rel="noreferrer"
										className="text-kumo-link hover:underline"
									>
										{c.url}
									</a>
								) : null}
							</li>
						))}
					</ul>
				</section>
			) : null}

			{/* Capabilities preview */}
			{capabilities.length > 0 ? (
				<section>
					<h2 className="text-sm font-semibold text-kumo-subtle">{t`Declared permissions`}</h2>
					<div className="mt-2 flex flex-wrap gap-2">
						{capabilities.map((c) => (
							<Badge key={c}>{c}</Badge>
						))}
					</div>
				</section>
			) : null}

			{/* Long-form sections (description / installation / faq / changelog /
			    security). One pane per non-empty section; sanitized Markdown. */}
			{sections.length > 0 && activePane ? (
				<section aria-label={t`Plugin details`}>
					{sections.length > 1 ? (
						<Tabs
							variant="underline"
							value={activeSection}
							onValueChange={(v) => setSelectedSection(v as SectionKey)}
							tabs={sections.map(
								(s): TabsItem => ({ value: s.key, label: t(SECTION_LABELS[s.key]) }),
							)}
						/>
					) : (
						<h2 className="text-sm font-semibold text-kumo-subtle">
							{t(SECTION_LABELS[activePane.key])}
						</h2>
					)}
					<div className="prose prose-sm mt-4 max-w-none rounded-lg border bg-kumo-base p-6">
						<div dangerouslySetInnerHTML={{ __html: renderMarkdown(activePane.markdown) }} />
					</div>
				</section>
			) : null}

			{/* Consent dialog */}
			{showConsent && release && activeVerification ? (
				<CapabilityConsentDialog
					mode="install"
					pluginName={displayName ?? slug}
					capabilities={activeVerification.capabilities}
					allowedHosts={
						declaredAccessToCapabilities(activeVerification.declaredAccess).allowedHosts
					}
					mcpTools={mcpConsentTools}
					verification={activeVerification.verification}
					isPending={installMutation.isPending}
					error={getMutationError(installMutation.error)}
					onConfirm={() => installMutation.mutate()}
					onCancel={() => {
						setShowConsent(false);
						setMcpConsentTools([]);
						setVerificationPreview(null);
						installMutation.reset();
					}}
				/>
			) : null}
		</div>
	);
}

const SECTION_LABELS: Record<SectionKey, MessageDescriptor> = {
	description: msg`Description`,
	installation: msg`Installation`,
	faq: msg`FAQ`,
	changelog: msg`Changelog`,
	security: msg`Security`,
};

function BackLink() {
	const { t } = useLingui();
	return (
		<Link
			to="/plugins/marketplace"
			className="inline-flex items-center gap-1 text-sm text-kumo-subtle hover:text-kumo-default"
		>
			<ArrowPrev className="h-4 w-4" />
			{t`Back to plugins`}
		</Link>
	);
}

const PRE_RELEASE_VERSION_RE = /^\d+\.\d+\.\d+-/;

/**
 * Detects semver pre-release identifiers (`1.0.0-alpha.1`, `2.0.0-rc.2`). The
 * release lexicon does not enforce semver shape, so a permissive `includes("-")`
 * check would light up the badge for malformed values like `-1.0.0` or
 * `abc-def`. Require a `MAJOR.MINOR.PATCH-` prefix instead.
 */
function isPreReleaseVersion(version: string): boolean {
	return PRE_RELEASE_VERSION_RE.test(version);
}

/**
 * Human-readable name for a `requires` env key. The known EmDash environments
 * get their proper product names; anything else falls back to the key with the
 * `env:` prefix stripped (product names, not localised strings).
 */
function envLabel(key: string): string {
	if (key === "env:emdash") return "EmDash";
	if (key === "env:astro") return "Astro";
	return key.startsWith("env:") ? key.slice("env:".length) : key;
}

function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString();
	} catch {
		return iso;
	}
}

/**
 * SPDX page URL for a license, or `null` when the value isn't a single
 * SPDX identifier (compound expressions like "MIT OR Apache-2.0" and the
 * literal "proprietary" have no canonical spdx.org page).
 */
/**
 * Validate an untrusted aggregator-supplied URL for use in an `href`.
 * Returns the normalised URL only when it is an absolute `http(s)` URL;
 * everything else (relative, `javascript:`, `data:`, garbage, non-string)
 * returns `null`. The profile/release records are pass-throughs from a
 * remote service, so an unsanitised `href` is stored XSS in the
 * authenticated admin origin.
 */
function safeExternalHref(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	return parsed.href;
}

// Conservative email shape: forbids whitespace (so no CRLF), the
// characters that could break out of a `mailto:` href, and the
// `mailto:` query delimiters (`? & = % /`) so a value like
// `victim@x.com?bcc=attacker@evil` can't smuggle cc/bcc/subject/body.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"?&=%/]+@[^\s@<>()[\]\\,;:"?&=%/]+\.[^\s@<>()[\]\\,;:"?&=%/]+$/;

function safeEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const email = value.trim();
	if (email.length === 0 || email.length > 320) return null;
	return EMAIL_RE.test(email) ? email : null;
}

const SPDX_SINGLE_ID_RE = /^[A-Za-z0-9.+-]+$/;

function spdxLicenseHref(license: string): string | null {
	const id = license.trim();
	if (!SPDX_SINGLE_ID_RE.test(id)) return null;
	if (id.toLowerCase() === "proprietary") return null;
	return `https://spdx.org/licenses/${id}.html`;
}

function LicenseBadge({ license }: { license: string }) {
	const { t } = useLingui();
	const href = spdxLicenseHref(license);
	if (!href) return <Badge>{license}</Badge>;
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			aria-label={t`View the ${license} license on spdx.org`}
			className="hover:opacity-80"
		>
			<Badge>{license}</Badge>
		</a>
	);
}

function formatHoldback(seconds: number): string {
	if (seconds <= 0) return "0s";
	if (seconds < 60 * 60) return `${Math.round(seconds / 60)} min`;
	if (seconds < 24 * 60 * 60) return `${Math.round(seconds / 60 / 60)} h`;
	return `${Math.round(seconds / 60 / 60 / 24)} d`;
}
