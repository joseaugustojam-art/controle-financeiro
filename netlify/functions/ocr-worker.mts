import type { Config } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { ocrJobs } from "../../db/schema.js";
import { TOOL, buildPrompt, normalizeResult, type OcrMeta } from "../../lib/ocr.js";

async function fail(id: string, code: string, message: string) {
  await db.update(ocrJobs).set({ status: "error", code, message }).where(eq(ocrJobs.id, id));
}

export default async (req: Request) => {
  let id = "";
  try { id = String((await req.json()).id || ""); } catch { return; }
  const claimed = await db.update(ocrJobs).set({ status: "running" })
    .where(and(eq(ocrJobs.id, id), eq(ocrJobs.status, "pending"))).returning();
  if (!claimed.length) return;
  const job = claimed[0];
  const store = getStore("ocr-images");
  try {
    const saved = (await store.get(id, { type: "json" })) as { images?: string[]; texts?: string[] } | string[] | null;
    const images = (Array.isArray(saved) ? saved : saved?.images) || [];
    const texts = (Array.isArray(saved) ? [] : saved?.texts) || [];
    if (!images.length) return fail(id, "image_rejected", "Imagem não encontrada.");
    const meta = (job.meta || {}) as OcrMeta;
    const cats = Array.isArray(meta.cats) && meta.cats.length ? meta.cats.map(String) : ["Outros"];

    const client = new Anthropic();
    // Modelo configurável (ANTHROPIC_MODEL); se o serviço não aceitar o modelo, tenta alternativas.
    const MODELS = [...new Set([process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", "claude-sonnet-4-5"])];
    let msg: any;
    for (let i = 0; i < MODELS.length; i++) {
      try {
        msg = await client.messages.create({
          model: MODELS[i],
          max_tokens: 16000,
          temperature: 0,
          tools: [TOOL],
          tool_choice: { type: "tool", name: TOOL.name },
          messages: [{
            role: "user",
            content: [
              ...images.map((data) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data } })),
              { type: "text" as const, text: buildPrompt(meta, texts, cats) },
            ],
          }],
        });
        break;
      } catch (err: any) {
        const d = String(err?.error?.error?.message || err?.message || "");
        if (i < MODELS.length - 1 && err?.status === 400 && /model/i.test(d)) continue;
        throw err;
      }
    }
    const tool = msg.content.find((c: any) => c.type === "tool_use");
    if (!tool) return fail(id, "ocr_error", "Não foi possível ler a fatura.");
    await db.update(ocrJobs).set({ status: "done", result: normalizeResult(tool.input, cats) }).where(eq(ocrJobs.id, id));
  } catch (e: any) {
    console.error(e);
    const status = e?.status;
    if (status === 429) return fail(id, "rate_limited", "Muitas leituras seguidas. Aguarde um minuto.");
    if (status === 400) {
      const detail = String(e?.error?.error?.message || e?.message || "").replace(/\s+/g, " ").slice(0, 180);
      return fail(id, "ocr_400", `Leitura recusada pelo serviço de IA: ${detail}`);
    }
    return fail(id, "ocr_error", "Falha na leitura da fatura.");
  } finally {
    await store.delete(id).catch(() => {});
  }
};

export const config: Config = { background: true };
