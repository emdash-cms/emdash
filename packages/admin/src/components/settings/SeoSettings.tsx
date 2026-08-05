/**
 * SEO Settings sub-page
 *
 * Title separator, search engine verification codes, and robots.txt.
 */

import {
	Banner,
	Button,
	Field,
	Input,
	InputArea,
	Loader,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Upload, WarningCircle, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { fetchSettings, updateSettings, type MediaItem, type SiteSettings } from "../../lib/api";
import { MediaPickerModal } from "../MediaPickerModal";
import { SaveButton } from "../SaveButton.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

function seoSettingsSnapshot(settings: Partial<SiteSettings>) {
	return JSON.stringify({
		titleSeparator: settings.seo?.titleSeparator || "|",
		defaultOgImage: settings.seo?.defaultOgImage ?? null,
		googleVerification: settings.seo?.googleVerification ?? "",
		bingVerification: settings.seo?.bingVerification ?? "",
		robotsTxt: settings.seo?.robotsTxt ?? "",
	});
}

export function SeoSettings() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();

	const {
		data: settings,
		isLoading,
		error: loadError,
	} = useQuery({
		queryKey: ["settings"],
		queryFn: fetchSettings,
		staleTime: Infinity,
	});

	const [formData, setFormData] = React.useState<Partial<SiteSettings>>({});
	const [savedFormData, setSavedFormData] = React.useState<Partial<SiteSettings>>({});
	const [ogImagePickerOpen, setOgImagePickerOpen] = React.useState(false);

	React.useEffect(() => {
		if (settings) {
			setFormData(settings);
			setSavedFormData(settings);
		}
	}, [settings]);

	const isDirty = React.useMemo(
		() => seoSettingsSnapshot(formData) !== seoSettingsSnapshot(savedFormData),
		[formData, savedFormData],
	);

	const saveMutation = useMutation({
		mutationFn: (data: Partial<SiteSettings>) => updateSettings(data),
		onSuccess: (_savedSettings, submittedSettings) => {
			setSavedFormData(submittedSettings);
			void queryClient.invalidateQueries({ queryKey: ["settings"] });
			toastManager.add({ title: t`SEO settings saved`, variant: "success", timeout: 3000 });
		},
		onError: (error) => {
			toastManager.add({
				title: t`Failed to save settings`,
				description: error instanceof Error ? error.message : t`An error occurred`,
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

	const title = t`SEO Settings`;
	const description = t`Search engine optimization and verification`;

	if (isLoading) {
		return (
			<SettingsFrame title={title} description={description}>
				<div
					className="flex items-center gap-2 rounded-xl border border-kumo-line bg-kumo-base px-4 py-4 text-sm text-kumo-subtle"
					role="status"
				>
					<Loader size="sm" />
					<span>{t`Loading settings...`}</span>
				</div>
			</SettingsFrame>
		);
	}

	if (loadError && settings === undefined) {
		return (
			<SettingsFrame title={title} description={description}>
				<Banner
					variant="error"
					title={t`An error occurred`}
					description={loadError instanceof Error ? loadError.message : t`An error occurred`}
					role="alert"
				/>
			</SettingsFrame>
		);
	}

	return (
		<SettingsFrame
			title={title}
			description={description}
			actions={
				<SaveButton
					type="submit"
					form="seo-settings-form"
					isDirty={isDirty}
					isSaving={saveMutation.isPending}
				/>
			}
		>
			<form id="seo-settings-form" onSubmit={handleSubmit} className="grid gap-8">
				<SettingsSection title={t`Search Engine Optimization`}>
					<SettingRow>
						<Input
							label={t`Title Separator`}
							value={formData.seo?.titleSeparator || "|"}
							onChange={(e) => handleSeoChange("titleSeparator", e.target.value)}
							description={t`Character between page title and site name (e.g., "My Post | My Site")`}
						/>
					</SettingRow>
					<SettingRow>
						<Field
							label={t`Default Social Image`}
							description={t`Used as the fallback Open Graph image when a page has none. Recommended size: 1200×630.`}
						>
							{/* A missing URL can represent an orphaned media reference, so mediaId remains the configured-state signal. */}
							{formData.seo?.defaultOgImage?.mediaId ? (
								<div className="grid gap-3">
									{formData.seo.defaultOgImage.url ? (
										<img
											src={formData.seo.defaultOgImage.url}
											alt={formData.seo.defaultOgImage.alt || t`Default social image`}
											className="h-32 max-w-full rounded border border-kumo-line bg-kumo-tint object-contain p-2"
										/>
									) : (
										<div
											className="flex min-h-32 items-start gap-2 rounded border border-dashed border-kumo-line bg-kumo-tint px-3 py-2 text-sm leading-5 text-kumo-subtle"
											role="status"
										>
											<span className="flex h-5 shrink-0 items-center" aria-hidden="true">
												<WarningCircle className="h-4 w-4" />
											</span>
											<span>{t`The referenced image is no longer available. Pick a new one or remove the reference.`}</span>
										</div>
									)}
									<div className="flex flex-wrap gap-3">
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
								>
									{t`Select Image`}
								</Button>
							)}
						</Field>
					</SettingRow>
				</SettingsSection>

				<SettingsSection
					title={
						<>
							{t`Google Verification`} / {t`Bing Verification`}
						</>
					}
				>
					<SettingRow>
						<Input
							label={t`Google Verification`}
							value={formData.seo?.googleVerification || ""}
							onChange={(e) => handleSeoChange("googleVerification", e.target.value)}
							description={t`Meta tag content for Google Search Console verification`}
						/>
					</SettingRow>
					<SettingRow>
						<Input
							label={t`Bing Verification`}
							value={formData.seo?.bingVerification || ""}
							onChange={(e) => handleSeoChange("bingVerification", e.target.value)}
							description={t`Meta tag content for Bing Webmaster Tools verification`}
						/>
					</SettingRow>
				</SettingsSection>

				<SettingsSection title={t`robots.txt`}>
					<SettingRow>
						<InputArea
							label={t`robots.txt`}
							value={formData.seo?.robotsTxt || ""}
							onChange={(e) => handleSeoChange("robotsTxt", e.target.value)}
							rows={5}
							description={t`Custom robots.txt content. Leave empty to use the default.`}
						/>
					</SettingRow>
				</SettingsSection>

				<div className="flex justify-end">
					<SaveButton
						type="submit"
						isDirty={isDirty}
						isSaving={saveMutation.isPending}
						announce={false}
					/>
				</div>
			</form>

			{/* Local raster images produce resolvable stored references suitable for social-card scrapers. */}
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
