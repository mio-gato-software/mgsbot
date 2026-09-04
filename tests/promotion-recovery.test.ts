import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { botNow } from "../src/bot-time.ts";
import { getChapterForMonth } from "../src/memory/chapters.ts";
import { loadWorkingMemory } from "../src/memory/episodes.ts";
import {
	defaultPromotionDependencies,
	drainPromotionSpool,
	type PromotionDependencies,
} from "../src/memory/promotion.ts";
import {
	loadPromotionSpool,
	promotionId,
	spoolChunk,
} from "../src/memory/promotion-spool.ts";
import { loadRelationshipMemory } from "../src/memory/relationships.ts";
import {
	loadSemanticStore,
	saveSemanticStore,
} from "../src/memory/semantic.ts";
import {
	addMessageToSensory,
	loadSensory,
	SENSORY_DIR,
	saveSensory,
} from "../src/memory/sensory.ts";
import { memoryPath } from "../src/runtime-paths.ts";
import type { ConversationMessage } from "../src/types.ts";

let chatId = 800001;
let evaluated = 0;
let embedded = 0;
let narrated = 0;
let dependencies: PromotionDependencies;
const stamp = Date.now() - 7 * 86400000;
const messages: ConversationMessage[] = [
	{
		id: "fixture-message",
		role: "user",
		name: "Ana",
		content: "I will move next month",
		timestamp: stamp,
	},
];
beforeEach(async () => {
	chatId++;
	evaluated = 0;
	embedded = 0;
	narrated = 0;
	await saveSemanticStore([]);
	dependencies = {
		...defaultPromotionDependencies,
		evaluate: async () => {
			evaluated++;
			return {
				summary: "A move next month",
				importance: 3,
				facts: [
					{
						category: "person",
						subject: "Ana",
						content: "Ana plans to move next month",
						importance: 3,
					},
				],
				personalitySignals: {
					traitChanges: [{ trait: "warmth", delta: 0.1, reason: "support" }],
				},
			};
		},
		embed: async () => {
			embedded++;
			return [1, 0, 0];
		},
		narrate: async () => {
			narrated++;
			return {
				relationship: {
					summary: "A supportive conversation",
					tone: "warm",
					notableDynamics: [],
					openThreads: [],
				},
				chapter: { title: "A move", summary: "Planning a move", importance: 3 },
			};
		},
	};
});
afterEach(async () => {
	await rm(join(SENSORY_DIR, `${chatId}.json`), { force: true });
});
async function queue() {
	await spoolChunk({ chatId, messages, reason: "overflow" });
}

test("failure before all embeddings finish leaves a durable chunk and no partial episode", async () => {
	await queue();
	const embed = dependencies.embed;
	dependencies.embed = async (text) => {
		if (text.startsWith("Ana")) throw new Error("temporary embedding failure");
		return embed(text);
	};
	await drainPromotionSpool(chatId, dependencies);
	expect((await loadWorkingMemory(chatId)).episodes).toHaveLength(0);
	expect(await loadPromotionSpool(chatId)).toHaveLength(1);
	dependencies.embed = embed;
	await drainPromotionSpool(chatId, dependencies);
	expect((await loadWorkingMemory(chatId)).episodes).toHaveLength(1);
	expect(await loadPromotionSpool(chatId)).toHaveLength(0);
});

test("failure after a fact write replays checkpoints without duplicate episodes, facts, or confirmations", async () => {
	await queue();
	const save = dependencies.saveFacts;
	let fail = true;
	dependencies.saveFacts = async (facts) => {
		await save(facts);
		if (fail) {
			fail = false;
			throw new Error("crash after fact write");
		}
	};
	await drainPromotionSpool(chatId, dependencies);
	const pending = await loadPromotionSpool(chatId);
	expect(pending[0]?.prepared).toBeDefined();
	await drainPromotionSpool(chatId, dependencies);
	expect(evaluated).toBe(1);
	expect(embedded).toBe(2);
	expect(narrated).toBe(1);
	const episodes = (await loadWorkingMemory(chatId)).episodes;
	expect(episodes).toHaveLength(1);
	expect(episodes[0]?.timestamp).toBe(stamp);
	expect(await loadSemanticStore()).toHaveLength(1);
	expect((await loadRelationshipMemory(chatId))?.interactionCount).toBe(1);
	expect(
		(await getChapterForMonth(chatId, botNow(stamp).format("YYYY-MM")))
			?.episodeIds,
	).toHaveLength(1);
});

test("a replay after all effects committed keeps personality and narrative unchanged", async () => {
	await queue();
	const narrate = dependencies.narrate;
	dependencies.narrate = async () => {
		throw new Error("narrative unavailable");
	};
	await drainPromotionSpool(chatId, dependencies);
	const checkpoint = (await loadPromotionSpool(chatId))[0];
	expect(checkpoint?.prepared).toBeDefined();
	dependencies.narrate = narrate;
	await drainPromotionSpool(chatId, dependencies);
	const personalityBefore = await readFile(
		memoryPath("personality.json"),
		"utf8",
	);
	const relationshipBefore = await loadRelationshipMemory(chatId);
	await mkdir(memoryPath("promotion-spool"), { recursive: true });
	await writeFile(
		memoryPath("promotion-spool", `${chatId}.json`),
		JSON.stringify({ schemaVersion: 1, data: [checkpoint] }),
	);
	await drainPromotionSpool(chatId, dependencies);
	expect(await readFile(memoryPath("personality.json"), "utf8")).toBe(
		personalityBefore,
	);
	expect(await loadRelationshipMemory(chatId)).toEqual(relationshipBefore);
	expect((await loadWorkingMemory(chatId)).episodes).toHaveLength(1);
});

test("journaled transfers recover if the process stops before removing sensory messages", async () => {
	const buffer = await loadSensory(chatId);
	buffer.messages = messages;
	await saveSensory(buffer);
	await queue();
	await drainPromotionSpool(chatId, dependencies);
	expect((await loadSensory(chatId)).messages).toHaveLength(0);
	expect((await loadWorkingMemory(chatId)).episodes).toHaveLength(1);
});

test("sensory overflow is durable before its caller starts promotion, including proactive appends", async () => {
	const buffer = await loadSensory(chatId);
	for (let index = 0; index < 11; index++)
		await addMessageToSensory(
			buffer,
			{
				role: index === 10 ? "model" : "user",
				content: `message ${index}`,
				timestamp: Date.now(),
				id: `m-${index}`,
			},
			{ source: "passive", minImportance: 3 },
		);
	const chunks = await loadPromotionSpool(chatId);
	expect(chunks).toHaveLength(1);
	expect(chunks[0]?.source).toBe("passive");
	expect(chunks[0]?.minImportance).toBe(3);
	expect(chunks[0]?.id).toBe(promotionId(chatId, chunks[0]?.messages ?? []));
});

test("exhausted retries retain the original messages for recovery", async () => {
	await queue();
	dependencies.evaluate = async () => {
		throw new Error("provider unavailable");
	};
	for (let i = 0; i < 10; i++) await drainPromotionSpool(chatId, dependencies);
	const chunks = await loadPromotionSpool(chatId);
	expect(chunks).toHaveLength(1);
	expect(chunks[0]?.failed).toBe(true);
	expect(chunks[0]?.messages).toEqual(messages);
});

for (const phase of [
	"episode",
	"relationship",
	"chapter",
	"completion",
] as const) {
	test(`recovery after ${phase} commit does not repeat committed effects`, async () => {
		await queue();
		let fail = true;
		const crash = () => {
			if (fail) {
				fail = false;
				throw new Error(`crash after ${phase}`);
			}
		};
		if (phase === "episode")
			dependencies.saveEpisode = async (...args) => {
				await defaultPromotionDependencies.saveEpisode(...args);
				crash();
			};
		if (phase === "relationship")
			dependencies.saveRelationship = async (...args) => {
				await defaultPromotionDependencies.saveRelationship(...args);
				crash();
			};
		if (phase === "chapter")
			dependencies.saveChapter = async (...args) => {
				await defaultPromotionDependencies.saveChapter(...args);
				crash();
			};
		if (phase === "completion")
			dependencies.complete = async (...args) => {
				crash();
				await defaultPromotionDependencies.complete(...args);
			};
		await drainPromotionSpool(chatId, dependencies);
		expect(await loadPromotionSpool(chatId)).toHaveLength(1);
		await drainPromotionSpool(chatId, dependencies);
		expect(await loadPromotionSpool(chatId)).toHaveLength(0);
		expect((await loadWorkingMemory(chatId)).episodes).toHaveLength(1);
		expect(await loadSemanticStore()).toHaveLength(1);
		expect((await loadRelationshipMemory(chatId))?.interactionCount).toBe(1);
		expect(narrated).toBe(1);
		expect(evaluated).toBe(1);
	});
}

for (const phase of ["relationship", "chapter"] as const) {
	test(`a delayed ${phase} retry preserves narrative from later promotions`, async () => {
		await queue();
		await spoolChunk({
			chatId,
			messages: [
				{
					id: "later-message",
					role: "user",
					name: "Ana",
					timestamp: stamp,
					content: "A new job",
				},
			],
			reason: "overflow",
		});
		const evaluate = dependencies.evaluate;
		dependencies.evaluate = async (...args) => ({
			...(await evaluate(...args)),
			summary: args[0],
		});
		dependencies.narrate = async ({
			existingRelationship,
			existingChapter,
			episode,
		}) => ({
			relationship: {
				summary: `${existingRelationship?.summary ?? ""} | ${episode.summary}`,
				tone: "warm",
				notableDynamics: [],
				openThreads: [],
			},
			chapter: {
				title: "Events",
				importance: 3,
				summary: `${existingChapter?.summary ?? ""} | ${episode.summary}`,
			},
		});
		let fail = true;
		const failOnce = () => {
			if (fail) {
				fail = false;
				throw new Error("temporary narrative write failure");
			}
		};
		if (phase === "relationship")
			dependencies.saveRelationship = async (...args) => {
				failOnce();
				await defaultPromotionDependencies.saveRelationship(...args);
			};
		else
			dependencies.saveChapter = async (...args) => {
				failOnce();
				await defaultPromotionDependencies.saveChapter(...args);
			};
		await drainPromotionSpool(chatId, dependencies);
		expect(await loadPromotionSpool(chatId)).toHaveLength(1);
		await drainPromotionSpool(chatId, dependencies);
		const relationship = await loadRelationshipMemory(chatId);
		const chapter = await getChapterForMonth(
			chatId,
			botNow(stamp).format("YYYY-MM"),
		);
		for (const summary of [relationship?.summary, chapter?.summary]) {
			expect(summary).toContain("I will move next month");
			expect(summary).toContain("A new job");
		}
		expect(relationship?.interactionCount).toBe(2);
		expect(chapter?.episodeIds).toHaveLength(2);
		expect(await loadPromotionSpool(chatId)).toHaveLength(0);
	});
}

test("a failed journal write does not remove the original sensory messages", async () => {
	const buffer = await loadSensory(chatId);
	for (let i = 0; i < 10; i++)
		await addMessageToSensory(buffer, {
			role: "user",
			content: String(i),
			timestamp: Date.now(),
		});
	await mkdir(memoryPath("promotion-spool"), { recursive: true });
	const path = memoryPath("promotion-spool", `${chatId}.json`);
	await writeFile(path, "{damaged");
	await expect(
		addMessageToSensory(buffer, {
			role: "user",
			content: "new",
			timestamp: Date.now(),
		}),
	).rejects.toThrow();
	expect((await loadSensory(chatId)).messages).toHaveLength(10);
	expect(await readFile(path, "utf8")).toBe("{damaged");
	await rm(path);
});
