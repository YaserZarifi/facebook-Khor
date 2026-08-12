const FB_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;

async function startUploadSession(env) {
  const url = `${GRAPH_BASE}/${env.FB_PAGE_ID}/video_reels`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      upload_phase: "start",
      access_token: env.FB_PAGE_ACCESS_TOKEN,
    }),
  });
  const data = await res.json();
  if (!data.video_id || !data.upload_url) {
    throw new Error("Facebook start-phase failed: " + JSON.stringify(data));
  }
  return { videoId: data.video_id, uploadUrl: data.upload_url };
}

async function transferVideoBytes(env, uploadUrl, videoBytes) {
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${env.FB_PAGE_ACCESS_TOKEN}`,
      offset: "0",
      file_size: String(videoBytes.byteLength),
    },
    body: videoBytes,
  });
  const data = await res.json();
  if (data.success !== true) {
    throw new Error("Facebook upload-phase failed: " + JSON.stringify(data));
  }
}

async function finishUpload(env, videoId, { description }) {
  const url = `${GRAPH_BASE}/${env.FB_PAGE_ID}/video_reels`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      upload_phase: "finish",
      video_id: videoId,
      description: description || "",
      video_state: "PUBLISHED",
      access_token: env.FB_PAGE_ACCESS_TOKEN,
    }),
  });
  const data = await res.json();
  if (data.success !== true) {
    throw new Error("Facebook finish-phase failed: " + JSON.stringify(data));
  }
}

export async function uploadReel(env, videoBytes, { description }) {
  const { videoId, uploadUrl } = await startUploadSession(env);
  await transferVideoBytes(env, uploadUrl, videoBytes);
  await finishUpload(env, videoId, { description });
  return videoId;
}

// Facebook's Graph API returns errors as JSON with an OAuthException code —
// 4, 17, and 32 are Facebook's general/page-level rate-limit codes, 613 is
// the custom rate-limit code used by several write endpoints including
// video_reels. This can't be verified against a live call from here (no
// network access to graph.facebook.com in this environment) — treat this
// as a best-effort matcher and adjust the pattern if you see a real rate
// -limit error slip through uncaught, or a normal error get mis-flagged.
export function isRateLimitError(message) {
  return /rate limit|too many requests|request limit reached|"code"\s*:\s*(4|17|32|613)\b/i.test(message || "");
}

// Best-effort view count per posted Reel via the video_insights edge. Not
// verified against a live Graph API response — Facebook's exact metric name
// and response shape for Reels insights has shifted across API versions, so
// treat a missing/undefined result as "couldn't fetch," not "zero views."
export async function getVideoViews(env, videoIds) {
  if (!videoIds || videoIds.length === 0) return {};
  const map = {};
  await Promise.all(
    videoIds.map(async (id) => {
      try {
        const url = `${GRAPH_BASE}/${id}/video_insights?metric=post_video_views&access_token=${env.FB_PAGE_ACCESS_TOKEN}`;
        const res = await fetch(url);
        const data = await res.json();
        const value = data?.data?.[0]?.values?.[0]?.value;
        if (typeof value === "number") map[id] = value;
      } catch (err) {
        console.error("getVideoViews failed for", id, err.message);
      }
    })
  );
  return map;
}
