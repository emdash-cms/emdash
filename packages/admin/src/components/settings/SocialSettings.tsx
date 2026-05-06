/**
 * Social Settings sub-page
 *
 * Social media profile links (Twitter, GitHub, Facebook, Instagram, LinkedIn, YouTube).
 */

import { Button, Input } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { FloppyDisk, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { fetchSettings, updateSettings, type SiteSettings } from "../../lib/api";
import { ArrowPrev } from "../ArrowIcons.js";
import { EditorHeader } from "../EditorHeader";

export function SocialSettings() {
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
			setSaveStatus({ type: "success", message: t`Social links saved` });
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
			<div className="space-y-6">
				<div className="flex items-center gap-3">
					<Link to="/settings">
						<Button variant="ghost" shape="square" aria-label={t`Back to settings`}>
							<ArrowPrev className="h-4 w-4" />
						</Button>
					</Link>
					<h1 className="text-2xl font-bold">{t`Social Links`}</h1>
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
				leading={
					<Link to="/settings">
						<Button variant="ghost" shape="square" aria-label={t`Back to settings`}>
							<ArrowPrev className="h-4 w-4" />
						</Button>
					</Link>
				}
				actions={
					<Button
						type="submit"
						form="social-settings-form"
						disabled={saveMutation.isPending}
						icon={<FloppyDisk />}
					>
						{saveMutation.isPending ? t`Saving...` : t`Save Social Links`}
					</Button>
				}
			>
				<h1 className="text-2xl font-bold truncate">{t`Social Links`}</h1>
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

			<form id="social-settings-form" onSubmit={handleSubmit} className="space-y-6">
				<div className="rounded-lg border bg-kumo-base p-6">
					<h2 className="mb-4 text-lg font-semibold">{t`Social Profiles`}</h2>
					<p className="text-sm text-kumo-subtle mb-6">
						{t`Add your social media profiles. These are available to your site's theme and can be displayed in headers, footers, or author bios.`}
					</p>
					<div className="space-y-4">
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
					</div>
				</div>

				{/* Save Button */}
				<div className="flex justify-end">
					<Button type="submit" disabled={saveMutation.isPending} icon={<FloppyDisk />}>
						{saveMutation.isPending ? t`Saving...` : t`Save Social Links`}
					</Button>
				</div>
			</form>
		</div>
	);
}

export default SocialSettings;
