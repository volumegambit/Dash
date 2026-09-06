import type { MobileAgent, MobileSkill } from '@dash/mobile-contract';
import { type ReactElement, useEffect, useState } from 'react';
import type { MobileRestClient } from '../api/rest.js';

/**
 * Read-only skills browser.
 *
 * Deliberately read-only: the mobile namespace exposes no skill mutation, so
 * there is nothing to save here even if the UI offered it. The value is being
 * able to see what an agent has picked up on its own — a learned skill is
 * marked, and its lessons are readable.
 */

export interface SkillsProps {
  client: Pick<MobileRestClient, 'listAgents' | 'listAgentSkills'>;
}

const SOURCE_LABEL: Record<MobileSkill['source'], string> = {
  agent: 'Learned',
  managed: 'Added',
  remote: 'Installed',
  plugin: 'Built-in',
};

export function Skills({ client }: SkillsProps): ReactElement {
  const [agents, setAgents] = useState<MobileAgent[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const [skills, setSkills] = useState<MobileSkill[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listAgents()
      .then((list: MobileAgent[]) => {
        if (cancelled) return;
        setAgents(list);
        setAgentId((current) => current || (list[0]?.id ?? ''));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .listAgentSkills(agentId)
      .then((list: MobileSkill[]) => {
        if (!cancelled) setSkills(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, agentId]);

  return (
    <section className="skills" aria-label="Skills">
      {agents.length > 1 && (
        <label className="skills-agent-picker">
          Agent
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {error && <p className="skills-error">{error}</p>}
      {loading && <p className="skills-empty">Loading skills…</p>}
      {!loading && !error && skills.length === 0 && (
        <p className="skills-empty">This agent has no skills yet.</p>
      )}

      <ul className="skills-list">
        {skills.map((skill) => {
          const isOpen = expanded === skill.name;
          return (
            <li key={skill.name} className="skills-item" data-skill-source={skill.source}>
              <button
                type="button"
                className="skills-item-header"
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : skill.name)}
              >
                <span className="skills-item-name">{skill.name}</span>
                <span className="skills-item-source">{SOURCE_LABEL[skill.source]}</span>
              </button>
              <p className="skills-item-description">{skill.description}</p>
              {isOpen && skill.content && <pre className="skills-item-body">{skill.content}</pre>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
