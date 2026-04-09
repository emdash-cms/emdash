/**
 * AT Protocol Auth Provider Admin Components
 *
 * Provides LoginForm and SetupStep components for the pluggable auth system.
 * These are imported at build time via the virtual:emdash/auth-providers module.
 */

import * as React from "react";

// ============================================================================
// Shared icon
// ============================================================================

function AtprotoIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 600 527" fill="currentColor">
			<path d="m135.72 44.03c66.496 49.921 138.02 151.14 164.28 205.46 26.262-54.316 97.782-155.54 164.28-205.46 47.98-36.021 125.72-63.892 125.72 24.795 0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.3797-3.6904-10.832-3.7077-7.8964-0.0174-2.9357-1.1937 0.51669-3.7077 7.8964-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.26 82.697-152.22-67.108 11.421-142.55-7.4491-163.25-81.433-5.9562-21.282-16.111-152.36-16.111-170.07 0-88.687 77.742-60.816 125.72-24.795z" />
		</svg>
	);
}

// ============================================================================
// LoginButton — compact button shown in the provider grid
// ============================================================================

export function LoginButton() {
	return (
		<button
			type="button"
			className="w-full inline-flex items-center justify-center gap-2 rounded-md border border-kumo-tint bg-kumo-base px-4 py-2 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
		>
			<AtprotoIcon className="h-5 w-5" />
			<span>AT Protocol</span>
		</button>
	);
}

// ============================================================================
// LoginForm — expanded form shown when LoginButton is clicked
// ============================================================================

export function LoginForm() {
	const [handle, setHandle] = React.useState("");
	const [isLoading, setIsLoading] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!handle.trim()) return;

		setIsLoading(true);
		setError(null);

		try {
			const response = await fetch("/_emdash/api/auth/atproto/login", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-EmDash-Request": "1",
				},
				body: JSON.stringify({ handle: handle.trim() }),
			});

			if (!response.ok) {
				const body: { error?: { message?: string } } = await response.json().catch(() => ({}));
				throw new Error(body?.error?.message || "Failed to start AT Protocol login");
			}

			const result: { data: { url: string } } = await response.json();
			window.location.href = result.data.url;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to start AT Protocol login");
			setIsLoading(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-3">
			<div>
				<label
					htmlFor="atproto-handle"
					className="block text-sm font-medium text-kumo-default mb-1"
				>
					AT Protocol Handle
				</label>
				<input
					id="atproto-handle"
					type="text"
					value={handle}
					onChange={(e) => setHandle(e.target.value)}
					placeholder="you.bsky.social"
					disabled={isLoading}
					className="w-full rounded-md border border-kumo-tint bg-kumo-base px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-2 focus:ring-kumo-brand"
				/>
			</div>

			{error && (
				<div className="rounded-lg bg-kumo-danger/10 p-3 text-sm text-kumo-danger">{error}</div>
			)}

			<button
				type="submit"
				disabled={isLoading || !handle.trim()}
				className="w-full justify-center rounded-md bg-kumo-brand px-4 py-2 text-sm font-medium text-white hover:bg-kumo-brand/90 disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{isLoading ? "Connecting..." : "Sign in with PDS"}
			</button>
		</form>
	);
}

// ============================================================================
// SetupStep — shown in the setup wizard
// ============================================================================

export function SetupStep({ onComplete }: { onComplete: () => void }) {
	const [handle, setHandle] = React.useState("");
	const [isLoading, setIsLoading] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	// Suppress unused variable warning — onComplete is called after redirect
	void onComplete;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!handle.trim()) return;

		setIsLoading(true);
		setError(null);

		try {
			const response = await fetch("/_emdash/api/setup/atproto-admin", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-EmDash-Request": "1",
				},
				body: JSON.stringify({ handle: handle.trim() }),
			});

			if (!response.ok) {
				const body: { error?: { message?: string } } = await response.json().catch(() => ({}));
				throw new Error(body?.error?.message || "Failed to start AT Protocol login");
			}

			const result: { data: { url: string } } = await response.json();
			// Redirect to PDS authorization page — onComplete will be called after redirect back
			window.location.href = result.data.url;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to start AT Protocol login");
			setIsLoading(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-3">
			<div className="text-center mb-2">
				<p className="text-sm font-medium text-kumo-default">AT Protocol</p>
				<p className="text-xs text-kumo-subtle">Sign in with your PDS handle</p>
			</div>

			<div>
				<input
					type="text"
					value={handle}
					onChange={(e) => setHandle(e.target.value)}
					placeholder="you.bsky.social"
					disabled={isLoading}
					className="w-full rounded-md border border-kumo-tint bg-kumo-base px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-2 focus:ring-kumo-brand"
				/>
			</div>

			{error && (
				<div className="rounded-lg bg-kumo-danger/10 p-3 text-sm text-kumo-danger">{error}</div>
			)}

			<button
				type="submit"
				disabled={isLoading || !handle.trim()}
				className="w-full justify-center rounded-md border border-kumo-tint bg-kumo-base px-4 py-2 text-sm font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{isLoading ? "Connecting..." : "Sign in with PDS"}
			</button>
		</form>
	);
}
