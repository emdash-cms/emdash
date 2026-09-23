import { Client, ClientResponseError, ok, simpleFetchHandler } from "@atcute/client";
import { is } from "@atcute/lexicons/validations";
import {
	LabelerListAssessments,
	LabelerGetCurrentAssessment,
	type LabelerDefs,
} from "@emdash-cms/registry-lexicons";

export type ListingSubjectKind = "profile" | "release";
export type ListingAssessment = Pick<
	LabelerDefs.PublicAssessment,
	"reasonCodes" | "state" | "summary" | "subject"
>;

export interface GetLatestListingAssessmentOptions {
	labelerUrl: string;
	kind: ListingSubjectKind;
	uri: string;
	fetch?: typeof fetch;
}

export async function getLatestListingAssessment(
	options: GetLatestListingAssessmentOptions,
): Promise<ListingAssessment | null> {
	const client = new Client({
		handler: simpleFetchHandler({
			service: options.labelerUrl,
			fetch: options.fetch ?? globalThis.fetch,
		}),
	});
	const params = { kind: options.kind, uri: options.uri, limit: 1 };
	if (!is(LabelerListAssessments.mainSchema.params, params)) {
		throw new TypeError("Listing assessment subject is invalid");
	}
	const result = await ok(
		client.call(LabelerListAssessments, {
			params,
		}),
	);
	const latest = result.assessments[0];
	if (!latest) return null;
	const currentParams = {
		kind: latest.subject.kind,
		uri: latest.subject.uri,
		cid: latest.subject.cid,
	};
	if (!is(LabelerGetCurrentAssessment.mainSchema.params, currentParams)) {
		throw new TypeError("Current listing assessment subject is invalid");
	}
	let current: LabelerGetCurrentAssessment.$output;
	try {
		current = await ok(
			client.call(LabelerGetCurrentAssessment, {
				params: currentParams,
			}),
		);
	} catch (error) {
		if (error instanceof ClientResponseError && error.error === "NotFound") return null;
		throw error;
	}
	const assessment = current.assessment;
	return {
		state: activeLabelState(current.activeLabels) ?? assessment.state,
		subject: assessment.subject,
		reasonCodes: assessment.reasonCodes,
		...(assessment.summary === undefined ? {} : { summary: assessment.summary }),
	};
}

function activeLabelState(
	labels: LabelerGetCurrentAssessment.$output["activeLabels"],
): ListingAssessment["state"] | null {
	const values = new Set(labels.filter((label) => label.neg !== true).map((label) => label.val));
	if (values.has("!takedown") || values.has("listing-blocked")) return "blocked";
	if (values.has("listing-passed")) return "passed";
	if (values.has("listing-review")) return "review";
	if (values.has("listing-error")) return "error";
	if (values.has("listing-pending")) return "pending";
	return null;
}

export function listingStatusMessage(
	subject: string,
	assessment: Pick<ListingAssessment, "state"> | null,
): string {
	switch (assessment?.state) {
		case "passed":
			return `${subject}: approved`;
		case "review":
			return `${subject}: needs review`;
		case "error":
			return `${subject}: checks could not complete`;
		case "blocked":
			return `${subject}: not approved`;
		case "pending":
			return `${subject}: checks in progress`;
		case "superseded":
		case undefined:
			return `${subject}: waiting for checks`;
		default:
			return `${subject}: status unavailable`;
	}
}
