export class AsyncChannel<T> {
  private buffer: T[] = [];
  private takers: Array<(r: IteratorResult<T>) => void> = [];
  private isClosed = false;

  get closed(): boolean {
    return this.isClosed;
  }

  push(value: T): void {
    if (this.isClosed) return;
    const taker = this.takers.shift();
    if (taker) taker({ done: false, value });
    else this.buffer.push(value);
  }

  take(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift() as T;
      return Promise.resolve({ done: false, value });
    }
    if (this.isClosed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.takers.push(resolve));
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const taker of this.takers.splice(0)) taker({ done: true, value: undefined });
  }
}
