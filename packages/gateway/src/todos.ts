import { readdir } from "node:fs/promises";
import path from "node:path";
import { listSandboxTodos } from "@opencodingpartner/workers";
import { readPartnerIdentity } from "./fleet.js";

export interface TodoQueueItem {
  partner: string;
  workspace: string;
  id: string;
  text: string;
  done: boolean;
}

/** Todos in the session sandbox and each partner workspace. This does not add or complete one. */
export async function listTodoQueue(sessionRoot: string): Promise<TodoQueueItem[]> {
  const items: TodoQueueItem[] = [];
  for (const todo of await listSandboxTodos(sessionRoot)) {
    items.push({ partner: "session", workspace: ".", id: todo.id, text: todo.text, done: todo.done });
  }
  let names: string[] = [];
  try {
    names = await readdir(path.join(sessionRoot, ".ocp", "fleet"));
  } catch {
    names = [];
  }
  const partners: { id: string; workspace: string }[] = [];
  for (const name of names) {
    const workspace = path.join(sessionRoot, ".ocp", "fleet", name);
    const identity = await readPartnerIdentity(workspace);
    if (identity) partners.push({ id: identity.id, workspace });
  }
  partners.sort((left, right) => left.id.localeCompare(right.id));
  for (const partner of partners) {
    for (const todo of await listSandboxTodos(partner.workspace)) {
      items.push({
        partner: partner.id,
        workspace: `.ocp/fleet/${partner.id}`,
        id: todo.id,
        text: todo.text,
        done: todo.done,
      });
    }
  }
  return items;
}

export function formatTodoQueue(items: readonly TodoQueueItem[]): string {
  if (items.length === 0) return "Todos: none\nSay todo add or todo complete in chat to change the list.\n";
  const lines = ["Todos"];
  for (const item of items) {
    const text = item.text.replace(/\s+/g, " ").trim().slice(0, 160);
    lines.push(`${item.partner} ${item.workspace} ${item.id} ${item.done ? "done" : "open"} ${text}`);
  }
  lines.push("This list does not add or complete a todo.");
  return `${lines.join("\n")}\n`;
}

export function formatTodoQueueJson(items: readonly TodoQueueItem[]): string {
  return `${JSON.stringify(items, null, 2)}\n`;
}

export function todoDoctorLine(open: number): string {
  if (open === 0) return "green Todos: none open. This check does not change the list.";
  return `yellow Todos: ${open} open. This check does not change the list.`;
}
