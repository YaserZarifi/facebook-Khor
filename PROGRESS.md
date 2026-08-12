cd ~/projects/facebook-reels-bot
cat > PROGRESS.md << 'EOF'
# Facebook Reels Bot — Progress & Handoff Notes

## What this project is

A Cloudflare Worker + Telegram bot, sibling to `youtube_Shorts_bot`
(https://github.com/YaserZarifi/youtube_Shorts_bot.git), but for Facebook Reels
instead of YouTube.

Flow: send a video to the Telegram bot → bot stores a Telegram file pointer in
KV (never raw video bytes) → you send a note → Cloudflare Workers AI generates
a Facebook caption + hashtags → you accept → it joins a FIFO queue → a cron
tick posts it to Facebook via the Graph API Reels endpoint when its turn comes,
respecting a minimum gap between posts.

## Key architecture decisions made so far

- **Separate project from youtube_Shorts_bot** — own repo, own Worker, own
  Telegram bot, own KV namespace. Not a shared/multi-platform bot.
- **Facebook target: Reels specifically** (not regular Page video posts).
  Uses Graph API's 3-phase resumable upload: start → transfer bytes → finish
  (with `video_state=PUBLISHED`).
- **Scheduling model: FIFO with a minimum gap between posts** — NOT the
  YT bot's date/time-slot posting-window system. Simpler by design for v1.
- **Video storage: Telegram file pointers only**, same pattern as the YT bot's
  current (post-refactor) approach. `fileId` + `fileUniqueId` stored in KV;
  actual bytes fetched fresh from Telegram right before upload. No bytes ever
  sit in KV.
- **Two authorized users**, not one. `AUTHORIZED_USER_IDS` is a comma-separated
  env var, parsed and checked in full (not just index [0] like a shortcut in
  the YT bot). Per-item notifications (upload success/fail) go to whoever sent
  that video; system-wide alerts (queue paused, quota issues) should broadcast
  to both — this broadcast helper (`tgBroadcast`) is designed but NOT YET
  IMPLEMENTED (see Next Steps).
- **AI captioning via Cloudflare Workers AI** (`@cf/meta/llama-4-scout-17b-16e-instruct`,
  free tier, `env.AI` binding) — adapted from the YT bot's `ai.js`, but
  simplified to a single `{description, hashtags}` shape since Reels have one
  caption field (no separate title like YouTube). Currently NOT locked to a
  specific language/niche the way the YT bot hardcodes Persian poetry content
  — this is generic. Revisit if this Page needs the same fixed niche/language
  lock.
- **User working rules (IMPORTANT — apply to all future sessions on this
  project):**
  - Never dump full files unprompted or create downloadable files.
  - New files: give full exact content to create via terminal heredoc.
  - Edits to existing files: give EXACT find/replace snippet pairs only
    (user applies via VSCode find & replace) — never regenerate a whole file
    for an edit.
  - Guide step by step: which command, which file, where exactly, how to test.
  - Ask clarifying questions before proceeding on any new ask.
  - Incremental development — one component at a time, test before moving on.

## Repo state / what's actually built and working

Deployed at: `https://facebook-reels-bot.leonardo-scrapper.workers.dev`

- `wrangler.jsonc` — configured with:
  - `kv_namespaces`: `STATE` binding (id `89a24d818b2d4e9eb51bea5cde330ff9`)
  - `triggers.crons`: `["*/15 * * * *"]` (15-min queue-check tick)
  - `vars.AUTHORIZED_USER_IDS`: two numeric Telegram IDs, comma-separated
  - `ai.binding`: `AI` (Cloudflare Workers AI)
- Secrets set (via `wrangler secret put`, confirmed working):
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_SECRET` (random hex, verifies incoming webhook requests)
  - `FB_PAGE_ACCESS_TOKEN` (long-lived, already had this)
  - `FB_PAGE_ID`
- `src/telegram.js` — DONE. Straight port from youtube_Shorts_bot, zero logic
  changes (Telegram API doesn't care what platform you post to downstream).
  Exports: `escapeHtml`, `tgSend`, `tgEditMessage`, `tgAnswerCallback`,
  `tgGetFileUrl`, `tgSetCommands`.
- `src/facebook.js` — DONE (not yet tested end-to-end / not yet called from
  index.js's upload path). Implements the 3-phase Reels upload:
  `startUploadSession` → `transferVideoBytes` → `finishUpload`, wrapped as
  `uploadReel(env, videoBytes, { description })`. NOTE: uses hardcoded
  `FB_API_VERSION = "v21.0"` constant in-code (not an env var, intentional) —
  double check this hasn't been deprecated by Facebook before relying on it,
  see https://developers.facebook.com/docs/graph-api/changelog. Also note:
  transfer step needs `Authorization: OAuth {token}` header — NOT `Bearer`,
  that's a real gotcha that differs from the finish/start calls (which pass
  token as a form param instead).
- `src/ai.js` — DONE. `generateCaption(env, userText, extraGuidance)` → calls
  Workers AI, parses JSON response defensively (regex-extracts `{...}` block
  in case the model adds commentary), falls back to raw user note if JSON
  parse fails. Returns `{ description, hashtags, aiFailed }`. NOT YET PORTED:
  the YT bot's `validateAIMetadata()` sanity-check pass (catches leftover
  JSON/AI commentary/wrong-language output) — deferred as a v2 refinement.
- `src/index.js` — PARTIALLY DONE:
  - Webhook skeleton (`/webhook` POST, secret-token verification, GET health
    check) — DONE, deployed, tested working end to end.
  - `isAuthorized` / `getAuthorizedUserIds` — DONE, tested working (two-user
    check confirmed via a deliberate "wrong ID" test).
  - `/start`, `/ping` — DONE, tested, bot replies correctly.
  - Video intake (`message.video` → save pending KV record) — DONE, just
    written, deploy + Telegram test pending as of this note (was about to be
    tested when this handoff file was requested).
  - Note → AI caption generation → preview (`sendPreview`) — DONE, just
    written, same untested-yet status.
  - Accept/Retry — DONE, now implemented as tappable inline keyboard buttons
    (callback_query, callback_data "accept"/"retry") instead of text
    commands. Preview message is edited in place after each action
    (tgEditMessage) rather than sending new messages. TESTED, working.
  - `/queue` command — DONE. Lists all queued items with position number and
    a truncated first-line preview of each description. TESTED, working.
  - `handleCallback(cq, env)` — DONE. Routes accept/retry callback actions,
    checks auth, answers the callback (tgAnswerCallback) and edits the
    original preview message. TESTED, working.
  - `/remove [position]` command — DONE. 1-indexed to match /queue display.
    Status as of this note: just written, deploy/test pending.
  - `/postnow [position]` command — DONE. Removes item from queue BEFORE
    attempting upload (re-inserts at same position on failure) to avoid a
    double-post risk if the queue save failed after a successful upload.
    This is also the FIRST place `facebook.js`'s `uploadReel()` actually
    gets called/tested end to end — previously written but unexercised.
    Status as of this note: just written, deploy/test pending — this is the
    real first test of the Facebook Graph API upload path.
  - `fetchVideoBytes(env, fileId)` + `postItemToFacebook(env, item)` — DONE.
    Shared helpers now used by /postnow, WILL BE REUSED by the eventual cron
    tick (`scheduled()`) once that's built — don't duplicate this logic
    there, just call postItemToFacebook.
  - `scheduled(event, env, ctx)` — STILL STUB ONLY. Just logs a message.
    This is still the biggest missing piece — see Next Steps. NOTE: once
    built, it should reuse `postItemToFacebook()` (see above) rather than
    reimplementing the upload call.

## Next steps (in priority order)

1. ~~Deploy + live-test the intake flow~~ — DONE. Full flow tested working:
   video → note → AI preview with inline buttons → Accept/Retry taps →
   queued confirmation. `/queue` command also added and tested.
2. **Build out `scheduled()` / the cron tick queue-processor.** Needs to:
   - Read the queue, check if it's non-empty
   - Enforce the "minimum gap between posts" FIFO rule against the
     `lastPostedAt` KV key (NOW BEING WRITTEN by postItemToFacebook, added
     this session — read it and compare against Date.now() before posting).
     Still need to decide/ask the user the actual minimum-gap VALUE — not
     yet specified.
   - Reuse `fetchVideoBytes(env, fileId)` and `postItemToFacebook(env, item)`
     (added this session, used by /postnow) — do NOT reimplement the
     fetch/upload logic here, call the shared helpers.
   - On success: shift queue, save, notify the sending user with a permalink
     (`https://www.facebook.com/reel/{video_id}` — pattern already used by
     /postnow's success message)
   - On failure: needs retry/fail-count logic — port the general shape of the
     YT bot's `processQueueTick` fail handling (retry once, then either drop
     or requeue), adapted for Facebook-specific error shapes (Graph API
     errors look different from YouTube's quota-error JSON shape — need to
     figure out what a Facebook rate-limit/quota error actually looks like
     and how to detect it — THIS SHOULD NOW BE POSSIBLE TO OBSERVE from
     /postnow's real test results this session, check those error messages
     first before researching blind)
3. **Implement `tgBroadcast()` for system-wide alerts** (queue paused,
   posting errors that affect the whole queue) — designed conceptually but
   not yet coded.
4. ~~Add `/queue` command~~ — DONE (see above). **Still need `/status`**
   (quick summary: queue length, last posted time, paused state) — YT bot's
   `renderQueuePage`/status command is a reference pattern for both.
5. **End-to-end test: actually post one real Reel to Facebook** and confirm
   it appears correctly, once steps 1-2 are done.
6. **Later / explicitly deferred, not urgent:**
   - `validateAIMetadata`-style AI output sanity checks
   - Locking AI caption generation to a specific language/niche (only if this
     Page needs that — unconfirmed)
   - Event logging (`/logs`, `/history`) like the YT bot has
   - Quota/circuit-breaker pause logic once we understand Facebook's actual
     rate-limit behavior in practice

## Reference: sibling project for patterns

`youtube_Shorts_bot` (https://github.com/YaserZarifi/youtube_Shorts_bot.git)
is the mature, feature-complete sibling this project is deliberately starting
leaner than. Good source of proven patterns (queue repacking, event logging,
scheduling-window math, quota detection, retry/fail-count handling) to port
in once this bot's v1 core loop (intake → queue → cron → upload) is proven
solid. Do not copy its scheduling-window system though — this project uses
FIFO + minimum gap instead, a deliberate simplification decided for this bot.
EOF
