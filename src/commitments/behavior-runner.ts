import { createHash } from "node:crypto";
import dayjs from "dayjs";
import type { Api } from "grammy";
import { alertOwner } from "../alerts.ts";
import { isBotOff, isSleepingHour } from "../bot-state.ts";
import { logBotMessage } from "../chat-logger.ts";
import { log } from "../logger.ts";
import { withChatLock } from "../memory/locks.ts";
import { addMessageToSensory, loadSensory } from "../memory/sensory.ts";
import { evaluateBehavior, renderBehavior } from "./behavior-evaluation.ts";
import { deliverScheduledMessage, type ScheduledMessage } from "./delivery.ts";
import { allowedCommitmentChat, commitmentsEnabled } from "./requests.ts";
import type { ConditionalBehavior, ScheduledTask } from "./schema.ts";
import { type CommitmentStore, commitments } from "./store.ts";

export interface BehaviorObservation {
	evidence: string[];
	persona: string;
	checkedAt: number;
}
export interface BehaviorServices {
	store: CommitmentStore;
	now: () => number;
	evaluate: typeof evaluateBehavior;
	render: typeof renderBehavior;
	deliver: (chatId: number, message: ScheduledMessage) => Promise<unknown>;
	record: (task: ScheduledTask, text: string) => Promise<void>;
	alert: (text: string) => Promise<void>;
	isOff: () => boolean;
	isSleeping: () => boolean;
	isAllowed: (chatId: number) => boolean;
}
const PREPARATION_LEASE_MS = 10 * 60000;
const day = (timestamp: number, task: ScheduledTask) =>
	dayjs.utc(timestamp).tz(task.timezone).format("YYYY-MM-DD");

function eligible(
	current: ScheduledTask | undefined,
	original: ScheduledTask,
	behavior: ConditionalBehavior,
	services: BehaviorServices,
): current is ScheduledTask {
	return (
		!!current &&
		current.status === "active" &&
		current.expiresAt > services.now() &&
		current.chatId === original.chatId &&
		current.instruction === original.instruction &&
		JSON.stringify(current.behaviors?.find((b) => b.id === behavior.id)) ===
			JSON.stringify(behavior) &&
		!services.isOff() &&
		!services.isSleeping() &&
		services.isAllowed(current.chatId)
	);
}

/** Each behavior effect has a durable claim and send intent, independently of
 * the parent report. Generation failures can retry within limits; uncertain
 * Telegram outcomes can never retry automatically. */
export async function runTaskBehaviors(
	task: ScheduledTask,
	observation: BehaviorObservation,
	services: BehaviorServices,
): Promise<void> {
	if (task.kind !== "research" || !task.behaviors?.length) return;
	const now = services.now();
	if (
		observation.checkedAt > now + 1000 ||
		now - observation.checkedAt > 60 * 60000
	)
		return;
	for (const behavior of task.behaviors) {
		try {
			const current = (await services.store.read()).tasks.find(
				(t) => t.id === task.id,
			);
			if (!eligible(current, task, behavior, services)) continue;
			const previous = (current.behaviorEvents ?? []).filter(
				(e) => e.behaviorId === behavior.id,
			);
			const result = await services.evaluate(
				behavior,
				observation.evidence,
				previous,
				day(services.now(), task),
			);
			if (result.outcome !== "matched") {
				log.info(`[behaviors] ${behavior.id}: ${result.outcome}`);
				continue;
			}
			for (const event of result.events) {
				const claimedAt = await services.store.transaction((state) => {
					const current = state.tasks.find((t) => t.id === task.id);
					if (!eligible(current, task, behavior, services)) return;
					const now = services.now();
					const today = day(now, task);
					const oldest = dayjs
						.utc(now)
						.tz(task.timezone)
						.subtract(behavior.maxEventAgeDays, "day")
						.format("YYYY-MM-DD");
					if (
						event.date > today ||
						event.date < oldest ||
						event.date < day(behavior.createdAt, task)
					)
						return;
					current.behaviorEvents = (current.behaviorEvents ?? []).filter(
						(e) => e.updatedAt > now - 35 * 86400000,
					);
					const existing = current.behaviorEvents.find(
						(e) => e.behaviorId === behavior.id && e.eventKey === event.key,
					);
					// A behavior prepares one creative output at a time, allowing the
					// next event to see the first event's saved creative history.
					if (
						current.behaviorEvents.some(
							(e) =>
								e.behaviorId === behavior.id &&
								e.eventKey !== event.key &&
								e.status === "preparing" &&
								now - e.updatedAt < PREPARATION_LEASE_MS,
						)
					)
						return;
					if (existing?.status === "sending") {
						existing.status = "unknown";
						return;
					}
					if (
						existing &&
						(["sent", "unknown"].includes(existing.status) ||
							(existing.status === "preparing" &&
								now - existing.updatedAt < PREPARATION_LEASE_MS))
					)
						return;
					const attemptsToday = current.behaviorEvents
						.filter((e) => e.behaviorId === behavior.id)
						.flatMap((e) => e.attempts)
						.filter((at) => day(at, task) === today).length;
					if (
						attemptsToday >= behavior.maxPerDay ||
						(existing?.attempts.length ?? 0) >= 3
					)
						return;
					if (!existing && current.behaviorEvents.length >= 500) return;
					if (existing) {
						existing.status = "preparing";
						existing.updatedAt = now;
						existing.attempts.push(now);
					} else
						current.behaviorEvents.push({
							behaviorId: behavior.id,
							eventKey: event.key,
							summary: event.summary,
							date: event.date,
							status: "preparing",
							attempts: [now],
							updatedAt: now,
						});
					return now;
				});
				if (claimedAt === undefined) continue;
				let attempted = false;
				try {
					const creativeHistory =
						(await services.store.read()).tasks.find((t) => t.id === task.id)
							?.behaviorEvents ?? [];
					const message = await services.render(
						behavior,
						event,
						observation.persona,
						creativeHistory
							.filter(
								(e) =>
									e.behaviorId === behavior.id &&
									["sent", "sending", "unknown"].includes(e.status),
							)
							.map((e) => ({
								text: e.lastCaption ?? "",
								concept: e.creativeConcept,
								scene: e.creativeScene,
								imageDigest: e.imageDigest,
							})),
					);
					if (
						!message.text.trim() ||
						message.text.length > 1000 ||
						(behavior.output === "image" && !message.image?.length)
					)
						throw new Error("Invalid conditional output");
					const sent = await services.store.transaction(async (state) => {
						const current = state.tasks.find((t) => t.id === task.id);
						const receipt = current?.behaviorEvents?.find(
							(e) => e.behaviorId === behavior.id && e.eventKey === event.key,
						);
						if (
							receipt?.status !== "preparing" ||
							receipt.updatedAt !== claimedAt
						)
							return false;
						if (
							!eligible(current, task, behavior, services) ||
							services.now() - observation.checkedAt > 60 * 60000
						) {
							receipt.status = "failed";
							return false;
						}
						receipt.status = "sending";
						receipt.lastCaption = message.text;
						receipt.creativeConcept = message.creativeConcept;
						receipt.creativeScene = message.creativeScene;
						receipt.imageDigest = message.image
							? createHash("sha256").update(message.image).digest("hex")
							: undefined;
						await services.store.persist(state);
						attempted = true;
						await services.deliver(task.chatId, message);
						receipt.status = "sent";
						receipt.lastCaption = message.text;
						receipt.updatedAt = services.now();
						return true;
					});
					if (sent)
						await services
							.record(task, message.text)
							.catch(() =>
								log.warn("[behaviors] History recording failed after delivery"),
							);
				} catch {
					await services.store.transaction((state) => {
						const receipt = state.tasks
							.find((t) => t.id === task.id)
							?.behaviorEvents?.find(
								(e) => e.behaviorId === behavior.id && e.eventKey === event.key,
							);
						if (receipt && receipt.updatedAt === claimedAt) {
							receipt.status = attempted ? "unknown" : "failed";
							receipt.updatedAt = services.now();
						}
					});
					await services
						.alert(
							`Conditional behavior ${behavior.id}: ${attempted ? "delivery uncertain; not retried" : "generation failed; report delivery unaffected"}.`,
						)
						.catch(() => {});
				}
			}
		} catch {
			await services
				.alert(
					`Conditional behavior ${behavior.id}: evaluation or persistence failed; no new action confirmed.`,
				)
				.catch(() => {});
		}
	}
}

export async function checkAndSendTaskBehaviors(
	api: Api,
	task: ScheduledTask,
	observation: BehaviorObservation,
	guards = { isOff: isBotOff, isSleeping: isSleepingHour },
): Promise<void> {
	if (!commitmentsEnabled()) return;
	await runTaskBehaviors(task, observation, {
		store: commitments,
		now: Date.now,
		evaluate: evaluateBehavior,
		render: renderBehavior,
		...guards,
		isAllowed: allowedCommitmentChat,
		deliver: (chatId, message) => deliverScheduledMessage(api, chatId, message),
		alert: (text) => alertOwner("conditional-behaviors", text),
		record: async (task, text) => {
			await withChatLock(task.chatId, async () => {
				const buffer = await loadSensory(task.chatId);
				await addMessageToSensory(buffer, {
					role: "model",
					content: text,
					timestamp: Date.now(),
				});
			});
			await logBotMessage(text);
		},
	});
}
