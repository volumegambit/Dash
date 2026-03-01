import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentDeployment } from '../types.js';

export class AgentRegistry {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'agents.json');
  }

  private async load(): Promise<AgentDeployment[]> {
    if (!existsSync(this.filePath)) return [];
    const raw = await readFile(this.filePath, 'utf-8');
    return JSON.parse(raw) as AgentDeployment[];
  }

  private async save(deployments: AgentDeployment[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(deployments, null, 2));
  }

  async list(): Promise<AgentDeployment[]> {
    return this.load();
  }

  async get(id: string): Promise<AgentDeployment | null> {
    const deployments = await this.load();
    return deployments.find((d) => d.id === id) ?? null;
  }

  async add(deployment: AgentDeployment): Promise<void> {
    const deployments = await this.load();
    if (deployments.some((d) => d.id === deployment.id)) {
      throw new Error(`Deployment "${deployment.id}" already exists`);
    }
    deployments.push(deployment);
    await this.save(deployments);
  }

  async update(id: string, patch: Partial<AgentDeployment>): Promise<void> {
    const deployments = await this.load();
    const index = deployments.findIndex((d) => d.id === id);
    if (index === -1) {
      throw new Error(`Deployment "${id}" not found`);
    }
    deployments[index] = { ...deployments[index], ...patch };
    await this.save(deployments);
  }

  async remove(id: string): Promise<void> {
    const deployments = await this.load();
    const filtered = deployments.filter((d) => d.id !== id);
    if (filtered.length === deployments.length) {
      throw new Error(`Deployment "${id}" not found`);
    }
    await this.save(filtered);
  }
}
