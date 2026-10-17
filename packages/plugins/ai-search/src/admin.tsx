import { Banner, Button, Code, Loader, Tabs } from "@cloudflare/kumo";
import { PencilSimple } from "@phosphor-icons/react";
import type { PluginAdminExports } from "emdash";
import * as React from "react";

import { ActivityPanel } from "./admin-activity.js";
import {
	call,
	errorMessage,
	isForbidden,
	type Settings,
	type SettingsTab,
	type Status,
	tabFromUrl,
} from "./admin-api.js";
import { useBuildRunner, useStatusPoll } from "./admin-build.js";
import { EntryIndexPanel } from "./admin-entry-panel.js";
import { IndexImpactNote } from "./admin-impact.js";
import { PreviewSearchButton } from "./admin-preview.js";
import { ContentTab, RelevanceTab, SaveBar } from "./admin-sources.js";
import { StatusWidget } from "./admin-widget.js";
import { SetupWizard } from "./admin-wizard.js";
import type { Config } from "./config.js";

const TABS: Array<{ value: SettingsTab; label: string }> = [
	{ value: "content", label: "Search content" },
	{ value: "relevance", label: "Relevance" },
];

const BINDING_SNIPPET = `// wrangler.jsonc
{
  "compatibility_date": "2026-03-27",
  "ai_search_namespaces": [
    { "binding": "AI_SEARCH", "namespace": "my-site" }
  ]
}`;

/** The wizard's starting point: a draft to edit and, optionally, the source to open at. */
interface WizardLaunch {
	draft: Config;
	startAt?: string;
}

function SettingsPage() {
	const [status, setStatus] = React.useState<Status | null>(null);
	const [settings, setSettings] = React.useState<Settings | null>(null);
	const [draft, setDraft] = React.useState<Config | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [pending, setPending] = React.useState<"save" | "rebuild" | null>(null);
	const [wizard, setWizard] = React.useState<WizardLaunch | null>(null);
	const [tab, setTab] = React.useState<string>(() => {
		const fromUrl = tabFromUrl();
		return fromUrl === "relevance" ? fromUrl : "content";
	});
	const activityRef = React.useRef<HTMLElement>(null);

	const refreshStatus = React.useCallback(async () => {
		const next = await call<Status>("status");
		setStatus(next);
		return next;
	}, []);

	React.useEffect(() => {
		void (async () => {
			try {
				const [loadedStatus, loadedSettings] = await Promise.all([
					call<Status>("status"),
					call<Settings>("config"),
				]);
				setStatus(loadedStatus);
				setSettings(loadedSettings);
				setDraft(loadedSettings.config);
				if (loadedStatus.connected && !loadedSettings.saved) {
					setWizard({ draft: loadedSettings.config });
				}
			} catch (loadError) {
				setError(
					isForbidden(loadError)
						? "Only administrators can change AI Search settings."
						: errorMessage(loadError),
				);
			}
		})();
	}, []);

	useBuildRunner(Boolean(status?.build), refreshStatus, (runError) =>
		setError(errorMessage(runError)),
	);
	useStatusPoll(status, refreshStatus);

	const loaded = Boolean(status && settings);
	React.useEffect(() => {
		if (loaded && tabFromUrl() === "activity") activityRef.current?.scrollIntoView();
	}, [loaded]);

	if (!status || !settings || !draft) {
		return error ? <Banner variant="error" description={error} /> : <Loader />;
	}

	const run = async (action: NonNullable<typeof pending>, task: () => Promise<void>) => {
		setPending(action);
		setError(null);
		try {
			await task();
		} catch (actionError) {
			setError(errorMessage(actionError));
		} finally {
			setPending(null);
		}
	};
	const saveConfig = async (next: Config) => {
		const config = await call<Config>("config/save", next);
		setSettings({ ...settings, config, saved: true });
		setDraft(config);
		await refreshStatus();
	};
	const rebuild = () =>
		run("rebuild", async () => {
			await call("index/rebuild", {});
			await refreshStatus();
		});
	const labels = new Map(settings.sources.map((source) => [source.id, source.label]));
	const saveBar = (
		<SaveBar
			settings={settings}
			draft={draft}
			saving={pending === "save"}
			impact={
				<IndexImpactNote
					saved={settings.config}
					draft={draft}
					labels={labels}
					counts={status.counts}
				/>
			}
			onSave={() => void run("save", () => saveConfig(draft))}
		/>
	);

	let body: React.ReactNode;
	if (wizard) {
		body = (
			<SetupWizard
				settings={settings}
				status={status}
				initialDraft={wizard.draft}
				startAt={wizard.startAt}
				onSave={saveConfig}
				onClose={() => setWizard(null)}
			/>
		);
	} else if (!status.connected) {
		body = (
			<section className="space-y-4">
				<Banner
					variant="alert"
					title="AI Search is not connected"
					description="The plugin runs only on Cloudflare Workers and needs an AI Search namespace binding. Add one to your Wrangler configuration and deploy again."
				/>
				<Code lang="jsonc" code={BINDING_SNIPPET} />
			</section>
		);
	} else if (!settings.saved) {
		body = (
			<section className="flex flex-wrap items-center gap-4 rounded-xl border border-kumo-line bg-kumo-base p-4">
				<div className="min-w-0 flex-1">
					<h2 className="font-semibold">Set up AI Search</h2>
					<p className="text-sm text-kumo-subtle">
						Choose what visitors can find and check where each result links to.
					</p>
				</div>
				<Button variant="primary" onClick={() => setWizard({ draft: settings.config })}>
					Start setup
				</Button>
			</section>
		);
	} else {
		body = (
			<div className="flex flex-col gap-6 xl:flex-row">
				<div className="min-w-0 max-w-3xl flex-1 space-y-5">
					<Tabs variant="underline" tabs={TABS} value={tab} onValueChange={setTab} />
					{tab === "content" && (
						<ContentTab
							settings={settings}
							draft={draft}
							onChange={setDraft}
							counts={status.counts}
							building={status.build?.sources ?? []}
							onConfigure={(next, startAt) => setWizard({ draft: next, startAt })}
						/>
					)}
					{tab === "relevance" && (
						<RelevanceTab settings={settings} draft={draft} onChange={setDraft} />
					)}
					{saveBar}
				</div>
				<aside ref={activityRef} className="min-w-0 shrink-0 space-y-4 xl:w-[380px]">
					<div className="flex flex-wrap gap-2">
						<PreviewSearchButton onError={(openError) => setError(errorMessage(openError))} />
						<Button
							variant="outline"
							size="sm"
							icon={<PencilSimple />}
							onClick={() => setWizard({ draft })}
						>
							Edit setup
						</Button>
					</div>
					<ActivityPanel
						status={status}
						labels={labels}
						rebuilding={pending === "rebuild"}
						onRebuild={() => void rebuild()}
						onChanged={async () => void (await refreshStatus())}
					/>
				</aside>
			</div>
		);
	}

	const twoColumn = status.connected && settings.saved && !wizard;
	return (
		<div className={twoColumn ? "space-y-5" : "max-w-3xl space-y-5"}>
			<header className="min-w-0">
				<h1 className="text-2xl font-semibold">AI Search</h1>
				<p className="text-sm text-kumo-subtle">
					Help visitors find the content, people, and pages on your site.
				</p>
			</header>
			{error && <Banner variant="error" description={error} />}
			{body}
		</div>
	);
}

export const pages: PluginAdminExports["pages"] = { "/settings": SettingsPage };

export const widgets: PluginAdminExports["widgets"] = { status: StatusWidget };

/** Editor role: the status route requires `plugins:read`. */
const EDITOR_ROLE = 40;

export const contentEditorPanels = [
	{ id: "index-status", title: "AI Search", component: EntryIndexPanel, minRole: EDITOR_ROLE },
];
