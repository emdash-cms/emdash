export interface FocalPoint {
	focalX: number;
	focalY: number;
}

export interface FocalPointUpdate {
	focalX?: number | null;
	focalY?: number | null;
}

function isFocalCoordinate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function normalizeFocalPoint(focalX: unknown, focalY: unknown): FocalPoint | null {
	if (!isFocalCoordinate(focalX) || !isFocalCoordinate(focalY)) return null;
	return { focalX, focalY };
}

export function isValidFocalPointUpdate(input: FocalPointUpdate): boolean {
	const hasX = input.focalX !== undefined;
	const hasY = input.focalY !== undefined;
	if (!hasX && !hasY) return true;
	if (!hasX || !hasY) return false;
	if (input.focalX === null || input.focalY === null) {
		return input.focalX === null && input.focalY === null;
	}
	return normalizeFocalPoint(input.focalX, input.focalY) !== null;
}

export function focalPointToObjectPosition(focalX: unknown, focalY: unknown): string | undefined {
	const point = normalizeFocalPoint(focalX, focalY);
	if (!point) return undefined;
	const x = Math.round(point.focalX * 10_000) / 100;
	const y = Math.round(point.focalY * 10_000) / 100;
	return `${x}% ${y}%`;
}
