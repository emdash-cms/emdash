import { Banner } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

export function RevisionViewError() {
	const { t } = useLingui();
	return <Banner variant="error" role="alert" title={t`This version can't be shown.`} />;
}

interface RevisionViewErrorBoundaryProps {
	/** The shown version. A new one gets another try without remounting what's on screen. */
	resetKey: string | null;
	children: React.ReactNode;
}

interface RevisionViewErrorBoundaryState {
	hasError: boolean;
	resetKey: string | null;
}

/** Keeps a version that fails to render from taking the editor down with it. */
export class RevisionViewErrorBoundary extends React.Component<
	RevisionViewErrorBoundaryProps,
	RevisionViewErrorBoundaryState
> {
	override state: RevisionViewErrorBoundaryState = {
		hasError: false,
		resetKey: this.props.resetKey,
	};

	static getDerivedStateFromProps(
		props: RevisionViewErrorBoundaryProps,
		state: RevisionViewErrorBoundaryState,
	): Partial<RevisionViewErrorBoundaryState> | null {
		return props.resetKey === state.resetKey ? null : { hasError: false, resetKey: props.resetKey };
	}

	static getDerivedStateFromError(): Partial<RevisionViewErrorBoundaryState> {
		return { hasError: true };
	}

	override componentDidCatch(error: unknown) {
		console.error("[revisions] Failed to show version:", error);
	}

	override render() {
		return this.state.hasError ? <RevisionViewError /> : this.props.children;
	}
}
