export interface ImageGenerationOptions {
	/** Report illustrations may need labels and exact numeric tables. */
	allowText?: boolean;
	dimensions?: { width: number; height: number };
}

export function reportAspectRatio({
	width,
	height,
}: NonNullable<ImageGenerationOptions["dimensions"]>): string {
	const target = width / height;
	const ratios = [
		[1, 1],
		[2, 3],
		[3, 2],
		[3, 4],
		[4, 3],
		[4, 5],
		[5, 4],
		[9, 16],
		[16, 9],
		[21, 9],
	] as const;
	const distance = ([w, h]: readonly [number, number]) =>
		Math.abs(Math.log(w / h / target));
	const compatible = target < 1 ? ratios.filter(([w, h]) => w < h) : ratios;
	return compatible
		.reduce((best, ratio) => (distance(ratio) < distance(best) ? ratio : best))
		.join(":");
}

export function gptReportCanvas({
	width,
	height,
}: NonNullable<ImageGenerationOptions["dimensions"]>) {
	if (width === height) return { width: 1024, height: 1024 };
	return width < height
		? { width: 1024, height: 1536 }
		: { width: 1536, height: 1024 };
}

export interface ImageProvider {
	readonly name: string;
	isAvailable(): boolean;
	generateImage(
		prompt: string,
		referenceImagePath?: string,
		options?: ImageGenerationOptions,
	): Promise<Buffer>;
	/**
	 * Edit a user-provided image according to the prompt. Differs from
	 * generateImage(prompt, ref) in intent: edit applies the prompt as a
	 * modification to the image, while generateImage with a reference treats
	 * the reference as a character template.
	 */
	editImage(prompt: string, imagePath: string): Promise<Buffer>;
}
