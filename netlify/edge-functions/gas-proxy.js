// Netlify Edge Function：瀏覽器與 GAS 之間的轉發層（取代原本的 Netlify Function）。
// 目的一：GAS_URL、GAS_TOKEN 只存在這支程式的執行環境變數裡，瀏覽器端完全看不到。
// 目的二：省點數。原本的 Netlify Function 按「執行時間」計算運算點數，而轉發層大部分時間都在
//         等 Google 回應；Edge Function 只算「請求數」（便宜很多），等待時間不計運算點數。
// 這支程式本身不做任何權限判斷——誰能做什麼、能看什麼，全部由 GAS 後端（icare-gas-backend.js）決定。
// 網址與原本相同（/.netlify/functions/gas-proxy），所以網頁不用改。
//
// 其他設計：
//  1. 配額查詢 getQuota 直接回固定值，不去問 GAS
//  2. 匿名的 getAll（GET）已停用，直接 403；需憑證的 getAll 走 POST，不受影響
//  3. 少變動的唯讀設定交給 Netlify 邊緣快取，命中時連這支程式都不會執行
//  4. 等 GAS 最多等 26 秒（Edge Function 回應標頭限制為 40 秒）

const UPSTREAM_TIMEOUT_MS = 26000;

// 只有這幾個「公開、唯讀、很少變動」的 GET 查詢才允許被快取。
// 絕對不可放：任何帶身分驗證的動作（本來就走 POST）、ping（要真的測到連線）。
// max-age＝這段時間內直接回快取；stale-while-revalidate＝過期後先回舊的、背景再更新。
const CACHEABLE_GET = {
  getUnits:        'public, durable, max-age=300, stale-while-revalidate=3600',
  getDispositions: 'public, durable, max-age=300, stale-while-revalidate=3600',
  getCriteria:     'public, durable, max-age=300, stale-while-revalidate=3600',
  getSettings:     'public, durable, max-age=60, stale-while-revalidate=120',
};

function jsonResponse(status, obj, extraHeaders) {
  return new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
  });
}

function isOkJson(text) {
  try { return JSON.parse(text).status === 'ok'; } catch (e) { return false; }
}

export default async (request) => {
  const GAS_URL = Netlify.env.get('GAS_URL');
  const GAS_TOKEN = Netlify.env.get('GAS_TOKEN');
  if (!GAS_URL || !GAS_TOKEN) {
    return jsonResponse(500, {
      status: 'error',
      message: 'Netlify 環境變數 GAS_URL 或 GAS_TOKEN 尚未設定，請至 Site settings → Environment variables 設定後重新部署。',
    }, { 'Cache-Control': 'no-store' });
  }

  const method = request.method;
  if (method !== 'GET' && method !== 'POST') {
    return jsonResponse(405, { status: 'error', message: 'Method not allowed' }, { 'Cache-Control': 'no-store' });
  }

  const url = new URL(request.url);
  const action = method === 'GET' ? url.searchParams.get('action') : undefined;

  // 匿名的 getAll（網址帶 ?action=getAll 的 GET）已無正常用途（填報改用收據碼），一律擋掉。
  // 需憑證的 getAll 走 POST、網址沒有 action 參數，不受影響。
  if (action === 'getAll') {
    return jsonResponse(403, { status: 'error', message: '此查詢已停用' }, { 'Cache-Control': 'no-store' });
  }

  // 配額查詢：GAS 後端早已停止累計執行時間，真實值恆為 0，直接在這裡回答
  if (action === 'getQuota') {
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    return jsonResponse(200, { status: 'ok', usedSeconds: 0, date: today }, {
      'Netlify-CDN-Cache-Control': 'public, durable, max-age=600',
      'Netlify-Vary': 'query=action',
    });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    let upstream;
    if (method === 'GET') {
      const params = new URLSearchParams(url.search);
      params.set('token', GAS_TOKEN);
      upstream = await fetch(GAS_URL + '?' + params.toString(), { signal: ctrl.signal });
    } else {
      let body = {};
      try { body = JSON.parse((await request.text()) || '{}'); } catch (e) { body = {}; }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) body = {};
      body.token = GAS_TOKEN;
      upstream = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    }

    const text = await upstream.text();

    // 只有「查詢成功、而且在白名單內」才快取；錯誤或異常回應一律不快取，避免把錯誤存起來
    const cacheRule = CACHEABLE_GET[action];
    if (cacheRule && upstream.ok && isOkJson(text)) {
      return jsonResponse(200, text, {
        'Netlify-CDN-Cache-Control': cacheRule,
        'Netlify-Vary': 'query=action',
      });
    }
    return jsonResponse(200, text, { 'Cache-Control': 'no-store' });
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return jsonResponse(timedOut ? 504 : 502, {
      status: 'error',
      message: timedOut ? '後端回應逾時，請稍後再試' : '轉發到 GAS 失敗：' + (err && err.message),
    }, { 'Cache-Control': 'no-store' });
  } finally {
    clearTimeout(timer);
  }
};

// cache: 'manual'＝允許用上面回應裡的 Netlify-CDN-Cache-Control 把結果存在邊緣快取
export const config = { path: '/.netlify/functions/gas-proxy', cache: 'manual' };
