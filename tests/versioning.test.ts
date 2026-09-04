import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, utimes, writeFile } from "node:fs/promises";
import {
	FOLLOW_UPS_PATH,
	loadFollowUps,
	saveFollowUps,
} from "../src/follow-ups.ts";
import {
	loadSemanticStore,
	SEMANTIC_PATH,
	saveSemanticStore,
} from "../src/memory/semantic.ts";
import {
	loadSensory,
	SENSORY_DIR,
	saveSensory,
} from "../src/memory/sensory.ts";
import {
	CURRENT_SCHEMA_VERSION,
	unwrapVersioned,
	wrapVersioned,
} from "../src/memory/versioning.ts";
import { MEMORY_DIR } from "../src/runtime-paths.ts";
import type { FollowUp, SemanticFact, SensoryBuffer } from "../src/types.ts";

// Distinct fixture ID within the disposable test memory root.
const TEST_CHAT_ID = 999_999_902;

// These singleton fixtures live under the disposable root installed by preload.
// Restore them between suites to avoid leaking test state.
const originals = new Map<string, string | null>();

async function snapshot(path: string): Promise<void> {
	originals.set(path, existsSync(path) ? await readFile(path, "utf-8") : null);
}

async function restore(path: string): Promise<void> {
	const original = originals.get(path);
	if (original == null) {
		if (existsSync(path)) await unlink(path);
	} else {
		await writeFile(path, original);
	}
}

function makeFollowUp(overrides: Partial<FollowUp> = {}): FollowUp {
	return {
		id: "fu_test_1",
		chatId: TEST_CHAT_ID,
		event: "ir al cine a las 8pm",
		followUpQuestion: "¿Qué tal la película?",
		detectedAt: 1_000,
		scheduledFor: 2_000,
		status: "pending",
		attempts: 0,
		...overrides,
	};
}

function makeFact(overrides: Partial<SemanticFact> = {}): SemanticFact {
	return {
		id: "fact_test_1",
		content: "Test fact for versioning",
		category: "event",
		embedding: [0.1, 0.2, 0.3],
		importance: 3,
		confidence: 0.9,
		createdAt: 1_000,
		lastConfirmed: 1_000,
		...overrides,
	};
}

beforeAll(async () => {
	await mkdir(MEMORY_DIR, { recursive: true });
	await mkdir(SENSORY_DIR, { recursive: true });
	await snapshot(FOLLOW_UPS_PATH);
	await snapshot(SEMANTIC_PATH);
});

afterAll(async () => {
	await restore(FOLLOW_UPS_PATH);
	await restore(SEMANTIC_PATH);
	const sensoryPath = `${SENSORY_DIR}/${TEST_CHAT_ID}.json`;
	if (existsSync(sensoryPath)) await unlink(sensoryPath);
});

describe("versioning helpers", () => {
	test("wrapVersioned stamps the current schema version", () => {
		expect(wrapVersioned([1, 2])).toEqual({
			schemaVersion: CURRENT_SCHEMA_VERSION,
			data: [1, 2],
		});
	});

	test("unwrapVersioned returns data from a wrapped value", () => {
		expect(unwrapVersioned<number[]>(wrapVersioned([1, 2]))).toEqual([1, 2]);
	});

	test("unwrapVersioned passes legacy bare arrays through", () => {
		expect(unwrapVersioned<number[]>([1, 2])).toEqual([1, 2]);
	});

	test("unwrapVersioned passes legacy objects without schemaVersion through", () => {
		const legacy = { chatId: 1, episodes: [] };
		expect(unwrapVersioned<typeof legacy>(legacy)).toEqual(legacy);
	});
});

describe("follow-ups store versioning", () => {
	test("loads a legacy bare-array file", async () => {
		const followUp = makeFollowUp();
		await writeFile(FOLLOW_UPS_PATH, JSON.stringify([followUp], null, 2));
		expect(await loadFollowUps()).toEqual([followUp]);
	});

	test("loads a wrapped file", async () => {
		const followUp = makeFollowUp({ id: "fu_test_2" });
		await writeFile(
			FOLLOW_UPS_PATH,
			JSON.stringify(wrapVersioned([followUp]), null, 2),
		);
		expect(await loadFollowUps()).toEqual([followUp]);
	});

	test("save-then-load round-trip writes the wrapped shape", async () => {
		const followUp = makeFollowUp({ id: "fu_test_3" });
		await saveFollowUps([followUp]);

		const raw = JSON.parse(await readFile(FOLLOW_UPS_PATH, "utf-8"));
		expect(raw.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(Array.isArray(raw.data)).toBe(true);
		expect(await loadFollowUps()).toEqual([followUp]);
	});
});

describe("semantic store versioning", () => {
	// loadSemanticStore caches by mtime; give each write a distinct mtime so
	// back-to-back test writes are not served from the cache.
	let fakeMtime = Date.now() + 10_000;
	async function writeSemanticFile(content: string): Promise<void> {
		await writeFile(SEMANTIC_PATH, content);
		fakeMtime += 1_000;
		await utimes(SEMANTIC_PATH, fakeMtime / 1000, fakeMtime / 1000);
	}

	test("loads a legacy bare-array file", async () => {
		const fact = makeFact();
		await writeSemanticFile(JSON.stringify([fact], null, 2));
		const store = await loadSemanticStore();
		expect(store).toHaveLength(1);
		expect(store[0]?.id).toBe(fact.id);
		expect(store[0]?.content).toBe(fact.content);
	});

	test("loads a wrapped file", async () => {
		const fact = makeFact({ id: "fact_test_2" });
		await writeSemanticFile(JSON.stringify(wrapVersioned([fact]), null, 2));
		const store = await loadSemanticStore();
		expect(store).toHaveLength(1);
		expect(store[0]?.id).toBe(fact.id);
	});

	test("save-then-load round-trip writes the wrapped shape", async () => {
		const fact = makeFact({ id: "fact_test_3" });
		await saveSemanticStore([fact]);

		const raw = JSON.parse(await readFile(SEMANTIC_PATH, "utf-8"));
		expect(raw.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(Array.isArray(raw.data)).toBe(true);

		const store = await loadSemanticStore();
		expect(store).toHaveLength(1);
		expect(store[0]?.id).toBe(fact.id);
	});
});

describe("sensory store versioning", () => {
	function makeBuffer(): SensoryBuffer {
		return {
			chatId: TEST_CHAT_ID,
			messages: [
				{
					role: "user",
					name: "tester",
					content: "hola",
					timestamp: Date.now(),
				},
			],
			lastActivity: Date.now(),
			messageCountSincePromotion: 1,
		};
	}

	test("loads a legacy file without schemaVersion", async () => {
		await writeFile(
			`${SENSORY_DIR}/${TEST_CHAT_ID}.json`,
			JSON.stringify(makeBuffer(), null, 2),
		);
		const loaded = await loadSensory(TEST_CHAT_ID);
		expect(loaded.chatId).toBe(TEST_CHAT_ID);
		expect(loaded.messages).toHaveLength(1);
		expect(loaded.schemaVersion).toBeUndefined();
	});

	test("save-then-load round-trip stamps schemaVersion on the object", async () => {
		await saveSensory(makeBuffer());

		const raw = JSON.parse(
			await readFile(`${SENSORY_DIR}/${TEST_CHAT_ID}.json`, "utf-8"),
		);
		expect(raw.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

		const loaded = await loadSensory(TEST_CHAT_ID);
		expect(loaded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(loaded.messages).toHaveLength(1);
		expect(loaded.messages[0]?.content).toBe("hola");
	});
});
