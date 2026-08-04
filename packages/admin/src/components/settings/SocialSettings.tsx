/**
 * Social Settings sub-page
 *
 * Social media profile links (Twitter, GitHub, Facebook, Instagram, LinkedIn, YouTube).
 */

import { Input, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { fetchSettings, updateSettings, type SiteSettings } from "../../lib/api";
import { getMutationError } from "../DialogError.js";
import { SaveButton } from "../SaveButton.js";
import { BackToSettingsLink } from "./BackToSettingsLink.js";
import {
	SettingsErrorState,
	SettingsFrame,
	SettingsLoadingState,
	SettingsSection,
} from "./SettingsLayout.js";

export function SocialSettings() {
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

	React.useEffect(() => {
		if (settings) setFormData(settings);
	}, [settings]);

	const isDirty = Boolean(settings && JSON.stringify(formData) !== JSON.stringify(settings));

	const saveMutation = useMutation({
		mutationFn: (data: Partial<SiteSettings>) => updateSettings(data),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["settings"] });
			toastManager.add({ title: t`Social links saved`, variant: "success", timeout: 3000 });
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

	const handleSocialChange = (key: string, value: string) => {
		setFormData((prev) => ({
			...prev,
			social: {
				...prev.social,
				[key]: value,
			},
		}));
	};

	if (isLoading) {
		return (
			<SettingsFrame title={t`Social Links`} leading={<BackToSettingsLink />}>
				<SettingsLoadingState />
			</SettingsFrame>
		);
	}

	if (error || !settings) {
		return (
			<SettingsFrame title={t`Social Links`} leading={<BackToSettingsLink />}>
				<SettingsErrorState message={getMutationError(error) ?? t`Failed to load settings`} />
			</SettingsFrame>
		);
	}

	return (
		<SettingsFrame
			title={t`Social Links`}
			leading={<BackToSettingsLink />}
			actions={
				<SaveButton
					type="submit"
					form="social-settings-form"
					isDirty={isDirty}
					isSaving={saveMutation.isPending}
				/>
			}
		>
			<form id="social-settings-form" onSubmit={handleSubmit} className="space-y-8">
				<SettingsSection
					title={t`Social Profiles`}
					description={t`Add your social media profiles. These are available to your site's theme and can be displayed in headers, footers, or author bios.`}
				>
					<Input
						label={t`Twitter`}
						value={formData.social?.twitter || ""}
						onChange={(e) => handleSocialChange("twitter", e.target.value)}
						description={t`Your Twitter/X handle (e.g., @username)`}
					/>
					<Input
						label={t`GitHub`}
						value={formData.social?.github || ""}
						onChange={(e) => handleSocialChange("github", e.target.value)}
						description={t`Your GitHub username`}
					/>
					<Input
						label={t`Facebook`}
						value={formData.social?.facebook || ""}
						onChange={(e) => handleSocialChange("facebook", e.target.value)}
						description={t`Your Facebook page or profile username`}
					/>
					<Input
						label={t`Instagram`}
						value={formData.social?.instagram || ""}
						onChange={(e) => handleSocialChange("instagram", e.target.value)}
						description={t`Your Instagram username`}
					/>
					<Input
						label={t`LinkedIn`}
						value={formData.social?.linkedin || ""}
						onChange={(e) => handleSocialChange("linkedin", e.target.value)}
						description={t`Your LinkedIn profile username`}
					/>
					<Input
						label={t`YouTube`}
						value={formData.social?.youtube || ""}
						onChange={(e) => handleSocialChange("youtube", e.target.value)}
						description={t`Your YouTube channel ID or handle`}
					/>
				</SettingsSection>

				<div className="flex justify-end">
					<SaveButton type="submit" isDirty={isDirty} isSaving={saveMutation.isPending} />
				</div>
			</form>
		</SettingsFrame>
	);
}

export default SocialSettings;
