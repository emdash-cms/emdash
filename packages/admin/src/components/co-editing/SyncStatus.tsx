import { Button, Popover } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Check, CloudWarning, Copy } from "@phosphor-icons/react";
import * as React from "react";

import type { KeptReason } from "../../lib/co-editing/session.js";
import { cn } from "../../lib/utils";

/** A room state the save button shows in place of Save, and explains when selected. */
export type SyncProblem =
	| { readonly kind: "joining"; readonly waiting: boolean }
	| {
			readonly kind: "offline";
			/** The browser still has a network connection, so the server can't be reached. */
			readonly unreachable?: boolean;
	  }
	| { readonly kind: "not-saved"; readonly reason: KeptReason; readonly reload: () => void }
	| {
			/** Edits from before joining that a recovery revision couldn't keep. */
			readonly kind: "not-kept";
			/** Why the recovery revision failed. */
			readonly error: string;
			/** The edits as plain text. */
			readonly copy: () => string;
			readonly retry: () => void;
			readonly retrying: boolean;
	  };

const COPIED_MS = 1600;

export interface SyncStatusProps {
	/** Null while the room has nothing to explain. */
	problem: SyncProblem | null;
	/** The editor takes no edits, so Offline doesn't ask to keep typing. */
	readOnly?: boolean;
	/** The edits as plain text, for **Copy my edits**. */
	onCopyEdits?: () => string;
	/** The save button, which opens the explanation while there's a problem. */
	children: React.ReactElement<React.ComponentPropsWithRef<"button">>;
}

/**
 * Explains the save button's co-editing state in a popover, and opens by itself once edits can't be
 * saved. The button stays mounted through every state, so its live region announces each change.
 */
export function SyncStatus({ problem, readOnly = false, onCopyEdits, children }: SyncStatusProps) {
	const { t } = useLingui();
	const anchorRef = React.useRef<HTMLButtonElement>(null);
	const popupRef = React.useRef<HTMLDivElement>(null);
	const kind = problem?.kind ?? null;
	// Opened by itself, it leaves focus in the field the user may be typing in.
	const opensItself = kind === "not-saved" || kind === "not-kept";
	const [open, setOpen] = React.useState<false | "selected" | "auto">(opensItself ? "auto" : false);
	const [shownKind, setShownKind] = React.useState(kind);
	if (shownKind !== kind) {
		setShownKind(kind);
		setOpen(opensItself ? "auto" : false);
	}

	const button = React.cloneElement(
		children,
		problem
			? {
					ref: anchorRef,
					"aria-haspopup": "dialog",
					"aria-expanded": open !== false,
					onClick: () => {
						if (open === "selected") {
							setOpen(false);
							return;
						}
						// An open that came by itself left focus behind, so selecting moves it in.
						if (open === "auto") popupRef.current?.querySelector<HTMLElement>("button")?.focus();
						setOpen("selected");
					},
				}
			: { ref: anchorRef },
	);
	return (
		<>
			{button}
			{problem && (
				<Popover
					open={open !== false}
					onOpenChange={(next, details) => {
						if (next) return;
						// The button toggles the popover itself, so pressing it, or focus moving to it,
						// doesn't close the popover first.
						if (details.reason === "outside-press" || details.reason === "focus-out") {
							const event = details.event;
							const to = event instanceof FocusEvent ? event.relatedTarget : event.target;
							if (to instanceof Node && anchorRef.current?.contains(to)) return;
						}
						setOpen(false);
					}}
				>
					<Popover.Portal>
						<Popover.Positioner anchor={anchorRef} align="end">
							<Popover.Popup
								initialFocus={open === "auto" ? false : undefined}
								className="w-80 max-w-[calc(100vw-2rem)]"
							>
								<Popover.Arrow />
								<div ref={popupRef} className="contents">
									<SyncExplanation problem={problem} readOnly={readOnly} />
									{problem.kind === "not-saved" && (
										<NotSavedActions onCopyEdits={onCopyEdits}>
											<Button type="button" size="sm" variant="primary" onClick={problem.reload}>
												{t`Reload`}
											</Button>
										</NotSavedActions>
									)}
									{problem.kind === "not-kept" && (
										<NotSavedActions onCopyEdits={problem.copy}>
											<Button
												type="button"
												size="sm"
												variant="primary"
												loading={problem.retrying}
												onClick={problem.retry}
											>
												{t`Try again`}
											</Button>
										</NotSavedActions>
									)}
								</div>
							</Popover.Popup>
						</Popover.Positioner>
					</Popover.Portal>
				</Popover>
			)}
		</>
	);
}

/** The popover's title and body for a problem. */
function SyncExplanation({ problem, readOnly }: { problem: SyncProblem; readOnly: boolean }) {
	const { t } = useLingui();
	let title: string;
	let body: string;
	switch (problem.kind) {
		case "joining":
			title = problem.waiting ? t`Waiting to join` : t`Joining this entry`;
			body = problem.waiting
				? t`EmDash couldn’t join this entry yet and keeps trying every few seconds.`
				: t`Connecting to the live version of this entry.`;
			break;
		case "offline":
			if (problem.unreachable) {
				title = t`Can’t reach EmDash`;
				body = readOnly
					? t`Other people’s edits show here again once EmDash can be reached.`
					: t`Keep typing. Your edits stay in this tab and save once EmDash can be reached again, so keep the tab open. Until then, you can’t publish or preview.`;
				break;
			}
			title = t`You’re offline`;
			body = readOnly
				? t`Other people’s edits show here again once you’re back online.`
				: t`Keep typing. Your edits stay in this tab and save when you’re back online, so keep the tab open. Until then, you can’t publish or preview.`;
			break;
		case "not-saved":
			title = t`Your last edits weren’t saved`;
			body =
				problem.reason === "access"
					? t`You no longer have edit access to this entry. Your edits are still on this page.`
					: problem.reason === "deleted"
						? t`This entry was moved to Trash or deleted. Your edits are still on this page.`
						: t`EmDash couldn’t merge them or keep them as a recovery revision. Your edits are still on this page.`;
			break;
		case "not-kept":
			title = t`Your earlier edits weren’t kept`;
			body = t`EmDash couldn’t keep the edits you made before joining as a recovery revision. Copy them, or try again.`;
			break;
	}

	return (
		<>
			<Popover.Title className="flex items-center gap-2">
				{(problem.kind === "not-saved" || problem.kind === "not-kept") && (
					<CloudWarning aria-hidden="true" className="size-4 shrink-0 text-kumo-warning" />
				)}
				{title}
			</Popover.Title>
			<Popover.Description>{body}</Popover.Description>
			{problem.kind === "not-kept" && (
				<p role="alert" className="mt-2 text-sm text-kumo-subtle">
					{problem.error}
				</p>
			)}
		</>
	);
}

function NotSavedActions({
	onCopyEdits,
	children,
}: {
	onCopyEdits?: () => string;
	/** The action that ends the problem, after **Copy my edits**. */
	children: React.ReactNode;
}) {
	const { t } = useLingui();
	const [copy, setCopy] = React.useState<"idle" | "copied" | "failed">("idle");
	const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	React.useEffect(() => () => clearTimeout(timer.current), []);
	const copyEdits = async (read: () => string) => {
		clearTimeout(timer.current);
		try {
			await navigator.clipboard.writeText(read());
		} catch {
			setCopy("failed");
			return;
		}
		setCopy("copied");
		timer.current = setTimeout(setCopy, COPIED_MS, "idle");
	};
	const copied = copy === "copied";

	return (
		<>
			{copy === "failed" && (
				<p role="alert" className="mt-2 text-sm text-kumo-danger">
					{t`Couldn’t copy. Select the text on the page and copy it instead.`}
				</p>
			)}
			<div className="mt-3 flex flex-wrap gap-2">
				{onCopyEdits && (
					<Button
						type="button"
						size="sm"
						variant="secondary"
						icon={copied ? <Check /> : <Copy />}
						onClick={() => void copyEdits(onCopyEdits)}
					>
						{/* Both labels take the same space, so Reload stays put. */}
						<span className="inline-grid">
							<span className={cn("[grid-area:1/1]", copied && "invisible")}>
								{t`Copy my edits`}
							</span>
							<span className={cn("[grid-area:1/1]", !copied && "invisible")}>{t`Copied`}</span>
						</span>
					</Button>
				)}
				{children}
			</div>
		</>
	);
}
