const ALLOWED_ORIGINS = new Set([
  "https://anon-astra.github.io",
  "https://drop-public-media.anon69f.chatgpt.site"
]);

const headersFor = request => {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://anon-astra.github.io",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
};

const json = (request, body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...headersFor(request), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

function canonical(value) {
  const match = String(value || "").match(/https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?/i);
  if (!match) throw new Error("Paste a public Instagram post or Reel link.");
  return match[0].replace(/\/+$/, "/");
}

function shortcodeFrom(value) {
  const match = String(value || "").match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i);
  if (!match) throw new Error("Could not read the Instagram shortcode.");
  return match[1];
}

function mediaIdFromShortcode(shortcode) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let value = 0n;
  for (const character of shortcode) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid Instagram shortcode.");
    value = value * 64n + BigInt(digit);
  }
  return value.toString();
}

function decode(value) {
  return value.replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/&#x2F;/g, "/");
}

function extract(html) {
  const found = new Map();
  const collect = (regex, type, limit = 20) => {
    for (const match of html.matchAll(regex)) {
      const url = decode(match[1]);
      try {
        const host = new URL(url).hostname;
        if (host.endsWith("cdninstagram.com") || host.endsWith("fbcdn.net")) {
          found.set(url, { url, type });
          if (found.size >= limit) break;
        }
      } catch {}
    }
  };
  collect(/"video_url"\s*:\s*"((?:\\.|[^"\\])*)"/g, "video");
  collect(/"display_url"\s*:\s*"((?:\\.|[^"\\])*)"/g, "image");
  collect(/<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)/gi, "video", 1);
  collect(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/gi, "image", 1);
  return [...found.values()];
}

function validSession(value) {
  return typeof value === "string" && value.length >= 20 && value.length <= 300 && /^[A-Za-z0-9%:_-]+$/.test(value);
}

async function authenticatedInstagramPage(url, sessionId) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "Cookie": `sessionid=${sessionId}`,
      "Referer": "https://www.instagram.com/",
      "X-IG-App-ID": "936619743392459"
    },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`Instagram returned ${response.status}.`);
  return response.text();
}

async function authenticatedMediaInfo(shortcode, sessionId) {
  const mediaId = mediaIdFromShortcode(shortcode);
  const response = await fetch(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, {
    headers: {
      "User-Agent": "Instagram 320.0.0.42.101 Android (34/14; 420dpi; 1080x2400; Google; Pixel 7; panther; panther; en_US; 557106244)",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Cookie": `sessionid=${sessionId}`,
      "Referer": "https://www.instagram.com/",
      "X-IG-App-ID": "936619743392459",
      "X-ASBD-ID": "129477"
    },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`Instagram media API returned ${response.status}.`);
  return response.json();
}

function itemsFromMediaInfo(payload) {
  const root = payload?.items?.[0];
  if (!root) return [];
  const nodes = Array.isArray(root.carousel_media) && root.carousel_media.length ? root.carousel_media : [root];
  return nodes.flatMap(node => {
    const videos = Array.isArray(node.video_versions) ? node.video_versions : [];
    if (videos.length) {
      const best = videos.slice().sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
      return best?.url ? [{ type: "video", url: best.url }] : [];
    }
    const images = node.image_versions2?.candidates || [];
    const best = images.slice().sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
    return best?.url ? [{ type: "image", url: best.url }] : [];
  });
}

async function resolve(request) {
  let body;
  try { body = await request.json(); } catch { return json(request, { error: "Invalid request." }, 400); }
  if (!validSession(body.sessionId)) return json(request, { error: "Enter a valid Instagram session ID." }, 401);
  let base;
  try { base = canonical(body.url); } catch (error) { return json(request, { error: error.message }, 400); }
  const origin = new URL(request.url).origin;
  try {
    const apiItems = itemsFromMediaInfo(await authenticatedMediaInfo(shortcodeFrom(base), body.sessionId));
    if (apiItems.length) {
      return json(request, { items: apiItems.map(item => ({ type: item.type, url: `${origin}/api/media?url=${encodeURIComponent(item.url)}` })) });
    }
  } catch (error) {
    if (/returned (401|403|429)/.test(error.message)) return json(request, { error: error.message }, 502);
  }
  let lastError;
  for (const target of [base + "embed/captioned/", base]) {
    try {
      const items = extract(await authenticatedInstagramPage(target, body.sessionId));
      if (items.length) {
        return json(request, { items: items.map(item => ({ type: item.type, url: `${origin}/api/media?url=${encodeURIComponent(item.url)}` })) });
      }
    } catch (error) { lastError = error; }
  }
  return json(request, { error: lastError?.message || "Instagram did not expose media for this public post." }, 502);
}

async function media(request) {
  const raw = new URL(request.url).searchParams.get("url") || "";
  let target;
  try {
    target = new URL(raw);
    if (target.protocol !== "https:" || !(target.hostname.endsWith("cdninstagram.com") || target.hostname.endsWith("fbcdn.net"))) throw new Error();
  } catch { return json(request, { error: "Invalid media URL." }, 400); }
  const upstream = await fetch(target.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36" }
  });
  if (!upstream.ok) return json(request, { error: `Media host returned ${upstream.status}.` }, 502);
  const responseHeaders = new Headers(headersFor(request));
  responseHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "application/octet-stream");
  responseHeaders.set("Cache-Control", "public, max-age=300");
  return new Response(upstream.body, { status: 200, headers: responseHeaders });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headersFor(request) });
    const url = new URL(request.url);
    if (url.pathname === "/api/resolve" && request.method === "POST") return resolve(request);
    if (url.pathname === "/api/media" && request.method === "GET") return media(request);
    return json(request, { service: "Drop resolver", status: "online" });
  }
};
