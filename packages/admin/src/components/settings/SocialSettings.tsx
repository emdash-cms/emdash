/**
 * Social Settings sub-page
 *
 * Social media profile links (Twitter, GitHub, Facebook, Instagram, LinkedIn, YouTube).
 */

import { Banner, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { fetchSettings, updateSettings, type SiteSettings } from "../../lib/api";
import { SaveButton } from "../SaveButton.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

function socialSettingsSnapshot(settings: Partial<SiteSettings>) {
	return JSON.stringify({
		twitter: settings.social?.twitter ?? "",
		github: settings.social?.github ?? "",
		facebook: settings.social?.facebook ?? "",
		instagram: settings.social?.instagram ?? "",
		linkedin: settings.social?.linkedin ?? "",
		youtube: settings.social?.youtube ?? "",
	});
}

export function SocialSettings() {
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

	React.useEffect(() => {
		if (settings) {
			setFormData(settings);
			setSavedFormData(settings);
		}
	}, [settings]);

	const isDirty = React.useMemo(
		() => socialSettingsSnapshot(formData) !== socialSettingsSnapshot(savedFormData),
		[formData, savedFormData],
	);

	const saveMutation = useMutation({
		mutationFn: (data: Partial<SiteSettings>) => updateSettings(data),
		onSuccess: (_savedSettings, submittedSettings) => {
			setSavedFormData(submittedSettings);
			void queryClient.invalidateQueries({ queryKey: ["settings"] });
			toastManager.add({ title: t`Social links saved`, variant: "success", timeout: 3000 });
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

	const handleSocialChange = (key: string, value: string) => {
		setFormData((prev) => ({
			...prev,
			social: {
				...prev.social,
				[key]: value,
			},
		}));
	};

	const title = t`Social Links`;
	const description = t`Social media profile links`;

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
					form="social-settings-form"
					isDirty={isDirty}
					isSaving={saveMutation.isPending}
				/>
			}
		>
			<form id="social-settings-form" onSubmit={handleSubmit} className="grid gap-8">
				<SettingsSection
					title={t`Social Profiles`}
					description={t`Add your social media profiles. These are available to your site's theme and can be displayed in headers, footers, or author bios.`}
				>
					<SettingRow>
						<Input
							label={t`Twitter`}
							value={formData.social?.twitter ?? ""}
							onChange={(e) => handleSocialChange("twitter", e.target.value)}
							description={t`Your Twitter/X handle (e.g., @username)`}
						/>
					</SettingRow>
					<SettingRow>
						<Input
							label={t`GitHub`}
							value={formData.social?.github ?? ""}
							onChange={(e) => handleSocialChange("github", e.target.value)}
							description={t`Your GitHub username`}
						/>
					</SettingRow>
					<SettingRow>
						<Input
							label={t`Facebook`}
							value={formData.social?.facebook ?? ""}
							onChange={(e) => handleSocialChange("facebook", e.target.value)}
							description={t`Your Facebook page or profile username`}
						/>
					</SettingRow>
					<SettingRow>
						<Input
							label={t`Instagram`}
							value={formData.social?.instagram ?? ""}
							onChange={(e) => handleSocialChange("instagram", e.target.value)}
							description={t`Your Instagram username`}
						/>
					</SettingRow>
					<SettingRow>
						<Input
							label={t`LinkedIn`}
							value={formData.social?.linkedin ?? ""}
							onChange={(e) => handleSocialChange("linkedin", e.target.value)}
							description={t`Your LinkedIn profile username`}
						/>
					</SettingRow>
					<SettingRow>
						<Input
							label={t`YouTube`}
							value={formData.social?.youtube ?? ""}
							onChange={(e) => handleSocialChange("youtube", e.target.value)}
							description={t`Your YouTube channel ID or handle`}
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
		</SettingsFrame>
	);
}

export default SocialSettings;
