import type { AgencyConfig } from "@swisshost/contracts";
import guelphConfig from "../../../config/agencies/guelph.json";
import ttcConfig from "../../../config/agencies/ttc.json";
import goConfig from "../../../config/agencies/go-transit.json";
import thunderbayConfig from "../../../config/agencies/thunderbay.json";
import type { FeedSchedulerDO } from "../../collector/src/feed-scheduler-do";
import type { AgencyLiveDO } from "../../live/src/agency-live-do";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS?: Fetcher;
  FEED_SCHEDULER: DurableObjectNamespace<FeedSchedulerDO>;
  AGENCY_LIVE: DurableObjectNamespace<AgencyLiveDO>;

  APP_NAME: string;
  PUBLIC_ORIGIN: string;
  GITHUB_ARCHIVE_REPO: string;
  GITHUB_ARCHIVE_BRANCH: string;
  DEFAULT_STALE_SECONDS: string;
  DAILY_D1_WRITE_BUDGET: string;
  DAILY_DO_REQUEST_BUDGET: string;
  DAILY_WORKER_REQUEST_BUDGET: string;

  // Optional Secrets (set via wrangler secret put)
  ADMIN_API_TOKEN?: string;
  GITHUB_ARCHIVE_TOKEN?: string;
  GO_TRANSIT_API_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  [secretName: string]: unknown;
}

export const BUILTIN_AGENCIES: AgencyConfig[] = [
  guelphConfig as AgencyConfig,
  ttcConfig as AgencyConfig,
  goConfig as AgencyConfig,
  thunderbayConfig as AgencyConfig,
];

export function getBudgets(env: Env) {
  return {
    d1Writes: Number(env.DAILY_D1_WRITE_BUDGET || "80000"),
    doRequests: Number(env.DAILY_DO_REQUEST_BUDGET || "80000"),
    workerRequests: Number(env.DAILY_WORKER_REQUEST_BUDGET || "80000"),
  };
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) {
    diff |= ab[i]! ^ bb[i]!;
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    key,
    256
  );
  return `pbkdf2$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored || !stored.startsWith("pbkdf2$")) return false;
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const salt = hexToBytes(parts[1]!);
  const expectedHex = parts[2]!;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltCopy = new Uint8Array(salt.byteLength);
  saltCopy.set(salt);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltCopy, iterations: 100_000, hash: "SHA-256" },
    key,
    256
  );
  return timingSafeEqualString(bytesToHex(new Uint8Array(bits)), expectedHex);
}
