interface SessionClient {
  session: {
    list(): Promise<{ data: { id: string; title: string }[] | undefined }>;
    create(params: { title: string }): Promise<{ data: { id: string } | undefined }>;
  };
}

export class SessionIdMap {
  private map = new Map<string, string>();

  async init(client: SessionClient): Promise<void> {
    const { data: sessions } = await client.session.list();
    for (const session of sessions ?? []) {
      if (session.title?.includes(':')) {
        this.map.set(session.title, session.id);
      }
    }
  }

  async getOrCreate(channelId: string, conversationId: string, client: SessionClient): Promise<string> {
    const key = `${channelId}:${conversationId}`;
    const existing = this.map.get(key);
    if (existing) return existing;

    const { data: session } = await client.session.create({ title: key });
    if (!session) throw new Error('Failed to create OpenCode session');
    this.map.set(key, session.id);
    return session.id;
  }
}
