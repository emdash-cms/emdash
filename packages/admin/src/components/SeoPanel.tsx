/**
 * SEO Panel for Content Editor Sidebar
 *
 * Shows SEO metadata fields (title, description, OG image, canonical URL,
 * noIndex) when the collection has `hasSeo` enabled. Changes are sent
 * alongside content updates via the `seo` field on the update body.
 */

import { Input, InputArea, Label, Switch } from "@cloudflare/kumo";
import * as React from "react";

import type { ContentSeo, ContentSeoInput } from "../lib/api";

export interface SeoPanelProps {
	seo?: ContentSeo;
	onChange: (seo: ContentSeoInput) => void;
}

/**
 * Compact SEO metadata editor for the content sidebar.
 */
export function SeoPanel({ seo, onChange }: SeoPanelProps) {
	const [title, setTitle] = React.useState(seo?.title ?? "");
	const [description, setDescription] = React.useState(seo?.description ?? "");
	const [canonical, setCanonical] = React.useState(seo?.canonical ?? "");
	const [noIndex, setNoIndex] = React.useState(seo?.noIndex ?? false);

	// Keep local state in sync when the prop changes (e.g. after save)
	React.useEffect(() => {
		setTitle(seo?.title ?? "");
		setDescription(seo?.description ?? "");
		setCanonical(seo?.canonical ?? "");
		setNoIndex(seo?.noIndex ?? false);
	}, [seo]);

	const emitChange = (patch: Partial<ContentSeoInput>) => {
		onChange({
			title: title || null,
			description: description || null,
			canonical: canonical || null,
			noIndex,
			...patch,
		});
	};

	return (
		<div className="space-y-3">
			<Input
				label="SEO Title"
				description="Overrides the page title in search engine results"
				value={title}
				onChange={(e) => {
					setTitle(e.target.value);
					emitChange({ title: e.target.value || null });
				}}
			/>

			<div>
				<InputArea
					label="Meta Description"
					description={
						description
							? `${description.length}/160 characters`
							: "Brief summary shown below the title in search results"
					}
					value={description}
					onChange={(e) => {
						setDescription(e.target.value);
						emitChange({ description: e.target.value || null });
					}}
					rows={3}
				/>
			</div>

			<Input
				label="Canonical URL"
				description="Points search engines to the original version of this page, if it's duplicated from another URL"
				value={canonical}
				onChange={(e) => {
					setCanonical(e.target.value);
					emitChange({ canonical: e.target.value || null });
				}}
			/>

			<div className="flex items-center justify-between pt-1">
				<div>
					<Label>Hide from search engines</Label>
					<p className="text-xs text-kumo-subtle">Add noindex meta tag</p>
				</div>
				<Switch
					checked={noIndex}
					onCheckedChange={(checked) => {
						setNoIndex(checked);
						emitChange({ noIndex: checked });
					}}
				/>
			</div>
		</div>
	);
}
