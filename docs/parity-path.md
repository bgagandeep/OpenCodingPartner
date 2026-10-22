# Path to the teammate claim

The announcement window is 1 November 2026 through 19 December 2026. Waiting for that date does not make Open Coding Partner into [OpenBot](https://github.com/CopilotKit/OpenBot), Dot, or Grok Bot. This page records the proofs that earned the category introduction, and the surfaces that are still false.

Open Coding Partner is independent of those projects. This path does not copy their internals, their license, or their accounts.

## The sentence that is true now

Open Coding Partner is ready to be introduced in the category people mean by OpenBot, Dot, and Grok Bot. It is a local, open-source coding partner for one operator and the people that operator adds on this machine. The model is fully local or brought by you. A bot can have a computer of its own. Consequential actions are recorded, a person can take the controls, and the model is one you run locally or one you bring. A foreign agent process on this machine can register over the public agent event stream. Replies can be cards. Voice accepts a transcript. WhatsApp stays a draft. Pages live in the app. Nothing in the box is a hosted signup, and the app binds to loopback only.

That sentence is the public announcement. The name on the product is Open Coding Partner. [Onboarding](onboarding.md) is the install path.

## What OpenBot actually is

OpenBot's own README calls it an alpha template, not a finished hosted product. A clone runs on your machine. No model ships in the box. An administrator supplies a credential, encrypted at rest. Each coworker gets a computer: its own container, browser profile, and workspace. A gateway decides an action, writes the audit row, and only then performs it. A person can take the wheel. Skills are instructions. Routines run on a schedule. Any agent that speaks their AG-UI protocol can be a bot. Their quick start also asks for their Intelligence service (managed, or a local licence) and a model key.

Our version of "bring your own brain" is an OpenAI-compatible base URL. That can be Ollama, LM Studio, vLLM, or a hosted router. We do not take a dependency on their Intelligence service to boot. No OpenBot source is copied. The credit is in the README Credits table. The agent event stream uses the public protocol event names. No protocol SDK is copied.

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
9. **A foreign agent on this machine.** Registration accepts only a loopback URL. A run speaks `RUN_STARTED`, text message events, a component event, and `RUN_FINISHED`. With no agent and no model, the run says it will not invent an action.
10. **Component replies.** A bot message in a thread carries a card the page can render.
11. **A local directory.** An operator can add an admin or a member. Passwords are hashed. Company sign-in is a signed assertion checked on this machine. The directory response contains neither the password nor the assertion secret.
12. **Voice transcripts.** A transcript comes back as speech text. No model means the turn will not invent an action. No audio service is called.
13. **WhatsApp drafts.** Reach into WhatsApp writes a draft and a local outbox. Allowing the draft still sends nothing.
14. **Pages.** A person can save a page. A secret-shaped token is redacted before it is stored.
15. **Coder confinement on request.** `OCP_CODER_CONFINEMENT=workspace` builds a bubblewrap launch that bind-mounts the workspace and drops the network. If bubblewrap is missing, the launch refuses. The default launch still uses the operator's OS permissions.

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

These hosted-operations surfaces are not yet in this tree. They are not required to introduce the local product in that category.

- A container runtime harder than bubblewrap, such as gVisor.
- A Helm chart.
- A database inside the app image.
- Their hosted model, their hosted accounts, and a public signup. The app still binds to loopback only.
- Standalone OCP Coder without `OCP_CODER_CONFINEMENT=workspace`. That default still uses the operator's OS permissions.

## What we will not say

- That the product name is OpenBot, Dot, or Grok Bot. Introduce it in that category under the name Open Coding Partner.
- That it reproduces their proprietary behavior.
- That a local model is configured when the header still says **No model configured**.
- That a shared workspace screen is a computer per bot. The dashboard computer is per bot. The unnamed workspace computer is the older shared path.
