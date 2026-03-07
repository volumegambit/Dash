export interface SessionClient {
  session: {
    list(): Promise<{ data: { id: string; title: string }[] | undefined }>;
    create(params: { title: string }): Promise<{ data: { id: string } | undefined }>;
  };
}

export class SessionIdMap {
  private map = new Map<string, string>();
  private pending = new Map<string, Promise<string>>();

  async init(client: SessionClient): Promise<void> {
    this.map.clear();
    const { data: sessions } = await client.session.list();
    for (const session of sessions ?? []) {
      if (session.title?.includes(':')) {
        this.map.set(session.title, session.id);
      }
    }
  }

  async getOrCreate(
    channelId: string,
    conversationId: string,
    client: SessionClient,
  ): Promise<string> {
    const key = `${channelId}:${conversationId}`;
    const existing = this.map.get(key);
    if (existing) return existing;

    // Deduplicate concurrent calls for the same key
    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const promise = client.session.create({ title: key }).then(({ data: session }) => {
      if (!session) throw new Error('Failed to create OpenCode session');
      this.map.set(key, session.id);
      this.pending.delete(key);
      return session.id;
    });

    this.pending.set(key, promise);
    return promise;
  }
}
