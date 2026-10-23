# Catch-up

Open Coding Partner is a local open-source coding partner. This note is the sequence for closing the gap with [OpenBot](https://github.com/CopilotKit/openbot), [Grok Bot](https://docs.x.ai/grok-bot), and [dots](https://openai.com/index/introducing-dots), researched 23 October 2026. It does not copy their source, their licenses, or their accounts. It does not say this project is ready to be introduced as any of them.

Voice and meetings are not in any wave.

## What is already ahead

These are true in this tree, with tests.

- The model is chosen by the operator, including a fully local OpenAI-compatible base URL. Nothing in the box picks a frontier model for you.
- `MEMORY.md` can be corrected or forgotten by a person.
- Each bot has its own display number and browser profile. Take Control pauses that bot's mouse, keyboard, and browser.
- The audit log is a file on this machine.
- Slack, Telegram, and mail wait for a person. WhatsApp and Teams stay drafts even after Allow.
- The app binds to loopback. Docker publishes `127.0.0.1:4317` only. Boot does not require a managed intelligence license.

## Wave 1, in this tree

A gateway that decides, then acts.

- A deny rule can name a tool, a relative path, a command prefix, and whether it applies to a person, a routine, or anyone. A shell call is refused before the command runs. A command rule should omit the path prefix, because a shell call has no path.
- A broken rules file refuses every call.
- Ten failures in a row pause a routine. A success clears the count and does not resume a paused routine by itself.
- A scheduled responsibility check waits at least 15 minutes and is marked proactive.

Still false after this wave: a container per bot, gVisor, a Helm chart, a database in the image, and a company directory. Company sign-in remains a signed assertion on this machine. Bubblewrap is opt-in with `OCP_CODER_CONFINEMENT=workspace`.

## Wave 2, in this tree

Roster behavior on a machine you control.

- Hand off queues a finished task's result for another bot. The new task does not inherit a channel, so it cannot send the previous reply.
- A finished task can be saved as a routine.
- A person in the chat can answer an approval whenever they return. A routine approval expires (10 minutes, or `OCP_APPROVAL_TTL_MS` in a test) and the action does not run.
- Schedules keep running while this process is running. Compose restart restores them only while the machine is on.

Still false after this wave: a hosted computer that keeps working with the laptop closed, one shared cloud desktop as the only computer, and voice.

## Wave 3, in this tree

A single activity list, and a watch that cannot act.

- `GET /api/activity` lists waiting approvals, unsent drafts, open responsibilities, and routines. Draft text, destinations, and webhook secrets are left out.
- A proactive task may read, search, and list bots. Shell, write, send, and computer control are refused before they run.
- Teams reach writes a local outbox. Allowing it still sends nothing.

Still false after this wave: thousands of plugins, a frontier model in the box, a hosted identity that posts as you, and a real Teams or WhatsApp send.

## Not in any wave

- Voice, meetings, and a speech form.
- A public signup, or a port open beyond loopback.
- Their models, their accounts, and their source.
- Claiming the product is in their category.
