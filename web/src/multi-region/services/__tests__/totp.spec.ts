import { webcrypto } from "node:crypto";

// jsdom's `crypto` exposes getRandomValues but NOT SubtleCrypto, which TOTP
// needs for HMAC. The browser runtime always has it (secure context); for the
// test we graft Node's webcrypto (getRandomValues + subtle) onto the global.
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});

import {
  base32Decode,
  base32Encode,
  buildOtpAuthUri,
  computeTotp,
  formatSecretForDisplay,
  generateOathSecret,
} from "../totp";

describe("totp / base32", () => {
  it("round-trips bytes through base32", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255, 128, 64, 17]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it("decodes tolerating spaces, padding and lower-case", () => {
    const canonical = base32Decode("JBSWY3DPEHPK3PXP");
    expect(base32Decode("jbsw y3dp ehpk 3pxp")).toEqual(canonical);
    expect(base32Decode("JBSWY3DPEHPK3PXP======")).toEqual(canonical);
  });

  it("rejects an invalid base32 character", () => {
    expect(() => base32Decode("ABC1")).toThrow(/Invalid base32/);
  });

  it("formats a secret into spaced quads", () => {
    expect(formatSecretForDisplay("abcdefgh")).toBe("ABCD EFGH");
  });
});

describe("totp / generateOathSecret", () => {
  it("produces a 32-char base32 secret by default (20 bytes)", () => {
    const s = generateOathSecret();
    expect(s).toHaveLength(32);
    expect(s).toMatch(/^[A-Z2-7]+$/);
  });

  it("produces distinct secrets across calls", () => {
    expect(generateOathSecret()).not.toBe(generateOathSecret());
  });

  it("rejects an out-of-range length", () => {
    expect(() => generateOathSecret(4)).toThrow(/\[10, 64\]/);
  });
});

describe("totp / computeTotp — RFC 6238 reference vectors", () => {
  // RFC 6238 Appendix B uses the ASCII seed "12345678901234567890".
  const SEED_BASE32 = base32Encode(
    Uint8Array.from("12345678901234567890", (c) => c.charCodeAt(0)),
  );

  it("encodes the RFC seed to the canonical base32 value", () => {
    expect(SEED_BASE32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  // [unix seconds, expected 8-digit TOTP] from RFC 6238 Appendix B (SHA-1).
  const VECTORS: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it.each(VECTORS)("T=%i → 8-digit %s", async (t, expected) => {
    const { code } = await computeTotp(SEED_BASE32, {
      atMs: t * 1000,
      digits: 8,
      periodSeconds: 30,
      algorithm: "SHA-1",
    });
    expect(code).toBe(expected);
  });

  it("derives the 6-digit code as the low 6 digits of the 8-digit code", async () => {
    const { code } = await computeTotp(SEED_BASE32, {
      atMs: 59 * 1000,
      digits: 6,
    });
    expect(code).toBe("287082");
  });

  it("reports seconds-remaining within the period", async () => {
    const { secondsRemaining } = await computeTotp(SEED_BASE32, {
      atMs: 59 * 1000,
      periodSeconds: 30,
    });
    // epoch 59s → 29s elapsed into the 2nd step → 1s remaining.
    expect(secondsRemaining).toBe(1);
  });
});

describe("totp / buildOtpAuthUri", () => {
  it("emits a spec-compliant otpauth URI", () => {
    const uri = buildOtpAuthUri({
      secret: "jbsw y3dp",
      accountName: "alice@contoso.com",
      issuer: "Contoso",
    });
    expect(uri).toMatch(
      /^otpauth:\/\/totp\/Contoso:alice%40contoso\.com\?/,
    );
    expect(uri).toContain("secret=JBSWY3DP");
    expect(uri).toContain("issuer=Contoso");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
