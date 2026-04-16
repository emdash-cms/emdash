/**
 * Marketplace Plugin Detail
 *
 * Full detail view for a marketplace plugin:
 * - README rendered as markdown
 * - Screenshot gallery
 * - Capability list
 * - Audit summary
 * - Version history
 * - Install button (with capability consent)
 */

import { Badge, Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowLeft,
	DownloadSimple,
	GithubLogo,
	Globe,
	ShieldCheck,
	Warning,
	CaretLeft,
	CaretRight,
	X,
} from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import DOMPurify from "dompurify";
import { Marked, Renderer } from "marked";
import * as React from "react";

import {
	fetchMarketplacePlugin,
	installMarketplacePlugin,
	uninstallMarketplacePlugin,
	describeCapability,
} from "../lib/api/marketplace.js";
import { SAFE_URL_RE, isSafeUrl, safeIconUrl } from "../lib/url.js";
import { CapabilityConsentDialog } from "./CapabilityConsentDialog.js";
import { getMutationError } from "./DialogError.js";
import { AuditBadge } from "./MarketplaceBrowse.js";
import { UninstallConfirmDialog } from "./PluginManager.js";

export interface MarketplacePluginDetailProps {
	pluginId: string;
	/** IDs of plugins already installed on this site */
	installedPluginIds?: Set<string>;
}

export function MarketplacePluginDetail({
	pluginId,
	installedPluginIds = new Set(),
}: MarketplacePluginDetailProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [showConsent, setShowConsent] = React.useState(false);
	const [showUninstallConfirm, setShowUninstallConfirm] = React.useState(false);
	const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);

	const {
		data: plugin,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["marketplace", "plugin", pluginId],
		queryFn: () => fetchMarketplacePlugin(pluginId),
	});

	const installMutation = useMutation({
		mutationFn: () =>
			installMarketplacePlugin(pluginId, {
				version: plugin?.latestVersion?.version,
			}),
		onSuccess: () => {
			setShowConsent(false);
			void queryClient.invalidateQueries({ queryKey: ["plugins"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			void queryClient.invalidateQueries({ queryKey: ["marketplace"] });
		},
	});

	const uninstallMutation = useMutation({
		mutationFn: (deleteData: boolean) => uninstallMarketplacePlugin(pluginId, { deleteData }),
		onSuccess: () => {
			setShowUninstallConfirm(false);
			void queryClient.invalidateQueries({ queryKey: ["plugins"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			void queryClient.invalidateQueries({ queryKey: ["marketplace"] });
		},
	});

	const isInstalled = installedPluginIds.has(pluginId);

	if (isLoading) {
		return (
			<div className="space-y-6">
				<BackLink />
				<div className="animate-pulse space-y-4">
					<div className="flex items-center gap-4">
						<div className="h-16 w-16 rounded-xl bg-kumo-tint" />
						<div className="space-y-2">
							<div className="h-6 w-48 rounded bg-kumo-tint" />
							<div className="h-4 w-32 rounded bg-kumo-tint" />
						</div>
					</div>
					<div className="h-4 w-full rounded bg-kumo-tint" />
					<div className="h-4 w-3/4 rounded bg-kumo-tint" />
					<div className="h-64 w-full rounded bg-kumo-tint" />
				</div>
			</div>
		);
	}

	if (error || !plugin) {
		return (
			<div className="space-y-6">
				<BackLink />
				<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-6 text-center">
					<Warning className="mx-auto h-8 w-8 text-kumo-danger" />
					<h3 className="mt-3 font-medium text-kumo-danger">{t`Failed to load plugin`}</h3>
					<p className="mt-1 text-sm text-kumo-subtle">
						{error instanceof Error ? error.message : t`Plugin not found`}
					</p>
					<Link to="/plugins/marketplace" className="mt-4 inline-block text-kumo-brand text-sm">
						{t`Back to marketplace`}
					</Link>
				</div>
			</div>
		);
	}

	const latest = plugin.latestVersion;
	const imageVerdict = latest?.imageAudit?.verdict;
	const isImageFlagged = imageVerdict === "warn" || imageVerdict === "fail";
	const isAuditFailed = latest?.audit?.verdict === "fail";
	const screenshots = (latest?.screenshotUrls ?? []).filter(isSafeUrl);
	const iconSrc = plugin.iconUrl ? safeIconUrl(plugin.iconUrl, 128) : null;

	return (
		<div className="space-y-6">
			<BackLink />

			{/* Header */}
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex items-start gap-4">
					{/* Icon */}
					{iconSrc ? (
						<img
							src={iconSrc}
							alt=""
							className={`h-16 w-16 rounded-xl object-cover ${isImageFlagged ? "blur-md" : ""}`}
							aria-label={isImageFlagged ? t`Icon blurred due to image audit` : undefined}
						/>
					) : (
						<div className="flex h-16 w-16 items-center justify-center rounded-xl bg-kumo-brand/10 text-kumo-brand text-2xl font-bold">
							{plugin.name.charAt(0).toUpperCase()}
						</div>
					)}

					<div>
						<h1 className="text-2xl font-bold">{plugin.name}</h1>
						<div className="mt-1 flex items-center gap-2 text-sm text-kumo-subtle">
							<span>{plugin.author.name}</span>
							{plugin.author.verified && <ShieldCheck className="h-4 w-4 text-kumo-brand" />}
							{latest && (
								<>
									<span aria-hidden="true">&middot;</span>
									<span>v{latest.version}</span>
								</>
							)}
						</div>
						{plugin.description && (
							<p className="mt-2 text-sm text-kumo-subtle max-w-lg">{plugin.description}</p>
						)}
					</div>
				</div>

				{/* Action button */}
				<div className="flex items-center gap-3">
					{isInstalled ? (
						<>
							<Badge variant="secondary" className="text-sm px-3 py-1">
								{t`Installed`}
							</Badge>
							<Button
								variant="outline"
								className="text-kumo-danger hover:text-kumo-danger"
								onClick={() => setShowUninstallConfirm(true)}
							>
								{t`Uninstall`}
							</Button>
						</>
					) : isAuditFailed ? (
						<div className="flex flex-col items-end gap-1">
							<Button disabled variant="secondary">
								{t`Install blocked`}
							</Button>
							<span className="text-xs text-kumo-danger">{t`Failed security audit`}</span>
						</div>
					) : (
						<Button onClick={() => setShowConsent(true)}>
							<DownloadSimple className="me-2 h-4 w-4" />
							{t`Install`}
						</Button>
					)}
				</div>
			</div>

			{/* Stats bar */}
			<div className="flex flex-wrap items-center gap-4 rounded-lg border bg-kumo-tint/30 p-3 text-sm">
				<div className="flex items-center gap-1.5">
					<DownloadSimple className="h-4 w-4 text-kumo-subtle" />
					<span>{t`${plugin.installCount.toLocaleString()} installs`}</span>
				</div>
				{latest?.audit && <AuditBadge verdict={latest.audit.verdict} />}
				{plugin.license && <span className="text-kumo-subtle">{plugin.license}</span>}
				{plugin.repositoryUrl && isSafeUrl(plugin.repositoryUrl) && (
					<a
						href={plugin.repositoryUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-1 text-kumo-brand hover:underline"
					>
						<GithubLogo className="h-4 w-4" />
						{t`Source`}
					</a>
				)}
				{plugin.homepageUrl && isSafeUrl(plugin.homepageUrl) && (
					<a
						href={plugin.homepageUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-1 text-kumo-brand hover:underline"
					>
						<Globe className="h-4 w-4" />
						{t`Website`}
					</a>
				)}
			</div>

			{/* Screenshots */}
			{screenshots.length > 0 && (
				<div>
					<h2 className="mb-3 text-lg font-semibold">{t`Screenshots`}</h2>
					<div className="flex gap-3 overflow-x-auto pb-2">
						{screenshots.map((url, i) => (
							<button
								key={url}
								onClick={() => setLightboxIndex(i)}
								className="shrink-0 overflow-hidden rounded-lg border hover:ring-2 hover:ring-kumo-brand transition-shadow"
							>
								<img
									src={url}
									alt={t`Screenshot ${i + 1}`}
									className={`h-40 w-auto object-cover ${isImageFlagged ? "blur-md" : ""}`}
									loading="lazy"
									aria-label={isImageFlagged ? t`Screenshot blurred due to image audit` : undefined}
								/>
							</button>
						))}
					</div>
				</div>
			)}

			{/* Two-column layout: README + sidebar */}
			<div className="grid gap-6 lg:grid-cols-[1fr_280px]">
				{/* README */}
				<div>
					{latest?.readme ? (
						<div className="prose prose-sm max-w-none rounded-lg border bg-kumo-base p-6">
							<div dangerouslySetInnerHTML={{ __html: renderMarkdown(latest.readme) }} />
						</div>
					) : (
						<div className="rounded-lg border bg-kumo-base p-6 text-center text-kumo-subtle">
							{t`No detailed description available.`}
						</div>
					)}
				</div>

				{/* Sidebar */}
				<div className="space-y-4">
					{/* Capabilities */}
					<div className="rounded-lg border bg-kumo-base p-4">
						<h3 className="text-sm font-semibold mb-2">{t`Permissions`}</h3>
						{plugin.capabilities.length === 0 ? (
							<p className="text-xs text-kumo-subtle">
								{t`This plugin requires no special permissions.`}
							</p>
						) : (
							<ul className="space-y-1.5">
								{plugin.capabilities.map((cap) => (
									<li key={cap} className="flex items-start gap-2 text-xs text-kumo-subtle">
										<ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-kumo-brand" />
										<span>{describeCapability(cap)}</span>
									</li>
								))}
							</ul>
						)}
					</div>

					{/* Keywords */}
					{plugin.keywords && plugin.keywords.length > 0 && (
						<div className="rounded-lg border bg-kumo-base p-4">
							<h3 className="text-sm font-semibold mb-2">{t`Keywords`}</h3>
							<div className="flex flex-wrap gap-1">
								{plugin.keywords.map((kw) => (
									<span key={kw} className="rounded-md bg-kumo-tint px-2 py-0.5 text-xs">
										{kw}
									</span>
								))}
							</div>
						</div>
					)}

					{/* Audit summary */}
					{latest?.audit && (
						<div className="rounded-lg border bg-kumo-base p-4">
							<h3 className="text-sm font-semibold mb-2">{t`Security Audit`}</h3>
							<div className="flex items-center gap-2">
								<AuditBadge verdict={latest.audit.verdict} />
								<span className="text-xs text-kumo-subtle">
									{t`Risk score: ${latest.audit.riskScore}/100`}
								</span>
							</div>
						</div>
					)}

					{/* Version info */}
					{latest && (
						<div className="rounded-lg border bg-kumo-base p-4">
							<h3 className="text-sm font-semibold mb-2">{t`Version`}</h3>
							<div className="space-y-1 text-xs text-kumo-subtle">
								<div>v{latest.version}</div>
								{latest.minEmDashVersion && (
									<div>{t`Requires EmDash ${latest.minEmDashVersion}`}</div>
								)}
								<div>{t`Published ${new Date(latest.publishedAt).toLocaleDateString()}`}</div>
								{latest.bundleSize > 0 && <div>{formatBytes(latest.bundleSize)}</div>}
							</div>
						</div>
					)}
				</div>
			</div>

			{/* Capability consent dialog */}
			{showConsent && (
				<CapabilityConsentDialog
					mode="install"
					pluginName={plugin.name}
					capabilities={plugin.capabilities}
					auditVerdict={latest?.audit?.verdict}
					isPending={installMutation.isPending}
					error={getMutationError(installMutation.error)}
					onConfirm={() => installMutation.mutate()}
					onCancel={() => {
						setShowConsent(false);
						installMutation.reset();
					}}
				/>
			)}

			{/* Uninstall confirmation */}
			{showUninstallConfirm && (
				<UninstallConfirmDialog
					pluginName={plugin.name}
					isPending={uninstallMutation.isPending}
					error={getMutationError(uninstallMutation.error)}
					onConfirm={(deleteData) => uninstallMutation.mutate(deleteData)}
					onCancel={() => {
						setShowUninstallConfirm(false);
						uninstallMutation.reset();
					}}
				/>
			)}

			{/* Screenshot lightbox */}
			{lightboxIndex !== null && lightboxIndex < screenshots.length && (
				<ScreenshotLightbox
					screenshots={screenshots}
					index={lightboxIndex}
					isBlurred={isImageFlagged}
					onClose={() => setLightboxIndex(null)}
					onNavigate={setLightboxIndex}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function BackLink() {
	const { t } = useLingui();
	return (
		<Link
			to="/plugins/marketplace"
			className="inline-flex items-center gap-1 text-sm text-kumo-subtle hover:text-kumo-default"
		>
			<ArrowLeft className="h-4 w-4" />
			{t`Back to marketplace`}
		</Link>
	);
}

interface ScreenshotLightboxProps {
	screenshots: string[];
	index: number;
	isBlurred?: boolean;
	onClose: () => void;
	onNavigate: (index: number) => void;
}

function ScreenshotLightbox({
	screenshots,
	index,
	isBlurred = false,
	onClose,
	onNavigate,
}: ScreenshotLightboxProps) {
	const { t } = useLingui();
	const handleKeyDown = React.useCallback(
		(e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
			if (e.key === "ArrowLeft" && index > 0) onNavigate(index - 1);
			if (e.key === "ArrowRight" && index < screenshots.length - 1) onNavigate(index + 1);
		},
		[index, screenshots.length, onClose, onNavigate],
	);

	React.useEffect(() => {
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [handleKeyDown]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
			role="dialog"
			aria-modal="true"
			aria-label={t`Screenshot viewer`}
		>
			<button
				onClick={onClose}
				className="absolute end-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
				aria-label={t`Close`}
			>
				<X className="h-5 w-5" />
			</button>

			{index > 0 && (
				<button
					onClick={() => onNavigate(index - 1)}
					className="absolute start-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
					aria-label={t`Previous screenshot`}
				>
					<CaretLeft className="h-5 w-5" />
				</button>
			)}

			<img
				src={screenshots[index]}
				alt={t`Screenshot ${index + 1} of ${screenshots.length}`}
				className={`max-h-[85vh] max-w-[90vw] rounded-lg object-contain ${
					isBlurred ? "blur-md" : ""
				}`}
			/>

			{index < screenshots.length - 1 && (
				<button
					onClick={() => onNavigate(index + 1)}
					className="absolute end-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
					aria-label={t`Next screenshot`}
				>
					<CaretRight className="h-5 w-5" />
				</button>
			)}

			{/* Counter */}
			<div className="absolute bottom-4 start-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-sm text-white">
				{index + 1} / {screenshots.length}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Markdown rendering (via marked, raw HTML blocked, sanitized with DOMPurify)
// ---------------------------------------------------------------------------

const HTML_ESCAPE_MAP: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

const HTML_ESCAPE_RE = /[&<>"']/g;

function escapeHtml(str: string): string {
	return str.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch]!);
}

const renderer = new Renderer();

renderer.link = ({ href, text }) => {
	if (!SAFE_URL_RE.test(href)) return escapeHtml(text);
	return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
};

renderer.image = ({ text }) => escapeHtml(text);

renderer.html = () => "";

const md = new Marked({ renderer, async: false });

/** Allowed tags and attributes for DOMPurify — only standard markdown output. */
const SANITIZE_CONFIG = {
	ALLOWED_TAGS: [
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"p",
		"a",
		"ul",
		"ol",
		"li",
		"blockquote",
		"pre",
		"code",
		"em",
		"strong",
		"del",
		"br",
		"hr",
		"table",
		"thead",
		"tbody",
		"tr",
		"th",
		"td",
		"details",
		"summary",
		"sup",
		"sub",
	],
	ALLOWED_ATTR: ["href", "target", "rel"],
};

function renderMarkdown(markdown: string): string {
	const result = md.parse(markdown);
	const html = typeof result === "string" ? result : "";
	return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default MarketplacePluginDetail;
