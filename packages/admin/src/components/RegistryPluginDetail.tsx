/**
 * Registry Plugin Detail
 *
 * Detail view for a plugin from the experimental decentralized plugin
 * registry. Resolves `(handle, slug)` directly against the configured
 * aggregator; install routes through the EmDash server's
 * `/_emdash/api/admin/plugins/registry/install` endpoint, which
 * re-resolves and re-verifies before writing the install.
 *
 * Identified in the URL by a `pluginId` that is `${handle}/${slug}`.
 * The router wraps this component when `manifest.registry` is set on
 * the same route the marketplace detail uses, so existing bookmarks /
 * sidebar entries stay stable.
 */

import { Badge, Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ShieldCheck, Warning } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
	canonicalCapabilitiesForDriftCheck,
	getLatestRegistryRelease,
	getRegistryPackage,
	installRegistryPlugin,
	releasePassesPolicy,
	resolveRegistryPackage,
	type RegistryClientConfig,
} from "../lib/api/registry.js";
import { ArrowPrev } from "./ArrowIcons.js";
import { CapabilityConsentDialog } from "./CapabilityConsentDialog.js";
import { getMutationError } from "./DialogError.js";
import { PublisherHandle, usePublisherHandle } from "./PublisherHandle.js";

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
	const { data: pkg, isLoading: isLoadingPkg } = useQuery({
		queryKey: ["registry", "package", config.aggregatorUrl, publisher, slug, isDid],
		queryFn: () =>
			isDid
				? getRegistryPackage(config, publisher, slug)
				: resolveRegistryPackage(config, publisher, slug),
		enabled: Boolean(publisher && slug),
	});

	// Resolve the publisher's handle for display (and for the install
	// gate -- we block install on an "invalid" status, where the
	// publisher claims a handle that doesn't round-trip back to this
	// DID, because that's an impersonation risk).
	const handleResult = usePublisherHandle(pkg?.did ?? "", pkg?.handle);

	const { data: release } = useQuery({
		queryKey: ["registry", "latest-release", config.aggregatorUrl, pkg?.did, slug],
		queryFn: () => getLatestRegistryRelease(config, pkg!.did, slug),
		enabled: Boolean(pkg?.did && slug),
	});

	// `release.extensions[com.emdashcms.experimental.package.releaseExtension]`
	// carries the structured `declaredAccess`. The EmDash bundle manifest
	// uses the legacy `capabilities: string[]` shape that the sandbox
	// enforces today, so we lift that from the release's extension when
	// available and fall back to the structured declaredAccess flattened
	// to a string list otherwise. This keeps `CapabilityConsentDialog` --
	// which only understands `capabilities` -- working unchanged.
	//
	// `canonicalCapabilitiesForDriftCheck` filters non-strings, dedupes,
	// and sorts so an aggregator-supplied array with unstable order or
	// junk entries can't trigger a spurious server-side drift rejection
	// later.
	//
	// NSID is exact-matched, not prefix-matched. RFC 0001 fixes the NSID
	// for this extension; accepting variants like `…releaseExtensionV2`
	// or `…releaseExtension.deprecated` would let a publisher render a
	// different permissions list than another publisher would for the
	// same RFC-0001 fields.
	const RELEASE_EXTENSION_NSID = "com.emdashcms.experimental.package.releaseExtension";
	const releaseDoc = release?.release as
		| {
				extensions?: Record<string, { declaredAccess?: unknown; capabilities?: unknown }>;
		  }
		| undefined;
	const ext = releaseDoc?.extensions?.[RELEASE_EXTENSION_NSID];

	const capabilities: string[] = Array.isArray(ext?.capabilities)
		? canonicalCapabilitiesForDriftCheck(ext?.capabilities)
		: canonicalCapabilitiesForDriftCheck(declaredAccessToCapabilityList(ext?.declaredAccess));

	const profile = pkg?.profile as { name?: string; description?: string } | undefined;
	const verified = (pkg?.labels ?? []).some((l: { val?: string }) => l.val === "verified");

	const policyOk =
		release && pkg ? releasePassesPolicy(release, { did: pkg.did, slug }, config.policy) : true;
	// Handle resolution affects display only -- installs are addressed
	// by DID, so an unverified or missing handle doesn't block install.
	// A handle that *claims* a value but doesn't verify (`status:
	// "invalid"`) is a publisher misconfiguration we surface as a
	// warning but don't gate on.

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

	const installMutation = useMutation({
		mutationFn: () => {
			if (!pkg) throw new Error("Package not loaded");
			return installRegistryPlugin({
				did: pkg.did,
				slug,
				version: release?.version,
				// Always send the acknowledgement, even when the dialog
				// showed no permissions. The server compares this list
				// against the bundle's actual `manifest.capabilities`
				// after download:
				//
				//   - If the bundle has capabilities, the server
				//     requires us to send a matching list (the consent
				//     dialog is the only place the admin sees what
				//     they're agreeing to).
				//   - If the bundle has no capabilities, no consent is
				//     required and the server ignores this field.
				//
				// Sending the empty list when the release extension was
				// missing means a publisher who ships a bundle with
				// permissions but no extension block can't sneak the
				// permissions past an empty consent dialog -- the
				// server will refuse with `DECLARED_ACCESS_REQUIRED`.
				acknowledgedDeclaredAccess: capabilities,
			});
		},
		onSuccess: () => {
			setShowConsent(false);
			void queryClient.invalidateQueries({ queryKey: ["plugins"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			void queryClient.invalidateQueries({ queryKey: ["registry"] });
		},
	});

	if (isLoadingPkg) {
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

	if (!pkg) {
		return (
			<div className="space-y-6">
				<BackLink />
				<div
					className="rounded-md border border-kumo-error bg-kumo-error/10 p-4 text-kumo-error"
					role="alert"
				>
					{t`Plugin not found. The publisher handle or slug may be incorrect.`}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<BackLink />

			{/* Header */}
			<div className="flex items-start gap-4">
				<div className="rounded-xl bg-kumo-subtle p-3 text-kumo-subtle">
					<span aria-hidden className="block h-10 w-10" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h1 className="truncate text-3xl font-bold">{profile?.name ?? slug}</h1>
						{verified ? (
							<ShieldCheck
								className="h-5 w-5 shrink-0 text-kumo-brand"
								aria-label={t`Verified publisher`}
							/>
						) : null}
					</div>
					<p className="text-sm text-kumo-subtle">
						{t`Published by`}{" "}
						<PublisherHandle did={pkg.did} aggregatorHandle={pkg.handle} variant="detail" />
					</p>
					{release ? (
						<p className="text-xs text-kumo-subtle">
							{t`Version ${release.version}`} · {t`indexed ${formatDate(release.indexedAt)}`}
						</p>
					) : null}
				</div>
				<div>
					{isInstalled ? (
						<Button variant="secondary" disabled>
							{t`Installed`}
						</Button>
					) : (
						<Button
							variant="primary"
							disabled={!release || !policyOk || handleResult.status === "invalid"}
							onClick={() => setShowConsent(true)}
						>
							{t`Install`}
						</Button>
					)}
				</div>
			</div>

			{/* Invalid-handle notice. The publisher's DID document claims a
			    handle but the handle's domain doesn't point back to this
			    DID. Possible causes: an expired DNS record or stale
			    .well-known/atproto-did file on the publisher's side
			    (legitimate but misconfigured), OR an active impersonation
			    attempt -- somebody publishing under a DID that claims to
			    be `stripe.com` etc. We can't tell the two apart from this
			    side, so we treat the claim as untrusted and block
			    install. Don't display the spoofed handle string -- it
			    might be exactly what the attacker wants the admin to see. */}
			{handleResult.status === "invalid" ? (
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

			{/* Description */}
			{profile?.description ? (
				<p className="text-base text-kumo-default">{profile.description}</p>
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

			{/* Consent dialog */}
			{showConsent && release ? (
				<CapabilityConsentDialog
					mode="install"
					pluginName={profile?.name ?? slug}
					capabilities={capabilities}
					isPending={installMutation.isPending}
					error={getMutationError(installMutation.error)}
					onConfirm={() => installMutation.mutate()}
					onCancel={() => {
						setShowConsent(false);
						installMutation.reset();
					}}
				/>
			) : null}
		</div>
	);
}

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

/**
 * Flatten an RFC-0001 `declaredAccess` block (`{ content: { read: true },
 * email: { send: { allowedHosts: [...] } }, ... }`) into the legacy
 * `capabilities: string[]` shape that the existing sandbox runtime
 * enforces today. One entry per declared operation under each
 * category. Unknown values are skipped silently -- the consent dialog
 * shows only what the current runtime recognises.
 */
function declaredAccessToCapabilityList(declaredAccess: unknown): string[] {
	if (!declaredAccess || typeof declaredAccess !== "object") return [];
	const out: string[] = [];
	for (const [category, value] of Object.entries(declaredAccess as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		for (const [operation, opValue] of Object.entries(value as Record<string, unknown>)) {
			// Skip operations explicitly opted out (`false`).
			if (opValue === false) continue;
			out.push(`${category}:${operation}`);
		}
	}
	return out;
}

function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString();
	} catch {
		return iso;
	}
}

function formatHoldback(seconds: number): string {
	if (seconds <= 0) return "0s";
	if (seconds < 60 * 60) return `${Math.round(seconds / 60)} min`;
	if (seconds < 24 * 60 * 60) return `${Math.round(seconds / 60 / 60)} h`;
	return `${Math.round(seconds / 60 / 60 / 24)} d`;
}
