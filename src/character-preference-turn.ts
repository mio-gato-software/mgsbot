import {
	type CharacterPreferencePlan,
	type CharacterPreferenceTurnInput,
	characterPreferencePlanSchema,
	classifyCharacterPreferenceIntent,
	interpretCharacterPreferences,
} from "./ai/character-preference-classifier.ts";
import {
	type CharacterPreference,
	type CharacterPreferenceChange,
	type CharacterPreferenceStore,
	characterPreferences,
} from "./character-preferences.ts";
import { log } from "./logger.ts";
import { currentOperationSignal } from "./operation-deadline.ts";

export function characterPreferencesEnabled(): boolean {
	return (
		process.env.ENABLE_CHARACTER_PREFERENCES !== "false" &&
		process.env.SIMPLE_ASSISTANT_MODE !== "true"
	);
}

type ResolutionAction = "recall" | "keep" | "create" | "revise";

export interface CharacterPreferencePromptContext {
	preferences: readonly CharacterPreference[];
	resolutions?: readonly {
		action: ResolutionAction;
		preference: CharacterPreference;
	}[];
	unavailable?: boolean;
}

export interface CharacterPreferenceTurn
	extends Omit<CharacterPreferenceTurnInput, "preferences"> {
	chatId: number;
	messageId: number;
}

export interface CharacterPreferenceTurnDependencies {
	store: Pick<CharacterPreferenceStore, "read" | "apply">;
	classify: typeof classifyCharacterPreferenceIntent;
	interpret: typeof interpretCharacterPreferences;
}

const defaultDependencies: CharacterPreferenceTurnDependencies = {
	store: characterPreferences,
	classify: classifyCharacterPreferenceIntent,
	interpret: interpretCharacterPreferences,
};

function proposedChanges(
	plan: CharacterPreferencePlan,
	input: CharacterPreferenceTurn,
	preferences: readonly CharacterPreference[],
): CharacterPreferenceChange[] {
	const saved = new Map(preferences.map((item) => [item.key, item]));
	const changes: CharacterPreferenceChange[] = [];
	for (const entry of plan.entries) {
		const current = saved.get(entry.key);
		if (
			entry.action === "create" &&
			!current &&
			input.text.includes(entry.evidence)
		) {
			changes.push({
				action: "create",
				key: entry.key,
				label: entry.label,
				value: entry.value,
			});
		}
		// The model determines the meaning of the reason. This only verifies that
		// the evidence actually comes from the same speaker's authored messages.
		if (
			entry.action === "revise" &&
			current &&
			current.value !== entry.value &&
			(input.text.includes(entry.evidence) ||
				input.recent.some(
					(turn) =>
						turn.role === "speaker" && turn.text.includes(entry.evidence),
				))
		) {
			changes.push({ action: "revise", key: entry.key, value: entry.value });
		}
	}
	return changes;
}

function effectiveResolutions(
	plan: CharacterPreferencePlan,
	preferences: readonly CharacterPreference[],
	applied: readonly CharacterPreferenceChange[] = [],
): CharacterPreferencePromptContext["resolutions"] {
	const saved = new Map(preferences.map((item) => [item.key, item]));
	const changes = new Map(applied.map((item) => [item.key, item.action]));
	return plan.entries.flatMap(({ action, key }) => {
		const preference = saved.get(key);
		if (!preference) return [];
		const effectiveAction =
			changes.get(key) ??
			(action === "revise" || action === "keep" ? "keep" : "recall");
		return [{ action: effectiveAction, preference }];
	});
}

export async function resolveCharacterPreferenceTurn(
	input: CharacterPreferenceTurn,
	services = defaultDependencies,
): Promise<CharacterPreferencePromptContext> {
	let preferences: readonly CharacterPreference[] = [];
	const { chatId, messageId, ...conversation } = input;
	try {
		let state = await services.store.read();
		preferences = state.preferences;
		if ((await services.classify({ ...conversation, preferences })) === false)
			return { preferences };

		const source = { chatId, messageId };
		for (let attempt = 0; attempt < 2; attempt++) {
			const raw = await services.interpret({ ...conversation, preferences });
			const parsed = characterPreferencePlanSchema.safeParse(raw);
			if (!parsed.success) return { preferences, unavailable: true };
			const plan = parsed.data;
			const changes = proposedChanges(plan, input, preferences);
			if (!changes.length) {
				// A different chat can change a choice while interpretation is running.
				preferences = (await services.store.read()).preferences;
				return {
					preferences,
					resolutions: effectiveResolutions(plan, preferences),
				};
			}
			const result = await services.store.apply(
				state.revision,
				changes,
				source,
			);
			state = result.state;
			preferences = state.preferences;
			if (result.status === "conflict" && attempt === 0) continue;
			return {
				preferences,
				resolutions: effectiveResolutions(
					plan,
					preferences,
					result.status === "applied" ? changes : [],
				),
				unavailable:
					result.status === "capacity" ||
					result.status === "conflict" ||
					undefined,
			};
		}
	} catch {
		currentOperationSignal()?.throwIfAborted();
		log.warn(
			"[character preferences] Could not resolve or save the current choice",
		);
	}
	return { preferences, unavailable: true };
}
