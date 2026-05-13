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
	getLatestRegistryRelease,
	installRegistryPlugin,
	releasePassesPolicy,
	resolveRegistryPackage,
	type RegistryClientConfig,
} from "../lib/api/registry.js";
import { ArrowPrev } from "./ArrowIcons.js";
import { CapabilityConsentDialog } from "./CapabilityConsentDialog.js";
import { getMutationError } from "./DialogError.js";

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

	// Parse `handle/slug` out of the route param. Slugs themselves are
	// `[A-Za-z][A-Za-z0-9_-]*` (no slashes), so the first `/` is the split.
	const slashIdx = pluginId.indexOf("/");
	const handle = slashIdx > 0 ? pluginId.slice(0, slashIdx) : "";
	const slug = slashIdx > 0 ? pluginId.slice(slashIdx + 1) : "";

	const { data: pkg, isLoading: isLoadingPkg } = useQuery({
		queryKey: ["registry", "package", config.aggregatorUrl, handle, slug],
		queryFn: () => resolveRegistryPackage(config, handle, slug),
		enabled: Boolean(handle && slug),
	});

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
	const releaseDoc = release?.release as
		| {
				extensions?: Record<string, { declaredAccess?: unknown; capabilities?: string[] }>;
		  }
		| undefined;
	const extensionEntries = releaseDoc?.extensions ? Object.entries(releaseDoc.extensions) : [];
	const ext = extensionEntries.find(([k]) =>
		k.startsWith("com.emdashcms.experimental.package.releaseExtension"),
	)?.[1];

	const capabilities: string[] = Array.isArray(ext?.capabilities)
		? (ext?.capabilities as string[])
		: declaredAccessToCapabilityList(ext?.declaredAccess);

	const profile = pkg?.profile as { name?: string; description?: string } | undefined;
	const verified = (pkg?.labels ?? []).some((l: { val?: string }) => l.val === "verified");

	const policyOk =
		release && pkg ? releasePassesPolicy(release, { did: pkg.did, slug }, config.policy) : true;

	const installMutation = useMutation({
		mutationFn: () =>
			installRegistryPlugin({
				handle,
				slug,
				version: release?.version,
				acknowledgedDeclaredAccess: capabilities,
			}),
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
						{t`Published by`} {pkg.handle ?? pkg.did}
					</p>
					{release ? (
						<p className="text-xs text-kumo-subtle">
							{t`Version ${release.version}`} · {t`indexed ${formatDate(release.indexedAt)}`}
						</p>
					) : null}
				</div>
				<div>
					<Button
						variant="primary"
						disabled={!release || !policyOk}
						onClick={() => setShowConsent(true)}
					>
						{t`Install`}
					</Button>
				</div>
			</div>

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
