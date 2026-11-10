// Cloudflare Worker: посредник между мини-приложением «Мой тренер» и Gemini API.
// Секреты (Settings → Variables and Secrets): GEMINI_KEY — ключ из Google AI Studio,
// BOT_TOKEN — токен бота от BotFather (нужен, чтобы пускать запросы только из твоего Telegram).
// Необязательно: ALLOWED_USERS — Telegram ID через запятую; MODEL — имя модели Gemini.

const ORIGIN = "https://1-sketch-hash.github.io";
const MODELS = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"];

const SYSTEM = `Ты — тренер по питанию в приложении «Мой тренер». Пользователь: мужчина 25 лет, рост 177 см, вес около 72 кг, тренируется 4 раза в неделю фулбади, цель — рекомпозиция (убрать жир на боках, набрать мышцы верха). Живёт в Германии: учитывай местные продукты (Skyr, Magerquark, Hüttenkäse, продукты из REWE, Lidl, Aldi).
Цель на день: ~2300 ккал, белок 140 г, жиры 60–70 г, углеводы 260–290 г.
Что ты делаешь:
1. Если пользователь описал или сфотографировал еду — оцени каждый продукт: название, примерный вес в граммах, ккал, белки, жиры, углеводы. Если вес неизвестен — возьми типичную порцию и назови её в ответе. Будь реалистичен, не занижай калории соусов и масла.
2. Если просит совет — предложи конкретные блюда с граммовками под остаток калорий и белка на сегодня.
3. Отвечай по-русски, коротко и по делу: 2–5 предложений, без воды. Не ставь диагнозов; при вопросах о здоровье советуй врача.
Всегда отвечай ТОЛЬКО JSON без markdown такого вида:
{"reply":"текст ответа","items":[{"name":"продукт","grams":150,"kcal":250,"protein":30,"fat":8,"carbs":10}]}
Поле items заполняй только когда оцениваешь съеденную еду; иначе отдавай пустой массив.`;

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "not_found" }, 404);
    if (!env.GEMINI_KEY) return json({ error: "no_key" }, 500);

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

    // Пускаем только запросы из Telegram этого бота.
    if (env.BOT_TOKEN) {
      const user = await verifyInitData(String(body.initData || ""), env.BOT_TOKEN);
      if (!user) return json({ error: "unauthorized" }, 401);
      if (env.ALLOWED_USERS) {
        const ids = env.ALLOWED_USERS.split(",").map(s => s.trim());
        if (!ids.includes(String(user.id))) return json({ error: "forbidden" }, 403);
      }
    }

    const text = String(body.text || "").slice(0, 2000);
    const context = String(body.context || "").slice(0, 1500);
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
    const contents = [];
    for (const m of history) {
      const t = String(m.text || "").slice(0, 1500);
      if (t) contents.push({ role: m.role === "model" ? "model" : "user", parts: [{ text: t }] });
    }
    const parts = [{ text: (context ? "[Данные на сегодня] " + context + "\n\n" : "") + (text || "Оцени еду на фото.") }];
    if (body.image && body.image.data && String(body.image.data).length < 2_000_000) {
      parts.push({ inline_data: { mime_type: body.image.mime || "image/jpeg", data: body.image.data } });
    }
    contents.push({ role: "user", parts });

    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      generationConfig: { temperature: 0.4, responseMimeType: "application/json", maxOutputTokens: 1200 }
    };

    const models = env.MODEL ? [env.MODEL, ...MODELS] : MODELS;
    let lastErr = "no_model";
    for (const model of models) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
        body: JSON.stringify(payload)
      });
      if (r.status === 404 || r.status === 400 && model !== models[models.length - 1]) { lastErr = "model_" + r.status; continue; }
      if (r.status === 429) return json({ error: "rate_limit" }, 429);
      if (!r.ok) { lastErr = "gemini_" + r.status; continue; }
      const data = await r.json();
      const raw = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
      let out;
      try { out = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()); }
      catch { out = { reply: raw.trim() || "Не получилось разобрать ответ, попробуй ещё раз.", items: [] }; }
      const items = Array.isArray(out.items) ? out.items.slice(0, 15).map(i => ({
        name: String(i.name || "").slice(0, 60), grams: num(i.grams), kcal: num(i.kcal),
        protein: num(i.protein), fat: num(i.fat), carbs: num(i.carbs)
      })) : [];
      return json({ reply: String(out.reply || "").slice(0, 3000), items, model });
    }
    return json({ error: lastErr }, 502);
  }
};

function num(v) { const n = Number(v); return isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0; }

// Проверка подписи Telegram WebApp initData (HMAC-SHA256).
async function verifyInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const enc = new TextEncoder();
  const hmac = async (keyBytes, data) => {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  };
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const sig = await hmac(secret, check);
  const hex = [...sig].map(b => b.toString(16).padStart(2, "0")).join("");
  if (hex !== hash) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 7 * 24 * 3600) return null;
  try { return JSON.parse(params.get("user") || "{}"); } catch { return null; }
}
