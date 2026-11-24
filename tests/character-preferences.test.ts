import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyRestoredMemoryBackup } from "../scripts/verify-memory-backup.ts";
import {
	CHARACTER_PREFERENCES_FILE,
	type CharacterPreferenceChange,
	CharacterPreferenceStore,
	MAX_CHARACTER_PREFERENCES,
} from "../src/character-preferences.ts";
import { StoreReadError } from "../src/memory/storage.ts";
import { runMemoryBackup } from "../src/memory-backup.ts";
import { memoryPath } from "../src/runtime-paths.ts";

function fixture() {
	const directory = memoryPath("character-preference-tests", randomUUID());
	const path = join(directory, CHARACTER_PREFERENCES_FILE);
	return {
		directory,
		path,
		store: new CharacterPreferenceStore(path, () => 1000),
	};
}

const color = {
	action: "create",
	key: "favorite-color",
	label: "Favorite color",
	value: "Marigold",
} satisfies CharacterPreferenceChange;

test("character decisions persist, and a retried Telegram source cannot revise them", async () => {
	const { path, store } = fixture();
	expect(await store.read()).toEqual({
		revision: 0,
		preferences: [],
		receipts: [],
	});
	const source = {
		chatId: -100,
		messageId: 10,
		quote: "A synthetic private sentence",
	};
	const created = await store.apply(0, [color], source);
	expect(created).toEqual({
		status: "applied",
		state: {
			revision: 1,
			preferences: [
				{
					key: color.key,
					label: color.label,
					value: color.value,
					updatedAt: 1000,
				},
			],
			receipts: [{ chatId: -100, messageId: 10 }],
		},
	});
	const restarted = new CharacterPreferenceStore(path, () => 2000);
	const revised = {
		action: "revise",
		key: color.key,
		value: "Indigo",
	} as const;
	expect(await restarted.apply(0, [revised], source)).toEqual({
		status: "duplicate",
		state: created.state,
	});
	expect(
		await restarted.apply(1, [revised], { chatId: 200, messageId: 10 }),
	).toMatchObject({
		status: "applied",
		state: {
			revision: 2,
			preferences: [
				{
					key: color.key,
					label: color.label,
					value: "Indigo",
					updatedAt: 2000,
				},
			],
		},
	});
	const raw = await readFile(path, "utf8");
	expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 1 });
	expect(raw).not.toContain(source.quote);
});

test("concurrent proposals from two chats cannot overwrite the same character preference", async () => {
	const { path, store } = fixture();
	const otherStore = new CharacterPreferenceStore(path, () => 2000);
	const [first, second] = await Promise.all([
		store.apply(0, [color], { chatId: -101, messageId: 10 }),
		otherStore.apply(0, [{ ...color, value: "Blue" }], {
			chatId: 201,
			messageId: 10,
		}),
	]);
	expect(first.status).toBe("applied");
	expect(second).toEqual({ status: "conflict", state: first.state });
	expect(
		await otherStore.apply(1, [{ ...color, value: "Blue" }], {
			chatId: 201,
			messageId: 10,
		}),
	).toEqual({ status: "conflict", state: first.state });
	expect(await store.read()).toEqual(first.state);
});

test("invalid slugs, duplicate changes and missing revision targets leave a batch untouched", async () => {
	const { store } = fixture();
	const source = { chatId: 100, messageId: 1 };
	for (const key of [
		"Color",
		"favorito-café",
		"favorite--color",
		"color\n",
		"a".repeat(65),
	]) {
		await expect(store.apply(0, [{ ...color, key }], source)).rejects.toThrow();
	}
	await expect(
		store.apply(0, [{ ...color, value: "v".repeat(181) }], source),
	).rejects.toThrow();
	await expect(
		store.apply(
			0,
			[color, { action: "revise", key: color.key, value: "Purple" }],
			source,
		),
	).rejects.toThrow();
	expect(
		await store.apply(
			0,
			[color, { action: "revise", key: "favorite-game", value: "Chess" }],
			source,
		),
	).toEqual({
		status: "conflict",
		state: { revision: 0, preferences: [], receipts: [] },
	});
	expect((await store.apply(0, [color], source)).status).toBe("applied");
});

test("capacity preserves every established preference and allows an intentional revision", async () => {
	const { store } = fixture();
	const atCapacity = Array.from(
		{ length: MAX_CHARACTER_PREFERENCES },
		(_, index) => ({ ...color, key: `topic-${index}` }),
	);
	const initial = await store.apply(0, atCapacity, {
		chatId: 100,
		messageId: 1,
	});
	const revise = { action: "revise", key: "topic-0", value: "Blue" } as const;
	const source = { chatId: 100, messageId: 2 };
	expect(await store.apply(1, [revise, color], source)).toEqual({
		status: "capacity",
		state: initial.state,
	});
	expect(await store.read()).toEqual(initial.state);
	expect(await store.apply(1, [revise], source)).toMatchObject({
		status: "applied",
		state: { revision: 2 },
	});
	expect((await store.read()).preferences).toHaveLength(
		MAX_CHARACTER_PREFERENCES,
	);
});

test("the receipt journal rolls forward with a fixed capacity", async () => {
	const { directory, path, store } = fixture();
	const receipts = Array.from({ length: 256 }, (_, index) => ({
		chatId: 100,
		messageId: index + 1,
	}));
	await mkdir(directory, { recursive: true });
	await writeFile(
		path,
		JSON.stringify({
			schemaVersion: 1,
			data: { revision: 256, preferences: [], receipts },
		}),
	);
	const source = { chatId: 100, messageId: 1000 };
	const result = await store.apply(256, [color], source);
	expect(result.status).toBe("applied");
	expect(result.state.receipts).toEqual([...receipts.slice(1), source]);
	expect(
		(await store.apply(256, [color], { chatId: 100, messageId: 256 })).status,
	).toBe("duplicate");
});

test("damaged and future-version preference files are preserved", async () => {
	const { directory, path, store } = fixture();
	await mkdir(directory, { recursive: true });
	for (const raw of [
		"{broken",
		'{"schemaVersion":2,"data":{"revision":0,"preferences":[],"receipts":[]}}',
	]) {
		await writeFile(path, raw);
		await expect(
			store.apply(0, [color], { chatId: 100, messageId: 1 }),
		).rejects.toBeInstanceOf(StoreReadError);
		expect(await readFile(path, "utf8")).toBe(raw);
	}
});

test("restored snapshots validate the character preference store schema", async () => {
	const { directory, path, store } = fixture();
	await store.apply(0, [color], { chatId: 100, messageId: 1 });
	await runMemoryBackup({ memoryDir: directory, date: "2040-04-01" });
	const goodSnapshot = join(directory, "backups", "2040-04-01");
	expect(await verifyRestoredMemoryBackup(goodSnapshot)).toBe(1);
	await writeFile(path, '{"revision":0,"preferences":[],"receipts":[false]}');
	await runMemoryBackup({ memoryDir: directory, date: "2040-04-02" });
	const invalidSnapshot = join(directory, "backups", "2040-04-02");
	await expect(verifyRestoredMemoryBackup(invalidSnapshot)).rejects.toThrow(
		`Invalid memory store in ${CHARACTER_PREFERENCES_FILE}`,
	);
});
