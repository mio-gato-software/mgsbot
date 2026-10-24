import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import {
	localTime,
	monthDeadline,
	renewalDeadline,
	renewalReminderAt,
} from "../src/commitments/calendar.ts";
import {
	answerRenewal,
	type RenewalServices,
	registerRenewalCallbacks,
	renewalButtons,
	runRenewalNotices,
} from "../src/commitments/renewal.ts";
import { interpretationSchema } from "../src/commitments/schema.ts";
import { CommitmentStore } from "../src/commitments/store.ts";

let root: string;
let store: CommitmentStore;
let now: number;
let services: RenewalServices;
let sent: string[];
const env = { ...process.env };
const request = {
	chatId: -99,
	userId: 7,
	userName: "Ejemplo",
	messageId: 1,
	text: "Reporte diario, pregunta dos días antes",
};
const plan = (actions: unknown[]) => interpretationSchema.parse({ actions });
async function task() {
	const t = (await store.read()).tasks[0];
	if (!t) throw new Error("Missing fixture");
	return t;
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "renewal-"));
	now = localTime("2026-10-22", "11:33");
	store = new CommitmentStore(join(root, "state.json"), () => now);
	process.env.ENABLE_COMMITMENTS = "true";
	process.env.ALLOWED_GROUP_ID = "-99";
	process.env.OWNER_USER_ID = "1";
	process.env.ALLOW_GROUP_TASK_EDITS = "true";
	await store.apply(
		request,
		plan([
			{
				type: "schedule",
				evidence: request.text,
				task: {
					instruction: "Resultados de pelota",
					kind: "research",
					searchQuery: "LIDOM resultados",
					renewalReminderDays: 2,
					schedule: {
						frequency: "daily",
						time: "07:00",
						startDate: "2026-10-22",
						weekdays: [0, 1, 2, 3, 4, 5, 6],
					},
				},
			},
		]),
	);
	sent = [];
	services = {
		store,
		now: () => now,
		isOff: () => false,
		isSleeping: () => false,
		isAllowed: () => true,
		deliver: async (_, text) => {
			sent.push(text);
		},
		record: async () => {},
		alert: async () => {},
	};
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	for (const key of [
		"ALLOWED_GROUP_ID",
		"OWNER_USER_ID",
		"ALLOW_GROUP_TASK_EDITS",
	]) {
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
});

test("notice is part of the same task, sent once two local dates before expiry across restart/concurrent ticks", async () => {
	const original = await task();
	now = localTime("2026-11-20", "06:59");
	await runRenewalNotices(services);
	expect(sent).toHaveLength(0);
	now = localTime("2026-11-20", "07:00");
	await Promise.all([runRenewalNotices(services), runRenewalNotices(services)]);
	await runRenewalNotices({
		...services,
		store: new CommitmentStore(store.path, () => now),
	});
	expect(sent).toHaveLength(1);
	expect((await store.read()).tasks).toHaveLength(1);
	expect((await task()).expiresAt).toBe(original.expiresAt);
	expect((await task()).renewalNotice?.status).toBe("sent");
	for (const row of renewalButtons(original).inline_keyboard)
		for (const button of row)
			expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
	now = original.expiresAt + 1;
	await runRenewalNotices(services);
	expect(sent).toHaveLength(1);
	expect((await task()).expiresAt).toBe(original.expiresAt);
});

test("explicit button confirmation renews once; stale/repeated buttons and other chats cannot renew", async () => {
	now = localTime("2026-11-20", "07:00");
	await runRenewalNotices(services);
	const before = await task();
	const data =
		renewalButtons(before).inline_keyboard[0]?.[0]?.callback_data ?? "";
	await expect(answerRenewal(store, -100, 8, data, now)).rejects.toThrow();
	process.env.ALLOW_GROUP_TASK_EDITS = "false";
	await expect(answerRenewal(store, -99, 8, data, now)).rejects.toThrow();
	process.env.ALLOW_GROUP_TASK_EDITS = "true";
	const result = await answerRenewal(store, -99, 8, data, now);
	expect(result).toContain("Renovada");
	expect((await task()).expiresAt).toBe(localTime("2026-11-27", "07:00"));
	expect((await task()).schedule).toEqual(before.schedule);
	await expect(answerRenewal(store, -99, 8, data, now)).rejects.toThrow();
	await runRenewalNotices(services);
	expect(sent).toHaveLength(1);
	now = localTime("2026-11-25", "07:00");
	await runRenewalNotices(services);
	expect(sent).toHaveLength(2);
});

test("decline preserves expiry and stops prompts; disabled, cancelled, off and sleeping tasks do not notify", async () => {
	now = localTime("2026-11-20", "07:00");
	await runRenewalNotices({ ...services, isOff: () => true });
	await runRenewalNotices({ ...services, isSleeping: () => true });
	await runRenewalNotices({ ...services, isAllowed: () => false });
	expect(sent).toHaveLength(0);
	await runRenewalNotices(services);
	const before = await task();
	const data =
		renewalButtons(before).inline_keyboard[1]?.[0]?.callback_data ?? "";
	await answerRenewal(store, -99, 7, data, now);
	expect((await task()).expiresAt).toBe(before.expiresAt);
	await runRenewalNotices(services);
	expect(sent).toHaveLength(1);
	await expect(answerRenewal(store, -99, 7, data, now)).rejects.toThrow();
});

test("ambiguous delivery and crash after send intent never duplicate the notice", async () => {
	now = localTime("2026-11-20", "07:00");
	await runRenewalNotices({
		...services,
		deliver: async () => {
			sent.push("attempt");
			throw new Error("timeout");
		},
	});
	expect((await task()).renewalNotice?.status).toBe("unknown");
	await runRenewalNotices(services);
	expect(sent).toHaveLength(1);
	await store.transaction((state) => {
		const t = state.tasks[0];
		if (t?.renewalNotice) t.renewalNotice.status = "sending";
	});
	await runRenewalNotices(services);
	expect(sent).toHaveLength(1);
});

test("custom days renew atomically and one calendar month is the hard limit", async () => {
	const before = await task();
	await store.apply(
		{ ...request, messageId: 2, text: "Renueva por 5 días" },
		plan([
			{
				type: "renew",
				ids: [before.id],
				days: 5,
				evidence: "Renueva por 5 días",
			},
		]),
	);
	expect((await task()).expiresAt).toBe(localTime("2026-10-27", "11:33"));
	await expect(
		store.apply(
			{ ...request, messageId: 3, text: "Renueva por 31 días" },
			plan([
				{
					type: "renew",
					ids: [before.id],
					days: 31,
					evidence: "Renueva por 31 días",
				},
			]),
		),
	).resolves.toBeDefined();
	const feb = localTime("2027-02-01", "07:00");
	expect(renewalDeadline(feb, "America/Santo_Domingo")).toBe(
		monthDeadline(feb),
	);
	expect(() => renewalDeadline(feb, "America/Santo_Domingo", 29)).toThrow();
	expect(() => renewalDeadline(feb, "America/Santo_Domingo", 0)).toThrow();
	expect(() => renewalDeadline(feb, "America/Santo_Domingo", 32)).toThrow();
});

test("notice settings edit existing tasks without renewal and can be disabled", async () => {
	const before = await task();
	await store.apply(
		{ ...request, messageId: 2, text: "no preguntes" },
		plan([
			{
				type: "renewal_reminder",
				id: before.id,
				days: null,
				evidence: "no preguntes",
			},
		]),
	);
	expect((await task()).expiresAt).toBe(before.expiresAt);
	now = localTime("2026-11-20", "07:00");
	await runRenewalNotices(services);
	expect(sent).toHaveLength(0);
	await store.apply(
		{ ...request, messageId: 3, text: "pregunta dos días antes" },
		plan([
			{
				type: "renewal_reminder",
				id: before.id,
				days: 2,
				evidence: "pregunta dos días antes",
			},
		]),
	);
	await runRenewalNotices(services);
	expect(sent).toHaveLength(1);
});

test("calendar days respect DST and a short renewed period does not immediately prompt again", async () => {
	expect(
		renewalReminderAt(
			localTime("2026-11-02", "12:00", "America/New_York"),
			2,
			"07:00",
			"America/New_York",
		),
	).toBe(localTime("2026-10-31", "07:00", "America/New_York"));
	const t = await task();
	await store.apply(
		{ ...request, messageId: 2, text: "Renueva por un día" },
		plan([
			{ type: "renew", ids: [t.id], days: 1, evidence: "Renueva por un día" },
		]),
	);
	await runRenewalNotices(services);
	expect(sent).toHaveLength(0);
});

test("Telegram confirmation callback saves the selected duration before acknowledging", async () => {
	now = localTime("2026-11-20", "07:00");
	await runRenewalNotices(services);
	const bot = new Bot("test-token", {
		botInfo: {
			id: 42,
			is_bot: true,
			first_name: "Bot",
			username: "test_bot",
			can_join_groups: true,
			can_read_all_group_messages: true,
			supports_inline_queries: false,
			can_connect_to_business: false,
			has_main_web_app: false,
			has_topics_enabled: false,
			allows_users_to_create_topics: false,
			can_manage_bots: false,
			supports_join_request_queries: false,
		},
	});
	const calls: string[] = [];
	bot.api.config.use(async (_previous, method) => {
		calls.push(method);
		if (method === "answerCallbackQuery")
			expect((await task()).expiresAt).toBe(localTime("2026-12-04", "07:00"));
		return { ok: true, result: true } as never;
	});
	registerRenewalCallbacks(bot, store, () => now);
	const data =
		renewalButtons(await task()).inline_keyboard[0]?.[1]?.callback_data ?? "";
	await bot.handleUpdate({
		update_id: 12,
		callback_query: {
			id: "callback-1",
			from: { id: 7, is_bot: false, first_name: "Ejemplo" },
			chat_instance: "test",
			data,
			message: {
				message_id: 22,
				date: Math.floor(now / 1000),
				chat: { id: -99, type: "group", title: "Test" },
				text: "Renew?",
			},
		},
	});
	expect(calls).toEqual([
		"answerCallbackQuery",
		"editMessageReplyMarkup",
		"sendMessage",
	]);
});

test("over-month renewal fails atomically; cancelled tasks and expired buttons cannot act", async () => {
	const original = await task();
	now = localTime("2027-02-01", "07:00");
	await expect(
		store.apply(
			{ ...request, messageId: 2, text: "Renueva por 29 días" },
			plan([
				{
					type: "renew",
					ids: [original.id],
					days: 29,
					evidence: "Renueva por 29 días",
				},
			]),
		),
	).rejects.toThrow("mes calendario");
	expect((await task()).expiresAt).toBe(original.expiresAt);
	await expect(
		answerRenewal(
			store,
			-99,
			7,
			renewalButtons(original).inline_keyboard[0]?.[0]?.callback_data ?? "",
			now,
		),
	).rejects.toThrow();
	now = localTime("2026-11-20", "07:00");
	await store.apply(
		{ ...request, messageId: 3, text: "cancela" },
		plan([{ type: "cancel", ids: [original.id], evidence: "cancela" }]),
	);
	await runRenewalNotices(services);
	expect(sent).toHaveLength(0);
});
