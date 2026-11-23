import { log } from "../logger.ts";
import {
	currentOperationSignal,
	requestSignal,
} from "../operation-deadline.ts";
import { resolveTypeSafeClassifierModel } from "./platform.ts";
import type { ClassifierQuestions } from "./typed-classifier.ts";

export async function evaluateWithTypeSafe(
	state: Record<string, unknown>,
	questions: ClassifierQuestions,
): Promise<unknown> {
	const key = process.env.TYPESAFE_API_KEY?.trim();
	if (!key) return null;
	try {
		const response = await fetch("https://api.typesafe.ai/v1/systemone", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: resolveTypeSafeClassifierModel(),
				state,
				questions,
			}),
			// Bound the extra wait before the existing classifier takes over.
			signal: requestSignal(2000),
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			log.warn(
				`[typesafe] Classifier HTTP ${response.status}; using existing classifier.`,
			);
			return null;
		}
		return await response.json();
	} catch {
		currentOperationSignal()?.throwIfAborted();
		// Never log upstream bodies or exceptions that might contain credentials.
		log.warn("[typesafe] Classifier unavailable; using existing classifier.");
		return null;
	}
}
