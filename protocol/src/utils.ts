import type { z } from "zod";

export interface ParseMessageResult<TSchema extends z.ZodType> {
	data: z.infer<TSchema> | null;
	error: string | null;
	parsed: unknown;
}

export function parseMessage<TSchema extends z.ZodType>(
	raw: string | object,
	schema: TSchema,
): ParseMessageResult<TSchema> {
	let parsed: unknown;

	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				data: null,
				error: "Invalid JSON payload",
				parsed: null,
			};
		}
	} else {
		parsed = raw;
	}

	const result = schema.safeParse(parsed);
	if (result.success) {
		return {
			data: result.data,
			error: null,
			parsed,
		};
	}

	return {
		data: null,
		error: result.error.message,
		parsed,
	};
}
