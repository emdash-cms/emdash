import { createFlueClient, FlueExecutionError } from "@flue/sdk";

const trailingSlash = /\/$/;
const [baseUrl, mode = "quick", interruption = "none"] = process.argv.slice(2);
if (!baseUrl) {
	throw new Error(
		"Usage: tsx scripts/probe.ts <base-url> [quick|long|fail|durable-long] [none|container|container-abort|redeploy]",
	);
}
const key = process.env.PROBE_KEY;
if (!key) throw new Error("PROBE_KEY is required");

const id = `${mode}-${Date.now()}`;
const url = `${baseUrl.replace(trailingSlash, "")}/agents/durability-probe/${id}`;
const client = createFlueClient({ url, token: key });
const admission = await client.send({
	message: { kind: "user", body: `Run the ${mode} durability probe now.` },
	initialData: { mode },
	uid: null,
});

console.log(JSON.stringify({ phase: "admitted", id, ...admission }, null, 2));

if (interruption === "container" || interruption === "container-abort") {
	void (async () => {
		await new Promise((resolve) => setTimeout(resolve, 10_000));
		const response = await fetch(
			`${baseUrl.replace(trailingSlash, "")}/control/${id}/container/destroy`,
			{ method: "POST", headers: { authorization: `Bearer ${key}` } },
		);
		console.log(JSON.stringify({ phase: "container-destroy", status: response.status }));
		if (interruption === "container-abort") {
			await new Promise((resolve) => setTimeout(resolve, 5_000));
			const result = await client.abort();
			console.log(JSON.stringify({ phase: "abort", ...result }));
		}
	})().catch((error) =>
		console.error(JSON.stringify({ phase: "interrupt-error", error: String(error) })),
	);
} else if (interruption === "redeploy") {
	console.log("Redeploy the Worker now from another terminal; waiting for durable settlement.");
}

try {
	await client.wait(admission, {
		signal: AbortSignal.timeout(12 * 60_000),
		onEvent(event) {
			if (event.type === "submission-settled") {
				console.log(JSON.stringify({ phase: "settled", event }, null, 2));
			}
		},
	});
	console.log(JSON.stringify({ phase: "completed", submissionId: admission.submissionId }));
} catch (error) {
	if (error instanceof FlueExecutionError) {
		console.error(
			JSON.stringify(
				{
					phase: "failed",
					submissionId: error.targetId,
					failure: error.failure,
					error: error.error,
				},
				null,
				2,
			),
		);
	} else if (error instanceof DOMException && error.name === "TimeoutError") {
		console.error(
			JSON.stringify({ phase: "observation-timeout", submissionId: admission.submissionId }),
		);
	} else {
		throw error;
	}
}

const history = await client.history();
console.log(JSON.stringify({ phase: "history", settlements: history.settlements }, null, 2));
