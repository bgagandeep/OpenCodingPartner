# Path to the teammate claim

The announcement window is 1 November 2026 through 19 December 2026. Waiting for that date does not make Open Coding Partner into [OpenBot](https://github.com/CopilotKit/OpenBot), Dot, or Grok Bot. This page is the work that has to land before any of those comparisons is fair, and the sentence we are allowed to say before that work lands.

Open Coding Partner is independent of those projects. This path does not copy their internals, their license, or their accounts.

## The sentence that is true now

Open Coding Partner is a local, open-source coding partner for one operator. The model is fully local or brought by you. Nothing in the box is a hosted signup, and the app binds to loopback only.

That sentence is the 1 November announcement if no further product work lands. [Onboarding](onboarding.md) is the install path for it.

## The sentence we still have to earn

A single-operator teammate in the same category as OpenBot: you name a bot, it works on a computer of its own, every consequential action is decided and recorded, you can take the controls, and the model is one you run or one you rent.

Dot and Grok Bot are the same category of persistent teammate. They are hosted products with their own models. Matching them means matching that shape on our machine, not wearing their names.

## What OpenBot actually is

OpenBot's own README calls it an alpha template, not a finished hosted product. A clone runs on your machine. No model ships in the box. An administrator supplies a credential, encrypted at rest. Each coworker gets a computer: its own container, browser profile, and workspace. A gateway decides an action, writes the audit row, and only then performs it. A person can take the wheel. Skills are instructions. Routines run on a schedule. Any agent that speaks their AG-UI protocol can be a bot. Their quick start also asks for their Intelligence service (managed, or a local licence) and a model key.

Our version of "bring your own brain" is an OpenAI-compatible base URL. That can be Ollama, LM Studio, vLLM, or a hosted router. We do not take a dependency on their Intelligence service to boot.

## Where we already match

| Shape | Here today |
| --- | --- |
| No model in the box | Header stays **No model configured** until Settings has one. A turn with no key refuses to invent actions. |
| Fully local | **Use local GPU (Ollama)** sets the base URL to `http://127.0.0.1:11434/v1`. A local base URL can use the placeholder key `ollama`. No hosted account is required. |
| Bring your own model | OpenRouter, or any OpenAI-compatible base URL and model id. The key is not written into `state.json` or the task log. |
| A computer, and take the wheel | One virtual display per workspace. **Take Control** refuses bot mouse, keyboard, and browser until you return control. |
| Decide, then act | Allow once, Always, Deny, Redirect. Unattended runs fail closed. |
| Secrets stay out of the transcript | Vault fills by item name. A sign-in, 2FA, or captcha page is not typed by the bot. |
| Skills and routines | Skills are instructions with a "When to use" line. Routines take five-field cron plus an IANA timezone, or an interval, or an event. |
| Reach, in part | Slack and Telegram can deliver work. Mail waits on a draft card until a person sends it. |
| Loopback | The process refuses `0.0.0.0`. A foreign `Origin` or `Host` is refused. |

## What is still false

These are the gaps that make "like OpenBot" false today. They are ordered. Each one names the proof that closes it. None of them is a rename.

1. **A computer per bot.** Today the display and the browser profile are hashed from the workspace, so Ada and Linus on one project share a screen. OpenBot gives each bot its own computer. Close it when two bots in one workspace have different profile directories and different displays, and resetting one does not sign the other out. Test that without starting Xvnc: the paths and the display numbers must differ.
2. **An audit a person can read.** Task events exist. There is no System page that lists permitted, refused, and failed actions and names the rule. Close it when a denied approval shows on that page with the rule id, and a vault secret does not.
3. **A standing responsibility.** Routines fire prompts. A bot has no lasting goal with visible progress. Close it when a responsibility survives a restart, shows status on the bot, and a routine can name it. Cap how many can be armed, the way a 15-minute floor stops a sentence from scheduling a fleet.
4. **A thread with more than one bot.** Team chat is one project channel. Close it when a person can address two bots in one new thread and both replies stay in that thread. Use the built-in runtime with no network call in the test.
5. **Reach from the bot.** Channels exist beside the bot. Close it when a bot page can continue the same conversation into Slack or Telegram and the transcript shows that delivery. Sending still waits for a person where the channel can post as the user.
6. **Memory the person can edit.** Bots can remember inside the workspace. Close it when Settings or the bot page lists those facts and a person can correct or forget one. The model is not the only writer.
7. **A named deny rule.** Allow and deny are per action. Close it when a person can store a rule (tool name, optional path prefix), a matching call is refused, and the audit row quotes that rule. A broken rule refuses. This is not a general policy language. That can wait.
8. **Doctor tells the truth about the model path.** `ocp doctor` must print `Model: local <base url>` or `Model: hosted` or `Model: not configured`, and must not print the key or dial the network to do it.

## Explicitly later

These are real OpenBot or hosted-teammate surfaces. They are not required for the earned sentence above, and they are not November work.

- Speaking their AG-UI protocol so a foreign agent process can register as a bot. Our bring-your-own-model path is the November substitute.
- Answers made of live interface components instead of text, diffs, and cards.
- Accounts for more than one person, company sign-in, and an admin directory.
- Voice, WhatsApp, and a pages surface.
- A container runtime harder than Docker, a Helm chart, or a database inside the app image.

## How to know we got there

The earned sentence may appear in the README only after items 1 through 8 have tests in this repository and those tests pass in CI. Until that commit, the README keeps the sentence that is true now. A demo that needs a live model key is not the proof. The proof uses a fake local endpoint or no socket at all.

Ship the items in order. Item 1 changes isolation, so it should not share a change with the audit page. Item 8 is documentation of behavior the doctor does not print yet, and it can land beside item 1 only if the doctor change stays free of network calls.

## What we will not say

- That Open Coding Partner is OpenBot, Dot, or Grok Bot.
- That it reproduces their proprietary behavior.
- That a local model is configured when the header still says **No model configured**.
- That a shared workspace screen is a computer per bot.
