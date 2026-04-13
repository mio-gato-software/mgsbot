const tutorActive = process.env.ENABLE_TUTOR_MODE === "true";

export function isTutorActive(): boolean {
	return tutorActive;
}
