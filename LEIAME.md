# Controle Financeiro — versão para vender (Hotmart + Netlify)

Acesso liberado automaticamente quando a compra é aprovada na Hotmart, e derrubado em reembolso/chargeback.

## Como funciona
1. O cliente compra na Hotmart. A Hotmart avisa o seu site (`/api/hotmart`, webhook v2) e a licença do e-mail é criada.
2. O cliente abre o site > **Primeiro acesso** e informa: **e-mail da compra + código da transação (HP...) + uma senha**.
   O código da transação aparece no recibo/e-mail da compra da Hotmart. Ele prova que a pessoa é a compradora (sem isso,
   alguém que soubesse o e-mail poderia criar a conta antes).
3. Depois, o cliente entra com e-mail e senha. Os dados de cada cliente ficam separados e protegidos por login no servidor.
4. Reembolso, chargeback ou cancelamento da compra: o acesso é bloqueado na hora (inclusive quem já está logado).
   Esquecer a senha: repetir o "Primeiro acesso" (e-mail + código) e criar uma nova.

## Instalação (≈15 min)
1. Crie um repositório no GitHub com esta pasta e, na Netlify: **Add new site > Import from Git**
   (publish `public`, functions `netlify/functions` — já estão no `netlify.toml`). Não use "arrastar pasta": as funções precisam do build.
2. Na Netlify: **Site configuration > Environment variables** — crie:
   | Variável | Valor |
   |---|---|
   | `ADMIN_KEY` | (opcional) chave para usar `/api/admin` pelo terminal (`curl`); a página `/admin` não precisa dela |
   | `HOTMART_HOTTOK` | o *hottok* da sua conta Hotmart (Ferramentas > Webhook > aba Autenticação) |
   | `JWT_SECRET` | (opcional) texto aleatório longo; se não existir, o sistema gera um sozinho |
   | `HOTMART_PRODUCT_ID` | (opcional) ID do produto, se você tiver mais de um na conta |
   | `OCR_LIMIT` | (opcional) leituras de fatura por cliente/mês; padrão 40 |
   | `ANTHROPIC_MODEL` | (opcional) modelo usado na leitura; padrão `claude-sonnet-5-5` |
   Depois faça um novo deploy. A leitura de faturas usa o AI Gateway da Netlify (cobrado nos créditos da Netlify), sem precisar de chave da Anthropic.
3. Na Hotmart: **Ferramentas > Webhook > Cadastrar webhook**: URL `https://SEU-SITE.netlify.app/api/hotmart`,
   **versão 2.0.0**, selecione o produto e os eventos: *Compra aprovada, Compra completa, Compra cancelada,
   Reembolso (PURCHASE_REFUNDED), Chargeback* (e *Cancelamento de assinatura*, se vender por assinatura).
4. Na página/mensagem de entrega do produto, avise o cliente: *"Acesse https://SEU-SITE.netlify.app > Primeiro acesso e use o e-mail da compra e o código da transação (HP...)."*

## Criar o seu acesso (admin)
1. Depois do primeiro deploy, abra `https://SEU-SITE.netlify.app/admin`.
2. Na primeira visita aparece **Criar a conta de administrador**: escolha e-mail e senha. Faça isso logo após publicar, porque só a primeira conta criada vira administradora.
3. Nas próximas vezes, entre em `/admin` com esse e-mail e senha para liberar, revogar e criar contas de clientes. A mesma conta também usa o app normalmente.

## Testar sem comprar
Pela página `/admin` (Liberar acesso para um cliente) ou via terminal. Libere um e-mail manualmente (código `TESTE1`):
```
curl -X POST https://SEU-SITE.netlify.app/api/admin -H "x-admin-key: SUA_ADMIN_KEY" -H "content-type: application/json" -d '{"email":"voce@email.com","code":"TESTE1"}'
```
Depois use Primeiro acesso com esse e-mail e o código `TESTE1`. Para revogar: acrescente `"action":"revoke"`.

## Pontos importantes
- **Proteção contra cópia:** o código do site é público no navegador (como todo site), mas sem licença ninguém acessa dados nem a leitura de fatura:
  tudo isso fica atrás do login no servidor. Copiar o site não dá acesso ao serviço.
- **Custo da leitura de fatura:** cada leitura consome créditos da Netlify (AI Gateway). O limite mensal por cliente (`OCR_LIMIT`) protege contra abuso.
- **Dados:** ficam no Netlify Database (Postgres), separados por cliente. Em duas telas abertas ao mesmo tempo vale a última gravação.
  Faça os testes com a Hotmart em modo teste antes de abrir as vendas e confira os campos do webhook na documentação da Hotmart.
- **Open Finance:** não incluído (exige agregador contratado).
- **Aspectos legais:** inclua Termos de Uso e Política de Privacidade (LGPD) no site, pois você guardará dados financeiros de clientes.
