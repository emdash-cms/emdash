/**
 * The content editor's Sidebar.Provider gets no `onOpenChange`, so Kumo's `setOpen` and
 * `toggleSidebar` do nothing on desktop. Show or hide the desktop panel through this hook.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { cn } from "../lib/utils.js";

type Side = "left" | "right";
type PanelChoice = "shown" | "hidden";

const SETTINGS_PANEL_STORAGE_KEY = "emdash-editor-settings-panel";

function readSettingsPanelChoice(): PanelChoice {
	if (typeof window === "undefined") return "shown";
	try {
		return window.localStorage.getItem(SETTINGS_PANEL_STORAGE_KEY) === "hidden"
			? "hidden"
			: "shown";
	} catch {
		return "shown";
	}
}

function writeSettingsPanelChoice(choice: PanelChoice): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(SETTINGS_PANEL_STORAGE_KEY, choice);
	} catch {}
}

type ConstraintControl = Element & {
	readonly willValidate: boolean;
	readonly validity: ValidityState;
	reportValidity(): boolean;
};

function isConstraintControl(element: Element): element is ConstraintControl {
	return "willValidate" in element && "validity" in element && "reportValidity" in element;
}

/** The control the browser reports first on submit. Reads `validity` only, so it fires no `invalid` event. */
function firstInvalidControl(form: HTMLFormElement): ConstraintControl | null {
	for (const element of form.elements) {
		if (isConstraintControl(element) && element.willValidate && !element.validity.valid) {
			return element;
		}
	}
	return null;
}

// Kumo's content container is border-box with a 1px border on its canvas side, so its children
// get --sidebar-width minus 1px. Pinned, they slide with the panel edge instead of re-wrapping
// on every frame of the width transition.
const PINNED_CONTENT = "*:w-[calc(var(--sidebar-width)-1px)]";

export interface SettingsPanelOptions {
	panelId: string;
	/** Kumo's physical side, so "left" in RTL. */
	side: Side;
	isBelowLg: boolean;
	/** The open image or gallery detail panel, which shows a hidden panel while it lasts. */
	blockPanel: object | null;
	closeBlockPanel: () => void;
}

export interface SettingsPanelToggleProps {
	open: boolean;
	/** Kumo's physical side, so "left" in RTL. */
	side: Side;
	onClick: () => void;
	/** The panel's id. */
	controls: string;
	buttonRef?: React.Ref<HTMLButtonElement>;
	disabled?: boolean;
	className?: string;
}

export interface SettingsPanel {
	/** Undefined below lg, so the phone sheet stays Kumo's own. */
	providerOpen: boolean | undefined;
	/** Opens the desktop panel without changing the stored visibility choice. */
	reveal: () => void;
	/** Stable. Replays a validation report deferred by `onInvalidCapture` once the panel has opened. */
	onOpenChangeComplete: (open: boolean) => void;
	asideProps: {
		ref: (node: HTMLElement | null) => void;
		contentClassName: string | undefined;
	};
	asideClassName: string | undefined;
	listVisible: boolean;
	/** Compose into the form's `onInvalidCapture`. Reveals the panel when the first invalid control is hidden in it. */
	onInvalidCapture: (event: React.FormEvent<HTMLFormElement>) => void;
	/** Desktop only. Below lg, the editor drives the button from Kumo's phone sheet. */
	toggle: SettingsPanelToggleProps | null;
}

export function useSettingsPanel({
	panelId,
	side,
	isBelowLg,
	blockPanel,
	closeBlockPanel,
}: SettingsPanelOptions): SettingsPanel {
	const [choice, setChoice] = React.useState(readSettingsPanelChoice);
	const toggleRef = React.useRef<HTMLButtonElement>(null);
	const pendingInvalidRef = React.useRef<ConstraintControl | null>(null);
	const deferringRef = React.useRef(false);

	const desktop = !isBelowLg;
	const open = choice === "shown" || blockPanel !== null;

	// A deferred report waits for a desktop open that a breakpoint change means never comes.
	React.useEffect(() => {
		if (isBelowLg) pendingInvalidRef.current = null;
	}, [isBelowLg]);

	const onClick = () => {
		if (open) {
			// Safari doesn't focus a clicked button. Move focus out before the panel goes inert,
			// or the browser drops it on the body.
			if (document.getElementById(panelId)?.contains(document.activeElement)) {
				toggleRef.current?.focus();
			}
			pendingInvalidRef.current = null;
			// A block panel left open behind an inert panel would still answer Escape and mod+s.
			if (blockPanel) closeBlockPanel();
			writeSettingsPanelChoice("hidden");
			setChoice("hidden");
		} else {
			writeSettingsPanelChoice("shown");
			setChoice("shown");
		}
	};

	const onInvalidCapture = (event: React.FormEvent<HTMLFormElement>) => {
		if (deferringRef.current) {
			event.preventDefault();
			return;
		}
		if (!desktop || open) return;
		const first = firstInvalidControl(event.currentTarget);
		if (first !== event.target) return;
		if (!first || !document.getElementById(panelId)?.contains(first)) return;
		// The browser can't focus a control in the inert, collapsed panel or anchor its message
		// there. Report it once the panel has finished opening instead.
		event.preventDefault();
		deferringRef.current = true;
		// Every `invalid` event of one submit is dispatched in the same task.
		setTimeout(() => {
			deferringRef.current = false;
		}, 0);
		pendingInvalidRef.current = first;
		setChoice("shown");
	};

	const onOpenChangeComplete = React.useCallback((nextOpen: boolean) => {
		const control = pendingInvalidRef.current;
		pendingInvalidRef.current = null;
		if (!nextOpen || !control) return;
		// Under reduced motion this runs inside the submit, while its `invalid` events are still
		// being cancelled. A later task reports after that window has closed.
		setTimeout(() => {
			if (control.isConnected) control.reportValidity();
		}, 0);
	}, []);

	// Kumo leaves a collapsed desktop rail focusable and in the accessibility tree. Set the
	// attribute directly, as Kumo does for its phone sheet: React 18 drops `inert={true}`.
	// Below lg the ref reaches Kumo's sheet, whose `inert` stays Kumo's to manage.
	const panelRef = React.useCallback(
		(node: HTMLElement | null) => {
			if (desktop) node?.toggleAttribute("inert", !open);
		},
		[desktop, open],
	);

	const reveal = React.useCallback(() => setChoice("shown"), []);
	const collapsed = desktop && !open;

	return {
		providerOpen: desktop ? open : undefined,
		reveal,
		onOpenChangeComplete,
		asideProps: {
			ref: panelRef,
			contentClassName: desktop ? PINNED_CONTENT : undefined,
		},
		// Kumo's collapsed content container keeps its 1px border at width 0. Clip it.
		asideClassName: collapsed ? "overflow-hidden" : undefined,
		listVisible: desktop && open,
		onInvalidCapture,
		toggle: desktop ? { open, side, onClick, controls: panelId, buttonRef: toggleRef } : null,
	};
}

/** Shows or hides the editor's settings panel. Its label names what a click does. */
export function SettingsPanelToggle({
	open,
	side,
	onClick,
	controls,
	buttonRef,
	disabled,
	className,
}: SettingsPanelToggleProps) {
	const { t } = useLingui();
	const label = open ? t`Hide settings` : t`Show settings`;
	return (
		<Button
			ref={buttonRef}
			variant="ghost"
			shape="square"
			size="sm"
			type="button"
			disabled={disabled}
			className={className}
			onClick={onClick}
			aria-controls={controls}
			aria-label={label}
			title={label}
		>
			<PanelToggleIcon open={open} side={side} />
		</Button>
	);
}

/**
 * The animated icon of Kumo's `Sidebar.Trigger`, which Kumo doesn't export on its own: the divider
 * slides as the panel opens and closes. Kumo draws it for a left-hand panel.
 */
function PanelToggleIcon({ open, side }: { open: boolean; side: Side }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden="true"
			focusable="false"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			className={cn("size-4 shrink-0", side === "right" && "-scale-x-100")}
		>
			<path d="M21.25 6.72v10.56a2.97 2.97 0 0 1-2.97 2.97H5.72a2.97 2.97 0 0 1-2.97-2.97V6.72a2.97 2.97 0 0 1 2.97-2.97h12.56a2.97 2.97 0 0 1 2.97 2.97" />
			<path
				d="M6.25 7.25v9.5"
				className={cn(
					"transition-transform duration-(--sidebar-animation-duration) ease-(--sidebar-easing) motion-reduce:transition-none",
					open ? "translate-x-px" : "translate-x-[10.5px]",
				)}
			/>
		</svg>
	);
}
