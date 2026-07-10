// Subprocess probe for env-dependent routing behavior. handlers.ts bakes
// ALLOWED_GROUP_ID / OWNER_USER_ID / ENABLE_GROUP_VOICE_CONTEXT /
// GROUP_PASSIVE_VOICE_* at module load, so tests spawn this script with a
// controlled env (and a temp cwd holding memory/bot_config.json) and assert
// on the JSON it prints.
import {
	buildPassiveVoiceContent,
	buildUntranscribedVoiceContent,
	detectMentionType,
	detectTranscribedMentionType,
	securityMiddleware,
	shouldTranscribePassiveGroupVoice,
} from "../../src/handlers.ts";
import { makeMockContext } from "./telegram-mock.ts";

async function runMiddleware(ctx: Parameters<typeof securityMiddleware>[0]) {
	let nextCalled = false;
	await securityMiddleware(ctx, async () => {
		nextCalled = true;
	});
	return nextCalled;
}

const BOT = { id: 42, username: "mgs_test_bot" };

// --- Passive group voice gating ---
const gating = {
	short: shouldTranscribePassiveGroupVoice(10),
	atLimit30: shouldTranscribePassiveGroupVoice(30),
	over30: shouldTranscribePassiveGroupVoice(31),
	unknownDuration: shouldTranscribePassiveGroupVoice(undefined),
	untranscribedMsg: buildUntranscribedVoiceContent("Juan", 200),
	passiveLong: buildPassiveVoiceContent("Juan", "x".repeat(100)),
};

// --- Name mention detection against the configured bot name ---
const nameCtx = (text: string) =>
	makeMockContext({ chatType: "group", me: BOT, text }).ctx;
const mention = {
	plainName: detectMentionType(nameCtx("Niña ven acá"), BOT.id),
	strippedDiacritics: detectMentionType(nameCtx("oye nina que tal"), BOT.id),
	noName: detectMentionType(nameCtx("hola a todos"), BOT.id),
	transcribedName: detectTranscribedMentionType(
		nameCtx("dile a nina que venga"),
		BOT.id,
		"dile a nina que venga",
	),
	transcribedNone: detectTranscribedMentionType(
		nameCtx("hola a todos"),
		BOT.id,
		"hola a todos",
	),
};

// --- Security middleware (ALLOWED_GROUP_ID=-100500, OWNER_USER_ID=777) ---
const allowedGroup = makeMockContext({
	chatType: "group",
	chatId: -100500,
	from: { id: 1, first_name: "Any" },
	me: BOT,
	text: "hola",
});
const otherGroup = makeMockContext({
	chatType: "supergroup",
	chatId: -100999,
	from: { id: 1, first_name: "Any" },
	me: BOT,
	text: "hola",
});
const ownerDm = makeMockContext({
	chatType: "private",
	chatId: 777,
	from: { id: 777, first_name: "Owner" },
	me: BOT,
	text: "hola",
});
const strangerDm = makeMockContext({
	chatType: "private",
	chatId: 888,
	from: { id: 888, first_name: "Stranger" },
	me: BOT,
	text: "hola",
});

const security = {
	allowedGroupNext: await runMiddleware(allowedGroup.ctx),
	allowedGroupLeaveCalls: allowedGroup.spies.apiCalls.filter(
		(c) => c.method === "leaveChat",
	),
	otherGroupNext: await runMiddleware(otherGroup.ctx),
	otherGroupLeaveCalls: otherGroup.spies.apiCalls.filter(
		(c) => c.method === "leaveChat",
	),
	ownerDmNext: await runMiddleware(ownerDm.ctx),
	ownerDmReplies: ownerDm.spies.replies,
	strangerDmNextFirst: await runMiddleware(strangerDm.ctx),
	strangerDmNextSecond: await runMiddleware(strangerDm.ctx),
	strangerDmReplies: strangerDm.spies.replies,
};

console.log(JSON.stringify({ gating, mention, security }));
// Imported modules start interval timers (e.g. embedding cache persistence),
// which would keep the probe process alive forever.
process.exit(0);
