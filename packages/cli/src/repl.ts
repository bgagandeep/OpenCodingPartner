export interface ChatLine {
  transcript: string;
}

/** Read chat lines until `exit` or the input ends. A line ending in `\` continues the message. */
export async function runChatRepl(options: {
  read: () => Promise<string | null>;
  write: (text: string) => void;
  turn: (message: string) => Promise<ChatLine>;
}): Promise<number> {
  options.write("OpenCodingPartner chat agent. Type a message. End a line with \\ to continue. Type exit to stop.\n");
  let pending = "";
  for (;;) {
    options.write(pending.length === 0 ? "You: " : "... ");
    const line = await options.read();
    if (line === null) {
      if (pending.length > 0) {
        const result = await options.turn(pending.replace(/\n$/, ""));
        options.write(result.transcript);
        options.write("\n");
      }
      options.write("\n");
      return 0;
    }
    const piece = pending.length === 0 ? line.replace(/^\s+/, "") : line;
    if (pending.length === 0 && piece.length === 0) continue;
    if (pending.length === 0 && (piece === "exit" || piece === "quit")) return 0;
    if (piece.endsWith("\\")) {
      pending += `${piece.slice(0, -1)}\n`;
      continue;
    }
    const message = `${pending}${piece}`;
    pending = "";
    if (message.length === 0) continue;
    const result = await options.turn(message);
    options.write(result.transcript);
    options.write("\n");
  }
}
