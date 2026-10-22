import { afterEach, beforeEach, expect, test } from "bun:test";
import { registerIdentity } from "../src/identities.ts";
import {
	loadSemanticStore,
	saveSemanticStore,
} from "../src/memory/semantic.ts";
import { retrieveMemoryContext } from "../src/prompt/retrieval.ts";
import type { SemanticFact } from "../src/types.ts";

let saved: SemanticFact[];
const dm = 889902;
const group = -100889902;
beforeEach(async () => {
	saved = await loadSemanticStore();
});
afterEach(async () => {
	await saveSemanticStore(saved);
});
test("the complete retrieval merge enforces chat scope while retaining shared person facts and aliases", async () => {
	await registerIdentity(dm, "Alex Original");
	await registerIdentity(dm, "Alex Current");
	const base = {
		category: "person" as const,
		subject: "Alex Original",
		embedding: [1, 0],
		importance: 5,
		confidence: 1,
		createdAt: Date.now(),
		lastConfirmed: Date.now(),
		sourceChatId: dm,
	};
	await saveSemanticStore([
		{ ...base, id: "private", content: "Private plan", scope: "chat" },
		{ ...base, id: "shared", content: "Shared interest", scope: "person" },
		{
			...base,
			id: "permanent-private",
			content: "Private permanent fact",
			scope: "chat",
			permanent: true,
		},
	]);
	const deps = {
		queryEmbedding: async () => ({ embedding: [1, 0], text: "Alex Current" }),
	};
	const messages = [
		{
			role: "user" as const,
			name: "Alex Current",
			content: "hello",
			timestamp: Date.now(),
		},
	];
	const groupContext = await retrieveMemoryContext(
		{ chatId: group, messages },
		deps,
	);
	expect(groupContext.relevantFacts.map((f) => f.id)).toEqual(["shared"]);
	expect(groupContext.permanentFacts).toHaveLength(0);
	const dmContext = await retrieveMemoryContext({ chatId: dm, messages }, deps);
	expect(dmContext.relevantFacts.map((f) => f.id).sort()).toEqual([
		"private",
		"shared",
	]);
	expect(dmContext.permanentFacts.map((f) => f.id)).toEqual([
		"permanent-private",
	]);
});
