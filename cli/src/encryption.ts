import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import type { EncryptedPayloadEncoding } from "@shellular/protocol";
import sodium from "libsodium-wrappers";

import { config } from "@/config";
import { logger } from "@/logger";

/**
 * Below this, gzip's header outweighs what it saves and the round trip is pure
 * overhead. Transcripts (the payloads that actually hurt) are far above it.
 */
const COMPRESS_MIN_BYTES = 4 * 1024;

const keyFilePath = path.join(
	config.SHELLULAR_DIR,
	`shellular-${config.MACHINE_ID}.e2ee`,
);

let key: Uint8Array | undefined;

export async function initEncryption(): Promise<void> {
	await sodium.ready;
	key = loadOrCreateKey();
	logger.debug(`E2EE key loaded (${keyFilePath})`);
}

function loadOrCreateKey(): Uint8Array {
	try {
		const buf = fs.readFileSync(keyFilePath);
		if (buf.length === sodium.crypto_secretbox_KEYBYTES) {
			return new Uint8Array(buf);
		}
		logger.warn("Invalid key file size, regenerating key");
	} catch {
		// Key file doesn't exist yet — will create below
	}

	const newKey = sodium.crypto_secretbox_keygen();
	fs.writeFileSync(keyFilePath, Buffer.from(newKey), { mode: 0o600 });
	return newKey;
}

function getKey(): Uint8Array {
	if (!key) {
		throw new Error("Encryption not initialized");
	}

	return key;
}

export function getKeyBase64(): string {
	return sodium.to_base64(getKey(), sodium.base64_variants.ORIGINAL);
}

/**
 * @param allowCompression whether the recipient can decode `enc: "gzip"`.
 *   Defaults to false so any caller that has not established the peer's
 *   capabilities emits the universally-readable format.
 */
export function encrypt(
	plaintext: string,
	allowCompression = false,
): {
	nonce: string;
	ciphertext: string;
	enc?: EncryptedPayloadEncoding;
} {
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	// Compress before encrypting: ciphertext is incompressible, and the relay
	// only ever reads the envelope's routing fields, so this stays end-to-end
	// and needs no relay-side support.
	const raw = Buffer.from(plaintext, "utf8");
	const compress = allowCompression && raw.byteLength >= COMPRESS_MIN_BYTES;
	const payload = compress ? gzipSync(raw) : raw;
	const ciphertext = sodium.crypto_secretbox_easy(payload, nonce, getKey());

	return {
		nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
		ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
		...(compress ? { enc: "gzip" as const } : {}),
	};
}

export function encryptBytes(plaintext: Uint8Array): {
	nonce: Uint8Array;
	ciphertext: Uint8Array;
} {
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, getKey());

	return { nonce, ciphertext };
}

export function decrypt(
	nonceB64: string,
	ciphertextB64: string,
	enc?: EncryptedPayloadEncoding,
): string | null {
	try {
		const nonce = sodium.from_base64(nonceB64, sodium.base64_variants.ORIGINAL);
		const ciphertext = sodium.from_base64(
			ciphertextB64,
			sodium.base64_variants.ORIGINAL,
		);
		const plaintext = sodium.crypto_secretbox_open_easy(
			ciphertext,
			nonce,
			getKey(),
		);
		// No `enc` means a peer that predates compression: raw UTF-8 JSON.
		if (enc === "gzip") {
			return gunzipSync(Buffer.from(plaintext)).toString("utf8");
		}
		return sodium.to_string(plaintext);
	} catch {
		logger.error("E2EE decryption failed — dropping message");
		return null;
	}
}
