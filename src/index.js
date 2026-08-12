import { tgSend, tgEditMessage, tgAnswerCallback, tgGetFileUrl } from "./telegram.js";
import { generateCaption } from "./ai.js";
import { uploadReel } from "./facebook.js";

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

async function fetchVideoBytes(env, fileId) {
  const fileUrl = await tgGetFileUrl(env, fileId);
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Telegram file fetch failed: ${res.status}`);
  return res.arrayBuffer();
}

async function postItemToFacebook(env, item) {
  const videoBytes = await fetchVideoBytes(env, item.fileId);
  const videoId = await uploadReel(env, videoBytes, { description: item.description });
  await env.STATE.put("lastPostedAt", Date.now().toString());
  return videoId;
}

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
  const lines = queue.map((item, i) => {
    const shortDesc = item.description.split("\n")[0].slice(0, 60);
    return `${i + 1}. ${shortDesc}`;
  });
  await tgSend(env, chatId, `📋 Queue (${queue.length} video${queue.length === 1 ? "" : "s"}):\n\n${lines.join("\n")}`);
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
    queue.push({
      id: crypto.randomUUID(),
      fileId: pending.fileId,
      fileUniqueId: pending.fileUniqueId,
      description: pending.description,
      chatId,
      addedAt: Date.now(),
    });
    await saveQueue(env, queue);
    await clearPending(env, chatId);
    await tgAnswerCallback(env, cq.id, "Queued!");
    await tgEditMessage(env, chatId, cq.message.message_id, `✅ Queued at position ${queue.length}.\n\n${pending.description}`);
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
    await saveQueue(env, queue);
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
    await saveQueue(env, queue);
    await tgSend(env, chatId, `⏳ Posting "${item.description.split("\n")[0].slice(0, 60)}" now...`);
    try {
      const videoId = await postItemToFacebook(env, item);
      await tgSend(env, item.chatId, `✅ Posted now: https://www.facebook.com/reel/${videoId}`);
    } catch (err) {
      console.error("postnow failed:", err.message);
      queue.splice(pos - 1, 0, item);
      await saveQueue(env, queue);
      await tgSend(env, chatId, `❌ Post failed: ${err.message}\nItem restored to queue at position ${pos}.`);
    }
    return;
  }

  if (message.video) {
    await savePending(env, chatId, {
      step: "awaiting_note",
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
    console.log("Scheduled tick fired — queue logic not wired up yet.");
  },
};
