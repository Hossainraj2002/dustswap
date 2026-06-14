import { COOKIE_NAME, expectedToken, getPassword, jsonResponse } from "../../_lib/auth.js";

// POST { password } -> sets session cookie on success
// DELETE -> logs out (clears cookie)
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  const expected = getPassword(env);
  if (!expected) {
    return jsonResponse(
      { error: "ADMIN_PASSWORD is not configured on this Cloudflare Pages project." },
      503
    );
  }

  if (!body || body.password !== expected) {
    return jsonResponse({ error: "Incorrect password" }, 401);
  }

  const token = await expectedToken(env);
  const headers = new Headers({ "content-type": "application/json" });
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
  );

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

export async function onRequestDelete() {
  const headers = new Headers({ "content-type": "application/json" });
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
