# Partner working agreement

Open Coding Partner (OCP) uses this file as the partner agreement for a repo or a sandbox. A coding turn that sees `PARTNER.md` in the sandbox follows this loop. There is no approve card yet.

## Loop

1. Intent. The chat message is saved at `.ocp/sdlc/intent.md`.
2. Spec. A short restatement of that request is saved at `.ocp/sdlc/spec.md`.
3. Plan. The steps are saved at `.ocp/sdlc/plan.md`. Edits wait until a later message says `accept the plan`.
4. Diff and tests. After the plan is accepted, the coding worker edits the sandbox and runs the named check `node --test` in that sandbox.
5. Review. The QA agent does the mechanical review (files and the check). A human still owns intent and risk. The split is written at `.ocp/sdlc/review.md`.
6. Fail. A failed check or a failed mechanical review goes back to intent. `.ocp/sdlc/review-hold` stays until the plan is accepted again.

An explicit create-file message still writes that one file. It is not an open edit.

## Review hold

While `.ocp/sdlc/review-hold` exists, orchestration stands up one coding worker. The board session already runs one chat turn at a time. The ceiling is one coding worker during the hold, not a one-worker product. The early-test cap of 8 agents stays temporary and is a different limit.

## Self-verify

The named check is `node --test`, run in the sandbox with no shell. The transcript reports the exit code. The coding worker does not invent a pass.
