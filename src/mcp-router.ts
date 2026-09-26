import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type McpDomain =
  | 'browser'
  | 'database'
  | 'notebooks'
  | 'web_search'
  | 'vcs'
  | 'monitoring'
  | 'general';

export interface ScopedMcpResult {
  homeDir: string;
  disabledServers: string[];
  activeDomains: string[];
  cleanup: () => void;
}

const DOMAIN_KEYWORDS: Record<McpDomain, RegExp[]> = {
  browser: [
    /\bbrowsers?\b/i,
    /\bplaywright\b/i,
    /\bwebpages?\b/i,
    /\bdom\b/i,
    /\bscreenshots?\b/i,
    /\be2e\b/i,
    /\bheadless\b/i,
    /\bclick(?:ing)?\b/i,
    /\bnavigate\b/i,
  ],
  database: [
    /\bpostgres(?:ql)?\b/i,
    /\bsqlite\b/i,
    /\bsupabase\b/i,
    /\bdatabases?\b/i,
    /\bsql\b/i,
    /\btables?\b/i,
    /\bmigrations?\b/i,
    /\bqueries\b/i,
  ],
  notebooks: [
    /\bnotebooks?\b/i,
    /\bipynb\b/i,
    /\bjupyter\b/i,
    /\bcells?\b/i,
    /\bdata-agent-kit\b/i,
  ],
  web_search: [
    /\bsearch\b/i,
    /\bcrawl(?:ing)?\b/i,
    /\bscrape?r?(?:ing)?\b/i,
    /\bfirecrawl\b/i,
    /\bexa\b/i,
    /\bfetch\s+url\b/i,
  ],
  vcs: [
    /\bgit\b/i,
    /\bgithub\b/i,
    /\bcommits?\b/i,
    /\bpull\s*requests?\b/i,
    /\bbranch(?:es)?\b/i,
  ],
  monitoring: [/\bsentry\b/i, /\berror tracking\b/i, /\bincidents?\b/i],
  general: [
    /\boverlord\b/i,
    /\bmagic\b/i,
    /\bhyperlambda\b/i,
    /\bcapabilities?\b/i,
    /\bcontext\b/i,
  ],
};

const SERVER_DOMAIN_MAP: Record<string, McpDomain> = {
  playwright: 'browser',
  postgres: 'database',
  sqlite: 'database',
  supabase: 'database',
  notebooks: 'notebooks',
  'data-agent-kit': 'notebooks',
  visualization: 'notebooks',
  sentry: 'monitoring',
  exa: 'web_search',
  firecrawl: 'web_search',
  git: 'vcs',
  github: 'vcs',
  'magic-hyperlambda': 'general',
  'overlord-context': 'general',
  'overlord-capabilities': 'general',
};

// Heavy server namespaces that add significant schema tokens
const HEAVY_SERVERS = new Set([
  'playwright',
  'postgres',
  'sqlite',
  'supabase',
  'notebooks',
  'data-agent-kit',
  'visualization',
  'sentry',
  'magic-hyperlambda',
  'overlord-context',
  'overlord-capabilities',
]);

/**
 * Detects which functional domains are relevant to a given prompt.
 */
export function detectRequiredDomains(prompt: string): Set<McpDomain> {
  const domains = new Set<McpDomain>();
  if (!prompt) return domains;

  for (const [domain, patterns] of Object.entries(DOMAIN_KEYWORDS) as [McpDomain, RegExp[]][]) {
    for (const pattern of patterns) {
      if (pattern.test(prompt)) {
        domains.add(domain);
        break;
      }
    }
  }

  return domains;
}

/**
 * Computes which MCP servers should be disabled for a given set of required domains.
 */
export function computeDisabledServers(
  allServerNames: string[],
  requiredDomains: Set<McpDomain>,
): string[] {
  const toDisable: string[] = [];

  for (const name of allServerNames) {
    if (!HEAVY_SERVERS.has(name)) {
      continue;
    }
    const domain = SERVER_DOMAIN_MAP[name];
    if (domain && !requiredDomains.has(domain)) {
      toDisable.push(name);
    }
  }

  return toDisable;
}

/** `auto` gates heavy servers by prompt keywords, `none` starts no MCP servers, `all` leaves the real config. */
export type McpMode = 'auto' | 'none' | 'all';

/** Reads the MCP mode from ACP `_meta` (`_meta.agyRouter.mcp` or `_meta.mcp`). */
export function parseMcpMode(meta: unknown, fallback: McpMode = 'auto'): McpMode {
  if (!meta || typeof meta !== 'object') return fallback;
  const m = meta as Record<string, unknown>;
  const router = m['agyRouter'];
  const raw = router && typeof router === 'object' ? (router as Record<string, unknown>)['mcp'] : m['mcp'];
  if (raw === undefined || raw === null) return fallback;
  const v = String(raw).toLowerCase();
  if (v === 'none' || v === 'off' || v === 'false') return 'none';
  if (v === 'all' || v === 'on' || v === 'true') return 'all';
  if (v === 'auto') return 'auto';
  return fallback;
}

export interface CreateScopedMcpOptions {
  prompt: string;
  enabled?: boolean;
  mode?: McpMode;
  baseHome?: string;
  configPath?: string;
  /** Where reusable scoped homes live. Defaults to ~/.gemini-acp-server/scoped-homes. */
  stateDir?: string;
}

// Real-home entries that tools rely on. Symlinked (never copied) so caches and credentials are shared.
// .npm matters most: npx installs MCP packages there, and a private per-turn copy re-downloads
// hundreds of MB every turn.
const SHARED_HOME_ENTRIES = ['.npm', '.cache', '.config', '.local', '.ssh', '.gitconfig', '.git-credentials'];
const STALE_HOME_MS = 30 * 24 * 3_600_000;

interface CachedMcpConfig {
  signature: string;
  raw: string;
  config: { mcpServers?: Record<string, Record<string, unknown>> };
}

const configCache = new Map<string, CachedMcpConfig>();
const scopedHomeSourceCache = new Map<string, string>();

function linkIfMissing(target: string, linkPath: string): void {
  try {
    fs.lstatSync(linkPath);
  } catch {
    try {
      fs.symlinkSync(target, linkPath);
    } catch {
      // raced with another process creating the same link
    }
  }
}

/** Creates (or refreshes) `.gemini` inside a scoped home: real dir of symlinks, with a generated mcp config. */
function populateScopedHome(home: string, baseHome: string, modifiedConfig: unknown): void {
  const scopedGemini = path.join(home, '.gemini');
  fs.mkdirSync(scopedGemini, { recursive: true });
  const realGemini = path.join(baseHome, '.gemini');
  if (fs.existsSync(realGemini)) {
    for (const item of fs.readdirSync(realGemini)) {
      if (item === 'config') continue;
      linkIfMissing(path.join(realGemini, item), path.join(scopedGemini, item));
    }
  }
  const scopedConfig = path.join(scopedGemini, 'config');
  fs.mkdirSync(scopedConfig, { recursive: true });
  const realConfig = path.join(realGemini, 'config');
  if (fs.existsSync(realConfig)) {
    for (const item of fs.readdirSync(realConfig)) {
      if (item !== 'mcp_config.json') linkIfMissing(path.join(realConfig, item), path.join(scopedConfig, item));
    }
  }
  fs.writeFileSync(path.join(scopedConfig, 'mcp_config.json'), JSON.stringify(modifiedConfig, null, 2));

  for (const entry of SHARED_HOME_ENTRIES) {
    const real = path.join(baseHome, entry);
    if (fs.existsSync(real)) linkIfMissing(real, path.join(home, entry));
  }
  // make sure npx always has a shared cache to write into, even on a fresh machine
  const npm = path.join(baseHome, '.npm');
  if (!fs.existsSync(npm)) {
    fs.mkdirSync(npm, { recursive: true });
    linkIfMissing(npm, path.join(home, '.npm'));
  }
}

function pruneStaleHomes(stateDir: string, keep: string): void {
  try {
    for (const name of fs.readdirSync(stateDir)) {
      const dir = path.join(stateDir, name);
      if (dir === keep) continue;
      if (Date.now() - fs.statSync(dir).mtimeMs > STALE_HOME_MS) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // pruning is best-effort
  }
}

function readMcpConfig(file: string): CachedMcpConfig | undefined {
  try {
    const stat = fs.statSync(file);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const cached = configCache.get(file);
    if (cached?.signature === signature) return cached;
    const raw = fs.readFileSync(file, 'utf8');
    const config = JSON.parse(raw) as { mcpServers?: Record<string, Record<string, unknown>> };
    const next = { signature, raw, config };
    configCache.set(file, next);
    return next;
  } catch {
    return undefined;
  }
}

function homeSourceSignature(baseHome: string): string {
  const gemini = path.join(baseHome, '.gemini');
  const config = path.join(gemini, 'config');
  try {
    return `${fs.statSync(gemini).mtimeMs}:${fs.statSync(config).mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/**
 * Returns a HOME for one agy turn in which unneeded MCP servers are disabled.
 *
 * The home is persistent and shared: it is keyed by the MCP config content plus the set of disabled
 * servers, built once, and reused by every later turn (and by concurrent turns). Nothing is created
 * or deleted per turn, so /tmp is never touched and there is no cleanup race between parallel turns.
 */
export function createScopedMcpEnvironment(options: CreateScopedMcpOptions): ScopedMcpResult {
  const baseHome = options.baseHome || process.env.HOME || os.homedir();
  const noopResult: ScopedMcpResult = { homeDir: baseHome, disabledServers: [], activeDomains: [], cleanup: () => {} };
  const mode: McpMode = options.mode ?? 'auto';

  if (options.enabled === false || mode === 'all') return noopResult;

  const realMcpConfigFile = options.configPath || path.join(baseHome, '.gemini', 'config', 'mcp_config.json');
  const cachedConfig = readMcpConfig(realMcpConfigFile);
  if (!cachedConfig) return noopResult;
  const { raw: rawConfig, config: mcpConfig } = cachedConfig;

  const serverNames = Object.keys(mcpConfig.mcpServers ?? {});
  if (serverNames.length === 0) return noopResult;

  const requiredDomains = mode === 'none' ? new Set<McpDomain>() : detectRequiredDomains(options.prompt);
  const disabledServers = mode === 'none' ? serverNames : computeDisabledServers(serverNames, requiredDomains);
  const activeDomains = Array.from(requiredDomains);
  if (disabledServers.length === 0) return { ...noopResult, activeDomains };

  const key = createHash('sha1').update(rawConfig).update('\0').update([...disabledServers].sort().join(',')).digest('hex').slice(0, 16);
  const stateDir = options.stateDir || path.join(baseHome, '.gemini-acp-server', 'scoped-homes');
  const home = path.join(stateDir, key);

  try {
    // agy still launches servers marked `disabled: true` (measured: ~35 s of startup for 14 servers, versus
    // ~5 s with none configured), so excluded servers must be removed from the config, not flagged.
    const modified = JSON.parse(rawConfig) as { mcpServers: Record<string, Record<string, unknown>> };
    for (const name of disabledServers) {
      delete modified.mcpServers[name];
    }
    const cacheKey = `${stateDir}\0${home}`;
    const sourceSignature = homeSourceSignature(baseHome);
    if (!fs.existsSync(home)) {
      fs.mkdirSync(stateDir, { recursive: true });
      const staging = fs.mkdtempSync(path.join(stateDir, '.build-'));
      populateScopedHome(staging, baseHome, modified);
      try {
        fs.renameSync(staging, home);
      } catch {
        fs.rmSync(staging, { recursive: true, force: true }); // another process built it first
      }
      pruneStaleHomes(stateDir, home);
      scopedHomeSourceCache.set(cacheKey, sourceSignature);
    } else if (scopedHomeSourceCache.get(cacheKey) !== sourceSignature) {
      // real .gemini gains entries over time (conversations, caches); keep the links current
      populateScopedHome(home, baseHome, modified);
      scopedHomeSourceCache.set(cacheKey, sourceSignature);
    }
    return { homeDir: home, disabledServers, activeDomains, cleanup: () => {} };
  } catch {
    return noopResult; // if scoping fails for any reason, run with the normal home
  }
}
