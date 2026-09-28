import { defineChallengeContext } from "@emdash-cms/auth/passkey";

import type { ApprovalDecision } from "./digest.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ApproverEnrolmentContext {
	approverDid: string;
	credentialName: string;
}

export interface ApprovalChallengeContext {
	approverDid: string;
	publisherDid: string;
	intentId: string;
	evidenceDigest: string;
	approvalDigest: string;
	decision: ApprovalDecision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function parseEnrolmentContext(value: unknown): ApproverEnrolmentContext {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["approverDid", "credentialName"]) ||
		typeof value["approverDid"] !== "string" ||
		!DID_PATTERN.test(value["approverDid"]) ||
		typeof value["credentialName"] !== "string" ||
		value["credentialName"].length < 1 ||
		value["credentialName"].length > 100 ||
		value["credentialName"].trim() !== value["credentialName"]
	) {
		throw new TypeError("Invalid approver enrolment context");
	}
	return {
		approverDid: value["approverDid"],
		credentialName: value["credentialName"],
	};
}

function parseApprovalContext(value: unknown): ApprovalChallengeContext {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"approverDid",
			"publisherDid",
			"intentId",
			"evidenceDigest",
			"approvalDigest",
			"decision",
		]) ||
		typeof value["approverDid"] !== "string" ||
		!DID_PATTERN.test(value["approverDid"]) ||
		typeof value["publisherDid"] !== "string" ||
		!DID_PATTERN.test(value["publisherDid"]) ||
		typeof value["intentId"] !== "string" ||
		!ULID_PATTERN.test(value["intentId"]) ||
		typeof value["evidenceDigest"] !== "string" ||
		!DIGEST_PATTERN.test(value["evidenceDigest"]) ||
		typeof value["approvalDigest"] !== "string" ||
		!DIGEST_PATTERN.test(value["approvalDigest"]) ||
		(value["decision"] !== "approve" && value["decision"] !== "reject")
	) {
		throw new TypeError("Invalid approval challenge context");
	}
	return {
		approverDid: value["approverDid"],
		publisherDid: value["publisherDid"],
		intentId: value["intentId"],
		evidenceDigest: value["evidenceDigest"],
		approvalDigest: value["approvalDigest"],
		decision: value["decision"],
	};
}

export const approverEnrolmentContext = defineChallengeContext(
	"emdash-approver-enrolment",
	1,
	parseEnrolmentContext,
);

export const approvalChallengeContext = defineChallengeContext(
	"emdash-release-approval",
	1,
	parseApprovalContext,
);
