#!/usr/bin/env node
/**
 * Generates a single-plugin marketplace from the repo's skills/ and mcps/ directories.
 *
 * Reads each top-level skill directory containing a SKILL.md and generates:
 *   - .claude-plugin/marketplace.json
 *   - .marketplace/all/.claude-plugin/plugin.json
 *   - .marketplace/all/.mcp.json           (merged from mcps/*\/.mcp.json and skills/*\/.mcp.json)
 *   - .marketplace/all/skills/<name>/...   (copied from skills/<name>/)
 *   - .marketplace/all/mcps/<name>/...     (copied from mcps/<name>/, excluding .mcp.json)
 *   - .marketplace/all/hooks/...           (copied from hooks/, if present)
 *
 * Usage:
 *   node scripts/generate-marketplace.mjs
 *   node scripts/generate-marketplace.mjs --check
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const marketplaceName = "skills-prototype";
const pluginName = "all";
const ownerName = "Test";
const skillsRoot = path.join(repoRoot, "skills");
const mcpsRoot = path.join(repoRoot, "mcps");
const hooksRoot = path.join(repoRoot, "hooks");
const generatedRoot = path.join(repoRoot, ".marketplace");
const pluginRoot = path.join(generatedRoot, pluginName);
const pluginJsonPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
const contentHashPath = path.join(pluginRoot, ".claude-plugin", ".content-hash");
const mergedMcpPath = path.join(pluginRoot, ".mcp.json");
const copiedSkillsRoot = path.join(pluginRoot, "skills");
const copiedMcpsRoot = path.join(pluginRoot, "mcps");
const copiedHooksRoot = path.join(pluginRoot, "hooks");
const marketplacePath = path.join(repoRoot, ".claude-plugin", "marketplace.json");
const checkMode = process.argv.includes("--check");

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  return content.slice(4, end);
}

function extractField(yaml, field) {
  const re = new RegExp(`^\\s*${field}:\\s*(.+)\\s*$`, "m");
  const match = yaml.match(re);
  if (!match) return "";
  return match[1].replace(/^['"]|['"]$/g, "").trim();
}

function discoverSkills() {
  const skills = [];
  if (!fs.existsSync(skillsRoot)) return skills;

  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = path.join(skillsRoot, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    const content = fs.readFileSync(skillMdPath, "utf8");
    const yaml = parseFrontmatter(content);
    const name = yaml ? extractField(yaml, "name") || entry.name : entry.name;

    skills.push({
      dirName: entry.name,
      name,
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function discoverMcps() {
  const mcps = [];
  if (!fs.existsSync(mcpsRoot)) return mcps;

  for (const entry of fs.readdirSync(mcpsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    mcps.push({ dirName: entry.name });
  }

  return mcps.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function stableJsonStringify(value) {
  return JSON.stringify(sortJsonValue(value));
}

function findFilesNamed(rootDir, targetName) {
  const matches = [];
  if (!fs.existsSync(rootDir)) return matches;

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name === targetName) {
        matches.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return matches.sort();
}

function pathFromRepo(filePath) {
  return path.relative(repoRoot, filePath) || ".";
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${pathFromRepo(filePath)}: ${error.message}`);
  }
}

function discoverMcpConfigPaths(skills) {
  const configPaths = [];

  configPaths.push(...findFilesNamed(mcpsRoot, ".mcp.json"));

  for (const skill of skills) {
    const skillRoot = path.join(skillsRoot, skill.dirName);
    configPaths.push(...findFilesNamed(skillRoot, ".mcp.json"));
  }

  return [...new Set(configPaths)].sort();
}

function mergeMcpConfigs(skills) {
  const configPaths = discoverMcpConfigPaths(skills);
  if (configPaths.length === 0) return null;

  const mergedServers = new Map();
  const serverSources = new Map();

  for (const configPath of configPaths) {
    const parsed = readJsonFile(configPath);
    if (!isPlainObject(parsed)) {
      throw new Error(`Expected ${pathFromRepo(configPath)} to contain a JSON object.`);
    }

    const mcpServers = parsed.mcpServers ?? {};
    if (!isPlainObject(mcpServers)) {
      throw new Error(`Expected "mcpServers" in ${pathFromRepo(configPath)} to be an object.`);
    }

    for (const serverName of Object.keys(mcpServers).sort()) {
      const serverConfig = mcpServers[serverName];
      if (!isPlainObject(serverConfig)) {
        throw new Error(
          `Expected mcpServers.${serverName} in ${pathFromRepo(configPath)} to be an object.`,
        );
      }

      const normalizedConfig = sortJsonValue(serverConfig);
      const normalizedConfigString = stableJsonStringify(serverConfig);
      const existingSource = serverSources.get(serverName);

      if (!existingSource) {
        mergedServers.set(serverName, normalizedConfig);
        serverSources.set(serverName, {
          configPath,
          configString: normalizedConfigString,
        });
        continue;
      }

      if (existingSource.configString !== normalizedConfigString) {
        throw new Error(
          `Conflicting MCP server "${serverName}" found in ${pathFromRepo(existingSource.configPath)} and ${pathFromRepo(configPath)}.`,
        );
      }
    }
  }

  return {
    mcpServers: Object.fromEntries(
      [...mergedServers.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function hashDirectory(dir, { skipFileNames } = {}) {
  const skip = new Set(skipFileNames ?? []);
  const hash = crypto.createHash("sha256");
  const entries = [];

  function walk(currentDir, prefix) {
    if (!fs.existsSync(currentDir)) return;

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (
        entry.isDirectory() ||
        (entry.isSymbolicLink() && fs.statSync(fullPath).isDirectory())
      ) {
        walk(fullPath, relativePath);
      } else if (!skip.has(entry.name)) {
        entries.push(relativePath);
      }
    }
  }

  walk(dir, "");
  entries.sort();

  for (const relativePath of entries) {
    hash.update(relativePath);
    hash.update(fs.readFileSync(path.join(dir, relativePath)));
  }

  return hash.digest("hex");
}

function computePluginHash(skills, mcps, mergedMcpConfig) {
  const hash = crypto.createHash("sha256");
  const sortedSkills = [...skills].sort((a, b) => a.dirName.localeCompare(b.dirName));
  const sortedMcps = [...mcps].sort((a, b) => a.dirName.localeCompare(b.dirName));

  for (const skill of sortedSkills) {
    hash.update(`skill:${skill.dirName}`);
    hash.update(hashDirectory(path.join(skillsRoot, skill.dirName)));
  }

  for (const mcp of sortedMcps) {
    hash.update(`mcp:${mcp.dirName}`);
    hash.update(hashDirectory(path.join(mcpsRoot, mcp.dirName), { skipFileNames: [".mcp.json"] }));
  }

  if (fs.existsSync(hooksRoot)) {
    hash.update("hooks");
    hash.update(hashDirectory(hooksRoot));
  }

  hash.update("merged-mcp");
  hash.update(mergedMcpConfig ? stableJsonStringify(mergedMcpConfig) : "");

  return hash.digest("hex");
}

function bumpPatch(version) {
  const parts = version.split(".");
  if (parts.length !== 3) return "1.0.1";

  const patch = Number(parts[2]);
  if (Number.isNaN(patch)) return "1.0.1";

  parts[2] = String(patch + 1);
  return parts.join(".");
}

function resolveVersion(nextHash) {
  const baseVersion = "1.0.0";

  if (!fs.existsSync(pluginJsonPath)) {
    return { version: baseVersion, hashChanged: true };
  }

  let existingVersion = baseVersion;
  try {
    const existingPlugin = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
    existingVersion = existingPlugin.version || baseVersion;
  } catch {
    existingVersion = baseVersion;
  }

  let existingHash = "";
  try {
    existingHash = fs.readFileSync(contentHashPath, "utf8").trim();
  } catch {
    return { version: existingVersion, hashChanged: true };
  }

  if (existingHash === nextHash) {
    return { version: existingVersion, hashChanged: false };
  }

  return { version: bumpPatch(existingVersion), hashChanged: true };
}

function buildPluginDescription(skills) {
  const skillNames = skills.map((skill) => skill.name).join(", ");
  return skillNames ? `Skills: ${skillNames}` : "Skills";
}

function generatePluginJson(skills, version) {
  return {
    name: pluginName,
    version,
    description: buildPluginDescription(skills),
    author: {
      name: ownerName,
    },
  };
}

function generateMarketplaceJson(skills) {
  return {
    name: marketplaceName,
    owner: {
      name: ownerName,
    },
    metadata: {
      description: "Skills and plugins prototype for agents like Claude Code.",
    },
    plugins: [
      {
        name: pluginName,
        source: `./.marketplace/${pluginName}`,
        description: buildPluginDescription(skills),
      },
    ],
  };
}

function writeFileIfChanged(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing === content) return false;
  }

  if (checkMode) return true;
  fs.writeFileSync(filePath, content);
  return true;
}

function writeJsonIfChanged(filePath, data) {
  return writeFileIfChanged(filePath, JSON.stringify(data, null, 2) + "\n");
}

function removeFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return false;
  if (checkMode) return true;
  fs.rmSync(filePath, { force: true });
  return true;
}

function copyDirectoryFiltered(srcPath, destPath, { skipFileNames } = {}) {
  const skip = new Set(skipFileNames ?? []);

  if (!fs.existsSync(destPath)) {
    fs.mkdirSync(destPath, { recursive: true });
  }

  for (const entry of fs.readdirSync(srcPath, { withFileTypes: true })) {
    const from = path.join(srcPath, entry.name);
    const to = path.join(destPath, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryFiltered(from, to, { skipFileNames });
      continue;
    }

    if (skip.has(entry.name)) continue;

    fs.copyFileSync(from, to);
  }
}

function syncDirectoryCopy(destPath, srcPath, { skipFileNames } = {}) {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let needsUpdate = false;
  if (!fs.existsSync(destPath)) {
    needsUpdate = true;
  } else {
    const destStat = fs.lstatSync(destPath);
    if (!destStat.isDirectory() || destStat.isSymbolicLink()) {
      needsUpdate = true;
    } else {
      needsUpdate =
        hashDirectory(srcPath, { skipFileNames }) !== hashDirectory(destPath);
    }
  }

  if (!needsUpdate) return false;
  if (checkMode) return true;

  fs.rmSync(destPath, { recursive: true, force: true });
  if (skipFileNames && skipFileNames.length > 0) {
    copyDirectoryFiltered(srcPath, destPath, { skipFileNames });
  } else {
    fs.cpSync(srcPath, destPath, { recursive: true, dereference: true });
  }
  return true;
}

function cleanupStaleEntries(dir, validNames) {
  if (!fs.existsSync(dir)) return false;

  let changed = false;
  for (const entry of fs.readdirSync(dir)) {
    if (validNames.has(entry)) continue;

    if (checkMode) return true;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    changed = true;
  }

  return changed;
}

function main() {
  const skills = discoverSkills();
  if (skills.length === 0) {
    console.error("No skills found in skills/");
    process.exit(1);
  }

  const mcps = discoverMcps();

  let changed = false;
  const mergedMcpConfig = mergeMcpConfigs(skills);

  const contentHash = computePluginHash(skills, mcps, mergedMcpConfig);
  const { version, hashChanged } = resolveVersion(contentHash);

  if (writeJsonIfChanged(pluginJsonPath, generatePluginJson(skills, version))) {
    changed = true;
    if (!checkMode) {
      const verb = hashChanged ? `Updated (${version})` : "Updated";
      console.log(`  ${verb} ${path.relative(repoRoot, pluginJsonPath)}`);
    }
  }

  if (writeFileIfChanged(contentHashPath, `${contentHash}\n`)) {
    changed = true;
  }

  if (mergedMcpConfig) {
    if (writeJsonIfChanged(mergedMcpPath, mergedMcpConfig)) {
      changed = true;
      if (!checkMode) {
        console.log(`  Updated ${path.relative(repoRoot, mergedMcpPath)}`);
      }
    }
  } else if (removeFileIfExists(mergedMcpPath)) {
    changed = true;
    if (!checkMode) {
      console.log(`  Removed ${path.relative(repoRoot, mergedMcpPath)}`);
    }
  }

  for (const skill of skills) {
    const sourcePath = path.join(skillsRoot, skill.dirName);
    const copiedPath = path.join(copiedSkillsRoot, skill.dirName);

    if (syncDirectoryCopy(copiedPath, sourcePath)) {
      changed = true;
      if (!checkMode) {
        console.log(
          `  Synced ${path.relative(repoRoot, copiedPath)} from ${path.relative(repoRoot, sourcePath)}`,
        );
      }
    }
  }

  for (const mcp of mcps) {
    const sourcePath = path.join(mcpsRoot, mcp.dirName);
    const copiedPath = path.join(copiedMcpsRoot, mcp.dirName);

    if (syncDirectoryCopy(copiedPath, sourcePath, { skipFileNames: [".mcp.json"] })) {
      changed = true;
      if (!checkMode) {
        console.log(
          `  Synced ${path.relative(repoRoot, copiedPath)} from ${path.relative(repoRoot, sourcePath)}`,
        );
      }
    }
  }

  if (fs.existsSync(hooksRoot)) {
    if (syncDirectoryCopy(copiedHooksRoot, hooksRoot)) {
      changed = true;
      if (!checkMode) {
        console.log(
          `  Synced ${path.relative(repoRoot, copiedHooksRoot)} from ${path.relative(repoRoot, hooksRoot)}`,
        );
      }
    }
  } else if (fs.existsSync(copiedHooksRoot)) {
    if (!checkMode) fs.rmSync(copiedHooksRoot, { recursive: true, force: true });
    changed = true;
    if (!checkMode) {
      console.log(`  Removed ${path.relative(repoRoot, copiedHooksRoot)}`);
    }
  }

  if (cleanupStaleEntries(copiedSkillsRoot, new Set(skills.map((skill) => skill.dirName)))) {
    changed = true;
    if (!checkMode) {
      console.log(`  Cleaned stale entries in ${path.relative(repoRoot, copiedSkillsRoot)}`);
    }
  }

  if (fs.existsSync(copiedMcpsRoot)) {
    if (cleanupStaleEntries(copiedMcpsRoot, new Set(mcps.map((mcp) => mcp.dirName)))) {
      changed = true;
      if (!checkMode) {
        console.log(`  Cleaned stale entries in ${path.relative(repoRoot, copiedMcpsRoot)}`);
      }
    }
  }

  if (cleanupStaleEntries(generatedRoot, new Set([pluginName]))) {
    changed = true;
    if (!checkMode) {
      console.log(`  Cleaned stale entries in ${path.relative(repoRoot, generatedRoot)}`);
    }
  }

  if (writeJsonIfChanged(marketplacePath, generateMarketplaceJson(skills))) {
    changed = true;
    if (!checkMode) {
      console.log(`  Updated ${path.relative(repoRoot, marketplacePath)}`);
    }
  }

  if (checkMode) {
    if (changed) {
      console.error(
        "Marketplace files are out of date. Run: node scripts/generate-marketplace.mjs",
      );
      process.exit(1);
    }

    console.log("Marketplace files are up to date.");
    return;
  }

  if (changed) {
    console.log(
      `\nGenerated marketplace with 1 plugin from ${skills.length} skill(s) and ${mcps.length} mcp(s).`,
    );
  } else {
    console.log("Marketplace files are already up to date.");
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
