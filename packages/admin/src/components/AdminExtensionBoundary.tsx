import { Trans } from "@lingui/react/macro";
import * as React from "react";

interface Props {
	children: React.ReactNode;
	/**
	 * Where the extension renders, which decides the fallback shape:
	 * - `"cell"`: a quiet placeholder that keeps the table cell's size and
	 *   semantics (no card chrome inside a `<td>`).
	 * - `"panel"`: a restrained note with a retry action, matching the
	 *   plugin-field boundary's tone.
	 */
	variant: "cell" | "panel";
	/** Replaces the variant's default fallback (e.g. a header's plain label). */
	fallback?: React.ReactNode;
	/**
	 * Accessible name of the failed extension (e.g. the panel title), added
	 * screen-reader-only to the retry action so two broken panels don't
	 * produce two indistinguishable "Retry" buttons.
	 */
	label?: string;
}

interface State {
	hasError: boolean;
}

/**
 * Error boundary around trusted admin extensions (content-list columns and
 * editor sidebar panels). One broken contribution degrades to a small,
 * accessible fallback instead of unmounting the list or the editor.
 *
 * Unlike `PluginFieldErrorBoundary`, the error message itself is never
 * rendered — extension failures can wrap arbitrary data, and the admin UI
 * must not leak it. The error is logged to the console for developers.
 */
export class AdminExtensionBoundary extends React.Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError(): State {
		return { hasError: true };
	}

	override componentDidCatch(error: Error, info: React.ErrorInfo) {
		console.error("[admin-extensions] An admin extension failed to render.", error, info);
	}

	override render() {
		if (this.state.hasError) {
			if (this.props.fallback !== undefined) {
				return this.props.fallback;
			}
			if (this.props.variant === "cell") {
				return (
					<span className="text-kumo-subtle">
						<span aria-hidden="true">—</span>
						<span className="sr-only">
							<Trans>Extension failed to render</Trans>
						</span>
					</span>
				);
			}
			return (
				// `alert` is the role designed to announce content that appears
				// after render, which is exactly how a boundary fallback mounts.
				<div role="alert" className="text-sm text-kumo-subtle">
					<p>
						<Trans>This extension failed to render.</Trans>
					</p>
					<button
						type="button"
						className="mt-1 text-xs font-medium text-kumo-brand underline"
						onClick={() => this.setState({ hasError: false })}
					>
						<Trans>Retry</Trans>
						{this.props.label !== undefined && <span className="sr-only"> {this.props.label}</span>}
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
