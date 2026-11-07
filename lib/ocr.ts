// Leitura de fatura: instruções para a IA (transcrição fiel) e limpeza do resultado.
// Funções puras, sem dependências, para facilitar os testes.

export const TOOL = {
  name: "registrar_fatura",
  description: "Registra, linha por linha e exatamente como impresso, os lançamentos da fatura do cartão.",
  input_schema: {
    type: "object" as const,
    properties: {
      total: { type: "number", description: "Valor TOTAL DA FATURA exatamente como impresso, em reais (use 0 se não aparecer)." },
      compras: {
        type: "array",
        description: "TODAS as linhas de lançamento da fatura, na ordem em que aparecem.",
        items: {
          type: "object",
          properties: {
            linha_original: { type: "string", description: "A linha do lançamento copiada literalmente (data, descrição, parcela e valor), sem alterar nada." },
            data: { type: "string", description: "Data do lançamento (dia e mês exatamente como impressos) no formato AAAA-MM-DD." },
            desc: { type: "string", description: "Descrição/estabelecimento copiado LETRA POR LETRA como impresso (mesmas maiúsculas, acentos, números e símbolos), sem o trecho da parcela." },
            tipo: { type: "string", enum: ["compra", "encargo", "estorno", "pagamento"], description: "compra = compra/serviço; encargo = juros, multa, IOF, anuidade, seguro, tarifa; estorno = crédito/estorno/devolução; pagamento = pagamento da fatura anterior ou saldo anterior." },
            cat: { type: "string", description: "Uma das categorias informadas." },
            valor: { type: "number", description: "Valor da linha em reais, exatamente como impresso (negativo para estorno/crédito)." },
            parc: { type: "integer", description: "Total de parcelas (1 se à vista)." },
            parcAt: { type: "integer", description: "Número da parcela atual (1 se à vista)." },
          },
          required: ["linha_original", "data", "desc", "tipo", "cat", "valor", "parc", "parcAt"],
        },
      },
      observacoes: { type: "string", description: "Avisos curtos: linhas ilegíveis, valores duvidosos, páginas cortadas. Vazio se estiver tudo claro." },
    },
    required: ["total", "compras"],
  },
};

export type OcrMeta = { mes?: string; cats?: string[]; pdf?: boolean; slices?: boolean; semImagens?: boolean };

export function buildPrompt(meta: OcrMeta, texts: string[], cats: string[]) {
  const tem = texts.some((t) => t && t.trim());
  const origem = meta.semImagens ? "o texto digital, página a página, de um PDF (sem imagens)" : meta.pdf ? "páginas de um PDF" : meta.slices ? "fatias sobrepostas (de cima para baixo) de UMA foto" : "a foto";
  const partes = [
    `Você é um transcritor de faturas de cartão de crédito brasileiras. Você recebeu ${origem} de uma fatura${meta.mes ? ` (mês de referência ${meta.mes})` : ""}.`,
    `Sua tarefa é TRANSCREVER com fidelidade total cada linha de lançamento, chamando a ferramenta registrar_fatura.`,
    ``,
    `REGRAS DE FIDELIDADE (as mais importantes):`,
    `1. Copie descrições, datas e valores EXATAMENTE como estão impressos. Não corrija, não traduza, não abrevie, não complete, não reescreva em outro formato e não troque maiúsculas por minúsculas.`,
    `2. Valores: copie dígito por dígito, inclusive os centavos. Nunca arredonde nem estime. Na dúvida entre dois dígitos, releia a imagem com atenção e, se ainda houver dúvida, registre a melhor leitura e avise em "observacoes".`,
    `3. Datas: mantenha o dia e o mês impressos. Se a fatura não mostrar o ano, deduza-o pelo período/vencimento da fatura (compras de dezembro numa fatura de janeiro são do ano anterior).`,
    `4. Inclua TODAS as linhas de todas as páginas: compras, serviços, assinaturas, parcelas, juros, multa, IOF, anuidade, seguros, tarifas e estornos. Não pule nem junte linhas. Não invente linhas.`,
    `5. Parcelas aparecem como "PARC 03/10", "03/10", "3 de 10" ou "(3/10)": parcAt = 3 e parc = 10, e "valor" é o valor da parcela. Retire esse trecho da descrição (ele fica em linha_original). Sem parcela: parc = 1 e parcAt = 1.`,
    `6. Compras em moeda estrangeira: use o valor em reais (R$) cobrado na fatura.`,
    `7. Pagamentos da fatura anterior, "saldo anterior" e totais NÃO são compras: use tipo "pagamento" (serão descartados). Estornos e créditos: tipo "estorno" com valor negativo.`,
    `8. "total": o valor total a pagar da fatura, como impresso (0 se não aparecer). Use "observacoes" para qualquer ponto duvidoso.`,
    meta.slices ? `9. As fatias se sobrepõem um pouco: se a mesma linha aparecer em duas fatias, registre-a UMA só vez.` : ``,
    ``,
    `Categorias permitidas (use exatamente uma por linha): ${cats.join(", ")}. Se nenhuma servir, use "Outros".`,
  ];
  if (tem) {
    if (meta.semImagens) partes.push(``, `Não há imagens: transcreva a partir do texto abaixo, que mantém as linhas do PDF (colunas separadas por 3 espaços).`);
    partes.push(``, `TEXTO EXTRAÍDO DO PDF: abaixo está o texto digital do próprio PDF. Ele é a FONTE PRINCIPAL dos caracteres: copie descrições e valores dele (sem erros de leitura). Use as imagens apenas para entender o layout (colunas, parcelas, o que é pagamento ou estorno). Se o texto e a imagem divergirem, siga o texto.`);
    texts.forEach((t, i) => { if (t && t.trim()) partes.push(``, `--- página ${i + 1} ---`, t); });
  }
  return partes.filter((x) => x !== undefined).join("\n");
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function normalizeResult(input: any, cats: string[]) {
  const itens: any[] = Array.isArray(input?.compras) ? input.compras : [];
  const compras = [];
  for (const i of itens) {
    const tipo = String(i?.tipo || "compra");
    if (tipo === "pagamento") continue;
    const desc = String(i?.desc ?? "").replace(/\s+/g, " ").trim();
    let valor = Number(i?.valor);
    const data = String(i?.data ?? "");
    if (!desc || !Number.isFinite(valor) || !/^\d{4}-\d{2}-\d{2}$/.test(data)) continue;
    if (tipo === "estorno" && valor > 0) valor = -valor;
    const parc = Math.max(1, Math.min(60, Math.trunc(Number(i?.parc)) || 1));
    const parcAt = Math.max(1, Math.min(parc, Math.trunc(Number(i?.parcAt)) || 1));
    const cat = cats.includes(i?.cat) ? i.cat : "Outros";
    compras.push({ data, desc, cat, valor: r2(valor), parc, parcAt, tipo });
  }
  const total = Number(input?.total);
  const totalOk = Number.isFinite(total) && total > 0 ? r2(total) : null;
  const soma = r2(compras.reduce((s, c) => s + c.valor, 0));
  return {
    total: totalOk,
    compras,
    observacoes: String(input?.observacoes ?? "").slice(0, 600),
    soma,
    diferenca: totalOk === null ? null : r2(totalOk - soma),
  };
}
