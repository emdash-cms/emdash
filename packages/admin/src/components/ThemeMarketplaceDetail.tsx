/**
 * Theme Marketplace Detail
 *
 * Full detail view for a marketplace theme:
 * - Screenshot gallery
 * - Description, author, license
 * - "Try with my data" button
 * - Demo + repository links
 */

import { Badge, Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowLeft,
	ArrowSquareOut,
	Eye,
	GithubLogo,
	Globe,
	Palette,
	ShieldCheck,
	CaretLeft,
	CaretRight,
	X,
} from "@phosphor-icons/react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { fetchTheme, generatePreviewUrl } from "../lib/api/theme-marketplace.js";

/** Only allow safe URL protocols for external links */
function isSafeUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	} catch {
		return false;
	}
}

export interface ThemeMarketplaceDetailProps {
	themeId: string;
}

export function ThemeMarketplaceDetail({ themeId }: ThemeMarketplaceDetailProps) {
	const { t } = useLingui();
	const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);

	const {
		data: theme,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["themes", "detail", themeId],
		queryFn: () => fetchTheme(themeId),
	});

	const previewMutation = useMutation({
		mutationFn: () => generatePreviewUrl(theme!.previewUrl),
		onSuccess: (url) => {
			window.open(url, "_blank", "noopener");
		},
	});

	// Loading
	if (isLoading) {
		return (
			<div className="space-y-6 animate-pulse">
				<div className="h-6 w-48 rounded bg-kumo-tint" />
				<div className="aspect-video max-w-2xl rounded-lg bg-kumo-tint" />
				<div className="space-y-3">
					<div className="h-4 w-64 rounded bg-kumo-tint" />
					<div className="h-4 w-96 rounded bg-kumo-tint" />
				</div>
			</div>
		);
	}

	// Error
	if (error || !theme) {
		return (
			<div className="space-y-4">
				<Link
					to={"/themes/marketplace" as "/"}
					className="inline-flex items-center gap-1 text-sm text-kumo-subtle hover:text-kumo-default"
				>
					<ArrowLeft className="h-4 w-4" />
					{t`Back to Themes`}
				</Link>
				<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-6 text-center">
					<h3 className="font-medium text-kumo-danger">{t`Failed to load theme`}</h3>
					<p className="mt-1 text-sm text-kumo-subtle">
						{error instanceof Error ? error.message : t`Theme not found`}
					</p>
				</div>
			</div>
		);
	}

	const thumbnailUrl = theme.hasThumbnail
		? `/_emdash/api/admin/themes/marketplace/${encodeURIComponent(theme.id)}/thumbnail`
		: null;

	return (
		<div className="space-y-6">
			{/* Back link */}
			<Link
				to={"/themes/marketplace" as "/"}
				className="inline-flex items-center gap-1 text-sm text-kumo-subtle hover:text-kumo-default"
			>
				<ArrowLeft className="h-4 w-4" />
				{t`Back to Themes`}
			</Link>

			{/* Header */}
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex items-start gap-4">
					{thumbnailUrl ? (
						<img src={thumbnailUrl} alt="" className="h-16 w-16 rounded-lg object-cover" />
					) : (
						<div className="flex h-16 w-16 items-center justify-center rounded-lg bg-kumo-brand/10">
							<Palette className="h-8 w-8 text-kumo-brand" />
						</div>
					)}
					<div>
						<h1 className="text-2xl font-bold">{theme.name}</h1>
						<div className="mt-1 flex items-center gap-2 text-sm text-kumo-subtle">
							<span>{theme.author.name}</span>
							{theme.author.verified && <ShieldCheck className="h-4 w-4 text-kumo-brand" />}
						</div>
						{theme.description && (
							<p className="mt-2 text-sm text-kumo-subtle max-w-xl">{theme.description}</p>
						)}
					</div>
				</div>

				{/* Actions */}
				<div className="flex gap-2 shrink-0">
					<Button
						variant="primary"
						onClick={() => previewMutation.mutate()}
						disabled={previewMutation.isPending}
					>
						<Eye className="me-2 h-4 w-4" />
						{previewMutation.isPending ? t`Loading...` : t`Try with my data`}
					</Button>
					{theme.demoUrl && isSafeUrl(theme.demoUrl) && (
						<Button
							variant="outline"
							onClick={() => window.open(theme.demoUrl!, "_blank", "noopener")}
						>
							<ArrowSquareOut className="me-2 h-4 w-4" />
							{t`Demo`}
						</Button>
					)}
				</div>
			</div>

			{previewMutation.error && (
				<div className="rounded-md border border-kumo-danger/50 bg-kumo-danger/10 p-3 text-sm text-kumo-danger">
					{previewMutation.error instanceof Error
						? previewMutation.error.message
						: t`Failed to generate preview URL`}
				</div>
			)}

			{/* Screenshot gallery */}
			{theme.screenshotCount > 0 && (
				<div>
					<h2 className="text-lg font-semibold mb-3">{t`Screenshots`}</h2>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{theme.screenshotUrls.map((url, i) => (
							<button
								key={i}
								className="rounded-lg border overflow-hidden hover:border-kumo-brand/50 transition-colors cursor-pointer"
								onClick={() => setLightboxIndex(i)}
							>
								<img
									src={url}
									alt={t`Screenshot ${i + 1}`}
									className="aspect-video w-full object-cover"
									loading="lazy"
								/>
							</button>
						))}
					</div>
				</div>
			)}

			{/* Details */}
			<div className="grid gap-6 sm:grid-cols-2">
				{/* Keywords */}
				{theme.keywords.length > 0 && (
					<div>
						<h3 className="text-sm font-medium text-kumo-subtle mb-2">{t`Keywords`}</h3>
						<div className="flex flex-wrap gap-1">
							{theme.keywords.map((kw) => (
								<Badge key={kw} variant="secondary">
									{kw}
								</Badge>
							))}
						</div>
					</div>
				)}

				{/* License */}
				{theme.license && (
					<div>
						<h3 className="text-sm font-medium text-kumo-subtle mb-2">{t`License`}</h3>
						<p className="text-sm">{theme.license}</p>
					</div>
				)}

				{/* Links */}
				<div>
					<h3 className="text-sm font-medium text-kumo-subtle mb-2">{t`Links`}</h3>
					<div className="flex flex-col gap-1.5">
						{theme.repositoryUrl && isSafeUrl(theme.repositoryUrl) && (
							<a
								href={theme.repositoryUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1.5 text-sm text-kumo-brand hover:underline"
							>
								<GithubLogo className="h-4 w-4" />
								{t`Repository`}
							</a>
						)}
						{theme.homepageUrl && isSafeUrl(theme.homepageUrl) && (
							<a
								href={theme.homepageUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1.5 text-sm text-kumo-brand hover:underline"
							>
								<Globe className="h-4 w-4" />
								{t`Homepage`}
							</a>
						)}
					</div>
				</div>
			</div>

			{/* Lightbox */}
			{lightboxIndex !== null && (
				<Lightbox
					urls={theme.screenshotUrls}
					index={lightboxIndex}
					onClose={() => setLightboxIndex(null)}
					onPrev={() =>
						setLightboxIndex((i) => (i !== null && i > 0 ? i - 1 : theme.screenshotUrls.length - 1))
					}
					onNext={() =>
						setLightboxIndex((i) => (i !== null && i < theme.screenshotUrls.length - 1 ? i + 1 : 0))
					}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

function Lightbox({
	urls,
	index,
	onClose,
	onPrev,
	onNext,
}: {
	urls: string[];
	index: number;
	onClose: () => void;
	onPrev: () => void;
	onNext: () => void;
}) {
	const { t } = useLingui();
	React.useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
			if (e.key === "ArrowLeft") onPrev();
			if (e.key === "ArrowRight") onNext();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose, onPrev, onNext]);

	const url = urls[index];
	if (!url) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
			onClick={onClose}
		>
			<div className="relative max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
				<img src={url} alt={t`Screenshot ${index + 1}`} className="max-h-[85vh] rounded-lg" />

				<button
					onClick={onClose}
					className="absolute -top-3 -end-3 rounded-full bg-kumo-base p-1.5 shadow-lg hover:bg-kumo-tint"
					aria-label={t`Close`}
				>
					<X className="h-4 w-4" />
				</button>

				{urls.length > 1 && (
					<>
						<button
							onClick={onPrev}
							className="absolute start-2 top-1/2 -translate-y-1/2 rounded-full bg-kumo-base/80 p-2 shadow hover:bg-kumo-base"
							aria-label={t`Previous`}
						>
							<CaretLeft className="h-5 w-5" />
						</button>
						<button
							onClick={onNext}
							className="absolute end-2 top-1/2 -translate-y-1/2 rounded-full bg-kumo-base/80 p-2 shadow hover:bg-kumo-base"
							aria-label={t`Next`}
						>
							<CaretRight className="h-5 w-5" />
						</button>
					</>
				)}

				<div className="absolute bottom-2 start-1/2 -translate-x-1/2 rounded-full bg-kumo-base/80 px-3 py-1 text-xs">
					{index + 1} / {urls.length}
				</div>
			</div>
		</div>
	);
}

export default ThemeMarketplaceDetail;
