// Netlify Edge Function：在 gas-proxy 函式「之前」執行。
// 匿名的 getAll（網址帶 ?action=getAll 的 GET）已無正常用途（填報改用收據碼，
// 需憑證的 getAll 走 POST、網址沒有 action 參數），外部程式反覆呼叫的話，
// 在這一層直接回 403，不進函式，所以不會消耗「函數運算」點數（改按便宜的請求數計）。
// 其餘請求一律原樣放行給 gas-proxy。
export default async (request, context) => {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.searchParams.get('action') === 'getAll') {
    return new Response(JSON.stringify({ status: 'error', message: '此查詢已停用' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  return context.next();
};

export const config = { path: '/.netlify/functions/gas-proxy' };
