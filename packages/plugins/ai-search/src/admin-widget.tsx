import { LinkButton, Loader } from "@cloudflare/kumo";
import * as React from "react";

import {
	call,
	errorMessage,
	isForbidden,
	relativeTime,
	SETTINGS_URL,
	settingsUrl,
	type Status,
} from "./admin-api.js";

/** Dashboard card: a setup prompt until the plugin is configured, then its status. */
export function StatusWidget() {
	const [status, setStatus] = React.useState<Status | null>(null);
	const [error, setError] = React.useState<string | null>(null);

	React.useEffect(() => {
		void call<Status>("status").then(setStatus, (loadError) =>
			setError(
				isForbidden(loadError)
					? "Editors and administrators can see the search index status here."
					: errorMessage(loadError),
			),
		);
	}, []);

	if (error) return <p className="text-sm text-kumo-subtle">{error}</p>;
	if (!status) return <Loader />;

	if (!status.connected) {
		return (
			<WidgetBody
				title="AI Search is not connected"
				description="Add an AI Search namespace binding to your Wrangler configuration and deploy again."
				action={<SettingsLink label="See how" />}
			/>
		);
	}
	if (!status.configured) {
		return (
			<WidgetBody
				title="Finish setting up AI Search"
				description="Nothing is indexed yet. Choose what visitors can find."
				action={<SettingsLink label="Start setup" primary />}
			/>
		);
	}
	if (status.build) {
		return (
			<WidgetBody
				badge={<Loader size="sm" />}
				title="Building the search index"
				description={`${status.build.processed.toLocaleString()} ${
					status.build.processed === 1 ? "record" : "records"
				} checked so far.`}
				action={<SettingsLink label="View progress" />}
			/>
		);
	}

	const synced = relativeTime(status.lastActivity ?? undefined);
	const { indexed, failed: attention } = status.totals;
	return (
		<WidgetBody
			title={`${indexed.toLocaleString()} ${indexed === 1 ? "item" : "items"} indexed`}
			description={[
				synced ? `Last synced ${synced}` : null,
				attention > 0 ? `${attention.toLocaleString()} need attention` : null,
			]
				.filter(Boolean)
				.join(" · ")}
			action={
				<div className="flex flex-wrap gap-2">
					{attention > 0 && (
						<LinkButton variant="outline" size="sm" href={settingsUrl("activity")}>
							Review issues
						</LinkButton>
					)}
					<SettingsLink label="Open settings" />
				</div>
			}
		/>
	);
}

function WidgetBody(props: {
	badge?: React.ReactNode;
	title: string;
	description: string;
	action: React.ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-center gap-3">
			{props.badge}
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium">{props.title}</p>
				{props.description && <p className="text-sm text-kumo-subtle">{props.description}</p>}
			</div>
			{props.action}
		</div>
	);
}

function SettingsLink(props: { label: string; primary?: boolean }) {
	return (
		<LinkButton variant={props.primary ? "primary" : "outline"} size="sm" href={SETTINGS_URL}>
			{props.label}
		</LinkButton>
	);
}
