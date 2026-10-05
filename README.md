# Open Coding Partner

Open Coding Partner (OCP) is an agentic coding tool. You talk to a chat agent. That chat agent runs an orchestration agent swarm. You ask the swarm to stand up agents.

A coding agent and a QA agent build and test the product. A computer agent helps sell it. A security agent checks the work inside the same coding setup.

A company with enough model hosting can replace day-to-day coding-team build, review, and ship work. This does not cover legal, spend, or brand. A startup can use it to bring an idea to life and to help sell that idea.

The core is free forever and open source. The operator owns the meter. The full coding partner is included. Seats and credit packs in Settings are design only. Billing is inert. No charge is made. Ads are off. Payments are off in the core.

## First run

```bash
pnpm install
pnpm bundle:install
pnpm exec ocp doctor
```

`ocp doctor` prints green, yellow, or red. `ocp doctor --sandbox .sandbox` checks that sandbox: partner fleet, pending Approve cards, review holds, whether `PARTNER.md` is present, whether `gtm/last-frame.png` is a PNG, and each partner frame that has a page or a frame file. It also says whether the last page check passed, who holds the browser, and whether each partner shared mount is read-only at this session. It does not print the mount path. It also reports the last `node --test`, `pnpm test`, or `tsc --noEmit` exit code and does not print the command output. It reports whether the last QA passed and does not print the QA summary. It counts routines and does not run one or print its message. It says whether the last write was orchestration or local and does not print the path. It does not print the page text and does not take or return the browser. It does not start the browser, does not start containers, does not decide a card, does not clear a hold, does not copy `PARTNER.md`, and does not print keys or the request text. A pending card is named as plan or computer. It names the last decided card as approved, denied, or redirected and does not print the request. It also says whether the `docker` command answered. A missing Docker install is yellow. `ocp fleet start` still does not run during doctor.

- System-1: green when `.bundle/laya` python and `.bundle/laya/hf` are present. The next chat can say `System-1: real.` Yellow means the transcript will say `System-1: fallback.` System python is not System-1.
- Meter: set one of these, in this order. `LITELLM_API_KEY` or `LITELLM_MASTER_KEY` (optional `LITELLM_BASE_URL`, default `http://127.0.0.1:4000/v1`). Else `OPENAI_API_KEY` and `OPENAI_BASE_URL`. Else `XAI_API_KEY` with the `grok` binary. Yellow `Meter: none` means a general edit will refuse. A simple create-file still writes on the local sandbox.
- Orchestration: `docker compose up -d openclaw-gateway`. Doctor checks `GET /healthz`. Yellow means the chat turn writes locally and says `Write path: local sandbox.`
- Write bridge: load `integrations/openclaw-sandbox-write` on that gateway. When the gateway answers, `ocp doctor` asks whether `ocp_sandbox_todo` is offered. That check does not update a list. When the gateway is down, doctor does not prove the plugin loaded. `fs_write` stays blocked.
- Computer capture: yellow until Playwright is installed. Needed for `ocp computer capture` and `--computer-execute`. The doctor line does not start the browser.

Prove-it chat, after doctor is green for the pieces you care about:

```bash
export LITELLM_API_KEY="the operator key"
pnpm exec ocp chat --sandbox .sandbox "Use the coding worker to create hello.txt with content:
hello
"
```

Scripted coding proof, with no meter key:

```bash
pnpm exec ocp prove coding
```

That command runs one local turn in a temp sandbox. It creates `src/`, writes a small add function, globs `src/**/*.mjs`, patches the function, copies it to `src/math.copy.mjs`, and runs `node --test`. The source and the copy match. The transcript says `Copy path: local sandbox.` Exit 0 means those files and transcript lines matched. It prints `Passed.` It does not call a meter, and it does not print keys. The orchestration gateway does not copy the file in this proof. `pnpm proof:coding` is different: that one needs a meter key.

Scripted computer proof, with no Playwright and no meter key:

```bash
pnpm exec ocp prove computer
```

That command opens `https://example.com` with a fake browser driver, scrolls, presses Enter, hovers `#buy`, double-clicks `#buy`, right-clicks `#buy`, fills `#email`, selects `#plan` option Pro, checks `#agree`, and checks the page text. It writes `gtm/last-run.json` with a pass and a screenshot for each of those steps. Exit 0 prints `Passed.` Exit 1 prints `Failed.` This is one scripted chain, not a full go-to-market run. The orchestration gateway does not run the browser. It does not print keys.

Read the transcript. `System-1: real.` or `System-1: fallback.` `Write path: orchestration.` only if the gateway accepted the plan and the write landed. Otherwise `Write path: local sandbox.` `Meter: proxy`, `Meter: compatible`, `Meter: worker`, or `Meter: none`. The offline command `pnpm exec ocp demo --sandbox .sandbox` does not pretend those live pieces ran.

## Which tool runs what

| User-facing name | Runs on |
| --- | --- |
| Chat agent / chat bot | OpenCodingPartner CLI + orchestration |
| Orchestration agent swarm | Orchestration gateway. The pin and license are in [Credits](#credits). |
| Coding agents + QA agents | Coding worker. The pin and license are in [Credits](#credits). |
| Computer agents (GTM) | Computer-use worker seam |
| Security agents | Policy/security worker seam in the coding environment |

We cite those projects. We do not copy their source into this repo. See [Credits](#credits) and [Independence](#independence).

## Install the connected stack

```bash
pnpm install
pnpm bundle:install
```

That one command installs the pinned orchestration gateway, coding worker, and System-1 under `.bundle/`. It uses npm and pip. It also downloads the System-1 English checkpoint into `.bundle/laya/hf` (about 800 MB; the first download often takes several minutes). Those weights are not committed. It does not copy upstream source trees into this repo. Upstream license files stay inside those installs. Names are in [Credits](#credits).

System-1 only, including the same weight download:

```bash
pnpm bundle:install:laya
```

System `python3` is not System-1. After either command, the next `ocp chat` turn uses the bundled Python and `HF_HOME=.bundle/laya/hf`. The transcript says `System-1: real.`

Optional orchestration gateway:

```bash
docker compose up -d openclaw-gateway
```

The image pin is in [Credits](#credits).

## Run a chat turn

```bash
pnpm install
pnpm exec ocp chat --sandbox .sandbox
```

Type a message, then type `exit`. One turn stands up a coding agent, a QA agent, a security agent, and a computer agent. The transcript says what each one did.

`ocp chat` copies [PARTNER.md](PARTNER.md) into the sandbox when that file is missing. An open edit then writes `.ocp/sdlc/intent.md`, `.ocp/sdlc/spec.md`, and `.ocp/sdlc/plan.md` and shows an Approve card. The queue is `.ocp/approvals.json`. Say `approve` or `accept the plan` before the coding worker edits. `deny` stops the edit. `redirect: note` sends the note back to intent. `ocp approve list` shows pending cards for the session and each partner workspace. It does not decide a card. It also shows a review hold, and it does not clear that hold. `ocp doctor` counts those cards and holds, and does not print the request text. After an approved edit it runs `node --test` in the sandbox and reports the exit code. QA reviews the files and the check. The Approve card is the human intent and risk decision. A failed check returns to intent and holds the coding worker at one until the next approval. Rules in `PARTNER.rules` or `.ocp/rules` are loaded into the coding worker prompt. A `block:` line stops a matching request. A partner turn also loads those files from the read-only shared session and does not copy them. An explicit create-file message still writes that one file.

`ocp computer` is the Computer tab. It prints the sandbox desktop status and the last frame path under `gtm/`. There is no live pixel stream in this build. `ocp computer takeover` gives you the browser. `ocp computer return` gives it back to the partner. With `PARTNER.md` in the sandbox, `--computer-execute` waits for an Approve card before the partner opens a page. `ocp chat --partner coding` and `ocp computer --partner coding` use that partner's own workspace under `.ocp/fleet/coding`. The same message for two partner ids is two turns. Repeating it for one partner replays that turn. When the orchestration gateway drives a write, the write bridge uses that same workspace. The file does not land in the session root. The session root is mounted read-only at `/shared`. A partner list, read, grep, or glob of `shared` or `shared/path` uses that session root and does not copy it. A write to `shared` is refused. `ocp fleet status` lists each partner, its workspace, whether the container is running, stopped, or not started, and the last frame path and time. `ocp fleet status --json` prints that list. It does not start containers. No telemetry is sent. `ocp fleet start --partner coding` runs that container when Docker is installed. `ocp fleet stop --partner coding` stops it. If Docker is missing, start fails and does not claim the container is running. `ocp computer capture` writes `gtm/last-frame.png` from the open page and `ocp computer` shows that path and its time. After `--computer-execute`, capture copies the step screenshot to `gtm/last-frame.png` and Computer QA `computer-frame` checks that file. A missing page, a missing screenshot, or a file that is not a PNG fails the turn in the transcript. With `--partner`, that frame stays in `.ocp/fleet/<id>/gtm/`, and `ocp computer` and `ocp computer qa --partner <id>` print that path. Without a partner id, the path stays `gtm/last-frame.png`. Takeover and return on that workspace block and restore the partner browser. `ocp computer capture` still writes the frame from the open page, and Computer QA `computer-frame` checks that it exists, is a PNG, and that the time moved. A miss fails the turn. `ocp computer qa` prints pass or fail for the frame on disk and does not open a page. Without `--partner`, it also checks each partner frame that has a page or a frame file. One bad frame fails the command. A missing browser is an error, not a blank image. A live pixel stream is still later. `ocp computer --partner coding` shows Container: running or stopped. With `PARTNER.md` in the sandbox, start waits on the same Approve card as computer-use. A fleet grid and telemetry are later. `ocp fleet start --dry-run` only prints the command.

`ocp routine add --partner coding --every 60000 --message "check the files"` stores a routine in `.ocp/routines.json`. `ocp routine list`, `pause`, and `resume` manage it. `ocp routine run` fires interval routines that are due and runs each one as a partner turn. `ocp routine event build-finished` fires event routines. `ocp channel slack --text "approve" --channel dev` turns that reply into a partner turn, so approve and deny work without a card widget. This build posts a Slack reply only when `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are set. Inbound events are checked with that signing secret. Without those, `ocp channel slack` still runs the offline turn and says what is missing. Telegram uses the same turn. A Telegram reply is posted only when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are set. Inbound updates are checked with that webhook secret. Without those, `ocp channel telegram` still runs the offline turn and says what is missing. `ocp channel slack receive` and `ocp channel telegram receive` accept one saved inbound body only when the secret matches. A missing or bad secret does not run the turn. `ocp doctor` says the same and does not print the values. WhatsApp is later.

`ocp swarm apply --file docs/examples/swarm.json --sandbox .sandbox` reads a JSON swarm manifest and creates one workspace per partner under `.ocp/fleet`. `ocp swarm validate` checks the file. `ocp swarm apply --dry-run` prints the plan and writes nothing. Intervals shorter than 1000 ms are refused. The manifest does not start containers. A fleet grid and telemetry are later.

Advanced ACP is off. Set `OCP_ACP=1` or `.ocp/settings.json` `advanced.acp` to true to ask for an optional backend. None is installed. The local swarm still runs. `ocp settings` prints that switch and the packaging lines: free OSS core, design-only seats and credits, and inert billing. The backend name is in Credits. No payment provider is connected.

A general request, such as "Add an add function in src/math.ts and a test in src/math.test.ts", is sent to the coding agent with the sandbox as the working directory. The meter prompt also includes the text files already in that sandbox, so a later turn on the same sandbox can see them. It also includes `Prior turns:` for this session and sandbox: the last six user messages and a short outcome (files written, QA pass or fail). A secret in a blocked write is not stored. Another sandbox does not see that history. The same lines are saved in `.ocp/prior-turns.json` inside that sandbox, so a new process still has them. That file is not listed or grepped into the prompt. Inside one turn the coding agent can list a directory, grep text files, glob a relative pattern such as `src/**/*.ts` or `*.md`, read a file, patch an existing file, write a new file, delete one file, rename one file, copy one file (through `ocp_sandbox_copy` when the gateway drove the turn, otherwise locally; a missing plugin falls back locally; a refusal does not copy locally). Append adds text to one existing relative file and does not create a file (through `ocp_sandbox_append` when the gateway drove the turn, otherwise locally; a missing plugin falls back locally; a refusal does not append locally). A missing file, a directory, `../`, a secret, `gtm/`, or `.ocp/` is refused. The transcript says `Append path: orchestration.` or `Append path: local sandbox.` The turn can also mkdir one directory and run one of these checks: `node --test` plus relative paths, `pnpm test` with no extra arguments, or `tsc --noEmit` plus relative paths. It can also run `git status`, `git status -sb`, `git status --short --branch`, `git diff` plus relative paths, and `git log --oneline -n N` with N from 1 to 20, and `git show HEAD:` plus one relative path. Git add, commit, push, checkout, reset, and other writes are refused. A long diff or `git show` is cut at 2000 characters and the observation says truncated. The working directory is the sandbox. Other commands are refused. Delete unlinks that file only. Rename moves one file to a new relative path and refuses to overwrite. It refuses a directory, a path outside the sandbox, and anything under `gtm/`. A secret file the security gate blocks is left in place. Mkdir creates one relative directory, including parents. An existing directory is left as it is. A path that is already a file, `../`, an absolute path, `gtm/`, `.ocp/`, or a secret path is refused. When the gateway did not drive the turn, the transcript says `Mkdir path: local sandbox.` When it did, mkdir uses `ocp_sandbox_mkdir` and the transcript says `Mkdir path: orchestration.` A missing plugin falls back to the local sandbox. Rmdir removes one empty relative directory. A file or a directory that still has files is refused. When the gateway did not drive the turn, the transcript says `Rmdir path: local sandbox.` When it did, rmdir uses `ocp_sandbox_rmdir` and the transcript says `Rmdir path: orchestration.` A missing plugin falls back to the local sandbox. A refusal does not remove the directory locally. A coding turn can keep a local checklist with todo add and todo complete. The list is capped at 12 and stored in `.ocp/todos.json`. Secrets and `../` are refused. `ocp todo list` shows that checklist for the session and each partner workspace. It does not add or complete a todo. `ocp doctor` counts the open items and does not print the text. When the gateway drives the turn, the list is updated through `ocp_sandbox_todo`. A missing plugin updates it locally. A refusal does not update it locally. The transcript says `Todo path: orchestration.` or `Todo path: local sandbox.` When the gateway drove the turn, delete and rename go through that bridge. The transcript says `Delete path: orchestration.` or `Rename path: orchestration.` If the plugin is missing, the same step runs in the local sandbox and the transcript says `Delete path: local sandbox.` or `Rename path: local sandbox.` Grep returns matching paths and short line snippets. It skips secrets, binary files, and `gtm/`. It then sees those tool results and can take another round, up to ten rounds, in the same turn. It stops when the reply is done, there are no more steps, or the check passes. Other commands are refused. The transcript lists each round and each tool step. If `node --test` still fails, that output goes into the same two-retry fix loop. Secret files are left out of that prompt. The same chat session can take a follow-up: create `src/math.ts`, then ask for `src/math.test.ts`, then ask to fix a failing assert. Each turn has its own transcript and meter line. The QA agent then reviews the files that changed. The security agent checks the request first, and checks the written files after. A file that escapes the sandbox or contains a secret is removed.

That general path needs a meter. Prefer the proxy keys `LITELLM_API_KEY` or `LITELLM_MASTER_KEY`. If those are unset, a compatible endpoint with `OPENAI_API_KEY` and `OPENAI_BASE_URL` is next. The native coding worker (`XAI_API_KEY` and the `grok` binary) is last. Without a key, the chat agent says so. It does not pretend the offline sandbox can do open-ended edits. The transcript names the meter: `Meter: proxy`, `Meter: compatible`, `Meter: worker`, or `Meter: none`.

## Meter

The meter is a chat-completions proxy you run or already have. It is not a second orchestration system. Orchestration still owns the session plan. Coding workers in this process send chat completions to the proxy. Upstream names are in [Credits](#credits).

| Variable | Role |
| --- | --- |
| `LITELLM_API_KEY` | Key this process sends. Wins over `LITELLM_MASTER_KEY`. |
| `LITELLM_MASTER_KEY` | Same job when `LITELLM_API_KEY` is unset. This is the proxy's usual master key. |
| `LITELLM_BASE_URL` | Proxy URL. Defaults to `http://127.0.0.1:4000/v1` when a proxy key is set. |
| `LITELLM_MODEL` | Model alias. Then `OPENAI_MODEL`. Then `gpt-4o-mini`. |
| `OPENAI_API_KEY` and `OPENAI_BASE_URL` | Used only when no proxy key is set. |
| `XAI_API_KEY` | Native coding worker, only when the other meters are unset and `grok` is installed. |

Remote proxy:

```bash
export LITELLM_API_KEY="the operator key"
export LITELLM_BASE_URL="https://your-litellm.example/v1"
export LITELLM_MODEL="your-alias"
pnpm exec ocp chat --sandbox .sandbox
```

Local proxy, bound to localhost. The example config is [examples/litellm/config.yaml](examples/litellm/config.yaml). `OPENAI_API_KEY` here is the provider key the proxy reads, not the key this chat agent sends.

```bash
export LITELLM_MASTER_KEY="the proxy key"
export OPENAI_API_KEY="the provider key"
docker compose up -d litellm
export LITELLM_API_KEY="$LITELLM_MASTER_KEY"
pnpm exec ocp chat --sandbox .sandbox
```

When System-1 is installed (`pnpm bundle:install`, or `OCP_LAYA_PYTHON`), the chat turn calls `integrations/laya/predict.py` and the transcript says `System-1: real.` A machine that only has system Python is not treated as System-1. The transcript then says `System-1: fallback.`

This simple message still writes a file on the local sandbox worker:

```text
Use the coding worker to create hello.txt with content:
hello
```

The security agent blocks a path that escapes the sandbox, and it blocks secrets. The QA agent checks the file that was written. The computer agent writes `gtm/action-plan.json`. Without `--computer-execute`, every computer action stays `executed: false` and no browser runs.

With `--computer-execute` (or `OCP_COMPUTER_EXECUTE=1`), the computer agent runs a short sequence in this process with headless Chromium through Playwright: open the http or https URL you name, read the title and page text, and, if you ask, type into one CSS selector. Example: `Open https://example.com and type "hello" into #hero`. Each step is `executed: true` only after it runs. `gtm/last-run.json` lists the steps. Each finished step also saves `gtm/step-1.png`, `gtm/step-2.png`, and `gtm/step-3.png` when that step ran. Local hosts, private addresses, metadata hosts, and URLs with a username or password are refused. A selector that looks like a script is refused and is not typed. Set `OCP_COMPUTER_ALLOW_HOSTS` to a comma-separated host list when you want a tighter allow list. Evidence stays under the sandbox `gtm/` directory. Notes redact secrets.

```bash
pnpm add playwright
pnpm exec playwright install chromium
pnpm exec ocp chat --sandbox .sandbox --computer-execute "Open https://example.com and type \"hello\" into #hero"
```

If Playwright or Chromium is missing, the turn says the browser is missing, no frame was written, and to run `pnpm exec playwright install chromium`. `ocp doctor` says the same and does not start the browser. Steps that did not run stay `executed: false`.

A page check can chain steps in one message: `expect title "..."`, `expect text "..."`, `type "..." into SELECTOR`, `click SELECTOR` or `click "text"`, `navigate URL`, `wait SELECTOR`, `wait N` or `wait Nms` (capped at 30 seconds), `scroll down`, `scroll up`, `scroll N` (capped at 2000 pixels), `scroll SELECTOR`, `press KEY`, and `expect selector SELECTOR value "..."`. `press` allows only Enter, Escape, Tab, Backspace, ArrowUp, ArrowDown, ArrowLeft, and ArrowRight. Any other key fails the step. `hover SELECTOR` or `hover "text"` moves the pointer onto that element. `double-click SELECTOR` or `double-click "text"` clicks that element twice. `right-click SELECTOR` or `right-click "text"` clicks it with the right button. `fill SELECTOR with "text"` or `fill "label" with "text"` clears that field and types the quoted text. `select SELECTOR option "label"` or `select "field" option "label"` chooses that option by its visible label. `check SELECTOR` or `check "label"` checks that box. `uncheck SELECTOR` or `uncheck "label"` clears it. A missing selector, quoted target, or option fails the step and later steps stay unexecuted. `wait SELECTOR` waits until that selector is visible. A failed wait or scroll stops the chain. `scroll SELECTOR` brings that element into view. The orchestration gateway does not run the browser. `navigate` stays on the host you opened, or on a host in `OCP_COMPUTER_ALLOW_HOSTS`. It does not crawl other sites. Each step is recorded in `gtm/last-run.json` with pass or fail and a screenshot when it ran. If a step fails, later steps stay `executed: false` and the transcript names the failed step. The QA agent also reads `gtm/assertion.json`. It fails when the claim does not match, when execute is off, or when the browser did not start.

After a coding write, `expect file path to contain "text"` asks the QA agent to check that snippet. A missing file, an empty file, or a file the security agent removed fails the review. The transcript says which file failed. On that failure, the coding agent writes again through the same path (the orchestration write bridge when the gateway drove the turn, otherwise the local sandbox) and QA runs again. A failed page claim is checked again the same way. This repeats until QA passes or two retries are used. The transcript then says `fix loop passed on retry N` or `fix budget exhausted after 2 retries`.

```bash
pnpm exec ocp chat --sandbox .sandbox --computer-execute "Open https://example.com and expect title \"Example Domain\""
```

You can also send one message and return:

```bash
pnpm exec ocp chat --sandbox .sandbox "Use the coding worker to create hello.txt with content:
hello
"
```

When the orchestration gateway is up, it owns the session plan on `agent:board:main`. The chat agent sends that plan with `sessions.send` and checks `skills.status` on that session. The local swarm does not run a second plan. If the gateway rejects the plan, the turn stops and no worker writes files. When the gateway is down, the transcript prints a manager plan from the local manager before any worker runs, and a create-file is a local sandbox write. The transcript says `Write path: local sandbox.`

After the plan is accepted, this process starts a loopback write bridge and asks the gateway to invoke `ocp_sandbox_write`, `ocp_sandbox_delete`, `ocp_sandbox_rename`, `ocp_sandbox_mkdir`, `ocp_sandbox_rmdir`, `ocp_sandbox_copy`, `ocp_sandbox_append`, or `ocp_sandbox_todo`. The gateway calls that bridge. The bridge runs the security gate, then writes, deletes, renames, creates, removes, copies, or appends the sandbox path, or updates the todo list. The transcript says `Write path: orchestration.`, `Delete path: orchestration.`, `Rename path: orchestration.`, `Mkdir path: orchestration.`, `Rmdir path: orchestration.`, `Copy path: orchestration.`, `Append path: orchestration.`, or `Todo path: orchestration.` A general edit is drafted in a temp directory by the meter, then each kept file is sent through that same bridge. The meter order is unchanged. `fs_write`, `apply_patch`, and `sessions_spawn` stay blocked. If the bridge tool is missing on the gateway, the turn asks the built-in `write` tool for an absolute path in the sandbox. If that also refuses, the file does not land and this process does not copy it in. `pnpm demo:connected` checks the gateway and the meter. It does not itself write a sandbox file. Do not commit `XAI_API_KEY`, `OPENAI_API_KEY`, or `OPENCLAW_GATEWAY_TOKEN`.

Live check when you have a gateway and a meter key. Tests do not call a live gateway. Load `integrations/openclaw-sandbox-write` in the gateway, then:

```bash
docker compose up -d openclaw-gateway
export OPENCLAW_GATEWAY_TOKEN="the gateway token"
export LITELLM_API_KEY="the operator key"
pnpm exec ocp chat --sandbox .sandbox "add a README section explaining install"
```

The sandbox file should exist, and the transcript should say `Write path: orchestration.` If the plugin is not loaded, the same command still tries the built-in `write` tool. A missing file means that tool refused the path.

Open the multi-file proof without a key: [examples/proof-multifile/src/math.ts](examples/proof-multifile/src/math.ts) and [examples/proof-multifile/src/math.test.ts](examples/proof-multifile/src/math.test.ts). With a meter key, this writes those files into `.sandbox-proof/`:

```bash
pnpm proof:coding
```

Native coding worker:

```bash
pnpm bundle:install
export OPENCLAW_GATEWAY_TOKEN="the gateway token"
export XAI_API_KEY="the operator key"
docker compose up -d openclaw-gateway
pnpm exec ocp chat --sandbox .sandbox
```

Compatible meter. `OPENAI_MODEL` is optional and defaults to `gpt-4o-mini`:

```bash
export OPENAI_API_KEY="the operator key"
export OPENAI_BASE_URL="https://your-litellm-or-openrouter/v1"
pnpm exec ocp chat --sandbox .sandbox
```

## Demo

```bash
pnpm install
pnpm test
pnpm exec ocp demo --sandbox .sandbox
pnpm exec opencodingpartner demo --sandbox .sandbox
pnpm demo:connected
```

`ocp demo --live` is the same command as `pnpm demo:connected`. It tries a real chat turn on the orchestration gateway and a real coding/QA call through the bundled coding-worker binary. The report says what ran and what was skipped.

Set these in your shell. Do not commit them.

```bash
export OPENCLAW_GATEWAY_TOKEN="the gateway token"
export XAI_API_KEY="the operator key"
docker compose up -d openclaw-gateway
pnpm demo:connected
```

Or point the coding meter at the proxy:

```bash
export LITELLM_API_KEY="the operator key"
export LITELLM_BASE_URL="https://your-litellm.example/v1"
```

`OPENAI_API_KEY` plus `OPENAI_BASE_URL` still works when no proxy key is set.

If the gateway is down, the chat turn is skipped. If no proxy key, compatible pair, or `XAI_API_KEY` is set, the coding call is skipped. The offline demo still works without the bundle.

The demo stands up a coding agent, a QA agent, a security agent, and a computer agent. The coding agent writes `PRODUCT.md` in the sandbox. The QA agent checks that file. The security agent blocks a path escape and a secret. The computer agent writes `gtm/action-plan.json`. Every computer action is marked not executed. No live browser ran.

## Credits

| Piece | License | Credit |
| --- | --- | --- |
| OpenClaw | MIT | OpenClaw Foundation — https://github.com/openclaw/openclaw |
| Grok Build | Apache-2.0 | xAI (SpaceXAI) — https://github.com/xai-org/grok-build |
| Laya | Apache-2.0 | Convai Innovations — https://pypi.org/project/laya/ and https://huggingface.co/convaiinnovations/laya |
| LiteLLM | MIT | BerriAI — https://github.com/BerriAI/litellm |
| Hermes Agent | MIT | Nous Research — https://github.com/NousResearch/hermes-agent — optional ACP-shaped backend, not installed and not required |
| OpenCodingPartner | Apache-2.0 | OpenCodingPartner contributors |

Full wording is in [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

## Independence

We package and connect the tools named in Credits. We are not affiliated with those projects. The offline demo still uses a local sandbox. System-1 uses the install from `pnpm bundle:install` (or `pnpm bundle:install:laya`) and says fallback when that Python is missing. The computer agent does not run a browser unless you pass `--computer-execute`. Orchestration owns the session plan. A create-file after that plan uses the gateway `write` tool. General model edits still run in this process. System-1 weights download into `.bundle/laya/hf` and are not committed.
