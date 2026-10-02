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

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
async function authenticatedMediaInfo(shortcode, sessionId, desktop = false) {
  const mediaId = mediaIdFromShortcode(shortcode);
  const response = await fetch(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, {
    headers: {
      "User-Agent": desktop ? DESKTOP_UA : "Instagram 320.0.0.42.101 Android (34/14; 420dpi; 1080x2400; Google; Pixel 7; panther; panther; en_US; 557106244)",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Cookie": `sessionid=${sessionId}`,
      "Referer": "https://www.instagram.com/",
      "X-IG-App-ID": "936619743392459",
      "X-ASBD-ID": "129477"
    },
    redirect: "manual", signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Instagram media API returned ${response.status}.`);
  return response.json();
}

function imageCandidate(candidate) {
  const url=candidate?.url||candidate?.src;
  try { checkedHost(url,['cdninstagram.com','fbcdn.net']); } catch { return null; }
  const width=Number(candidate.width??candidate.config_width??0),height=Number(candidate.height??candidate.config_height??0);
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<0||height<0||width>30000||height>30000)return null;
  return {url,width,height};
}
function nodeKey(node){return String(node.pk??node.id??'').split('_')[0];}
function itemsFromMediaInfo(payload, source = 'mobile', extended = false) {
  const root = payload?.items?.[0];
  if (!root) return [];
  const nodes = Array.isArray(root.carousel_media) && root.carousel_media.length ? root.carousel_media : root.edge_sidecar_to_children?.edges?.map(e=>e.node) || [root];
  return nodes.flatMap(node => {
    const videos = Array.isArray(node.video_versions) ? node.video_versions : [];
    if (videos.length) {
      const best = videos.slice().sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
      return best?.url ? [{ type: "video", url: best.url, mediaId:nodeKey(node),width:best.width||0,height:best.height||0,source }] : [];
    }
    if(node.is_video || node.media_type===2)return [];
    let images = [...(node.image_versions2?.candidates || [])];
    if(extended){
      images.push(...(node.display_resources||[]));
      if(node.display_url)images.push({url:node.display_url,...node.dimensions});
      const extra=node.image_versions2?.additional_candidates||{};
      images.push(...Object.values(extra).filter(v=>v&&typeof v==='object'&&v.url));
    }
    images=images.map(imageCandidate).filter(Boolean);
    const best = images.slice().sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
    return best?.url ? [{ type: "image", ...best, mediaId:nodeKey(node),source }] : [];
  });
}

function desktopRows(document,shortcode,source){
  const expected=mediaIdFromShortcode(shortcode),stack=[document],rows=[];let visited=0;
  while(stack.length&&visited++<100000){const value=stack.pop();if(!value||typeof value!=='object')continue;
    if(!Array.isArray(value)&&(value.code===shortcode||value.shortcode===shortcode||nodeKey(value)===expected)&&('image_versions2'in value||'carousel_media'in value||'display_resources'in value||'edge_sidecar_to_children'in value))rows.push(...itemsFromMediaInfo({items:[value]},source,true));
    for(const child of Object.values(value))if(child&&typeof child==='object')stack.push(child);
  }return rows;
}
function upgradeImages(baseline,candidates){
  return baseline.map(item=>{if(item.type!=='image'||!item.mediaId)return item;let best=item;
    for(const next of candidates){if(next.type==='image'&&next.mediaId===item.mediaId&&next.width>0&&next.height>0&&next.width*next.height>best.width*best.height&&next.width>=item.width&&next.height>=item.height)best=next;}
    return best===item?item:{...best,baselineWidth:item.width,baselineHeight:item.height};
  });
}
async function higherResolution(baseline,shortcode,sessionId){
  let result=baseline,note='No larger desktop image was exposed.',blocked=false;
  try{const desktop=await authenticatedMediaInfo(shortcode,sessionId,true);result=upgradeImages(result,desktopRows(desktop,shortcode,'desktop-api'));}
  catch(error){if(/returned (401|403|429)/.test(error.message)){blocked=true;note='Desktop check unavailable; using available media.';}}
  if(!blocked){try{
    const page=await fetch('https://www.instagram.com/p/'+shortcode+'/',{headers:{'User-Agent':DESKTOP_UA,'Accept':'text/html','Cookie':'sessionid='+sessionId,'X-IG-App-ID':'936619743392459'},redirect:'manual',signal:AbortSignal.timeout(12000)});
    if(!page.ok)throw new Error('Desktop page unavailable');
    const text=new TextDecoder().decode(await readLimited(page,12*1024*1024));
    let count=0;for(const match of text.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)){if(count++>=100)break;try{const document=JSON.parse(match[1]);result=upgradeImages(result,desktopRows(document,shortcode,'desktop-page'));}catch{}}
  }catch{note='Desktop page unavailable or contained no larger image; using available media.';}}
  const upgraded=result.filter((item,i)=>item.type==='image'&&item.width*item.height>baseline[i].width*baseline[i].height).length;
  return {items:result,quality:{checked:true,upgraded,note:upgraded?'Higher-resolution desktop images found.':note}};
}

async function resolve(request) {
  let body;
  try { body = await request.json(); } catch { return json(request, { error: "Invalid request." }, 400); }
  if (!validSession(body.sessionId)) return json(request, { error: "Enter a valid Instagram session ID." }, 401);
  let base;
  try { base = canonical(body.url); } catch (error) { return json(request, { error: error.message }, 400); }
  const origin = new URL(request.url).origin;
  try {
    const shortcode=shortcodeFrom(base);
    let apiItems = itemsFromMediaInfo(await authenticatedMediaInfo(shortcode, body.sessionId));
    if (apiItems.length) {
      let quality={checked:false,upgraded:0,note:'Standard quality.'};
      if(body.highResolution===true&&apiItems.some(i=>i.type==='image')){const upgraded=await higherResolution(apiItems,shortcode,body.sessionId);apiItems=upgraded.items;quality=upgraded.quality;}
      return json(request, { quality, items: apiItems.map(item => ({ ...item, url: `${origin}/api/media?url=${encodeURIComponent(item.url)}` })) });
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

// Setup is intentionally same-origin only and separate from the public resolver.
const SETUP_ORIGIN = "https://drop-public-media.anon69f.chatgpt.site";
const B2_BUCKET = "drop-tee21";
const B2_ENDPOINT = "https://s3.us-east-005.backblazeb2.com";
const SETTINGS_KEY = "private/b2-settings-v1";
const encoder = new TextEncoder();
const base64 = bytes => btoa(String.fromCharCode(...bytes));
const unbase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

function setupResponse(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, private",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Vary": "Cookie",
    ...extra
  }});
}
const setupJSON = (data, status = 200) => setupResponse(JSON.stringify(data), status);
class SetupError extends Error {}

async function validateB2(keyId, applicationKey) {
  const response = await fetch("https://api.backblazeb2.com/b2api/v4/b2_authorize_account", {
    headers: { Authorization: "Basic " + btoa(keyId + ":" + applicationKey) },
    redirect: "manual", signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new SetupError(response.status === 401 ? "B2 rejected the key ID or application key. Check both values." : "B2 is unavailable or has reached an account limit. Try again later.");
  const authorization = await response.json();
  const api = authorization.apiInfo?.storageApi;
  const buckets = api?.allowed?.buckets;
  if (!Array.isArray(buckets) || buckets.length !== 1 || buckets[0].name !== B2_BUCKET) {
    throw new SetupError("Use an application key restricted to drop-tee21 only, not a master or all-buckets key.");
  }
  if (api.s3ApiUrl?.replace(/\/$/, "") !== B2_ENDPOINT) throw new SetupError("This key belongs to a different B2 region.");
  const capabilities = api.allowed.capabilities || [];
  if (!["listBuckets", "listFiles", "readFiles", "writeFiles"].every(c => capabilities.includes(c))) {
    throw new SetupError("The bucket key needs read/write access, including listBuckets, listFiles, readFiles and writeFiles.");
  }
  if (api.allowed.namePrefix) throw new SetupError("Create the bucket-restricted key without a file-name prefix.");
  const apiUrl = new URL(api.apiUrl);
  if (apiUrl.protocol !== "https:" || !apiUrl.hostname.endsWith(".backblazeb2.com") || apiUrl.username || apiUrl.password || apiUrl.port) throw new SetupError("B2 returned an unexpected API endpoint.");
  const check = await fetch(new URL("/b2api/v4/b2_list_buckets", apiUrl), {
    method: "POST", headers: { Authorization: authorization.authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: authorization.accountId, bucketId: buckets[0].id }),
    redirect: "manual", signal: AbortSignal.timeout(15000)
  });
  if (!check.ok) throw new SetupError("Cannot verify the bucket. Check that this key has listBuckets permission.");
  const bucket = (await check.json()).buckets?.find(b => b.bucketId === buckets[0].id);
  if (bucket?.bucketType !== "allPrivate") throw new SetupError("Set drop-tee21 to Private in Backblaze before connecting it.");
  return { bucketId: bucket.bucketId, bucket: B2_BUCKET, endpoint: B2_ENDPOINT };
}

async function sealSettings(env, value) {
  const key = await crypto.subtle.importKey("raw", unbase64(env.B2_SETTINGS_ENCRYPTION_KEY), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(SETTINGS_KEY) }, key, encoder.encode(JSON.stringify(value)));
  return JSON.stringify({ v: 1, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) });
}

function setupPage() {
  const nonce = base64(crypto.getRandomValues(new Uint8Array(18)));
  return setupResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Drop · Storage</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='10' fill='%23ef4545'/%3E%3C/svg%3E"><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:#050505;color:#f5f5f5;font:16px/1.5 Inter,Arial,sans-serif}main{max-width:520px;margin:64px auto;padding:24px}h1{font-size:36px;letter-spacing:5px;margin:0}h1 span{color:#ef4545}h2{font-size:22px;margin-top:36px}p{color:#aaa}label{display:block;margin:22px 0 8px}input{width:100%;padding:16px;background:#111;border:1px solid #444;border-radius:12px;color:#fff;font:inherit}input:focus{outline:2px solid #eee;outline-offset:2px}button{width:100%;padding:16px;margin-top:24px;border:0;border-radius:12px;background:#eee;color:#111;font:600 16px Inter,Arial,sans-serif;cursor:pointer}button:disabled{opacity:.5;cursor:wait}.secondary{background:#191919;color:#eee;border:1px solid #444}small{display:block;font-size:14px;color:#999;margin-top:10px}code{overflow-wrap:anywhere;font-size:14px}.meta{padding:16px;border:1px solid #333;border-radius:12px}#status{min-height:48px;white-space:pre-line}a{color:#ccc}footer{margin-top:32px;font-size:14px} @media(max-width:600px){main{margin:16px auto}}
</style></head><body><main><h1>DROP<span>•</span></h1><h2>Connect storage</h2><p>Owner-only · Sign in with your ChatGPT account.</p><div class="meta"><strong>drop-tee21</strong><br><code>s3.us-east-005.backblazeb2.com</code></div><p id="status" role="status" aria-live="polite">Checking connection…</p><form id="setup" autocomplete="off"><label for="keyId">Application key ID</label><input id="keyId" name="keyId" type="password" required maxlength="200" autocomplete="off" spellcheck="false" autocapitalize="off"><label for="applicationKey">Application key</label><input id="applicationKey" name="applicationKey" type="password" required maxlength="300" autocomplete="new-password" spellcheck="false" autocapitalize="off"><small>Use a read/write key restricted to this bucket. Your key is encrypted on the server and never returned to the page.</small><button id="connect">Verify &amp; save</button></form><button id="disconnect" class="secondary" hidden>Disconnect B2</button><small>Disconnect removes the saved connection, not your B2 files. Revoke the key in Backblaze to invalidate it.</small><footer><a href="https://anon-astra.github.io/instagram-drop/">Back to Drop</a> · <a href="/signout-with-chatgpt?return_to=%2Fsetup">Sign out</a></footer></main><script nonce="${nonce}">
const status=document.getElementById('status'),form=document.getElementById('setup'),connect=document.getElementById('connect'),disconnect=document.getElementById('disconnect');
async function api(method,body){const r=await fetch('/api/storage/setup',{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let data;try{data=await r.json()}catch{throw Error('Session expired. Reload this page and sign in again.')}if(!r.ok)throw Error(data.error||'Request failed.');return data;}
function display(data){disconnect.hidden=!data.connected;status.textContent=data.connected?'B2 connected. Use Save beside Download in Drop to archive posts.':'Not connected. Enter your B2 key below.';connect.textContent=data.connected?'Verify & replace key':'Verify & save';}
api('GET').then(display).catch(e=>status.textContent=e.message);
form.addEventListener('submit',async e=>{e.preventDefault();connect.disabled=disconnect.disabled=true;status.textContent='Verifying B2 access…';try{display(await api('POST',{keyId:form.keyId.value.trim(),applicationKey:form.applicationKey.value.trim()}));form.reset();}catch(e){status.textContent=e.message;}finally{connect.disabled=disconnect.disabled=false;}});
disconnect.addEventListener('click',async()=>{if(!confirm('Disconnect B2? Your files will stay in Backblaze.'))return;connect.disabled=disconnect.disabled=true;try{display(await api('DELETE'));form.reset();}catch(e){status.textContent=e.message;}finally{connect.disabled=disconnect.disabled=false;}});
window.addEventListener('pagehide',()=>form.reset());
</script></body></html>`, 200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` });
}

async function storageSetup(request, env, path) {
  const userId = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email");
  if (!userId || !email) {
    if (path === "/setup" && request.method === "GET") return setupResponse(null, 302, { Location: "/signin-with-chatgpt?return_to=%2Fsetup" });
    return setupJSON({ error: "Sign in with the owner's ChatGPT account." }, 401);
  }
  // Authentication is dispatch-owned; email must match the explicitly configured Site owner.
  if (!env.DROP_OWNER_EMAIL || email.toLowerCase() !== env.DROP_OWNER_EMAIL.toLowerCase()) return setupJSON({ error: "This page is restricted to the owner." }, 403);
  if (path === "/setup") return request.method === "GET" ? setupPage() : setupJSON({ error: "Method not allowed." }, 405);
  if (!env.SETTINGS || !env.B2_SETTINGS_ENCRYPTION_KEY) return setupJSON({ error: "Secure storage is unavailable. Please try again later." }, 503);
  let stage = "read-settings";
  try {
    if (request.method === "GET") return setupJSON({ connected: !!(await env.SETTINGS.head(SETTINGS_KEY)), bucket: B2_BUCKET });
    if (!["POST", "DELETE"].includes(request.method)) return setupJSON({ error: "Method not allowed." }, 405);
    if (request.headers.get("Origin") !== SETUP_ORIGIN) return setupJSON({ error: "Open the setup page to change storage settings." }, 403);
    if (request.method === "DELETE") {
      await env.SETTINGS.delete(SETTINGS_KEY);
      return setupJSON({ connected: false });
    }
    if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") return setupJSON({ error: "JSON required." }, 415);
    stage = "read-request";
    const reader = request.body?.getReader();
    if (!reader) return setupJSON({ error: "Missing key details." }, 400);
    let size = 0; const chunks = [];
    while (true) { const {done,value} = await reader.read(); if(done)break;size+=value.byteLength;if(size>2048){await reader.cancel();return setupJSON({error:"Request too large."},413);}chunks.push(value); }
    const bytes = new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return setupJSON({ error: "Invalid request." }, 400); }
    const { keyId, applicationKey } = body || {};
    if (typeof keyId !== "string" || !/^[A-Za-z0-9_-]{5,200}$/.test(keyId) || typeof applicationKey !== "string" || !/^[A-Za-z0-9_+\/=\-]{10,300}$/.test(applicationKey)) return setupJSON({ error: "Enter a valid key ID and application key." }, 400);
    stage = "verify-b2";
    const details = await validateB2(keyId, applicationKey);
    stage = "encrypt-settings";
    const encrypted = await sealSettings(env, { ...details, keyId, applicationKey, savedAt: new Date().toISOString() });
    stage = "store-settings";
    await env.SETTINGS.put(SETTINGS_KEY, encrypted, { httpMetadata: { contentType: "application/json" } });
    return setupJSON({ connected: true, bucket: B2_BUCKET });
  } catch (error) {
    // Never log exception messages, request bodies, credentials or upstream responses.
    if (!(error instanceof SetupError)) console.error("B2_SETUP_FAILURE", stage, error instanceof TypeError ? "TypeError" : "RuntimeError");
    return setupJSON({ error: error instanceof SetupError ? error.message : `Connection failed during ${stage}. Please try again.`, code: error instanceof SetupError ? "B2_VALIDATION" : stage }, error instanceof SetupError ? 400 : 503);
  }
}

async function readLimited(response, limit) {
  if (Number(response.headers.get('Content-Length')) > limit) throw new SetupError('Media is too large. This version supports up to 40 MB per item.');
  const reader = response.body?.getReader();
  if (!reader) throw new SetupError('Empty media response.');
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new SetupError('Media is too large. This version supports up to 40 MB per item.');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
function checkedHost(raw, domains) {
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!domains.some(d=>u.hostname===d||u.hostname.endsWith('.'+d)))throw new SetupError('Unexpected media or storage address.');
  return u;
}
async function b2Connection(env) {
  const record=await env.SETTINGS.get(SETTINGS_KEY);
  if(!record)throw new SetupError('Connect B2 on the storage setup page first.');
  const sealed=await record.json();
  const key=await crypto.subtle.importKey('raw',unbase64(env.B2_SETTINGS_ENCRYPTION_KEY),'AES-GCM',false,['decrypt']);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(sealed.iv),additionalData:encoder.encode(SETTINGS_KEY)},key,unbase64(sealed.ciphertext));
  const settings=JSON.parse(new TextDecoder().decode(plain));
  const res=await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account',{headers:{Authorization:'Basic '+btoa(settings.keyId+':'+settings.applicationKey)},redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(!res.ok)throw new SetupError('B2 authorization failed. Reconnect your key in storage settings.');
  const auth=await res.json(),api=auth.apiInfo?.storageApi;
  const apiUrl=checkedHost(api.apiUrl,['backblazeb2.com']);
  // Recheck privacy, since the bucket may have been changed after setup.
  const buckets=await fetch(new URL('/b2api/v4/b2_list_buckets',apiUrl),{method:'POST',headers:{Authorization:auth.authorizationToken,'Content-Type':'application/json'},body:JSON.stringify({accountId:auth.accountId,bucketId:settings.bucketId}),redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(!buckets.ok||(await buckets.json()).buckets?.find(b=>b.bucketId===settings.bucketId)?.bucketType!=='allPrivate')throw new SetupError('Your B2 bucket must remain private to save media.');
  const upload=await fetch(new URL('/b2api/v4/b2_get_upload_url',apiUrl),{method:'POST',headers:{Authorization:auth.authorizationToken,'Content-Type':'application/json'},body:JSON.stringify({bucketId:settings.bucketId}),redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(!upload.ok)throw new SetupError('B2 could not accept uploads. Check your storage cap and key permissions.');
  const target=await upload.json();checkedHost(target.uploadUrl,['backblaze.com','backblazeb2.com']);
  return target;
}
async function uploadB2(connection,name,bytes,type) {
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-1',bytes));
  const sha1=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
  const res=await fetch(connection.uploadUrl,{method:'POST',headers:{Authorization:connection.authorizationToken,'X-Bz-File-Name':encodeURIComponent(name),'X-Bz-Content-Sha1':sha1,'Content-Type':type,'Content-Length':String(bytes.byteLength)},body:bytes,redirect:'manual',signal:AbortSignal.timeout(120000)});
  if(!res.ok)throw new SetupError('B2 upload failed ('+res.status+'). Retry Save; completed items are retained.');
  const file=await res.json();return {fileId:file.fileId,fileName:name,bytes:bytes.byteLength,contentType:type};
}
function savePage(){
  const nonce=base64(crypto.getRandomValues(new Uint8Array(18)));
  return setupResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Drop · Save</title><style nonce="${nonce}">body{background:#050505;color:#eee;font:16px/1.6 Inter,Arial,sans-serif;margin:0}main{max-width:480px;margin:70px auto;padding:24px}h1{letter-spacing:5px}h1 span{color:#e33}p{color:#aaa}a{color:#eee}button{padding:16px 24px;background:#fff;color:#000;border:0;border-radius:14px;font:600 16px Arial;cursor:pointer}button:disabled{opacity:.5}</style></head><body><main><h1>DROP<span>•</span></h1><h2>Save to collection</h2><p id="status" role="status" aria-live="polite">Waiting for your post…</p><button id="retry" hidden>Retry save</button><p><a href="/collection">View collection</a> · <a href="/setup">Storage settings</a> · <a href="https://anon-astra.github.io/instagram-drop/">Back to Drop</a></p></main><script nonce="${nonce}">
const FRONT='https://anon-astra.github.io',status=document.getElementById('status'),retry=document.getElementById('retry');let data=null,busy=false,complete=false;
function notify(type,extra={}){if(window.opener)window.opener.postMessage({type,...extra},FRONT)}
async function run(){if(!data||busy||complete)return;busy=true;retry.hidden=true;try{for(let index=0;index<data.items.length;index++){status.textContent='Saving '+(index+1)+' / '+data.items.length+' to B2… Keep this tab open.';notify('drop-save-progress',{index:index+1,total:data.items.length});const r=await fetch('/api/collection/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({postUrl:data.postUrl,items:data.items,index})});let result;try{result=await r.json()}catch{throw Error('Your sign-in expired. Return to Drop and tap Save again.')}if(!r.ok)throw Error(result.error||'Save failed.');if(result.complete)break;}complete=true;status.textContent='Saved to your private B2 collection. You can close this tab.';notify('drop-save-complete');}catch(e){status.textContent=e.message;retry.hidden=false;notify('drop-save-error',{message:e.message});}finally{busy=false;}}
window.addEventListener('message',e=>{if(e.origin!==FRONT||e.source!==window.opener||e.data?.type!=='drop-save-data'||data)return;if(!Array.isArray(e.data.items)||!e.data.items.length||e.data.items.length>20)return;data={postUrl:e.data.postUrl,items:e.data.items};run();});retry.onclick=run;
notify('drop-save-ready');const handshake=setInterval(()=>{if(data||!window.opener){clearInterval(handshake);return;}notify('drop-save-ready')},1000);
setTimeout(()=>{if(!data){clearInterval(handshake);status.textContent='Return to Drop and tap Save again. Allow the new tab to open, and keep the original tab open too.';}},60000);
</script></body></html>`,200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`});
}
async function collectionSave(request,env,path){
  const email=request.headers.get('oai-authenticated-user-email'),id=request.headers.get('oai-authenticated-user-id');
  if(!email||!id){if(path==='/save'&&request.method==='GET')return setupResponse(null,302,{Location:'/signin-with-chatgpt?return_to=%2Fsave'});return setupJSON({error:'Sign in with your ChatGPT account.'},401);}
  if(!env.DROP_OWNER_EMAIL||email.toLowerCase()!==env.DROP_OWNER_EMAIL.toLowerCase())return setupJSON({error:'Only the owner can save to this collection.'},403);
  if(path==='/save')return request.method==='GET'?savePage():setupJSON({error:'Method not allowed.'},405);
  if(request.method!=='POST')return setupJSON({error:'Method not allowed.'},405);
  if(request.headers.get('Origin')!==SETUP_ORIGIN)return setupJSON({error:'Open Save from Drop to continue.'},403);
  if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')return setupJSON({error:'JSON required.'},415);
  let stage='read-request';
  try{
    const raw=await readLimited(request,100000);let body;try{body=JSON.parse(new TextDecoder().decode(raw))}catch{throw new SetupError('Invalid save request.')}
    const {items,index}=body;
    if(!Array.isArray(items)||items.length<1||items.length>20||!Number.isInteger(index)||index<0||index>=items.length)throw new SetupError('Invalid carousel. Resolve this post again.');
    const post=new URL(body.postUrl);
    if(!['instagram.com','www.instagram.com'].includes(post.hostname)||post.protocol!=='https:'||!/^\/(p|reel|tv)\/[A-Za-z0-9_-]{1,64}\/$/.test(post.pathname))throw new SetupError('Invalid Instagram post.');
    const shortcode=shortcodeFrom(post.href),prefix='collection/'+shortcode+'/';
    const targets=items.map(item=>{if(!['image','video'].includes(item.type))throw new SetupError('Invalid media type.');const proxy=new URL(item.url);if(proxy.origin!==SETUP_ORIGIN||proxy.pathname!=='/api/media')throw new SetupError('Resolve this post again before saving.');return checkedHost(proxy.searchParams.get('url'),['cdninstagram.com','fbcdn.net']);});
    if(await env.SETTINGS.get(prefix+'deleting'))throw new SetupError('This post is being removed. Finish removing it before saving again.');
    const complete=await env.SETTINGS.get(prefix+'complete');if(complete)return setupJSON({complete:true,alreadySaved:true});
    const itemKey=prefix+'item-'+String(index).padStart(2,'0');
    const existing=await env.SETTINGS.get(itemKey);let saved=existing?await existing.json():null;
    stage='connect-b2';const connection=await b2Connection(env);
    if(!saved){
      stage='download-media';const res=await fetch(targets[index],{redirect:'manual',signal:AbortSignal.timeout(60000),headers:{'User-Agent':'Mozilla/5.0'}});
      if(!res.ok)throw new SetupError('Instagram media expired or is unavailable. Find Media again, then retry Save.');
      const type=(res.headers.get('Content-Type')||'').split(';')[0].toLowerCase();
      const extensions={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif','video/mp4':'mp4','video/webm':'webm'};
      if(!extensions[type]||!type.startsWith(items[index].type+'/'))throw new SetupError('The media host returned an unsupported file type.');
      const bytes=await readLimited(res,40*1024*1024);if(!bytes.length)throw new SetupError('The media file is empty.');
      stage='upload-media';saved={...await uploadB2(connection,prefix+String(index+1).padStart(2,'0')+'.'+extensions[type],bytes,type),type:items[index].type,index};
      await env.SETTINGS.put(itemKey,JSON.stringify(saved));
    }
    if(index===items.length-1){
      stage='save-manifest';const ordered=[];
      for(let i=0;i<items.length;i++){const record=await env.SETTINGS.get(prefix+'item-'+String(i).padStart(2,'0'));if(!record)throw new SetupError('Some carousel items are missing. Retry Save to finish them.');ordered.push(await record.json());}
      const manifest={version:1,shortcode,postUrl:'https://www.instagram.com'+post.pathname,savedAt:new Date().toISOString(),items:ordered};
      await uploadB2(connection,prefix+'post.json',encoder.encode(JSON.stringify(manifest)),'application/json');
      await env.SETTINGS.put(prefix+'complete',JSON.stringify(manifest));return setupJSON({complete:true,count:items.length});
    }
    return setupJSON({complete:false,index});
  }catch(error){if(!(error instanceof SetupError))console.error('COLLECTION_SAVE_FAILURE',stage,error instanceof TypeError?'TypeError':'RuntimeError');return setupJSON({error:error instanceof SetupError?error.message:'Save failed during '+stage+'. Retry Save to resume.'},error instanceof SetupError?400:503);}
}

let collectionAuthCache = null;
async function collectionReadAuth(env) {
  const record=await env.SETTINGS.get(SETTINGS_KEY);
  if(!record)throw new SetupError('B2 is disconnected. Reconnect it in Storage settings.');
  const sealed=await record.json();
  if(collectionAuthCache?.ciphertext===sealed.ciphertext && collectionAuthCache.expires>Date.now())return collectionAuthCache;
  const key=await crypto.subtle.importKey('raw',unbase64(env.B2_SETTINGS_ENCRYPTION_KEY),'AES-GCM',false,['decrypt']);
  const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(sealed.iv),additionalData:encoder.encode(SETTINGS_KEY)},key,unbase64(sealed.ciphertext));
  const settings=JSON.parse(new TextDecoder().decode(raw));
  const response=await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account',{headers:{Authorization:'Basic '+btoa(settings.keyId+':'+settings.applicationKey)},redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new SetupError('B2 authorization failed. Reconnect your key in Storage settings.');
  const auth=await response.json();
  const downloadUrl=checkedHost(auth.apiInfo?.storageApi?.downloadUrl,['backblazeb2.com']).origin;
  collectionAuthCache={ciphertext:sealed.ciphertext,expires:Date.now()+5*60*1000,token:auth.authorizationToken,downloadUrl,apiUrl:checkedHost(auth.apiInfo.storageApi.apiUrl,['backblazeb2.com']).origin,bucketId:settings.bucketId,capabilities:auth.apiInfo.storageApi.allowed?.capabilities||[]};
  return collectionAuthCache;
}

async function collectionRemove(request,env){
  if(request.headers.get('Origin')!==SETUP_ORIGIN)return setupJSON({error:'Remove posts from the Collection page.'},403);
  const post=new URL(request.url).searchParams.get('post')||'';
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(post))return setupJSON({error:'Invalid saved post.'},400);
  const prefix='collection/'+post+'/';
  try{
    if(!await env.SETTINGS.get(prefix+'complete'))return setupJSON({removed:true});
    const auth=await collectionReadAuth(env);
    if(!auth.capabilities.includes('deleteFiles')||!auth.capabilities.includes('listFiles'))return setupJSON({error:'Your B2 key needs deleteFiles and listFiles permissions. Reconnect a read/write key in Storage settings.'},403);
    async function b2(method,body){const r=await fetch(new URL('/b2api/v4/'+method,auth.apiUrl),{method:'POST',headers:{Authorization:auth.token,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(15000)});let data;try{data=await r.json()}catch{data={}}if(!r.ok){if(method==='b2_delete_file_version'&&data.code==='file_not_present')return {};if(r.status===401)collectionAuthCache=null;throw new SetupError('B2 could not finish removing this post ('+r.status+'). Check key permissions or Object Lock, then retry.');}return data;}
    const page=await b2('b2_list_file_versions',{bucketId:auth.bucketId,prefix,maxFileCount:25});
    if(!Array.isArray(page.files))throw new SetupError('B2 returned an invalid file list. Try again.');
    // Verify the whole batch before deleting; never accept a path outside this post.
    for(const file of page.files)if(typeof file.fileName!=='string'||!file.fileName.startsWith(prefix)||!file.fileId||!['upload','hide'].includes(file.action))throw new SetupError('Unexpected file in this post. Nothing from this batch was removed.');
    await env.SETTINGS.put(prefix+'deleting',JSON.stringify({startedAt:new Date().toISOString()}));
    for(const file of page.files)await b2('b2_delete_file_version',{fileName:file.fileName,fileId:file.fileId});
    const remaining=await b2('b2_list_file_versions',{bucketId:auth.bucketId,prefix,maxFileCount:1});
    if(!Array.isArray(remaining.files))throw new SetupError('Could not confirm removal. Retry to finish.');
    if(remaining.files.length)return setupJSON({removed:false,more:true});
    // Keep the visible record until B2 cleanup succeeds, so failures can be retried.
    const metadata=await env.SETTINGS.list({prefix,limit:1000});
    for(const item of metadata.objects)if(item.key!==prefix+'complete'&&item.key!==prefix+'deleting')await env.SETTINGS.delete(item.key);
    if(metadata.truncated)return setupJSON({removed:false,more:true});
    await env.SETTINGS.delete(prefix+'complete');
    await env.SETTINGS.delete(prefix+'deleting');
    return setupJSON({removed:true});
  }catch(error){if(!(error instanceof SetupError))console.error('COLLECTION_REMOVE_FAILURE',error instanceof TypeError?'TypeError':'RuntimeError');return setupJSON({error:error instanceof SetupError?error.message:'Removal could not finish. Retry Remove post to clean up remaining files.'},503);}
}

function collectionPage(){
  const nonce=base64(crypto.getRandomValues(new Uint8Array(18)));
  return setupResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#000"><title>Drop · Collection</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='10' fill='%23d71920'/%3E%3C/svg%3E"><style nonce="${nonce}">
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#000;color:#f4f4f2;font:16px/1.5 Inter,Arial,sans-serif}main{max-width:720px;margin:auto;padding:28px 20px}header{display:flex;justify-content:space-between;align-items:center;gap:16px}.brand{font:700 28px ui-monospace,monospace;letter-spacing:5px}.brand span{color:#d71920}.private{font:14px ui-monospace,monospace;color:#aaa}nav{display:flex;gap:8px;margin:26px 0}a,button{font:inherit}nav a,.button,button{border:1px solid #333;border-radius:14px;background:#111;color:#eee;padding:12px 16px;text-decoration:none;cursor:pointer}nav a[aria-current]{background:#eee;color:#000;border-color:#eee}button:disabled{opacity:.5;cursor:wait}.heading{display:flex;justify-content:space-between;align-items:center;gap:12px}h1{font-size:24px;margin:14px 0}#status{color:#aaa;min-height:26px;margin:8px 0 20px}.grid{display:grid;grid-template-columns:minmax(0,1fr);gap:24px}.card{padding:0;overflow:hidden;text-align:left;background:#111;position:relative;border:1px solid #333;border-radius:20px}.card-row+.card-row{border-top:1px solid #444}.card-media{position:relative;aspect-ratio:4/5;max-height:75svh;background:#050505;touch-action:pan-y}.card img,.card video{width:100%;height:100%;object-fit:contain;display:block}.card-top,.card-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px}.card-top{border-bottom:1px solid #292929;font-size:14px;color:#aaa}.card-controls{border-top:1px solid #292929;flex-wrap:wrap}.card-nav{display:flex;gap:8px}.card-count{font:14px ui-monospace,monospace;color:#eee}.card .badge{position:absolute;right:10px;top:10px;border-radius:30px;background:#000b;padding:5px 9px;font-size:14px}.card .date{position:absolute;left:10px;bottom:10px;background:#000b;border-radius:8px;padding:4px 8px;font-size:14px}.card .failed{position:absolute;inset:0;display:grid;place-items:center;background:#111;color:#aaa;text-align:center;padding:16px}#more{display:block;margin:24px auto}#more[hidden]{display:none}footer{margin-top:40px;display:flex;gap:20px;font-size:14px}footer a{color:#aaa}dialog{width:min(94vw,820px);max-height:94svh;padding:16px;border:1px solid #333;border-radius:22px;background:#090909;color:#eee}dialog::backdrop{background:#000d}.viewer-top,.viewer-actions{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}#media{height:min(65svh,760px);display:grid;place-items:center;touch-action:pan-y;background:#000;border-radius:12px;overflow:hidden}#media img,#media video{width:100%;height:100%;max-height:65svh;object-fit:contain}#media p{padding:20px;color:#aaa}#position{font:14px ui-monospace,monospace;color:#bbb}.viewer-actions{margin:14px 0 0}.viewer-actions a{color:#eee;font-size:14px}#navigation{display:flex;gap:8px}.button{display:inline-block}button:focus-visible,a:focus-visible{outline:2px solid #eee;outline-offset:3px}@media(max-width:600px){main{padding:22px 16px}.grid{grid-template-columns:minmax(0,1fr);gap:20px}.private{font-size:12px}dialog{padding:12px}.viewer-actions{flex-wrap:wrap}.viewer-top button{padding:10px 14px}}
</style></head><body><main><header><div class="brand">DROP<span>•</span></div><span class="private">PRIVATE COLLECTION</span></header><nav aria-label="Drop sections"><a href="https://anon-astra.github.io/instagram-drop/">Download</a><a href="/collection" aria-current="page">Collection</a></nav><div class="heading"><h1>Saved posts</h1><button id="refresh">Refresh</button></div><p id="status" role="status" aria-live="polite">Loading your collection…</p><section id="grid" class="grid" aria-label="Saved posts"></section><button id="more" hidden>Load more</button><footer><a href="/setup">Storage settings</a><a href="/signout-with-chatgpt?return_to=%2Fcollection">Sign out</a></footer></main><dialog id="viewer" aria-label="Saved post viewer"><div class="viewer-top"><span id="position"></span><button id="close">Close</button></div><div id="media"></div><div class="viewer-actions"><div id="navigation"><button id="prev">Previous</button><button id="next">Next</button></div><a id="download" class="button">Download</a><a id="original" target="_blank" rel="noopener noreferrer">Instagram post</a></div><button id="removePost" style="margin-top:16px;width:100%;color:#ff9494">Remove post</button><p id="removeStatus" role="status" aria-live="polite"></p></dialog><script nonce="${nonce}">
const $=id=>document.getElementById(id),grid=$('grid'),status=$('status'),viewer=$('viewer');let posts=[],cursor=null,loading=false,current=null,index=0,touch=0;
function mediaUrl(post,i){return '/api/collection/media?post='+encodeURIComponent(post.shortcode)+'&index='+i;}
function addCard(post){
  const card=document.createElement('article');card.className='card';card.setAttribute('aria-label',post.items.length>1?'Linked carousel post':'Saved post');
  const top=document.createElement('div');top.className='card-top';const kind=document.createElement('span');kind.textContent=post.items.length>1?'CAROUSEL · '+post.items.length+' LINKED ITEMS':post.items[0].type==='video'?'REEL':'PHOTO';const date=document.createElement('time');date.dateTime=post.savedAt;date.textContent=new Date(post.savedAt).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});top.append(kind,date);card.append(top);
  post.items.forEach((item,itemIndex)=>{
    const row=document.createElement('section');row.className='card-row';row.setAttribute('aria-label','Media '+(itemIndex+1)+' of '+post.items.length);
    const frame=document.createElement('div');frame.className='card-media';const el=document.createElement(item.type==='video'?'video':'img');if(item.type==='video'){el.preload='none';el.controls=true;el.playsInline=true;}else{el.loading='lazy';el.alt='Saved post, item '+(itemIndex+1)+' of '+post.items.length;}el.src=mediaUrl(post,itemIndex);el.addEventListener('error',()=>{const failure=document.createElement('span');failure.className='failed';failure.textContent='Preview unavailable. Open item to retry.';frame.append(failure);},{once:true});frame.append(el);
    const controls=document.createElement('div');controls.className='card-controls';const counter=document.createElement('span');counter.className='card-count';counter.textContent=(itemIndex+1)+' / '+post.items.length;const open=document.createElement('button');open.textContent='Open item';open.onclick=()=>{card.querySelectorAll('video').forEach(video=>video.pause());current=post;index=itemIndex;showItem();viewer.showModal();};controls.append(counter,open);row.append(frame,controls);card.append(row);
  });grid.append(card);
}
async function load(reset=false){if(loading)return;loading=true;$('refresh').disabled=$('more').disabled=true;status.textContent='Loading saved posts…';try{const res=await fetch('/api/collection'+(!reset&&cursor?'?cursor='+encodeURIComponent(cursor):''));if(res.status===401){status.textContent='Your session expired. Reload this page to sign in.';return;}const data=await res.json();if(!res.ok)throw Error(data.error||'Could not load collection.');if(reset){posts=[];grid.replaceChildren();}for(const post of data.posts){if(posts.some(p=>p.shortcode===post.shortcode))continue;posts.push(post);addCard(post);}cursor=data.cursor;status.textContent=posts.length?posts.length+' saved post'+(posts.length===1?'':'s')+(cursor?' shown':''):cursor?'More saved posts may be on the next page.':'Nothing saved yet. Open Download, find a post, then tap Save.';$('more').hidden=!cursor;}catch(e){status.textContent=e.message;}finally{loading=false;$('refresh').disabled=$('more').disabled=false;}}
function showItem(){$('removeStatus').textContent='';const panel=$('media');panel.querySelector('video')?.pause();panel.replaceChildren();const item=current.items[index],el=document.createElement(item.type==='video'?'video':'img');if(item.type==='video'){el.controls=true;el.playsInline=true;el.preload='metadata';}else{el.alt='Saved carousel item '+(index+1);}el.src=mediaUrl(current,index);el.onerror=()=>{panel.replaceChildren();const text=document.createElement('p');text.textContent='Could not load this saved file. Check Storage settings or refresh to sign in again.';panel.append(text);};panel.append(el);$('position').textContent=(index+1)+' / '+current.items.length;$('navigation').hidden=current.items.length<2;$('prev').disabled=$('next').disabled=current.items.length<2;$('download').href=mediaUrl(current,index)+'&download=1';$('original').href=current.postUrl;}
function step(n){if(!current||current.items.length<2)return;index=(index+n+current.items.length)%current.items.length;showItem();}
let removing=false;viewer.addEventListener('cancel',e=>{if(removing)e.preventDefault();});
$('removePost').onclick=async()=>{if(!current||removing)return;const selected=current;if(!confirm('Permanently remove this post and all '+selected.items.length+' media item(s) from your B2 collection? This cannot be undone. The original Instagram post is unaffected.'))return;removing=true;const controls=['removePost','close','prev','next'];controls.forEach(id=>$(id).disabled=true);$('removeStatus').textContent='Removing post and saved files…';try{let finished=false;for(let batch=0;batch<20;batch++){const r=await fetch('/api/collection?post='+encodeURIComponent(selected.shortcode),{method:'DELETE'});let data;try{data=await r.json()}catch{throw Error('Sign in again, then retry Remove post.')}if(!r.ok)throw Error(data.error||'Removal failed.');if(data.removed){finished=true;break;}if(!data.more)throw Error('Could not confirm removal. Retry Remove post.');}if(!finished)throw Error('Some files remain. Tap Remove post again to finish.');viewer.close();await load(true);status.textContent='Post removed from your collection and B2.';}catch(e){$('removeStatus').textContent=e.message;}finally{removing=false;controls.forEach(id=>$(id).disabled=false);}};
$('prev').onclick=()=>step(-1);$('next').onclick=()=>step(1);$('close').onclick=()=>viewer.close();viewer.addEventListener('close',()=>{$('media').querySelector('video')?.pause();$('media').replaceChildren();});viewer.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'){e.preventDefault();step(-1)}if(e.key==='ArrowRight'){e.preventDefault();step(1)}});$('media').addEventListener('touchstart',e=>touch=e.changedTouches[0].clientX,{passive:true});$('media').addEventListener('touchend',e=>{const dx=e.changedTouches[0].clientX-touch;if(Math.abs(dx)>50)step(dx<0?1:-1)},{passive:true});$('refresh').onclick=()=>load(true);$('more').onclick=()=>load();load(true);
</script></body></html>`,200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`});
}

async function collectionRead(request,env,path){
  const email=request.headers.get('oai-authenticated-user-email'),id=request.headers.get('oai-authenticated-user-id');
  if(!email||!id){if(path==='/collection'&&request.method==='GET')return setupResponse(null,302,{Location:'/signin-with-chatgpt?return_to=%2Fcollection'});return setupJSON({error:'Sign in with your ChatGPT account.'},401);}
  if(!env.DROP_OWNER_EMAIL||email.toLowerCase()!==env.DROP_OWNER_EMAIL.toLowerCase())return setupJSON({error:'This collection is owner-only.'},403);
  if(path==='/api/collection'&&request.method==='DELETE')return collectionRemove(request,env);
  if(!['GET','HEAD'].includes(request.method))return setupJSON({error:'Method not allowed.'},405);
  if(path==='/collection')return collectionPage();
  try{
    const url=new URL(request.url);
    if(path==='/api/collection'){
      const cursor=url.searchParams.get('cursor');if(cursor&&cursor.length>2048)return setupJSON({error:'Invalid page.'},400);
      const page=await env.SETTINGS.list({prefix:'collection/',limit:50,...(cursor?{cursor}:{})});
      const complete=page.objects.filter(o=>/^collection\/[A-Za-z0-9_-]+\/complete$/.test(o.key));
      const posts=[];for(const object of complete){const record=await env.SETTINGS.get(object.key);if(!record)continue;const manifest=await record.json();if(!Array.isArray(manifest.items)||!manifest.items.length)continue;posts.push({shortcode:manifest.shortcode,postUrl:manifest.postUrl,savedAt:manifest.savedAt,items:manifest.items.map(i=>({type:i.type,bytes:i.bytes}))});}
      return setupJSON({posts,cursor:page.truncated?page.cursor:null});
    }
    const post=url.searchParams.get('post')||'',rawIndex=url.searchParams.get('index')||'';
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(post)||!/^\d{1,2}$/.test(rawIndex))return setupJSON({error:'Invalid saved item.'},400);
    const record=await env.SETTINGS.get('collection/'+post+'/complete');if(!record)return setupJSON({error:'Saved post not found.'},404);
    const manifest=await record.json(),item=manifest.items?.[Number(rawIndex)];if(!item?.fileId)return setupJSON({error:'Saved item not found.'},404);
    const range=request.headers.get('Range');if(range&&!/^bytes=(\d+-\d*|-\d+)$/.test(range))return setupJSON({error:'Unsupported byte range.'},416);
    const auth=await collectionReadAuth(env);const target=new URL('/b2api/v4/b2_download_file_by_id',auth.downloadUrl);target.searchParams.set('fileId',item.fileId);
    const response=await fetch(target,{method:request.method,headers:{Authorization:auth.token,...(range?{Range:range}:{})},redirect:'manual',signal:AbortSignal.timeout(120000)});
    if(!response.ok){if(response.status===401)collectionAuthCache=null;return setupJSON({error:response.status===404?'This file no longer exists in B2.':'B2 could not load this file. Check your storage connection.'},response.status===404?404:502);}
    const headers={'Content-Type':item.contentType||'application/octet-stream','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Vary':'Cookie','Accept-Ranges':'bytes'};
    for(const name of ['Content-Length','Content-Range']){const value=response.headers.get(name);if(value)headers[name]=value;}
    if(url.searchParams.get('download')==='1')headers['Content-Disposition']='attachment; filename="DROP_'+post+'_'+(Number(rawIndex)+1)+'.'+({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif','video/mp4':'mp4','video/webm':'webm'}[item.contentType]||'bin')+'"';
    return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers});
  }catch(error){if(!(error instanceof SetupError))console.error('COLLECTION_READ_FAILURE',error instanceof TypeError?'TypeError':'RuntimeError');return setupJSON({error:error instanceof SetupError?error.message:'Could not load your collection. Please try again.'},503);}
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/collection' || path === '/api/collection' || path === '/api/collection/media') return collectionRead(request, env, path);
    if (path === '/save' || path === '/api/collection/save') return collectionSave(request, env, path);
    if (path === "/setup" || path === "/api/storage/setup") return storageSetup(request, env, path);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headersFor(request) });
    const url = new URL(request.url);
    if (url.pathname === "/api/resolve" && request.method === "POST") return resolve(request);
    if (url.pathname === "/api/media" && request.method === "GET") return media(request);
    return json(request, { service: "Drop resolver", status: "online" });
  }
};
