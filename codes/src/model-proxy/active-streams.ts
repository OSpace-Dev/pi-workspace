export class ActiveStreams {
  private readonly streams = new Map<string, { connectionId: string; controller: AbortController }>();

  register(taskId: string, connectionId: string, controller: AbortController): (() => void) | null {
    if (this.streams.has(taskId) || this.streams.size >= 8) return null;
    this.streams.set(taskId, { connectionId, controller });
    return () => {
      if (this.streams.get(taskId)?.controller === controller) this.streams.delete(taskId);
    };
  }

  abortTask(taskId: string): void {
    this.streams.get(taskId)?.controller.abort();
  }

  abortConnection(connectionId: string): void {
    for (const active of this.streams.values()) {
      if (active.connectionId === connectionId) active.controller.abort();
    }
  }

  abortAll(): void {
    for (const taskId of this.streams.keys()) this.abortTask(taskId);
  }
}
