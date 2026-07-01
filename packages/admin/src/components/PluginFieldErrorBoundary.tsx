import { Trans } from "@lingui/react/macro";
import * as React from "react";

interface Props {
	children: React.ReactNode;
	/** The underlying field kind to show in the error message */
	fieldKind: string;
}

interface State {
	hasError: boolean;
	error?: Error;
}

/**
 * Error boundary that wraps trusted plugin field widgets.
 * On render error, shows a warning with a retry button instead of crashing the editor.
 */
export class PluginFieldErrorBoundary extends React.Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error };
	}

	override render() {
		if (this.state.hasError) {
			return (
				<div className="rounded-md border border-kumo-danger/50 bg-kumo-danger/5 p-3">
					<p className="text-sm font-medium text-kumo-danger">
						<Trans>Plugin widget error</Trans>
					</p>
					<p className="mt-1 text-xs text-kumo-subtle">
						{this.state.error?.message || <Trans>The plugin field widget failed to render.</Trans>}
					</p>
					<button
						type="button"
						className="mt-2 text-xs font-medium text-kumo-brand underline"
						onClick={() => this.setState({ hasError: false, error: undefined })}
					>
						<Trans>Retry</Trans>
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
