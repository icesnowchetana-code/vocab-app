// 霸總學單字 後端（Cloudflare Worker）
// 所有金鑰都放在 Worker 的 Secrets 裡，前端拿不到。
//   ANTHROPIC_API_KEY：呼叫 Anthropic 用
//   NOTION_TOKEN：寫入 Notion 單字庫用（Integration token）
//   APP_PASS：通關密碼，前端用 X-App-Pass 帶上來
//   ALLOW_LOCALHOST：只在本機 .dev.vars 設成 "true"，正式環境不要設

const ALLOWED_ORIGINS = ['https://icesnowchetana-code.github.io'];

// 模型與上限由後端決定，前端不能指定
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 3500; // 多了詞性與例句，比原本的 2500 多留一些空間
const MAX_PROMPT_CHARS = 6000;

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (env.ALLOW_LOCALHOST === 'true') {
    return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }
  return false;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Pass',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(origin ? corsHeaders(origin) : {}),
    },
  });
}

// 比對密碼：先各自雜湊再比，避免從回應時間猜出密碼
async function passMatches(given, expected) {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function handleStory(request, env, origin) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: '請求格式錯誤（不是 JSON）' }, 400, origin); }

  const prompt = body?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return json({ error: '缺少 prompt' }, 400, origin);
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json({ error: 'prompt 太長' }, 413, origin);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: '後端尚未設定 ANTHROPIC_API_KEY' }, 500, origin);
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const message = data?.error?.message || `Anthropic 回應 ${resp.status}`;
    return json({ error: message }, 502, origin);
  }

  const text = (data?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return json({ text }, 200, origin);
}

// ===== Notion 單字庫 =====

const NOTION_VERSION = '2025-09-03';
const MAX_WORDS_PER_REQUEST = 12;

// 單字庫（data source ID）。只寫這兩個，不碰「待封存」的重複庫。
const VOCAB_DB = {
  en: { dataSourceId: '370f4fed-cfcc-816c-a058-000bdee1acde', defField: '定義', hasReading: false },
  jp: { dataSourceId: '370f4fed-cfcc-81a7-8ac8-000baebf89c6', defField: '意思', hasReading: true },
};

const SOURCE_NAME = '霸總單字';
const POS_OPTIONS =['名詞', '動詞', '形容詞', '副詞', '片語', '其他'];
const EN_LEVEL_MAP = { '初級': '初級', '中級': '中級', '進階': '高級', '高級': '高級' };
const JP_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
// APP 下拉選單的值 → Notion「類別」選項
const CATEGORY_MAP = {
  '': '一般', '一般': '一般',
  '建築設計': '建築', '建築': '建築',
  '結構工程': '結構工程',
  '室內設計': '室內設計',
  '都市規劃': '都市計畫', '都市計畫': '都市計畫',
  '專案管理': '專案管理',
  '材料工程': '材料工程',
};

const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const richText = (s) => (s ? [{ type: 'text', text: { content: s } }] : []);
const plainText = (prop) =>
  (prop?.rich_text || prop?.title || []).map((t) => t.plain_text || '').join('');

// 台灣時間的今天（YYYY-MM-DD）
function todayInTaipei() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function notion(env, method, path, body) {
  const resp = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data?.message || `Notion 回應 ${resp.status}`);
  return data;
}

// 用「單字」找同一筆。英文不分大小寫：多查幾種寫法，再用小寫比對確認。
async function findExisting(env, db, word, lang) {
  const variants = new Set([word]);
  if (lang === 'en') {
    const lower = word.toLowerCase();
    variants.add(lower);
    variants.add(word.toUpperCase());
    variants.add(lower.charAt(0).toUpperCase() + lower.slice(1));
  }
  const filters = [...variants].map((v) => ({ property: '單字', title: { equals: v } }));
  const data = await notion(env, 'POST', `/data_sources/${db.dataSourceId}/query`, {
    filter: filters.length > 1 ? { or: filters } : filters[0],
    page_size: 10,
  });
  const norm = (s) => (lang === 'en' ? s.trim().toLowerCase() : s.trim());
  return (data.results || []).find((p) => norm(plainText(p.properties['單字'])) === norm(word)) || null;
}

async function upsertWord(env, db, lang, w, shared) {
  const existing = await findExisting(env, db, w.word, lang);

  if (existing) {
    // 已有：只動 出現次數、最後出現、劇集，其他欄位（含熟悉度）一律不碰
    const count = existing.properties['出現次數']?.number || 0;
    const oldEpisodes = plainText(existing.properties['劇集']);
    let episodes = oldEpisodes ? `${oldEpisodes}；${shared.episode}` : shared.episode;
    if (episodes.length > 1900) episodes = '…' + episodes.slice(-1899);
    const properties = {
      '出現次數': { number: count + 1 },
      '最後出現': { date: { start: shared.today } },
      '劇集': { rich_text: richText(episodes) },
    };
    // 來源是多選時：原有來源全部保留，只在還沒有「霸總單字」時補上
    const source = existing.properties['來源'];
    if (source?.type === 'multi_select') {
      const names = source.multi_select.map((o) => o.name);
      if (!names.includes(SOURCE_NAME)) {
        properties['來源'] = { multi_select: [...names, SOURCE_NAME].map((name) => ({ name })) };
      }
    }
    await notion(env, 'PATCH', `/pages/${existing.id}`, { properties });
    return 'updated';
  }

  const level = lang === 'en'
    ? EN_LEVEL_MAP[shared.level]
    : (JP_LEVELS.includes(w.level) ? w.level : (JP_LEVELS.includes(shared.level) ? shared.level : null));

  const properties = {
    '單字': { title: richText(w.word) },
    [db.defField]: { rich_text: richText(w.def) },
    '例句': { rich_text: richText(w.example) },
    '詞性': { select: { name: POS_OPTIONS.includes(w.pos) ? w.pos : '其他' } },
    '類別': { select: { name: lang === 'en' ? (CATEGORY_MAP[shared.domain] || '一般') : '一般' } },
    '來源': shared.sourceIsMulti
      ? { multi_select: [{ name: SOURCE_NAME }] }
      : { select: { name: SOURCE_NAME } },
    '劇集': { rich_text: richText(shared.episode) },
    '出現次數': { number: 1 },
    '最後出現': { date: { start: shared.today } },
    '熟悉度': { select: { name: '陌生' } },
  };
  if (level) properties['程度'] = { select: { name: level } };
  if (db.hasReading) properties['讀音'] = { rich_text: richText(w.reading) };

  await notion(env, 'POST', '/pages', {
    parent: { type: 'data_source_id', data_source_id: db.dataSourceId },
    properties,
  });
  return 'created';
}

async function handleWords(request, env, origin) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: '請求格式錯誤（不是 JSON）' }, 400, origin); }

  const db = VOCAB_DB[body?.lang];
  if (!db) return json({ error: 'lang 必須是 en 或 jp' }, 400, origin);
  if (!Array.isArray(body.words) || body.words.length === 0) {
    return json({ error: '缺少 words' }, 400, origin);
  }
  if (body.words.length > MAX_WORDS_PER_REQUEST) {
    return json({ error: `一次最多 ${MAX_WORDS_PER_REQUEST} 個單字` }, 413, origin);
  }
  if (!env.NOTION_TOKEN) {
    return json({ error: '後端尚未設定 NOTION_TOKEN' }, 500, origin);
  }

  const shared = {
    today: todayInTaipei(),
    level: clip(body.level, 10),
    domain: clip(body.domain, 20),
    // 劇集：霸總類型／場景／第幾集
    episode: [clip(body.heroType, 20), clip(body.scene, 30), `第${parseInt(body.episode, 10) || 1}集`]
      .filter(Boolean).join('／'),
  };

  // 「來源」欄位可能是單選或多選，先看單字庫現在的設定再決定怎麼寫
  try {
    const schema = await notion(env, 'GET', `/data_sources/${db.dataSourceId}`);
    shared.sourceIsMulti = schema.properties?.['來源']?.type === 'multi_select';
  } catch (e) {
    return json({ error: `讀不到 Notion 單字庫：${e.message}` }, 502, origin);
  }

  // 同一批裡重複的單字只算一次
  const seen = new Set();
  const words = [];
  for (const raw of body.words) {
    const word = clip(raw?.word, 100);
    const key = body.lang === 'en' ? word.toLowerCase() : word;
    if (!word || seen.has(key)) continue;
    seen.add(key);
    words.push({
      word,
      def: clip(raw.def, 500),
      reading: clip(raw.reading, 100),
      example: clip(raw.example, 1000),
      pos: clip(raw.pos, 10),
      level: clip(raw.level, 5).toUpperCase(),
    });
  }

  let created = 0, updated = 0;
  const failed = [];
  // 一個一個來，避免超過 Notion 的速率限制
  for (const w of words) {
    try {
      const result = await upsertWord(env, db, body.lang, w, shared);
      if (result === 'created') created++; else updated++;
    } catch (e) {
      failed.push({ word: w.word, error: e.message });
    }
  }

  const status = failed.length && created + updated === 0 ? 502 : 200;
  return json({ created, updated, failed }, status, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = isAllowedOrigin(origin, env);

    // 來源不在名單內：直接拒絕，而且不回任何 CORS 標頭
    if (!allowed) return json({ error: '不允許的來源' }, 403, null);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (request.method !== 'POST') return json({ error: '只接受 POST' }, 405, origin);

    if (!(await passMatches(request.headers.get('X-App-Pass'), env.APP_PASS))) {
      return json({ error: '通關密碼錯誤' }, 401, origin);
    }

    if (url.pathname === '/api/story') return handleStory(request, env, origin);
    if (url.pathname === '/api/words') return handleWords(request, env, origin);

    return json({ error: '找不到這個路徑' }, 404, origin);
  },
};
