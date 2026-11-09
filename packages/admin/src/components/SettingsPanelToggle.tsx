/**
 * The content editor's Sidebar.Provider gets no `onOpenChange`, so Kumo's `setOpen` and
 * `toggleSidebar` do nothing on desktop. Show or hide the desktop panel through this hook.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { SidebarSimple } from "@phosphor-icons/react";
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
	isDistractionFree: boolean;
	/** The open image or gallery detail panel, which shows a hidden panel while it lasts. */
	blockPanel: object | null;
	closeBlockPanel: () => void;
}

export interface SettingsPanelToggleModel {
	open: boolean;
	side: Side;
	controls: string;
	ref: React.RefObject<HTMLButtonElement | null>;
	onClick: () => void;
}

export interface SettingsPanel {
	/** Undefined below lg, so the phone sheet stays Kumo's own. */
	providerOpen: boolean | undefined;
	/** Stable. Replays a validation report deferred by `onInvalidCapture` once the panel has opened. */
	onOpenChangeComplete: (open: boolean) => void;
	asideProps: { inert: true | undefined; contentClassName: string | undefined };
	asideClassName: string | undefined;
	listVisible: boolean;
	/** Compose into the form's `onInvalidCapture`. Reveals the panel when the first invalid control is hidden in it. */
	onInvalidCapture: (event: React.FormEvent<HTMLFormElement>) => void;
	toggle: SettingsPanelToggleModel | null;
}

export function useSettingsPanel({
	panelId,
	side,
	isBelowLg,
	isDistractionFree,
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
		if (!desktop || isDistractionFree || open) return;
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

	const collapsed = desktop && !open;

	return {
		providerOpen: desktop ? open : undefined,
		onOpenChangeComplete,
		asideProps: {
			// Kumo leaves a collapsed desktop rail focusable and in the accessibility tree.
			inert: collapsed ? true : undefined,
			contentClassName: desktop ? PINNED_CONTENT : undefined,
		},
		// Kumo's collapsed content container keeps its 1px border at width 0. Clip it.
		asideClassName: collapsed ? "overflow-hidden" : undefined,
		listVisible: desktop && !isDistractionFree && open,
		onInvalidCapture,
		toggle:
			desktop && !isDistractionFree
				? { open, side, controls: panelId, ref: toggleRef, onClick }
				: null,
	};
}

export function SettingsPanelToggle({ toggle }: { toggle: SettingsPanelToggleModel | null }) {
	const { t } = useLingui();
	if (!toggle) return null;
	const label = toggle.open ? t`Hide settings` : t`Show settings`;
	return (
		<Button
			ref={toggle.ref}
			variant="ghost"
			shape="square"
			size="sm"
			type="button"
			onClick={toggle.onClick}
			aria-controls={toggle.controls}
			aria-label={label}
			title={label}
		>
			{/* The glyph's stripe is drawn on the left. Mirror it to point at a right-hand panel. */}
			<SidebarSimple
				aria-hidden="true"
				className={cn("h-4 w-4", toggle.side === "right" && "-scale-x-100")}
			/>
		</Button>
	);
}
