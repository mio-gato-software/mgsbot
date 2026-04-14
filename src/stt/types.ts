export interface SttProvider {
	readonly name: string;
	transcribe(filePath: string, mimeType?: string): Promise<string>;
}
