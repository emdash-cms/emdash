export const WORKLOAD_VERIFICATION_ERROR_CODES = [
	"WORKLOAD_TOKEN_MALFORMED",
	"WORKLOAD_TOKEN_UNSUPPORTED_ALGORITHM",
	"WORKLOAD_TOKEN_SIGNATURE_INVALID",
	"WORKLOAD_TOKEN_ISSUER_INVALID",
	"WORKLOAD_TOKEN_AUDIENCE_INVALID",
	"WORKLOAD_TOKEN_EXPIRED",
	"WORKLOAD_TOKEN_NOT_ACTIVE",
	"WORKLOAD_TOKEN_IAT_INVALID",
	"WORKLOAD_CLAIMS_INVALID",
	"WORKLOAD_DISCOVERY_INVALID",
	"WORKLOAD_JWKS_INVALID",
	"WORKLOAD_ISSUER_UNAVAILABLE",
] as const;

export type WorkloadVerificationErrorCode = (typeof WORKLOAD_VERIFICATION_ERROR_CODES)[number];

export interface VerifiedWorkload {
	issuer: string;
	subject: string;
	repository: string;
	repositoryId: string;
	repositoryOwnerId: string;
	workflowRef: string;
	jobWorkflowRef?: string;
	ref: string;
	sha: string;
	runId: string;
	runAttempt: string;
	environment?: string;
	expiresAt: number;
}

export interface WorkloadVerificationError {
	code: WorkloadVerificationErrorCode;
	message: "Workload identity verification failed";
}

export type WorkloadVerificationResult =
	| { success: true; workload: VerifiedWorkload }
	| { success: false; error: WorkloadVerificationError };

export interface WorkloadVerificationOptions {
	signal?: AbortSignal;
}

export interface WorkloadIssuer {
	verify(
		token: string,
		expectedAudience: string,
		options?: WorkloadVerificationOptions,
	): Promise<WorkloadVerificationResult>;
}

export interface WorkloadMatcher<Policy> {
	matches(workload: VerifiedWorkload, policy: Policy): boolean;
}
