# Plugin catalog

Open Coding Partner is a local open-source coding partner. A plugin is a manifest the operator installs onto one bot on this machine. It bundles skills and HTTP MCP connectors the product already knows how to run, plus the secrets those connectors need. It is not a new runtime, and it is not a hosted store.

The product version is **0.2.0**. Phase 1 is in this tree: the manifest parser, the shipped catalog, install and uninstall, `GET /api/plugins`, `POST /api/plugins/:id/install`, `POST /api/plugins/:id/uninstall`, and the Plugins tab. An operator catalog URL is not fetched yet. The rule that refuses an operator manifest with a shipped id is implemented and tested.

Voice and meetings are not now. No plugin adds a voice route or a meeting surface. Ads stay off. There is no payment, no paid listing, and no hosted marketplace. There is no NovaMind backend. The app keeps binding to loopback. A catalog URL, when one is fetched in a later phase, is an outbound fetch from this machine. It does not open a public port.

## What already exists

Install sits on these surfaces. A plugin does not get a side door around them.

| Surface | Today |
| --- | --- |
| Connectors | Per bot. Name, `http` or `https` URL, optional auth header name. The token is stored in `mcp-secrets.json`, not in `state.json`, and is not returned by the API. A session probes `tools/list`. A probe error stops that session. Tool calls use names like `mcp:server/tool`. |
| Skills | Library files live under `skills/<id>/SKILL.md`. Frontmatter is `name` and `when-to-use`. The body is steps. There is no skill runtime. The library holds at most 100 skills. A pack import holds at most 40. A plugin skill is enabled per bot. Other library skills stay visible to every bot. |
| Vault | Encrypted items of kind login, oauth, token, or note. A bot can fill a virtual-computer login by item name. The secret is not sent to the model and is not written into the task log. |
| Accounts | The operator pastes their own Google or Microsoft OAuth client. OCP ships no client. Gmail and Outlook writes are draft cards. A person sends. |
| Channels | Slack and Telegram replies stay drafts until a person sends them. WhatsApp and Teams reach stay drafts. Allowing either of those two still sends nothing. |
| Deny rules | A rule can name a tool, including `mcp:server/tool`, a relative path, a command prefix, and a person or a routine. A broken rules file refuses every call. A proactive task can read and cannot shell, write, send, or drive the computer. |
| Approvals | Allow once, Always, Deny, and Redirect. External MCP calls wait for approval unless that bot's action rule says to act. |

## Plugin manifest

A plugin is one JSON object. Unknown keys make the manifest invalid. An invalid manifest is not installed.

Canonical bytes are the object with `checksum` and `signature` removed, keys sorted at every object level, no insignificant whitespace, UTF-8. `checksum` is `sha256:` plus the hex digest of those bytes. Install refuses a mismatch.

```json
{
  "id": "github",
  "name": "GitHub",
  "description": "Read issues and pull requests through an HTTP MCP server you run. Opening a pull request still waits for a person. Merging stays with a person.",
  "version": "1.0.0",
  "minOcpVersion": "0.2.0",
  "checksum": "sha256:",
  "mcpServers": [
    {
      "name": "github",
      "authHeader": "Authorization",
      "urlField": "mcpUrl"
    }
  ],
  "skills": [
    {
      "name": "Work a GitHub issue",
      "whenToUse": "A GitHub issue should become a reviewed local change.",
      "body": "1. Read the issue.\n2. Draft a plan and wait for approval.\n3. Do not merge."
    }
  ],
  "secrets": [
    {
      "name": "github-token",
      "kind": "token",
      "label": "GitHub token from the operator's own account",
      "storage": "vault"
    }
  ],
  "setupFields": [
    {
      "name": "mcpUrl",
      "label": "HTTP MCP URL for this bot",
      "kind": "url",
      "required": true
    }
  ],
  "permissions": ["network", "workspace.read", "draft.message"],
  "accounts": []
}
```

Fields:

| Field | Rule |
| --- | --- |
| `id` | 1–80 characters, `a-z`, `0-9`, and single hyphens. Stable across versions. A shipped id changes only when OCP is updated. |
| `name` | 1–80 characters, shown on the card. |
| `description` | 1–300 characters. It must not claim that a message was sent. |
| `version` | `MAJOR.MINOR.PATCH`, numeric, each part at most 6 digits. |
| `minOcpVersion` | Same shape. Compared with `@opencodingpartner/product`, which is 0.2.0. A higher requirement is refused. An equal version is allowed. A product at 0.1.0 refuses these manifests. |
| `mcpServers` | Zero or more. `name` matches the connector name rule. `urlField` points at a setup field of kind `url`. No URL is baked into the shipped catalog. `authHeader` defaults to `Authorization`. An MCP server requires the `network` permission. |
| `skills` | Zero or more `SKILL.md` bodies. The same limits as the skills library: name 1–80, when-to-use 1–300, body 1–20,000. A plugin may contain at most 40 skills. |
| `secrets` | Vault item name, kind, and label. The manifest holds no secret value. |
| `setupFields` | `url`, `text`, or `account`. `account` is only `google` or `microsoft`, and it opens the existing Accounts flow. |
| `permissions` | Closed list below. The empty list is valid for a skill-only plugin. |
| `accounts` | Subset of `google` and `microsoft`. Presence means "use the operator's existing client", not "embed a client". |
| `draftOnly` | Optional. Teams and WhatsApp set it. The card shows **Draft only**. |
| `checksum` | Required. |
| `signature` | Refused while no public key is pinned. That pin is Phase 3. |

A manifest needs at least one skill or one MCP server. It cannot be empty.

### Permissions

The closed list:

| Permission | What install is allowed to prepare |
| --- | --- |
| `network` | Save an HTTP MCP URL on the chosen bot and probe it. |
| `workspace.read` | Skills may tell the bot to read the workspace. The workspace tools still apply. |
| `workspace.write` | Skills may tell the bot to edit files. `plan_submit` and the human plan approval still apply. |
| `draft.message` | Skills may draft Slack, Telegram, mail, WhatsApp, or Teams. The existing draft gate still applies. |
| `account.read` | Use the connected Google or Microsoft read tools. |
| `account.draft` | Use `gmail_draft` or `outlook_draft`. A person sends from the draft card. |
| `computer` | Skills may mention the virtual computer. Take Control, the sign-in wall, and vault fill rules still apply. |
| `vault.fill` | Skills may name a vault item. The secret is still not returned to the model. |

These tokens are rejected, and the manifest is invalid:

- `message.send`
- `payment`
- `voice`
- `meeting`

`draft.message` does not authorize a send. Slack and Telegram still wait for the person on the channel draft. WhatsApp and Teams still stay in the local outbox after Allow. Gmail and Outlook still do not request send scope. A plugin tool call that is classified as an external MCP call still waits on the approval gate, and deny rules still run before the call.

A tool whose name ends in `_send` or `-send`, or whose description says it sends, is refused at install. Phrases that say the tool sends nothing, does not send, or that nothing is sent are allowed. `draft.message` does not authorize that tool.

## Local catalog index

Two sources are specified. Only the shipped catalog is fetched today.

1. **Shipped catalog.** `packages/product/catalog/plugins.json`. It ships with the app. It is the trust root for its ids. The loader reads it from `packages/product/catalog/plugins.json` next to the compiled output.
2. **Operator catalog URL.** Not fetched in this phase. The merge rule is already decided and tested: `operatorCatalogDecision` returns `refused` when the id is shipped and `add` when it is not. A plugin from an operator URL with the same id as a shipped plugin cannot replace, hide, or downgrade the shipped one. A fetch error, once fetching exists, must leave the shipped catalog in place.

There is no account to sign up for, no listing fee, and no remote install log.

## How a plugin bundles skills and connectors

One manifest is one install on one bot. Installing a plugin does not change every bot.

- Each skill is written with the same library writer the Skills page uses. `tool_search` returns `skill:<id>` only for a bot that has that plugin installed. If no actor bot is set, plugin skills stay hidden. Starter skills and other library skills that are not part of a plugin install stay visible to every bot.
- A second bot can install the same plugin. The skill file is not copied again when the body checksum matches. A different body is refused with "A skill with that name already exists."
- Each MCP server is written onto the bot the person picked. The token is copied into `mcp-secrets.json` for that bot and server name only. The vault keeps its own copy. If the vault item already exists and the person does not type a new secret, the saved item is reused. Typing a new secret over an existing item is refused.
- Setup fields of kind `account` do not create a second OAuth client. The card points at Accounts.
- The install record in the data directory, `plugins.json`, stores one row per plugin and bot: plugin id, version, checksum, bot id, connector names, skill ids, a checksum of each skill body, vault item names, the non-secret setup fields, and the install time.

## Install and uninstall

Update is not in this build. A later phase can offer a greater version, show new permissions, and roll a failed probe back to the previous checksums.

### Install

1. The person searches the catalog on this machine and opens a card.
2. The card lists the version, the permissions, the setup fields, and the short checksum. It names the bot that will receive the connectors.
3. Secret values go to the vault under the manifest's item name. The install response is `{ ok, pluginId, botId }` and does not echo the secret.
4. The app checks `minOcpVersion`, the checksum, the closed permission list, and the connector URL rules before it writes a skill, a connector, or a secret. A bad manifest writes nothing.
5. It writes the vault item, the skills, the connector secret, and the connector, then probes. A skill-only plugin does not probe.
6. If the probe fails, or a listed tool claims to send, the app deletes the skills, connector, and connector secret it just wrote for this install. The vault item the person typed stays. The install record is not kept. The error is the probe error.
7. An audit row records `plugin.install`, the plugin id, and the bot id. The row does not contain the secret.

### Uninstall

Uninstall targets the bot the person picks. It removes that bot's connector and that bot's `mcp-secrets.json` entry. It removes a skill file only when no remaining install uses it and the file body checksum still matches the install record. A skill the person edited is left in the library, and the result lists it in `keptSkills`.

Vault items stay unless the person ticks **also delete saved secrets**. That choice is off by default. The vault is shared on this machine, so the checkbox removes the named item for every bot. Those items may also be used by Issue to PR.

The install record for that bot is removed. An audit row records `plugin.uninstall`.

## Trust and safety

A checksum proves the manifest bytes. It does not constrain the remote server after install. The shipped catalog does not vendor third-party servers. The operator supplies every MCP URL and every token.

The Plugins tab states that limit in the pane: "A checksum proves the manifest. It does not constrain the remote server after install."

A signature field is reserved for Phase 3. Until a public key is pinned, a manifest that includes `signature` is refused. Phase 3 can pin an ed25519 public key for the shipped catalog. Checksums stay required either way.

Permission prompts happen at install. Accepting `draft.message` does not accept a send. An update that adds a permission is not built yet, so there is no second prompt in this phase.

After install, the existing gates still wrap every call:

- Deny rules match the tool name, including `mcp:server/tool`. A command prefix still refuses a shell before it runs. A broken rules file still refuses every call.
- External MCP calls still wait for approval unless that bot's action rule says to act.
- Plan approval still sits in front of workspace writes.
- Channel, mail, WhatsApp, and Teams drafts still apply. A plugin cannot register a sender. The installer rejects `message.send`.
- Proactive tasks and responsibility checks stay read-only.
- Audit rows redact `sk-` tokens, bearer values, and `token=`, `password=`, and `secret=` assignments.
- Connector URLs still cannot carry userinfo. Secrets still stay out of `state.json` and out of the task log.

A remote server can misbehave after a good checksum. The mitigation is the approval gate, the deny rule, and uninstall. This design does not sandbox the remote process.

## Plugins tab

The tab sits in the Connect group, beside Connectors.

- Button: `data-tab="plugins"`, label **Plugins**.
- Pane: `id="tab-plugins"`.
- Search: `id="pluginSearch"`. It filters the cards already loaded, by name and description. Typing in the search box does not call a search service.
- List: `id="pluginList"`.

Each card shows the name, a **Draft only** pill when `draftOnly` is set, a **Shipped** pill, an **Installed** pill when a bot in the current project has it, the version, the checksum prefix, the description, the skill name, and the permission names. The install form asks for the bot, the setup fields, and password inputs for secrets. The uninstall form asks for the bot and the checkbox **also delete saved secrets**.

Google and Microsoft cards say they use the account already saved in Accounts and do not add another OAuth client.

Visuals use the studio tokens already on the page. Dark, Light, and System keep working through `data-theme`. No separate palette, no price, and no promotional block. Under 820px the card stacks in the inspector sheet the same way the other Connect panes do.

Copy on the pane states the limits: a plugin installs on one bot, a checksum does not constrain the remote server after install, drafts still wait for a person, and allowing a WhatsApp or Teams draft still sends nothing.

## Starter plugins

These eighteen ship in `packages/product/catalog/plugins.json`. They are catalog entries and skill text. They are not running servers. Each one needs something the operator already controls. OCP does not ship the token, the OAuth client, or the MCP process.

| Plugin | What the operator provides | What it is allowed to do |
| --- | --- | --- |
| GitHub | A personal or fine-grained token in the vault, and an HTTP MCP URL they run or choose. OCP does not ship a GitHub App. | Read issues and pull requests. Issue to PR still asks the person to approve the plan. Merging stays with the person. |
| Linear | A Linear API key in the vault, and an MCP URL. | Read issues. Changing a workflow state waits for approval. |
| Jira | Site URL, account email, and an API token in the vault, and an MCP URL. OCP does not ship an Atlassian app. | Read issues. Writing or transitioning an issue waits for approval. |
| Confluence | Site URL and an API token in the vault, and an MCP URL. | Read pages. Writing a page waits for approval. |
| Slack drafts | The operator's own Slack app: bot token and signing secret, already saved in Settings. | A skill that drafts a reply. The existing channel Allow path is the only send. The plugin adds no send tool. |
| Telegram drafts | The operator's bot token and webhook secret in Settings. | Same draft rule as Slack. |
| Notion | A Notion integration token in the vault, and an MCP URL they supply. OCP does not host a Notion server. | Read pages the integration can see. Writing a page waits for approval. |
| Google | An OAuth client the operator creates, pasted into Accounts. Scopes stay the ones in [OAuth clients](oauth-setup.md). The plugin does not embed a second client. | Gmail read, Gmail draft, Calendar read, Calendar create with approval, Drive read. A send scope is not requested. |
| Microsoft | An Entra application the operator registers, pasted into Accounts. | Outlook read, Outlook draft, calendar, OneDrive read. A person sends mail from the draft card. Full file write scope is not requested. |
| Figma | A personal access token in the vault, and an MCP URL. | Read files. |
| Sentry | An auth token in the vault, and an MCP URL. | Read issues. Resolving an issue waits for approval. |
| PagerDuty | An API token in the vault, and an MCP URL. | Read incidents. Acknowledging or paging waits for approval. |
| Teams drafts | No Graph application is included. The card is labeled **Draft only**. | A skill that uses the existing Teams reach draft. Allowing it still writes the local outbox and sends nothing. |
| WhatsApp drafts | No Cloud API client is included. The card is labeled **Draft only**. | A skill that uses the existing WhatsApp draft. Allowing it still sends nothing. |
| Penpot | The operator's own instance URL and a token in the vault. OCP does not ship a Penpot server or a Penpot client. | Read designs on that instance. Changing a design waits for approval. |
| Storybook | A local or hosted Storybook URL. OCP does not host Storybook and does not include a Storybook client. | Read stories and components and compare them with the design. |
| Canva | An access token from a Canva developer app the operator registers. OCP does not ship a Canva client. This is not the Google or Microsoft account in Accounts. | Draft marketing visuals. No payment scope is requested. |
| Image generation | The operator's own OpenAI-compatible image endpoint URL, model id, and model key. There is no default provider and no baked host. | `image_generate` posts only to that endpoint and records the call on the usage meter. A meter cap stops the call before any request. |

Voice and meeting plugins are not in this list. They are not now.

## Phased plan

Sizes are the code each phase has to touch. They are not a release schedule.

### Phase 1. Manifest, shipped catalog, install, uninstall, tab

Shipped in this tree.

- `packages/product/src/plugins.ts` parses a manifest, loads the shipped catalog, installs and uninstalls on one bot, and filters plugin skills by bot.
- `packages/product/catalog/plugins.json` holds the eighteen starters, including Penpot, Storybook, Canva, and Image generation. `minOcpVersion` is 0.2.0. `@opencodingpartner/product` is 0.2.0.
- `GET /api/plugins` returns the catalog without secrets. `POST /api/plugins/:id/install` and `POST /api/plugins/:id/uninstall` require the local app token.
- The Plugins pane is in the Connect group.
- `tool_search` and `tool_describe` use the per-bot skill filter.

This phase does not fetch a catalog URL and does not change the channel send path.

### Phase 2. Update, operator URL, audit on update

Add `pluginCatalogUrl` to settings. Fetch with a timeout, a 256 KB cap, and `https` only, plus loopback `http://127.0.0.1` or `http://localhost` for a file server on this machine. Userinfo is refused. Offer updates, re-prompt for new permissions, and roll a failed update probe back to the previous checksums. A shipped id stays refused, which the pure rule already tests.

### Phase 3. Pinned signature

Pin an ed25519 public key for the shipped catalog and refuse a signature that does not verify. Checksums remain required. The pane already states that a checksum does not constrain the remote server after install. A signature does not change that limit for the process behind the URL; it only proves the manifest bytes came from the pinned key.

### Not in these phases

- A hosted marketplace, a listing account, ads, or payments.
- A voice or meeting plugin.
- A plugin permission that sends mail, Slack, Telegram, WhatsApp, or Teams on its own.
- Vendoring someone else's MCP server.
- Listening beyond loopback. `OCP_DOCKER_BIND=bridge` stays the only way to bind wider, and compose still publishes `127.0.0.1:4317` only.

## Test strategy

Phase 1 tests live in `packages/product/src/plugins.test.ts`. They are local. The only network is a loopback MCP fixture.

- A valid connector install enables the skill only for that bot, stores the connector on that bot, and stores the token in `mcp-secrets.json` for that bot only. `state.json`, the install record, the audit file, and the install response do not contain the token.
- A second bot does not see the plugin skill until that bot installs it. A matching skill body is not duplicated. A library starter stays visible to both.
- Unknown keys, a bad id, a bad URL, userinfo in a URL, `minOcpVersion` 0.3.0, `message.send`, `payment`, `voice`, `meeting`, a checksum mismatch, and a `signature` field refuse the install and write nothing.
- `versionAccepts("0.2.0", "0.1.0")` is false. Product version 0.1.0 would refuse this catalog.
- A probe failure and a tool that sends roll back the skill and leave the vault item. The connector and connector secret are not kept.
- Uninstall removes the connector and secret. An edited skill file is kept when it is the last copy. Vault items stay unless **also delete saved secrets** is set.
- A deny rule on `mcp:github/create_issue` still refuses that call. The audit row quotes the rule id.
- Teams and WhatsApp manifests are `draftOnly` and do not request `message.send`.
- Penpot, Storybook, Canva, and Image generation parse, match their checksums, and do not request `message.send` or `payment`. Penpot stores an instance URL and a vault token. Storybook stores a URL and no secret. Canva stores an oauth vault token and does not use the Google or Microsoft account. Image generation stores an endpoint URL, a model id, and a vault key.
- Image generation calls only the saved endpoint. A missing install, a missing key, and a reached usage cap do not call a host. A completed call is recorded on the usage meter. `image_generate` is not part of a proactive pass.
- The page HTML contains `data-tab="plugins"`, `id="pluginSearch"`, `id="pluginList"`, the checksum sentence, **Draft only**, and **also delete saved secrets**. The inline script parses. Search is an input listener over `state.plugins`.
- `operatorCatalogDecision` refuses a shipped id and allows a new id.
- Strict branding guard and lint stay clean. The pane does not mention voice as an available feature.

Phase 2 still needs tests for a non-loopback `http` catalog URL, a failed fetch that keeps the shipped catalog, and an update that waits for a new permission. Phase 3 still needs a signature that does not verify to be refused.

## Board decisions

These were open in the first draft of this page. They are settled.

1. Plugin skills are enabled per bot, the same way connectors are. Installing a plugin does not change every bot.
2. A shipped plugin id changes only when OCP is updated. A plugin from an operator URL with the same id as a shipped one is refused, so it cannot replace the shipped one.
3. A checksum is enough for now. A checksum does not constrain the remote server after install. That limit is stated in this page and on the Plugins tab. The pinned signature stays in Phase 3.
4. Uninstall keeps vault items unless the person ticks **also delete saved secrets**.
5. Teams and WhatsApp ship now. Their cards are labeled **Draft only**. Allowing either draft still sends nothing.
6. `minOcpVersion` is 0.2.0. `@opencodingpartner/product` is 0.2.0. A 0.1.0 product refuses these manifests.

## Limits

- The operator supplies every token, OAuth client, MCP URL, Penpot instance, Storybook URL, Canva app, and image endpoint. Nothing in the catalog is a hosted integration.
- Penpot, Storybook, and Canva do not include those products' clients. They save what the operator types onto one bot.
- Image generation has no default provider. `image_generate` uses the endpoint and key saved for that bot and records the call on the usage meter. Cost uses a price the operator enters. A loopback endpoint is counted as local.
- A checksum does not constrain the remote server after install.
- No operator catalog URL is fetched yet. No update route is built. No signature is pinned.
- WhatsApp and Teams drafts still send nothing after Allow.
- Slack and Telegram still send only after a person allows the draft. Gmail and Outlook still have no send scope.
- There is no hosted marketplace, no payment, and no ads.
- Voice and meetings are not now.
- Loopback bind is unchanged.
