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
  "Only help with studying (UNT and university subjects, study plans and exam preparation). Politely refuse anything else. " +
  "Give hints and guiding questions rather than ready answers, unless the instructions in the conversation ask for a JSON verdict.";
const hits = new Map(); // best-effort rate limit per visitor (resets when the function restarts)

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
let geminiModel = null; // found once per function start

function config() {
  if (process.env.GEMINI_API_KEY) {
    return { kind: "openai", gemini: true, key: process.env.GEMINI_API_KEY.trim(), base: GEMINI_BASE, model: process.env.AI_MODEL || geminiModel,
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

// Gemini: try several "flash" models in order and remember the first one that answers,
// so nobody has to type a model name and a retired or quota-limited model does not break the helper.
const GEMINI_FALLBACKS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-flash-latest"];
let geminiList = null;

async function geminiCandidates(c) {
  if (process.env.AI_MODEL) return [process.env.AI_MODEL];
  if (geminiModel) return [geminiModel].concat(GEMINI_FALLBACKS.filter(m => m !== geminiModel));
  if (geminiList) return geminiList;
  let found = [];
  try {
    const r = await fetch(c.base + "/models", { headers: { "authorization": "Bearer " + c.key } });
    const j = await r.json().catch(() => ({}));
    found = (j.data || []).map(m => String(m.id || "").replace(/^models\//, ""))
      .filter(id => /^gemini-[\d.]+-flash(-lite)?$/.test(id));
  } catch {}
  const ver = id => parseFloat(id.split("-")[1]) || 0;
  found.sort((a, b) => ver(b) - ver(a) || a.length - b.length);
  geminiList = Array.from(new Set(GEMINI_FALLBACKS.concat(found))).slice(0, 6);
  return geminiList;
}

function authError(status, msg) {
  return status === 401 || status === 403 || /api key|api_key|permission|unauthenticated/i.test(msg || "");
}

async function chatOnce(c, model, msgs, maxTokens, extra) {
  const body = Object.assign({ model, max_tokens: maxTokens, messages: msgs }, extra || {});
  const r = await fetch(c.base + "/chat/completions", { method: "POST",
    headers: { "authorization": "Bearer " + c.key, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  const err = Array.isArray(j) ? j[0]?.error : j?.error;
  if (!r.ok) return { status: r.status, error: err?.message || ("HTTP " + r.status) };
  const content = j?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map(p => p.text || "").join("") : String(content || "");
  if (!text.trim()) return { status: 502, error: "empty answer (finish_reason: " + (j?.choices?.[0]?.finish_reason || "?") + ")" };
  return { text, model };
}

async function callOpenAI(c, messages, image, maxTokens) {
  const msgs = [{ role: "system", content: SYSTEM }].concat(messages.map(m => ({ role: m.role, content: m.content })));
  if (image) { const last = msgs[msgs.length - 1];
    last.content = [{ type: "text", text: last.content }, { type: "image_url", image_url: { url: `data:${image.media_type};base64,${image.data}` } }]; }
  if (!c.gemini) return chatOnce(c, c.model, msgs, maxTokens);

  // Gemini "thinking" models spend output tokens on reasoning, so give them room and keep reasoning low
  const budget = maxTokens + 1500;
  let last = { status: 502, error: "no model answered" };
  for (const model of await geminiCandidates(c)) {
    let out = await chatOnce(c, model, msgs, budget, { reasoning_effort: "low" });
    if (out.error && out.status === 400 && !authError(out.status, out.error)) out = await chatOnce(c, model, msgs, budget);
    if (!out.error) { geminiModel = model; return out; }
    console.error("Gemini model failed", model, out.status, out.error);
    last = out;
    if (authError(out.status, out.error)) break; // a bad key fails on every model
  }
  return last;
}

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const c = config();
  if (req.method === "GET") {
    const test = /[?&]test=1/.test(req.url || "");
    if (!test) return res.status(200).json(c ? { ok: true, images: c.images, label: c.label } : { ok: false });
    // diagnostic: open /api/ai?test=1 in the browser to see whether the key and model work (the key itself is never shown)
    if (!c) return res.status(200).json({ ok: false, problem: "No key found. Add GEMINI_API_KEY in Vercel → Settings → Environment Variables, then Redeploy." });
    if (limited(req)) return res.status(429).json({ ok: false, problem: "too many requests, wait 10 minutes" });
    try {
      const out = c.kind === "anthropic" ? await callAnthropic(c, [{ role: "user", content: "Reply with the single word OK." }], null, 50)
        : await callOpenAI(c, [{ role: "user", content: "Reply with the single word OK." }], null, 50);
      return res.status(200).json(out.error ? { ok: false, provider: c.label, status: out.status, problem: out.error }
        : { ok: true, provider: c.label, model: out.model || c.model, answer: out.text.slice(0, 40) });
    } catch (e) { return res.status(200).json({ ok: false, provider: c.label, problem: String(e && e.message) }); }
  }
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
    const out = c.kind === "anthropic" ? await callAnthropic(c, messages, image, maxTokens) : await callOpenAI(c, messages, image, maxTokens);
    if (out.error) { console.error("AI provider error", out.status, out.error); return res.status(out.status === 429 ? 429 : 502).json({ error: "AI provider error" }); }
    return res.status(200).json({ text: out.text });
  } catch (e) {
    console.error("AI call failed", e && e.message);
    return res.status(502).json({ error: "AI call failed" });
  }
};
