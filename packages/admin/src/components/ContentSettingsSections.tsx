import * as React from "react";

import { resolveEditor, type EditorSectionId, type ListLayout } from "../lib/admin-layout.js";

export interface ContentSettingsSectionProps {
	id: EditorSectionId;
	children: React.ReactNode;
}

/** Bylines positions its Add button against it. */
export function ContentSettingsSection({ id, children }: ContentSettingsSectionProps) {
	return (
		<section className="relative border-t bg-kumo-base" data-settings-section={id}>
			{children}
		</section>
	);
}

type SettingsTab = "details" | "distribution" | "history";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
	{ id: "details", label: "פרטים" },
	{ id: "distribution", label: "הפצה" },
	{ id: "history", label: "היסטוריה" },
];

/** Publish and SEO are distribution. Revisions are history. Everything else is details. */
function settingsTab(id: string): SettingsTab {
	if (id === "revisions") return "history";
	if (id === "publish" || id === "seo") return "distribution";
	return "details";
}

/**
 * Renders the `ContentSettingsSection` children in the user's order, without
 * the ones they hid. Children only decide which sections this entry has; the
 * default order comes from `admin-layout.ts`, not from their JSX order.
 *
 * `grouped` turns that list into three tabs (פרטים / הפצה / היסטוריה). Inactive
 * tabs are hidden by `styles.css`, which the admin shell loads. The sections
 * stay in the document so their order is unchanged.
 */
export function ContentSettingsSections({
	layout,
	children,
	grouped = false,
}: {
	layout: ListLayout;
	children: React.ReactNode;
	grouped?: boolean;
}) {
	const [tab, setTab] = React.useState<SettingsTab>("details");
	const sections = React.Children.toArray(children)
		.filter((child): child is React.ReactElement<ContentSettingsSectionProps> =>
			React.isValidElement<ContentSettingsSectionProps>(child),
		)
		.map((element) => ({ id: element.props.id, element }));
	const ordered = resolveEditor(sections, layout);
	const panes = ordered.map(({ id, element }) => (
		<div key={id} data-settings-pane={settingsTab(id)} className="first:[&>section]:border-t-0">
			{React.cloneElement(element, { key: id })}
		</div>
	));

	if (!grouped) return <>{panes}</>;

	const hasHistory = ordered.some(({ id }) => settingsTab(id) === "history");

	return (
		<div className="polemos-settings-tabs" data-polemos-settings-tabs="" data-active={tab}>
			<div
				role="tablist"
				aria-label="הגדרות"
				className="sticky top-0 z-10 flex gap-1 border-b bg-kumo-elevated px-2"
			>
				{SETTINGS_TABS.map((item) => (
					<button
						key={item.id}
						type="button"
						role="tab"
						aria-selected={tab === item.id}
						className={
							tab === item.id
								? "border-b-2 border-kumo-brand px-3 py-2 text-sm font-medium"
								: "px-3 py-2 text-sm text-kumo-subtle"
						}
						onClick={() => setTab(item.id)}
					>
						{item.label}
					</button>
				))}
			</div>
			{panes}
			{!hasHistory ? (
				<p data-settings-pane="history" className="p-4 text-sm text-kumo-subtle">
					אין היסטוריה עדיין.
				</p>
			) : null}
		</div>
	);
}
