import { z } from "zod";

import { ClientInfoRequestSchema, HostInfoSchema } from "./session";

export const LOCAL_CONTROL_PROTOCOL_VERSION = 1;

export const LocalCliStateSchema = z.enum([
	"stopped",
	"resolving",
	"installing",
	"starting",
	"running",
	"stopping",
	"incompatible",
	"error",
]);
export type LocalCliState = z.infer<typeof LocalCliStateSchema>;

export const LocalCliRemoteStateSchema = z.enum([
	"disabled",
	"connecting",
	"connected",
	"reconnecting",
	"disconnected",
]);
export type LocalCliRemoteState = z.infer<typeof LocalCliRemoteStateSchema>;

export const LocalCliStartSourceSchema = z.enum([
	"development",
	"npx",
	"global",
	"attached",
	"manual",
]);
export type LocalCliStartSource = z.infer<typeof LocalCliStartSourceSchema>;

export const LocalCliLifecycleSchema = z.enum(["app-owned", "attached"]);
export type LocalCliLifecycle = z.infer<typeof LocalCliLifecycleSchema>;

export const LocalCliErrorCodeSchema = z.enum([
	"EXISTING_CLI_UNSUPPORTED",
	"PROTOCOL_MISMATCH",
	"AUTHENTICATION_FAILED",
	"PORT_IN_USE",
	"NODE_NOT_FOUND",
	"NPM_NOT_FOUND",
	"INSTALL_FAILED",
	"START_FAILED",
	"EXECUTION_UNAVAILABLE",
	"CLI_NOT_RUNNING",
	"ACTIVATION_TIMEOUT",
	"PROCESS_NOT_OWNED",
]);
export type LocalCliErrorCode = z.infer<typeof LocalCliErrorCodeSchema>;

export const LocalCliErrorSchema = z.object({
	code: LocalCliErrorCodeSchema,
	message: z.string(),
	currentVersion: z.string().optional(),
	requiredVersion: z.string().optional(),
});
export type LocalCliError = z.infer<typeof LocalCliErrorSchema>;

export const LocalCliKnownClientSchema = z.object({
	clientId: z.string(),
	user: z
		.object({
			id: z.string(),
			email: z.string(),
		})
		.optional(),
	platform: z.string(),
	appVersion: z.string(),
	deviceModel: z.string().optional(),
	deviceManufacturer: z.string().optional(),
	firstSeen: z.string(),
	lastSeen: z.string(),
	approved: z.boolean(),
	connected: z.boolean(),
});
export type LocalCliKnownClient = z.infer<typeof LocalCliKnownClientSchema>;

export const LocalCliLogEntrySchema = z.object({
	id: z.number().int().nonnegative(),
	timestamp: z.string(),
	level: z.enum(["log", "debug", "warn", "error"]),
	message: z.string(),
});
export type LocalCliLogEntry = z.infer<typeof LocalCliLogEntrySchema>;

export const LocalCliSnapshotSchema = z.object({
	state: LocalCliStateSchema,
	cliVersion: z.string().optional(),
	protocolVersion: z.number().int().optional(),
	pid: z.number().int().positive().optional(),
	port: z.number().int().min(0).max(65535).optional(),
	uptimeMs: z.number().nonnegative().optional(),
	directory: z.string().optional(),
	machineName: z.string().optional(),
	source: LocalCliStartSourceSchema.optional(),
	lifecycle: LocalCliLifecycleSchema.optional(),
	remoteState: LocalCliRemoteStateSchema.optional(),
	hostInfo: HostInfoSchema.optional(),
	qrData: z.string().optional(),
	clients: z.array(LocalCliKnownClientSchema).default([]),
	logs: z.array(LocalCliLogEntrySchema).default([]),
	error: LocalCliErrorSchema.optional(),
});
export type LocalCliSnapshot = z.infer<typeof LocalCliSnapshotSchema>;

export const LocalCliTicketRequestSchema = z.object({
	protocolVersion: z.literal(LOCAL_CONTROL_PROTOCOL_VERSION),
	client: ClientInfoRequestSchema.omit({ hostId: true }),
});
export type LocalCliTicketRequest = z.infer<typeof LocalCliTicketRequestSchema>;

export const LocalCliTicketResponseSchema = z.object({
	wsUrl: z.string(),
	ticket: z.string(),
	hostId: z.string(),
	clientId: z.string(),
	encryptionKey: z.string(),
	protocolVersion: z.literal(LOCAL_CONTROL_PROTOCOL_VERSION),
});
export type LocalCliTicketResponse = z.infer<
	typeof LocalCliTicketResponseSchema
>;

export const LocalCliClientMutationSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("set-approval"),
		clientId: z.string(),
		approved: z.boolean(),
	}),
	z.object({ action: z.literal("delete"), clientId: z.string() }),
]);
export type LocalCliClientMutation = z.infer<
	typeof LocalCliClientMutationSchema
>;

export const LocalCliDiscoverySchema = z.object({
	pid: z.number().int().positive(),
	port: z.number().int().positive().max(65535),
	instanceId: z.string(),
	cliVersion: z.string(),
	protocolVersion: z.literal(LOCAL_CONTROL_PROTOCOL_VERSION),
	startedAt: z.string(),
	source: LocalCliStartSourceSchema,
});
export type LocalCliDiscovery = z.infer<typeof LocalCliDiscoverySchema>;
