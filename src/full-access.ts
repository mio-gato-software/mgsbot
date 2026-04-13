const fullAccessActive = process.env.FULL_ACCESS_MODE === "true";

export function isFullAccessActive(): boolean {
	return fullAccessActive;
}
