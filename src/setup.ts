import type { Context } from "grammy";
import { generateResponse } from "./ai.ts";
import { type BotLanguage, loadConfig, saveConfig } from "./config.ts";
import { addMessageToSensory, loadSensory, saveSensory } from "./memory.ts";
import { buildMessages } from "./prompt.ts";
import type { ConversationMessage } from "./types.ts";

const SETUP_SYSTEM_PROMPT_ES = `Eres un asistente de configuración inicial para un nuevo bot de Telegram.
Tu objetivo es recopilar 4 datos fundamentales del dueño del bot para generar la personalidad del bot:
1. Nombre del bot
2. Año de nacimiento del bot (ej. 1995). La edad se calculará automáticamente, así el personaje crece con el tiempo.
3. Sexo: Da a escoger entre "hombre" o "mujer". Si el usuario dice otra cosa, explícale amablemente que solo puede ser "hombre" o "mujer". No le des ninguna explicación extra sobre las opciones disponibles, solo recuérdale que debe elegir entre esas dos opciones.
4. Personalidad (breve descripción de cómo debe actuar, hablar y comportarse)

Instrucciones:
- Saluda al usuario y explícale que estás configurando el bot.
- Ve paso a paso o pregunta todo a la vez si lo prefieres, pero mantén una conversación fluida y amable.
- Cuando tengas los 4 datos CLAROS Y CONFIRMADOS, debes finalizar tu respuesta incluyendo ÚNICAMENTE un bloque JSON con el siguiente formato EXACTO (sin Markdown extra de código si es posible, o asegúrate de que se pueda extraer):

\`\`\`json
{
  "botName": "Nombre",
  "birthYear": 1995,
  "gender": "hombre o mujer",
  "personality": "Descripción de la personalidad"
}
\`\`\`

- IMPORTANTE: Solo genera el JSON cuando ya tengas los 4 datos. Mientras tanto, conversa normalmente para obtenerlos.
- IMPORTANTE: El campo "gender" en el JSON SOLO puede ser "hombre" o "mujer". Ningún otro valor es válido.`;

const SETUP_SYSTEM_PROMPT_EN = `You are an initial setup assistant for a new Telegram bot.
Your goal is to collect 4 key pieces of information from the bot owner to generate the bot's personality:
1. Bot name
2. Bot's birth year (e.g. 1995). The age will be calculated automatically, so the character ages over time.
3. Gender: MUST be "male" or "female". Do not accept any other value. If the user says something else, kindly explain it can only be "male" or "female". Don't give any extra explanation about the available options, just remind them they must choose between those two options.
4. Personality (a brief description of how it should act, speak, and behave)

Instructions:
- Greet the user and explain that you are setting up the bot.
- Go step by step or ask everything at once if you prefer, but keep the conversation friendly and flowing.
- When you have all 4 pieces of data CLEAR AND CONFIRMED, end your response by including ONLY a JSON block in the following EXACT format (without extra Markdown code fencing if possible, or make sure it can be extracted):

\`\`\`json
{
  "botName": "Name",
  "birthYear": 1995,
  "gender": "male or female",
  "personality": "Personality description"
}
\`\`\`

- IMPORTANT: Only generate the JSON when you have all 4 pieces of data. Until then, converse normally to collect them.
- IMPORTANT: The "gender" field in the JSON can ONLY be "male" or "female". No other value is valid.`;

function getSetupPrompt(lang: BotLanguage): string {
	return lang === "en" ? SETUP_SYSTEM_PROMPT_EN : SETUP_SYSTEM_PROMPT_ES;
}

const VALID_GENDERS: Record<BotLanguage, string[]> = {
	es: ["hombre", "mujer"],
	en: ["male", "female"],
};

export async function processSetupConversation(
	ctx: Context,
	userContent: string,
	userName: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const userId = ctx.from?.id;
	const currentConfig = loadConfig();
	const lang: BotLanguage = currentConfig.language ?? "es";

	// Load sensory buffer to keep track of the setup conversation
	const buffer = await loadSensory(chatId);

	const userMessage: ConversationMessage = {
		role: "user",
		name: userName,
		userId,
		content: userContent,
		timestamp: Date.now(),
	};
	await addMessageToSensory(buffer, userMessage);

	const messages = buildMessages(buffer);

	await ctx.replyWithChatAction("typing");

	const responseText = await generateResponse(getSetupPrompt(lang), messages);

	if (!responseText.trim()) {
		return;
	}

	// Save bot response
	const botMessage: ConversationMessage = {
		role: "model",
		content: responseText,
		timestamp: Date.now(),
	};
	await addMessageToSensory(buffer, botMessage);

	// Check if JSON was generated
	const jsonMatch = responseText.match(
		/\{[\s\S]*"botName"[\s\S]*"personality"[\s\S]*\}/,
	);

	if (jsonMatch) {
		try {
			const configData = JSON.parse(jsonMatch[0]);
			const { botName, birthYear, gender, personality } = configData;

			const validGenders = VALID_GENDERS[lang];
			const normalizedGender = gender?.toLowerCase().trim();

			if (gender && !validGenders.includes(normalizedGender)) {
				const genderOptions = validGenders
					.map((g) => `*${g}*`)
					.join(lang === "en" ? " or " : " o ");
				const msg =
					lang === "en"
						? `⚠️ The bot's gender can only be ${genderOptions}. Please choose one of those two options.`
						: `⚠️ El sexo del bot solo puede ser ${genderOptions}. Por favor, elige una de esas dos opciones.`;
				await ctx.reply(msg, { parse_mode: "Markdown" });
				return;
			}

			if (botName && birthYear && normalizedGender && personality) {
				currentConfig.isConfigured = true;
				currentConfig.botName = botName;
				currentConfig.birthYear = Number(birthYear);
				currentConfig.gender = normalizedGender;
				currentConfig.personality = personality;
				currentConfig.language = lang;
				saveConfig(currentConfig);

				// Send confirmation to user
				const cleanText = responseText
					.replace(jsonMatch[0], "")
					.replace(/```json/g, "")
					.replace(/```/g, "")
					.trim();
				if (cleanText) {
					try {
						await ctx.reply(cleanText, { parse_mode: "Markdown" });
					} catch {
						await ctx.reply(cleanText);
					}
				}
				const confirmMsg =
					lang === "en"
						? `✅ Setup complete! I am now ${botName}.`
						: `✅ ¡Configuración completada! Ahora soy ${botName}.`;
				await ctx.reply(confirmMsg);

				// Clear the setup conversation to start fresh
				buffer.messages = [];
				await saveSensory(buffer);
				return;
			}
		} catch (error) {
			console.error("[setup] Error parsing setup JSON:", error);
			// Fallback to normal reply if parsing fails
		}
	}

	try {
		await ctx.reply(responseText, { parse_mode: "Markdown" });
	} catch {
		await ctx.reply(responseText);
	}
}
