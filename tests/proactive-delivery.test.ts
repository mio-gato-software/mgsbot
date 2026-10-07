import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, unlink } from "node:fs/promises";
import type { Api } from "grammy";
import { getWeekStart } from "../src/bot-time.ts";
import { checkAndSendCheckIns } from "../src/check-ins.ts";
import {
	checkAndCancelResolvedFollowUps,
	checkAndSendFollowUps,
	loadFollowUps,
	saveFollowUps,
} from "../src/follow-ups.ts";
import { loadSensory } from "../src/memory/sensory.ts";
import { memoryPath } from "../src/runtime-paths.ts";
import type { FollowUp } from "../src/types.ts";
import { atomicWriteFile } from "../src/utils.ts";

const chatId = 889901;
const now = Date.now();
const sourceAt = now - 86_400_000;
const envKeys = [
	"ENABLE_FOLLOW_UPS",
	"ENABLE_CHECK_INS",
	"OWNER_USER_ID",
] as const;
let env: Array<string | undefined>;
let previousFollowUps: FollowUp[];
let previousCheckIns: string | undefined;
const services = {
	generate: async () => "How was your appointment?",
	pulse: async () => {},
};
function followUp(overrides: Partial<FollowUp> = {}): FollowUp {
	return {
		id: "due",
		chatId,
		event: "dentist appointment",
		followUpQuestion: "How was it?",
		detectedAt: sourceAt + 1000,
		sourceMessageAt: sourceAt,
		scheduledFor: now - 60_000,
		attempts: 0,
		status: "pending",
		...overrides,
	};
}
async function history(
	messages: Array<{
		role: "user" | "model";
		content: string;
		timestamp: number;
	}>,
) {
	await atomicWriteFile(
		memoryPath(`sensory/${chatId}.json`),
		JSON.stringify({
			chatId,
			messages,
			lastActivity: now - 3_600_000,
			messageCountSincePromotion: messages.length,
		}),
	);
}
function apiWithFailure(error?: Error) {
	const calls: Array<unknown> = [];
	const api = {
		sendMessage: async (_chat: number, _text: string, options: unknown) => {
			calls.push(options);
			if (error && calls.length === 1) throw error;
			return { message_id: calls.length };
		},
	} as unknown as Api;
	return { api, calls };
}
beforeEach(async () => {
	env = envKeys.map((key) => process.env[key]);
	process.env.ENABLE_FOLLOW_UPS = "true";
	process.env.ENABLE_CHECK_INS = "true";
	process.env.OWNER_USER_ID = String(chatId);
	previousFollowUps = await loadFollowUps();
	previousCheckIns = await readFile(memoryPath("check-ins.json"), "utf8").catch(
		() => undefined,
	);
	await saveFollowUps([]);
	await history([]);
});
afterEach(async () => {
	for (const [i, key] of envKeys.entries()) {
		if (env[i] === undefined) delete process.env[key];
		else process.env[key] = env[i];
	}
	await saveFollowUps(previousFollowUps);
	if (previousCheckIns !== undefined)
		await atomicWriteFile(memoryPath("check-ins.json"), previousCheckIns);
	else await unlink(memoryPath("check-ins.json")).catch(() => {});
	await unlink(memoryPath(`sensory/${chatId}.json`)).catch(() => {});
});
test("the original plan and bot replies do not cancel a due follow-up", async () => {
	await saveFollowUps([followUp()]);
	await history([
		{
			role: "user",
			content: "Tomorrow I have a dentist appointment",
			timestamp: sourceAt,
		},
		{
			role: "model",
			content: "Tell me about your dentist appointment afterward",
			timestamp: sourceAt + 2000,
		},
	]);
	const { api, calls } = apiWithFailure();
	await checkAndSendFollowUps(
		api,
		() => false,
		() => false,
		services,
	);
	expect(calls).toHaveLength(1);
	expect((await loadFollowUps())[0]?.status).toBe("sent");
	expect((await loadSensory(chatId)).messages.at(-1)?.content).toBe(
		"How was your appointment?",
	);
});
test("a later user update cancels the follow-up without sending", async () => {
	await saveFollowUps([followUp()]);
	await history([
		{
			role: "user",
			content: "My dentist appointment went well",
			timestamp: sourceAt + 60_000,
		},
	]);
	const { api, calls } = apiWithFailure();
	await checkAndSendFollowUps(
		api,
		() => false,
		() => false,
		services,
	);
	expect(calls).toHaveLength(0);
	expect((await loadFollowUps())[0]?.status).toBe("cancelled");
});
test("legacy follow-ups use detection time to exclude original evidence", async () => {
	await saveFollowUps([followUp({ sourceMessageAt: undefined })]);
	await history([
		{ role: "user", content: "dentist appointment", timestamp: sourceAt },
	]);
	const { api, calls } = apiWithFailure();
	await checkAndSendFollowUps(
		api,
		() => false,
		() => false,
		services,
	);
	expect(calls).toHaveLength(1);
});
test("cancellation cannot race with extraction and resolve the source turn", async () => {
	await saveFollowUps([followUp()]);
	await checkAndCancelResolvedFollowUps(
		chatId,
		"dentist appointment",
		sourceAt,
	);
	expect((await loadFollowUps())[0]?.status).toBe("pending");
	await checkAndCancelResolvedFollowUps(
		chatId,
		"dentist appointment went well",
		sourceAt + 60_000,
	);
	expect((await loadFollowUps())[0]?.status).toBe("cancelled");
});
for (const kind of ["follow-up", "check-in"] as const) {
	for (const [label, error, expectedCalls] of [
		[
			"formatting",
			Object.assign(new Error("Bad Request: can't parse entities"), {
				error_code: 400,
			}),
			2,
		],
		[
			"rate limit",
			Object.assign(new Error("Too Many Requests"), { error_code: 429 }),
			1,
		],
		[
			"lost acknowledgement",
			new Error("Connection reset after server accepted message"),
			1,
		],
	] as const) {
		test(`${kind} only falls back for formatting errors: ${label}`, async () => {
			const { api, calls } = apiWithFailure(error);
			if (kind === "follow-up") {
				await saveFollowUps([followUp()]);
				await checkAndSendFollowUps(
					api,
					() => false,
					() => false,
					services,
				);
				expect((await loadFollowUps())[0]?.status).toBe(
					expectedCalls === 2
						? "sent"
						: label === "lost acknowledgement"
							? "expired"
							: "pending",
				);
				if (label === "lost acknowledgement") {
					expect(
						(await loadFollowUps())[0]?.deliveryUnconfirmedAt,
					).toBeGreaterThan(0);
					await checkAndSendFollowUps(
						api,
						() => false,
						() => false,
						services,
					);
				}
			} else {
				await atomicWriteFile(
					memoryPath("check-ins.json"),
					JSON.stringify([
						{
							chatId,
							weekStart: getWeekStart(),
							slots: [{ scheduledFor: now - 60_000, status: "pending" }],
							lastSentTimestamp: 0,
							recentStrategies: [],
						},
					]),
				);
				await checkAndSendCheckIns(
					api,
					() => false,
					() => false,
					services,
				);
				const saved = JSON.parse(
					await readFile(memoryPath("check-ins.json"), "utf8"),
				);
				expect(saved.data[0].slots[0].status).toBe(
					expectedCalls === 2 ? "sent" : "skipped",
				);
				if (label === "lost acknowledgement")
					await checkAndSendCheckIns(
						api,
						() => false,
						() => false,
						services,
					);
			}
			expect(calls).toHaveLength(expectedCalls);
			expect(calls[0]).toEqual({ parse_mode: "Markdown" });
			if (expectedCalls === 2) expect(calls[1]).toEqual({});
			expect((await loadSensory(chatId)).messages).toHaveLength(
				expectedCalls === 2 ? 1 : 0,
			);
		});
	}
}
