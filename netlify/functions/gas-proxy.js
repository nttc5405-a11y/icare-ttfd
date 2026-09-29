// Netlify Function：瀏覽器與 GAS 之間的轉發層。
// 目的：GAS_URL、GAS_TOKEN 只存在這支程式的執行環境變數裡，
// 瀏覽器端的原始碼完全看不到、也拿不到這兩個值。
// 這支程式本身不做任何權限判斷——誰能做什麼、能看什麼，
// 全部還是由 GAS 後端（icare-gas-backend.js）決定，這裡只負責轉發。

const GAS_URL = process.env.GAS_URL;
const GAS_TOKEN = process.env.GAS_TOKEN;

exports.handler = async (event) => {
  if (!GAS_URL || !GAS_TOKEN) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Netlify 環境變數 GAS_URL 或 GAS_TOKEN 尚未設定，請至 Site settings → Environment variables 設定後重新部署。',
      }),
    };
  }

  try {
    let upstream;

    if (event.httpMethod === 'GET') {
      const params = new URLSearchParams(event.queryStringParameters || {});
      params.set('token', GAS_TOKEN);
      upstream = await fetch(GAS_URL + '?' + params.toString());
    } else if (event.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
      body.token = GAS_TOKEN;
      upstream = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body),
      });
    } else {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'error', message: 'Method not allowed' }),
      };
    }

    const text = await upstream.text();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', message: '轉發到 GAS 失敗：' + err.message }),
    };
  }
};
