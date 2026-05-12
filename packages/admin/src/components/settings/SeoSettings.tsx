/**
 * SEO Settings sub-page
 *
 * Title separator, search engine verification codes, and robots.txt.
 */

import { Button, Input, InputArea, Label } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	FloppyDisk,
	CheckCircle,
	WarningCircle,
	MagnifyingGlass,
	Upload,
	X,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { fetchSettings, updateSettings, type SiteSettings, type MediaItem } from "../../lib/api";
import { EditorHeader } from "../EditorHeader";
import { MediaPickerModal } from "../MediaPickerModal";
import { BackToSettingsLink } from "./BackToSettingsLink.js";

export function SeoSettings() {
	const { t } = useLingui();
	const queryClient = useQueryClient();

	const { data: settings, isLoading } = useQuery({
		queryKey: ["settings"],
		queryFn: fetchSettings,
		staleTime: Infinity,
	});

	const [formData, setFormData] = React.useState<Partial<SiteSettings>>({});
	const [saveStatus, setSaveStatus] = React.useState<{
		type: "success" | "error";
		message: string;
	} | null>(null);
	const [ogImagePickerOpen, setOgImagePickerOpen] = React.useState(false);

	React.useEffect(() => {
		if (settings) setFormData(settings);
	}, [settings]);

	React.useEffect(() => {
		if (saveStatus) {
			const timer = setTimeout(setSaveStatus, 3000, null);
			return () => clearTimeout(timer);
		}
	}, [saveStatus]);

	const saveMutation = useMutation({
		mutationFn: (data: Partial<SiteSettings>) => updateSettings(data),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["settings"] });
			setSaveStatus({ type: "success", message: t`SEO settings saved` });
		},
		onError: (error) => {
			setSaveStatus({
				type: "error",
				message: error instanceof Error ? error.message : t`Failed to save settings`,
			});
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		saveMutation.mutate(formData);
	};

	const handleSeoChange = (key: string, value: unknown) => {
		setFormData((prev) => ({
			...prev,
			seo: {
				...prev.seo,
				[key]: value,
			},
		}));
	};

	const handleDefaultOgImageSelect = (media: MediaItem) => {
		setFormData((prev) => ({
			...prev,
			seo: {
				...prev.seo,
				defaultOgImage: { mediaId: media.id, alt: media.alt || "", url: media.url },
			},
		}));
		setOgImagePickerOpen(false);
	};

	const handleDefaultOgImageRemove = () => {
		setFormData((prev) => ({
			...prev,
			seo: { ...prev.seo, defaultOgImage: undefined },
		}));
	};

	if (isLoading) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-3">
					<BackToSettingsLink />
					<h1 className="text-2xl font-bold">{t`SEO Settings`}</h1>
				</div>
				<div className="rounded-lg border bg-kumo-base p-6">
					<p className="text-kumo-subtle">{t`Loading settings...`}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Sticky header — see GeneralSettings for the same pattern. */}
			<EditorHeader
				leading={<BackToSettingsLink />}
				actions={
					<Button
						type="submit"
						form="seo-settings-form"
						disabled={saveMutation.isPending}
						icon={<FloppyDisk />}
					>
						{saveMutation.isPending ? t`Saving...` : t`Save SEO Settings`}
					</Button>
				}
			>
				<h1 className="text-2xl font-bold truncate">{t`SEO Settings`}</h1>
			</EditorHeader>

			{/* Status banner */}
			{saveStatus && (
				<div
					className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${
						saveStatus.type === "success"
							? "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200"
							: "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200"
					}`}
				>
					{saveStatus.type === "success" ? (
						<CheckCircle className="h-4 w-4 flex-shrink-0" />
					) : (
						<WarningCircle className="h-4 w-4 flex-shrink-0" />
					)}
					{saveStatus.message}
				</div>
			)}

			<form id="seo-settings-form" onSubmit={handleSubmit} className="space-y-6">
				<div className="rounded-lg border bg-kumo-base p-6">
					<div className="flex items-center gap-2 mb-4">
						<MagnifyingGlass className="h-5 w-5 text-kumo-subtle" />
						<h2 className="text-lg font-semibold">{t`Search Engine Optimization`}</h2>
					</div>
					<div className="space-y-4">
						<Input
							label={t`Title Separator`}
							value={formData.seo?.titleSeparator || "|"}
							onChange={(e) => handleSeoChange("titleSeparator", e.target.value)}
							description={t`Character between page title and site name (e.g., "My Post | My Site")`}
						/>

						{/* Default OG Image Picker --
						    "configured" is determined by presence of `mediaId`, not `url`.
						    When the referenced media row is deleted, the resolver returns the
						    bare ref without a URL; we still need to show Remove so the user can
						    clear the dangling reference. */}
						<div>
							<Label>{t`Default Social Image`}</Label>
							<p className="mt-1 text-sm text-kumo-subtle">
								{t`Used as the fallback Open Graph image when a page has none. Recommended size: 1200×630.`}
							</p>
							{formData.seo?.defaultOgImage?.mediaId ? (
								<div className="mt-2 space-y-2">
									{formData.seo.defaultOgImage.url ? (
										<img
											src={formData.seo.defaultOgImage.url}
											alt={formData.seo.defaultOgImage.alt || t`Default social image`}
											className="h-32 rounded border bg-kumo-tint object-contain p-2"
										/>
									) : (
										<div
											className="flex min-h-32 items-center gap-2 rounded border border-dashed bg-kumo-tint px-3 py-2 text-sm text-kumo-subtle"
											role="status"
										>
											<WarningCircle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
											<span>{t`The referenced image is no longer available. Pick a new one or remove the reference.`}</span>
										</div>
									)}
									<div className="flex gap-2">
										<Button
											type="button"
											variant="outline"
											size="sm"
											icon={<Upload />}
											onClick={() => setOgImagePickerOpen(true)}
										>
											{t`Change Image`}
										</Button>
										<Button
											type="button"
											variant="outline"
											size="sm"
											icon={<X />}
											onClick={handleDefaultOgImageRemove}
										>
											{t`Remove`}
										</Button>
									</div>
								</div>
							) : (
								<Button
									type="button"
									variant="outline"
									icon={<Upload />}
									onClick={() => setOgImagePickerOpen(true)}
									className="mt-2"
								>
									{t`Select Image`}
								</Button>
							)}
						</div>

						<Input
							label={t`Google Verification`}
							value={formData.seo?.googleVerification || ""}
							onChange={(e) => handleSeoChange("googleVerification", e.target.value)}
							description={t`Meta tag content for Google Search Console verification`}
						/>
						<Input
							label={t`Bing Verification`}
							value={formData.seo?.bingVerification || ""}
							onChange={(e) => handleSeoChange("bingVerification", e.target.value)}
							description={t`Meta tag content for Bing Webmaster Tools verification`}
						/>
						<InputArea
							label="robots.txt"
							value={formData.seo?.robotsTxt || ""}
							onChange={(e) => handleSeoChange("robotsTxt", e.target.value)}
							rows={5}
							description={t`Custom robots.txt content. Leave empty to use the default.`}
						/>
					</div>
				</div>

				{/* Save Button */}
				<div className="flex justify-end">
					<Button type="submit" disabled={saveMutation.isPending} icon={<FloppyDisk />}>
						{saveMutation.isPending ? t`Saving...` : t`Save SEO Settings`}
					</Button>
				</div>
			</form>

			{/* Media Picker Modal --
			    localOnly: storage shape is `{ mediaId }`, so URL/provider selections would
			    yield references the server cannot resolve. See MediaPickerModalProps.localOnly.
			    mimeTypeFilters: social-card scrapers expect rasterised content; SVG also gets
			    served as `Content-Disposition: attachment` by the media file route, making it
			    unusable as an OG image. */}
			<MediaPickerModal
				open={ogImagePickerOpen}
				onOpenChange={setOgImagePickerOpen}
				onSelect={handleDefaultOgImageSelect}
				mimeTypeFilters={["image/jpeg", "image/png", "image/webp", "image/gif"]}
				localOnly
				title={t`Select Default Social Image`}
			/>
		</div>
	);
}

export default SeoSettings;
