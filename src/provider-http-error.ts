export class ProviderHttpError extends Error {
	constructor(
		operation: string,
		readonly status: number,
	) {
		super(`${operation}: ${status}`);
		this.name = "ProviderHttpError";
	}
}
