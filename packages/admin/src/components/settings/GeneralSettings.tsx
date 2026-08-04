/**
 * General Settings sub-page
 *
 * Site Identity (title, tagline, URL, logo, favicon) and Reading settings
 * (posts per page, date format, timezone).
 */

import { Button, Input, Label, useKumoToastManager } from "@cloudflare/kumo";
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

export function GeneralSettings() {
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
	const [logoPickerOpen, setLogoPickerOpen] = React.useState(false);
	const [faviconPickerOpen, setFaviconPickerOpen] = React.useState(false);

	React.useEffect(() => {
		if (settings) setFormData(settings);
	}, [settings]);

	const isDirty = Boolean(settings && JSON.stringify(formData) !== JSON.stringify(settings));

	const saveMutation = useMutation({
		mutationFn: (data: Partial<SiteSettings>) => updateSettings(data),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["settings"] });
			toastManager.add({
				title: t`Settings saved successfully`,
				variant: "success",
				timeout: 3000,
			});
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

	if (isLoading) {
		return (
			<SettingsFrame title={t`General Settings`} leading={<BackToSettingsLink />}>
				<SettingsLoadingState />
			</SettingsFrame>
		);
	}

	if (error || !settings) {
		return (
			<SettingsFrame title={t`General Settings`} leading={<BackToSettingsLink />}>
				<SettingsErrorState message={getMutationError(error) ?? t`Failed to load settings`} />
			</SettingsFrame>
		);
	}

	return (
		<SettingsFrame
			title={t`General Settings`}
			leading={<BackToSettingsLink />}
			actions={
				<SaveButton
					type="submit"
					form="general-settings-form"
					isDirty={isDirty}
					isSaving={saveMutation.isPending}
				/>
			}
		>
			<form id="general-settings-form" onSubmit={handleSubmit} className="space-y-8">
				<SettingsSection title={t`Site Identity`}>
					<Input
						label={t`Site Title`}
						value={formData.title || ""}
						onChange={(e) => handleChange("title", e.target.value)}
						description={t`The name of your site, used in the header and metadata`}
					/>
					<Input
						label={t`Tagline`}
						value={formData.tagline || ""}
						onChange={(e) => handleChange("tagline", e.target.value)}
						description={t`A short description of your site`}
					/>
					<Input
						label={t`Site URL`}
						type="url"
						value={formData.url || ""}
						onChange={(e) => handleChange("url", e.target.value)}
						description={t`The public URL of your site (used for canonical links and sitemaps)`}
					/>

					{/* Logo Picker --
						    "configured" gates on `mediaId`, not `url`, so an orphaned
						    reference (media row deleted, or a stale provider id stored
						    pre-localOnly fix) still renders Remove. Otherwise the user
						    would see "Select Logo" and silently re-save the dangling
						    `mediaId` on any unrelated change. */}
					<div>
						<Label>{t`Logo`}</Label>
						{formData.logo?.mediaId ? (
							<div className="mt-2 space-y-2">
								{formData.logo.url ? (
									<img
										src={formData.logo.url}
										alt={formData.logo.alt || t`Logo`}
										className="h-16 rounded border bg-kumo-tint object-contain p-2"
									/>
								) : (
									<div
										className="flex min-h-16 items-center gap-2 rounded border border-dashed bg-kumo-tint px-3 py-2 text-sm text-kumo-subtle"
										role="status"
									>
										<WarningCircle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
										<span>{t`The referenced logo is no longer available. Pick a new one or remove the reference.`}</span>
									</div>
								)}
								<div className="flex gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										icon={<Upload />}
										onClick={() => setLogoPickerOpen(true)}
									>
										{t`Change Logo`}
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
								className="mt-2"
							>
								{t`Select Logo`}
							</Button>
						)}
					</div>

					{/* Favicon Picker — see Logo Picker for the orphan-state rationale. */}
					<div>
						<Label>{t`Favicon`}</Label>
						{formData.favicon?.mediaId ? (
							<div className="mt-2 space-y-2">
								{formData.favicon.url ? (
									<img
										src={formData.favicon.url}
										alt={t`Favicon`}
										className="h-8 w-8 rounded border bg-kumo-tint object-contain p-1"
									/>
								) : (
									<div
										className="flex min-h-8 items-center gap-2 rounded border border-dashed bg-kumo-tint px-2 py-1 text-xs text-kumo-subtle"
										role="status"
									>
										<WarningCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
										<span>{t`Referenced favicon unavailable.`}</span>
									</div>
								)}
								<div className="flex gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										icon={<Upload />}
										onClick={() => setFaviconPickerOpen(true)}
									>
										{t`Change Favicon`}
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
								className="mt-2"
							>
								{t`Select Favicon`}
							</Button>
						)}
					</div>
				</SettingsSection>

				<SettingsSection title={t`Reading`}>
					<Input
						label={t`Posts Per Page`}
						type="number"
						value={formData.postsPerPage || 10}
						onChange={(e) => handleChange("postsPerPage", parseInt(e.target.value, 10))}
						min={1}
						max={100}
						description={t`Number of posts to show per page on list views`}
					/>
					<Input
						label={t`Date Format`}
						value={formData.dateFormat || "MMMM d, yyyy"}
						onChange={(e) => handleChange("dateFormat", e.target.value)}
						description={t`Example: ${formData.dateFormat || "MMMM d, yyyy"} → January 23, 2026`}
					/>
					<Input
						label={t`Timezone`}
						value={formData.timezone || "UTC"}
						onChange={(e) => handleChange("timezone", e.target.value)}
						description={t`Timezone for displaying dates (e.g., America/New_York)`}
					/>
				</SettingsSection>

				<div className="flex justify-end">
					<SaveButton type="submit" isDirty={isDirty} isSaving={saveMutation.isPending} />
				</div>
			</form>

			{/* Media Picker Modals --
			    localOnly: site settings only persist a local `mediaId`. URL/provider
			    selections would be stripped on save, leaving an unresolvable reference.
			    See MediaPickerModalProps.localOnly. */}
			<MediaPickerModal
				open={logoPickerOpen}
				onOpenChange={setLogoPickerOpen}
				onSelect={handleLogoSelect}
				mimeTypeFilter="image/"
				localOnly
				title={t`Select Logo`}
			/>
			<MediaPickerModal
				open={faviconPickerOpen}
				onOpenChange={setFaviconPickerOpen}
				onSelect={handleFaviconSelect}
				mimeTypeFilter="image/"
				localOnly
				title={t`Select Favicon`}
			/>
		</SettingsFrame>
	);
}

export default GeneralSettings;
