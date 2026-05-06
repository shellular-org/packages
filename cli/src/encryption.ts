import fs from "node:fs";
import path from "node:path";

import sodium from "libsodium-wrappers";

import { config } from "@/config";
import { logger } from "@/logger";

const keyFilePath = path.join(
	config.SHELLULAR_DIR,
	`shellular-${config.MACHINE_ID}.e2ee`,
);

let key: Uint8Array;

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

export function getKeyBase64(): string {
	return sodium.to_base64(key, sodium.base64_variants.ORIGINAL);
}

export function encrypt(plaintext: string): {
	nonce: string;
	ciphertext: string;
} {
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);

	return {
		nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
		ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
	};
}

export function encryptBytes(plaintext: Uint8Array): {
	nonce: Uint8Array;
	ciphertext: Uint8Array;
} {
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);

	return { nonce, ciphertext };
}

export function decrypt(
	nonceB64: string,
	ciphertextB64: string,
): string | null {
	try {
		const nonce = sodium.from_base64(nonceB64, sodium.base64_variants.ORIGINAL);
		const ciphertext = sodium.from_base64(
			ciphertextB64,
			sodium.base64_variants.ORIGINAL,
		);
		const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
		return sodium.to_string(plaintext);
	} catch {
		logger.error("E2EE decryption failed — dropping message");
		return null;
	}
}
