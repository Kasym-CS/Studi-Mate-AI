// StudyMate AI: server function for the AI helper (AI option B).
// Runs on Vercel as /api/ai. The API key stays here, in the hosting settings, and never reaches the browser.
//
// Easiest: Google Gemini. Set only GEMINI_API_KEY (free key from https://aistudio.google.com/apikey); the model is picked automatically.
// Provider A: Anthropic Claude. Set ANTHROPIC_API_KEY (and optionally AI_MODEL).
// Provider B: any OpenAI-compatible API (Google Gemini, Groq, OpenRouter...). Set AI_API_KEY, AI_BASE_URL, AI_MODEL,
//             and AI_IMAGES=1 if the model accepts images.
// Optional: AI_LABEL (name shown under "AI helper"), AI_MAX_PER_10MIN (requests per visitor, default 20),
//           ALLOWED_ORIGIN (e.g. https://studymate-ai.vercel.app) to refuse calls from other sites.

const LIMITS = { messages: 12, chars: 12000, imageBytes: 3_500_000, maxTokens: 800 };
const SYSTEM = "You are the AI helper inside StudyMate AI, a learning coach for school and university students in Kazakhstan. " +
  "Only help with studying (UNT maths, calculus, study plans and exam preparation). Politely refuse anything else. " +
  "Give hints and guiding questions rather than ready answers, unless the instructions in the conversation ask for a JSON verdict.";
const hits = new Map(); // best-effort rate limit per visitor (resets when the function restarts)

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

function config() {
  if (process.env.GEMINI_API_KEY) {
    return { kind: "gemini", key: process.env.GEMINI_API_KEY.trim(), base: GEMINI_BASE, model: process.env.GEMINI_MODEL || process.env.AI_MODEL || "gemini-2.5-flash",
      images: process.env.AI_IMAGES !== "0", label: process.env.AI_LABEL || "Gemini" };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { kind: "anthropic", key: process.env.ANTHROPIC_API_KEY, model: process.env.AI_MODEL || "claude-haiku-5-5",
      images: process.env.AI_IMAGES !== "0", label: process.env.AI_LABEL || "Claude" };
  }
  if (process.env.AI_API_KEY && process.env.AI_BASE_URL && process.env.AI_MODEL) {
    return { kind: "openai", key: process.env.AI_API_KEY, base: process.env.AI_BASE_URL.replace(/\/+$/, ""), model: process.env.AI_MODEL,
      images: process.env.AI_IMAGES === "1", label: process.env.AI_LABEL || process.env.AI_MODEL };
  }
  return null;
}

function limited(req) {
  const max = parseInt(process.env.AI_MAX_PER_10MIN || "20", 10);
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?").split(",")[0].trim();
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 600_000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

function cleanMessages(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > LIMITS.messages) return null;
  let total = 0; const out = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    const text = m.content.slice(0, 4000); total += text.length;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += "\n\n" + text; else out.push({ role: m.role, content: text });
  }
  if (total > LIMITS.chars || out[0].role !== "user" || out[out.length - 1].role !== "user") return null;
  return out;
}

function cleanImage(images) {
  if (!Array.isArray(images) || !images.length) return null;
  const im = images[0];
  if (!im || !/^image\/(jpeg|png|webp)$/.test(im.media_type) || typeof im.data !== "string") return undefined;
  if (im.data.length > LIMITS.imageBytes || !/^[A-Za-z0-9+/=]+$/.test(im.data)) return undefined;
  return im;
}

async function callAnthropic(c, messages, image, maxTokens) {
  const msgs = messages.map(m => ({ role: m.role, content: m.content }));
  if (image) { const last = msgs[msgs.length - 1];
    last.content = [{ type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } }, { type: "text", text: last.content }]; }
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": c.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: c.model, max_tokens: maxTokens, system: SYSTEM, messages: msgs }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { status: r.status, error: j?.error?.message || "upstream error" };
  return { text: (j.content || []).filter(b => b.type === "text").map(b => b.text).join("") };
}

async function request(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function callGemini(c, messages, image, maxTokens) {
  const contents = messages.map(m => ({role: m.role === "assistant" ? "model" : "user", parts: [{text: m.content}]}));
  if (image) contents[contents.length - 1].parts.push({inline_data: {mime_type: image.media_type, data: image.data}});
  const url = `${c.base}/models/${encodeURIComponent(c.model)}:generateContent`;
  const r = await request(url, {method: "POST", headers: {"x-goog-api-key": c.key, "content-type": "application/json"},
    body: JSON.stringify({system_instruction: {parts: [{text: SYSTEM}]}, contents,
      generationConfig: {maxOutputTokens: maxTokens, temperature: 0.5}})});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return {status: r.status, error: j?.error?.message || "Gemini request rejected"};
  return {text: (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("")};
}

async function callOpenAI(c, messages, image, maxTokens) {
  const msgs = [{ role: "system", content: SYSTEM }].concat(messages.map(m => ({ role: m.role, content: m.content })));
  if (image) { const last = msgs[msgs.length - 1];
    last.content = [{ type: "text", text: last.content }, { type: "image_url", image_url: { url: `data:${image.media_type};base64,${image.data}` } }]; }
  const r = await request(c.base + "/chat/completions", { method: "POST",
    headers: { "authorization": "Bearer " + c.key, "content-type": "application/json" },
    body: JSON.stringify({ model: c.model, max_tokens: maxTokens, messages: msgs }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { status: r.status, error: j?.error?.message || "upstream error" };
  const content = j?.choices?.[0]?.message?.content;
  return { text: Array.isArray(content) ? content.map(p => p.text || "").join("") : String(content || "") };
}

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const c = config();
  if (req.method === "GET") return res.status(200).json(c ? { ok: true, images: c.images, label: c.label, provider: c.kind, model: c.model } : { ok: false, error: "missing_server_api_key" });
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  if (!c) return res.status(503).json({ error: "AI is not configured" });
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && req.headers.origin && req.headers.origin !== allowed) return res.status(403).json({ error: "forbidden" });
  if (limited(req)) return res.status(429).json({ error: "too many requests" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const messages = cleanMessages(body && body.messages);
  if (!messages) return res.status(400).json({ error: "bad messages" });
  const image = cleanImage(body.images);
  if (image === undefined) return res.status(400).json({ error: "bad image" });
  if (image && !c.images) return res.status(400).json({ error: "images not supported" });
  const maxTokens = Math.min(LIMITS.maxTokens, Math.max(50, parseInt(body.maxTokens, 10) || 600));

  try {
    const out = c.kind === "gemini" ? await callGemini(c, messages, image, maxTokens) : c.kind === "anthropic" ? await callAnthropic(c, messages, image, maxTokens) : await callOpenAI(c, messages, image, maxTokens);
    if (out.error) { console.error("AI provider error", out.status, out.error); const code = out.status === 400 ? "invalid_request" : out.status === 401 || out.status === 403 ? "invalid_key_or_permissions" : out.status === 404 ? "model_unavailable" : out.status === 429 ? "quota_exceeded" : "provider_unavailable"; return res.status(out.status === 429 ? 429 : 502).json({ error: code }); }
    if (!out.text || !out.text.trim()) return res.status(502).json({error:"empty_response"});
    return res.status(200).json({ text: out.text });
  } catch (e) {
    console.error("AI call failed", e && e.message);
    return res.status(502).json({ error: e?.name === "AbortError" ? "provider_timeout" : "provider_unavailable" });
  }
};
