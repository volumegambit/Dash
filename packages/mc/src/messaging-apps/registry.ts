import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MessagingApp } from '../types.js';

export class MessagingAppRegistry {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'messaging-apps.json');
  }

  private async load(): Promise<MessagingApp[]> {
    if (!existsSync(this.filePath)) return [];
    const raw = await readFile(this.filePath, 'utf-8');
    return JSON.parse(raw) as MessagingApp[];
  }

  private async save(apps: MessagingApp[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(apps, null, 2));
  }

  async list(): Promise<MessagingApp[]> {
    return this.load();
  }

  async get(id: string): Promise<MessagingApp | null> {
    const apps = await this.load();
    return apps.find((a) => a.id === id) ?? null;
  }

  async add(app: MessagingApp): Promise<void> {
    const apps = await this.load();
    if (apps.some((a) => a.id === app.id)) {
      throw new Error(`Messaging app "${app.id}" already exists`);
    }
    apps.push(app);
    await this.save(apps);
  }

  async update(id: string, patch: Partial<MessagingApp>): Promise<void> {
    const apps = await this.load();
    const index = apps.findIndex((a) => a.id === id);
    if (index === -1) throw new Error(`Messaging app "${id}" not found`);
    apps[index] = { ...apps[index], ...patch };
    await this.save(apps);
  }

  async remove(id: string): Promise<void> {
    const apps = await this.load();
    const filtered = apps.filter((a) => a.id !== id);
    if (filtered.length === apps.length) throw new Error(`Messaging app "${id}" not found`);
    await this.save(filtered);
  }
}
