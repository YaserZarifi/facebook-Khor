export async function generateCaption(env, userText, extraGuidance = []) {
  const guidanceList = Array.isArray(extraGuidance) ? extraGuidance : [extraGuidance].filter(Boolean);
  const guidanceBlock = guidanceList.length
    ? `\n\nAdditional instructions from the creator for this regeneration (apply ALL of these, most recent last):\n${guidanceList.map((g, i) => `${i + 1}. ${g}`).join("\n")}\n`
    : "";

  const prompt = `You are an expert Facebook Reels content writer.

The creator's note about this video:
"${userText}"

Generate a Facebook Reels caption:

1. caption
- Write 1-3 short, engaging sentences that hook the viewer.
- Match the video's tone and mood based on the creator's note.
- Do not use excessive emojis (maximum 2).
- Do not use excessive hashtags inline in the sentence text itself.

2. hashtags
- Generate 5-8 relevant hashtags for Facebook Reels reach.
- Prefer hashtags that match the language and content of the creator's note.
- Do not use generic/spammy hashtags such as: viral, fyp, foryou, explore, trending.
- No duplicates.
- Return hashtags WITHOUT the # symbol.
${guidanceBlock}
Return ONLY valid JSON.
Do not include markdown, explanations, or extra text.

Use exactly this schema:

{
  "caption": "...",
  "hashtags": ["...", "..."]
}`;

  const result = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1024,
  });

  let rawText;
  if (typeof result === "string") {
    rawText = result;
  } else if (typeof result?.response === "string") {
    rawText = result.response;
  } else if (result?.response?.content) {
    rawText = result.response.content;
  } else if (result?.choices?.[0]?.message?.content) {
    rawText = result.choices[0].message.content;
  } else {
    rawText = JSON.stringify(result?.response ?? result);
  }

  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  const cleaned = jsonMatch ? jsonMatch[0] : rawText.trim();

  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error("AI JSON parse failed:", err.message, "cleaned was:", cleaned);
  }

  const fallbackCaption = (userText || "").trim();

  const aiTags = Array.isArray(parsed?.hashtags) ? parsed.hashtags.map((t) => String(t).replace(/^#/, "")) : [];
  const hashtags = [...new Set(aiTags)];

  const baseCaption = (parsed?.caption && parsed.caption.trim()) ? parsed.caption.trim() : fallbackCaption;
  const hashtagsText = hashtags.map((h) => `#${h}`).join(" ");
  const finalDescription = hashtagsText ? `${baseCaption}\n\n${hashtagsText}` : baseCaption;

  return {
    description: finalDescription,
    hashtags,
    aiFailed: !parsed,
  };
}
