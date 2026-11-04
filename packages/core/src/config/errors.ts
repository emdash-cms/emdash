export type EmDashConfigurationErrorCode = "BINDING_NOT_FOUND" | "CONFIGURATION_ERROR";

/** A configuration failure whose message is safe to return from the API. */
export class EmDashConfigurationError extends Error {
	constructor(
		message: string,
		public readonly code: EmDashConfigurationErrorCode,
		public override cause?: unknown,
	) {
		super(message);
		this.name = "EmDashConfigurationError";
	}
}
