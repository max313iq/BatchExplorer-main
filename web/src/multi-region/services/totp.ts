/**
 * Self-contained TOTP (RFC 6238) seed + code generator — the "OATH seed lab".
 *
 * Background: Microsoft Graph v1.0 `…/authentication/softwareOathMethods`
 * always returns a `null` secret (see the Graph docs / softwareOathAuthentication
 * Method resource), so a *usable* software-OATH seed can NOT be minted through
 * the v1.0 API. The supported way to stand up a known-seed TOTP factor is the
 * "programmable hardware OATH token" flow, where the seed is generated outside
 * Entra and provisioned in. This module generates that seed client-side and
 * computes live codes so an operator can (a) provision a programmable token /
 * authenticator with a known seed and (b) verify a seed produces the expected
 * codes.
 *
 * Technique mirrored from AADInternals `MFA.ps1` (`New-AADIntOTPSecret`,
 * `New-AADIntOTP` / `Generate-tOTP`), re-implemented on the Web Crypto API
 * (HMAC-SHA1 dynamic truncation) instead of .NET. Pure functions only — no
 * network, no Graph token — so it's deterministic and unit-testable against
 * the RFC 6238 reference vectors.
 */

/** RFC 4648 base32 alphabet (the alphabet every authenticator app expects). */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export interface TotpOptions {
  /** Evaluation time in epoch milliseconds. Defaults to `Date.now()`. */
  atMs?: number;
  /** Time-step in seconds. RFC 6238 default is 30. */
  periodSeconds?: number;
  /** Number of digits in the code. RFC 6238 default is 6. */
  digits?: number;
  /** HMAC hash. RFC 6238 default is SHA-1 (what Entra software OATH uses). */
  algorithm?: TotpAlgorithm;
}

export interface TotpCode {
  /** The zero-padded one-time code, e.g. `"492039"`. */
  code: string;
  /** The time-step counter this code was derived from. */
  counter: number;
  /** The time-step length used, in seconds. */
  periodSeconds: number;
  /** Seconds remaining until this code rolls over (1..periodSeconds). */
  secondsRemaining: number;
}

export interface OtpAuthUriOptions {
  /** Base32 secret (spaces/casing tolerated). */
  secret: string;
  /** The account the seed belongs to, e.g. a UPN. */
  accountName: string;
  /** Issuer shown in the authenticator, e.g. "Contoso". */
  issuer: string;
  digits?: number;
  periodSeconds?: number;
  algorithm?: TotpAlgorithm;
}

/** Resolve the platform crypto object (browser or Node webcrypto). */
function getCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle || !c.getRandomValues) {
    throw new Error(
      "Web Crypto API is unavailable in this environment; TOTP requires a " +
        "secure context (crypto.subtle).",
    );
  }
  return c;
}

/** Encode raw bytes as an unpadded RFC 4648 base32 string. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Decode a base32 secret to bytes. Tolerates lower-case, spaces, and `=`
 * padding (authenticator UIs commonly group the secret in spaced quads).
 * Throws on any non-base32 character so a typo fails loudly.
 */
export function base32Decode(secret: string): Uint8Array {
  const clean = secret.replace(/[\s=]/g, "").toUpperCase();
  if (clean.length === 0) {
    throw new Error("Empty base32 secret.");
  }
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: "${ch}".`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/**
 * Generate a cryptographically-random base32 OATH secret. Default is 20 bytes
 * (160 bits → 32 base32 chars), the standard RFC 4226/6238 key length and what
 * Microsoft Authenticator provisions.
 */
export function generateOathSecret(byteLength = 20): string {
  if (!Number.isInteger(byteLength) || byteLength < 10 || byteLength > 64) {
    throw new Error("OATH secret length must be an integer in [10, 64] bytes.");
  }
  const bytes = new Uint8Array(byteLength);
  getCrypto().getRandomValues(bytes);
  return base32Encode(bytes);
}

/** Group a base32 secret into spaced quads for readable manual entry. */
export function formatSecretForDisplay(secret: string): string {
  const clean = secret.replace(/[\s=]/g, "").toUpperCase();
  return clean.replace(/(.{4})/g, "$1 ").trim();
}

/** Big-endian 8-byte counter buffer for the HMAC message. */
function counterToBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  // JS bitwise ops are 32-bit; split the 64-bit counter into hi/lo halves.
  let hi = Math.floor(counter / 0x100000000);
  let lo = counter % 0x100000000;
  for (let i = 7; i >= 4; i--) {
    buf[i] = lo & 0xff;
    lo = Math.floor(lo / 256);
  }
  for (let i = 3; i >= 0; i--) {
    buf[i] = hi & 0xff;
    hi = Math.floor(hi / 256);
  }
  return buf;
}

/**
 * Compute the TOTP code for a base32 secret at a point in time. Async because
 * it uses the async Web Crypto `subtle.sign`. Mirrors AADInternals
 * `Generate-tOTP` (HMAC → dynamic truncation → mod 10^digits).
 */
export async function computeTotp(
  secret: string,
  options: TotpOptions = {},
): Promise<TotpCode> {
  const periodSeconds = options.periodSeconds ?? 30;
  const digits = options.digits ?? 6;
  const algorithm = options.algorithm ?? "SHA-1";
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error("TOTP digits must be an integer in [6, 8].");
  }
  if (!Number.isInteger(periodSeconds) || periodSeconds < 1) {
    throw new Error("TOTP period must be a positive integer (seconds).");
  }
  const atMs = options.atMs ?? Date.now();
  const epochSeconds = Math.floor(atMs / 1000);
  const counter = Math.floor(epochSeconds / periodSeconds);

  const key = base32Decode(secret);
  const crypto = getCrypto();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    // Copy into a fresh ArrayBuffer so the BufferSource is exactly the key.
    key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, counterToBytes(counter)),
  );

  // RFC 4226 dynamic truncation.
  const offset = sig[sig.length - 1] & 0x0f;
  const binary =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  const code = (binary % 10 ** digits).toString().padStart(digits, "0");

  const secondsRemaining = periodSeconds - (epochSeconds % periodSeconds);
  return { code, counter, periodSeconds, secondsRemaining };
}

/**
 * Build the `otpauth://totp/…` provisioning URI an authenticator app reads
 * (from a QR code or manual entry). The label encodes `issuer:account` and the
 * issuer is repeated as a query param per the Key URI Format spec.
 */
export function buildOtpAuthUri(options: OtpAuthUriOptions): string {
  const digits = options.digits ?? 6;
  const periodSeconds = options.periodSeconds ?? 30;
  // The Key URI Format spells the algorithm without the dash (SHA1, not SHA-1).
  const algorithm = (options.algorithm ?? "SHA-1").replace("-", "");
  const secret = options.secret.replace(/[\s=]/g, "").toUpperCase();
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(
    options.accountName,
  )}`;
  const params = new URLSearchParams({
    secret,
    issuer: options.issuer,
    algorithm,
    digits: String(digits),
    period: String(periodSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
