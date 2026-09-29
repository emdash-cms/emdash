/**
 * General Settings sub-page
 *
 * Site Identity (title, tagline, URL, logo, favicon) and Reading settings
 * (posts per page, date format, timezone).
 */

import { Autocomplete, Banner, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { WarningCircle, Upload, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, type Locale } from "date-fns";
import { enUS } from "date-fns/locale/en-US";
import * as React from "react";

import {
	fetchSettings,
	updateSettings,
	type MediaItem,
	type SiteSettings,
	type SiteSettingsUpdate,
} from "../../lib/api";
import { MediaPickerModal } from "../MediaPickerModal";
import { SaveButton } from "../SaveButton.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

const timezones = ["UTC", ...Intl.supportedValuesOf("timeZone")];
const exampleDate = new Date(2026, 0, 23);
const previewLocaleLoaders: Record<string, () => Promise<Locale>> = {
	ar: () => import("date-fns/locale/ar").then(({ ar }) => ar),
	eu: () => import("date-fns/locale/eu").then(({ eu }) => eu),
	bn: () => import("date-fns/locale/bn").then(({ bn }) => bn),
	ca: () => import("date-fns/locale/ca").then(({ ca }) => ca),
	"zh-CN": () => import("date-fns/locale/zh-CN").then(({ zhCN }) => zhCN),
	"zh-TW": () => import("date-fns/locale/zh-TW").then(({ zhTW }) => zhTW),
	cs: () => import("date-fns/locale/cs").then(({ cs }) => cs),
	da: () => import("date-fns/locale/da").then(({ da }) => da),
	nl: () => import("date-fns/locale/nl").then(({ nl }) => nl),
	"en-GB": () => import("date-fns/locale/en-GB").then(({ enGB }) => enGB),
	fa: () => import("date-fns/locale/fa-IR").then(({ faIR }) => faIR),
	fr: () => import("date-fns/locale/fr").then(({ fr }) => fr),
	ka: () => import("date-fns/locale/ka").then(({ ka }) => ka),
	de: () => import("date-fns/locale/de").then(({ de }) => de),
	hi: () => import("date-fns/locale/hi").then(({ hi }) => hi),
	hu: () => import("date-fns/locale/hu").then(({ hu }) => hu),
	id: () => import("date-fns/locale/id").then(({ id }) => id),
	ja: () => import("date-fns/locale/ja").then(({ ja }) => ja),
	nb: () => import("date-fns/locale/nb").then(({ nb }) => nb),
	pl: () => import("date-fns/locale/pl").then(({ pl }) => pl),
	"pt-BR": () => import("date-fns/locale/pt-BR").then(({ ptBR }) => ptBR),
	"sr-Latn": () => import("date-fns/locale/sr-Latn").then(({ srLatn }) => srLatn),
	"es-419": () => import("date-fns/locale/es").then(({ es }) => es),
	"es-ES": () => import("date-fns/locale/es").then(({ es }) => es),
	sv: () => import("date-fns/locale/sv").then(({ sv }) => sv),
	th: () => import("date-fns/locale/th").then(({ th }) => th),
	tr: () => import("date-fns/locale/tr").then(({ tr }) => tr),
	uk: () => import("date-fns/locale/uk").then(({ uk }) => uk),
};

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
		url: settings.url ?? "",
		logo: settings.logo ?? null,
		favicon: settings.favicon ?? null,
		postsPerPage: settings.postsPerPage ?? 10,
		dateFormat: settings.dateFormat ?? "MMMM d, yyyy",
		timezone: settings.timezone ?? "UTC",
	});
}

export function GeneralSettings() {
	const { t, i18n } = useLingui();
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

	const [formData, setFormData] = React.useState<SiteSettingsUpdate>({});
	const [savedFormData, setSavedFormData] = React.useState<SiteSettingsUpdate>({});
	const [logoPickerOpen, setLogoPickerOpen] = React.useState(false);
	const [faviconPickerOpen, setFaviconPickerOpen] = React.useState(false);
	const [showTimezoneError, setShowTimezoneError] = React.useState(false);
	const [previewLocale, setPreviewLocale] = React.useState<{ code: string; value: Locale | null }>({
		code: "en",
		value: enUS,
	});

	React.useEffect(() => {
		const code = i18n.locale;
		const load = previewLocaleLoaders[code];
		if (!load) {
			setPreviewLocale({ code, value: enUS });
			return;
		}
		let active = true;
		void (async () => {
			try {
				const value = await load();
				if (active) setPreviewLocale({ code, value });
			} catch {
				if (active) setPreviewLocale({ code, value: null });
			}
		})();
		return () => {
			active = false;
		};
	}, [i18n.locale]);

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

	const pattern = formData.dateFormat ?? "MMMM d, yyyy";
	const previewLoading = previewLocale.code !== i18n.locale;
	const preview =
		previewLoading || !previewLocale.value ? null : datePreview(pattern, previewLocale.value);
	const timezone = formData.timezone ?? "UTC";
	const recognizedTimezone = isValidTimezone(timezone);
	const savedTimezoneUnchanged = timezone === savedFormData.timezone;
	const canSaveTimezone = recognizedTimezone || savedTimezoneUnchanged;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setShowTimezoneError(true);
		if (!canSaveTimezone) return;
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
						<Input
							label={t`Site URL`}
							type="url"
							value={formData.url ?? ""}
							onChange={(e) => handleChange("url", e.target.value)}
							description={t`The public URL of your site (used for canonical links and sitemaps)`}
						/>
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
								previewLoading
									? t`Loading preview…`
									: preview === null
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
		</SettingsFrame>
	);
}

export default GeneralSettings;
