import {
  detectRequiredDomains,
  computeDisabledServers,
  createScopedMcpEnvironment,
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
        expect(scopedConfig.mcpServers.playwright.disabled).toBe(true);
        expect(scopedConfig.mcpServers.postgres.disabled).toBe(true);
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
});
