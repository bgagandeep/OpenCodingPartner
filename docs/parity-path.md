# Path to the teammate claim

The announcement window is 1 November 2026 through 19 December 2026. Waiting for that date does not make Open Coding Partner into [OpenBot](https://github.com/CopilotKit/OpenBot), Dot, or Grok Bot. This page records the proofs that earned the teammate sentence, and the surfaces that are still false.

Open Coding Partner is independent of those projects. This path does not copy their internals, their license, or their accounts.

## The sentence that is true now

Open Coding Partner is a local, open-source coding partner for one operator. The model is fully local or brought by you. A bot can have a computer of its own. Consequential actions are recorded, a person can take the controls, and the model is one you run locally or one you bring. Nothing in the box is a hosted signup, and the app binds to loopback only.

That sentence is the public announcement. It is the teammate shape. It is not a claim to be another product. [Onboarding](onboarding.md) is the install path.

## What OpenBot actually is

OpenBot's own README calls it an alpha template, not a finished hosted product. A clone runs on your machine. No model ships in the box. An administrator supplies a credential, encrypted at rest. Each coworker gets a computer: its own container, browser profile, and workspace. A gateway decides an action, writes the audit row, and only then performs it. A person can take the wheel. Skills are instructions. Routines run on a schedule. Any agent that speaks their AG-UI protocol can be a bot. Their quick start also asks for their Intelligence service (managed, or a local licence) and a model key.

Our version of "bring your own brain" is an OpenAI-compatible base URL. That can be Ollama, LM Studio, vLLM, or a hosted router. We do not take a dependency on their Intelligence service to boot. No OpenBot source is copied. The credit is in the README Credits table.

## Proofs in this tree

Each item has a test. None of them starts Xvnc, dials a model, or sends a channel message.

1. **A computer per bot.** Two bots in one workspace have different profile directories and different display numbers. Resetting one does not remove the other's state file.
2. **An audit a person can read.** The System audit page lists permitted, refused, and failed actions. A denied approval records rule id `approval`. A vault-shaped secret is redacted before the row is stored.
3. **A standing responsibility.** It survives in `responsibilities.json`, shows on the bot page, and a routine can name its id in the prompt. At most 20 can be open.
4. **A thread with more than one bot.** A person addresses two known bots. Both replies stay in that thread. With no model, each bot records that it will not invent an action. The test makes no network call.
5. **Reach from the bot.** The same thread can continue into Slack or Telegram as a draft. The channel log status is `draft`. The transcript says nothing was sent. Nothing is sent automatically.
6. **Memory the person can edit.** Correct and forget use the same `MEMORY.md` the workspace tools use. The model is not the only writer.
7. **A named deny rule.** A rule is a tool name plus an optional relative path prefix. A matching call is refused and the audit row quotes that rule id. A broken rules file refuses every call with rule id `broken`. A missing file allows the call.
8. **Doctor tells the truth about the model path.** `ocp doctor` prints `Model: local <base url>` for a loopback base URL, `Model: hosted` when the base URL or a key is present and the base URL is not loopback, or `Model: not configured`. It does not print the key and it does not dial the network. A local base URL wins over a hosted key. Userinfo is stripped from the printed URL.

## Where we already match

| Shape | Here today |
| --- | --- |
| No model in the box | Header stays **No model configured** until Settings has one. A turn with no key refuses to invent actions. |
| Fully local | **Use local GPU (Ollama)** sets the base URL to `http://127.0.0.1:11434/v1`. A local base URL can use the placeholder key `ollama`. No hosted account is required. |
| Bring your own model | OpenRouter, or any OpenAI-compatible base URL and model id. The key is not written into `state.json` or the task log. |
| A computer per bot, and take the wheel | Each bot has its own display number and Chrome profile. **Take Control** refuses bot mouse, keyboard, and browser until you return control. A workspace tool that does not name a bot still uses the shared workspace computer. |
| Decide, then act | Allow once, Always, Deny, Redirect, plus a named deny rule. Unattended runs fail closed. The audit page is the record. |
| Secrets stay out of the transcript | Vault fills by item name. A sign-in, 2FA, or captcha page is not typed by the bot. Audit rows redact `sk-` keys. |
| Skills and routines | Skills are instructions with a "When to use" line. Routines take five-field cron plus an IANA timezone, or an interval, or an event. A routine can name a responsibility id. |
| Reach, as a draft | Slack and Telegram drafts stay in the channel log until a person sends them. Mail waits on a draft card. |
| Loopback | The process refuses `0.0.0.0`. A foreign `Origin` or `Host` is refused. |

## What is still false

These are real OpenBot or hosted-teammate surfaces. They are not required for the sentence above, and they are not yet in this tree.

- Speaking their AG-UI protocol so a foreign agent process can register as a bot. Our bring-your-own-model path is the substitute.
- Answers made of live interface components instead of text, diffs, and cards.
- Accounts for more than one person, company sign-in, and an admin directory.
- Voice, WhatsApp, and a pages surface.
- A container runtime harder than Docker, a Helm chart, or a database inside the app image.
- A container boundary for standalone OCP Coder. Those processes still use the operator's OS permissions.

## What we will not say

- That Open Coding Partner is OpenBot, Dot, or Grok Bot.
- That it reproduces their proprietary behavior.
- That a local model is configured when the header still says **No model configured**.
- That a shared workspace screen is a computer per bot. The dashboard computer is per bot. The unnamed workspace computer is the older shared path.
