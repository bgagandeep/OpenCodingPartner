import type { TurnResult } from "@opencodingpartner/mesh";

interface SessionRecord {
  turnCount: number;
  readonly byKey: Map<string, TurnResult>;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly lanes = new Map<string, Promise<void>>();

  private record(sessionKey: string): SessionRecord {
    const existing = this.sessions.get(sessionKey);
    if (existing !== undefined) {
      return existing;
    }
    const created: SessionRecord = { turnCount: 0, byKey: new Map() };
    this.sessions.set(sessionKey, created);
    return created;
  }

  get(sessionKey: string, idempotencyKey: string): TurnResult | undefined {
    return this.record(sessionKey).byKey.get(idempotencyKey);
  }

  put(sessionKey: string, result: TurnResult): void {
    this.record(sessionKey).byKey.set(result.idempotencyKey, result);
  }

  allocateTurn(sessionKey: string): number {
    const record = this.record(sessionKey);
    record.turnCount += 1;
    return record.turnCount;
  }

  runExclusive<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(sessionKey) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lanes.set(sessionKey, gate);
    return previous.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }
}
