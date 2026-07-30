import type { ClientInfo } from "@shellular/protocol";
import semver from "semver";

/**
 * What a connected app build can understand, derived from its version.
 *
 * The CLI ships independently of the app and users update on their own
 * schedule, so a newer CLI will always be talking to some older apps. Rather
 * than negotiating a feature list at handshake time — which needs app-side
 * changes and therefore has the same bootstrap problem — capabilities are
 * inferred here from `ClientInfo.appVersion`.
 *
 * To add a capability: bump nothing, add a MIN_VERSION constant and a field on
 * `ClientCapabilities`, and default it to `false` for unparseable versions.
 * Never make a capability default to `true` on parse failure: an old client
 * that we fail to identify must degrade to the conservative behaviour, not the
 * new one.
 */
export interface ClientCapabilities {
	/**
	 * App can gunzip an encrypted envelope carrying `enc: "gzip"`. Apps before
	 * this decrypt straight to UTF-8 JSON and would fail to parse a compressed
	 * payload, dropping every message.
	 */
	gzipPayloads: boolean;
}

/** First app release that understands `enc: "gzip"` on encrypted envelopes. */
const MIN_VERSION_GZIP_PAYLOADS = "0.0.38";

const NO_CAPABILITIES: ClientCapabilities = {
	gzipPayloads: false,
};

/**
 * Pull the semver out of an `appVersion` string.
 *
 * The app sends `"{VERSION} ({VERSION_CODE})"` (e.g. `"0.0.37 (142)"`), so the
 * build code is dropped. Returns null for anything `semver` rejects, which
 * keeps unknown clients on the conservative path rather than throwing in the
 * comparison below.
 */
function parseAppVersion(appVersion: string): string | null {
	return semver.valid(appVersion.trim().split(" ")[0]);
}

/**
 * Resolve what the given client build supports. An unparseable or missing
 * version yields no capabilities, so unknown clients get the old wire format.
 */
export function getClientCapabilities(
	clientInfo: ClientInfo | undefined,
): ClientCapabilities {
	if (!clientInfo) return NO_CAPABILITIES;
	const version = parseAppVersion(clientInfo.appVersion);
	if (!version) return NO_CAPABILITIES;
	return {
		gzipPayloads: semver.gte(version, MIN_VERSION_GZIP_PAYLOADS),
	};
}
