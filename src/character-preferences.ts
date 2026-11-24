import { z } from "zod";
import { withCharacterPreferencesLock } from "./memory/locks.ts";
import { readStore, writeStore } from "./memory/storage.ts";
import { memoryPath } from "./runtime-paths.ts";

export const CHARACTER_PREFERENCES_FILE = "character-preferences.json";
export const MAX_CHARACTER_PREFERENCES = 48;
const MAX_RECEIPTS = 256;

export const characterPreferenceKeySchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const characterPreferenceLabelSchema = z.string().trim().min(1).max(80);
export const characterPreferenceValueSchema = z.string().trim().min(1).max(180);

const nonnegativeInteger = z.number().int().safe().nonnegative();
const fields = {
	key: characterPreferenceKeySchema,
	label: characterPreferenceLabelSchema,
	value: characterPreferenceValueSchema,
};

const preferenceSchema = z.object({
	...fields,
	updatedAt: nonnegativeInteger,
});

export type CharacterPreference = z.infer<typeof preferenceSchema>;

export const characterPreferenceChangeSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("create"), ...fields }),
	z.object({
		action: z.literal("revise"),
		key: fields.key,
		value: fields.value,
	}),
]);

export type CharacterPreferenceChange = z.infer<
	typeof characterPreferenceChangeSchema
>;

const changesSchema = z
	.array(characterPreferenceChangeSchema)
	.min(1)
	.refine(
		(changes) =>
			new Set(changes.map((change) => change.key)).size === changes.length,
		"Each character preference can change only once per turn",
	);

const sourceSchema = z.object({
	chatId: z
		.number()
		.int()
		.safe()
		.refine((id) => id !== 0),
	messageId: z.number().int().safe().positive(),
});

type Source = z.infer<typeof sourceSchema>;

function sourceKey(source: Source): string {
	return `${source.chatId}:${source.messageId}`;
}

export const characterPreferenceStateSchema = z.object({
	revision: nonnegativeInteger,
	preferences: z
		.array(preferenceSchema)
		.max(MAX_CHARACTER_PREFERENCES)
		.refine(
			(entries) =>
				new Set(entries.map((entry) => entry.key)).size === entries.length,
			"Character preference keys must be unique",
		),
	receipts: z
		.array(sourceSchema)
		.max(MAX_RECEIPTS)
		.refine(
			(receipts) => new Set(receipts.map(sourceKey)).size === receipts.length,
			"Character preference receipts must be unique",
		),
});

export type CharacterPreferenceState = z.infer<
	typeof characterPreferenceStateSchema
>;

type ApplyResult = {
	status: "applied" | "conflict" | "duplicate" | "capacity";
	state: CharacterPreferenceState;
};

export class CharacterPreferenceStore {
	constructor(
		private readonly path = memoryPath(CHARACTER_PREFERENCES_FILE),
		private readonly now: () => number = Date.now,
	) {}

	read(): Promise<CharacterPreferenceState> {
		return readStore(this.path, characterPreferenceStateSchema, () => ({
			revision: 0,
			preferences: [],
			receipts: [],
		}));
	}

	async apply(
		expectedRevision: number,
		changes: readonly CharacterPreferenceChange[],
		source: Source,
	): Promise<ApplyResult> {
		const revision = nonnegativeInteger.parse(expectedRevision);
		const checkedChanges = changesSchema.parse(changes);
		const checkedSource = sourceSchema.parse(source);
		return withCharacterPreferencesLock(async () => {
			const state = await this.read();
			if (
				state.receipts.some(
					(receipt) =>
						receipt.chatId === checkedSource.chatId &&
						receipt.messageId === checkedSource.messageId,
				)
			)
				return { status: "duplicate", state };
			if (revision !== state.revision) return { status: "conflict", state };

			const preferences = new Map(
				state.preferences.map((entry) => [entry.key, entry]),
			);
			const updatedAt = this.now();
			for (const change of checkedChanges) {
				const existing = preferences.get(change.key);
				if (change.action === "create") {
					if (existing) return { status: "conflict", state };
					const { key, label, value } = change;
					preferences.set(key, { key, label, value, updatedAt });
				} else {
					if (!existing) return { status: "conflict", state };
					if (existing.value !== change.value)
						preferences.set(change.key, {
							...existing,
							value: change.value,
							updatedAt,
						});
				}
			}
			if (preferences.size > MAX_CHARACTER_PREFERENCES)
				return { status: "capacity", state };

			const next = {
				revision: state.revision + 1,
				preferences: [...preferences.values()],
				receipts: [...state.receipts, checkedSource].slice(-MAX_RECEIPTS),
			};
			await writeStore(this.path, next, characterPreferenceStateSchema, true);
			return { status: "applied", state: next };
		});
	}
}

export const characterPreferences = new CharacterPreferenceStore();
