import type { Config } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { ocrJobs } from "../../db/schema.js";

const TOOL = {
  name: "registrar_fatura",
  description: "Registra as compras lidas da fatura do cartão.",
  input_schema: {
    type: "object" as const,
    properties: {
      total: { type: "number", description: "Valor total da fatura em reais (0 se não aparecer)." },
      compras: {
        type: "array",
        items: {
          type: "object",
          properties: {
            data: { type: "string", description: "Data da compra no formato AAAA-MM-DD." },
            desc: { type: "string", description: "Descrição/estabelecimento." },
            cat: { type: "string", description: "Uma das categorias informadas." },
            valor: { type: "number", description: "Valor da parcela desta fatura, em reais (positivo)." },
            parc: { type: "integer", description: "Total de parcelas (1 se à vista)." },
            parcAt: { type: "integer", description: "Número da parcela atual (1 se à vista)." },
          },
          required: ["data", "desc", "cat", "valor", "parc", "parcAt"],
        },
      },
    },
    required: ["total", "compras"],
  },
};

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
    const images = ((await store.get(id, { type: "json" })) as string[] | null) || [];
    if (!images.length) return fail(id, "image_rejected", "Imagem não encontrada.");
    const meta = (job.meta || {}) as { mes?: string; cats?: string[] };
    const cats = Array.isArray(meta.cats) && meta.cats.length ? meta.cats.map(String) : ["Outros"];

    const client = new Anthropic();
    // Tenta o modelo configurado e, se o serviço disser que o modelo não é aceito, um modelo alternativo.
    const MODELS = [process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", "claude-sonnet-4-5"];
    let msg: any;
    for (let i = 0; i < MODELS.length; i++) {
      try {
        msg = await client.messages.create({
      model: MODELS[i],
      max_tokens: 8000,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [{
        role: "user",
        content: [
          ...images.map((data) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data } })),
          {
            type: "text" as const,
            text: `Estas imagens são páginas de uma fatura de cartão de crédito brasileira${meta.mes ? ` (mês de referência ${meta.mes})` : ""}.
Liste todas as compras/lançamentos de débito. Ignore pagamentos, créditos, estornos, saldo anterior e encargos já totalizados.
Para compras parceladas ("03/10"), parcAt=3 e parc=10, e valor é o da parcela. Datas sem ano: use o ano mais provável pela fatura.
Categorias permitidas (use exatamente uma): ${cats.join(", ")}. Se nenhuma servir, use "Outros".`,
          },
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
    if (!tool || tool.type !== "tool_use") return fail(id, "ocr_error", "Não foi possível ler a fatura.");
    await db.update(ocrJobs).set({ status: "done", result: tool.input }).where(eq(ocrJobs.id, id));
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
