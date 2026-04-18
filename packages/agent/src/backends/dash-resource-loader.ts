/**
 * DashResourceLoader — wraps pi's DefaultResourceLoader to allow dynamic
 * system prompt and skill injection from Dash's configuration.
 *
 * Pi's AgentSession rebuilds its `_baseSystemPrompt` by reading from
 * `resourceLoader.getSystemPrompt()` and `resourceLoader.getSkills()`.
 * This wrapper lets Dash update those values at runtime so they're picked
 * up on the next system prompt rebuild.
 */
import type { ResourceLoader } from '@mariozechner/pi-coding-agent';
import type { Skill } from '@mariozechner/pi-coding-agent';

type ResourceExtensionPaths = Parameters<ResourceLoader['extendResources']>[0];

export class DashResourceLoader implements ResourceLoader {
  private _systemPrompt: string | undefined;
  private _appendSystemPrompt: string[] = [];
  private _extraSkills: Skill[] = [];

  constructor(private inner: ResourceLoader) {}

  /** Set Dash's operator-configured system prompt (replaces pi's default/discovered one). */
  setSystemPrompt(prompt: string | undefined): void {
    this._systemPrompt = prompt;
  }

  /** Set additional system prompt sections (e.g. memory preamble). */
  setAppendSystemPrompt(sections: string[]): void {
    this._appendSystemPrompt = sections;
  }

  /** Set extra skills discovered by Dash (merged with pi's discovered skills). */
  setExtraSkills(skills: Skill[]): void {
    this._extraSkills = skills;
  }

  // ── Overridden methods ──────────────────────────────────────────────

  getSystemPrompt(): string | undefined {
    return this._systemPrompt ?? this.inner.getSystemPrompt();
  }

  getAppendSystemPrompt(): string[] {
    const base = this.inner.getAppendSystemPrompt();
    return [...base, ...this._appendSystemPrompt];
  }

  getSkills(): ReturnType<ResourceLoader['getSkills']> {
    const base = this.inner.getSkills();
    if (this._extraSkills.length === 0) return base;

    // Merge, deduplicating by name (Dash skills take precedence)
    const dashNames = new Set(this._extraSkills.map((s) => s.name));
    const merged = [...this._extraSkills, ...base.skills.filter((s) => !dashNames.has(s.name))];
    return { skills: merged, diagnostics: base.diagnostics };
  }

  // ── Delegated methods ───────────────────────────────────────────────

  getExtensions() {
    return this.inner.getExtensions();
  }

  getPrompts() {
    return this.inner.getPrompts();
  }

  getThemes() {
    return this.inner.getThemes();
  }

  getAgentsFiles() {
    return this.inner.getAgentsFiles();
  }

  extendResources(paths: ResourceExtensionPaths): void {
    this.inner.extendResources(paths);
  }

  async reload(): Promise<void> {
    await this.inner.reload();
  }
}
