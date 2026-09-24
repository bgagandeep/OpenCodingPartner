export interface ChatLine {
  transcript: string;
}

/** Read chat lines until `exit` or the input ends. Each line is one turn. */
export async function runChatRepl(options: {
  read: () => Promise<string | null>;
  write: (text: string) => void;
  turn: (message: string) => Promise<ChatLine>;
}): Promise<number> {
  options.write("OpenCodingPartner chat agent. Type a message. Type exit to stop.\n");
  for (;;) {
    options.write("You: ");
    const line = await options.read();
    if (line === null) {
      options.write("\n");
      return 0;
    }
    const message = line.replace(/^\s+/, "");
    if (message.length === 0) continue;
    if (message === "exit" || message === "quit") return 0;
    const result = await options.turn(message);
    options.write(result.transcript);
    options.write("\n");
  }
}
