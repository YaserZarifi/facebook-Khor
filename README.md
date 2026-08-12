# facebook-Khor

A Cloudflare Worker + Telegram bot that posts Facebook Reels to a Page,
using AI-generated captions and a scheduled queue.

Sibling project to `youtube_Shorts_bot`, adapted for Facebook Reels instead
of YouTube Shorts.

## How it works

1. Send a video to the Telegram bot.
2. Send a short note describing it.
3. Cloudflare Workers AI (`llama-4-scout`) generates a caption + hashtags.
4. Tap **Accept** (or **Retry** to regenerate) on the preview.
5. The video joins a FIFO queue.
6. A cron trigger checks the queue every 15 minutes and posts the next
   video to Facebook via the Graph API's resumable Reels upload
   (`start` → `transfer` → `finish`).

Only a Telegram file pointer (`file_id` / `file_unique_id`) is stored in
KV — the actual video bytes are fetched fresh from Telegram right before
upload and never persisted.

## Bot commands

| Command | Description |
|---|---|
| `/start`, `/ping` | Health check |
| `/status` | Queue length, last posted time, paused state |
| `/queue` | List all queued items with position and preview |
| `/remove [position]` | Remove an item from the queue (1-indexed) |
| `/postnow [position]` | Post an item immediately, skipping the queue order |
| `/resumequeue` | Manually resume a paused queue |
| `/logs` | Recent event log |
| `/history [vid]` | Full timeline for a specific video |
| `/posted` | Recently posted videos |

## Setup

### Requirements

- Cloudflare account with Workers + Workers AI enabled
- A Facebook Page with a long-lived Page access token (Reels publishing
  permission)
- A Telegram bot token (via [@BotFather](https://t.me/BotFather))

### Environment variables (`wrangler.jsonc`)

- `AUTHORIZED_USER_IDS` — comma-separated Telegram user IDs allowed to use
  the bot
- `kv_namespaces.STATE` — KV namespace binding for queue/state storage
- `triggers.crons` — cron schedule for the queue-processing tick
- `ai.binding` — Workers AI binding (`AI`)

### Secrets (`wrangler secret put <NAME>`)

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_SECRET` — random hex string, verifies incoming Telegram
  webhook requests
- `FB_PAGE_ACCESS_TOKEN`
- `FB_PAGE_ID`

### Deploy

`npm install`
`npx wrangler deploy`


Then set the Telegram webhook to point at your deployed Worker's
`/webhook` path, with `X-Telegram-Bot-Api-Secret-Token` set to
`TELEGRAM_SECRET`.
