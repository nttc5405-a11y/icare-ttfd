// Netlify Function：瀏覽器與 GAS 之間的轉發層。
// 目的：GAS_URL、GAS_TOKEN 只存在這支程式的執行環境變數裡，
// 瀏覽器端的原始碼完全看不到、也拿不到這兩個值。
// 這支程式本身不做任何權限判斷——誰能做什麼、能看什麼，
// 全部還是由 GAS 後端（icare-gas-backend.js）決定，這裡只負責轉發。
//
// 省點數設計（Netlify 依「函式執行時間」計費，而這支程式大部分時間都在等 GAS）：
//  1. 配額查詢 getQuota 直接回固定值，不再去問 GAS
//  2. 少變動的唯讀設定交給 Netlify 邊緣快取，命中時不會執行這支函式
//  3. 等 GAS 最多等 26 秒，不空等到被平台強制切斷

const GAS_URL = process.env.GAS_URL;
const GAS_TOKEN = process.env.GAS_TOKEN;

const UPSTREAM_TIMEOUT_MS = 26000;

// 只有這幾個「公開、唯讀、很少變動」的 GET 查詢才允許被快取。
// 絕對不可放：getAll（填報頁的「今天填過了嗎」會用到，每次內容不同）、
// 任何帶身分驗證的動作（本來就走 POST）、ping（要真的測到連線）。
// max-age＝這段時間內直接回快取；stale-while-revalidate＝過期後先回舊的、背景再更新。
const CACHEABLE_GET = {
  getUnits:        'public, durable, max-age=300, stale-while-revalidate=3600',
  getDispositions: 'public, durable, max-age=300, stale-while-revalidate=3600',
  getCriteria:     'public, durable, max-age=300, stale-while-revalidate=3600',
  getSettings:     'public, durable, max-age=60, stale-while-revalidate=120',
};

function jsonResponse(statusCode, obj, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: typeof obj === 'string' ? obj : JSON.stringify(obj),
  };
}

function isOkJson(text) {
  try { return JSON.parse(text).status === 'ok'; } catch (e) { return false; }
}

exports.handler = async (event) => {
  if (!GAS_URL || !GAS_TOKEN) {
    return jsonResponse(500, {
      status: 'error',
      message: 'Netlify 環境變數 GAS_URL 或 GAS_TOKEN 尚未設定，請至 Site settings → Environment variables 設定後重新部署。',
    }, { 'Cache-Control': 'no-store' });
  }

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonResponse(405, { status: 'error', message: 'Method not allowed' }, { 'Cache-Control': 'no-store' });
  }

  const query = event.queryStringParameters || {};
  const action = event.httpMethod === 'GET' ? query.action : undefined;

  // 匿名的 getAll（查某單位「今天」的紀錄）只給填報頁在「送出後沒收到回應」時查證用，
  // 填報頁會帶 X-ICare-Verify 標記。沒帶標記的（例如外部程式反覆抓取）在這裡直接擋掉：
  // 既不去問 GAS（省下等十幾秒的點數），也不把當日紀錄交出去。
  // 需憑證的 getAll 走 POST，不受影響。
  if (action === 'getAll' && !(event.headers && event.headers['x-icare-verify'])) {
    return jsonResponse(403, { status: 'error', message: '此查詢需由填報頁發出' }, { 'Cache-Control': 'no-store' });
  }

  // 配額查詢：GAS 後端早已停止累計執行時間，真實值恆為 0，
  // 網頁卻每 10 分鐘問一次，直接在這裡回答，省掉一次等 GAS 的時間。
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
    if (event.httpMethod === 'GET') {
      const params = new URLSearchParams(query);
      params.set('token', GAS_TOKEN);
      upstream = await fetch(GAS_URL + '?' + params.toString(), { signal: ctrl.signal });
    } else {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
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
      message: timedOut ? '後端回應逾時，請稍後再試' : '轉發到 GAS 失敗：' + err.message,
    }, { 'Cache-Control': 'no-store' });
  } finally {
    clearTimeout(timer);
  }
};
