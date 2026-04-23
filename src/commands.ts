import type { Bot } from "grammy";
import { setBotOff } from "./bot-state.ts";
import { isGroupChat } from "./conversation.ts";
import {
	decayConfidence,
	loadSensory,
	saveSensory,
	withChatLock,
} from "./memory/index.ts";
import { getChatProviderInfo, switchChatProvider } from "./providers/index.ts";

const ALLOWED_GROUP_ID = Number(process.env.ALLOWED_GROUP_ID);

const VALID_PROVIDERS = [
	"gemini",
	"openrouter",
	"anthropic",
	"azure",
	"alibaba",
	"fireworks",
	"openai",
	"fal",
] as const;

export function registerCommands(bot: Bot): void {
	// /provider — switch chat provider (DM only, owner only)
	bot.command("provider", async (ctx) => {
		if (isGroupChat(ctx)) return;

		const matchStr = typeof ctx.match === "string" ? ctx.match.trim() : "";
		const parts = matchStr.split(/\s+/).filter(Boolean);
		const providerArg = parts[0]?.toLowerCase() ?? "";
		const modelArg =
			parts.length > 1 ? parts.slice(1).join(" ").trim() : undefined;

		console.log(
			`[provider] Command received: "${matchStr}" from ${ctx.from?.id}`,
		);

		if (!providerArg) {
			const info = getChatProviderInfo();
			await ctx.reply(
				`Proveedor: ${info.provider}\nModelo: ${info.model}\n\nProveedores: ${VALID_PROVIDERS.join(", ")}`,
			);
			return;
		}

		if (
			!VALID_PROVIDERS.includes(providerArg as (typeof VALID_PROVIDERS)[number])
		) {
			await ctx.reply(
				`Uso:\n/provider — ver proveedor actual\n/provider <proveedor> [modelo]\n\nEjemplos:\n/provider gemini\n/provider openrouter meta-llama/llama-4-scout\n\nProveedores: ${VALID_PROVIDERS.join(", ")}`,
			);
			return;
		}

		try {
			const provider = switchChatProvider(providerArg, modelArg);
			await ctx.reply(
				`Cambiado a proveedor: ${provider.name}\nModelo: ${provider.model}`,
			);
		} catch (error) {
			await ctx.reply(`Error cambiando proveedor: ${error}`);
		}
	});

	// /allowphotorequest — allow one photo request
	// Usage: /allowphotorequest → activates for this DM; /allowphotorequest group → activates for the group
	bot.command("allowphotorequest", async (ctx) => {
		if (isGroupChat(ctx)) return;

		const arg = ctx.match?.toString().trim().toLowerCase();
		const targetGroup = arg === "group" || arg === "grupo";

		if (targetGroup) {
			if (!Number.isFinite(ALLOWED_GROUP_ID)) {
				await ctx.reply(
					"Error: ALLOWED_GROUP_ID no está configurado correctamente.",
				);
				return;
			}
			try {
				await withChatLock(ALLOWED_GROUP_ID, async () => {
					const groupBuffer = await loadSensory(ALLOWED_GROUP_ID);
					groupBuffer.allowPhotoRequest = true;
					await saveSensory(groupBuffer);
				});
				await ctx.reply(
					"✅ allowPhotoRequest activado para el grupo. La próxima solicitud directa de foto en el grupo enviará una imagen contextual y luego se desactivará automáticamente.",
				);
			} catch (error) {
				await ctx.reply(`Error activando allowPhotoRequest: ${error}`);
			}
		} else {
			const chatId = ctx.chat?.id;
			if (!chatId) return;
			try {
				await withChatLock(chatId, async () => {
					const dmBuffer = await loadSensory(chatId);
					dmBuffer.allowPhotoRequest = true;
					await saveSensory(dmBuffer);
				});
				await ctx.reply(
					"✅ allowPhotoRequest activado para este DM. La próxima solicitud directa de foto aquí enviará una imagen contextual y luego se desactivará automáticamente.",
				);
			} catch (error) {
				await ctx.reply(`Error activando allowPhotoRequest: ${error}`);
			}
		}
	});

	// /help — show available commands
	bot.command("help", async (ctx) => {
		if (isGroupChat(ctx)) return;
		await ctx.reply(
			[
				"*Comandos disponibles:*",
				"",
				"/help — Mostrar esta lista de comandos",
				"/provider — Ver o cambiar el proveedor de chat",
				"/allowphotorequest — Permitir 1 foto bajo petición en este DM (o `/allowphotorequest group` para el grupo)",
				"/on — Encender el bot",
				"/off — Apagar el bot",
				"/optimize — Optimizar memorias (decay de confianza)",
			].join("\n"),
			{ parse_mode: "Markdown" },
		);
	});

	// /off — disable bot responses
	bot.command("off", async (ctx) => {
		if (isGroupChat(ctx)) return;
		setBotOff(true);
		await ctx.reply("😴 Bot apagado. Responderé con 😴 hasta que uses /on.");
	});

	// /on — re-enable bot responses
	bot.command("on", async (ctx) => {
		if (isGroupChat(ctx)) return;
		setBotOff(false);
		await ctx.reply("✅ Bot encendido. Respondiendo normalmente.");
	});

	// /optimize — decay confidence + report stats
	bot.command("optimize", async (ctx) => {
		if (isGroupChat(ctx)) return;
		await ctx.reply("Optimizando memorias...");
		try {
			const result = await decayConfidence();
			await ctx.reply(
				`Optimizado:\n\nSemantic facts: ${result.total}\nEliminados por baja confianza: ${result.removed}`,
			);
		} catch (error) {
			await ctx.reply(`Error optimizando: ${error}`);
		}
	});
}
