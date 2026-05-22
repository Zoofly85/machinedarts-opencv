import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const flavor = String(process.argv[2] || "").trim().toLowerCase();
const validFlavors = new Set(["home", "opencv", "club-board", "club-master"]);
if (!validFlavors.has(flavor)) {
  console.error("[ERROR] Missing or invalid flavor. Use: home | opencv | club-board | club-master");
  process.exit(1);
}

function normalizeUpdaterPubkey(raw) {
  // Tauri updater expects the base64-encoded updater public key blob.
  // Keep content as-is except trimming and optional UTF-8 BOM removal.
  let key = String(raw || "").trim();
  if (key.charCodeAt(0) === 0xfeff) {
    key = key.slice(1);
  }
  return key;
}

function decodeBase64Utf8(raw) {
  try {
    return Buffer.from(String(raw || "").trim(), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function looksLikeSecretKeyBlob(raw) {
  const txt = decodeBase64Utf8(raw);
  return txt.includes("encrypted secret key");
}

const homeDir = os.homedir();
const defaultPubkeyPath = path.join(homeDir, ".tauri", "machine-darts-updater.pubkey");
const defaultPubkeyPathAlt = path.join(homeDir, ".tauri", "machine-darts-updater.key.pub");
const defaultPrivateKeyPath = path.join(homeDir, ".tauri", "machine-darts-updater.key");
const allowUnsigned =
  String(process.env.MACHINE_DARTS_TAURI_ALLOW_UNSIGNED || "").trim() === "1";

let pubkey = "";
if (fs.existsSync(defaultPubkeyPathAlt) || fs.existsSync(defaultPubkeyPath)) {
  // Prefer .key.pub first (it is the canonical Tauri-generated public key artifact).
  const chosenPubkeyPath = fs.existsSync(defaultPubkeyPathAlt) ? defaultPubkeyPathAlt : defaultPubkeyPath;
  pubkey = fs.readFileSync(chosenPubkeyPath, "utf8").trim();
  console.log(`[INFO] Loaded updater pubkey from ${chosenPubkeyPath}`);
} else {
  pubkey =
    process.env.MACHINE_DARTS_TAURI_UPDATER_PUBKEY ||
    process.env.TAURI_UPDATER_PUBKEY ||
    "";
}

if (pubkey.trim() && looksLikeSecretKeyBlob(pubkey)) {
  console.error("[ERROR] Updater pubkey value contains a secret-key blob. Fix your pubkey file/env.");
  process.exit(1);
}

// If raw minisign key is provided (starts with RW...), wrap it and convert to
// the base64 blob format expected by this Tauri updater configuration.
if (/^RW[A-Za-z0-9+/=]+$/.test(pubkey.trim())) {
  const wrapped = `untrusted comment: minisign public key\n${pubkey.trim()}\n`;
  pubkey = Buffer.from(wrapped, "utf8").toString("base64");
  console.log("[INFO] Converted raw updater public key to base64 updater blob.");
}

pubkey = normalizeUpdaterPubkey(pubkey);
if (pubkey) {
  process.env.MACHINE_DARTS_TAURI_UPDATER_PUBKEY = pubkey;
  process.env.TAURI_UPDATER_PUBKEY = pubkey;
}

if (!process.env.TAURI_SIGNING_PRIVATE_KEY && fs.existsSync(defaultPrivateKeyPath)) {
  process.env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(defaultPrivateKeyPath, "utf8");
  console.log(`[INFO] Loaded signing private key from ${defaultPrivateKeyPath}`);
}
const bundles = (process.env.MACHINE_DARTS_TAURI_BUNDLES || "nsis").trim();
const updaterManifestName = String(
  process.env.MACHINE_DARTS_UPDATER_MANIFEST_NAME || "latest.json"
).trim();

if (!pubkey.trim() && !allowUnsigned) {
  console.error(
    "[ERROR] Updater pubkey missing. Set MACHINE_DARTS_TAURI_UPDATER_PUBKEY (or TAURI_UPDATER_PUBKEY) before building."
  );
  process.exit(1);
}

const repoRoot = process.cwd();
const srcConfig = path.join(repoRoot, "src-tauri", `tauri.${flavor}.conf.json`);
if (!fs.existsSync(srcConfig)) {
  console.error(`[ERROR] Tauri config not found: ${srcConfig}`);
  process.exit(1);
}

// Keep generated config in src-tauri root so all relative paths resolve exactly
// like the base tauri.<flavor>.conf.json.
const generatedDir = path.join(repoRoot, "src-tauri");
fs.mkdirSync(generatedDir, { recursive: true });
const outConfig = path.join(generatedDir, `tauri.${flavor}.conf.generated.json`);

/** @type {any} */
const cfg = JSON.parse(fs.readFileSync(srcConfig, "utf8"));
const secureModelsResource = process.env.MACHINE_DARTS_SECURE_MODELS_RESOURCE || "";
if (secureModelsResource.trim()) {
  const resources = Array.isArray(cfg.bundle?.resources) ? cfg.bundle.resources : [];
  cfg.bundle = cfg.bundle || {};
  cfg.bundle.resources = resources.map((resource) =>
    resource === "../../models" ? secureModelsResource.trim() : resource
  );
  console.log(`[INFO] Using secure models resource: ${secureModelsResource.trim()}`);
}
const resourcesAfterSecureRewrite = Array.isArray(cfg.bundle?.resources) ? cfg.bundle.resources : [];
if (resourcesAfterSecureRewrite.includes("../../models")) {
  console.error("[ERROR] Refusing to build installer with raw ../../models resource. Use build/secure-models/models.");
  process.exit(1);
}
cfg.plugins = cfg.plugins || {};
if (pubkey.trim()) {
  cfg.plugins.updater = cfg.plugins.updater || {};
  cfg.plugins.updater.pubkey = pubkey.trim();
  const currentEndpoints = Array.isArray(cfg.plugins.updater.endpoints)
    ? cfg.plugins.updater.endpoints.filter((x) => typeof x === "string" && x.trim().length > 0)
    : [];
  if (currentEndpoints.length > 0) {
    const first = currentEndpoints[0].trim();
    const rewritten = first.replace(/\/latest\.json$/i, `/${updaterManifestName}`);
    cfg.plugins.updater.endpoints = [rewritten];
    console.log(`[INFO] Updater endpoint manifest: ${updaterManifestName}`);
  }
} else if (allowUnsigned) {
  // Linux/dev builds can skip updater signing to avoid blocking local packaging.
  delete cfg.plugins.updater;
  console.log("[WARN] Updater pubkey missing; building unsigned bundle (updater disabled).");
}
fs.writeFileSync(outConfig, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

console.log(`[INFO] Generated updater-aware config: ${outConfig}`);
console.log(`[INFO] Tauri bundles: ${bundles}`);

const outConfigArg = path.relative(repoRoot, outConfig).replace(/\\/g, "/");

const result =
  process.platform === "win32"
    ? spawnSync(
        process.env.ComSpec || "cmd.exe",
        [
          "/d",
          "/s",
          "/c",
          `npx tauri build --config ${outConfigArg} --bundles ${bundles}`,
        ],
        {
          stdio: "inherit",
          cwd: repoRoot,
          env: process.env,
          shell: false,
        }
      )
    : spawnSync(
        "npx",
        ["tauri", "build", "--config", outConfigArg, "--bundles", bundles],
        {
          stdio: "inherit",
          cwd: repoRoot,
          env: process.env,
          shell: false,
        }
      );

if (typeof result.status === "number") {
  if (result.status !== 0 && result.error) {
    console.error(`[ERROR] Failed to run tauri build command: ${result.error.message}`);
  }
  process.exit(result.status);
}
if (result.error) {
  console.error(`[ERROR] Failed to run tauri build command: ${result.error.message}`);
}
process.exit(1);
