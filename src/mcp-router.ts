import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type McpDomain =
  | 'browser'
  | 'database'
  | 'notebooks'
  | 'web_search'
  | 'vcs'
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
  general: [],
};

const SERVER_DOMAIN_MAP: Record<string, McpDomain> = {
  playwright: 'browser',
  postgres: 'database',
  sqlite: 'database',
  supabase: 'database',
  notebooks: 'notebooks',
  'data-agent-kit': 'notebooks',
  exa: 'web_search',
  firecrawl: 'web_search',
  git: 'vcs',
  github: 'vcs',
};

// Heavy server namespaces that add significant schema tokens
const HEAVY_SERVERS = new Set([
  'playwright',
  'postgres',
  'sqlite',
  'supabase',
  'notebooks',
  'data-agent-kit',
]);

// Cache for scoped MCP environments by domain set hash
const scopedMcpCache = new Map<string, { result: ScopedMcpResult; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minute cache

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

export interface CreateScopedMcpOptions {
  prompt: string;
  enabled?: boolean;
  baseHome?: string;
  configPath?: string;
}

/**
 * Creates an ephemeral scoped home environment disabling heavy, unused MCP servers
 * for pure coding tasks, eliminating redundant system prompt schemas.
 * Uses caching to avoid filesystem ops when domain requirements match prior turns.
 */
export function createScopedMcpEnvironment(
  options: CreateScopedMcpOptions,
): ScopedMcpResult {
  const baseHome = options.baseHome || process.env.HOME || '/home/prime';
  const noopResult: ScopedMcpResult = {
    homeDir: baseHome,
    disabledServers: [],
    activeDomains: [],
    cleanup: () => {},
  };

  if (options.enabled === false) {
    return noopResult;
  }

  const requiredDomains = detectRequiredDomains(options.prompt);
  const domainCacheKey = Array.from(requiredDomains).sort().join(',');

  // Check cache before filesystem ops
  const cached = scopedMcpCache.get(domainCacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.result;
  }

  const realMcpConfigFile =
    options.configPath || path.join(baseHome, '.gemini', 'config', 'mcp_config.json');

  if (!fs.existsSync(realMcpConfigFile)) {
    return noopResult;
  }

  let mcpConfig: any;
  try {
    mcpConfig = JSON.parse(fs.readFileSync(realMcpConfigFile, 'utf8'));
  } catch {
    return noopResult;
  }

  const servers = mcpConfig.mcpServers || {};
  const serverNames = Object.keys(servers);
  if (serverNames.length === 0) {
    return noopResult;
  }

  const disabledServers = computeDisabledServers(serverNames, requiredDomains);

  if (disabledServers.length === 0) {
    const result: ScopedMcpResult = {
      homeDir: baseHome,
      disabledServers: [],
      activeDomains: Array.from(requiredDomains),
      cleanup: () => {},
    };
    scopedMcpCache.set(domainCacheKey, { result, timestamp: Date.now() });
    return result;
  }

  // Create isolated temp directory
  try {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-acp-mcp-'));
    const scopedGemini = path.join(tmpHome, '.gemini');
    fs.mkdirSync(scopedGemini, { recursive: true });

    const realGemini = path.join(baseHome, '.gemini');
    if (fs.existsSync(realGemini)) {
      for (const item of fs.readdirSync(realGemini)) {
        if (item === 'config') {
          const scopedConfig = path.join(scopedGemini, 'config');
          fs.mkdirSync(scopedConfig, { recursive: true });
          const realConfig = path.join(realGemini, 'config');

          for (const cItem of fs.readdirSync(realConfig)) {
            if (cItem === 'mcp_config.json') {
              const modifiedConfig = JSON.parse(JSON.stringify(mcpConfig));
              for (const sName of disabledServers) {
                if (modifiedConfig.mcpServers[sName]) {
                  modifiedConfig.mcpServers[sName].disabled = true;
                }
              }
              fs.writeFileSync(
                path.join(scopedConfig, cItem),
                JSON.stringify(modifiedConfig, null, 2),
              );
            } else {
              fs.symlinkSync(path.join(realConfig, cItem), path.join(scopedConfig, cItem));
            }
          }
        } else {
          fs.symlinkSync(path.join(realGemini, item), path.join(scopedGemini, item));
        }
      }
    }

    const result: ScopedMcpResult = {
      homeDir: tmpHome,
      disabledServers,
      activeDomains: Array.from(requiredDomains),
      cleanup: () => {
        try {
          fs.rmSync(tmpHome, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      },
    };
    scopedMcpCache.set(domainCacheKey, { result, timestamp: Date.now() });
    return result;
  } catch (err) {
    // If sandboxing encounters an issue, fallback to normal home
    return noopResult;
  }
}
