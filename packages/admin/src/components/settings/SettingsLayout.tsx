import { Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";
import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/utils.js";
import { CaretNext } from "../ArrowIcons.js";
import { DialogError } from "../DialogError.js";
import { EditorHeader } from "../EditorHeader.js";

export interface SettingsFrameProps {
	/** Page title, usually a localized string. */
	title: React.ReactNode;
	/** Optional explanatory copy shown below the title. */
	description?: React.ReactNode;
	/** Back link or close action rendered before the title. */
	leading?: React.ReactNode;
	/** Primary actions rendered beside the title. */
	actions?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
}

export function SettingsFrame({
	title,
	description,
	leading,
	actions,
	children,
	className,
}: SettingsFrameProps) {
	return (
		<div className={cn("mx-auto max-w-3xl space-y-8", className)}>
			<EditorHeader leading={leading} actions={actions}>
				<div className="space-y-1">
					<h1 className="truncate text-2xl font-semibold leading-tight">{title}</h1>
					{description && <p className="max-w-prose text-sm leading-5 text-kumo-subtle">{description}</p>}
				</div>
			</EditorHeader>
			{children}
		</div>
	);
}

export interface SettingsSectionProps {
	title: React.ReactNode;
	description?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
}

export function SettingsSection({ title, description, children, className }: SettingsSectionProps) {
	return (
		<section className={cn("rounded-lg border bg-kumo-base p-6", className)}>
			<div className="space-y-1">
				<h2 className="text-lg font-semibold leading-tight">{title}</h2>
				{description && <p className="max-w-prose text-sm leading-5 text-kumo-subtle">{description}</p>}
			</div>
			<div className="mt-5 space-y-4">{children}</div>
		</section>
	);
}

export interface SettingRowProps {
	label: React.ReactNode;
	description?: React.ReactNode;
	control: React.ReactNode;
	className?: string;
}

export function SettingRow({ label, description, control, className }: SettingRowProps) {
	return (
		<div className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
			<div className="min-w-0 flex-1">
				<p className="font-medium">{label}</p>
				{description && <p className="mt-1 text-sm leading-5 text-kumo-subtle">{description}</p>}
			</div>
			<div className="w-full shrink-0 sm:w-auto">{control}</div>
		</div>
	);
}

export interface SettingsNavRowProps {
	to: string;
	title: React.ReactNode;
	description: React.ReactNode;
	icon: React.ReactNode;
	className?: string;
}

export function SettingsNavRow({ to, title, description, icon, className }: SettingsNavRowProps) {
	return (
		<Link
			to={to}
			className={cn(
				"group flex min-w-0 items-center justify-between gap-4 rounded-lg border bg-kumo-base p-4",
				"transition-colors hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-accent",
				className,
			)}
		>
			<span className="flex min-w-0 items-center gap-3">
				<span className="shrink-0 text-kumo-subtle" aria-hidden="true">
					{icon}
				</span>
				<span className="min-w-0">
					<span className="block font-medium">{title}</span>
					<span className="mt-1 block text-sm leading-5 text-kumo-subtle">{description}</span>
				</span>
			</span>
			<CaretNext className="h-5 w-5 shrink-0 text-kumo-subtle transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
		</Link>
	);
}

export function SettingsLoadingState({ label }: { label?: React.ReactNode }) {
	const { t } = useLingui();
	return (
		<div className="flex min-h-32 items-center justify-center rounded-lg border bg-kumo-base p-6" role="status">
			<div className="flex items-center gap-3 text-sm text-kumo-subtle">
				<Loader size="sm" />
				<span>{label ?? t`Loading settings...`}</span>
			</div>
		</div>
	);
}

export function SettingsErrorState({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-4">
			<DialogError message={message} className="bg-transparent p-0 text-kumo-danger" />
		</div>
	);
}

export function SettingsEmptyState({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-lg border border-dashed p-6 text-center text-sm text-kumo-subtle">
			{children}
		</div>
	);
}
