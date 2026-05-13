#!/usr/bin/env node
/**
 * Generates a multi-plugin marketplace from the repo's skills/ and mcps/ directories.
 *
 * Plugins emitted:
 *   - `base`: every skill without a `metadata.plugin` field, plus any MCP listed under
 *     `base` in mcps/plugins.json (and any MCP without an entry).
 *   - one plugin per distinct `metadata.plugin` value declared in skill frontmatter
 *     and/or per plugin name appearing in mcps/plugins.json.
 *   - `all`: every skill and every MCP, regardless of declarations.
 *
 * Hooks from hooks/ are copied into every plugin.
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
const ownerName = "Fivetran";
const skillsRoot = path.join(repoRoot, "skills");
const mcpsRoot = path.join(repoRoot, "mcps");
const pluginsRoot = path.join(repoRoot, "plugins");
const mcpsPluginsJsonPath = path.join(mcpsRoot, "plugins.json");
const hooksRoot = path.join(repoRoot, "hooks");
const generatedRoot = path.join(repoRoot, ".marketplace");
const marketplacePath = path.join(repoRoot, ".claude-plugin", "marketplace.json");
const checkMode = process.argv.includes("--check");

const BASE_PLUGIN = "base";
const ALL_PLUGIN = "all";
const RESERVED_PLUGIN_NAMES = new Set([BASE_PLUGIN, ALL_PLUGIN]);

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

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

function parseMetadataField(yaml, field) {
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const inlineMatch = lines[i].match(/^\s*metadata:\s*\{(.*)\}\s*$/);
    if (inlineMatch) {
      const fieldMatch = inlineMatch[1].match(
        new RegExp(`(?:^|,)\\s*${field}:\\s*([^,}]+)\\s*(?:,|$)`),
      );
      return fieldMatch
        ? fieldMatch[1].replace(/^['"]|['"]$/g, "").trim()
        : "";
    }
    const blockMatch = lines[i].match(/^(\s*)metadata:\s*$/);
    if (!blockMatch) continue;
    const metaIndent = blockMatch[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      const indent = (lines[j].match(/^(\s*)/)?.[1] ?? "").length;
      if (indent <= metaIndent) break;
      const fieldMatch = lines[j].match(
        new RegExp(`^\\s*${field}:\\s*(.+)\\s*$`),
      );
      if (fieldMatch) {
        return fieldMatch[1].replace(/^['"]|['"]$/g, "").trim();
      }
    }
    return "";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

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
    const plugin = yaml ? parseMetadataField(yaml, "plugin") : "";
    const shortDescription = yaml ? parseMetadataField(yaml, "short-description") : "";

    if (plugin && RESERVED_PLUGIN_NAMES.has(plugin)) {
      throw new Error(
        `Skill "${entry.name}" declares metadata.plugin="${plugin}", which is reserved. ` +
          `Skills with no metadata.plugin go to "${BASE_PLUGIN}" automatically; every skill is ` +
          `included in "${ALL_PLUGIN}". Pick a different plugin name or remove the field.`,
      );
    }

    skills.push({
      dirName: entry.name,
      name,
      plugin: plugin || "",
      shortDescription,
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

function readMcpsPluginsJson(mcps) {
  const mcpDirs = new Set(mcps.map((m) => m.dirName));
  const mapping = new Map();

  if (!fs.existsSync(mcpsPluginsJsonPath)) {
    return mapping;
  }

  const parsed = readJsonFile(mcpsPluginsJsonPath);
  if (!isPlainObject(parsed)) {
    throw new Error(`Expected ${pathFromRepo(mcpsPluginsJsonPath)} to contain a JSON object.`);
  }

  for (const [mcpName, plugins] of Object.entries(parsed)) {
    if (!Array.isArray(plugins) || !plugins.every((p) => typeof p === "string")) {
      throw new Error(
        `Expected ${pathFromRepo(mcpsPluginsJsonPath)} key "${mcpName}" to be an array of plugin name strings.`,
      );
    }
    if (!mcpDirs.has(mcpName)) {
      console.warn(
        `  ⚠ ${pathFromRepo(mcpsPluginsJsonPath)} references "${mcpName}" but mcps/${mcpName}/ does not exist.`,
      );
      continue;
    }
    for (const plugin of plugins) {
      if (plugin === ALL_PLUGIN) {
        throw new Error(
          `${pathFromRepo(mcpsPluginsJsonPath)}: MCP "${mcpName}" lists "${ALL_PLUGIN}", which is reserved. ` +
            `Every MCP is automatically included in "${ALL_PLUGIN}".`,
        );
      }
    }
    mapping.set(mcpName, plugins);
  }

  return mapping;
}

// ---------------------------------------------------------------------------
// JSON / file utilities
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeObjects(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return sortJsonValue(override);
  }

  const merged = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      merged[key] = mergeObjects(baseValue, overrideValue);
      continue;
    }
    merged[key] = sortJsonValue(overrideValue);
  }

  return sortJsonValue(merged);
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

function pluginManifestOverridePath(pluginName) {
  return path.join(pluginsRoot, pluginName, "plugin.json");
}

function readPluginManifestOverride(pluginName) {
  const overridePath = pluginManifestOverridePath(pluginName);
  if (!fs.existsSync(overridePath)) return null;

  const parsed = readJsonFile(overridePath);
  if (!isPlainObject(parsed)) {
    throw new Error(`Expected ${pathFromRepo(overridePath)} to contain a JSON object.`);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Plugin membership
// ---------------------------------------------------------------------------

/**
 * Collect the full set of plugin names. Always includes `base` and `all`.
 * Adds any plugin name declared via skill frontmatter or mcps/plugins.json.
 */
function collectPluginNames(skills, mcpPluginMap) {
  const names = new Set([BASE_PLUGIN, ALL_PLUGIN]);
  for (const skill of skills) {
    if (skill.plugin) names.add(skill.plugin);
  }
  for (const plugins of mcpPluginMap.values()) {
    for (const plugin of plugins) names.add(plugin);
  }
  return names;
}

function skillsForPlugin(pluginName, skills) {
  if (pluginName === ALL_PLUGIN) return [...skills];
  if (pluginName === BASE_PLUGIN) return skills.filter((s) => !s.plugin);
  return skills.filter((s) => s.plugin === pluginName);
}

function mcpsForPlugin(pluginName, mcps, mcpPluginMap) {
  if (pluginName === ALL_PLUGIN) return [...mcps];

  return mcps.filter((mcp) => {
    const plugins = mcpPluginMap.get(mcp.dirName);
    if (!plugins) {
      // Unlisted MCPs default to `base` (and `all`, handled above).
      return pluginName === BASE_PLUGIN;
    }
    return plugins.includes(pluginName);
  });
}

// ---------------------------------------------------------------------------
// Merged .mcp.json per plugin
// ---------------------------------------------------------------------------

function discoverMcpConfigPathsForPlugin(pluginSkills, pluginMcps) {
  const configPaths = [];

  for (const mcp of pluginMcps) {
    configPaths.push(...findFilesNamed(path.join(mcpsRoot, mcp.dirName), ".mcp.json"));
  }

  for (const skill of pluginSkills) {
    const skillRoot = path.join(skillsRoot, skill.dirName);
    configPaths.push(...findFilesNamed(skillRoot, ".mcp.json"));
  }

  return [...new Set(configPaths)].sort();
}

function mergeMcpConfigs(configPaths) {
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

// ---------------------------------------------------------------------------
// Hashing & versioning
// ---------------------------------------------------------------------------

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

function computePluginHash(pluginName, pluginSkills, pluginMcps, mergedMcpConfig, manifestOverride) {
  const hash = crypto.createHash("sha256");
  const sortedSkills = [...pluginSkills].sort((a, b) => a.dirName.localeCompare(b.dirName));
  const sortedMcps = [...pluginMcps].sort((a, b) => a.dirName.localeCompare(b.dirName));

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

  hash.update("manifest-override");
  hash.update(`plugin:${pluginName}`);
  hash.update(manifestOverride ? stableJsonStringify(manifestOverride) : "");

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

function resolveVersion(pluginJsonPath, contentHashPath, nextHash) {
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

// ---------------------------------------------------------------------------
// Plugin descriptions
// ---------------------------------------------------------------------------

function buildPluginDescription(pluginName, pluginSkills) {
  if (pluginSkills.length === 1) {
    const [only] = pluginSkills;
    return only.shortDescription || only.name;
  }

  const skillNames = pluginSkills.map((skill) => skill.name).join(", ");
  if (pluginName === ALL_PLUGIN) {
    return skillNames ? `All skills: ${skillNames}` : "All skills";
  }
  if (pluginName === BASE_PLUGIN) {
    return skillNames ? `Base skills: ${skillNames}` : "Base skills";
  }
  return skillNames ? `${pluginName} skills: ${skillNames}` : `${pluginName} skills`;
}

function generatePluginJson(pluginName, pluginSkills, version, manifestOverride = null) {
  const generated = {
    name: pluginName,
    version,
    description: buildPluginDescription(pluginName, pluginSkills),
    author: {
      name: ownerName,
    },
  };

  const merged = manifestOverride ? mergeObjects(generated, manifestOverride) : generated;
  return {
    ...merged,
    name: pluginName,
    version,
  };
}

function generateMarketplaceJson(orderedPlugins) {
  return {
    name: marketplaceName,
    owner: {
      name: ownerName,
    },
    metadata: {
      description: "Skills and plugins prototype for agents like Claude Code.",
    },
    plugins: orderedPlugins.map(({ name, skills }) => ({
      name,
      source: `./.marketplace/${name}`,
      description: buildPluginDescription(name, skills),
    })),
  };
}

// ---------------------------------------------------------------------------
// File-system writes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Per-plugin emission
// ---------------------------------------------------------------------------

function emitPlugin(pluginName, pluginSkills, pluginMcps, log) {
  const pluginRoot = path.join(generatedRoot, pluginName);
  const pluginJsonPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  const contentHashPath = path.join(pluginRoot, ".claude-plugin", ".content-hash");
  const mergedMcpPath = path.join(pluginRoot, ".mcp.json");
  const copiedSkillsRoot = path.join(pluginRoot, "skills");
  const copiedMcpsRoot = path.join(pluginRoot, "mcps");
  const copiedHooksRoot = path.join(pluginRoot, "hooks");

  let changed = false;

  const configPaths = discoverMcpConfigPathsForPlugin(pluginSkills, pluginMcps);
  const mergedMcpConfig = mergeMcpConfigs(configPaths);
  const manifestOverride = readPluginManifestOverride(pluginName);

  const contentHash = computePluginHash(
    pluginName,
    pluginSkills,
    pluginMcps,
    mergedMcpConfig,
    manifestOverride,
  );
  const { version, hashChanged } = resolveVersion(pluginJsonPath, contentHashPath, contentHash);

  if (
    writeJsonIfChanged(
      pluginJsonPath,
      generatePluginJson(pluginName, pluginSkills, version, manifestOverride),
    )
  ) {
    changed = true;
    if (!checkMode) {
      const verb = hashChanged ? `Updated (${version})` : "Updated";
      log(`  ${verb} ${path.relative(repoRoot, pluginJsonPath)}`);
    }
  }

  if (writeFileIfChanged(contentHashPath, `${contentHash}\n`)) {
    changed = true;
  }

  if (mergedMcpConfig) {
    if (writeJsonIfChanged(mergedMcpPath, mergedMcpConfig)) {
      changed = true;
      if (!checkMode) log(`  Updated ${path.relative(repoRoot, mergedMcpPath)}`);
    }
  } else if (removeFileIfExists(mergedMcpPath)) {
    changed = true;
    if (!checkMode) log(`  Removed ${path.relative(repoRoot, mergedMcpPath)}`);
  }

  for (const skill of pluginSkills) {
    const sourcePath = path.join(skillsRoot, skill.dirName);
    const copiedPath = path.join(copiedSkillsRoot, skill.dirName);

    if (syncDirectoryCopy(copiedPath, sourcePath)) {
      changed = true;
      if (!checkMode) {
        log(
          `  Synced ${path.relative(repoRoot, copiedPath)} from ${path.relative(repoRoot, sourcePath)}`,
        );
      }
    }
  }

  for (const mcp of pluginMcps) {
    const sourcePath = path.join(mcpsRoot, mcp.dirName);
    const copiedPath = path.join(copiedMcpsRoot, mcp.dirName);

    if (syncDirectoryCopy(copiedPath, sourcePath, { skipFileNames: [".mcp.json"] })) {
      changed = true;
      if (!checkMode) {
        log(
          `  Synced ${path.relative(repoRoot, copiedPath)} from ${path.relative(repoRoot, sourcePath)}`,
        );
      }
    }
  }

  if (fs.existsSync(hooksRoot)) {
    if (syncDirectoryCopy(copiedHooksRoot, hooksRoot)) {
      changed = true;
      if (!checkMode) {
        log(
          `  Synced ${path.relative(repoRoot, copiedHooksRoot)} from ${path.relative(repoRoot, hooksRoot)}`,
        );
      }
    }
  } else if (fs.existsSync(copiedHooksRoot)) {
    if (!checkMode) fs.rmSync(copiedHooksRoot, { recursive: true, force: true });
    changed = true;
    if (!checkMode) log(`  Removed ${path.relative(repoRoot, copiedHooksRoot)}`);
  }

  if (cleanupStaleEntries(copiedSkillsRoot, new Set(pluginSkills.map((s) => s.dirName)))) {
    changed = true;
    if (!checkMode) log(`  Cleaned stale entries in ${path.relative(repoRoot, copiedSkillsRoot)}`);
  }

  if (fs.existsSync(copiedMcpsRoot)) {
    if (cleanupStaleEntries(copiedMcpsRoot, new Set(pluginMcps.map((m) => m.dirName)))) {
      changed = true;
      if (!checkMode) log(`  Cleaned stale entries in ${path.relative(repoRoot, copiedMcpsRoot)}`);
    }
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function orderPlugins(pluginNames) {
  const named = [...pluginNames]
    .filter((n) => !RESERVED_PLUGIN_NAMES.has(n))
    .sort((a, b) => a.localeCompare(b));
  return [BASE_PLUGIN, ...named, ALL_PLUGIN];
}

function main() {
  const skills = discoverSkills();
  if (skills.length === 0) {
    console.error("No skills found in skills/");
    process.exit(1);
  }

  const mcps = discoverMcps();
  const mcpPluginMap = readMcpsPluginsJson(mcps);
  const pluginNames = collectPluginNames(skills, mcpPluginMap);
  const ordered = orderPlugins(pluginNames);

  let changed = false;
  const orderedForMarketplace = [];

  for (const pluginName of ordered) {
    const pluginSkills = skillsForPlugin(pluginName, skills);
    const pluginMcps = mcpsForPlugin(pluginName, mcps, mcpPluginMap);
    orderedForMarketplace.push({ name: pluginName, skills: pluginSkills });

    if (!checkMode) console.log(`Plugin: ${pluginName}`);
    if (emitPlugin(pluginName, pluginSkills, pluginMcps, console.log)) {
      changed = true;
    }
  }

  if (cleanupStaleEntries(generatedRoot, new Set(ordered))) {
    changed = true;
    if (!checkMode) console.log(`  Cleaned stale entries in ${path.relative(repoRoot, generatedRoot)}`);
  }

  if (writeJsonIfChanged(marketplacePath, generateMarketplaceJson(orderedForMarketplace))) {
    changed = true;
    if (!checkMode) console.log(`  Updated ${path.relative(repoRoot, marketplacePath)}`);
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
      `\nGenerated marketplace with ${ordered.length} plugin(s) from ${skills.length} skill(s) and ${mcps.length} mcp(s).`,
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
