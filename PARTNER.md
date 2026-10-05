# Partner working agreement

Open Coding Partner (OCP) uses this file as the partner agreement for a repo or a sandbox. A coding turn that sees `PARTNER.md` in the sandbox follows this loop.

## Loop

1. Intent. The chat message is saved at `.ocp/sdlc/intent.md`.
2. Spec. A short restatement of that request is saved at `.ocp/sdlc/spec.md`.
3. Plan. The steps are saved at `.ocp/sdlc/plan.md`. The chat shows an Approve card in the transcript and stores the queue at `.ocp/approvals.json`. Edits wait until you say `approve` or `accept the plan`. `deny` stops the edit. `redirect: note` sends the note back to intent and opens a new card.
4. Diff and tests. After the plan is accepted, the coding worker edits the sandbox and runs the named check `node --test` in that sandbox.
5. Review. The QA agent does the mechanical review (files and the check). Human intent and risk are the Approve card before the edit. The split is written at `.ocp/sdlc/review.md`.
6. Fail. A failed check or a failed mechanical review goes back to intent. `.ocp/sdlc/review-hold` stays until the plan is accepted again.

An explicit create-file message still writes that one file. It is not an open edit. When the orchestration gateway drives that write for a partner, the file lands in that partner workspace, not the session root.

## Review hold

While `.ocp/sdlc/review-hold` exists, orchestration stands up one coding worker. The board session already runs one chat turn at a time. The ceiling is one coding worker during the hold, not a one-worker product. The early-test cap of 8 agents stays temporary and is a different limit.

## Computer tab

`ocp computer` shows the sandbox desktop: who has control, and the last frame path. There is no live pixel stream in this build. `ocp computer --partner coding` shows that partner's own workspace, including whether its container is running or stopped, and the last frame path and time. `ocp computer capture` writes `gtm/last-frame.png` in this workspace. A browser run captures the step screenshot into that same file, then Computer QA `computer-frame` checks it. A missing page or a file that is not a PNG fails the turn in the transcript. `ocp computer qa` prints pass or fail and does not open a page. A live pixel stream is still later. `ocp fleet start --partner coding` starts it when Docker is installed. With this file present, start waits on an Approve card. If Docker is missing, start fails and does not claim the container is running. `ocp computer takeover` gives you the mouse and keyboard handoff. The partner does not run the browser while you hold it. `ocp computer return` gives control back. Starting the browser waits on an Approve card.

## Routines and channels

A routine in `.ocp/routines.json` can wake a partner on an interval or an event name while you are away. `ocp routine run` fires the ones that are due. Slack or Telegram text arrives as a partner turn. `approve`, `deny`, and `redirect:` in that text decide the Approve card. Slack posts a reply when `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are set. Inbound Slack events are checked with the signing secret. Without those values the offline turn still runs, and the values are not printed. Telegram does not call Telegram. WhatsApp is later.

## Swarm manifest

`docs/examples/swarm.json` lists partners and routines. `ocp swarm apply` creates each partner workspace under `.ocp/fleet` and registers the routines. `ocp swarm validate` and `--dry-run` do not write. A short interval is refused. The manifest does not start a container.

## Partner rules

Write rules in `PARTNER.rules` at the sandbox root, or in `.ocp/rules`. The coding worker sees both in its prompt. A line `block: text` stops the turn when the message contains that text.

## Self-verify

The named check is `node --test`, run in the sandbox with no shell. The transcript reports the exit code. The coding worker does not invent a pass.
