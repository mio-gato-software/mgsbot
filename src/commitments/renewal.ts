import type { Bot } from "grammy";
import {
	displayTime,
	nextOccurrence,
	renewalDeadline,
	renewalReminderAt,
} from "./calendar.ts";
import { allowedCommitmentChat, commitmentsEnabled } from "./requests.ts";
import type { ScheduledTask } from "./schema.ts";
import {
	type CommitmentStore,
	commitments,
	sharedTaskManagement,
} from "./store.ts";

export function renewalButtons(task: ScheduledTask) {
	const data = (choice: string) =>
		`rn:${task.id}:${task.expiresAt.toString(36)}:${choice}`;
	return {
		inline_keyboard: [
			[
				{ text: "7 días", callback_data: data("7") },
				{ text: "14 días", callback_data: data("14") },
				{ text: "Un mes", callback_data: data("month") },
			],
			[{ text: "Dejar vencer", callback_data: data("no") }],
		],
	};
}

export interface RenewalServices {
	store: CommitmentStore;
	now: () => number;
	isOff: () => boolean;
	isSleeping: () => boolean;
	isAllowed: (chatId: number) => boolean;
	deliver: (task: ScheduledTask, text: string) => Promise<unknown>;
	record: (task: ScheduledTask, text: string) => Promise<void>;
	alert: (text: string) => Promise<void>;
}

/** Save send intent under the mutation lock; ambiguous sends are never replayed. */
export async function runRenewalNotices(
	services: RenewalServices,
): Promise<void> {
	const tasks = (await services.store.read()).tasks;
	for (const candidate of tasks) {
		let sent: { task: ScheduledTask; text: string } | undefined;
		let failed = false;
		await services.store.transaction(async (state) => {
			const task = state.tasks.find((t) => t.id === candidate.id);
			const now = services.now();
			if (
				task?.status !== "active" ||
				task.schedule.frequency === "once" ||
				!task.renewalReminderDays ||
				task.expiresAt <= now ||
				task.renewalNotice?.forExpiresAt === task.expiresAt ||
				services.isOff() ||
				services.isSleeping() ||
				!services.isAllowed(task.chatId)
			)
				return;
			const due = renewalReminderAt(
				task.expiresAt,
				task.renewalReminderDays,
				task.schedule.time,
				task.timezone,
			);
			if (now < due || due <= (task.renewalTermStartedAt ?? task.createdAt))
				return;
			const text = `La tarea «${task.instruction.slice(0, 180)}» vence el ${displayTime(task.expiresAt, task.timezone)}. ¿Quieren renovarla? Pueden elegir abajo o pedirme renovar esta tarea por otro número de días, hasta un mes calendario desde la confirmación. Sin confirmación, vencerá en la fecha indicada.`;
			task.renewalNotice = {
				forExpiresAt: task.expiresAt,
				at: now,
				status: "sending",
			};
			await services.store.persist(state);
			try {
				await services.deliver(task, text);
				task.renewalNotice.status = "sent";
				sent = { task: structuredClone(task), text };
			} catch {
				task.renewalNotice.status = "unknown";
				failed = true;
			}
		});
		if (failed)
			await services
				.alert(
					`Renewal notice for task ${candidate.id}: delivery uncertain; not retried.`,
				)
				.catch(() => {});
		if (sent) await services.record(sent.task, sent.text).catch(() => {});
	}
}

export async function answerRenewal(
	store: CommitmentStore,
	chatId: number,
	userId: number,
	data: string,
	now = Date.now(),
): Promise<string> {
	const match = /^rn:([^:]+):([a-z0-9]+):(7|14|month|no)$/.exec(data);
	if (!match) throw new Error("Opción inválida.");
	const [, id, term, choice] = match;
	return store.transaction((state) => {
		const task = state.tasks.find((t) => t.id === id && t.chatId === chatId);
		if (
			!task ||
			!allowedCommitmentChat(chatId) ||
			(task.creatorId !== userId &&
				userId !== Number(process.env.OWNER_USER_ID) &&
				!sharedTaskManagement(chatId))
		)
			throw new Error("No tienes permiso para gestionar esta tarea.");
		const notice = task.renewalNotice;
		if (
			task.status !== "active" ||
			task.expiresAt <= now ||
			task.expiresAt.toString(36) !== term ||
			!task.renewalReminderDays ||
			!notice ||
			notice.forExpiresAt !== task.expiresAt ||
			!["sent", "sending", "unknown"].includes(notice.status)
		)
			throw new Error(
				"Este aviso ya no está pendiente. Si deseas renovar, pide una nueva renovación.",
			);
		if (choice === "no") {
			notice.status = "declined";
			task.updatedAt = now;
			return `De acuerdo. La tarea vencerá el ${displayTime(task.expiresAt, task.timezone)}; no la renovaré automáticamente.`;
		}
		const expiresAt = renewalDeadline(
			now,
			task.timezone,
			choice === "month" ? undefined : Number(choice),
		);
		const schedule = { ...task.schedule, endDate: undefined };
		const nextRunAt = nextOccurrence(schedule, now, expiresAt, task.timezone);
		if (!nextRunAt)
			throw new Error(
				"No hay ejecuciones dentro de ese plazo; elige más días.",
			);
		task.schedule = schedule;
		task.expiresAt = expiresAt;
		task.renewalTermStartedAt = now;
		task.nextRunAt = nextRunAt;
		task.renewalNotice = undefined;
		task.updatedAt = now;
		return `Renovada hasta el ${displayTime(expiresAt, task.timezone)}. Mantengo el horario y volveré a preguntar ${task.renewalReminderDays} días antes de vencer.`;
	});
}

export function registerRenewalCallbacks(
	bot: Bot,
	store = commitments,
	now = Date.now,
): void {
	bot.callbackQuery(/^rn:/, async (ctx) => {
		if (!commitmentsEnabled() || !ctx.chat) {
			await ctx.answerCallbackQuery({
				text: "La agenda no está disponible.",
				show_alert: true,
			});
			return;
		}
		let message: string;
		try {
			message = await answerRenewal(
				store,
				ctx.chat.id,
				ctx.from.id,
				ctx.callbackQuery.data,
				now(),
			);
		} catch (error) {
			await ctx.answerCallbackQuery({
				text:
					error instanceof Error
						? error.message.slice(0, 190)
						: "No pude guardar el cambio.",
				show_alert: true,
			});
			return;
		}
		await ctx
			.answerCallbackQuery({ text: "Respuesta guardada." })
			.catch(() => {});
		await ctx
			.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
			.catch(() => {});
		await ctx.reply(message);
	});
}
