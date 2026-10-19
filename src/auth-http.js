import { AuthError } from './auth.js';
import {
  bearerToken, makeJsonSender, readJson, requestContext, sendError,
} from './http-util.js';

const OAUTH_ROUTE = /^\/auth\/oauth\/([a-z]+)\/(start|callback)$/;
const OAUTH_UNLINK = /^\/auth\/oauth\/([a-z]+)$/;

const html = (res, status, text) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><p style="font:16px sans-serif;margin:2em">${text}</p>`);
};

/**
 * Các đường dẫn /auth/*. Trả về hàm xử lý: true nếu đã xử lý yêu cầu.
 *
 *   GET    /auth/providers                      -> { ok, providers: ['google', ...] }  (chỉ những bên đã cấu hình)
 *   POST   /auth/register  { username, password, displayName? }  -> { ok, token, user }
 *   POST   /auth/login     { username, password }                -> { ok, token, user }
 *   GET    /auth/me        (Bearer)                              -> { ok, user: { ..., providers, hasPassword } }
 *   POST   /auth/logout    (Bearer)                              -> { ok }
 *   POST   /auth/oauth/:provider/start  { appRedirect, link? }   -> { ok, url }  (link=true cần Bearer)
 *   GET    /auth/oauth/:provider/callback?code&state             -> 302 về app kèm ?code=... hoặc ?error=...
 *   POST   /auth/oauth/exchange  { code }                        -> { ok, token, user }
 *   DELETE /auth/oauth/:provider (Bearer)                        -> { ok }  (gỡ liên kết)
 */
export function createAuthRoutes(auth, oauth, { corsOrigin = '*', trustProxy = false } = {}) {
  const send = makeJsonSender(corsOrigin);

  const requireUser = async (req) => {
    const user = await auth.authenticate(bearerToken(req));
    if (!user) throw new AuthError('invalid_token', 401);
    return user;
  };

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    if (!pathname.startsWith('/auth/')) return false;

    if (req.method === 'OPTIONS') {
      send(res, 204, {});
      return true;
    }

    const ctx = requestContext(req, trustProxy);
    try {
      const route = `${req.method} ${pathname}`;
      const oauthMatch = OAUTH_ROUTE.exec(pathname);
      const unlinkMatch = OAUTH_UNLINK.exec(pathname);

      if (route === 'GET /auth/providers') {
        send(res, 200, { ok: true, providers: oauth.listProviders() });
      } else if (route === 'POST /auth/register') {
        send(res, 200, { ok: true, ...(await auth.register(await readJson(req), ctx)) });
      } else if (route === 'POST /auth/login') {
        send(res, 200, { ok: true, ...(await auth.login(await readJson(req), ctx)) });
      } else if (route === 'GET /auth/me') {
        const user = await requireUser(req);
        send(res, 200, { ok: true, user: await auth.profile(user.id) });
      } else if (route === 'POST /auth/logout') {
        await requireUser(req);
        await auth.logout(bearerToken(req), ctx);
        send(res, 200, { ok: true });
      } else if (route === 'POST /auth/oauth/exchange') {
        const body = await readJson(req);
        send(res, 200, { ok: true, ...(await oauth.exchange(body.code, ctx)) });
      } else if (oauthMatch && req.method === 'POST' && oauthMatch[2] === 'start') {
        const body = await readJson(req);
        const linkUserId = body.link === true ? (await requireUser(req)).id : null;
        const authorizeUrl = await oauth.start(oauthMatch[1], { appRedirect: body.appRedirect, linkUserId });
        send(res, 200, { ok: true, url: authorizeUrl });
      } else if (oauthMatch && req.method === 'GET' && oauthMatch[2] === 'callback') {
        const result = await oauth.handleCallback(oauthMatch[1], Object.fromEntries(url.searchParams), ctx);
        if (result.redirect) {
          res.writeHead(302, { location: result.redirect, 'cache-control': 'no-store' });
          res.end();
        } else {
          html(res, 400, 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Hãy quay lại ứng dụng và thử lại.');
        }
      } else if (unlinkMatch && req.method === 'DELETE' && unlinkMatch[1] !== 'exchange') {
        const user = await requireUser(req);
        await oauth.unlink(user.id, unlinkMatch[1], ctx);
        send(res, 200, { ok: true });
      } else {
        throw new AuthError('not_found', 404);
      }
    } catch (err) {
      sendError(send, res, err);
    }
    return true;
  };
}
