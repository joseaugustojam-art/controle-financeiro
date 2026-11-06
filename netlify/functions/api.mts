import type { Config, Context } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { licenses, ocrJobs, settings, userData, users } from "../../db/schema.js";
import {
  HttpError, activeLicense, checkPassword, fail, json, normCode, normEmail, readJson,
  requireUser, safeEqual, signToken, throttleCheck, throttleClear, throttleHit, validEmail, validatePassword,
} from "../../lib/auth.js";
import { inDays, setExpiry, setLicense, upsertUser } from "../../lib/accounts.js";

const MAX_DATA_BYTES = 4_000_000;
const MAX_IMAGES = 8;

type Handler = (req: Request, ctx: Context) => Promise<Response>;

// ---------- cliente ----------
const register: Handler = async (req) => {
  const b = await readJson(req);
  const email = normEmail(b.email), code = normCode(b.code);
  if (!validEmail(email)) throw new HttpError(400, "bad_email", "Informe um e-mail válido.");
  if (!code) throw new HttpError(400, "no_code", "Informe o código da transação (HP...).");
  const password = validatePassword(b.password);
  await throttleCheck("reg:" + email);
  const lic = await activeLicense(email);
  if (!lic || !lic.code || !safeEqual(normCode(lic.code), code)) {
    await throttleHit("reg:" + email);
    throw new HttpError(403, "no_license", "Não encontramos uma compra ativa com esse e-mail e código.");
  }
  await throttleClear("reg:" + email);
  const user = await upsertUser(email, password);
  return json({ token: await signToken(user) });
};

const login: Handler = async (req) => {
  const b = await readJson(req);
  const email = normEmail(b.email);
  await throttleCheck("login:" + email);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user || !(await checkPassword(String(b.password ?? ""), user.passHash))) {
    await throttleHit("login:" + email);
    throw new HttpError(401, "bad_login", "E-mail ou senha incorretos.");
  }
  await throttleClear("login:" + email);
  if (!(await activeLicense(email))) throw new HttpError(403, "license_inactive", "Licença inativa ou expirada. Fale com o suporte.");
  return json({ token: await signToken(user) });
};

const me: Handler = async (req) => {
  const u = await requireUser(req);
  return json({ id: u.id, email: u.email, isAdmin: u.isAdmin });
};

const data: Handler = async (req) => {
  const u = await requireUser(req);
  if (req.method === "GET") {
    const [row] = await db.select().from(userData).where(eq(userData.userId, u.id));
    return json({ docs: row?.docs ?? {} });
  }
  if (req.method === "PUT") {
    const raw = await req.text();
    if (raw.length > MAX_DATA_BYTES) throw new HttpError(413, "too_large", "Dados grandes demais.");
    let docs: unknown;
    try { docs = JSON.parse(raw).docs; } catch { throw new HttpError(400, "bad_json", "Requisição inválida."); }
    if (!docs || typeof docs !== "object" || Array.isArray(docs)) throw new HttpError(400, "bad_docs", "Dados inválidos.");
    await db.insert(userData).values({ userId: u.id, docs, updatedAt: new Date() })
      .onConflictDoUpdate({ target: userData.userId, set: { docs, updatedAt: new Date() } });
    return json({ ok: true });
  }
  throw new HttpError(405, "method", "Método não permitido.");
};

const ocrStart: Handler = async (req) => {
  const u = await requireUser(req);
  const b = await readJson(req);
  const id = String(b.id || "");
  if (!/^[a-z0-9]{8,40}$/i.test(id)) throw new HttpError(400, "bad_id", "Requisição inválida.");
  const images = Array.isArray(b.images) ? b.images.filter((x: unknown) => typeof x === "string" && x.length > 100) : [];
  if (!images.length || images.length > MAX_IMAGES) throw new HttpError(400, "image_rejected", "Envie de 1 a 8 imagens.");

  const limit = Number(process.env.OCR_LIMIT) || 40;
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(ocrJobs)
    .where(and(eq(ocrJobs.userId, u.id), gte(ocrJobs.createdAt, start)));
  if (n >= limit) throw new HttpError(429, "ocr_limit", `Limite de ${limit} leituras de fatura neste mês atingido.`);

  const [recent] = await db.select().from(ocrJobs).where(eq(ocrJobs.userId, u.id)).orderBy(desc(ocrJobs.createdAt)).limit(1);
  if (recent && Date.now() - recent.createdAt.getTime() < 10_000)
    throw new HttpError(429, "rate_limited", "Muitas leituras seguidas. Aguarde um minuto.");

  const meta = b.meta && typeof b.meta === "object" ? b.meta : {};
  const inserted = await db.insert(ocrJobs).values({ id, userId: u.id, meta }).onConflictDoNothing().returning();
  if (!inserted.length) throw new HttpError(409, "dup", "Leitura já iniciada.");
  const texts = Array.isArray(b.texts)
    ? b.texts.filter((x: unknown) => typeof x === "string").map((x: string) => x.slice(0, 40_000)).slice(0, MAX_IMAGES)
    : [];
  await getStore("ocr-images").setJSON(id, { images, texts });

  const r = await fetch(new URL("/.netlify/functions/ocr-worker", req.url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
  });
  if (r.status !== 202 && !r.ok) {
    await db.update(ocrJobs).set({ status: "error", code: "worker", message: "Não foi possível iniciar a leitura." }).where(eq(ocrJobs.id, id));
    throw new HttpError(502, "worker", "Não foi possível iniciar a leitura.");
  }
  return json({ ok: true, id });
};

const ocrStatus: Handler = async (req) => {
  const u = await requireUser(req);
  const id = new URL(req.url).searchParams.get("id") || "";
  const [job] = await db.select().from(ocrJobs).where(and(eq(ocrJobs.id, id), eq(ocrJobs.userId, u.id)));
  if (!job) throw new HttpError(404, "not_found", "Leitura não encontrada.");
  if (job.status === "done") return json({ status: "done", data: job.result });
  if (job.status === "error") return json({ status: "error", code: job.code, message: job.message });
  if (Date.now() - job.createdAt.getTime() > 5 * 60_000)
    return json({ status: "error", code: "timeout", message: "Tempo esgotado na leitura da fatura." });
  return json({ status: "pending" });
};

// ---------- admin ----------
const hasAdmin = async () =>
  (await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).limit(1)).length > 0;

// Aceita a sessão de um usuário administrador ou, opcionalmente, a chave ADMIN_KEY.
async function requireAdmin(req: Request) {
  const key = process.env.ADMIN_KEY;
  const sent = req.headers.get("x-admin-key");
  if (key && sent && safeEqual(sent, key)) return;
  if (req.headers.get("authorization")) {
    const u = await requireUser(req);
    if (u.isAdmin) return;
    throw new HttpError(403, "not_admin", "Esta conta não é de administrador.");
  }
  throw new HttpError(401, "no_session", "Entre com a sua conta de administrador.");
}

// Primeiro administrador: só funciona enquanto nenhum admin existir.
const adminSetup: Handler = async (req) => {
  if (req.method === "GET") return json({ hasAdmin: await hasAdmin() });
  if (req.method !== "POST") throw new HttpError(405, "method", "Método não permitido.");
  // Se ADMIN_KEY estiver definida, ela é exigida para criar o primeiro administrador (evita que um estranho tome a conta).
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && !safeEqual(req.headers.get("x-admin-key") || "", adminKey))
    throw new HttpError(401, "bad_admin_key", "Informe a chave de administrador (ADMIN_KEY) para criar o administrador.");
  const b = await readJson(req);
  const email = normEmail(b.email);
  if (!validEmail(email)) throw new HttpError(400, "bad_email", "Informe um e-mail válido.");
  const password = validatePassword(b.password);
  if (await hasAdmin()) throw new HttpError(409, "admin_exists", "O administrador já foi criado. Entre com e-mail e senha.");
  const claimed = await db.insert(settings).values({ key: "admin_claimed", value: email }).onConflictDoNothing().returning();
  if (!claimed.length) throw new HttpError(409, "admin_exists", "O administrador já foi criado. Entre com e-mail e senha.");
  await setLicense(email, { code: "ADMIN", status: "active", source: "admin", event: "ADMIN_SETUP" });
  const u = await upsertUser(email, password);
  const [admin] = await db.update(users).set({ isAdmin: true }).where(eq(users.id, u.id)).returning();
  return json({ token: await signToken(admin) });
};

const admin: Handler = async (req) => {
  await requireAdmin(req);
  if (req.method === "GET") {
    const rows = await db.select().from(licenses).orderBy(desc(licenses.updatedAt)).limit(500);
    const accs = await db.select({ email: users.email }).from(users);
    const has = new Set(accs.map((a) => a.email));
    const exps = await db.select().from(settings).where(like(settings.key, "exp:%"));
    const expMap = new Map(exps.map((e) => [e.key.slice(4), Number(e.value)]));
    return json({ licenses: rows.map((r) => ({ ...r, hasAccount: has.has(r.email), expiresAt: expMap.get(r.email) ?? null })) });
  }
  if (req.method !== "POST") throw new HttpError(405, "method", "Método não permitido.");
  const b = await readJson(req);
  const email = normEmail(b.email);
  if (!validEmail(email)) throw new HttpError(400, "bad_email", "Informe um e-mail válido.");
  const action = String(b.action || "grant");

  if (action === "revoke") {
    const [target] = await db.select().from(users).where(eq(users.email, email));
    if (target?.isAdmin) throw new HttpError(400, "is_admin", "Não é possível revogar a conta de administrador.");
    const lic = await setLicense(email, { status: "revoked", source: "admin", event: "ADMIN_REVOKE" });
    return json({ ok: true, license: lic });
  }
  if (action === "grant") {
    // days > 0 = código de teste com prazo (aceita fração: 0.0417 ≈ 1 hora). Sem days = sem prazo.
    const days = Math.min(Math.max(Number(b.days) || 0, 0), 365);
    const code = normCode(b.code) || (days > 0 ? "TESTE-" + randomBytes(3).toString("hex").toUpperCase() : "TESTE1");
    const lic = await setLicense(email, { code, status: "active", source: "admin", event: days > 0 ? "ADMIN_TRIAL" : "ADMIN_GRANT" });
    const expiresAt = days > 0 ? inDays(days) : null;
    await setExpiry(email, expiresAt);
    return json({ ok: true, license: lic, expiresAt: expiresAt ? expiresAt.getTime() : null });
  }
  if (action === "create_account") {
    // Libera a licença e já cria a conta (ou troca a senha) — útil para o seu próprio acesso.
    const password = validatePassword(b.password);
    const code = normCode(b.code) || "ADMIN";
    const days = Math.min(Math.max(Number(b.days) || 0, 0), 365);
    await setLicense(email, { code, status: "active", source: "admin", event: "ADMIN_ACCOUNT" });
    await setExpiry(email, days > 0 ? inDays(days) : null);
    await upsertUser(email, password);
    return json({ ok: true });
  }
  throw new HttpError(400, "bad_action", "Ação desconhecida.");
};

// ---------- webhook Hotmart (v2) ----------
const ACTIVATE = new Set(["PURCHASE_APPROVED", "PURCHASE_COMPLETE"]);
const REVOKE = new Set(["PURCHASE_CANCELED", "PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_PROTEST", "SUBSCRIPTION_CANCELLATION"]);

const hotmart: Handler = async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "method", "Método não permitido.");
  const expected = process.env.HOTMART_HOTTOK;
  if (!expected) throw new HttpError(503, "not_configured", "HOTMART_HOTTOK não configurado.");
  const b = await readJson(req);
  const got = req.headers.get("x-hotmart-hottok") || String(b.hottok || "");
  if (!safeEqual(got, expected)) throw new HttpError(401, "bad_hottok", "hottok inválido.");

  const event = String(b.event || "").toUpperCase();
  const d = b.data || {};
  const productId = process.env.HOTMART_PRODUCT_ID;
  if (productId && d.product?.id != null && String(d.product.id) !== String(productId))
    return json({ ok: true, ignored: "product" });
  const email = normEmail(d.buyer?.email || d.subscriber?.email);
  if (!validEmail(email)) return json({ ok: true, ignored: "no_email" });
  const code = normCode(d.purchase?.transaction);

  if (ACTIVATE.has(event)) {
    await setLicense(email, { code, status: "active", source: "hotmart", event });
    await setExpiry(email, null); // a compra real substitui qualquer prazo de teste
  } else if (REVOKE.has(event)) {
    const [lic] = await db.select().from(licenses).where(eq(licenses.email, email));
    // Só revoga se for a mesma transação (ou se não houver código para comparar).
    if (lic && (!code || !lic.code || normCode(lic.code) === code || event === "SUBSCRIPTION_CANCELLATION"))
      await setLicense(email, { status: "revoked", source: "hotmart", event });
  } else {
    return json({ ok: true, ignored: event || "no_event" });
  }
  return json({ ok: true });
};

const routes: Record<string, Handler> = {
  register, login, me, data, "admin-setup": adminSetup, "ocr-start": ocrStart, "ocr-status": ocrStatus, admin, hotmart,
};
const POST_ONLY = new Set(["register", "login", "ocr-start"]);

export default async (req: Request, ctx: Context) => {
  try {
    const name = new URL(req.url).pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
    const h = routes[name];
    if (!h) throw new HttpError(404, "not_found", "Rota não encontrada.");
    if (POST_ONLY.has(name) && req.method !== "POST") throw new HttpError(405, "method", "Método não permitido.");
    return await h(req, ctx);
  } catch (e) {
    return fail(e);
  }
};

export const config: Config = { path: "/api/*" };
