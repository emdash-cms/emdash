/**
 * AT Protocol Auth Provider Admin Components
 *
 * Provides LoginForm and SetupStep components for the pluggable auth system.
 * These are imported at build time via the virtual:emdash/auth-providers module.
 */

import { Button, Input } from "@cloudflare/kumo";
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
		<Button type="button" variant="outline" className="w-full justify-center">
			<AtprotoIcon className="h-5 w-5" />
			<span>Atmosphere</span>
		</Button>
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
			<Input
				label="Atmosphere Handle"
				type="text"
				value={handle}
				onChange={(e) => setHandle(e.target.value)}
				placeholder="you.bsky.social"
				disabled={isLoading}
			/>

			{error && (
				<div className="rounded-lg bg-kumo-danger/10 p-3 text-sm text-kumo-danger">{error}</div>
			)}

			<Button type="submit" className="w-full" disabled={isLoading || !handle.trim()}>
				{isLoading ? "Connecting..." : "Sign in"}
			</Button>
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
				<p className="text-sm font-medium text-kumo-default">Atmosphere</p>
				<p className="text-xs text-kumo-subtle">Sign in with your Bluesky/Atmosphere handle</p>
			</div>

			<Input
				label="Atmosphere Handle"
				name="handle"
				type="text"
				value={handle}
				onChange={(e) => setHandle(e.target.value)}
				placeholder="you.bsky.social"
				disabled={isLoading}
				className="w-full"
			/>

			{error && (
				<div className="rounded-lg bg-kumo-danger/10 p-3 text-sm text-kumo-danger">{error}</div>
			)}

			<Button
				type="submit"
				variant="outline"
				className="w-full"
				disabled={isLoading || !handle.trim()}
			>
				{isLoading ? "Connecting..." : "Sign in"}
			</Button>
		</form>
	);
}
