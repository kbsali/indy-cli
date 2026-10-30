/**
 * Reads one cookie from the Chromium/Chrome cookie store of a logged-in
 * browser (Linux, libsecret), so nobody copies it from DevTools.
 */
import { Database } from "bun:sqlite";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const BROWSERS = {
  chromium: { dir: "chromium", secret: "chromium" },
  chrome: { dir: "google-chrome", secret: "chrome" },
} as const;

export type Browser = keyof typeof BROWSERS;

/**
 * Chromium on Linux: AES-128-CBC, key = PBKDF2-SHA1(password, "saltysalt", 1),
 * IV = 16 spaces. "v11" uses the libsecret password, "v10" the fixed "peanuts".
 * From DB meta version 24 the plaintext starts with SHA-256(host_key).
 */
export function decryptValue(
  encrypted: Uint8Array,
  keys: { v10: Buffer; v11: Buffer },
  metaVersion: number
): string {
  const buffer = Buffer.from(encrypted);
  const prefix = buffer.subarray(0, 3).toString();
  if (prefix !== "v10" && prefix !== "v11") return buffer.toString();
  const decipher = createDecipheriv(
    "aes-128-cbc",
    keys[prefix],
    Buffer.alloc(16, " ")
  );
  const plain = Buffer.concat([
    decipher.update(buffer.subarray(3)),
    decipher.final(),
  ]);
  return plain.subarray(metaVersion >= 24 ? 32 : 0).toString();
}

/** undefined when the browser has no cookie store or no such cookie. */
export function browserCookie(
  host: string,
  name: string,
  browser: Browser = "chromium",
  profile = "Default"
): string | undefined {
  const { dir, secret } = BROWSERS[browser];
  const base = join(homedir(), ".config", dir, profile);
  const path = [join(base, "Network", "Cookies"), join(base, "Cookies")].find(
    existsSync
  );
  if (!path) return undefined;

  const lookup = Bun.spawnSync([
    "secret-tool",
    "lookup",
    "application",
    secret,
  ]);
  const password = lookup.stdout.toString().trim();
  if (lookup.exitCode !== 0 || !password) {
    throw new Error(
      `No "${browser} Safe Storage" password in the keyring (secret-tool lookup application ${secret})`
    );
  }
  const keys = {
    v10: pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1"),
    v11: pbkdf2Sync(password, "saltysalt", 1, 16, "sha1"),
  };

  // The browser keeps the database locked: read a copy.
  const scratch = mkdtempSync(join(tmpdir(), "indy-cookies-"));
  try {
    const copy = join(scratch, "Cookies");
    copyFileSync(path, copy);
    const db = new Database(copy, { readonly: true });
    try {
      const meta = db
        .query("SELECT value FROM meta WHERE key = 'version'")
        .get() as { value: string } | null;
      const row = db
        .query(
          "SELECT encrypted_value FROM cookies WHERE host_key IN (?1, ?2) AND name = ?3 ORDER BY expires_utc DESC"
        )
        .get(host, `.${host}`, name) as {
        encrypted_value: Uint8Array;
      } | null;
      if (!row) return undefined;
      return decryptValue(row.encrypted_value, keys, Number(meta?.value ?? 0));
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
