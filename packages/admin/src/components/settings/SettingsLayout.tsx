import { Link } from "@tanstack/react-router";
import * as React from "react";

import { cn } from "../../lib/utils.js";
import { CaretNext } from "../ArrowIcons.js";
import { EditorHeader } from "../EditorHeader.js";
import { BackToSettingsLink } from "./BackToSettingsLink.js";

interface SettingsFrameProps {
	title: React.ReactNode;
	description: React.ReactNode;
	actions?: React.ReactNode;
	children: React.ReactNode;
}

export function SettingsFrame({ title, description, actions, children }: SettingsFrameProps) {
	return (
		<div className="max-w-4xl pb-6">
			<EditorHeader
				leading={
					<div className="self-start">
						<BackToSettingsLink />
					</div>
				}
				actions={actions}
			>
				<div>
					<h1 className="text-2xl font-semibold leading-tight text-balance">{title}</h1>
					<p className="mt-1.5 max-w-2xl text-sm leading-5 text-pretty text-kumo-subtle">
						{description}
					</p>
				</div>
			</EditorHeader>
			<div className="mt-6">{children}</div>
		</div>
	);
}

interface SettingsSectionProps {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	contentClassName?: string;
	children: React.ReactNode;
}

export function SettingsSection({
	title,
	description,
	actions,
	contentClassName,
	children,
}: SettingsSectionProps) {
	const headingId = React.useId();

	return (
		<section aria-labelledby={headingId}>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="grid gap-1">
					<h2 id={headingId} className="text-lg font-semibold leading-6 text-balance">
						{title}
					</h2>
					{description && (
						<p className="max-w-2xl text-sm leading-5 text-pretty text-kumo-subtle">
							{description}
						</p>
					)}
				</div>
				{actions && <div className="flex shrink-0 justify-end sm:pt-0.5">{actions}</div>}
			</div>
			<div
				className={cn(
					"mt-3 divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line bg-kumo-base",
					contentClassName,
				)}
			>
				{children}
			</div>
		</section>
	);
}

interface SettingRowProps {
	children: React.ReactNode;
	className?: string;
}

export function SettingRow({ children, className }: SettingRowProps) {
	return <div className={cn("px-4 py-4", className)}>{children}</div>;
}

interface SettingsNavRowProps {
	to: string;
	icon: React.ReactNode;
	title: React.ReactNode;
	description: React.ReactNode;
}

export function SettingsNavRow({ to, icon, title, description }: SettingsNavRowProps) {
	return (
		<Link
			to={to}
			className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-kumo-tint focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-brand"
		>
			<span
				className="flex h-5 w-5 shrink-0 items-center justify-center text-kumo-subtle"
				aria-hidden="true"
			>
				{icon}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-base font-medium leading-5">{title}</span>
				<span className="mt-0.5 block text-sm leading-5 text-pretty text-kumo-subtle">
					{description}
				</span>
			</span>
			<CaretNext
				className="h-5 w-5 shrink-0 text-kumo-subtle rtl:-scale-x-100"
				aria-hidden="true"
			/>
		</Link>
	);
}
