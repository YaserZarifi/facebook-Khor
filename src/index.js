import { tgSend } from "./telegram.js";

function getAuthorizedUserIds(env) {
  return (env.AUTHORIZED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function isAuthorized(env, userId) {
  return getAuthorizedUserIds(env).includes(String(userId));
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

  await tgSend(env, chatId, "Got your message. Video intake isn't wired up yet — coming next.");
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
    } catch (err) {
      console.error(err);
    }
    return new Response("ok");
  },

  async scheduled(event, env, ctx) {
    console.log("Scheduled tick fired — queue logic not wired up yet.");
  },
};
