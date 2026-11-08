import { z } from "zod";
import { behaviorInputSchema } from "./schema.ts";
import { commitments } from "./store.ts";

/** Apply while the bot is stopped, as with other headless store edits. */
export async function configureTaskBehaviorsFile(file: string): Promise<void> {
	const config = z
		.strictObject({
			taskId: z.string().min(1),
			behaviors: z.array(behaviorInputSchema).max(3),
		})
		.parse(await Bun.file(file).json());
	await commitments.configureBehaviors(config.taskId, config.behaviors);
}
