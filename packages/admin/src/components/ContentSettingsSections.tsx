import * as React from "react";

import { resolveEditor, type EditorSectionId, type ListLayout } from "../lib/admin-layout.js";

export interface ContentSettingsSectionProps {
	id: EditorSectionId;
	children: React.ReactNode;
}

/** Bylines positions its Add button against it. */
export function ContentSettingsSection({ id, children }: ContentSettingsSectionProps) {
	return (
		<section className="relative border-t first:border-t-0 bg-kumo-base" data-settings-section={id}>
			{children}
		</section>
	);
}

/**
 * Renders the `ContentSettingsSection` children in the user's order, without
 * the ones they hid. Children only decide which sections this entry has; the
 * default order comes from `admin-layout.ts`, not from their JSX order.
 */
export function ContentSettingsSections({
	layout,
	children,
}: {
	layout: ListLayout;
	children: React.ReactNode;
}) {
	const sections = React.Children.toArray(children)
		.filter((child): child is React.ReactElement<ContentSettingsSectionProps> =>
			React.isValidElement<ContentSettingsSectionProps>(child),
		)
		.map((element) => ({ id: element.props.id, element }));

	return (
		<>
			{resolveEditor(sections, layout).map(({ id, element }) =>
				React.cloneElement(element, { key: id }),
			)}
		</>
	);
}
