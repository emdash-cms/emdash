import { Button } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChatCircleText } from "@phosphor-icons/react";

import type { EditorialThread } from "../../lib/api/editorial-threads.js";

/** Open threads on each field, keyed by field name, oldest first. */
export function fieldThreadsByName(threads: EditorialThread[]): Map<string, EditorialThread[]> {
	const byName = new Map<string, EditorialThread[]>();
	for (const thread of threads) {
		if (thread.status !== "open" || thread.anchor.type !== "field") continue;
		const list = byName.get(thread.anchor.field) ?? [];
		list.push(thread);
		byName.set(thread.anchor.field, list);
	}
	return byName;
}

/**
 * Sits at the end of a field's label row. With threads it shows their count and
 * opens them, so a commented field shows it while the margin is closed; without
 * any it appears on hover or focus and starts a comment on the field.
 */
export function FieldCommentsButton({
	label,
	threads,
	activeThreadId,
	onOpen,
	onStart,
}: {
	label: string;
	threads: EditorialThread[];
	activeThreadId: string | null;
	onOpen: (threadId: string) => void;
	/** Omitted when the person can't start a comment here. */
	onStart?: () => void;
}) {
	const { t } = useLingui();
	const first = threads[0];
	if (!first) {
		if (!onStart) return null;
		return (
			<Button
				variant="ghost"
				size="xs"
				shape="square"
				type="button"
				aria-label={t`Comment on ${label}`}
				title={t`Comment on ${label}`}
				className="absolute end-0 top-0 z-10 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
				onClick={onStart}
			>
				<ChatCircleText className="h-3.5 w-3.5" aria-hidden="true" />
			</Button>
		);
	}
	const count = threads.length;
	const active = threads.some((thread) => thread.id === activeThreadId);
	const description = plural(count, {
		one: `# comment thread on ${label}`,
		other: `# comment threads on ${label}`,
	});
	return (
		<Button
			variant={active ? "secondary" : "ghost"}
			size="xs"
			type="button"
			aria-pressed={active}
			aria-label={description}
			title={t`Show comments`}
			className="absolute end-0 top-0 z-10 gap-1 px-1.5"
			onClick={() => onOpen(first.id)}
		>
			<ChatCircleText className="h-3.5 w-3.5" aria-hidden="true" />
			<span className="tabular-nums">{count}</span>
		</Button>
	);
}
