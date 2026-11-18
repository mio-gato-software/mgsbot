import { randomUUID } from "node:crypto";
import { z } from "zod";
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
import { planScheduledImage } from "./image.ts";
import {
	behaviorInputSchema,
	COMMITMENTS_VERSION,
	type CommitmentState,
	type FormatChange,
	type Interpretation,
	interpretationSchema,
	MAX_REPORT_PHOTO_IDS,
	type ReportImage,
	type ScheduledTask,
	type StandingPreference,
	stateSchema,
} from "./schema.ts";

function applyFormat(
	current: ReportImage | null,
	change?: FormatChange,
): ReportImage | null {
	const delivery = change?.delivery ?? current?.delivery ?? "text";
	if (delivery === "text") {
		if (change?.description || change?.canvas)
			throw new Error("Un diseño de imagen requiere una entrega con imagen.");
		return null;
	}
	return {
		delivery,
		description:
			change?.description ??
			current?.description ??
			"Illustrate the complete current report.",
		canvas: change?.canvas ?? current?.canvas ?? "auto",
	};
}

/** Runtime configuration, never learned from ordinary memory or web content. */
function setBehaviors(task: ScheduledTask, raw: unknown, now: number): void {
	const inputs = z.array(behaviorInputSchema).max(3).parse(raw);
	if (inputs.length && task.kind !== "research")
		throw new Error(
			"Los comportamientos condicionales requieren una tarea de investigación.",
		);
	const seen = new Set<string>();
	task.behaviors = inputs.map((input) => {
		const previous = task.behaviors?.find((b) => b.id === input.id);
		if (input.id && (!previous || seen.has(input.id)))
			throw new Error("Identificador de comportamiento inválido o repetido.");
		const id = previous?.id ?? randomUUID();
		seen.add(id);
		return { ...input, id, createdAt: previous?.createdAt ?? now };
	});
	task.updatedAt = now;
	if (task.lastOccurrence?.status === "preparing")
		task.lastOccurrence.status = "failed";
}

export interface RequestIdentity {
	chatId: number;
	userId: number;
	userName: string;
	messageId: number;
	text: string;
	voice?: boolean;
	/** Bounded same-chat reference context, never authorization or evidence. */
	replyContext?: { text: string; isBot: boolean; messageId?: number };
	referenceImage?: { size?: string; description?: string };
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

function mayManage(
	entry: ScheduledTask | StandingPreference,
	request: RequestIdentity,
): boolean {
	return (
		entry.chatId === request.chatId &&
		(entry.creatorId === request.userId ||
			request.userId === Number(process.env.OWNER_USER_ID) ||
			("schedule" in entry && sharedTaskManagement(request.chatId)))
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

/** Always expose live tasks even when newer cancelled/replaced tasks fill the history. */
export function agendaTasks(
	tasks: ScheduledTask[],
	chatId: number,
	now: number,
): ScheduledTask[] {
	const live: ScheduledTask[] = [];
	const history: ScheduledTask[] = [];
	for (const task of tasks) {
		if (task.chatId !== chatId) continue;
		(task.status === "active" && task.expiresAt > now ? live : history).push(
			task,
		);
	}
	return [
		...history.slice(Math.max(0, history.length + live.length - 30)),
		...live,
	];
}

export function taskDetails({
	lastMessage: _last,
	behaviorEvents: _events,
	reportPhotoIds: _photos,
	...details
}: ScheduledTask) {
	return details;
}

export function rememberReportPhoto(task: ScheduledTask, messageId: number) {
	if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
	task.reportPhotoIds = [...(task.reportPhotoIds ?? []), messageId].slice(
		-MAX_REPORT_PHOTO_IDS,
	);
}

export class CommitmentStore {
	constructor(
		readonly path = memoryPath("commitments.json"),
		readonly now = Date.now,
		private readonly inferLegacyImage = planScheduledImage,
	) {}
	read(): Promise<CommitmentState> {
		return readStore(
			this.path,
			stateSchema,
			() => ({
				tasks: [],
				preferences: [],
				receipts: [],
				pending: [],
			}),
			COMMITMENTS_VERSION,
		);
	}
	/** Caller must hold the commitment transaction lock. */
	persist(state: CommitmentState): Promise<void> {
		return writeStore(this.path, state, stateSchema, true, COMMITMENTS_VERSION);
	}
	async resolveReportImage(
		snapshot: ScheduledTask,
	): Promise<ReportImage | null> {
		if (snapshot.reportImage !== undefined) return snapshot.reportImage;
		// Model work stays outside the transaction. A concurrent winner owns the format.
		const inferred = await this.inferLegacyImage(snapshot);
		return this.transaction((state) => {
			const task = state.tasks.find(
				(t) => t.id === snapshot.id && t.chatId === snapshot.chatId,
			);
			if (
				!task ||
				task.status !== snapshot.status ||
				task.instruction !== snapshot.instruction
			)
				throw new Error("La tarea cambió mientras se preparaba su formato.");
			if (task.reportImage === undefined) task.reportImage = inferred;
			return task.reportImage;
		});
	}
	async transaction<T>(
		work: (state: CommitmentState) => T | Promise<T>,
	): Promise<T> {
		return withCommitmentsLock(async () => {
			const state = await this.read();
			const before = JSON.stringify(state);
			const result = await work(state);
			if (JSON.stringify(state) !== before) await this.persist(state);
			return result;
		});
	}
	async preferences(chatId: number): Promise<StandingPreference[]> {
		return (await this.read()).preferences.filter(
			(p) => p.chatId === chatId && p.status === "active",
		);
	}
	/** Headless operator configuration: no fabricated Telegram message or receipt. */
	async configureBehaviors(taskId: string, inputs: unknown): Promise<void> {
		await this.transaction((state) => {
			const task = state.tasks.find((t) => t.id === taskId);
			if (task?.status !== "active" || task.expiresAt <= this.now())
				throw new Error("La tarea debe estar activa.");
			setBehaviors(task, inputs, this.now());
		});
	}
	async apply(request: RequestIdentity, raw: Interpretation): Promise<string> {
		const plan = interpretationSchema.parse(raw);
		const key = `${request.chatId}:${request.messageId}`;
		const editedIds = plan.actions.flatMap((a) => {
			if (!request.text.includes(a.evidence)) return [];
			if ("format" in a && a.format?.delivery === "text") return [];
			if (a.type === "update") return [a.id];
			return a.type === "schedule" && a.replaceId ? [a.replaceId] : [];
		});
		const legacyImages = new Map<
			string,
			{ instruction: string; image: ReportImage | null }
		>();
		if (
			editedIds.length &&
			!plan.clarification &&
			!plan.needsWrittenConfirmation
		) {
			const snapshot = await this.read();
			const receipt = snapshot.receipts.find((r) => r.key === key);
			if (receipt) return receipt.result;
			for (const task of snapshot.tasks) {
				if (
					editedIds.includes(task.id) &&
					task.reportImage === undefined &&
					task.status === "active" &&
					task.expiresAt > this.now() &&
					mayManage(task, request)
				)
					legacyImages.set(task.id, {
						instruction: task.instruction,
						image: await this.inferLegacyImage(task),
					});
			}
		}
		return this.transaction((state) => {
			const now = this.now();
			const revisedImage = (
				task: ScheduledTask | undefined,
				change?: FormatChange,
			) => {
				if (!task || change?.delivery === "text")
					return applyFormat(null, change);
				if (task.reportImage === undefined) {
					const legacy = legacyImages.get(task.id);
					if (!legacy || legacy.instruction !== task.instruction)
						throw new Error(
							"La tarea cambió mientras se preparaba su formato.",
						);
					task.reportImage = legacy.image;
				}
				return applyFormat(task.reportImage, change);
			};
			const receipt = state.receipts.find((r) => r.key === key);
			if (receipt) return receipt.result;
			if (plan.clarification || plan.needsWrittenConfirmation)
				throw new Error("La solicitud necesita aclaración; no se guardó nada.");
			const owned = (id: string) => {
				const entry = [...state.tasks, ...state.preferences].find(
					(item) => item.id === id && item.chatId === request.chatId,
				);
				if (!entry || !mayManage(entry, request))
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
							!existing.includes(domain) &&
							!(
								request.domainEvidenceText === undefined &&
								savedDomains.includes(domain)
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
			const changes: Array<{
				action: string;
				id: string;
				[key: string]: unknown;
			}> = [];
			for (const action of plan.actions) {
				if (!request.text.includes(action.evidence))
					throw new Error(
						"No pude verificar la petición original; repítela explícitamente.",
					);
				if (action.type === "set_behaviors") {
					const task = owned(action.id);
					if (
						!("schedule" in task) ||
						task.status !== "active" ||
						task.expiresAt <= now
					)
						throw new Error("La tarea debe estar activa.");
					setBehaviors(task, action.behaviors, now);
					changes.push({ action: "behaviors_updated", ...taskDetails(task) });
				} else if (action.type === "renewal_reminder") {
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
					changes.push({ action: "renewal_reminder", ...taskDetails(task) });
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
					task.reportImage = revisedImage(task, action.format);
					if (action.instruction !== undefined)
						task.instruction = action.instruction;
					if (action.time !== undefined && action.time !== task.schedule.time) {
						task.schedule.time = action.time;
						if (task.schedule.frequency === "once")
							task.expiresAt = scheduleDeadline(
								task.schedule,
								now,
								task.timezone,
							);
						task.nextRunAt = nextOccurrence(
							task.schedule,
							now,
							task.expiresAt,
							task.timezone,
						);
						if (!task.nextRunAt)
							throw new Error(
								"Esa hora no tiene una próxima ejecución dentro del plazo de la tarea.",
							);
					}
					if (action.searchQuery !== undefined) {
						if (task.kind !== "research")
							throw new Error(
								"La consulta pública requiere una tarea de investigación.",
							);
						task.searchQuery = action.searchQuery;
					}
					if (action.domains !== undefined)
						task.domains = checkedDomains(action.domains, task.domains);
					task.updatedAt = now;
					task.sourceMessageId = request.messageId;
					task.evidence = action.evidence;
					// Discard an obsolete generation already in flight, retaining the next occurrence.
					if (task.lastOccurrence?.status === "preparing")
						task.lastOccurrence.status = "failed";
					changes.push({
						action: "updated",
						...taskDetails(task),
						expiresLocal: displayTime(task.expiresAt, task.timezone),
					});
				} else if (action.type === "schedule") {
					const previous = action.replaceId
						? owned(action.replaceId)
						: undefined;
					if (
						previous &&
						(!("schedule" in previous) ||
							previous.status !== "active" ||
							previous.expiresAt <= now)
					)
						throw new Error("Solo se puede reemplazar una tarea activa.");
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
					if (previous) {
						previous.status = "cancelled";
						previous.updatedAt = now;
					}
					const timezone = previous?.timezone ?? BOT_TZ;
					const expiresAt = scheduleDeadline(
						action.task.schedule,
						now,
						timezone,
					);
					const nextRunAt = nextOccurrence(
						action.task.schedule,
						now,
						expiresAt,
						timezone,
					);
					if (!nextRunAt)
						throw new Error(
							"Necesito una fecha y hora futuras compatibles con los días elegidos; las recurrencias deben empezar dentro del próximo mes.",
						);
					const task = {
						...action.task,
						reportImage: revisedImage(previous, action.format),
						reportPhotoIds: previous?.reportPhotoIds,
						behaviors: previous?.behaviors,
						behaviorEvents: previous?.behaviorEvents,
						renewalReminderDays:
							action.task.schedule.frequency === "once"
								? undefined
								: (action.task.renewalReminderDays ??
									previous?.renewalReminderDays),
						domains: checkedDomains(
							action.task.domains ?? previous?.domains ?? [],
							previous?.domains,
						),
						...provenance(action.evidence),
						creatorId: previous?.creatorId ?? request.userId,
						creatorName:
							previous?.creatorName ?? request.userName.slice(0, 200),
						timezone,
						expiresAt,
						nextRunAt,
						status: "active" as const,
					};
					if (action.task.behaviors !== undefined)
						setBehaviors(task, action.task.behaviors, now);
					if (task.behaviors?.length && task.kind !== "research")
						throw new Error("Los comportamientos requieren investigación.");
					state.tasks.push(task);
					changes.push({
						action: "saved",
						...taskDetails(task),
						nextLocal: displayTime(nextRunAt, timezone),
						expiresLocal: displayTime(expiresAt, timezone),
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
							...("schedule" in entry ? taskDetails(entry) : entry),
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
							agenda: agendaTasks(state.tasks, request.chatId, now).map(
								taskDetails,
							),
							preferences: state.preferences.filter(
								(p) => p.chatId === request.chatId && p.status === "active",
							),
						}
					: {}),
				policy:
					"Tasks end at the stated deadline. Renew only on an explicit new request. Preferences persist until changed or cancelled.",
			});
			// Large multi-task listings can exceed the receipt limit even without
			// runtime history. Keep their mutation acknowledgements replay-safe.
			const receiptResult =
				result.length <= 60_000
					? result
					: JSON.stringify({
							committed: true,
							changes: changes.map(({ id, action }) => ({ id, action })),
							listed: plan.list,
						});
			state.receipts = [
				...state.receipts.slice(-499),
				{ key, result: receiptResult, at: now },
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
