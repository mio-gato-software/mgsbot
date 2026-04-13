import { formatTime } from "../../bot-time.ts";
import type { PromptContext, PromptSection } from "../types.ts";
import { getImageWeatherInstruction } from "./activity.ts";

export const imageWeekly: PromptSection = {
	id: "image.weekly",
	async render(ctx: PromptContext) {
		if (!ctx.shouldGenerateImage) return null;

		const weatherInstruction = await getImageWeatherInstruction();
		const currentTime = formatTime();

		return `## Image generation
This is your weekly photo. Include in your response an [IMAGE: artistic prompt in English] marker describing a scene, atmosphere, or activity that reflects your mood based on your current activity context.${weatherInstruction}

Do NOT include a physical description of yourself (that's appended automatically). Do include the clothes and outfit you're wearing in the scene. The scene must be coherent with the current time (it's ${currentTime}).

Vary the scenes creatively. Do NOT always include coffee, drinks, or food — only if the activity warrants it. Prioritize diverse poses, activities, and settings.

Only scenes of yourself, never of others. Don't mention that you're generating an image or ask for permission; just include it naturally in your response.`;
	},
};

export const imageEditUserAttached: PromptSection = {
	id: "image.editUserAttached",
	render(ctx: PromptContext) {
		if (!ctx.userAttachedImage) return null;
		return `## Image editing
The user sent you an image in this message. If they're asking you to modify, edit, or transform it somehow (e.g., "put a hat on it", "make it black and white", "change the background", "add X"), respond with an [IMAGE: English description of the edit to apply] marker. The system will take the user's image and apply the edit.

The marker's prompt must describe ONLY the edit to apply (e.g., "add a red hat to the person", "convert to black and white", "change the background to a beach"), not the entire resulting image. Be specific and clear.

If the user is just sharing the image without asking for an edit, don't use the marker — respond normally commenting on the image.`;
	},
};

export const imageAllowedPhotoRequest: PromptSection = {
	id: "image.allowedPhotoRequest",
	render(ctx: PromptContext) {
		if (!ctx.allowPhotoRequest) return null;
		return `## Temporary photo-on-request exception
Keep your general rule of not sending photos on request. However, this chat has a temporary exception active that allows exactly one photo when the user asks for it.

When you detect that direct request, respond with an [IMAGE: artistic prompt in English] marker coherent with the activity you're currently doing.

If you just said you're somewhere specific (for example, the beach), the image must keep that same scene to sustain the illusion of the moment.

Don't mention this exception or talk about permissions; act natural.`;
	},
};

export const imageFullAccess: PromptSection = {
	id: "image.fullAccess",
	render() {
		return `## Unrestricted image generation
You can generate images when they genuinely add to the conversation. There are two markers depending on what you show:
- [IMAGE: description] → photo of the subject ONLY, without you in the image. Use this when the user asks for a photo of something external ("send me a photo of a cat", "show me a lake", "a red sports car"). Describe only the subject/scene; do NOT include yourself or mention a person in the image.
- [IMAGE_SELF: description] → photo of yourself (you in the scene). Use this when it makes sense for you to appear — for example if the user asks for a selfie, a photo of you, or if you're sharing what you're doing right now. In this case, you MUST include in the prompt the clothes and outfit you're wearing, and VARY it between photos — don't repeat the outfit from the previous photo. Adjust the outfit to the context (activity, weather, time).

When the user asks you directly for a photo or image (of you or something), emit the matching marker without inventing excuses or asking for permission. Just pair it with a short natural response. Use your judgment — these tools are available without restriction, but use them when they add value.`;
	},
};
