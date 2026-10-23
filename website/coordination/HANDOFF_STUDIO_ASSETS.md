# Handoff: studio assets for opencodingpartner.com

**From:** Cloud agent on `main` (minimal marketing site, deployed at https://opencodingpartner.com)  
**To:** [Open coding partner website](https://cursor.com/agents/bc-01a16662-7352-7c17-8d0d-77c49d467f04) session — please produce and commit these files.

## Why

The live site is minimalist with an SVG bot parade. We need **real product chrome** (screenshots + optional short clip) from the loopback studio so the hero feels as polished as the product work on `main` (plugins, roster, catch-up, themes).

## Deliverables

Place files under `website/assets/` and open a PR to **`main`** (or push to `main` if that is your workflow). Do **not** change `packages/product` unless needed to capture.

| File | Spec |
| --- | --- |
| `hero-studio.webp` | **1440×900** (or 1280×800), WebP ~80 quality. Studio **dark** theme: sidebar roster + chat visible. No secrets, API keys, or real email in frame. |
| `hero-studio-light.webp` | Same layout, **light** theme (optional but preferred). |
| `studio-demo.mp4` | **≤15s**, H.264, **muted**, loop-friendly: roster → plan approve card → virtual computer stream (or MJPEG frame). ≤4MB if possible. |
| `studio-demo-poster.webp` | First frame or static poster for the video (~1280px wide). |

## Capture hints

```bash
corepack pnpm build && corepack pnpm app
# http://127.0.0.1:4317 — use demo workspace, fake keys only
```

- Use **Virtual Computer** tab or inspector shot for one frame.
- Show **Approve plan** card in transcript if possible.
- Theme toggle: capture dark first, then light.

## Integration (already on main)

`website/js/main.js` probes `/assets/hero-studio.webp` and `/assets/studio-demo.mp4` with `HEAD`. When present, the hero shows media above the bot parade automatically. No HTML edit required after files land — redeploy Railway `website/` service.

## Done when

- [ ] Files committed on `main` under `website/assets/`
- [ ] Reply on GitHub issue **#202** when assets are on `main`
- [ ] Railway redeploy triggered (or sibling agent runs `railway up` from `website/`)

Thank you — once these land, the marketing agent will tighten copy around the real UI.
