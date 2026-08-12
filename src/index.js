import { tgSend, tgEditMessage, tgAnswerCallback, tgGetFileUrl, tgBroadcast } from "./telegram.js";
import { generateCaption } from "./ai.js";
import { uploadReel, isRateLimitError, getVideoViews } from "./facebook.js";

function getAuthorizedUserIds(env) {
  return (env.AUTHORIZED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function isAuthorized(env, userId) {
  return getAuthorizedUserIds(env).includes(String(userId));
}

async function getPending(env, chatId) {
  const raw = await env.STATE.get(`pending:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}

async function savePending(env, chatId, pending) {
  await env.STATE.put(`pending:${chatId}`, JSON.stringify(pending), { expirationTtl: 60 * 60 * 6 });
}

async function clearPending(env, chatId) {
  await env.STATE.delete(`pending:${chatId}`);
}

async function getQueue(env) {
  const raw = await env.STATE.get("queue");
  return raw ? JSON.parse(raw) : [];
}

async function saveQueue(env, queue) {
  await env.STATE.put("queue", JSON.stringify(queue));
}

// ---------------------------------------------------------------------------
// Scheduling — ported from the YouTube bot. Videos get an evenly-spaced daily
// slot (MAX_UPLOADS_PER_DAY of them, MIN_HOURS_BETWEEN_UPLOADS apart, inside
// POSTING_WINDOW_START_HOUR..POSTING_WINDOW_END_HOUR), snapped to a 15-minute
// grid matching the cron. Manually-pinned items (not implemented here as a
// command, but the field is supported) block their slot for auto items.
// ---------------------------------------------------------------------------

const SLOT_GRID_MS = 15 * 60 * 1000;

function hashStr(s) {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (Math.imul(31, hash) + s.charCodeAt(i)) | 0;
  }
  return hash;
}

function getSchedule(env) {
  const perDay = Math.max(1, parseInt(env.MAX_UPLOADS_PER_DAY || "4", 10));
  const gapMin = Math.round(Math.max(0, parseFloat(env.MIN_HOURS_BETWEEN_UPLOADS || "4")) * 60);
  const startMin = Math.round(Math.max(0, parseFloat(env.POSTING_WINDOW_START_HOUR || "11")) * 60);
  const endHour = parseFloat(env.POSTING_WINDOW_END_HOUR ?? "1");
  const windowLenMin = (((Math.round(endHour * 60) - startMin) % 1440) + 1440) % 1440 || 1440;
  const jitterMin = Math.min(60, Math.max(0, gapMin - 15));
  const windows = [];
  for (let i = 0; i < perDay; i++) {
    const off = startMin + i * gapMin;
    windows.push({ startOffsetMin: off, endOffsetMin: off + jitterMin });
  }
  const lastOffset = (perDay - 1) * gapMin;
  return { uploadsPerDay: perDay, windows, startMin, gapMin, windowLenMin, fits: lastOffset <= windowLenMin };
}

function offsetToClock(offMin) {
  const m = (((Math.round(offMin) % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function getTimeZoneOffsetMs(timeZone, ms) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(ms));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === "24" ? "0" : map.hour;
  const asUTC = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second);
  return asUTC - ms;
}

function parseLocalDateTime(dateStr, timeStr, timeZone) {
  const [y, mo, d] = (dateStr || "").split("-").map(Number);
  const [h, mi] = (timeStr || "").split(":").map(Number);
  if (!y || !mo || !d || isNaN(h) || isNaN(mi)) return null;
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const offset = getTimeZoneOffsetMs(timeZone, guess);
    guess = Date.UTC(y, mo - 1, d, h, mi) - offset;
  }
  return guess;
}

function slotTimeFor(schedule, dayMidnightMs, windowIndex) {
  const win = schedule.windows[windowIndex];
  const startMs = dayMidnightMs + win.startOffsetMin * 60000;
  const endMs = dayMidnightMs + win.endOffsetMin * 60000;
  const randomDec = Math.abs(Math.sin(hashStr(String(dayMidnightMs) + windowIndex) || 1));
  const raw = startMs + Math.floor(randomDec * (endMs - startMs));
  const snapped = Math.floor(raw / SLOT_GRID_MS) * SLOT_GRID_MS;
  return Math.max(startMs, snapped);
}

function generateAutoSlots(env, startMs, count, blockedTimes = []) {
  const timeZone = env.DISPLAY_TIMEZONE || "UTC";
  const schedule = getSchedule(env);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const gapMs = schedule.gapMin * 60000;
  const taken = new Set(blockedTimes.map((t) => Math.floor(t / SLOT_GRID_MS)));
  const times = [];
  if (count <= 0) return times;

  const tooCloseToBlocked = (t) => blockedTimes.some((b) => Math.abs(t - b) < gapMs);

  let dayStr = fmt.format(new Date(startMs));
  let dayMidnight = parseLocalDateTime(dayStr, "00:00", timeZone);

  for (let day = 0; day < 3700 && times.length < count; day++) {
    for (let w = 0; w < schedule.windows.length && times.length < count; w++) {
      const t = slotTimeFor(schedule, dayMidnight, w);
      if (t < startMs) continue;
      const bucket = Math.floor(t / SLOT_GRID_MS);
      if (taken.has(bucket)) continue;
      if (tooCloseToBlocked(t)) continue;
      taken.add(bucket);
      times.push(t);
    }
    dayMidnight += 24 * 60 * 60 * 1000;
    dayStr = fmt.format(new Date(dayMidnight));
    dayMidnight = parseLocalDateTime(dayStr, "00:00", timeZone);
  }
  return times;
}

// Assign each queued item a persisted scheduledAt: manual items keep theirs,
// auto items (in queue order) take the earliest free slots from now. Then
// sort so array order matches time order — the cron always posts queue[0].
function repackQueue(env, queue) {
  const now = Date.now();
  const isManual = (it) => it.manual && it.scheduledAt;
  const blocked = queue.filter(isManual).map((it) => it.scheduledAt);
  const autoItems = queue.filter((it) => !isManual(it));
  const slots = generateAutoSlots(env, now, autoItems.length, blocked);
  autoItems.forEach((it, i) => {
    it.scheduledAt = slots[i];
  });
  queue.sort((a, b) => a.scheduledAt - b.scheduledAt);
  return queue;
}

function formatReadable(ms, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms));
}

// ---------------------------------------------------------------------------
// Reliability — retry Telegram downloads, retry/requeue failed posts, and
// pause the whole queue on a Facebook rate-limit error until it clears.
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, options = {}, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function fetchVideoBytes(env, item) {
  const fileUrl = await tgGetFileUrl(env, item.fileId);
  const res = await fetchWithRetry(fileUrl, {}, 2);
  return res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Visibility — permanent per-video IDs, an event log, /status, /posted,
// /logs, and /history.
// ---------------------------------------------------------------------------

async function nextVideoId(env) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // UTC YYYYMMDD
  const counterKey = `vidCounter:${day}`;
  const n = parseInt((await env.STATE.get(counterKey)) || "0", 10) + 1;
  await env.STATE.put(counterKey, String(n), { expirationTtl: 60 * 60 * 48 });
  return `VID-${day}-${String(n).padStart(4, "0")}`;
}

const EVENT_LOG_CAP = 200;

async function logEvent(env, type, message, meta) {
  try {
    const raw = await env.STATE.get("eventLog");
    const log = raw ? JSON.parse(raw) : [];
    log.unshift({ type, message, meta: meta || undefined, timestamp: Date.now() });
    await env.STATE.put("eventLog", JSON.stringify(log.slice(0, EVENT_LOG_CAP)));
  } catch (err) {
    console.error("logEvent failed:", type, err.message);
  }
}

const EVENT_ICONS = {
  VIDEO_RECEIVED: "🎬",
  QUEUE_ADDED: "✅",
  QUEUE_REMOVED: "🗑️",
  UPLOAD_STARTED: "⏫",
  UPLOAD_SUCCESS: "✅",
  UPLOAD_FAILED: "❌",
  FETCH_FAILED: "⚠️",
  RATE_LIMITED: "🚫",
  QUEUE_PAUSED: "⏸️",
  QUEUE_RESUMED: "▶️",
};

const EVENT_SEVERITY = {
  VIDEO_RECEIVED: "success",
  QUEUE_ADDED: "success",
  UPLOAD_STARTED: "success",
  UPLOAD_SUCCESS: "success",
  QUEUE_RESUMED: "success",
  QUEUE_REMOVED: "warning",
  FETCH_FAILED: "warning",
  QUEUE_PAUSED: "warning",
  UPLOAD_FAILED: "error",
  RATE_LIMITED: "error",
};

const isErrorishEvent = (ev) => EVENT_SEVERITY[ev.type] === "warning" || EVENT_SEVERITY[ev.type] === "error";

function eventDetail(ev) {
  const m = ev.meta || {};
  const clip = (s) => (String(s).length > 40 ? String(s).slice(0, 37) + "..." : String(s));
  if (m.error) return ` (${m.error})`;
  if (m.reason) return ` — ${m.reason}`;
  if (m.desc) return ` — "${clip(m.desc)}"`;
  return "";
}

function formatEventLine(ev, timeZone) {
  const icon = EVENT_ICONS[ev.type] || "•";
  return `${formatReadable(ev.timestamp, timeZone)} ${icon} ${ev.message}${eventDetail(ev)}`;
}

async function getEventLog(env) {
  const raw = await env.STATE.get("eventLog");
  return raw ? JSON.parse(raw) : [];
}

function resolveVid(log, arg) {
  const raw = (arg || "").trim();
  if (/^VID-\d{8}-\d{4}$/i.test(raw)) return raw.toUpperCase();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const suffix = `-${digits.padStart(4, "0")}`;
  for (const ev of log) {
    const v = ev.meta && ev.meta.vid;
    if (v && v.endsWith(suffix)) return v;
  }
  return null;
}

function renderHistoryTimeline(log, vid, timeZone) {
  const events = log.filter((ev) => ev.meta && ev.meta.vid === vid).reverse();
  if (events.length === 0) return null;
  const lines = events.map((ev) => formatEventLine(ev, timeZone)).join("\n");
  const success = events.find((ev) => ev.type === "UPLOAD_SUCCESS" && ev.meta && ev.meta.videoId);
  const linkLine = success ? `\n\n🔗 https://www.facebook.com/reel/${success.meta.videoId}` : "";
  return `🎬 ${vid}\n\n${lines}${linkLine}`;
}

function renderHistoryIndex(log, timeZone) {
  const seen = new Map();
  for (const ev of log) {
    const v = ev.meta && ev.meta.vid;
    if (v && !seen.has(v)) seen.set(v, ev);
    if (seen.size >= 10) break;
  }
  if (seen.size === 0) return null;
  const lines = [];
  for (const [vid, ev] of seen) {
    const icon = EVENT_ICONS[ev.type] || "•";
    lines.push(`${icon} ${vid} — ${ev.message} · ${formatReadable(ev.timestamp, timeZone)}`);
  }
  return `🎬 Recent videos (last ${seen.size}):\n\n${lines.join("\n")}\n\nSend /history <id> for a full timeline (e.g. /history ${[...seen.keys()][0].slice(-4)}).`;
}

// ---------------------------------------------------------------------------
// Existing bot flow (unchanged intent, adapted to carry vid/scheduledAt)
// ---------------------------------------------------------------------------

async function sendPreview(env, chatId, pending) {
  const sent = await tgSend(
    env,
    chatId,
    `📝 Generated caption:\n\n${pending.description}`,
    {
      inline_keyboard: [
        [
          { text: "✅ Accept", callback_data: "accept" },
          { text: "🔁 Retry", callback_data: "retry" },
        ],
      ],
    }
  );
  if (sent?.result?.message_id) {
    pending.previewMessageId = sent.result.message_id;
    await savePending(env, chatId, pending);
  }
}

async function handleQueueCommand(env, chatId) {
  const queue = await getQueue(env);
  if (queue.length === 0) {
    await tgSend(env, chatId, "📋 Queue is empty.");
    return;
  }
  if (queue.some((q) => !q.scheduledAt)) {
    repackQueue(env, queue);
    await saveQueue(env, queue);
  }
  const timeZone = env.DISPLAY_TIMEZONE || "UTC";
  const lines = queue.map((item, i) => {
    const shortDesc = item.description.split("\n")[0].slice(0, 60);
    const timeStr = item.scheduledAt ? formatReadable(item.scheduledAt, timeZone) : "unscheduled";
    return `${i + 1}. ${shortDesc}\n   └ 🕒 ${timeStr}`;
  });
  await tgSend(env, chatId, `📋 Queue (${queue.length} video${queue.length === 1 ? "" : "s"}):\n\n${lines.join("\n\n")}`);
}

async function handleCallback(cq, env) {
  const chatId = cq.message.chat.id;
  const userId = cq.from?.id;

  if (!isAuthorized(env, userId)) {
    await tgAnswerCallback(env, cq.id, "🚫 Not authorized.");
    return;
  }

  const pending = await getPending(env, chatId);
  if (!pending || pending.step !== "awaiting_confirmation") {
    await tgAnswerCallback(env, cq.id, "Nothing pending — send a video first.");
    return;
  }

  if (cq.data === "accept") {
    const queue = await getQueue(env);
    const vid = pending.vid || (await nextVideoId(env));
    const newItem = {
      id: crypto.randomUUID(),
      vid,
      fileId: pending.fileId,
      fileUniqueId: pending.fileUniqueId,
      description: pending.description,
      chatId,
      addedAt: Date.now(),
      manual: false,
      scheduledAt: undefined,
      failCount: 0,
      fetchFailCount: 0,
    };
    queue.push(newItem);
    repackQueue(env, queue);
    await saveQueue(env, queue);
    await clearPending(env, chatId);
    await logEvent(env, "QUEUE_ADDED", "Video queued", { vid, desc: pending.description.split("\n")[0] });
    await tgAnswerCallback(env, cq.id, "Queued!");
    const timeZone = env.DISPLAY_TIMEZONE || "UTC";
    await tgEditMessage(
      env,
      chatId,
      cq.message.message_id,
      `✅ Queued for ${formatReadable(newItem.scheduledAt, timeZone)}.\n\n${pending.description}`
    );
    return;
  }

  if (cq.data === "retry") {
    await tgAnswerCallback(env, cq.id, "Regenerating...");
    const result = await generateCaption(env, pending.note);
    pending.description = result.description;
    await savePending(env, chatId, pending);
    await tgEditMessage(
      env,
      chatId,
      cq.message.message_id,
      `📝 Generated caption:\n\n${pending.description}`,
      {
        inline_keyboard: [
          [
            { text: "✅ Accept", callback_data: "accept" },
            { text: "🔁 Retry", callback_data: "retry" },
          ],
        ],
      }
    );
    return;
  }

  await tgAnswerCallback(env, cq.id, "Unknown action.");
}

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = message.from?.id;

  if (!isAuthorized(env, userId)) {
    await tgSend(env, chatId, "🚫 You're not authorized to use this bot.");
    return;
  }

  if (message.text === "/start" || message.text === "/ping") {
    await tgSend(env, chatId, "✅ Bot is alive and you're authorized.");
    return;
  }

  if (message.text === "/status") {
    const paused = await env.STATE.get("queuePaused");
    const queue = await getQueue(env);
    const today = new Date().toISOString().slice(0, 10);
    const countKey = `fbcount:${today}`;
    const count = parseInt((await env.STATE.get(countKey)) || "0", 10);
    const schedule = getSchedule(env);
    const lastPostedAt = parseInt((await env.STATE.get("lastPostedAt")) || "0", 10);
    const timeZone = env.DISPLAY_TIMEZONE || "UTC";

    const postedRaw = await env.STATE.get("postedVideos");
    const postedCount = postedRaw ? JSON.parse(postedRaw).length : 0;

    const autoCount = queue.filter((it) => !(it.manual && it.scheduledAt)).length;
    const blockedTimes = queue.filter((it) => it.manual && it.scheduledAt).map((it) => it.scheduledAt);
    const projectedSlots = generateAutoSlots(env, Date.now(), autoCount + 1, blockedTimes);
    const nextSlot = projectedSlots[projectedSlots.length - 1];
    const lastQueued = queue.length ? queue[queue.length - 1].scheduledAt : null;
    const nextUp = queue.length ? queue[0].scheduledAt : null;

    const slotTimes = schedule.windows.map((w) => offsetToClock(w.startOffsetMin)).join(", ");
    const gapHrs = (schedule.gapMin / 60).toFixed(schedule.gapMin % 60 ? 1 : 0);
    const fitNote = schedule.fits ? "" : `\n⚠️ These slots span more than the posting window — later slots roll into the next window.`;

    const statusText = `📊 Bot Status

📋 Queue: ${queue.length} video(s)
📅 Today's posts: ${count}/${schedule.uploadsPerDay}
🕒 Last post: ${lastPostedAt ? formatReadable(lastPostedAt, timeZone) : "never"}
📤 Next video will post: ${nextUp ? formatReadable(nextUp, timeZone) : "—"}
🗓️ Queue posts through: ${lastQueued ? formatReadable(lastQueued, timeZone) : "—"}
⏭️ Next new video would post: ${formatReadable(nextSlot, timeZone)}
⏸️ Paused: ${paused ? `yes (${paused})` : "no"}

⚙️ Posting config
- Posts/day: ${schedule.uploadsPerDay}
- Daily slots (approx): ${slotTimes} (${timeZone})
- Spacing: ~${gapHrs}h${fitNote}

🗄️ History
- Posted history: ${postedCount} record(s) (capped at 200)`;

    await tgSend(env, chatId, statusText);
    return;
  }

  if (message.text === "/posted") {
    const postedRaw = await env.STATE.get("postedVideos");
    const posted = postedRaw ? JSON.parse(postedRaw) : [];
    if (posted.length === 0) {
      await tgSend(env, chatId, "📭 No videos posted yet.");
      return;
    }
    const recent = posted.slice(0, 10);
    const views = await getVideoViews(env, recent.map((p) => p.id));
    const timeZone = env.DISPLAY_TIMEZONE || "UTC";
    const list = recent
      .map((p, i) => {
        const shortDesc = (p.description || "").split("\n")[0].slice(0, 60);
        const v = views[p.id];
        const viewsText = typeof v === "number" ? `${v} views` : "views unavailable";
        return `${i + 1}. ${shortDesc}\n   👁️ ${viewsText} · 🕒 ${formatReadable(p.postedAt, timeZone)}\n   🔗 https://www.facebook.com/reel/${p.id}`;
      })
      .join("\n\n");
    await tgSend(env, chatId, `📼 Last ${recent.length} posted video(s):\n\n${list}`);
    return;
  }

  if (message.text?.startsWith("/logs")) {
    const parts = message.text.trim().split(/\s+/);
    const filter = parts[1] === "errors" ? "errors" : "all";
    const all = await getEventLog(env);
    const entries = filter === "errors" ? all.filter(isErrorishEvent) : all;
    if (entries.length === 0) {
      await tgSend(env, chatId, filter === "errors" ? "🧾 No warnings or errors logged yet." : "🧾 No events logged yet.");
      return;
    }
    const timeZone = env.DISPLAY_TIMEZONE || "UTC";
    const list = entries.slice(0, 20).map((ev) => formatEventLine(ev, timeZone)).join("\n");
    const header = filter === "errors"
      ? `🧾 ${entries.length} warning/error event(s) (most recent 20):`
      : `🧾 ${entries.length} event(s) logged (most recent 20). Send /logs errors to filter.`;
    await tgSend(env, chatId, `${header}\n\n${list}`);
    return;
  }

  if (message.text?.startsWith("/history")) {
    const parts = message.text.trim().split(/\s+/);
    const arg = parts[1];
    const log = await getEventLog(env);
    const timeZone = env.DISPLAY_TIMEZONE || "UTC";

    if (!arg) {
      const text = renderHistoryIndex(log, timeZone);
      await tgSend(env, chatId, text || "🎬 No videos tracked yet. Send a video and it'll be assigned an ID like VID-20260813-0001.");
      return;
    }

    const vid = resolveVid(log, arg);
    const text = vid ? renderHistoryTimeline(log, vid, timeZone) : null;
    if (!text) {
      await tgSend(env, chatId, `🔍 No history found for "${arg}". Send /history to see recent video IDs.`);
      return;
    }
    await tgSend(env, chatId, text);
    return;
  }

  if (message.text === "/resumequeue") {
    await env.STATE.delete("queuePaused");
    await env.STATE.delete("lastPausedReminderAt");
    await logEvent(env, "QUEUE_RESUMED", "Queue resumed", { via: "manual" });
    await tgSend(env, chatId, "▶️ Queue resumed. It'll try posting again on the next check.");
    return;
  }

  if (message.text === "/queue") {
    await handleQueueCommand(env, chatId);
    return;
  }

  if (message.text?.startsWith("/remove")) {
    const pos = parseInt(message.text.trim().split(/\s+/)[1], 10);
    const queue = await getQueue(env);
    if (!pos || pos < 1 || pos > queue.length) {
      await tgSend(env, chatId, `Usage: /remove [position]\nValid range: 1-${queue.length}`);
      return;
    }
    const [removed] = queue.splice(pos - 1, 1);
    repackQueue(env, queue);
    await saveQueue(env, queue);
    await logEvent(env, "QUEUE_REMOVED", "Video removed from queue", { vid: removed.vid, desc: removed.description.split("\n")[0] });
    await tgSend(env, chatId, `🗑️ Removed from queue:\n${removed.description.split("\n")[0].slice(0, 60)}`);
    return;
  }

  if (message.text?.startsWith("/postnow")) {
    const pos = parseInt(message.text.trim().split(/\s+/)[1], 10);
    const queue = await getQueue(env);
    if (!pos || pos < 1 || pos > queue.length) {
      await tgSend(env, chatId, `Usage: /postnow [position]\nValid range: 1-${queue.length}`);
      return;
    }
    const [item] = queue.splice(pos - 1, 1);
    await tgSend(env, chatId, `⏳ Posting "${item.description.split("\n")[0].slice(0, 60)}" now...`);
    try {
      await logEvent(env, "UPLOAD_STARTED", "Upload started via /postnow", { vid: item.vid });
      const videoBytes = await fetchVideoBytes(env, item);
      const videoId = await uploadReel(env, videoBytes, { description: item.description });

      repackQueue(env, queue);
      await saveQueue(env, queue);

      const today = new Date().toISOString().slice(0, 10);
      const countKey = `fbcount:${today}`;
      const count = parseInt((await env.STATE.get(countKey)) || "0", 10);
      await env.STATE.put(countKey, (count + 1).toString(), { expirationTtl: 60 * 60 * 26 });
      await env.STATE.put("lastPostedAt", Date.now().toString());

      const postedRaw = await env.STATE.get("postedVideos");
      const posted = postedRaw ? JSON.parse(postedRaw) : [];
      posted.unshift({ id: videoId, vid: item.vid, description: item.description, postedAt: Date.now() });
      await env.STATE.put("postedVideos", JSON.stringify(posted.slice(0, 200)));

      await logEvent(env, "UPLOAD_SUCCESS", "Video posted via /postnow", { vid: item.vid, videoId });
      await tgSend(env, item.chatId, `✅ Posted now: https://www.facebook.com/reel/${videoId}`);
    } catch (err) {
      console.error("postnow failed:", err.message);
      queue.splice(pos - 1, 0, item);
      await saveQueue(env, queue);
      if (isRateLimitError(err.message)) {
        await logEvent(env, "RATE_LIMITED", "Facebook rate limit reached via /postnow", { vid: item.vid });
      } else {
        await logEvent(env, "UPLOAD_FAILED", "Upload failed via /postnow", { vid: item.vid, error: err.message });
      }
      await tgSend(env, chatId, `❌ Post failed: ${err.message}\nItem restored to queue at position ${pos}.`);
    }
    return;
  }

  if (message.video) {
    const vid = await nextVideoId(env);
    await logEvent(env, "VIDEO_RECEIVED", "Video received", { vid });
    await savePending(env, chatId, {
      step: "awaiting_note",
      vid,
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id,
    });
    await tgSend(env, chatId, "🎬 Got the video ✅\n\nSend me a short note about it — I'll use it to generate a caption.");
    return;
  }

  const pending = await getPending(env, chatId);

  if (pending && pending.step === "awaiting_note" && message.text) {
    const result = await generateCaption(env, message.text);
    pending.step = "awaiting_confirmation";
    pending.note = message.text;
    pending.description = result.description;
    await savePending(env, chatId, pending);
    await sendPreview(env, chatId, pending);
    return;
  }

  await tgSend(env, chatId, "Send me a video to get started.");
}

async function processQueueTick(env) {
  const paused = await env.STATE.get("queuePaused");
  if (paused) {
    const lastPostedAt = parseInt((await env.STATE.get("lastPostedAt")) || "0", 10);
    const hoursSince = lastPostedAt ? (Date.now() - lastPostedAt) / (1000 * 60 * 60) : 0;
    if (lastPostedAt && hoursSince >= 24) {
      await env.STATE.delete("queuePaused");
      await env.STATE.delete("lastPausedReminderAt");
      await logEvent(env, "QUEUE_RESUMED", "Queue auto-resumed after 24h", { via: "automatic" });
      const notifyIds = getAuthorizedUserIds(env);
      if (notifyIds.length) {
        await tgBroadcast(env, notifyIds, "▶️ Queue auto-resumed — it's been 24h since your last post, so the rate limit should have cleared. I'll try the next video on the next check.");
      }
    } else {
      const lastReminderAt = parseInt((await env.STATE.get("lastPausedReminderAt")) || "0", 10);
      const hoursSinceReminder = lastReminderAt ? (Date.now() - lastReminderAt) / (1000 * 60 * 60) : Infinity;
      if (hoursSinceReminder >= 6) {
        const notifyIds = getAuthorizedUserIds(env);
        if (notifyIds.length) {
          const resumeInHrs = lastPostedAt ? Math.max(0, 24 - hoursSince).toFixed(1) : "?";
          await tgBroadcast(env, notifyIds, `⏸️ Reminder: queue is still paused (${paused}). Auto-resumes in ~${resumeInHrs}h, or send /resumequeue now.`);
        }
        await env.STATE.put("lastPausedReminderAt", Date.now().toString());
      }
      return;
    }
  }

  const queue = await getQueue(env);
  if (queue.length === 0) {
    console.log("Queue empty, nothing to post.");
    return;
  }

  if (queue.some((q) => !q.scheduledAt)) {
    repackQueue(env, queue);
    await saveQueue(env, queue);
  }

  const item = queue[0];
  if (Date.now() < item.scheduledAt) {
    console.log("Not time to post yet.");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const countKey = `fbcount:${today}`;
  const count = parseInt((await env.STATE.get(countKey)) || "0", 10);

  let videoBytes;
  try {
    videoBytes = await fetchVideoBytes(env, item);
  } catch (err) {
    console.error("Telegram fetch failed for queued item:", item.id, err.message);
    item.fetchFailCount = (item.fetchFailCount || 0) + 1;
    await logEvent(env, "FETCH_FAILED", "Telegram fetch failed", { vid: item.vid, error: err.message });
    if (item.fetchFailCount >= 2) {
      queue.shift();
      repackQueue(env, queue);
      await saveQueue(env, queue);
      await tgSend(
        env,
        item.chatId,
        `🗑️ Dropped "${item.description.split("\n")[0].slice(0, 60)}" — the original video is no longer available on Telegram (the file expired or the message was deleted), so it can't be posted. Please resend it if you still want it posted.\n\nRun /history ${item.vid} for the full timeline.`
      );
    } else {
      await saveQueue(env, queue);
      await tgSend(
        env,
        item.chatId,
        `⚠️ Couldn't fetch "${item.description.split("\n")[0].slice(0, 60)}" from Telegram (attempt ${item.fetchFailCount}/2). Will retry next cycle — if it keeps failing, the original video is probably gone.\n\nRun /history ${item.vid} for the full timeline.`
      );
    }
    return;
  }

  try {
    await logEvent(env, "UPLOAD_STARTED", "Upload started", { vid: item.vid });
    const videoId = await uploadReel(env, videoBytes, { description: item.description });

    queue.shift();
    repackQueue(env, queue);
    await saveQueue(env, queue);
    await env.STATE.put(countKey, (count + 1).toString(), { expirationTtl: 60 * 60 * 26 });
    await env.STATE.put("lastPostedAt", Date.now().toString());

    const postedRaw = await env.STATE.get("postedVideos");
    const posted = postedRaw ? JSON.parse(postedRaw) : [];
    posted.unshift({ id: videoId, vid: item.vid, description: item.description, postedAt: Date.now() });
    await env.STATE.put("postedVideos", JSON.stringify(posted.slice(0, 200)));

    await logEvent(env, "UPLOAD_SUCCESS", "Video posted", { vid: item.vid, videoId });
    await tgSend(env, item.chatId, `✅ Queued video is live: https://www.facebook.com/reel/${videoId}\n📋 ${queue.length} left in queue.`);
  } catch (err) {
    console.error("Queued upload failed:", err.message);

    if (isRateLimitError(err.message)) {
      await env.STATE.put("queuePaused", "Facebook rate limit reached");
      await logEvent(env, "RATE_LIMITED", "Facebook rate limit reached", { vid: item.vid });
      await logEvent(env, "QUEUE_PAUSED", "Queue paused", { reason: "Facebook rate limit reached" });
      await tgBroadcast(
        env,
        getAuthorizedUserIds(env),
        `🚫 Facebook rate limit reached. The queue is now PAUSED.\n\nIt'll auto-resume 24h after your last successful post, or send /resumequeue to override manually.\n\nRun /history ${item.vid} for this video's timeline.`
      );
      return;
    }

    item.failCount = (item.failCount || 0) + 1;
    await logEvent(env, "UPLOAD_FAILED", "Upload failed", { vid: item.vid, error: err.message });
    if (item.failCount >= 2) {
      queue.shift();
      item.manual = false;
      item.scheduledAt = undefined;
      queue.push(item);
      repackQueue(env, queue);
      await saveQueue(env, queue);
      const newPos = queue.findIndex((q) => q.id === item.id) + 1;
      await tgSend(
        env,
        item.chatId,
        `❌ Upload failed twice for "${item.description.split("\n")[0].slice(0, 60)}": ${err.message}\n↩️ Moved to the back of the queue (position ${newPos}) so it doesn't block other videos. I'll retry it again later.\n\nRun /history ${item.vid} for the full timeline.`
      );
    } else {
      await saveQueue(env, queue);
      await tgSend(
        env,
        item.chatId,
        `❌ Scheduled upload failed for "${item.description.split("\n")[0].slice(0, 60)}" (attempt ${item.failCount}/2): ${err.message}\nWill retry next cycle.\n\nRun /history ${item.vid} for the full timeline.`
      );
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") return new Response("ok");
    if (url.pathname !== "/webhook") return new Response("not found", { status: 404 });

    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    const update = await request.json();
    try {
      if (update.message) await handleMessage(update.message, env);
      if (update.callback_query) await handleCallback(update.callback_query, env);
    } catch (err) {
      console.error(err);
    }
    return new Response("ok");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processQueueTick(env));
  },
};
