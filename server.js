// Atendente RL Coberturas — site de demo + WhatsApp (Z-API). Sem dependências.
const http = require("http");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.OPENAI_API_KEY || "";
const MODELS = (process.env.OPENAI_MODEL || "gpt-5-mini,gpt-4o-mini").split(",").map(s => s.trim()).filter(Boolean);

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
const brl = v => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

// ---------- WhatsApp via Z-API ----------
const ZAPI = {
  id: (process.env.ZAPI_INSTANCE_ID || "").trim(),
  token: (process.env.ZAPI_TOKEN || "").trim(),
  client: (process.env.ZAPI_CLIENT_TOKEN || "").trim(),
  secret: (process.env.ZAPI_WEBHOOK_SECRET || "").trim(),
};
const RAFAEL = (process.env.RAFAEL_WHATSAPP || "").replace(/\D/g, ""); // número pessoal do Rafael: recebe os pedidos e aprova
const ESPERA_MS = Number(process.env.ESPERA_SEGUNDOS || 10) * 1000;   // junta mensagens seguidas do cliente antes de responder
const usaZapi = () => !!(ZAPI.id && ZAPI.token);
const enviadosPeloBot = new Set(); // ids das mensagens que o próprio bot mandou (pra não confundir com o Rafael digitando)

async function zapi(rota, corpo) {
  const headers = { "Content-Type": "application/json" };
  if (ZAPI.client) headers["Client-Token"] = ZAPI.client;
  try {
    const r = await fetch(`https://api.z-api.io/instances/${encodeURIComponent(ZAPI.id)}/token/${encodeURIComponent(ZAPI.token)}/${rota}`,
      { method: "POST", headers, body: JSON.stringify(corpo), signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    if (!r.ok) { console.error("Z-API recusou", rota, r.status, t.slice(0, 300)); return null; }
    try { const j = JSON.parse(t); for (const k of ["messageId", "zaapId", "id"]) if (j[k]) enviadosPeloBot.add(String(j[k])); return j; } catch { return {}; }
  } catch (e) { console.error("Z-API erro", rota, e.message || e); return null; }
}
const zapiTexto = (phone, message) => zapi("send-text", { phone, message, delayTyping: Math.min(4, 1 + Math.floor(message.length / 120)) });

// ---------- estado guardado (Render Key Value), com reserva em memória ----------
const REDIS_URL = process.env.REDIS_URL || "";
const mem = new Map();
let rsock = null, rbuf = Buffer.alloc(0), rfila = [];
function respEncode(args) { return `*${args.length}\r\n` + args.map(a => { a = String(a); return `$${Buffer.byteLength(a)}\r\n${a}\r\n`; }).join(""); }
function respParse(buf, i = 0) {
  const nl = buf.indexOf("\r\n", i); if (nl < 0) return null;
  const tipo = String.fromCharCode(buf[i]), linha = buf.toString("utf8", i + 1, nl);
  if (tipo === "+") return { v: linha, n: nl + 2 };
  if (tipo === "-") return { v: new Error(linha), n: nl + 2 };
  if (tipo === ":") return { v: Number(linha), n: nl + 2 };
  if (tipo === "$") { const len = Number(linha); if (len < 0) return { v: null, n: nl + 2 }; if (buf.length < nl + 2 + len + 2) return null; return { v: buf.toString("utf8", nl + 2, nl + 2 + len), n: nl + 2 + len + 2 }; }
  if (tipo === "*") { const len = Number(linha); let p = nl + 2; const arr = []; for (let k = 0; k < len; k++) { const r = respParse(buf, p); if (!r) return null; arr.push(r.v); p = r.n; } return { v: arr, n: p }; }
  return { v: null, n: nl + 2 };
}
function redisConn() {
  if (rsock) return rsock;
  const u = new URL(REDIS_URL);
  const opt = { host: u.hostname, port: Number(u.port || 6379) };
  const s = u.protocol === "rediss:" ? tls.connect({ ...opt, servername: u.hostname }) : net.connect(opt);
  rsock = s; s.setKeepAlive(true);
  s.on("data", d => { rbuf = Buffer.concat([rbuf, d]); let r; while (rbuf.length && (r = respParse(rbuf))) { rbuf = rbuf.subarray(r.n); const p = rfila.shift(); if (p) (r.v instanceof Error ? p.rej(r.v) : p.res(r.v)); } });
  const fim = e => { if (rsock !== s) return; if (e) console.error("Key Value:", e.message || e); rfila.splice(0).forEach(p => p.rej(e || new Error("conexão fechada"))); rsock = null; rbuf = Buffer.alloc(0); };
  s.on("error", fim); s.on("close", () => fim());
  if (u.password) { s.write(respEncode(u.username ? ["AUTH", decodeURIComponent(u.username), decodeURIComponent(u.password)] : ["AUTH", decodeURIComponent(u.password)])); rfila.push({ res() {}, rej() {} }); }
  return s;
}
function redis(...args) {
  return new Promise((res, rej) => {
    const s = redisConn(); const t = setTimeout(() => rej(new Error("timeout")), 5000);
    rfila.push({ res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } }); s.write(respEncode(args));
  });
}
const DIAS30 = 30 * 24 * 3600;
async function ler(k) {
  if (REDIS_URL) { try { const v = await redis("GET", k); return v ? JSON.parse(v) : null; } catch (e) { console.error("Key Value GET", e.message); } }
  return mem.has(k) ? JSON.parse(JSON.stringify(mem.get(k))) : null;
}
async function gravar(k, v) {
  mem.set(k, v);
  if (REDIS_URL) { try { await redis("SET", k, JSON.stringify(v), "EX", DIAS30); } catch (e) { console.error("Key Value SET", e.message); } }
}
async function proximoPedido() {
  if (REDIS_URL) { try { return await redis("INCR", "rl:seq"); } catch (e) { console.error("Key Value INCR", e.message); } }
  const n = (mem.get("rl:seq") || 0) + 1; mem.set("rl:seq", n); return n;
}

// ---------- IA ----------
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 60;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}

function instrucoes(c) {
  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  return `Você atende o WhatsApp da *${c.nome}*, empresa de São Paulo do Rafael que monta coberturas (tendas, lonas, estruturas de ferro, policarbonato).
A maioria dos clientes quer ALUGAR cobertura pra um evento (aniversário, almoço, churrasco, casamento, festa de empresa), muitas vezes pra cobrir varanda, área da piscina, salão de festas ou quintal, ou por medo de chuva. Alguns querem COMPRAR uma cobertura fixa pra ficar no lugar.

SEU TRABALHO É SÓ ESTE: entender o pedido, passar uma estimativa e pré-agendar a visita técnica. Quem fecha, negocia e confirma tudo é o Rafael.

Jeito de falar: como o Rafael fala no WhatsApp — simples, educado e direto ("Boa tarde! Tudo bem?", "Fazemos sim!"). Português do Brasil, mensagens curtas (1 a 3 frases), no máximo 1 emoji. Use *negrito* do WhatsApp com moderação. No máximo UMA pergunta por mensagem. Não diga que é uma IA a menos que perguntem; se perguntarem, diga que é o assistente virtual da ${c.nome} e que o Rafael acompanha todos os pedidos.

COMO CONDUZIR
- O cliente costuma mandar várias mensagens seguidas, com foto, vídeo e medidas aproximadas. Leia TUDO que ele já mandou e NÃO pergunte de novo o que ele já disse.
- Primeira resposta: cumprimente (pelo nome, se ele disse), confirme que vocês fazem ("Fazemos sim!") e já siga com a próxima informação que falta.
- Se falou de evento, data ou festa, é ALUGUEL — não pergunte se é aluguel ou compra. Só pergunte isso se realmente não der pra saber.
- COMPRA só quando o cliente quer uma cobertura fixa/definitiva. Aí apresente os 3 materiais.
- Foto ou vídeo do local ajudam: se ainda não mandou, pode pedir (opcional). Se mandou, agradeça e use o que der pra ver.

ALUGUEL — o que precisa (pule o que já tem):
1. tipo de evento e data  2. bairro/cidade
3. tamanho da área (ex: 10x20 m ou "varanda de 14 m"). Se não souber, pergunte quantas pessoas e estime ${c.m2PorPessoa} m² por pessoa, arredondando pra cima. Se ele disser só um lado (ex: 14 m), pergunte a outra medida aproximada.
4. se precisa de fechamento lateral (só se fizer sentido)
Preço de referência do aluguel por m²: São Paulo capital e Grande SP R$ ${PRECOS.locacao.sp}; interior / fora de SP R$ ${PRECOS.locacao.interior}.

COMPRA — o que precisa (pule o que já tem):
1. material — 3 opções: *Policarbonato* (R$ ${PRECOS.venda.policarbonato}/m²), *Lona* (R$ ${PRECOS.venda.lona}/m²) e *Plástico* (R$ ${PRECOS.venda.plastico}/m²). Se não souber, explique rapidinho e ajude a escolher.
2. bairro/cidade e que lugar é  3. tamanho da área  4. pra quando precisa

PREÇO
- Use SEMPRE a ferramenta calcular_orcamento pra dar valor. Não faça conta de cabeça.
- Todo valor é *estimativa*: varia com a distância e com as medidas reais, e o *valor final oficial sai só depois da visita técnica*.
- Fale um único valor (já com nota fiscal). NÃO ofereça sem nota nem desconto; se pedirem, diga que isso o Rafael conversa direto.
- Não invente frete, prazos, disponibilidade de data ou outros preços. Não prometa disponibilidade pra data do evento: diga que o Rafael confirma.

VISITA TÉCNICA (gratuita)
- Depois da estimativa, ofereça a visita técnica pra medir. Horários de referência: ${c.horarios}.
- Peça 1 a 3 opções de dia e período que funcionam pro cliente, o *endereço completo* do local e o nome dele (se ainda não disse).
- NUNCA confirme o horário como certo: é um *pré-agendamento*, o Rafael confere a agenda e confirma por aqui.
- Quando tiver tudo, chame registrar_pedido UMA vez e diga que já passou pro Rafael, que vai confirmar o horário da visita por aqui.

Se o cliente fugir do assunto, responda com educação e traga de volta. Hoje é ${hoje}.`;
}

const tools = [
  { type: "function", function: { name: "calcular_orcamento", description: "Calcula o valor ESTIMADO (com nota) a partir da modalidade, área e região (aluguel) ou material (compra). Use sempre que for informar preço.",
    parameters: { type: "object", properties: {
      modalidade: { type: "string", enum: ["aluguel", "compra"] },
      area_m2: { type: "number", description: "Área total em m²" },
      regiao: { type: "string", enum: ["sp", "interior"], description: "Só aluguel. sp = capital e Grande SP; interior = interior ou fora de SP" },
      material: { type: "string", enum: ["policarbonato", "lona", "plastico"], description: "Só compra" } },
      required: ["modalidade", "area_m2"] } } },
  { type: "function", function: { name: "registrar_pedido", description: "Envia o pedido completo pro Rafael aprovar a visita. Chame uma única vez, quando já tiver nome, modalidade, endereço/local, tamanho e as opções de horário da visita.",
    parameters: { type: "object", properties: {
      nome: { type: "string" }, modalidade: { type: "string", enum: ["aluguel", "compra"] },
      evento: { type: "string", description: "Aluguel: tipo de evento. Compra: uso da cobertura" },
      data: { type: "string", description: "Aluguel: data do evento. Compra: pra quando precisa" },
      local: { type: "string", description: "endereço completo ou bairro/cidade" },
      tamanho: { type: "string", description: "medida ou área, ex: 10x20 m (200 m²)" }, area_m2: { type: "number" },
      regiao: { type: "string", enum: ["sp", "interior"] }, material: { type: "string", enum: ["policarbonato", "lona", "plastico"] },
      fechamento_lateral: { type: "string" },
      visita: { type: "string", description: "opções de dia/período que o cliente pode, pro Rafael aprovar" },
      observacoes: { type: "string", description: "detalhes úteis: medo de chuva, varanda, piscina, salão de festas, fotos/vídeos enviados etc." } },
      required: ["nome", "modalidade", "local", "tamanho", "visita"] } } }
];

async function openai(body) {
  let lastErr;
  for (const model of MODELS) {
    const b = { ...body, model };
    if (/^gpt-5\.\d/.test(model)) b.reasoning_effort = "none";
    else if (/^(gpt-5|o\d)/.test(model)) b.reasoning_effort = "low";
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(b)
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    lastErr = new Error(`${model}: ${r.status} ${j.error && j.error.message}`);
    console.error(lastErr.message);
    if (r.status === 401 || r.status === 429) break;
  }
  throw lastErr;
}

async function transcrever(url) {
  try {
    const a = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!a.ok) return "";
    const blob = new Blob([await a.arrayBuffer()], { type: a.headers.get("content-type") || "audio/ogg" });
    for (const model of ["gpt-4o-mini-transcribe", "whisper-1"]) {
      const fd = new FormData(); fd.append("file", blob, "audio.ogg"); fd.append("model", model); fd.append("language", "pt");
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: fd });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.text) return j.text.trim();
      console.error("transcrição", model, r.status, j.error && j.error.message);
    }
  } catch (e) { console.error("transcrição erro", e.message || e); }
  return "";
}

async function chat(req) {
  const c = {
    nome: String(req.config?.nome || "RL Coberturas").slice(0, 60),
    m2PorPessoa: Number(req.config?.m2PorPessoa) > 0 ? Number(req.config.m2PorPessoa) : 1.5,
    horarios: String(req.config?.horarios || "segunda a sábado, das 8h às 17h").slice(0, 120),
  };
  const hist = (Array.isArray(req.messages) ? req.messages : []).slice(-30)
    .filter(m => m && (m.role === "user" || m.role === "assistant"))
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 2500) }));
  const extras = [];
  if (req.temFoto) extras.push({ role: "system", content: "Obs: o cliente já mandou foto/vídeo do local." });
  if (req.jaRegistrado) extras.push({ role: "system", content: "O pedido deste cliente JÁ foi enviado ao Rafael e está aguardando ele confirmar o horário da visita. Não chame registrar_pedido de novo. Responda dúvidas simples e diga que o Rafael confirma em breve; se o cliente mudar alguma informação importante, diga que vai avisar o Rafael." });

  const montar = comImagem => {
    const h = hist.map(m => ({ ...m }));
    if (comImagem && req.imagens?.length && h.length && h[h.length - 1].role === "user") {
      const u = h[h.length - 1];
      u.content = [{ type: "text", text: u.content }, ...req.imagens.slice(0, 3).map(url => ({ type: "image_url", image_url: { url } }))];
    }
    return [{ role: "system", content: instrucoes(c) }, ...h, ...extras];
  };
  let msgs;
  try { msgs = montar(true); var primeira = await openai({ messages: msgs, tools }); }
  catch (e) { if (!req.imagens?.length) throw e; msgs = montar(false); primeira = await openai({ messages: msgs, tools }); }

  const out = { reply: "", orcamento: null, pedido: null };
  let j = primeira;
  for (let i = 0; i < 4; i++) {
    if (i > 0) j = await openai({ messages: msgs, tools });
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
  if (!out.reply) out.reply = "Anotado! Mais alguma informação?";
  return out;
}

// ---------- atendimento no WhatsApp ----------
// status: "bot" (bot atende) · "aguardando" (pedido enviado, Rafael ainda não aprovou) · "remarcando" · "humano" (Rafael assumiu: bot fica quieto)
const novaConversa = () => ({ hist: [], temFoto: false, status: "bot", pedidoId: null, visita: "" });
const conversa = async phone => (await ler("rl:c:" + phone)) || novaConversa();
const salvar = (phone, c) => gravar("rl:c:" + phone, c);

const buffers = new Map(); // phone -> { partes, imagens, timer }
const filas = new Map();   // phone -> Promise (uma resposta por vez)
const vistos = new Set();
setInterval(() => { if (vistos.size > 5000) vistos.clear(); if (enviadosPeloBot.size > 5000) enviadosPeloBot.clear(); }, 3600 * 1000);
function naFila(phone, fn) { const p = (filas.get(phone) || Promise.resolve()).then(fn).catch(e => console.error("fila", e)); filas.set(phone, p); return p; }

function resumoPedido(p, phone, id) {
  const compra = p.modalidade === "compra";
  const l = [`🆕 *Pedido #${id} — ${compra ? "🛒 COMPRA" : "📅 ALUGUEL"}*`, ""];
  const add = (k, v) => { if (v) l.push(`*${k}:* ${v}`); };
  add("Cliente", p.nome); add("WhatsApp", "+" + phone);
  add(compra ? "Uso" : "Evento", p.evento); add(compra ? "Prazo" : "Data", p.data); add("Local", p.local);
  add("Tamanho", p.tamanho); if (compra) add("Material", NOME_MAT[p.material] || p.material); else add("Região", p.regiao === "interior" ? "Interior" : p.regiao ? "São Paulo" : "");
  add("Fech. lateral", p.fechamento_lateral); add("Obs.", p.observacoes);
  if (p.valor) { l.push(""); l.push(`💰 *Estimativa c/ nota:* ${brl(p.valor)} (${p.area} m² × ${brl(p.precoM2)})`); }
  l.push(""); l.push(`📆 *Visita — cliente pode:* ${p.visita || "-"}`);
  l.push("");
  l.push("*Responde aqui:*");
  l.push(`✅ *ok ${id}* → confirma a visita (ou *ok ${id} sábado 10h* pra escolher o horário)`);
  l.push(`🔁 *outro ${id} sexta 14h* → sugere outro horário pro cliente`);
  l.push(`🙋 *assumir ${id}* → o bot para e você segue a conversa`);
  return l.join("\n");
}

async function comandoRafael(texto) {
  const m = texto.trim().match(/^(ok|okay|sim|aprovad[oa]|aprovar|confirmad[oa]|confirmar|outro|remarcar|assumir|parar|bot|voltar)\b\s*#?\s*(\d+)?\s*(.*)$/is);
  if (!m) {
    return zapiTexto(RAFAEL, "Comandos:\n✅ *ok 12* (ou *ok 12 sábado 10h*) → confirma a visita\n🔁 *outro 12 sexta 14h* → sugere outro horário\n🙋 *assumir 12* → bot para de responder o cliente\n🤖 *bot 12* → bot volta a atender o cliente");
  }
  const cmd = m[1].toLowerCase(), extra = (m[3] || "").trim();
  const id = m[2] ? Number(m[2]) : await ler("rl:ultimo");
  const phone = id ? await ler("rl:p:" + id) : null;
  if (!phone) return zapiTexto(RAFAEL, `Não achei o pedido${id ? " #" + id : ""}. Manda com o número, ex: *ok 12*`);
  return naFila(phone, async () => {
    const c = await conversa(phone);
    if (/^(ok|okay|sim|aprov|confirm)/.test(cmd)) {
      const quando = extra || c.visita;
      await zapiTexto(phone, `✅ Visita técnica confirmada${quando ? ": *" + quando + "*" : ""}.\nA partir de agora o Rafael segue com você por aqui. Obrigado!`);
      c.status = "humano"; await salvar(phone, c);
      return zapiTexto(RAFAEL, `Feito! Pedido #${id} confirmado e avisei o cliente. Daqui pra frente o bot não responde mais ele — é com você 👊`);
    }
    if (/^(outro|remarcar)/.test(cmd)) {
      if (!extra) return zapiTexto(RAFAEL, `Me fala o horário, ex: *outro ${id} sexta 14h*`);
      await zapiTexto(phone, `O Rafael conferiu a agenda e não consegue nesse horário 😕 Ele sugeriu *${extra}*. Pode ser pra você?`);
      c.status = "remarcando"; c.visita = extra; c.hist.push({ role: "assistant", content: `O Rafael sugeriu ${extra} pra visita. Pode ser?` }); await salvar(phone, c);
      return zapiTexto(RAFAEL, `Mandei pro cliente a sugestão: ${extra}. Quando ele responder eu te passo aqui.`);
    }
    if (/^(assumir|parar)/.test(cmd)) { c.status = "humano"; await salvar(phone, c); return zapiTexto(RAFAEL, `Pronto, o bot parou no pedido #${id}. Pode responder o cliente direto pelo número da empresa.`); }
    c.status = c.pedidoId ? "aguardando" : "bot"; await salvar(phone, c);
    return zapiTexto(RAFAEL, `Ok, o bot voltou a atender o cliente do pedido #${id}.`);
  });
}

async function responder(phone) {
  const b = buffers.get(phone); buffers.delete(phone);
  if (!b || !b.partes.length) return;
  const c = await conversa(phone);
  if (c.status === "humano") return;
  const texto = b.partes.join("\n");
  if (c.status === "remarcando") {
    c.hist.push({ role: "user", content: texto }); c.status = "aguardando"; await salvar(phone, c);
    if (RAFAEL) await zapiTexto(RAFAEL, `💬 Cliente do pedido #${c.pedidoId} respondeu sobre o horário:\n"${texto.slice(0, 500)}"\n\nSe estiver ok: *ok ${c.pedidoId} ${c.visita}*`);
    return zapiTexto(phone, "Show, já passei pro Rafael! Ele te confirma por aqui 👍");
  }
  c.hist.push({ role: "user", content: texto.slice(0, 2500) });
  if (b.temMidia) c.temFoto = true;
  try {
    const r = await chat({ messages: c.hist, imagens: b.imagens, temFoto: c.temFoto, jaRegistrado: !!c.pedidoId });
    c.hist.push({ role: "assistant", content: r.reply }); c.hist = c.hist.slice(-30);
    await zapiTexto(phone, r.reply);
    if (r.pedido && !c.pedidoId) {
      const id = await proximoPedido();
      c.pedidoId = id; c.status = "aguardando"; c.visita = r.pedido.visita || "";
      await gravar("rl:p:" + id, phone); await gravar("rl:ultimo", id);
      console.log("Pedido registrado #" + id, phone, r.pedido.modalidade);
      if (RAFAEL) await zapiTexto(RAFAEL, resumoPedido(r.pedido, phone, id));
    }
    await salvar(phone, c);
  } catch (e) {
    console.error("Erro no atendimento", e.message || e);
    c.hist.pop(); await salvar(phone, c);
    await zapiTexto(phone, "Opa, deu uma instabilidade aqui. Pode mandar de novo?");
  }
}

async function receberWhatsApp(ev) {
  if (ev.type && ev.type !== "ReceivedCallback") return;
  const phone = String(ev.phone || "").replace(/\D/g, "");
  if (!phone || ev.isGroup || ev.isNewsletter || ev.broadcast || String(ev.phone).includes("@")) return;
  if (ev.messageId) { if (vistos.has(ev.messageId)) return; vistos.add(ev.messageId); }

  // mensagem que saiu do número da empresa: se não foi o bot, é o Rafael respondendo → bot para nesse cliente
  if (ev.fromMe) {
    await new Promise(r => setTimeout(r, 4000));
    if (enviadosPeloBot.has(String(ev.messageId)) || ev.fromApi) return;
    if (phone === RAFAEL) return;
    const c = await conversa(phone);
    if (c.status !== "humano") { c.status = "humano"; await salvar(phone, c); console.log("Rafael assumiu a conversa", phone); }
    return;
  }

  let texto = ev.text?.message || ev.buttonsResponseMessage?.message || ev.listResponseMessage?.title || "";
  if (RAFAEL && phone === RAFAEL) { if (texto) await comandoRafael(texto); return; }

  const c0 = await conversa(phone);
  if (c0.status === "humano") return;

  let imagem = null, midia = false;
  if (ev.image) { midia = true; imagem = ev.image.imageUrl || null; texto = "[enviou uma foto do local]" + (ev.image.caption ? " " + ev.image.caption : ""); }
  else if (ev.video) { midia = true; texto = "[enviou um vídeo do local]" + (ev.video.caption ? " " + ev.video.caption : ""); }
  else if (ev.audio) {
    const t = ev.audio.audioUrl ? await transcrever(ev.audio.audioUrl) : "";
    texto = t ? `[áudio] ${t}` : "[mandou um áudio que não deu pra ouvir]";
  }
  else if (ev.document) { midia = true; texto = "[enviou um arquivo]" + (ev.document.fileName ? " " + ev.document.fileName : ""); }
  else if (ev.location) texto = `[enviou a localização] ${ev.location.address || ""} ${ev.location.latitude || ""},${ev.location.longitude || ""}`.trim();
  if (!texto) return;

  let b = buffers.get(phone);
  if (!b) { b = { partes: [], imagens: [], temMidia: false, timer: null }; buffers.set(phone, b); }
  b.partes.push(texto); if (imagem) b.imagens.push(imagem); if (midia) b.temMidia = true;
  clearTimeout(b.timer);
  b.timer = setTimeout(() => naFila(phone, () => responder(phone)), ESPERA_MS);
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
  if (req.method === "POST" && usaZapi() && ZAPI.secret && req.url.split("?")[0] === "/zapi/" + ZAPI.secret) {
    let body = "";
    req.on("data", d => { body += d; if (body.length > 2000000) req.destroy(); });
    req.on("end", () => {
      res.end("ok");
      let ev; try { ev = JSON.parse(body || "{}"); } catch { return; }
      if (!KEY) return console.error("Mensagem recebida mas falta OPENAI_API_KEY");
      receberWhatsApp(ev).catch(e => console.error(e));
    });
    return;
  }
  if (req.url === "/health") return res.end(`ok · IA: ${KEY ? "ligada" : "desligada"} · WhatsApp: ${usaZapi() ? "Z-API ok" : "desligado"} · Rafael: ${RAFAEL ? "sim" : "não"} · memória: ${REDIS_URL ? "Key Value" : "temporária"}`);
  const p = req.url.split("?")[0];
  if (p !== "/" && p !== "/index.html") { res.statusCode = 404; return res.end("não encontrado"); }
  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    if (err) { res.statusCode = 500; return res.end("erro"); }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(data);
  });
}).listen(PORT, () => console.log(`RL Coberturas no ar na porta ${PORT} · IA: ${KEY ? "ligada" : "DESLIGADA (falta OPENAI_API_KEY)"} · WhatsApp: ${usaZapi() ? "Z-API ok" : "desligado"} · memória: ${REDIS_URL ? "Key Value" : "temporária"}`));
