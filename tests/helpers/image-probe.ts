import assert from "node:assert/strict";
import { backgroundTasks } from "../../src/background-tasks.ts";
import {
	processConversation,
	defaultConversationDependencies as services,
} from "../../src/conversation.ts";
import { handleDocument } from "../../src/handlers/document.ts";
import { handlePhoto } from "../../src/handlers/photo.ts";
import { loadSensory } from "../../src/memory/sensory.ts";
import type { ChatMessage } from "../../src/providers/types.ts";
import { type MockContextOptions, makeMockContext } from "./telegram-mock.ts";

const downloads: string[] = [];
const generated: ChatMessage[][] = [];
const files: string[] = [];
globalThis.fetch = Object.assign(
	async (url: string | URL | Request) => {
		assert(
			String(url).startsWith("https://api.telegram.org/file/bottest-token/"),
		);
		downloads.push(String(url));
		return new Response("image-bytes");
	},
	{ preconnect() {} },
) as typeof fetch;

function context(options: MockContextOptions) {
	const { ctx } = makeMockContext(options);
	Object.defineProperty(ctx, "api", {
		value: {
			token: "test-token",
			getFile: async (fileId: string) => ({
				file_path: `photos/${fileId}.jpg`,
			}),
		},
	});
	return ctx;
}
services.assemble = async () => "test system";
services.retrieve = async () => ({
	relevantEpisodes: [],
	relevantFacts: [],
	permanentFacts: [],
	relationshipMemory: null,
	recentChapters: [],
	activeNames: [],
	mentionedNames: [],
});
services.generate = async (_system, messages) => {
	generated.push(messages);
	return "Read the image";
};
services.send = async ({ userImagePath }) => {
	assert(userImagePath);
	assert(await Bun.file(userImagePath).exists());
	files.push(userImagePath);
	return { sent: true, cleanedText: "Read the image", bufferDirty: false };
};

await handlePhoto(
	context({
		chatId: 990001,
		photo: [{ file_id: "first", width: 10, height: 10 }],
	}),
	"test-token",
);
await processConversation(
	context({ chatId: 990001, messageId: 2 }),
	"¿Qué dice el letrero?",
	"Test",
);
await handlePhoto(
	context({
		chatId: 990002,
		text: "¿De qué color es?",
		replyToMessage: {
			message_id: 10,
			caption: "Mi carro",
			from: { id: 123, first_name: "Ana" },
			photo: [{ file_id: "replied", width: 10, height: 10 }],
		},
	}),
	"test-token",
	"¿De qué color es?",
);
const document = {
	file_id: "uncompressed",
	file_name: "original.png",
	mime_type: "image/png",
};
assert(
	await handleDocument(
		context({ chatId: 990003, document }),
		"test-token",
		document,
	),
);
assert(
	await handleDocument(
		context({ chatId: 990004, replyToMessage: { message_id: 20, document } }),
		"test-token",
		document,
		{ requestText: "Lee el texto" },
	),
);
await handlePhoto(
	context({
		chatId: -990005,
		chatType: "group",
		photo: [{ file_id: "passive", width: 10, height: 10 }],
	}),
	"test-token",
);
await backgroundTasks.drain();

assert.equal(downloads.length, 5);
assert.equal(generated.length, 5);
for (const messages of generated) {
	assert.equal(messages.filter((message) => message.mediaAttachment).length, 1);
	assert.equal(
		messages.at(-1)?.mediaAttachment?.data,
		Buffer.from("image-bytes").toString("base64"),
	);
}
assert(generated[1]?.at(-1)?.content.includes("¿Qué dice el letrero?"));
assert(generated[2]?.at(-1)?.content.includes("Image from Ana"));
assert(generated[2]?.at(-1)?.content.includes("¿De qué color es?"));
assert.equal(generated[3]?.at(-1)?.mediaAttachment?.mimeType, "image/png");
assert.equal(generated[4]?.at(-1)?.mediaAttachment?.mimeType, "image/png");
assert.equal(
	(await loadSensory(-990005)).messages[0]?.image?.fileId,
	"passive",
);
assert.equal(new Set(files).size, files.length);
for (const path of files) assert.equal(await Bun.file(path).exists(), false);
console.log("IMAGE_PROBE_OK");
