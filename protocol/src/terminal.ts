import { z } from "zod";

import { MsgType } from "./base";

// ─── Incoming (client → CLI) ──────────────────────────────────────────────────

export const TerminalCreateMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.TERMINAL_CREATE),
	clientId: z.string(),
	data: z.object({
		cols: z.number(),
		rows: z.number(),
		cwd: z.string().optional(),
	}),
});
export type TerminalCreateMsg = z.infer<typeof TerminalCreateMsgSchema>;

export const TerminalListMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.TERMINAL_LIST),
	clientId: z.string(),
});
export type TerminalListMsg = z.infer<typeof TerminalListMsgSchema>;

export const TerminalAttachMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.TERMINAL_ATTACH),
	clientId: z.string(),
	data: z.object({
		terminalId: z.string(),
		cols: z.number().optional(),
		rows: z.number().optional(),
	}),
});
export type TerminalAttachMsg = z.infer<typeof TerminalAttachMsgSchema>;

export const TerminalDataMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.TERMINAL_DATA),
	clientId: z.string(),
	data: z.object({
		terminalId: z.string(),
		data: z.string(),
	}),
});
export type TerminalDataMsg = z.infer<typeof TerminalDataMsgSchema>;

export const TerminalResizeMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.TERMINAL_RESIZE),
	clientId: z.string(),
	data: z.object({
		terminalId: z.string(),
		cols: z.number(),
		rows: z.number(),
	}),
});
export type TerminalResizeMsg = z.infer<typeof TerminalResizeMsgSchema>;

export const TerminalCloseMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.TERMINAL_CLOSE),
	clientId: z.string(),
	data: z.object({
		terminalId: z.string(),
	}),
});
export type TerminalCloseMsg = z.infer<typeof TerminalCloseMsgSchema>;

// ─── Outgoing (CLI → client) ──────────────────────────────────────────────────

export const TerminalCreateResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.TERMINAL_CREATE_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			terminalId: z.string().optional(),
			shell: z.string().optional(),
		})
		.optional(),
});
export type TerminalCreateResultMsg = z.infer<
	typeof TerminalCreateResultMsgSchema
>;

export const TerminalListResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.TERMINAL_LIST_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			terminals: z.array(
				z.object({
					terminalId: z.string(),
					shell: z.string(),
				}),
			),
		})
		.optional(),
});
export type TerminalListResultMsg = z.infer<typeof TerminalListResultMsgSchema>;

export const TerminalAttachResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.TERMINAL_ATTACH_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			terminalId: z.string().optional(),
			shell: z.string().optional(),
			snapshot: z.string().optional(),
			snapshotFormat: z.literal("xterm-serialize").optional(),
			activeBuffer: z.enum(["normal", "alternate"]).optional(),
			error: z.string().optional(),
		})
		.optional(),
});
export type TerminalAttachResultMsg = z.infer<
	typeof TerminalAttachResultMsgSchema
>;

/** Terminal output streamed from CLI to client (same wire type as TerminalDataMsg) */
export const TerminalOutputMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.TERMINAL_DATA),
	clientId: z.string(),
	data: z.object({
		terminalId: z.string(),
		data: z.string(),
	}),
});
export type TerminalOutputMsg = z.infer<typeof TerminalOutputMsgSchema>;

export const TerminalClosedMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.TERMINAL_CLOSED),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			terminalId: z.string(),
			exitCode: z.number().optional(),
		})
		.optional(),
});
export type TerminalClosedMsg = z.infer<typeof TerminalClosedMsgSchema>;

export const TerminalTitleMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.TERMINAL_TITLE),
	clientId: z.string(),
	data: z.object({
		terminalId: z.string(),
		title: z.string(),
	}),
});
export type TerminalTitleMsg = z.infer<typeof TerminalTitleMsgSchema>;
