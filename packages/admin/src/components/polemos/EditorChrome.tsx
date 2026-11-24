import { Button, LayerDialog } from "@cloudflare/kumo";
import * as React from "react";

import { apiFetch } from "../../lib/api/client.js";
import {
	applyPolemosContentLang,
	readPolemosContentLang,
	type PolemosContentLang,
} from "../../lib/polemos-content-lang.js";

const LANGS: Array<{ id: PolemosContentLang; label: string }> = [
	{ id: "he", label: "עברית" },
	{ id: "ar", label: "ערבית" },
	{ id: "both", label: "שתיהן" },
];

/** Header switch: Hebrew fields, Arabic fields, or both. Not the admin language. */
export function PolemosLangSwitch() {
	const [view, setView] = React.useState<PolemosContentLang>(() =>
		typeof document === "undefined" ? "both" : readPolemosContentLang(),
	);

	React.useLayoutEffect(() => {
		applyPolemosContentLang(view);
	}, [view]);

	return (
		<div
			role="group"
			aria-label="שפת התוכן, לא שפת הממשק"
			data-polemos-lang-switch=""
			className="flex shrink-0 items-center rounded-md border border-kumo-line p-0.5"
		>
			{LANGS.map((option) => (
				<button
					key={option.id}
					type="button"
					aria-pressed={view === option.id}
					className={
						view === option.id
							? "rounded-sm bg-kumo-tint px-2 py-1 text-xs font-medium"
							: "rounded-sm px-2 py-1 text-xs text-kumo-subtle"
					}
					onClick={() => setView(option.id)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

/** Stays in the editor bar after a save, while typing, and while a save is in flight. */
export function PolemosSaveStatus({
	isNew,
	dirty,
	saving,
}: {
	isNew: boolean;
	dirty: boolean;
	saving: boolean;
}) {
	const text = saving ? "שומר…" : dirty ? "יש שינויים" : isNew ? "טיוטה חדשה" : "נשמר";
	return (
		<span
			role="status"
			aria-live="polite"
			data-polemos-save=""
			className="shrink-0 text-xs whitespace-nowrap text-kumo-subtle"
		>
			{text}
		</span>
	);
}

interface ChecklistResult {
	blockers: string[];
	warnings: string[];
}

function asStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Runs the desk checklist before publish. Required gaps block. Warnings ask
 * for confirmation. A failed checklist request still publishes.
 */
export function usePolemosPublish(collection: string, id: string | undefined, publish: () => void) {
	const publishRef = React.useRef(publish);
	publishRef.current = publish;
	const [checking, setChecking] = React.useState(false);
	const [result, setResult] = React.useState<ChecklistResult | null>(null);

	const request = React.useCallback(async () => {
		if (!id) {
			publishRef.current();
			return;
		}
		setChecking(true);
		try {
			const response = await apiFetch("/_emdash/api/plugins/polemos-desk/checklist", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ collection, id }),
			});
			if (!response.ok) {
				publishRef.current();
				return;
			}
			const body: unknown = await response.json().catch(() => ({}));
			const data =
				body && typeof body === "object" && "data" in body && body.data && typeof body.data === "object"
					? body.data
					: body;
			const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
			const blockers = asStrings(record.blockers);
			const warnings = asStrings(record.warnings);
			if (blockers.length || warnings.length) {
				setResult({ blockers, warnings });
				return;
			}
			publishRef.current();
		} catch {
			publishRef.current();
		} finally {
			setChecking(false);
		}
	}, [collection, id]);

	const dialog = result ? (
		<LayerDialog.Root
			open
			onOpenChange={(open) => {
				if (!open) setResult(null);
			}}
		>
			<LayerDialog.Content size="sm">
				<LayerDialog.Title>
					{result.blockers.length ? "אי אפשר לפרסם" : "לפרסם בכל זאת?"}
				</LayerDialog.Title>
				<LayerDialog.Body>
					<ul className="grid gap-2 text-sm" data-polemos-checklist="">
						{result.blockers.map((text) => (
							<li key={`b:${text}`}>{text}</li>
						))}
						{result.warnings.map((text) => (
							<li key={`w:${text}`}>{text}</li>
						))}
					</ul>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel="סגירה">
					{result.blockers.length === 0 ? (
						<LayerDialog.Action
							onClick={() => {
								setResult(null);
								publishRef.current();
							}}
						>
							פרסום
						</LayerDialog.Action>
					) : null}
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	) : null;

	return { request, checking, dialog };
}

/** Opens the one newsletter draft for this issue. */
export function PolemosIssueNewsletter({ id }: { id: string }) {
	const [busy, setBusy] = React.useState(false);
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			loading={busy}
			data-polemos-newsletter=""
			onClick={() => {
				setBusy(true);
				void (async () => {
					try {
						const response = await apiFetch("/_emdash/api/plugins/polemos-mailings/issue-open", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ id }),
						});
						if (!response.ok) return;
						const body: unknown = await response.json().catch(() => ({}));
						const data =
							body && typeof body === "object" && "data" in body && body.data
								? body.data
								: body;
						const path =
							data && typeof data === "object" && "path" in data && typeof data.path === "string"
								? data.path
								: "";
						if (path) window.location.assign(path);
					} finally {
						setBusy(false);
					}
				})();
			}}
		>
			ניוזלטר לגיליון
		</Button>
	);
}
