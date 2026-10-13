/**
 * General Settings sub-page
 *
 * Site Identity (title, tagline, URL, logo, favicon) and Reading settings
 * (posts per page, date format, timezone).
 */

import { Autocomplete, Banner, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ArrowSquareOut, WarningCircle, Upload, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, type Locale } from "date-fns";
import * as React from "react";

import {
	createSignInHandover,
	fetchEmailSettings,
	fetchManifest,
	fetchSettings,
	fetchSiteDomain,
	notifyUsersOfDomain,
	updateSettings,
	type MediaItem,
	type SiteSettings,
	type SiteSettingsUpdate,
} from "../../lib/api";
import { useDateLocale } from "../../locales/date-locale.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { MediaPickerModal } from "../MediaPickerModal";
import { SaveButton } from "../SaveButton.js";
import { ChangeDomainDialog } from "./ChangeDomainDialog.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

const timezones = ["UTC", ...Intl.supportedValuesOf("timeZone")];
const exampleDate = new Date(2026, 0, 23);
function datePreview(pattern: string, locale: Locale): string | null {
	try {
		return pattern.trim() ? format(exampleDate, pattern, { locale }) : null;
	} catch {
		return null;
	}
}

function isValidTimezone(timezone: string): boolean {
	try {
		Intl.DateTimeFormat("en", { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}

function generalSettingsSnapshot(settings: SiteSettingsUpdate) {
	return JSON.stringify({
		title: settings.title ?? "",
		tagline: settings.tagline ?? "",
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
	const { data: siteDomain } = useQuery({
		queryKey: ["site-domain"],
		queryFn: fetchSiteDomain,
	});
	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});
	const { data: emailSettings } = useQuery({
		queryKey: ["email-settings"],
		queryFn: fetchEmailSettings,
	});
	const siteHost =
		siteDomain?.siteOrigin && manifest && (!manifest.authMode || manifest.authMode === "passkey")
			? new URL(siteDomain.siteOrigin).host
			: null;
	const handoverHost = siteDomain?.siteOrigin !== window.location.origin ? siteHost : null;

	const [formData, setFormData] = React.useState<SiteSettingsUpdate>({});
	const [savedFormData, setSavedFormData] = React.useState<SiteSettingsUpdate>({});
	const [logoPickerOpen, setLogoPickerOpen] = React.useState(false);
	const [faviconPickerOpen, setFaviconPickerOpen] = React.useState(false);
	const [domainDialogOpen, setDomainDialogOpen] = React.useState(false);
	const [notifyDialogOpen, setNotifyDialogOpen] = React.useState(false);
	const [showTimezoneError, setShowTimezoneError] = React.useState(false);
	const dateLocale = useDateLocale();

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
		mutationFn: (data: SiteSettingsUpdate) => updateSettings(data),
		onSuccess: (_savedSettings, submittedSettings) => {
			setSavedFormData(submittedSettings);
			void queryClient.invalidateQueries({ queryKey: ["settings"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
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

	const handoverMutation = useMutation({
		mutationFn: createSignInHandover,
		onSuccess: ({ url }) => window.location.assign(url),
		onError: (error) => {
			toastManager.add({
				title: t`Failed to create a sign-in link`,
				description: error instanceof Error ? error.message : t`An error occurred`,
				variant: "error",
				timeout: 3000,
			});
		},
	});

	const notifyMutation = useMutation({
		mutationFn: notifyUsersOfDomain,
		onSuccess: ({ sent, failed }) => {
			setNotifyDialogOpen(false);
			toastManager.add({
				title: plural(sent, { one: "Emailed # user", other: "Emailed # users" }),
				description:
					failed > 0
						? plural(failed, {
								one: "# email could not be sent. Check the email provider.",
								other: "# emails could not be sent. Check the email provider.",
							})
						: undefined,
				variant: failed > 0 ? "warning" : "success",
				timeout: 8000,
			});
		},
	});

	const pattern = formData.dateFormat ?? "MMMM d, yyyy";
	const preview = datePreview(pattern, dateLocale);
	const timezone = formData.timezone ?? "UTC";
	const recognizedTimezone = isValidTimezone(timezone);
	const savedTimezoneUnchanged = timezone === savedFormData.timezone;
	const canSaveTimezone = recognizedTimezone || savedTimezoneUnchanged;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setShowTimezoneError(true);
		if (!canSaveTimezone) return;
		// The Change domain dialog owns the Site URL.
		const { url: _url, ...withoutUrl } = formData;
		saveMutation.mutate(withoutUrl);
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

	const handleDomainChanged = (url: string, checked: boolean) => {
		setDomainDialogOpen(false);
		setFormData((prev) => ({ ...prev, url }));
		// Refetching now would reset unsaved edits in this form.
		void queryClient.invalidateQueries({ queryKey: ["settings"], refetchType: "none" });
		void queryClient.invalidateQueries({ queryKey: ["site-domain"] });
		toastManager.add({
			title: checked ? t`Domain changed to ${url}` : t`Site URL set to ${url}`,
			description: t`Passkeys only work at the address where they were created.`,
			variant: "success",
			timeout: 8000,
		});
	};

	const handleLogoRemove = () => {
		setFormData((prev) => ({ ...prev, logo: null }));
	};

	const handleFaviconRemove = () => {
		setFormData((prev) => ({ ...prev, favicon: null }));
	};

	const title = t`General Settings`;
	const description = t`Site identity, logo, favicon, and reading preferences`;

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
					form="general-settings-form"
					isDirty={isDirty}
					isSaving={saveMutation.isPending}
				/>
			}
		>
			<form id="general-settings-form" onSubmit={handleSubmit} className="grid gap-8">
				<SettingsSection title={t`Site Identity`}>
					<SettingRow>
						<Input
							label={t`Site Title`}
							value={formData.title ?? ""}
							onChange={(e) => handleChange("title", e.target.value)}
							description={t`The name of your site, used in the header and metadata`}
						/>
					</SettingRow>
					<SettingRow>
						<Input
							label={t`Tagline`}
							value={formData.tagline ?? ""}
							onChange={(e) => handleChange("tagline", e.target.value)}
							description={t`A short description of your site`}
						/>
					</SettingRow>
					<SettingRow>
						<div className="grid gap-4 sm:grid-cols-2 sm:items-center">
							<div className="grid gap-1">
								<div className="text-base font-medium">{t`Site URL`}</div>
								<p className="text-sm text-kumo-subtle">
									{t`The public address of your site, used for links in emails and plugins, sitemaps, and absolute URLs in search and social metadata`}
								</p>
								{siteDomain?.configuredUrl && (
									<p className="text-sm text-kumo-subtle">
										{t`Links in emails and plugins use ${siteDomain.configuredUrl}, set by the deployment configuration.`}
									</p>
								)}
							</div>
							<div className="flex min-w-0 flex-wrap items-center gap-3 sm:justify-end">
								<span className="min-w-0 break-all font-mono text-sm" dir="ltr" translate="no">
									{formData.url || t`Not set`}
								</span>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setDomainDialogOpen(true)}
								>
									{t`Change domain`}
								</Button>
							</div>
						</div>
						{handoverHost && (
							<Banner
								className="mt-4"
								title={t`You're signed in at ${window.location.host}`}
								description={t`Passkeys only work at the address where they were created. Continue on ${handoverHost} to sign in there without a passkey, then add one for that address.`}
								action={
									<Button
										type="button"
										size="sm"
										icon={<ArrowSquareOut />}
										loading={handoverMutation.isPending || handoverMutation.isSuccess}
										onClick={() => handoverMutation.mutate()}
									>
										{t`Continue on ${handoverHost}`}
									</Button>
								}
							/>
						)}
						{siteHost && (
							<div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-4">
								<div className="grid min-w-0 gap-1">
									<div className="text-sm font-medium">{t`Tell users where to sign in`}</div>
									<p className="text-sm text-kumo-subtle">
										{emailSettings?.available === false
											? t`Set up an email provider in Email settings to email users.`
											: t`Email every other user a link to the sign-in page at ${siteHost}.`}
									</p>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={!emailSettings?.available}
									onClick={() => setNotifyDialogOpen(true)}
								>
									{t`Email users`}
								</Button>
							</div>
						)}
					</SettingRow>

					<SettingRow>
						<div className="grid gap-4 sm:grid-cols-2 sm:items-center">
							<div className="text-base font-medium">{t`Logo`}</div>
							<div className="min-w-0">
								{formData.logo?.mediaId ? (
									<div className="grid gap-3">
										{formData.logo.url ? (
											<img
												src={formData.logo.url}
												alt={formData.logo.alt || t`Logo`}
												className="emdash-media-transparency-grid h-16 max-w-full rounded border border-kumo-line object-contain p-2 sm:ms-auto"
											/>
										) : (
											<div
												className="flex min-h-16 items-start gap-2 rounded border border-dashed border-kumo-line bg-kumo-tint px-3 py-2 text-sm leading-5 text-kumo-subtle"
												role="status"
											>
												<span className="flex h-5 shrink-0 items-center" aria-hidden="true">
													<WarningCircle className="h-4 w-4" />
												</span>
												<span>{t`The referenced logo is no longer available. Pick a new one or remove the reference.`}</span>
											</div>
										)}
										<div className="flex flex-wrap gap-3 sm:justify-end">
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
									<div className="flex justify-end">
										<Button
											type="button"
											variant="outline"
											icon={<Upload />}
											onClick={() => setLogoPickerOpen(true)}
										>
											{t`Select Logo`}
										</Button>
									</div>
								)}
							</div>
						</div>
					</SettingRow>

					<SettingRow>
						<div className="grid gap-4 sm:grid-cols-2 sm:items-center">
							<div className="text-base font-medium">{t`Favicon`}</div>
							<div className="min-w-0">
								{formData.favicon?.mediaId ? (
									<div className="grid gap-3">
										{formData.favicon.url ? (
											<img
												src={formData.favicon.url}
												alt={t`Favicon`}
												className="emdash-media-transparency-grid h-8 w-8 rounded border border-kumo-line object-contain p-1 sm:ms-auto"
											/>
										) : (
											<div
												className="flex min-h-8 items-start gap-2 rounded border border-dashed border-kumo-line bg-kumo-tint px-3 py-2 text-sm leading-5 text-kumo-subtle"
												role="status"
											>
												<span className="flex h-5 shrink-0 items-center" aria-hidden="true">
													<WarningCircle className="h-4 w-4" />
												</span>
												<span>{t`Referenced favicon unavailable.`}</span>
											</div>
										)}
										<div className="flex flex-wrap gap-3 sm:justify-end">
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
									<div className="flex justify-end">
										<Button
											type="button"
											variant="outline"
											icon={<Upload />}
											onClick={() => setFaviconPickerOpen(true)}
										>
											{t`Select Favicon`}
										</Button>
									</div>
								)}
							</div>
						</div>
					</SettingRow>
				</SettingsSection>

				<SettingsSection title={t`Reading`}>
					<SettingRow>
						<Input
							label={t`Posts Per Page`}
							type="number"
							value={formData.postsPerPage ?? 10}
							onChange={(e) => handleChange("postsPerPage", parseInt(e.target.value, 10))}
							min={1}
							max={100}
							description={t`Number of posts to show per page on list views`}
						/>
					</SettingRow>
					<SettingRow>
						<Input
							label={t`Date Format`}
							value={pattern}
							onChange={(e) => handleChange("dateFormat", e.target.value)}
							description={
								preview === null
									? t`Preview unavailable for this format`
									: t`Example: ${pattern} → ${preview}`
							}
						/>
					</SettingRow>
					<SettingRow>
						<Autocomplete
							label={t`Timezone`}
							items={timezones}
							value={timezone}
							onValueChange={(value: string) => handleChange("timezone", value)}
							description={
								recognizedTimezone
									? t`Search for an IANA timezone (e.g., Europe/London)`
									: savedTimezoneUnchanged
										? t`This saved timezone isn't recognized. Choose a suggestion for reliable date display.`
										: t`Choose a recognized timezone for reliable date display.`
							}
							error={
								showTimezoneError && !canSaveTimezone
									? t`Enter a recognized timezone to save`
									: undefined
							}
						>
							<Autocomplete.InputGroup placeholder={t`Search timezones…`} />
							<Autocomplete.Content>
								<Autocomplete.List className="max-h-64 overflow-y-auto">
									{(item: string) => (
										<Autocomplete.Item key={item} value={item}>
											{item}
										</Autocomplete.Item>
									)}
								</Autocomplete.List>
								<Autocomplete.Empty>{t`No matching timezones`}</Autocomplete.Empty>
							</Autocomplete.Content>
						</Autocomplete>
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
			<ChangeDomainDialog
				open={domainDialogOpen}
				currentUrl={formData.url || undefined}
				configuredUrl={siteDomain?.configuredUrl ?? undefined}
				onClose={() => setDomainDialogOpen(false)}
				onChanged={handleDomainChanged}
			/>
			{siteHost && (
				<ConfirmDialog
					open={notifyDialogOpen}
					onClose={() => {
						setNotifyDialogOpen(false);
						notifyMutation.reset();
					}}
					variant="primary"
					title={t`Email all users?`}
					description={t`Every other user with an active account gets an email saying the site is now at ${siteHost}, with a link to sign in there. Passkeys from another address don't work at ${siteHost}, so users sign in with an email link and add a new passkey.`}
					confirmLabel={t`Send emails`}
					pendingLabel={t`Sending...`}
					preventCloseWhilePending
					isPending={notifyMutation.isPending}
					error={notifyMutation.error}
					onConfirm={() => notifyMutation.mutate()}
				/>
			)}
		</SettingsFrame>
	);
}

export default GeneralSettings;
