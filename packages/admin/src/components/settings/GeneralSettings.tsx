/**
 * General Settings sub-page
 *
 * Site Identity (title, tagline, URL, logo, favicon) and Reading settings
 * (posts per page, date format, timezone).
 */

import { Banner, Button, Field, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { WarningCircle, Upload, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { fetchSettings, updateSettings, type SiteSettings, type MediaItem } from "../../lib/api";
import { MediaPickerModal } from "../MediaPickerModal";
import { SaveButton } from "../SaveButton.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

function generalSettingsSnapshot(settings: Partial<SiteSettings>) {
	return JSON.stringify({
		title: settings.title ?? "",
		tagline: settings.tagline ?? "",
		url: settings.url ?? "",
		logo: settings.logo ?? null,
		favicon: settings.favicon ?? null,
		postsPerPage: settings.postsPerPage ?? 10,
		dateFormat: settings.dateFormat ?? "MMMM d, yyyy",
		timezone: settings.timezone ?? "UTC",
	});
}

export function GeneralSettings() {
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
	const [logoPickerOpen, setLogoPickerOpen] = React.useState(false);
	const [faviconPickerOpen, setFaviconPickerOpen] = React.useState(false);

	React.useEffect(() => {
		if (settings) {
			setFormData(settings);
			setSavedFormData(settings);
		}
	}, [settings]);

	const isDirty = React.useMemo(
		() => generalSettingsSnapshot(formData) !== generalSettingsSnapshot(savedFormData),
		[formData, savedFormData],
	);

	const saveMutation = useMutation({
		mutationFn: (data: Partial<SiteSettings>) => updateSettings(data),
		onSuccess: (_savedSettings, submittedSettings) => {
			setSavedFormData(submittedSettings);
			void queryClient.invalidateQueries({ queryKey: ["settings"] });
			toastManager.add({
				title: t`Settings saved successfully`,
				variant: "success",
				timeout: 3000,
			});
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

	const handleChange = (key: keyof SiteSettings, value: unknown) => {
		setFormData((prev) => ({ ...prev, [key]: value }));
	};

	const handleLogoSelect = (media: MediaItem) => {
		setFormData((prev) => ({
			...prev,
			logo: { mediaId: media.id, alt: media.alt || "", url: media.url },
		}));
		setLogoPickerOpen(false);
	};

	const handleFaviconSelect = (media: MediaItem) => {
		setFormData((prev) => ({
			...prev,
			favicon: { mediaId: media.id, url: media.url },
		}));
		setFaviconPickerOpen(false);
	};

	const handleLogoRemove = () => {
		setFormData((prev) => ({ ...prev, logo: undefined }));
	};

	const handleFaviconRemove = () => {
		setFormData((prev) => ({ ...prev, favicon: undefined }));
	};

	const title = t`General settings`;
	const description = t`Manage your site identity and reading defaults.`;

	if (isLoading) {
		return (
			<SettingsFrame title={title} description={description}>
				<div
					className="flex items-center gap-2 rounded-xl border border-kumo-line bg-kumo-base px-4 py-4 text-sm text-kumo-subtle"
					role="status"
				>
					<Loader size="sm" />
					<span>{t`Loading settings…`}</span>
				</div>
			</SettingsFrame>
		);
	}

	if (loadError) {
		return (
			<SettingsFrame title={title} description={description}>
				<Banner
					variant="error"
					title={t`Unable to load general settings`}
					description={loadError instanceof Error ? loadError.message : t`Failed to load settings`}
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
					form="general-settings-form"
					isDirty={isDirty}
					isSaving={saveMutation.isPending}
				/>
			}
		>
			<form id="general-settings-form" onSubmit={handleSubmit} className="grid gap-8">
				<SettingsSection
					title={t`Site identity`}
					description={t`Set your site title, tagline, address, logo, and favicon.`}
				>
					<SettingRow>
						<Input
							label={t`Site title`}
							value={formData.title ?? ""}
							onChange={(e) => handleChange("title", e.target.value)}
							description={t`The name shown in your site header and metadata.`}
						/>
					</SettingRow>
					<SettingRow>
						<Input
							label={t`Tagline`}
							value={formData.tagline ?? ""}
							onChange={(e) => handleChange("tagline", e.target.value)}
							description={t`A short description of your site.`}
						/>
					</SettingRow>
					<SettingRow>
						<Input
							label={t`Site URL`}
							type="url"
							value={formData.url ?? ""}
							onChange={(e) => handleChange("url", e.target.value)}
							description={t`The public URL used for canonical links and sitemaps.`}
						/>
					</SettingRow>

					<SettingRow>
						<Field label={t`Logo`} description={t`Used in your site header and branding.`}>
							{formData.logo?.mediaId ? (
								<div className="grid gap-3">
									{formData.logo.url ? (
										<img
											src={formData.logo.url}
											alt={formData.logo.alt || t`Logo`}
											className="h-16 max-w-full rounded border border-kumo-line bg-kumo-tint object-contain p-2"
										/>
									) : (
										<div
											className="flex min-h-16 items-start gap-2 rounded border border-dashed border-kumo-line bg-kumo-tint px-3 py-2 text-sm leading-5 text-kumo-subtle"
											role="status"
										>
											<span className="h-lh flex shrink-0 items-center" aria-hidden="true">
												<WarningCircle className="h-4 w-4" />
											</span>
											<span>{t`The referenced logo is no longer available. Pick a new one or remove the reference.`}</span>
										</div>
									)}
									<div className="flex flex-wrap gap-3">
										<Button
											type="button"
											variant="outline"
											size="sm"
											icon={<Upload />}
											onClick={() => setLogoPickerOpen(true)}
										>
											{t`Change logo`}
										</Button>
										<Button
											type="button"
											variant="outline"
											size="sm"
											icon={<X />}
											onClick={handleLogoRemove}
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
									onClick={() => setLogoPickerOpen(true)}
								>
									{t`Select logo`}
								</Button>
							)}
						</Field>
					</SettingRow>

					<SettingRow>
						<Field
							label={t`Favicon`}
							description={t`The icon shown in browser tabs and bookmarks.`}
						>
							{formData.favicon?.mediaId ? (
								<div className="grid gap-3">
									{formData.favicon.url ? (
										<img
											src={formData.favicon.url}
											alt={t`Favicon`}
											className="h-8 w-8 rounded border border-kumo-line bg-kumo-tint object-contain p-1"
										/>
									) : (
										<div
											className="flex min-h-8 items-start gap-2 rounded border border-dashed border-kumo-line bg-kumo-tint px-3 py-2 text-sm leading-5 text-kumo-subtle"
											role="status"
										>
											<span className="h-lh flex shrink-0 items-center" aria-hidden="true">
												<WarningCircle className="h-4 w-4" />
											</span>
											<span>{t`The referenced favicon is no longer available. Pick a new one or remove the reference.`}</span>
										</div>
									)}
									<div className="flex flex-wrap gap-3">
										<Button
											type="button"
											variant="outline"
											size="sm"
											icon={<Upload />}
											onClick={() => setFaviconPickerOpen(true)}
										>
											{t`Change favicon`}
										</Button>
										<Button
											type="button"
											variant="outline"
											size="sm"
											icon={<X />}
											onClick={handleFaviconRemove}
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
									onClick={() => setFaviconPickerOpen(true)}
								>
									{t`Select favicon`}
								</Button>
							)}
						</Field>
					</SettingRow>
				</SettingsSection>

				<SettingsSection
					title={t`Reading`}
					description={t`Choose how posts and dates are displayed.`}
				>
					<SettingRow>
						<Input
							label={t`Posts per page`}
							type="number"
							value={formData.postsPerPage ?? 10}
							onChange={(e) => handleChange("postsPerPage", parseInt(e.target.value, 10))}
							min={1}
							max={100}
							description={t`The number of posts shown on each listing page.`}
						/>
					</SettingRow>
					<SettingRow>
						<Input
							label={t`Date format`}
							value={formData.dateFormat ?? "MMMM d, yyyy"}
							onChange={(e) => handleChange("dateFormat", e.target.value)}
							description={t`Example: ${formData.dateFormat ?? "MMMM d, yyyy"} → January 23, 2026`}
						/>
					</SettingRow>
					<SettingRow>
						<Input
							label={t`Timezone`}
							value={formData.timezone ?? "UTC"}
							onChange={(e) => handleChange("timezone", e.target.value)}
							description={t`The timezone used to display dates, for example America/New_York.`}
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

			<MediaPickerModal
				open={logoPickerOpen}
				onOpenChange={setLogoPickerOpen}
				onSelect={handleLogoSelect}
				mimeTypeFilter="image/"
				localOnly
				title={t`Select logo`}
			/>
			<MediaPickerModal
				open={faviconPickerOpen}
				onOpenChange={setFaviconPickerOpen}
				onSelect={handleFaviconSelect}
				mimeTypeFilter="image/"
				localOnly
				title={t`Select favicon`}
			/>
		</SettingsFrame>
	);
}

export default GeneralSettings;
