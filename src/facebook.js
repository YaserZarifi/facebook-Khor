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
