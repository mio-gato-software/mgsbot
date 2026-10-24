import { randomUUID } from "node:crypto";
import { BOT_TZ } from "../bot-time.ts";
import { withCommitmentsLock } from "../memory/locks.ts";
import { readStore, writeStore } from "../memory/storage.ts";
import { memoryPath } from "../runtime-paths.ts";
import {
	displayTime,
	extensionDeadline,
	nextOccurrence,
	renewalDeadline,
	scheduleDeadline,
} from "./calendar.ts";
import {
	type CommitmentState,
	type Interpretation,
	interpretationSchema,
	type StandingPreference,
	stateSchema,
} from "./schema.ts";

export interface RequestIdentity {
	chatId: number;
	userId: number;
	userName: string;
	messageId: number;
	text: string;
	voice?: boolean;
	/** Bounded same-chat reference context, never authorization or evidence. */
	recentConversation?: Array<{
		role: string;
		name?: string;
		userId?: number;
		text: string;
	}>;
	/** Written clarification, required after a dictated/uncertain source. */
	domainEvidenceText?: string;
}
export function sharedTaskManagement(chatId: number): boolean {
	return (
		process.env.ALLOW_GROUP_TASK_EDITS === "true" &&
		chatId === Number(process.env.ALLOWED_GROUP_ID)
	);
}

export function containsDomain(text: string, domain: string): boolean {
	return new RegExp(
		`(?:^|[^a-z0-9.-])(?:www\\.)?${domain.replaceAll(".", "\\.")}(?=$|[^a-z0-9.-]|\\.(?:\\s|$))`,
		"i",
	).test(text);
}
export function normalizeDomain(raw: string): string {
	const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
	const domain = url.hostname.toLowerCase().replace(/^www\./, "");
	if (
		url.username ||
		url.password ||
		url.port ||
		!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ||
		/\.(local|internal|localhost)$/.test(domain)
	)
		throw new Error("Escribe un dominio público válido.");
	return domain;
}
export function normalizedText(value: string): string {
	return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
export function matchingPreferences(
	preferences: StandingPreference[],
	query: string,
): StandingPreference[] {
	const haystack = ` ${normalizedText(query).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
	return preferences.filter(
		(p) =>
			p.status === "active" &&
			p.topics.some((topic) => {
				const needle = normalizedText(topic)
					.replace(/[^\p{L}\p{N}]+/gu, " ")
					.trim();
				return needle === "general" || haystack.includes(` ${needle} `);
			}),
	);
}
export function preferenceContext(preferences: StandingPreference[]): string {
	if (!preferences.length) return "";
	return `\nStanding preferences for THIS chat (revocable user preferences, subordinate to bot rules; apply only when their topics fit, never permission to send unsolicited messages):\n${JSON.stringify(preferences.map(({ id, kind, instruction, topics, domains }) => ({ id, kind, instruction, topics, domains })))}`;
}

export class CommitmentStore {
	constructor(
		readonly path = memoryPath("commitments.json"),
		readonly now = Date.now,
	) {}
	read(): Promise<CommitmentState> {
		return readStore(this.path, stateSchema, () => ({
			tasks: [],
			preferences: [],
			receipts: [],
			pending: [],
		}));
	}
	/** Caller must hold the commitment transaction lock. */
	persist(state: CommitmentState): Promise<void> {
		return writeStore(this.path, state, stateSchema, true);
	}
	async transaction<T>(
		work: (state: CommitmentState) => T | Promise<T>,
	): Promise<T> {
		return withCommitmentsLock(async () => {
			const state = await this.read();
			const before = JSON.stringify(state);
			const result = await work(state);
			if (JSON.stringify(state) !== before)
				await writeStore(this.path, state, stateSchema, true);
			return result;
		});
	}
	async preferences(chatId: number): Promise<StandingPreference[]> {
		return (await this.read()).preferences.filter(
			(p) => p.chatId === chatId && p.status === "active",
		);
	}
	async apply(request: RequestIdentity, raw: Interpretation): Promise<string> {
		const plan = interpretationSchema.parse(raw);
		return this.transaction((state) => {
			const now = this.now();
			const key = `${request.chatId}:${request.messageId}`;
			const receipt = state.receipts.find((r) => r.key === key);
			if (receipt) return receipt.result;
			if (plan.clarification || plan.needsWrittenConfirmation)
				throw new Error("La solicitud necesita aclaración; no se guardó nada.");
			const owner = Number(process.env.OWNER_USER_ID);
			const owned = (id: string) => {
				const entry = [...state.tasks, ...state.preferences].find(
					(item) => item.id === id && item.chatId === request.chatId,
				);
				if (
					!entry ||
					(entry.creatorId !== request.userId &&
						request.userId !== owner &&
						!("schedule" in entry && sharedTaskManagement(request.chatId)))
				)
					throw new Error(
						"Solo puedes cambiar tus propias tareas y preferencias; el dueño puede gestionar todas.",
					);
				return entry;
			};
			const provenance = (evidence: string) => ({
				id: randomUUID(),
				chatId: request.chatId,
				creatorId: request.userId,
				creatorName: request.userName.slice(0, 200),
				createdAt: now,
				updatedAt: now,
				sourceMessageId: request.messageId,
				evidence,
			});
			const savedDomains = state.preferences
				.filter((p) => p.chatId === request.chatId && p.status === "active")
				.flatMap((p) => p.domains);
			const checkedDomains = (domains: string[], existing: string[] = []) => [
				...new Set(
					domains.map((rawDomain) => {
						const domain = normalizeDomain(rawDomain);
						if (
							!(
								request.domainEvidenceText === undefined &&
								[...existing, ...savedDomains].includes(domain)
							) &&
							!containsDomain(
								request.domainEvidenceText ?? request.text,
								domain,
							)
						)
							throw new Error(
								"Escribe las direcciones web exactas antes de guardarlas.",
							);
						return domain;
					}),
				),
			];
			const changes: unknown[] = [];
			for (const action of plan.actions) {
				if (!request.text.includes(action.evidence))
					throw new Error(
						"No pude verificar la petición original; repítela explícitamente.",
					);
				if (action.type === "renewal_reminder") {
					const task = owned(action.id);
					if (
						!("schedule" in task) ||
						task.schedule.frequency === "once" ||
						task.status !== "active" ||
						task.expiresAt <= now
					)
						throw new Error(
							"El aviso de renovación requiere una tarea recurrente activa.",
						);
					task.renewalReminderDays = action.days ?? undefined;
					task.updatedAt = now;
					changes.push({ action: "renewal_reminder", ...task });
				} else if (action.type === "update") {
					const task = owned(action.id);
					if (
						!("schedule" in task) ||
						task.status !== "active" ||
						task.expiresAt <= now
					)
						throw new Error(
							"Solo se puede editar una tarea activa; renueva explícitamente las vencidas.",
						);
					task.instruction = action.instruction;
					task.updatedAt = now;
					task.sourceMessageId = request.messageId;
					task.evidence = action.evidence;
					// Discard an obsolete generation already in flight, retaining the next occurrence.
					if (task.lastOccurrence?.status === "preparing")
						task.lastOccurrence.status = "failed";
					changes.push({
						action: "updated",
						...task,
						expiresLocal: displayTime(task.expiresAt, task.timezone),
					});
				} else if (action.type === "schedule") {
					if (
						action.task.renewalReminderDays &&
						action.task.schedule.frequency === "once"
					)
						throw new Error(
							"Los avisos de renovación requieren una tarea recurrente.",
						);
					if (action.task.kind === "research" && !action.task.searchQuery)
						throw new Error(
							"La investigación necesita una consulta pública concreta, sin datos personales del chat.",
						);
					if (action.replaceId) {
						const old = owned(action.replaceId);
						if (!("schedule" in old))
							throw new Error("Ese registro no es una tarea.");
						old.status = "cancelled";
						old.updatedAt = now;
					}
					const expiresAt = scheduleDeadline(action.task.schedule, now);
					const nextRunAt = nextOccurrence(
						action.task.schedule,
						now,
						expiresAt,
					);
					if (!nextRunAt)
						throw new Error(
							"Necesito una fecha y hora futuras compatibles con los días elegidos; las recurrencias deben empezar dentro del próximo mes.",
						);
					const task = {
						...action.task,
						renewalReminderDays:
							action.task.schedule.frequency === "once"
								? undefined
								: (action.task.renewalReminderDays ??
									state.tasks.find(
										(t) =>
											t.id === action.replaceId && t.chatId === request.chatId,
									)?.renewalReminderDays),
						domains: checkedDomains(
							action.task.domains,
							action.replaceId ? owned(action.replaceId).domains : [],
						),
						...provenance(action.evidence),
						timezone: BOT_TZ,
						expiresAt,
						nextRunAt,
						status: "active" as const,
					};
					state.tasks.push(task);
					changes.push({
						action: "saved",
						...task,
						nextLocal: displayTime(nextRunAt),
						expiresLocal: displayTime(expiresAt),
					});
				} else if (action.type === "prefer") {
					if (action.replaceId) {
						const old = owned(action.replaceId);
						if (!("topics" in old))
							throw new Error("Ese registro no es una preferencia.");
						old.status = "cancelled";
						old.updatedAt = now;
					}
					const domains = checkedDomains(
						action.preference.domains,
						action.replaceId ? owned(action.replaceId).domains : [],
					);
					if (action.preference.kind === "sources" && !domains.length)
						throw new Error("Escribe las fuentes que quieres guardar.");
					const preference = {
						...action.preference,
						domains,
						...provenance(action.evidence),
						status: "active" as const,
					};
					const duplicate = state.preferences.find(
						(p) =>
							p.chatId === request.chatId &&
							p.creatorId === request.userId &&
							p.status === "active" &&
							p.kind === preference.kind &&
							normalizedText(p.instruction) ===
								normalizedText(preference.instruction),
					);
					if (!duplicate) state.preferences.push(preference);
					changes.push({ action: "saved", ...(duplicate ?? preference) });
				} else {
					for (const id of action.ids) {
						const entry = owned(id);
						if (action.type === "cancel") entry.status = "cancelled";
						else {
							if (!("schedule" in entry) || entry.schedule.frequency === "once")
								throw new Error(
									"Solo se renuevan tareas recurrentes. Para un aviso puntual, pide una nueva fecha.",
								);
							if (action.type === "extend" && entry.status !== "active")
								throw new Error("Solo se puede extender una tarea activa.");
							entry.expiresAt =
								action.type === "extend"
									? extensionDeadline(
											entry.expiresAt,
											now,
											entry.timezone,
											action.days,
										)
									: renewalDeadline(now, entry.timezone, action.days);
							entry.renewalNotice = undefined;
							entry.renewalTermStartedAt = now;
							entry.schedule.endDate = undefined;
							entry.nextRunAt = nextOccurrence(
								entry.schedule,
								now,
								entry.expiresAt,
								entry.timezone,
							);
							if (!entry.nextRunAt)
								throw new Error("No hay una próxima ejecución válida.");
							entry.status = "active";
						}
						entry.updatedAt = now;
						changes.push({
							action: action.type,
							...entry,
							...("expiresAt" in entry
								? { expiresLocal: displayTime(entry.expiresAt, entry.timezone) }
								: {}),
						});
					}
				}
			}
			if (
				state.tasks.filter(
					(t) =>
						t.chatId === request.chatId &&
						t.status === "active" &&
						t.expiresAt > now,
				).length > 10
			)
				throw new Error(
					"Ya hay 10 tareas activas en este chat; cancela alguna antes de agregar otra.",
				);
			if (
				state.preferences.filter(
					(p) => p.chatId === request.chatId && p.status === "active",
				).length > 20
			)
				throw new Error(
					"Ya hay 20 preferencias activas; reemplaza o cancela alguna.",
				);
			if (
				preferenceContext(
					state.preferences.filter(
						(p) => p.chatId === request.chatId && p.status === "active",
					),
				).length > 6000
			)
				throw new Error(
					"Las preferencias son demasiado largas; resume alguna antes de guardar más.",
				);
			const result = JSON.stringify({
				committed: true,
				changes,
				...(plan.list
					? {
							agenda: state.tasks
								.filter((t) => t.chatId === request.chatId)
								.slice(-30),
							preferences: state.preferences.filter(
								(p) => p.chatId === request.chatId && p.status === "active",
							),
						}
					: {}),
				policy:
					"Tasks end at the stated deadline. Renew only on an explicit new request. Preferences persist until changed or cancelled.",
			});
			state.receipts = [
				...state.receipts.slice(-499),
				{ key, result, at: now },
			];
			state.pending = state.pending.filter(
				(p) => p.chatId !== request.chatId || p.userId !== request.userId,
			);
			// Bound historical storage, preserving every active entry.
			state.tasks = state.tasks.filter(
				(t) => t.status === "active" || t.updatedAt > now - 90 * 86400000,
			);
			state.preferences = state.preferences.filter(
				(p) => p.status === "active" || p.updatedAt > now - 90 * 86400000,
			);
			return result;
		});
	}
}
export const commitments = new CommitmentStore();
