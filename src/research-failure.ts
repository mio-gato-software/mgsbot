import { isTimeoutError } from "./operation-deadline.ts";

export class ResearchFailure extends Error {
	constructor(
		public readonly code:
			| "empty_response"
			| "invalid_response"
			| "verification"
			| "generation",
		detail: string,
		cause?: unknown,
	) {
		super(detail, { cause });
		this.name = "ResearchFailure";
	}
}

export function researchFailureNotice(error: unknown): string {
	if (isTimeoutError(error))
		return "El proveedor agotó el tiempo disponible al preparar el reporte. Puedes pedir que lo intente de nuevo.";
	if (error instanceof ResearchFailure) {
		switch (error.code) {
			case "empty_response":
				return "El proveedor devolvió una respuesta vacía o incompleta al preparar el reporte. Puedes pedir que lo intente de nuevo.";
			case "invalid_response":
				return "El proveedor devolvió una solicitud de consulta inválida en lugar del reporte. Puedes pedir que lo intente de nuevo.";
			case "verification":
				return error.cause
					? "No se pudo completar la revisión del reporte. El error del revisor quedó registrado para diagnóstico; puedes pedir que lo intente de nuevo."
					: `La revisión del reporte detectó datos pendientes de verificar: ${error.message.slice(0, 500)}. Puedes pedir que lo intente de nuevo.`;
			case "generation":
				return "Falló el proveedor mientras preparaba el reporte. El error quedó registrado para diagnóstico; puedes pedir que lo intente de nuevo.";
		}
	}
	return "Falló la preparación o el guardado del reporte. El error quedó registrado para diagnóstico; puedes pedir que lo intente de nuevo.";
}
