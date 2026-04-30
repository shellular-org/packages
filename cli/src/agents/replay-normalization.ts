import type { AcpMessage, AcpMessagePart } from "@shellular/protocol";

import { textFromContent } from "./events";

export function shouldSkipOpenCodeReadReplayContent(content: unknown) {
	const text = textFromContent(content);
	if (!text) return false;
	return (
		/Called the Read tool with the following input:\s*\{[^\n]*"filePath"\s*:/i.test(
			text,
		) ||
		/<path>[^<]+<\/path>\s*<type>file<\/type>\s*<content>[\s\S]*<\/content>/i.test(
			text,
		) ||
		/Image read successfully/i.test(text)
	);
}

export function normalizeCodexUserReplayMessage(
	message: AcpMessage,
): AcpMessage {
	const fileNormalized = normalizeUserFileAttachmentReplayMessage(message);
	const parts = fileNormalized.parts.flatMap(normalizeCodexUserReplayPart);
	return {
		...fileNormalized,
		parts: normalizeLegacyCodexPromptParts(parts),
	};
}

export function normalizeUserFileAttachmentReplayMessage(
	message: AcpMessage,
): AcpMessage {
	return {
		...message,
		parts: message.parts.flatMap((part) => {
			if (part.type === "text") {
				return normalizeResourceLinkTextPart(part);
			}
			const uri = fileUriFromPart(part);
			if (!uri) return part;
			return [
				fileReferencePartFromUri(
					uri,
					part.title || part.name || part.alt || uri.split("/").pop(),
					part.mimeType || part.mime,
				),
			];
		}),
	};
}

function normalizeCodexUserReplayPart(part: AcpMessagePart): AcpMessagePart[] {
	if (part.type !== "text") return [part];
	const result: AcpMessagePart[] = [];
	const regex = /\[@([^\]]+)\]\((file:\/\/[^)]+)\)/g;
	let lastIndex = 0;
	let match = regex.exec(part.text);
	while (match) {
		const before = part.text.slice(lastIndex, match.index);
		if (before) result.push({ type: "text", text: before });
		result.push(fileReferencePartFromUri(match[2], match[1]));
		lastIndex = regex.lastIndex;
		match = regex.exec(part.text);
	}
	const after = part.text.slice(lastIndex);
	if (after) result.push({ type: "text", text: after });
	return result.length ? result : [part];
}

function normalizeResourceLinkTextPart(part: AcpMessagePart): AcpMessagePart[] {
	if (part.type !== "text") return [part];
	const result: AcpMessagePart[] = [];
	const regex = /\[Resource link:\s*(file:\/\/[^\]]+)\]/g;
	let lastIndex = 0;
	let match = regex.exec(part.text);

	while (match) {
		const before = part.text.slice(lastIndex, match.index);
		if (before) result.push({ type: "text", text: before });
		const uri = match[1]?.trim();
		if (uri) result.push(fileReferencePartFromUri(uri));
		lastIndex = regex.lastIndex;
		match = regex.exec(part.text);
	}

	const after = part.text.slice(lastIndex);
	if (after) result.push({ type: "text", text: after });
	return result.length ? result : [part];
}

function normalizeLegacyCodexPromptParts(parts: AcpMessagePart[]) {
	const normalized = dedupeAdjacentFileReferences(parts);
	const textParts = normalized.filter(
		(part): part is AcpMessagePart & { type: "text"; text: string } =>
			part.type === "text",
	);
	const text = textParts
		.map((part) => part.text)
		.join("\n")
		.trim();
	if (
		!text.includes("Files mentioned by the user:") ||
		!text.includes("My request for")
	) {
		return normalized;
	}

	const requestMatch = text.match(
		/(?:^|\n)\s*#{1,6}\s*My request for [^:\n]+:\s*([\s\S]*)$/i,
	);
	if (!requestMatch) return normalized;
	const requestText = requestMatch[1]?.trim();
	if (!requestText) return normalized;

	const filesText = text.slice(0, requestMatch.index ?? 0);
	const fileParts = extractCodexMentionedFiles(filesText);
	if (!fileParts.length) return normalized;

	const nonTextParts = normalized.filter((part) => part.type !== "text");
	return dedupeAdjacentFileReferences([
		...fileParts,
		...nonTextParts,
		{ type: "text", text: requestText },
	]);
}

function extractCodexMentionedFiles(text: string): AcpMessagePart[] {
	const fileParts: AcpMessagePart[] = [];
	const lines = text.split("\n");

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		const inlineMatch = line.match(/^#{1,6}\s+([^:\n]+):\s*(\/.+)$/);
		if (inlineMatch) {
			fileParts.push(
				fileReferencePartFromPath(inlineMatch[2].trim(), inlineMatch[1].trim()),
			);
			continue;
		}

		const labelMatch = line.match(/^#{1,6}\s+([^:\n]+):\s*$/);
		const nextLine = lines[index + 1]?.trim();
		if (labelMatch && nextLine?.startsWith("/")) {
			fileParts.push(fileReferencePartFromPath(nextLine, labelMatch[1].trim()));
			index += 1;
		}
	}

	return fileParts;
}

function fileReferencePartFromUri(
	uri: string,
	label?: string,
	mimeType?: string,
): AcpMessagePart {
	const path = uri.replace(/^file:\/\//, "");
	return fileReferencePartFromPath(path, label, mimeType);
}

function fileReferencePartFromPath(
	path: string,
	label?: string,
	mimeType?: string,
): AcpMessagePart {
	const name = label?.replace(/^@/, "") || path.split("/").pop() || path;
	return {
		type: "file_reference",
		path,
		name,
		title: name,
		mimeType,
		rawContent: {
			type: "resource_link",
			uri: `file://${path}`,
			name,
			title: name,
			mimeType,
		},
	} as AcpMessagePart;
}

function fileUriFromPart(part: AcpMessagePart) {
	if (typeof part.uri === "string" && part.uri.startsWith("file://")) {
		return part.uri;
	}
	const raw = part.rawContent;
	if (!raw || typeof raw !== "object") return null;
	const rawUri = (raw as Record<string, unknown>).uri;
	if (typeof rawUri === "string" && rawUri.startsWith("file://")) {
		return rawUri;
	}
	return null;
}

function dedupeAdjacentFileReferences(parts: AcpMessagePart[]) {
	const result: AcpMessagePart[] = [];
	for (const part of parts) {
		const previous = result[result.length - 1];
		if (
			isFileReferencePart(part) &&
			previous &&
			isFileReferencePart(previous) &&
			previous.path === part.path
		) {
			continue;
		}
		result.push(part);
	}
	return result;
}

function isFileReferencePart(
	part: AcpMessagePart,
): part is AcpMessagePart & { type: "file_reference"; path: string } {
	return (
		part.type === "file_reference" &&
		"path" in part &&
		typeof part.path === "string"
	);
}
