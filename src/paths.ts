/**
 * Shared path resolution for token and config storage.
 *
 * New installs write to ~/.minicor/. Existing ~/.laminar/ installs
 * keep working via fallback reads. Once a user re-auths, tokens
 * silently migrate to ~/.minicor/.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MINICOR_DIR = path.join(os.homedir(), ".minicor");
const LEGACY_DIR = path.join(os.homedir(), ".laminar");

export { MINICOR_DIR };

export function getTokenPath(): string {
  const minicorPath = path.join(MINICOR_DIR, "tokens.json");
  if (fs.existsSync(minicorPath)) return minicorPath;
  const legacyPath = path.join(LEGACY_DIR, "tokens.json");
  if (fs.existsSync(legacyPath)) return legacyPath;
  return minicorPath;
}

export function getWriteTokenPath(): string {
  return path.join(MINICOR_DIR, "tokens.json");
}

export function getConfigPath(): string {
  const minicorPath = path.join(MINICOR_DIR, "config.json");
  if (fs.existsSync(minicorPath)) return minicorPath;
  const legacyPath = path.join(LEGACY_DIR, "config.json");
  if (fs.existsSync(legacyPath)) return legacyPath;
  return minicorPath;
}

export function getWriteConfigPath(): string {
  return path.join(MINICOR_DIR, "config.json");
}

export type Region = "us" | "ca";

export function regionToApiBase(region: Region): string {
  return region === "ca"
    ? "https://ca.api.laminar.run"
    : "https://api.laminar.run";
}

export function apiBaseToRegion(apiBase: string): Region {
  return apiBase.includes("ca.api") ? "ca" : "us";
}
