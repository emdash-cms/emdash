/**
 * SEO Settings sub-page
 *
 * Title separator, search engine verification codes, and robots.txt.
 */

import { Button, Input, InputArea, Label, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { WarningCircle, Upload, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { fetchSettings, updateSettings, type SiteSettings, type MediaItem } from "../../lib/api";
import { getMutationError } from "../DialogError.js";
import { MediaPickerModal } from "../MediaPickerModal";
import { SaveButton } from "../SaveButton.js";
import { BackToSettingsLink } from "./BackToSettingsLink.js";
import {
	SettingsErrorState,
	SettingsFrame,
	SettingsLoadingState,
	SettingsSection,
} from "./SettingsLayout.js";

export function SeoSettings() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();

	const {
		data: settings,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["settings"],
		queryFn: fetchSettings,
		staleTime: Infinity,
	});

	const [formData, setFormData] = React.useState<Partial<SiteSettings>>({});
	const [ogImagePickerOpen, setOgImagePickerOpen] = React.useState(false);

	React.useEffect(() => {
		if (settings) setFormData(settings);
	}, [settings]);

	const isDirty = Boolean(settings && JSON.stringify(formData) !== JSON.stringify(settings));

	const saveMutation = useMutation({
		mutationFn: (data: Partial<SiteSettings>) => updateSettings(data),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["settings"] });
			toastManager.add({ title: t`SEO settings saved`, variant: "success", timeout: 3000 });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: t`Failed to save settings`,
				description: getMutationError(mutationError) ?? t`An error occurred`,
				variant: "error",
				timeout: 3000,
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
			<SettingsFrame title={t`SEO Settings`} leading={<BackToSettingsLink />}>
				<SettingsLoadingState />
			</SettingsFrame>
		);
	}

	if (error || !settings) {
		return (
			<SettingsFrame title={t`SEO Settings`} leading={<BackToSettingsLink />}>
				<SettingsErrorState message={getMutationError(error) ?? t`Failed to load settings`} />
			</SettingsFrame>
		);
	}

	return (
		<SettingsFrame
			title={t`SEO Settings`}
			leading={<BackToSettingsLink />}
			actions={
				<SaveButton
					type="submit"
					form="seo-settings-form"
					isDirty={isDirty}
					isSaving={saveMutation.isPending}
				/>
			}
		>
			<form id="seo-settings-form" onSubmit={handleSubmit} className="space-y-8">
				<SettingsSection
					title={t`Search Engine Optimization`}
					description={t`Configure search appearance, verification, and crawler instructions for your site.`}
				>
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
						label={t`robots.txt`}
						value={formData.seo?.robotsTxt || ""}
						onChange={(e) => handleSeoChange("robotsTxt", e.target.value)}
						rows={5}
						description={t`Custom robots.txt content. Leave empty to use the default.`}
					/>
				</SettingsSection>

				<div className="flex justify-end">
					<SaveButton type="submit" isDirty={isDirty} isSaving={saveMutation.isPending} />
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
		</SettingsFrame>
	);
}

export default SeoSettings;
