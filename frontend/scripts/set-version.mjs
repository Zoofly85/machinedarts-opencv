import fs from "node:fs";
import path from "node:path";

const rawVersion = String(process.argv[2] || "").trim();
const semverLike = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

if (!semverLike.test(rawVersion)) {
  console.error("[ERROR] Invalid version. Use semver, e.g. 1.1.0 or 1.1.1-beta.1");
  process.exit(1);
}

const repoRoot = process.cwd();
const targets = [
  "package.json",
  path.join("src-tauri", "Cargo.toml"),
  path.join("src-tauri", "tauri.conf.json"),
  path.join("src-tauri", "tauri.home.conf.json"),
  path.join("src-tauri", "tauri.opencv.conf.json"),
  path.join("src-tauri", "tauri.club-board.conf.json"),
  path.join("src-tauri", "tauri.club-master.conf.json"),
];

for (const rel of targets) {
  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full)) {
    console.error(`[ERROR] Missing file: ${full}`);
    process.exit(1);
  }
  if (rel.endsWith("Cargo.toml")) {
    const toml = fs.readFileSync(full, "utf8");
    const lines = toml.split(/\r?\n/);
    const pkgStart = lines.findIndex((line) => line.trim() === "[package]");
    if (pkgStart < 0) {
      console.error(`[ERROR] Could not find [package] section in ${rel}`);
      process.exit(1);
    }
    let replaced = false;
    for (let i = pkgStart + 1; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) break;
      if (/^version\s*=/.test(trimmed)) {
        lines[i] = `version = "${rawVersion}"`;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      console.error(`[ERROR] Could not find [package] version in ${rel}`);
      process.exit(1);
    }
    const nextToml = `${lines.join("\n")}\n`;
    fs.writeFileSync(full, nextToml, "utf8");
    console.log(`[OK] ${rel} -> ${rawVersion}`);
    continue;
  }

  const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
  parsed.version = rawVersion;
  fs.writeFileSync(full, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  console.log(`[OK] ${rel} -> ${rawVersion}`);
}

console.log("");
console.log(`[DONE] Version set to ${rawVersion} in frontend + Tauri configs.`);
