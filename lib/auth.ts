import { createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { licenses, settings, users } from "../db/schema.js";

const scrypt = promisify(_scrypt) as (p: string, s: Buffer, n: number) => Promise<Buffer>;
const TOKEN_DAYS = 30;

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

export const fail = (e: unknown) => {
  if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
  console.error(e);
  return json({ error: "Erro interno no servidor.", code: "server_error" }, 500);
};

export const normEmail = (v: unknown) => String(v ?? "").trim().toLowerCase();
export const normCode = (v: unknown) => String(v ?? "").trim().toUpperCase();
export const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Segredo para assinar sessões: usa JWT_SECRET se existir; senão gera um e guarda no banco.
let secretCache: string | null = null;
async function secret(): Promise<string> {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (secretCache) return secretCache;
  const fresh = randomBytes(48).toString("base64url");
  await db.insert(settings).values({ key: "session_secret", value: fresh }).onConflictDoNothing();
  const [row] = await db.select().from(settings).where(eq(settings.key, "session_secret"));
  secretCache = row.value;
  return secretCache;
}

export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return `s1$${salt.toString("base64")}$${h.toString("base64")}`;
}

export async function checkPassword(pw: string, stored: string) {
  const [, s, h] = stored.split("$");
  if (!s || !h) return false;
  const got = await scrypt(pw, Buffer.from(s, "base64"), 64);
  const want = Buffer.from(h, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function signToken(user: { id: string; tokenVersion: number }) {
  const body = Buffer.from(
    JSON.stringify({ sub: user.id, v: user.tokenVersion, exp: Date.now() + TOKEN_DAYS * 864e5 }),
  ).toString("base64url");
  const sig = createHmac("sha256", await secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function validatePassword(pw: unknown) {
  const p = String(pw ?? "");
  if (p.length < 8) throw new HttpError(400, "weak_password", "A senha precisa ter pelo menos 8 caracteres.");
  if (p.length > 200) throw new HttpError(400, "weak_password", "Senha longa demais.");
  return p;
}

export async function activeLicense(email: string) {
  const [lic] = await db.select().from(licenses).where(eq(licenses.email, email));
  return lic && lic.status === "active" ? lic : null;
}

// Valida a sessão e confirma que a licença continua ativa (bloqueia reembolso/chargeback na hora).
export async function requireUser(req: Request) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  if (!m) throw new HttpError(401, "no_session", "Faça login para continuar.");
  const [body, sig] = m[1].split(".");
  if (!body || !sig) throw new HttpError(401, "bad_session", "Sessão inválida.");
  const want = createHmac("sha256", await secret()).update(body).digest("base64url");
  if (!safeEqual(sig, want)) throw new HttpError(401, "bad_session", "Sessão inválida.");
  let p: { sub: string; v: number; exp: number };
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    throw new HttpError(401, "bad_session", "Sessão inválida.");
  }
  if (!p.exp || p.exp < Date.now()) throw new HttpError(401, "expired", "Sessão expirada. Entre novamente.");
  const [user] = await db.select().from(users).where(eq(users.id, p.sub));
  if (!user || user.tokenVersion !== p.v) throw new HttpError(401, "bad_session", "Sessão expirada. Entre novamente.");
  if (!(await activeLicense(user.email)))
    throw new HttpError(403, "license_inactive", "Licença inativa. Fale com o suporte.");
  return user;
}

export async function readJson(req: Request): Promise<Record<string, any>> {
  try {
    const j = await req.json();
    return j && typeof j === "object" ? j : {};
  } catch {
    throw new HttpError(400, "bad_json", "Requisição inválida.");
  }
}
