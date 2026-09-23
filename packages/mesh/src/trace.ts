export type TraceEvent =
  | {
      readonly type: "session.resolved";
      readonly sessionKey: string;
      readonly channel: string;
      readonly agentId: string;
    }
  | {
      readonly type: "policy.predicted";
      readonly backend: string;
      readonly model: string;
      readonly disposition: string;
      readonly manager: string;
      readonly worker: string;
      readonly needsHuman: number;
    }
  | {
      readonly type: "control.blocked";
      readonly reason: string;
    }
  | {
      readonly type: "manager.planned";
      readonly managerId: string;
      readonly dispatch: boolean;
      readonly taskCount: number;
    }
  | {
      readonly type: "worker.skipped";
      readonly reason: string;
    }
  | {
      readonly type: "worker.dispatched";
      readonly workerId: string;
      readonly taskId: string;
    }
  | {
      readonly type: "worker.finished";
      readonly workerId: string;
      readonly relativePath: string;
      readonly bytesWritten: number;
    }
  | {
      readonly type: "turn.completed";
      readonly disposition: string;
      readonly dispatched: boolean;
      readonly ok: boolean;
    };
