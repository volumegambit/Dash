export interface SkillFrontmatter {
  name: string;
  description: string;
  trigger?: string;
  tools?: string[];
  tags?: string[];
  model?: string;
  context?: 'fork';
  'allowed-tools'?: string[];
  dependencies?: string[];
}

export interface SkillDiscoveryResult {
  name: string;
  description: string;
  trigger?: string;
  location: string;
  content: string;
  editable: boolean;
  source: 'managed' | 'agent' | 'remote';
}
