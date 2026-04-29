/**
 * API Test Plugin - Admin Components
 *
 * Provides a dashboard widget and test page for exercising plugin APIs.
 */

import {
	Play,
	CheckCircle,
	XCircle,
	CircleNotch,
	Database,
	Key,
	Globe,
	FileText,
	ImageSquare,
	Terminal,
	ArrowsClockwise,
} from "@phosphor-icons/react";
import type { PluginAdminExports } from "emdash";
import { apiFetch, getErrorMessage, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

// =============================================================================
// Types
// =============================================================================

interface TestResult {
	name: string;
	status: "pending" | "running" | "success" | "error";
	duration?: number;
	error?: string;
	data?: unknown;
}

interface ApiTestResults {
	plugin: { id: string; version: string };
	log: string;
	kv: { key: string; value: unknown; cleaned: boolean };
	storage: { id: string; entry: unknown; cleaned: boolean };
	content: { available: boolean; canWrite: boolean; sampleCount: number };
	media: { available: boolean; canWrite: boolean; sampleCount: number };
	http: { available: boolean; testStatus?: number; error?: string };
}

// =============================================================================
// Dashboard Widget
// =============================================================================

function ApiTestWidget() {
	const [lastRun, setLastRun] = React.useState<Date | null>(null);
	const [results, setResults] = React.useState<ApiTestResults | null>(null);
	const [isRunning, setIsRunning] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	const runTests = async () => {
		setIsRunning(true);
		setError(null);
		try {
			const response = await apiFetch("/_emdash/api/plugins/api-test/test/all", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			if (response.ok) {
				const data = await parseApiResponse<{ results: ApiTestResults }>(response);
				setResults(data.results);
				setLastRun(new Date());
			} else {
				setError(await getErrorMessage(response, "Test failed"));
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : "Test failed");
		} finally {
			setIsRunning(false);
		}
	};

	const apiStatus = React.useMemo(() => {
		if (!results) return [];
		return [
			{ name: "Plugin", ok: !!results.plugin?.id, icon: Terminal },
			{ name: "KV", ok: results.kv?.cleaned, icon: Key },
			{ name: "Storage", ok: results.storage?.cleaned, icon: Database },
			{ name: "Content", ok: results.content?.available, icon: FileText },
			{ name: "Media", ok: results.media?.available, icon: ImageSquare },
			{ name: "HTTP", ok: results.http?.testStatus === 200, icon: Globe },
		];
	}, [results]);

	return (
		<div className="space-y-4">
			{error && <div className="text-xs text-red-500 bg-red-500/10 rounded p-2">{error}</div>}

			{results ? (
				<div className="grid grid-cols-3 gap-2">
					{apiStatus.map(({ name, ok, icon: Icon }) => (
						<div key={name} className="flex items-center gap-1.5 text-xs">
							<Icon className="h-3.5 w-3.5 text-muted-foreground" />
							<span className="text-muted-foreground">{name}</span>
							{ok ? (
								<CheckCircle className="h-3.5 w-3.5 text-green-500 ms-auto" />
							) : (
								<XCircle className="h-3.5 w-3.5 text-red-500 ms-auto" />
							)}
						</div>
					))}
				</div>
			) : (
				<div className="text-center text-sm text-muted-foreground py-4">No test results yet</div>
			)}

			<div className="flex items-center justify-between pt-2 border-t">
				{lastRun && (
					<span className="text-xs text-muted-foreground">
						Last run: {lastRun.toLocaleTimeString()}
					</span>
				)}
				<button
					onClick={runTests}
					disabled={isRunning}
					className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 ms-auto"
				>
					{isRunning ? (
						<CircleNotch className="h-3.5 w-3.5 animate-spin" />
					) : (
						<ArrowsClockwise className="h-3.5 w-3.5" />
					)}
					{isRunning ? "Running..." : "Run Tests"}
				</button>
			</div>
		</div>
	);
}

// =============================================================================
// Test Page
// =============================================================================

const API_TESTS = [
	{
		id: "plugin-info",
		name: "Plugin Info",
		route: "plugin/info",
		icon: Terminal,
	},
	{
		id: "kv-set",
		name: "KV Set",
		route: "kv/set",
		icon: Key,
		body: { key: "admin-test", value: { from: "admin" } },
	},
	{
		id: "kv-get",
		name: "KV Get",
		route: "kv/get",
		icon: Key,
		body: { key: "admin-test" },
	},
	{ id: "kv-list", name: "KV List", route: "kv/list", icon: Key },
	{
		id: "storage-put",
		name: "Storage Put",
		route: "storage/logs/put",
		icon: Database,
		body: { level: "info", message: "Test from admin" },
	},
	{
		id: "storage-query",
		name: "Storage Query",
		route: "storage/logs/query",
		icon: Database,
		body: { limit: 5 },
	},
	{
		id: "content-list",
		name: "Content List",
		route: "content/list",
		icon: FileText,
	},
	{
		id: "media-list",
		name: "Media List",
		route: "media/list",
		icon: ImageSquare,
	},
	{
		id: "http-fetch",
		name: "HTTP Fetch",
		route: "http/fetch",
		icon: Globe,
		body: { url: "https://httpbin.org/get" },
	},
	{ id: "log-test", name: "Logging", route: "log/test", icon: Terminal },
];

function TestPage() {
	const [results, setResults] = React.useState<Record<string, TestResult>>({});
	const [isRunningAll, setIsRunningAll] = React.useState(false);

	const runTest = async (testId: string, route: string, body?: unknown) => {
		setResults((prev) => ({
			...prev,
			[testId]: { name: testId, status: "running" },
		}));

		const start = Date.now();
		try {
			const response = await apiFetch(`/_emdash/api/plugins/api-test/${route}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body || {}),
			});
			const duration = Date.now() - start;

			if (response.ok) {
				const data = await parseApiResponse<unknown>(response);
				setResults((prev) => ({
					...prev,
					[testId]: { name: testId, status: "success", duration, data },
				}));
			} else {
				const errorMsg = await getErrorMessage(response, "Failed");
				setResults((prev) => ({
					...prev,
					[testId]: {
						name: testId,
						status: "error",
						duration,
						error: errorMsg,
					},
				}));
			}
		} catch (e) {
			setResults((prev) => ({
				...prev,
				[testId]: {
					name: testId,
					status: "error",
					duration: Date.now() - start,
					error: e instanceof Error ? e.message : "Failed",
				},
			}));
		}
	};

	const runAllTests = async () => {
		setIsRunningAll(true);
		for (const test of API_TESTS) {
			await runTest(test.id, test.route, test.body);
		}
		setIsRunningAll(false);
	};

	const successCount = Object.values(results).filter((r) => r.status === "success").length;
	const errorCount = Object.values(results).filter((r) => r.status === "error").length;

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-3xl font-bold">API Tests</h1>
					<p className="text-muted-foreground mt-1">Test all plugin v2 APIs</p>
				</div>
				<div className="flex items-center gap-3">
					{Object.keys(results).length > 0 && (
						<div className="text-sm text-muted-foreground">
							<span className="text-green-500">{successCount} passed</span>
							{errorCount > 0 && (
								<>
									{" / "}
									<span className="text-red-500">{errorCount} failed</span>
								</>
							)}
						</div>
					)}
					<button
						onClick={runAllTests}
						disabled={isRunningAll}
						className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
					>
						{isRunningAll ? (
							<CircleNotch className="h-4 w-4 animate-spin" />
						) : (
							<Play className="h-4 w-4" />
						)}
						{isRunningAll ? "Running..." : "Run All Tests"}
					</button>
				</div>
			</div>

			<div className="grid gap-4 md:grid-cols-2">
				{API_TESTS.map((test) => {
					const result = results[test.id];
					const Icon = test.icon;

					return (
						<div key={test.id} className="border rounded-lg p-4 space-y-3">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<Icon className="h-4 w-4 text-muted-foreground" />
									<span className="font-medium">{test.name}</span>
								</div>
								<div className="flex items-center gap-2">
									{result?.status === "success" && (
										<span className="text-xs text-muted-foreground">{result.duration}ms</span>
									)}
									{result?.status === "running" ? (
										<CircleNotch className="h-4 w-4 animate-spin text-muted-foreground" />
									) : result?.status === "success" ? (
										<CheckCircle className="h-4 w-4 text-green-500" />
									) : result?.status === "error" ? (
										<XCircle className="h-4 w-4 text-red-500" />
									) : null}
									<button
										onClick={() => runTest(test.id, test.route, test.body)}
										disabled={result?.status === "running" || isRunningAll}
										className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
									>
										Run
									</button>
								</div>
							</div>

							<div className="text-xs text-muted-foreground font-mono">
								POST /_emdash/api/plugins/api-test/{test.route}
							</div>

							{result?.status === "error" && (
								<div className="text-xs text-red-500 bg-red-500/10 rounded p-2">{result.error}</div>
							)}

							{result?.status === "success" && result.data && (
								<pre className="text-xs bg-muted rounded p-2 overflow-auto max-h-32">
									{JSON.stringify(result.data, null, 2)}
								</pre>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

// =============================================================================
// Exports
// =============================================================================

export const widgets: PluginAdminExports["widgets"] = {
	"api-status": ApiTestWidget,
};

export const pages: PluginAdminExports["pages"] = {
	"/test": TestPage,
};
