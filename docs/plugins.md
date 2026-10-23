# Plugin catalog

Open Coding Partner is a local open-source coding partner. A plugin is a manifest the operator installs onto this machine. It bundles skills and HTTP MCP connectors the product already knows how to run, plus the secrets those connectors need. It is not a new runtime, and it is not a hosted store.

This page is the design. Nothing in it is installed by the app yet. The product version that can install a plugin is proposed as **0.2.0**. The tree today is **0.1.0**.

Voice and meetings are not now. No plugin adds a voice route or a meeting surface. Ads stay off. There is no payment, no paid listing, and no hosted marketplace. There is no NovaMind backend. The app keeps binding to loopback. A catalog URL, when the operator sets one, is an outbound fetch from this machine. It does not open a public port.

## What already exists

Install must sit on these surfaces. A plugin does not get a side door around them.

| Surface | Today |
| --- | --- |
| Connectors | Per bot. Name, `http` or `https` URL, optional auth header name. The token is stored in `mcp-secrets.json`, not in `state.json`, and is not returned by the API. A session probes `tools/list`. A probe error stops that session. Tool calls use names like `mcp:server/tool`. |
| Skills | Shared on this machine, under `skills/<id>/SKILL.md`. Frontmatter is `name` and `when-to-use`. The body is steps. `tool_search` returns `skill:<id>` and the steps. There is no skill runtime. The library holds at most 100 skills. A pack import holds at most 40. |
| Vault | Encrypted items of kind login, oauth, token, or note. A bot can fill a virtual-computer login by item name. The secret is not sent to the model and is not written into the task log. |
| Accounts | The operator pastes their own Google or Microsoft OAuth client. OCP ships no client. Gmail and Outlook writes are draft cards. A person sends. |
| Channels | Slack and Telegram replies stay drafts until a person sends them. WhatsApp and Teams reach stay drafts. Allowing either of those two still sends nothing. |
| Deny rules | A rule can name a tool, a relative path, a command prefix, and a person or a routine. A broken rules file refuses every call. A proactive task can read and cannot shell, write, send, or drive the computer. |
| Approvals | Allow once, Always, Deny, and Redirect. External MCP calls wait for approval unless that bot's action rule says to act. |

## Plugin manifest

A plugin is one JSON object. Unknown keys make the manifest invalid. An invalid manifest is not installed.

Canonical bytes are the object with `checksum` and `signature` removed, keys sorted at every object level, no insignificant whitespace, UTF-8. `checksum` is `sha256:` plus the hex digest of those bytes. Install refuses a mismatch.

```json
{
  "id": "github",
  "name": "GitHub",
  "description": "Read issues and pull requests. Opening a pull request still waits for a person. Merging stays with a person.",
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
| `id` | 1–80 characters, `a-z`, `0-9`, and single hyphens. Stable across versions. |
| `name` | 1–80 characters, shown on the card. |
| `description` | 1–300 characters. It must not claim that a message was sent. |
| `version` | `MAJOR.MINOR.PATCH`, numeric, each part at most 6 digits. |
| `minOcpVersion` | Same shape. Compared with the `@opencodingpartner/product` version. A higher manifest requirement is refused. |
| `mcpServers` | Zero or more. `name` matches the connector name rule. `urlField` points at a setup field of kind `url`. No URL is baked into the shipped catalog. `authHeader` defaults to `Authorization`. |
| `skills` | Zero or more `SKILL.md` bodies. The same limits as the skills library: name 1–80, when-to-use 1–300, body 1–20,000. A plugin may contain at most 40 skills. |
| `secrets` | Vault item name, kind, and label. The manifest holds no secret value. |
| `setupFields` | `url`, `text`, or `account`. `account` is only `google` or `microsoft`, and it opens the existing Accounts flow. |
| `permissions` | Closed list below. The empty list is valid for a skill-only plugin. |
| `accounts` | Subset of `google` and `microsoft`. Presence means "use the operator's existing client", not "embed a client". |
| `checksum` | Required. |
| `signature` | Absent in the first phase. When present later, it is verified or the install is refused. |

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

## Local catalog index

Two sources, both read by this machine:

1. **Shipped catalog.** A JSON array committed in the repo, proposed path `packages/product/catalog/plugins.json`. It ships with the app. It is the trust root for its ids.
2. **Operator catalog URL.** Optional. A setting `pluginCatalogUrl` on this machine. Empty by default. When set, the app fetches it with a timeout, a 256 KB cap, and `https` only. `http` is refused, except a loopback `http://127.0.0.1` or `http://localhost` URL so an operator can point at a file server on this machine. Userinfo in the URL is refused. The response is a JSON array of manifests.

Merge rules:

- The shipped id always wins. An operator URL cannot replace, hide, or downgrade a shipped plugin.
- An id that exists only on the URL is shown as an operator plugin.
- A fetch error leaves the shipped catalog in place and shows the error. It does not present an empty catalog.
- The fetch is outbound. The app does not listen for catalog traffic. Loopback bind is unchanged.

There is no account to sign up for, no listing fee, and no remote install log.

## How a plugin bundles skills and connectors

One manifest is one install. The skills and the connectors are not separate products.

- Skills are copied into the shared skills library as `SKILL.md` files, through the same writer the Library page uses. They show up in `tool_search` as `skill:<id>`.
- Each MCP server is written onto the bot the person picked, through the same connector record the Connectors page uses. The token from the matching vault item is copied into `mcp-secrets.json` for that bot and server name. The vault keeps its own copy.
- Setup fields of kind `account` do not create a second OAuth client. The card links to Accounts.
- The install record in the data directory, `plugins.json`, remembers the plugin id, version, checksum, bot ids, skill ids, connector names, vault item names, and a checksum of each skill body. That record is how update and uninstall know what they added.

Skills stay machine-wide because the library is machine-wide today. Connectors stay per bot because connectors are per bot today. Installing GitHub for Ada does not attach the GitHub connector to Linus. Both can see the skill.

## Install, update, and uninstall

### Install

1. The person searches the catalog and opens a card.
2. The card lists the version, the permissions, the setup fields, and the short checksum. It names the bot that will receive the connectors.
3. The person fills the fields. Secret values go to the vault under the manifest's item name. They are not echoed back by the install response.
4. The app checks `minOcpVersion`, the checksum, the closed permission list, and the connector URL rules. Any failure stops before a write.
5. The app writes the install record, the skills, the connector, and the connector secret.
6. It probes the new connector. If the probe fails, it deletes the skills, connector, and connector secret it just wrote, and leaves any vault item the person typed. The install record is removed. The error is the probe error, not a success with an empty tool list.
7. An audit row records `install`, the plugin id, and the bot id. The row does not contain the secret.

A second install of the same id on another bot adds that bot's connector and does not duplicate the skill files.

### Update

An update is offered when the catalog has a greater version for an installed id. The shipped catalog only changes when OCP itself is updated. An operator plugin updates from its URL.

The card shows permissions that are new since the installed version. The person must accept those permissions. A version that adds `message.send` or any rejected token is refused, and the installed copy stays.

Skills are replaced when their body checksum differs. Connector URL and header name are replaced. Vault items are left as they are unless the person types a new value. A failed probe rolls the skills and connector record back to the previous checksums.

A lower version is not installed unless the person chooses a downgrade on that card. A downgrade uses the same permission prompt.

### Uninstall

Uninstall removes the connector and its `mcp-secrets.json` entry from every bot this plugin was installed on. It removes a skill only when the file's checksum still matches the install record. A skill the person edited is left in the library, and the result says so.

Vault items are kept. The card offers a separate choice, off by default, to delete the vault items named in the install record. Those items may also be used by Issue to PR.

The install record is removed after the connector cleanup. An audit row records `uninstall`.

## Trust and safety

The checksum proves the manifest bytes. It does not prove what a remote MCP process will do later. The shipped catalog does not vendor third-party servers. The operator supplies every MCP URL.

A signature field is reserved. The first implementation requires the checksum and ignores no signature: if `signature` is present before the pin exists, install is refused. A later phase can pin an ed25519 public key in the repo for the shipped catalog, and a second key the operator sets for their URL. Unknown keys are refused. A bad signature is refused.

Permission prompts happen at install and again when an update adds a permission. Accepting `draft.message` does not accept a send.

After install, the existing gates still wrap every call:

- Deny rules match the tool name, including `mcp:server/tool` and `skill:` names when a rule is written that way. A command prefix still refuses a shell before it runs. A broken rules file still refuses every call.
- External MCP calls still wait for approval unless that bot's action rule says to act.
- Plan approval still sits in front of workspace writes.
- Channel, mail, WhatsApp, and Teams drafts still apply. A plugin cannot register a sender. The installer rejects `message.send`. A tool whose name ends in `_send` or whose description says it sends is refused at install for shipped plugins, and an operator plugin with that shape is shown as blocked rather than installed.
- Proactive tasks and responsibility checks stay read-only.
- Audit rows redact `sk-` tokens, bearer values, and `token=`, `password=`, and `secret=` assignments.
- Connector URLs still cannot carry userinfo. Secrets still stay out of `state.json` and out of the task log.

A remote server can misbehave after a good checksum. The mitigation is the approval gate, the deny rule, and uninstall. This design does not sandbox the remote process.

## Plugins tab

The tab sits in the Connect group, beside Connectors, Channels, Accounts, and Vault.

- Button: `data-tab="plugins"`, label **Plugins**.
- Pane: `id="tab-plugins"`.
- Search: `id="pluginSearch"`, filters the loaded cards on this machine by name and description. It does not call a search service.
- List: `id="pluginList"`.

Each card shows the name, the description, the version, a **Shipped** or **Operator** mark, the permission names, and **Install** or **Installed**. Installed cards show **Update** when a greater version is available, and **Uninstall**.

The install sheet is the same pane, not a new window. It has the bot select, the setup fields, the permission list, the checksum prefix, and **Install this plugin**. Secret inputs are `type="password"`. The response text never includes the value.

Visuals use the studio tokens already on the page: surface, line, text, muted, and accent. Dark, Light, and System keep working through `data-theme`. The card is the existing nav-list article. No separate palette, no price, and no promotional block. At the narrow sheet, under 820px wide, the card stacks in one column inside the inspector sheet the same way the other Connect panes do.

Copy on the pane states the limits in one line: plugins install on this machine, drafts still wait for a person, and WhatsApp and Teams drafts still send nothing.

## Starter plugins

These fourteen are catalog entries and skill text. They are not running servers. Each one needs something the operator already controls. OCP does not ship the token, the OAuth client, or the MCP process.

| Plugin | What the operator provides | What it is allowed to do |
| --- | --- | --- |
| GitHub | A personal or fine-grained token in the vault, and an HTTP MCP URL they run or choose. OCP does not ship a GitHub App. | Read issues and pull requests. Issue to PR still asks the person to approve the plan. Merging stays with the person. |
| Linear | A Linear API key in the vault, and an MCP URL. | Read issues. Changing a workflow state waits for approval. |
| Jira | Site URL, account email, and an API token in the vault, and an MCP URL. OCP does not ship an Atlassian app. | Read issues. Writing or transitioning an issue waits for approval. |
| Confluence | Site URL and an API token in the vault, and an MCP URL. | Read pages. Writing a page waits for approval. |
| Slack drafts | The operator's own Slack app: bot token and signing secret, already saved in Settings. | A skill that drafts a reply. The existing channel Allow path is the only send. The plugin adds no send tool. |
| Telegram drafts | The operator's bot token and webhook secret in Settings. | Same draft rule as Slack. |
| Notion | A Notion integration token in the vault, and an MCP URL they supply. OCP does not host a Notion server. | Read pages the integration can see. Writing a page waits for approval. |
| Google | An OAuth client the operator creates, pasted into Accounts. Scopes stay the ones in [OAuth clients](oauth-setup.md). The plugin does not embed a second client. | Gmail read, Gmail draft, Calendar read, Calendar create with approval, Drive read. `gmail.send` is not requested. |
| Microsoft | An Entra application the operator registers, pasted into Accounts. | Outlook read, Outlook draft, calendar, OneDrive read. A person sends mail from the draft card. Full file write scope is not requested. |
| Figma | A personal access token in the vault, and an MCP URL. | Read files. |
| Sentry | An auth token in the vault, and an MCP URL. | Read issues. Resolving an issue waits for approval. |
| PagerDuty | An API token in the vault, and an MCP URL. | Read incidents. Acknowledging or paging waits for approval. |
| Teams drafts | No Graph application is included. | A skill that uses the existing Teams reach draft. Allowing it still writes the local outbox and sends nothing. |
| WhatsApp drafts | No Cloud API client is included. | A skill that uses the existing WhatsApp draft. Allowing it still sends nothing. |

Voice and meeting plugins are not in this list. They are not now.

## Phased plan

Sizes are the code each phase has to touch. They are not a release schedule.

### Phase 1. Manifest, shipped catalog, install, uninstall, tab

Add the catalog JSON, a parser, and `plugins.json` in the data directory. Add `GET /api/plugins`, `POST /api/plugins/:id/install`, and `POST /api/plugins/:id/uninstall`. Add the Plugins pane and its script. Wire skills, connectors, vault item creation, and connector secrets through the existing writers.

This phase does not fetch a URL and does not change the channel send path.

Rough size: one product module, one catalog file, three routes, one Connect pane, one test file. `server.ts` gains the pane and the routes. The MCP client and the draft gate stay as they are.

### Phase 2. Update, operator URL, audit, rollback

Add `pluginCatalogUrl` to settings. Fetch with the timeout, size cap, and scheme rules above. Offer updates, re-prompt for new permissions, roll back a failed probe, and write audit rows for install, update, and uninstall.

Rough size: one settings field, one fetch helper, one update route, and tests around the merge rules. Smaller than phase 1. Still inside the product package.

### Phase 3. Starter entries

Fill the fourteen rows above with real skill text and setup labels. Google and Microsoft cards link to Accounts. Slack and Telegram cards link to Channels. Teams and WhatsApp cards repeat that Allow still sends nothing. No third-party server binary is added to the repo.

If the Board wants signatures in this phase, pin the shipped public key and refuse a present signature that does not verify. Checksums remain required either way.

Rough size: catalog content and copy. No new protocol.

### Not in these phases

- A hosted marketplace, a listing account, ads, or payments.
- A voice or meeting plugin.
- A plugin permission that sends mail, Slack, Telegram, WhatsApp, or Teams on its own.
- Vendoring someone else's MCP server.
- Listening beyond loopback. `OCP_DOCKER_BIND=bridge` stays the only way to bind wider, and compose still publishes `127.0.0.1:4317` only.

## Test strategy

Phase 1 tests, all local, with no network except a loopback probe fixture:

- A valid manifest installs a skill and a connector. The install response and `state.json` do not contain the token. `mcp-secrets.json` holds it for that bot only.
- Unknown keys, a bad id, a bad URL, userinfo in a URL, and `minOcpVersion` above the running version refuse the install and write nothing.
- `message.send`, `payment`, `voice`, and `meeting` refuse the install.
- A checksum mismatch refuses the install.
- A `signature` field present in phase 1 refuses the install.
- A probe failure rolls back the skill and the connector and keeps the vault item.
- Uninstall removes the connector and secret. An edited skill file is kept. Vault items stay unless the separate choice is set.
- A deny rule on `mcp:github/create_issue` still refuses that call after install. The audit row quotes the rule id.
- A drafted Slack or mail result from a plugin skill stays `draft`. The test does not perform a send.
- The page HTML contains `data-tab="plugins"`, `id="pluginSearch"`, and `id="pluginList"`. The inline script parses. The pane uses the existing theme tokens and does not add a hardcoded palette.
- Search filters cards in the page script without a request.
- Strict branding guard and lint stay clean. The pane does not mention voice as an available feature.

Phase 2 adds:

- An `http` catalog URL that is not loopback is refused.
- A URL that repeats a shipped id does not replace the shipped manifest.
- A URL failure still returns the shipped catalog and an error string.
- An update that adds a permission is not applied until the install request includes that acceptance.
- Audit rows for install and uninstall redact a token-shaped value.

Phase 3 checks that each starter manifest parses, names the operator's own credential, and does not contain a secret, an OAuth client secret, or a send permission. The Teams and WhatsApp entries' descriptions say that Allow still sends nothing.

## Open questions for the Board

1. Skills are shared by every bot on this machine. Should phase 1 keep that, or should a plugin skill be enabled per bot before `tool_search` returns it?
2. Should an operator catalog URL be allowed to update a shipped id in a later phase, or should shipped ids change only when OCP is updated?
3. Is a checksum enough until a public key is pinned, given that a checksum does not constrain the remote MCP process?
4. Uninstall keeps vault items unless the person asks to delete them. Is that the default the Board wants?
5. Teams and WhatsApp starter cards cannot send. Should they ship as draft-only cards, or wait until a real send exists?
6. The installer is proposed for product version 0.2.0. 0.1.0 should refuse these manifests. Is 0.2.0 the version to put on `minOcpVersion`?
