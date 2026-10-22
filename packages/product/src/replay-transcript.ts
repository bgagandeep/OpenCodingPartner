import type { ContextTurn, PinnedNotes } from "./context.js";

/** Fixed replay used to compare estimated tokens before and after context folding. */
export const REPLAY_RECENT_BUDGET = 20;

export const REPLAY_PINNED: PinnedNotes = {
  facts: ["The app binds to loopback only."],
  decisions: ["Decision: replies stay drafts until a person sends them."],
  todos: ["Keep pinned todos out of the summary."],
};

export const REPLAY_TURNS: ContextTurn[] = [
  {
    role: "user",
    content: `${"Earlier discussion about the draft inbox and the approval flow. ".repeat(40)}Edit packages/product/src/server.ts so the channel draft stays in the app.`,
  },
  {
    role: "assistant",
    content: "Decision: use workspace_patch on packages/product/src/server.ts instead of rewriting the file.",
  },
  {
    role: "tool",
    content: "Error: workspace_patch failed in packages/product/src/server.ts: hunk did not match.",
  },
  {
    role: "user",
    content: "The test log is long, but the failure is the hunk mismatch. Continue from that error.",
  },
  {
    role: "assistant",
    content: "Recent turn stays verbatim: check the draft reply.",
  },
];
