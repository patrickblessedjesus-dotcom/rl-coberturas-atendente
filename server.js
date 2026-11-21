// Atendente RL Coberturas — servidor simples (sem dependências)
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.OPENAI_API_KEY || "";
const MODELS = (process.env.OPENAI_MODEL || "gpt-5.4-mini,gpt-5-mini,gpt-4o-mini").split(",").map(s => s.trim()).filter(Boolean);
// Tudo com nota fiscal. Negociação sem nota é com o Rafael, fora do bot.
const PRECOS = {
  locacao: { sp: Number(process.env.PRECO_SP_NOTA || 120), interior: Number(process.env.PRECO_INTERIOR_NOTA || 150) },
  venda: {
    policarbonato: Number(process.env.PRECO_POLICARBONATO || 400),
    lona: Number(process.env.PRECO_LONA || 350),
    plastico: Number(process.env.PRECO_PLASTICO || 300),
  },
};
const NOME_MAT = { policarbonato: "Policarbonato", lona: "Lona", plastico: "Plástico" };
function precoM2(modalidade, regiao, material) {
  if (modalidade === "compra") return PRECOS.venda[material] || null;
  return regiao === "interior" ? PRECOS.locacao.interior : PRECOS.locacao.sp;
}

// ---------- WhatsApp via Z-API ----------
const ZAPI = {
  id: (process.env.ZAPI_INSTANCE_ID || "").trim(),
  token: (process.env.ZAPI_TOKEN || "").trim(),
  client: (process.env.ZAPI_CLIENT_TOKEN || "").trim(),
  secret: (process.env.ZAPI_WEBHOOK_SECRET || "").trim(),
};
const RAFAEL = (process.env.RAFAEL_WHATSAPP || "").replace(/\D/g, ""); // número pessoal do Rafael, recebe o resumo do pedido
const usaZapi = () => !!(ZAPI.id && ZAPI.token);
async function zapi(rota, corpo) {
  const headers = { "Content-Type": "application/json" };
  if (ZAPI.client) headers["Client-Token"] = ZAPI.client;
  try {
    const r = await fetch(`https://api.z-api.io/instances/${encodeURIComponent(ZAPI.id)}/token/${encodeURIComponent(ZAPI.token)}/${rota}`,
      { method: "POST", headers, body: JSON.stringify(corpo), signal: AbortSignal.timeout(20000) });
    if (!r.ok) console.error("Z-API recusou", rota, r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.error("Z-API erro", rota, e.message || e); return false; }
}
const zapiTexto = (phone, message) => zapi("send-text", { phone, message, delayTyping: Math.min(4, 1 + Math.floor(message.length / 120)) });

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
  return `Você é o atendente virtual da *${c.nome}*, empresa de São Paulo de coberturas (tendas, lonas, estruturas de ferro, policarbonato). A empresa trabalha em DOIS caminhos:
- *Aluguel (locação)* para eventos: casamentos, aniversários, festas de empresa etc.
- *Venda (compra)* da cobertura, para o cliente ficar com ela (área de lazer, garagem, comércio, quintal etc.).
Você conversa pelo WhatsApp com clientes que querem orçamento.

Jeito de falar: português do Brasil, simpático, natural e direto, como um atendente humano bom de WhatsApp. Mensagens curtas (1 a 3 frases), no máximo 1 emoji quando fizer sentido. Use *negrito* do WhatsApp com moderação. Faça UMA pergunta por vez. Não diga que é uma IA a menos que perguntem; se perguntarem, diga que é o assistente virtual da ${c.nome} e que o Rafael (dono) acompanha todos os pedidos.

PASSO 1 — descubra se o cliente quer *alugar* pra um evento ou *comprar* a cobertura (se a mensagem já deixar claro, não pergunte).

SE FOR ALUGUEL, colete (pule o que já foi dito):
1. tipo de evento  2. data do evento  3. local (bairro/cidade)
4. tamanho da área (ex: 10x20 m). Se não souber, pergunte nº de convidados e estime ${c.m2PorPessoa} m² por pessoa, arredondando pra cima.
5. se precisa de fechamento lateral  6. (opcional) foto do local
Preço de referência do aluguel por m²: São Paulo capital e Grande SP R$ ${PRECOS.locacao.sp}; interior / fora de SP R$ ${PRECOS.locacao.interior}.

SE FOR COMPRA, colete (pule o que já foi dito):
1. material — são 3 opções: *Policarbonato* (R$ ${PRECOS.venda.policarbonato}/m²), *Lona* (R$ ${PRECOS.venda.lona}/m²) e *Plástico* (R$ ${PRECOS.venda.plastico}/m²). Se o cliente não souber, explique rapidinho e ajude a escolher; se ele quiser comparar, pode calcular mais de um.
2. onde vai ser instalada (bairro/cidade e que tipo de lugar)
3. tamanho da área (ex: 5x8 m)
4. pra quando precisa  5. (opcional) foto do local

PREÇO — regras importantes:
- Use SEMPRE a ferramenta calcular_orcamento para dar valor. Não faça a conta de cabeça.
- Todo valor é *estimativa*. Diga que o valor varia com a distância e com as medidas reais, e que o *valor final oficial sai só depois da visita técnica*.
- Fale um único valor (os preços já são com nota fiscal). NÃO ofereça opção sem nota nem fale de desconto. Se o cliente pedir sem nota ou desconto, diga que isso o Rafael conversa direto com ele.
- Não invente outros preços, taxas, frete ou prazos; o que você não souber, diga que o Rafael confirma na visita.

VISITA TÉCNICA — depois do orçamento, ofereça a visita técnica (medição), que é gratuita. Horários de referência: ${c.horarios}. Peça ao cliente 1 a 3 opções de dia e período que funcionam pra ele. NÃO confirme o horário como certo: diga que é um *pré-agendamento* e que o Rafael confere a agenda dele e confirma (ou sugere outro horário) por aqui. Pegue também o nome do cliente.

Quando tiver tudo, chame registrar_pedido UMA vez e avise o cliente que o pedido foi passado pro Rafael, que vai confirmar o horário da visita por aqui.

Se o cliente fugir do assunto, responda com educação e traga de volta pro orçamento. Hoje é ${hoje}.`;
}

const tools = [
  { type: "function", function: { name: "calcular_orcamento", description: "Calcula o valor ESTIMADO (com nota) a partir da modalidade, área e região (aluguel) ou material (compra). Use sempre que for informar preço.",
    parameters: { type: "object", properties: {
      modalidade: { type: "string", enum: ["aluguel", "compra"] },
      area_m2: { type: "number", description: "Área total em m²" },
      regiao: { type: "string", enum: ["sp", "interior"], description: "Só aluguel. sp = capital e Grande SP; interior = interior ou fora de SP" },
      material: { type: "string", enum: ["policarbonato", "lona", "plastico"], description: "Só compra" } },
      required: ["modalidade", "area_m2"] } } },
  { type: "function", function: { name: "registrar_pedido", description: "Envia o pedido completo pro Rafael. Chame uma única vez, quando já tiver nome, modalidade, local, tamanho e as preferências de horário da visita.",
    parameters: { type: "object", properties: {
      nome: { type: "string" }, modalidade: { type: "string", enum: ["aluguel", "compra"] },
      evento: { type: "string", description: "Aluguel: tipo de evento. Compra: uso da cobertura" },
      data: { type: "string", description: "Aluguel: data do evento. Compra: pra quando precisa" },
      local: { type: "string" }, tamanho: { type: "string", description: "medida ou área, ex: 10x20 m (200 m²)" }, area_m2: { type: "number" },
      regiao: { type: "string", enum: ["sp", "interior"] }, material: { type: "string", enum: ["policarbonato", "lona", "plastico"] },
      fechamento_lateral: { type: "string" },
      visita: { type: "string", description: "opções de dia/período que o cliente pode, pra o Rafael aprovar" },
      observacoes: { type: "string" } },
      required: ["nome", "modalidade", "local", "tamanho", "visita"] } } }
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
        const mod = args.modalidade === "compra" ? "compra" : "aluguel";
        const a = Math.ceil(Number(args.area_m2) || 0), reg = args.regiao === "interior" ? "interior" : "sp";
        const p = precoM2(mod === "compra" ? "compra" : "locacao", reg, args.material);
        if (!p) result = { erro: "Na compra, falta escolher o material: policarbonato, lona ou plástico." };
        else {
          out.orcamento = { modalidade: mod, area: a, regiao: mod === "aluguel" ? reg : undefined, material: mod === "compra" ? args.material : undefined, precoM2: p, valor: a * p };
          result = { modalidade: mod, area_m2: a, ...(mod === "aluguel" ? { regiao: reg } : { material: NOME_MAT[args.material] }),
            preco_m2: brl(p), valor_estimado: brl(a * p),
            lembrete: "Estimativa com nota. Varia com distância e medidas; valor final oficial só após a visita técnica." };
        }
      } else if (tc.function.name === "registrar_pedido") {
        const a = Math.ceil(Number(args.area_m2) || 0);
        const p = precoM2(args.modalidade === "compra" ? "compra" : "locacao", args.regiao, args.material);
        if (a && p) { args.area = a; args.precoM2 = p; args.valor = a * p; }
        out.pedido = args; result = { ok: true };
      } else result = { erro: "ferramenta desconhecida" };
      msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  if (!out.reply) out.reply = "Anotado! Mais alguma informação sobre o evento?";
  return out;
}


// ---------- conversas do WhatsApp (memória do servidor) ----------
const conversas = new Map(); // phone -> { hist, temFoto, jaRegistrado, visto, fila }
const vistos = new Set();
function conversa(phone) {
  let c = conversas.get(phone);
  if (!c) { c = { hist: [], temFoto: false, jaRegistrado: false, fila: Promise.resolve() }; conversas.set(phone, c); }
  c.visto = Date.now(); return c;
}
setInterval(() => { const lim = Date.now() - 3 * 24 * 3600 * 1000; for (const [k, v] of conversas) if (v.visto < lim) conversas.delete(k); if (vistos.size > 5000) vistos.clear(); }, 3600 * 1000);

const NOMES = { policarbonato: "Policarbonato", lona: "Lona", plastico: "Plástico" };
function resumoPedido(p, phone) {
  const compra = p.modalidade === "compra";
  const l = [`🆕 *Novo pedido — ${compra ? "🛒 COMPRA" : "📅 ALUGUEL"}*`, ""];
  const add = (k, v) => { if (v) l.push(`*${k}:* ${v}`); };
  add("Cliente", p.nome); add("WhatsApp", "+" + phone);
  add(compra ? "Uso" : "Evento", p.evento); add(compra ? "Prazo" : "Data", p.data); add("Local", p.local);
  add("Tamanho", p.tamanho); if (compra) add("Material", NOMES[p.material] || p.material); else add("Região", p.regiao === "interior" ? "Interior" : p.regiao ? "São Paulo" : "");
  add("Fech. lateral", p.fechamento_lateral); add("Obs.", p.observacoes);
  if (p.valor) { l.push(""); l.push(`💰 *Estimativa c/ nota:* ${brl(p.valor)} (${p.area} m² × ${brl(p.precoM2)})`); }
  l.push(""); l.push(`📆 *Visita — cliente pode:* ${p.visita || "-"}`);
  l.push("⏳ Aguardando você aprovar o horário. Responde o cliente direto no número da empresa.");
  return l.join("\n");
}

async function atenderWhatsApp(ev) {
  const phone = String(ev.phone || "").replace(/\D/g, "");
  if (!phone || ev.fromMe || ev.isGroup || ev.isNewsletter || ev.broadcast || String(ev.phone).includes("@")) return;
  if (ev.messageId) { if (vistos.has(ev.messageId)) return; vistos.add(ev.messageId); }
  const c = conversa(phone);
  let texto = ev.text?.message || ev.buttonsResponseMessage?.message || ev.listResponseMessage?.title || "";
  if (ev.image) { c.temFoto = true; texto = "[cliente enviou uma foto do local]" + (ev.image.caption ? " " + ev.image.caption : ""); }
  else if (ev.audio) { c.fila = c.fila.then(() => zapiTexto(phone, "Opa! Por aqui eu não consigo ouvir áudio 😅 Me manda por escrito, rapidinho?")); return; }
  else if (!texto) return;
  c.fila = c.fila.then(async () => {
    c.hist.push({ role: "user", content: String(texto).slice(0, 1500) });
    try {
      const r = await chat({ messages: c.hist, temFoto: c.temFoto, jaRegistrado: c.jaRegistrado });
      c.hist.push({ role: "assistant", content: r.reply }); c.hist = c.hist.slice(-30);
      await zapiTexto(phone, r.reply);
      if (r.pedido && !c.jaRegistrado) {
        c.jaRegistrado = true;
        console.log("Pedido registrado", phone, r.pedido.modalidade);
        if (RAFAEL) await zapiTexto(RAFAEL, resumoPedido(r.pedido, phone));
      }
    } catch (e) {
      console.error("Erro no atendimento", e.message || e); c.hist.pop();
      await zapiTexto(phone, "Opa, deu uma instabilidade aqui. Pode mandar de novo?");
    }
  });
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
  if (req.method === "POST" && usaZapi() && req.url.split("?")[0] === "/zapi/" + ZAPI.secret && ZAPI.secret) {
    let body = "";
    req.on("data", d => { body += d; if (body.length > 2000000) req.destroy(); });
    req.on("end", () => {
      res.end("ok");
      let ev; try { ev = JSON.parse(body || "{}"); } catch { return; }
      if (!KEY) return console.error("Mensagem recebida mas falta OPENAI_API_KEY");
      atenderWhatsApp(ev).catch(e => console.error(e));
    });
    return;
  }
  if (req.url === "/health") return res.end(`ok · IA: ${KEY ? "ligada" : "desligada"} · WhatsApp: ${usaZapi() ? "Z-API ok" : "desligado"} · resumo pro Rafael: ${RAFAEL ? "sim" : "não"}`);
  const p = req.url.split("?")[0];
  if (p !== "/" && p !== "/index.html") { res.statusCode = 404; return res.end("não encontrado"); }
  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    if (err) { res.statusCode = 500; return res.end("erro"); }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(data);
  });
}).listen(PORT, () => console.log(`RL Coberturas no ar na porta ${PORT} · IA: ${KEY ? "ligada" : "DESLIGADA (falta OPENAI_API_KEY)"} · WhatsApp: ${usaZapi() ? "Z-API ok" : "desligado"}`));
