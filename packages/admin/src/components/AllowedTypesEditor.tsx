import { Button, Input, Label } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Plus, X } from "@phosphor-icons/react";
import * as React from "react";

import { EXTENSION_TO_MIME, VALID_MIME_RE } from "../lib/mime-utils.js";
import { cn } from "../lib/utils";

interface Preset {
	key: string;
	mimeTypes: string[];
}

const PRESETS: ReadonlyArray<Preset> = [
	{ key: "images", mimeTypes: ["image/"] },
	{ key: "pdf", mimeTypes: ["application/pdf"] },
	{
		key: "documents",
		mimeTypes: [
			"application/pdf",
			"application/msword",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"text/plain",
			"application/rtf",
		],
	},
	{
		key: "spreadsheets",
		mimeTypes: [
			"text/csv",
			"application/vnd.ms-excel",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		],
	},
	{ key: "archives", mimeTypes: ["application/zip", "application/x-tar", "application/gzip"] },
	{ key: "audio", mimeTypes: ["audio/"] },
	{ key: "video", mimeTypes: ["video/"] },
	{ key: "captions", mimeTypes: ["text/vtt", "application/x-subrip"] },
	{ key: "fonts", mimeTypes: ["font/"] },
];

function expandShorthand(entry: string): string | null {
	const trimmed = entry.trim();
	if (!trimmed) return null;
	if (trimmed.includes("/")) return VALID_MIME_RE.test(trimmed) ? trimmed : null;
	if (trimmed.startsWith(".")) return EXTENSION_TO_MIME[trimmed.toLowerCase()] ?? null;
	return null;
}

export interface AllowedTypesEditorProps {
	value: string[];
	onChange: (next: string[]) => void;
}

export function AllowedTypesEditor({ value, onChange }: AllowedTypesEditorProps) {
	const { t } = useLingui();
	const [draft, setDraft] = React.useState("");
	const [warning, setWarning] = React.useState<string | null>(null);

	const presetLabels: Record<string, string> = {
		images: t`Images`,
		pdf: t`PDF`,
		documents: t`Documents`,
		spreadsheets: t`Spreadsheets`,
		archives: t`Archives`,
		audio: t`Audio`,
		video: t`Video`,
		captions: t`Captions / Subtitles`,
		fonts: t`Fonts`,
	};

	const set = React.useMemo(() => new Set(value), [value]);

	const togglePreset = (preset: Preset) => {
		const allIncluded = preset.mimeTypes.every((m) => set.has(m));
		const next = new Set(value);
		if (allIncluded) {
			for (const m of preset.mimeTypes) next.delete(m);
		} else {
			for (const m of preset.mimeTypes) next.add(m);
		}
		onChange([...next]);
	};

	const addDraft = () => {
		const expanded = expandShorthand(draft);
		if (!expanded) {
			setWarning(t`Couldn't map "${draft}" to a MIME type. Type the MIME directly.`);
			return;
		}
		setWarning(null);
		if (!set.has(expanded)) onChange([...value, expanded]);
		setDraft("");
	};

	const removeEntry = (entry: string) => {
		onChange(value.filter((v) => v !== entry));
	};

	return (
		<div className="space-y-3">
			<Label>{t`Allowed types`}</Label>
			<p className="text-xs text-kumo-subtle">
				{value.length === 0
					? t`Any media type allowed (subject to global limits).`
					: t`Only the listed MIME types will be accepted for this field.`}
			</p>

			<div className="flex flex-wrap gap-1.5">
				{PRESETS.map((preset) => {
					const allIncluded = preset.mimeTypes.every((m) => set.has(m));
					return (
						<button
							key={preset.key}
							type="button"
							onClick={() => togglePreset(preset)}
							aria-pressed={allIncluded}
							className={cn(
								"px-3 py-1 rounded-full text-xs font-medium transition-colors",
								allIncluded
									? "bg-kumo-brand text-white"
									: "bg-kumo-tint text-kumo-subtle hover:bg-kumo-tint/80",
							)}
						>
							{presetLabels[preset.key]}
						</button>
					);
				})}
			</div>

			{value.length > 0 && (
				<ul className="flex flex-wrap gap-1.5">
					{value.map((entry) => (
						<li
							key={entry}
							className="flex items-center gap-1 bg-kumo-tint rounded px-2 py-1 text-xs"
						>
							<code>{entry}</code>
							<Button
								type="button"
								shape="square"
								variant="ghost"
								className="h-5 w-5"
								onClick={() => removeEntry(entry)}
								aria-label={t`Remove ${entry}`}
							>
								<X className="h-3 w-3" />
							</Button>
						</li>
					))}
				</ul>
			)}

			<div className="flex gap-2">
				<Input
					value={draft}
					onChange={(e) => {
						setDraft(e.target.value);
						setWarning(null);
					}}
					placeholder={t`e.g. application/zip or .pdf`}
					aria-label={t`Add MIME type or extension`}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							addDraft();
						}
					}}
				/>
				<Button type="button" icon={Plus} onClick={addDraft} disabled={!draft.trim()}>
					{t`Add`}
				</Button>
			</div>
			{warning && <p className="text-xs text-kumo-danger">{warning}</p>}
		</div>
	);
}
