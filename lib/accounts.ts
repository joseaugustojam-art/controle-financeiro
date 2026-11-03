import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { licenses, users } from "../db/schema.js";
import { hashPassword } from "./auth.js";

// Cria a conta ou redefine a senha (invalida sessões antigas).
export async function upsertUser(email: string, password: string) {
  const passHash = await hashPassword(password);
  const [u] = await db
    .insert(users)
    .values({ id: randomUUID(), email, passHash })
    .onConflictDoUpdate({
      target: users.email,
      set: { passHash, tokenVersion: sql`${users.tokenVersion} + 1` },
    })
    .returning();
  return u;
}

export async function setLicense(email: string, data: { code?: string; status: string; source: string; event?: string }) {
  const values = {
    email,
    code: data.code || "",
    status: data.status,
    source: data.source,
    lastEvent: data.event ?? null,
    updatedAt: new Date(),
  };
  const set: Record<string, unknown> = { status: values.status, source: values.source, lastEvent: values.lastEvent, updatedAt: values.updatedAt };
  if (data.code) set.code = data.code;
  await db.insert(licenses).values(values).onConflictDoUpdate({ target: licenses.email, set });
  const [lic] = await db.select().from(licenses).where(eq(licenses.email, email));
  return lic;
}
