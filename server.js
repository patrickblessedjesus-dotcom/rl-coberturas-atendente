// Atendente RL Coberturas — servidor simples (sem dependências)
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.OPENAI_API_KEY || "";
const MODELS = (process.env.OPENAI_MODEL || "gpt-5.4-mini,gpt-5-mini,gpt-4o-mini").split(",").map(s => s.trim()).filter(Boolean);
const PRECOS = {
  sp: Number(process.env.PRECO_SP || 100), spNota: Number(process.env.PRECO_SP_NOTA || 120),
  int: Number(process.env.PRECO_INTERIOR || 130), intNota: Number(process.env.PRECO_INTERIOR_NOTA || 150),
};
function tabela(regiao) { return regiao === "interior" ? { sem: PRECOS.int, com: PRECOS.intNota } : { sem: PRECOS.sp, com: PRECOS.spNota }; }

const brl = v => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

// limite simples por IP (evita gastar a chave à toa)
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 60;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}

function instrucoes(c) {
  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  return `Você é o atendente virtual da *${c.nome}*, empresa de São Paulo que monta coberturas para eventos (tendas, lonas, estruturas de ferro) para casamentos, aniversários, festas de empresa e eventos em geral. Você conversa pelo WhatsApp com clientes que querem orçamento.

Jeito de falar: português do Brasil, simpático, natural e direto, como um atendente humano bom de WhatsApp. Mensagens curtas (1 a 3 frases), no máximo 1 emoji quando fizer sentido. Use *negrito* do WhatsApp com moderação. Faça UMA pergunta por vez. Não diga que é uma IA a menos que perguntem; se perguntarem, diga que é o assistente virtual da ${c.nome} e que o Rafael (dono) acompanha todos os pedidos.

Colete de forma natural (pule o que o cliente já respondeu):
1. tipo de evento
2. data do evento
3. local (bairro/cidade)
4. tamanho da área a cobrir (ex: 10x20 m). Se o cliente não souber, pergunte o número de convidados e estime ${c.m2PorPessoa} m² por pessoa, arredondando para cima.
5. se precisa de fechamento lateral
6. (opcional) foto do local — o cliente pode mandar pelo ícone de câmera

Tabela de preço por m²:
- São Paulo (capital e Grande SP): R$ ${PRECOS.sp}/m² sem nota fiscal, R$ ${PRECOS.spNota}/m² com nota fiscal
- Interior / fora de SP: R$ ${PRECOS.int}/m² sem nota fiscal, R$ ${PRECOS.intNota}/m² com nota fiscal
Descubra a região pelo local do evento (se não der pra saber, pergunte). Quando tiver a área e a região, use a ferramenta calcular_orcamento e passe o valor ESTIMADO mostrando as duas opções (sem nota e com nota fiscal); depois pergunte se o cliente vai precisar de nota fiscal. Deixe claro que o preço final sai depois da visita técnica de medição, que é gratuita. Não invente outros preços, taxas ou descontos; se perguntarem algo que você não sabe (frete, montagem fora de SP, outros itens), diga que o Rafael confirma na visita.

Depois do orçamento, ofereça agendar a visita de medição (horários: ${c.horarios}). Pegue o dia/horário preferido e o nome do cliente. Quando tiver tudo, chame registrar_pedido UMA vez e confirme ao cliente que o pedido foi passado ao responsável, que vai confirmar a visita por aqui.

Se o cliente fugir do assunto, responda com educação e traga de volta para o orçamento. Hoje é ${hoje}.`;
}

const tools = [
  { type: "function", function: { name: "calcular_orcamento", description: "Calcula o valor estimado da cobertura (sem nota e com nota fiscal) a partir da área em m² e da região. Use sempre que for informar preço.",
    parameters: { type: "object", properties: { area_m2: { type: "number", description: "Área total em m²" },
      regiao: { type: "string", enum: ["sp", "interior"], description: "sp = capital e Grande SP; interior = interior ou fora de SP" } }, required: ["area_m2", "regiao"] } } },
  { type: "function", function: { name: "registrar_pedido", description: "Envia o pedido completo para o dono. Chame uma única vez, quando já tiver nome, evento, data, local, tamanho e horário da visita.",
    parameters: { type: "object", properties: {
      nome: { type: "string" }, evento: { type: "string" }, data: { type: "string" }, local: { type: "string" },
      tamanho: { type: "string", description: "medida ou área, ex: 30x30 m (900 m²)" }, area_m2: { type: "number" },
      fechamento_lateral: { type: "string" }, regiao: { type: "string", enum: ["sp", "interior"] },
      nota_fiscal: { type: "string", description: "sim, não ou não informado" }, visita: { type: "string" }, observacoes: { type: "string" } },
      required: ["nome", "evento", "data", "local", "tamanho", "visita"] } } }
];

async function openai(body) {
  let lastErr;
  for (const model of MODELS) {
    const b = { ...body, model };
    if (/^(gpt-5|o\d)/.test(model)) b.reasoning_effort = "low";
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(b)
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    lastErr = new Error(`${model}: ${r.status} ${j.error && j.error.message}`);
    console.error(lastErr.message);
    if (r.status === 401 || r.status === 429) break; // chave errada / sem crédito: não adianta trocar de modelo
  }
  throw lastErr;
}

async function chat(req) {
  const c = {
    nome: String(req.config?.nome || "RL Coberturas").slice(0, 60),
    m2PorPessoa: Number(req.config?.m2PorPessoa) > 0 ? Number(req.config.m2PorPessoa) : 1.5,
    horarios: String(req.config?.horarios || "segunda a sábado, das 8h às 17h").slice(0, 120),
  };
  const hist = (Array.isArray(req.messages) ? req.messages : []).slice(-30)
    .filter(m => m && (m.role === "user" || m.role === "assistant"))
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 1500) }));
  const msgs = [{ role: "system", content: instrucoes(c) }, ...hist];
  if (req.temFoto) msgs.push({ role: "system", content: "Obs: o cliente já mandou uma foto do local." });
  if (req.jaRegistrado) msgs.push({ role: "system", content: "O pedido deste cliente JÁ foi registrado. Não chame registrar_pedido de novo." });

  const out = { reply: "", orcamento: null, pedido: null };
  for (let i = 0; i < 4; i++) {
    const j = await openai({ messages: msgs, tools });
    const m = j.choices[0].message;
    msgs.push(m);
    if (!m.tool_calls || !m.tool_calls.length) { out.reply = (m.content || "").trim(); break; }
    for (const tc of m.tool_calls) {
      let args = {}; try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      let result;
      if (tc.function.name === "calcular_orcamento") {
        const a = Math.ceil(Number(args.area_m2) || 0), t = tabela(args.regiao);
        out.orcamento = { area: a, regiao: args.regiao === "interior" ? "interior" : "sp", semNota: a * t.sem, comNota: a * t.com };
        result = { area_m2: a, regiao: out.orcamento.regiao, preco_m2_sem_nota: t.sem, preco_m2_com_nota: t.com,
          valor_sem_nota: brl(a * t.sem), valor_com_nota: brl(a * t.com) };
      } else if (tc.function.name === "registrar_pedido") {
        if (args.area_m2) { const a = Math.ceil(args.area_m2), t = tabela(args.regiao); args.area = a; args.semNota = a * t.sem; args.comNota = a * t.com; }
        out.pedido = args; result = { ok: true };
      } else result = { erro: "ferramenta desconhecida" };
      msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  if (!out.reply) out.reply = "Anotado! Mais alguma informação sobre o evento?";
  return out;
}


http.createServer(async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", d => { body += d; if (body.length > 200000) req.destroy(); });
    req.on("end", async () => {
      res.setHeader("Content-Type", "application/json");
      if (!KEY) return res.end(JSON.stringify({ fallback: true, precos: PRECOS }));
      if (limited(ip)) { res.statusCode = 429; return res.end(JSON.stringify({ erro: "limite" })); }
      try { res.end(JSON.stringify(await chat(JSON.parse(body || "{}")))); }
      catch (e) { console.error(e); res.statusCode = 500; res.end(JSON.stringify({ erro: "falha" })); }
    });
    return;
  }
  if (req.url === "/health") return res.end("ok");
  const p = req.url.split("?")[0];
  if (p !== "/" && p !== "/index.html") { res.statusCode = 404; return res.end("não encontrado"); }
  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    if (err) { res.statusCode = 500; return res.end("erro"); }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(data);
  });
}).listen(PORT, () => console.log(`RL Coberturas no ar na porta ${PORT} · IA: ${KEY ? "ligada" : "DESLIGADA (falta OPENAI_API_KEY)"}`));
