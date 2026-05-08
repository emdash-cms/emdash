/**
 * General Settings sub-page
 *
 * Site Identity (title, tagline, URL, logo, favicon) and Reading settings
 * (posts per page, date format, timezone).
 */

import { Button, Input, Label } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { FloppyDisk, CheckCircle, WarningCircle, Upload, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { fetchSettings, updateSettings, type SiteSettings, type MediaItem } from "../../lib/api";
import { EditorHeader } from "../EditorHeader";
import { MediaPickerModal } from "../MediaPickerModal";
import { BackToSettingsLink } from "./BackToSettingsLink.js";

export function GeneralSettings() {
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

	const [logoPickerOpen, setLogoPickerOpen] = React.useState(false);
	const [faviconPickerOpen, setFaviconPickerOpen] = React.useState(false);

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
			setSaveStatus({ type: "success", message: t`Settings saved successfully` });
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
			<div className="space-y-6">
				<div className="flex items-center gap-3">
					<BackToSettingsLink />
					<h1 className="text-2xl font-bold">{t`General Settings`}</h1>
				</div>
				<div className="rounded-lg border bg-kumo-base p-6">
					<p className="text-kumo-subtle">{t`Loading settings...`}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Sticky header — keeps Save in view while users scroll a long
			    settings form. The bottom "Save Settings" button is preserved
			    below so the natural last-control DOM order works for keyboard
			    and screen-reader users. */}
			<EditorHeader
				leading={<BackToSettingsLink />}
				actions={
					<Button
						type="submit"
						form="general-settings-form"
						disabled={saveMutation.isPending}
						icon={<FloppyDisk />}
					>
						{saveMutation.isPending ? t`Saving...` : t`Save Settings`}
					</Button>
				}
			>
				<h1 className="text-2xl font-bold truncate">{t`General Settings`}</h1>
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

			<form id="general-settings-form" onSubmit={handleSubmit} className="space-y-6">
				{/* Site Identity */}
				<div className="rounded-lg border bg-kumo-base p-6">
					<h2 className="mb-4 text-lg font-semibold">{t`Site Identity`}</h2>
					<div className="space-y-4">
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

						{/* Logo Picker */}
						<div>
							<Label>{t`Logo`}</Label>
							{formData.logo?.url ? (
								<div className="mt-2 space-y-2">
									<img
										src={formData.logo.url}
										alt={formData.logo.alt || t`Logo`}
										className="h-16 rounded border bg-kumo-tint object-contain p-2"
									/>
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

						{/* Favicon Picker */}
						<div>
							<Label>{t`Favicon`}</Label>
							{formData.favicon?.url ? (
								<div className="mt-2 space-y-2">
									<img
										src={formData.favicon.url}
										alt={t`Favicon`}
										className="h-8 w-8 rounded border bg-kumo-tint object-contain p-1"
									/>
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
					</div>
				</div>

				{/* Reading Settings */}
				<div className="rounded-lg border bg-kumo-base p-6">
					<h2 className="mb-4 text-lg font-semibold">{t`Reading`}</h2>
					<div className="space-y-4">
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
							description={`Example: ${formData.dateFormat || "MMMM d, yyyy"} → January 23, 2026`}
						/>
						<Input
							label={t`Timezone`}
							value={formData.timezone || "UTC"}
							onChange={(e) => handleChange("timezone", e.target.value)}
							description={t`Timezone for displaying dates (e.g., America/New_York)`}
						/>
					</div>
				</div>

				{/* Save Button */}
				<div className="flex justify-end">
					<Button type="submit" disabled={saveMutation.isPending} icon={<FloppyDisk />}>
						{saveMutation.isPending ? t`Saving...` : t`Save Settings`}
					</Button>
				</div>
			</form>

			{/* Media Picker Modals */}
			<MediaPickerModal
				open={logoPickerOpen}
				onOpenChange={setLogoPickerOpen}
				onSelect={handleLogoSelect}
				mimeTypeFilter="image/"
				title={t`Select Logo`}
			/>
			<MediaPickerModal
				open={faviconPickerOpen}
				onOpenChange={setFaviconPickerOpen}
				onSelect={handleFaviconSelect}
				mimeTypeFilter="image/"
				title={t`Select Favicon`}
			/>
		</div>
	);
}

export default GeneralSettings;
