import {
  detectRequiredDomains,
  computeDisabledServers,
  createScopedMcpEnvironment,
  parseMcpMode,
} from '../mcp-router.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('McpRouter', () => {
  describe('detectRequiredDomains', () => {
    it('detects browser automation keywords', () => {
      const domains = detectRequiredDomains('Please click the button and take a screenshot in playwright');
      expect(domains.has('browser')).toBe(true);
      expect(domains.has('database')).toBe(false);
    });

    it('detects database keywords', () => {
      const domains = detectRequiredDomains('Query the users table in postgresql database');
      expect(domains.has('database')).toBe(true);
      expect(domains.has('browser')).toBe(false);
    });

    it('detects notebooks keywords', () => {
      const domains = detectRequiredDomains('Run the first cell in data analysis notebook ipynb');
      expect(domains.has('notebooks')).toBe(true);
    });

    it('detects web search keywords', () => {
      const domains = detectRequiredDomains('Search for the latest release with exa or firecrawl');
      expect(domains.has('web_search')).toBe(true);
    });

    it('returns empty set for pure coding tasks', () => {
      const domains = detectRequiredDomains('Refactor parseArgs to support additional flags');
      expect(domains.has('browser')).toBe(false);
      expect(domains.has('database')).toBe(false);
      expect(domains.has('notebooks')).toBe(false);
    });
  });

  describe('computeDisabledServers', () => {
    const allServers = ['playwright', 'postgres', 'context7', 'git', 'notebooks'];

    it('disables heavy servers when their domain is not required', () => {
      const required = new Set<'browser' | 'database' | 'notebooks' | 'web_search' | 'vcs' | 'general'>(['vcs']);
      const disabled = computeDisabledServers(allServers, required);

      expect(disabled).toContain('playwright');
      expect(disabled).toContain('postgres');
      expect(disabled).toContain('notebooks');
      expect(disabled).not.toContain('git'); // vcs is required
      expect(disabled).not.toContain('context7'); // not a heavy server
    });

    it('retains heavy server when its domain is detected', () => {
      const required = new Set<'browser' | 'database' | 'notebooks' | 'web_search' | 'vcs' | 'general'>(['browser']);
      const disabled = computeDisabledServers(allServers, required);

      expect(disabled).not.toContain('playwright');
      expect(disabled).toContain('postgres');
    });

    it('treats inherited platform servers as opt-in in auto mode', () => {
      const disabled = computeDisabledServers(
        ['magic-hyperlambda', 'overlord-context', 'overlord-capabilities'],
        new Set(),
      );
      expect(disabled).toEqual(expect.arrayContaining([
        'magic-hyperlambda',
        'overlord-context',
        'overlord-capabilities',
      ]));
    });

    it('activates the platform domain when explicitly requested', () => {
      const disabled = computeDisabledServers(
        ['magic-hyperlambda', 'overlord-context', 'overlord-capabilities'],
        detectRequiredDomains('Use Overlord context and Magic Hyperlambda'),
      );
      expect(disabled).toHaveLength(0);
    });
  });

  describe('createScopedMcpEnvironment', () => {
    let tmpHome: string;
    let configPath: string;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-router-test-'));
      const configDir = path.join(tmpHome, '.gemini', 'config');
      fs.mkdirSync(configDir, { recursive: true });
      configPath = path.join(configDir, 'mcp_config.json');

      const initialConfig = {
        mcpServers: {
          playwright: { command: 'npx', args: ['-y', '@playwright/mcp'], disabled: false },
          postgres: { command: 'npx', args: ['-y', 'postgres-mcp'], disabled: false },
          git: { command: 'npx', args: ['-y', 'git-mcp'], disabled: false },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));
    });

    afterEach(() => {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('suppresses unused heavy servers in a scoped sandbox for pure code tasks', () => {
      const result = createScopedMcpEnvironment({
        prompt: 'Fix a type error in index.ts',
        baseHome: tmpHome,
        configPath,
      });

      try {
        expect(result.disabledServers).toContain('playwright');
        expect(result.disabledServers).toContain('postgres');
        expect(result.homeDir).not.toBe(tmpHome);

        const scopedConfig = JSON.parse(
          fs.readFileSync(path.join(result.homeDir, '.gemini', 'config', 'mcp_config.json'), 'utf8'),
        );
        // removed, not flagged: agy launches servers that are merely marked disabled
        expect(scopedConfig.mcpServers.playwright).toBeUndefined();
        expect(scopedConfig.mcpServers.postgres).toBeUndefined();
        expect(scopedConfig.mcpServers.git.disabled).toBe(false);

        // Verify original config file is untouched
        const originalConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(originalConfig.mcpServers.playwright.disabled).toBe(false);
      } finally {
        result.cleanup();
      }
    });

    it('returns unmodified environment when gating is disabled', () => {
      const result = createScopedMcpEnvironment({
        prompt: 'Fix a type error in index.ts',
        enabled: false,
        baseHome: tmpHome,
        configPath,
      });

      expect(result.homeDir).toBe(tmpHome);
      expect(result.disabledServers.length).toBe(0);
      result.cleanup();
    });
  });

  describe('persistent scoped homes', () => {
    let base: string;
    let configPath: string;
    const config = {
      mcpServers: {
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] },
        sentry: { command: 'npx', args: ['-y', '@sentry/mcp-server'] },
        git: { command: 'npx', args: ['-y', 'git-mcp'] },
        context7: { command: 'npx', args: ['-y', 'c7-mcp-server'] },
      },
    };

    beforeEach(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-persist-'));
      fs.mkdirSync(path.join(base, '.gemini', 'config'), { recursive: true });
      fs.mkdirSync(path.join(base, '.gemini', 'antigravity-cli'), { recursive: true });
      fs.mkdirSync(path.join(base, '.npm', '_cacache'), { recursive: true });
      configPath = path.join(base, '.gemini', 'config', 'mcp_config.json');
      fs.writeFileSync(configPath, JSON.stringify(config));
    });
    afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

    it('reuses one home across turns instead of creating a directory per turn', () => {
      const a = createScopedMcpEnvironment({ prompt: 'Fix a bug', baseHome: base, configPath });
      const b = createScopedMcpEnvironment({ prompt: 'Refactor this function', baseHome: base, configPath });
      expect(a.homeDir).toBe(b.homeDir);
      expect(a.homeDir.startsWith(path.join(base, '.gemini-acp-server', 'scoped-homes'))).toBe(true);
      a.cleanup(); // no-op: a finished turn must not delete a home other turns are using
      expect(fs.existsSync(path.join(a.homeDir, '.gemini', 'config', 'mcp_config.json'))).toBe(true);
    });

    it('shares the real npm cache instead of giving each turn a private one', () => {
      const r = createScopedMcpEnvironment({ prompt: 'Fix a bug', baseHome: base, configPath });
      const npm = path.join(r.homeDir, '.npm');
      expect(fs.lstatSync(npm).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(npm)).toBe(fs.realpathSync(path.join(base, '.npm')));
      expect(fs.lstatSync(path.join(r.homeDir, '.gemini', 'antigravity-cli')).isSymbolicLink()).toBe(true);
    });

    it('none mode disables every server; all mode leaves the real home', () => {
      const none = createScopedMcpEnvironment({ prompt: 'Fix a bug', baseHome: base, configPath, mode: 'none' });
      expect(none.disabledServers.sort()).toEqual(['context7', 'git', 'playwright', 'sentry']);
      const scoped = JSON.parse(fs.readFileSync(path.join(none.homeDir, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
      expect(scoped.mcpServers).toEqual({}); // no servers configured means agy starts none
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.git).toBeDefined(); // original untouched
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.git.disabled).toBeUndefined();

      const all = createScopedMcpEnvironment({ prompt: 'Fix a bug', baseHome: base, configPath, mode: 'all' });
      expect(all.homeDir).toBe(base);
      expect(all.disabledServers).toEqual([]);
    });

    it('gates the previously ungated sentry server in auto mode', () => {
      const r = createScopedMcpEnvironment({ prompt: 'Fix a type error', baseHome: base, configPath });
      expect(r.disabledServers).toContain('sentry');
      expect(r.disabledServers).not.toContain('git');
      const withSentry = createScopedMcpEnvironment({ prompt: 'Look up this sentry incident', baseHome: base, configPath });
      expect(withSentry.disabledServers).not.toContain('sentry');
    });

    it('picks up new entries in the real .gemini and rebuilds when the MCP config changes', () => {
      const first = createScopedMcpEnvironment({ prompt: 'Fix a bug', baseHome: base, configPath });
      fs.mkdirSync(path.join(base, '.gemini', 'new-state'));
      const again = createScopedMcpEnvironment({ prompt: 'Fix a bug', baseHome: base, configPath });
      expect(again.homeDir).toBe(first.homeDir);
      expect(fs.existsSync(path.join(again.homeDir, '.gemini', 'new-state'))).toBe(true);

      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { ...config.mcpServers, extra: { command: 'x' } } }));
      const changed = createScopedMcpEnvironment({ prompt: 'Fix a bug', baseHome: base, configPath });
      expect(changed.homeDir).not.toBe(first.homeDir);
    });

    it('falls back to the normal home when there is no MCP config', () => {
      fs.rmSync(configPath);
      const r = createScopedMcpEnvironment({ prompt: 'Fix a bug', baseHome: base, configPath });
      expect(r.homeDir).toBe(base);
    });

    it('handles concurrent turns building the same home', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => Promise.resolve().then(() => createScopedMcpEnvironment({ prompt: 'Fix a bug', baseHome: base, configPath }))),
      );
      expect(new Set(results.map((r) => r.homeDir)).size).toBe(1);
      expect(fs.readdirSync(path.join(base, '.gemini-acp-server', 'scoped-homes')).filter((n) => n.startsWith('.build-'))).toEqual([]);
    });
  });

  describe('parseMcpMode', () => {
    it('reads the mode from _meta with a fallback', () => {
      expect(parseMcpMode({ agyRouter: { mcp: 'none' } })).toBe('none');
      expect(parseMcpMode({ mcp: 'all' })).toBe('all');
      expect(parseMcpMode({ mcp: false })).toBe('none');
      expect(parseMcpMode(undefined)).toBe('auto');
      expect(parseMcpMode({ agyRouter: { mcp: 'bogus' } }, 'none')).toBe('none');
    });
  });
});
