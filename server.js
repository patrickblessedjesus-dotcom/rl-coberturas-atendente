// Atendente RL Coberturas — WhatsApp (Z-API). Sem dependências.
const http = require("http");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const EMPRESA = (process.env.NOME_EMPRESA || "RL Coberturas").trim(); // ex: "Grupo RL" no segundo número
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
const NOME_MAT = { policarbonato: "Policarbonato", lona: "Lona vinílica translúcida", plastico: "Plástico cristal", vidro: "Vidro laminado", zinco: "Telha de zinco termoacústica" };
// páginas do catálogo da RL (arquivos .jpg no repositório), servidas em /fotos/<nome>.jpg
const FOTOS = {
  "venda-plastico": "Venda · Plástico cristal transparente", "venda-lona": "Venda · Lona vinílica translúcida", "venda-policarbonato": "Venda · Policarbonato",
  "venda-vidro": "Venda · Vidro laminado", "venda-zinco": "Venda · Telha de zinco termoacústica",
  "locacao-plastico": "Locação · Cobertura em plástico cristal", "locacao-tecido": "Locação · Tecido pra quebra de sol",
  "piso-carpete": "Locação · Piso nivelado com carpete", "piso-deck": "Locação · Piso nivelado com deck", "piso-vidro": "Locação · Piso de vidro temperado (sobre piscina)",
};
const URL_PUBLICA = (process.env.RENDER_EXTERNAL_URL || process.env.URL_PUBLICA || "https://rl-coberturas.onrender.com").replace(/\/$/, "");
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
const CLIENTES_RAFAEL = new Set((process.env.CLIENTES_RAFAEL || "").split(/[,;\s]+/).map(x => x.replace(/\D/g, "")).filter(Boolean)); // a Suelen nunca responde esses números
const ATIVO_DESDE = Date.parse(process.env.ATIVO_DESDE || "") || 0; // só responde mensagens que chegarem depois disso
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
async function zapiGet(rota) {
  const headers = {}; if (ZAPI.client) headers["Client-Token"] = ZAPI.client;
  try {
    const r = await fetch(`https://api.z-api.io/instances/${encodeURIComponent(ZAPI.id)}/token/${encodeURIComponent(ZAPI.token)}/${rota}`, { headers, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    if (!r.ok) { console.error("Z-API GET recusou", rota.split("?")[0], r.status, t.slice(0, 200)); return null; }
    return JSON.parse(t);
  } catch (e) { console.error("Z-API GET erro", e.message || e); return null; }
}
const DIAS_HUMANO = Number(process.env.DIAS_HUMANO || 30); // se o Rafael respondeu o cliente nesse período, a Suelen não entra
// olha o histórico do WhatsApp: o Rafael já respondeu esse cliente? e o que já foi conversado?
async function historicoWhatsApp(phone, c) {
  const lista = await zapiGet(`chat-messages/${phone}?amount=40`);
  if (!Array.isArray(lista)) return null;
  const msgs = lista.filter(m => m && m.messageId).sort((a, b) => Number(a.momment || 0) - Number(b.momment || 0));
  const doBot = new Set([...(c.botIds || []), ...enviadosPeloBot]);
  const limite = Date.now() - DIAS_HUMANO * 24 * 3600 * 1000;
  const humano = msgs.find(m => m.fromMe && !doBot.has(String(m.messageId)) && !m.fromApi && Number(m.momment || 0) >= limite);
  const texto = m => m.text?.message || (m.image ? "[foto]" + (m.image.caption ? " " + m.image.caption : "") : m.audio ? "[áudio]" : m.video ? "[vídeo]" : m.document ? "[arquivo]" : "");
  const antes = msgs.filter(m => !doBot.has(String(m.messageId))).slice(-20).map(m => `${m.fromMe ? "Rafael" : "Cliente"}: ${texto(m)}`).filter(l => !l.endsWith(": "));
  return { rafaelRespondeu: !!humano, contexto: antes.join("\n") };
}
const zapiTexto = (phone, message) => zapi("send-text", { phone, message, delayTyping: Math.min(4, 1 + Math.floor(message.length / 120)) });

// ---------- estado guardado (Render Key Value), com reserva em memória ----------
const REDIS_URL = process.env.REDIS_URL || "";
const P = "rl:" + (process.env.ESTADO_VERSAO || "1") + ":"; // trocar ESTADO_VERSAO zera conversas e pedidos
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
  if (REDIS_URL) { try { return await redis("INCR", P + "seq"); } catch (e) { console.error("Key Value INCR", e.message); } }
  const n = (mem.get(P + "seq") || 0) + 1; mem.set(P + "seq", n); return n;
}

// ---------- IA ----------

function instrucoes(c) {
  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  return `Você é a *Suelen*, assistente do Rafael na *${c.nome}*${/cobertura/i.test(c.nome) ? " (RL Coberturas e Decorações)" : " (do grupo da RL Coberturas e Decorações)"}, empresa de São Paulo. Você atende o WhatsApp da empresa.

O QUE A RL FAZ (catálogo)
- LOCAÇÃO pra eventos: cobertura em *plástico cristal transparente* (proteção contra chuva, visual sofisticado); cobertura com *tecido pra quebra de sol* (reduz o calor, elegante, ideal pra eventos de dia); *piso nivelado* com acabamento em *carpete*, *deck* (tábuas envernizadas) ou *vidro temperado* (transforma a piscina em área útil do evento).
- VENDA (cobertura fixa, sob medida): *plástico cristal transparente* (melhor custo-benefício), *lona vinílica translúcida* (protege sem perder luminosidade), *policarbonato* (alta resistência, desempenho térmico e proteção UV), *vidro laminado* (durável, isolamento acústico, proteção UV, máxima transparência) e *telha de zinco termoacústica* (com isopor, conforto térmico e acústico, pra áreas grandes).
- Visita técnica *gratuita* na cidade de São Paulo (fora da capital, o Rafael confirma). Parcelamento em até *12x sem juros*.
A maioria dos clientes quer ALUGAR cobertura pra um evento (aniversário, almoço, churrasco, casamento, festa de empresa), muitas vezes pra cobrir varanda, área da piscina, salão de festas ou quintal, ou por medo de chuva. Alguns querem COMPRAR uma cobertura fixa pra ficar no lugar.

SEU TRABALHO É SÓ ESTE: entender o pedido e pré-agendar a visita técnica (e, se o cliente já souber a medida, passar uma estimativa). Quem fecha, negocia e confirma tudo é o Rafael.

MEDIDA × VISITA TÉCNICA (muito importante)
- O objetivo principal é marcar a visita técnica. É lá que o Rafael vai até o local, entende a necessidade do cliente pessoalmente, tira as dúvidas e mede o que ele quer cobrir.
- Se o cliente JÁ disser a medida, use calcular_orcamento e passe a estimativa.
- Se ele NÃO souber a medida, souber só mais ou menos, ou não estiver no local: NÃO insista, NÃO tente calcular por número de pessoas, NÃO fique pedindo medidas. Diga que não tem problema e que o melhor é o Rafael ir até o local na visita técnica (gratuita) pra ver tudo pessoalmente e medir certinho — e já siga pro agendamento.

Jeito de falar: simples, educado e direto, do jeito que o Rafael fala no WhatsApp ("Boa tarde! Tudo bem?", "Fazemos sim!"). Português do Brasil, mensagens curtas (1 a 3 frases), no máximo 1 emoji. Use *negrito* do WhatsApp com moderação. No máximo UMA pergunta por mensagem. Fale no feminino (você é a Suelen). Na PRIMEIRA resposta da conversa, se apresente: "Aqui é a Suelen, assistente do Rafael da ${c.nome}". Se perguntarem se você é robô/IA, diga com naturalidade que é a assistente virtual do Rafael e que ele acompanha todos os pedidos.

CLIENTE QUE JÁ FALAVA COM O RAFAEL
Este número já era usado pelo Rafael antes de você começar. Se a mensagem não parecer um pedido NOVO de orçamento — ex.: o cliente fala de algo já combinado, um serviço já marcado, montagem, pagamento, contrato, "e aí, confirmado?", "conforme falamos", responde algo que parece continuação de conversa — NÃO comece o atendimento do zero. Se tiver dúvida, pergunte de forma simples se é um orçamento novo ou se é sobre algo que ele já estava vendo com o Rafael. Se for algo que já estava com o Rafael (ou assunto que não é orçamento, como fornecedor, cobrança, pessoal), chame passar_para_rafael e diga que já avisou o Rafael e que ele responde por aqui.

COMO CONDUZIR
- O cliente costuma mandar várias mensagens seguidas, com foto, vídeo e medidas aproximadas. Leia TUDO que ele já mandou e NÃO pergunte de novo o que ele já disse.
- Primeira resposta: cumprimente (pelo nome, se ele disse), confirme que vocês fazem ("Fazemos sim!") e já siga com a próxima informação que falta.
- Se falou de evento, data ou festa, é ALUGUEL — não pergunte se é aluguel ou compra. Só pergunte isso se realmente não der pra saber.
- COMPRA só quando o cliente quer uma cobertura fixa/definitiva. Aí apresente os 3 materiais.
- Foto ou vídeo do local ajudam: se ainda não mandou, pode pedir (opcional). Se mandou, agradeça e use o que der pra ver.

ALUGUEL — o que precisa (pule o que já tem):
1. tipo de evento e data  2. bairro/cidade
3. tamanho da área — pergunte UMA vez se ele já tem a medida (ex: 10x20 m).
4. se precisa de fechamento lateral (só se fizer sentido)
Extras da locação: tecido de quebra de sol e piso nivelado (carpete, deck ou vidro sobre a piscina). Ofereça quando fizer sentido (evento de dia com sol forte → tecido; gramado/terreno irregular → piso; evento na área da piscina → piso de vidro). Esses extras não têm valor de tabela: anote no pedido (observações) e diga que o Rafael passa o valor depois da visita. Pode mandar foto com enviar_fotos.
O valor depende da região (São Paulo capital/Grande SP ou interior/fora de SP) — a ferramenta calcula.

COMPRA — o que precisa (pule o que já tem):
1. material — policarbonato, lona, plástico cristal, vidro laminado ou telha de zinco. Se o cliente não souber qual quer, explique rapidinho a diferença e ofereça mandar fotos pra ajudar a escolher (ferramenta enviar_fotos). Vidro laminado e telha de zinco não têm valor de tabela: diga que o Rafael passa o valor depois da visita técnica.
2. bairro/cidade e que lugar é  3. tamanho da área, se ele souber (se não souber, vai pra visita)  4. pra quando precisa

PREÇO
- Use SEMPRE a ferramenta calcular_orcamento pra dar valor. Não faça conta de cabeça.
- Se perguntarem de pagamento: parcelamento em até 12x sem juros; detalhes com o Rafael.
- Passe SÓ o *valor final* da cobertura (ex: "10x10 fica em torno de R$ 12.000"). NUNCA fale o preço do metro quadrado, nem a conta "m² × preço".
- Na compra, calcule só o material que o cliente escolheu. Só mande as 3 opções (policarbonato, lona e plástico, cada uma com o valor final) se o cliente PEDIR pra comparar.
- Todo valor é *estimativa*: varia com a distância e com as medidas reais, e o *valor final oficial sai só depois da visita técnica*.
- Fale um único valor (já com nota fiscal). NÃO ofereça sem nota nem desconto; se pedirem, diga que isso o Rafael conversa direto.
- Não invente frete, prazos, disponibilidade de data ou outros preços. Não prometa disponibilidade pra data do evento: diga que o Rafael confirma.

VISITA TÉCNICA (gratuita)
- Ofereça a visita técnica assim que tiver o básico (o que é, onde e quando) — com ou sem estimativa. Horários de referência: ${c.horarios}.
- Peça 1 a 3 opções de dia e período que funcionam pro cliente, o *endereço completo* do local e o nome dele (se ainda não disse).
- NUNCA confirme o horário como certo: é um *pré-agendamento*, o Rafael confere a agenda e confirma por aqui.
- Quando tiver tudo, chame registrar_pedido UMA vez e diga que já passou pro Rafael, que vai confirmar o horário da visita por aqui.

NOME DO CLIENTE (muito importante)
- Chame o cliente só pelo nome que ELE disser que é dele ("meu nome é…", "aqui é a…", "sou o…") ou pelo nome do perfil do WhatsApp, se vier abaixo.
- NUNCA chame o cliente por um nome que ele usa pra falar COM a empresa. Clientes antigos às vezes chamam a empresa de *Darcy* (antigo dono da RL, já falecido) ou de *Rafael*. "Oi Darcy", "Bom dia seu Darcy", "Rafael, tudo bem?" = o cliente está chamando a EMPRESA, não dizendo o nome dele. Nunca chame cliente de Darcy nem de Rafael.
- Na dúvida sobre o nome, não use nome nenhum.

Se o cliente fugir do assunto, responda com educação e traga de volta. Hoje é ${hoje}.`;
}

const tools = [
  { type: "function", function: { name: "calcular_orcamento", description: "Calcula o valor ESTIMADO (com nota) a partir da modalidade, área e região (aluguel) ou material (compra). Use sempre que for informar preço.",
    parameters: { type: "object", properties: {
      modalidade: { type: "string", enum: ["aluguel", "compra"] },
      area_m2: { type: "number", description: "Área total em m²" },
      regiao: { type: "string", enum: ["sp", "interior"], description: "Só aluguel. sp = capital e Grande SP; interior = interior ou fora de SP" },
      material: { type: "string", enum: ["policarbonato", "lona", "plastico", "vidro", "zinco"], description: "Só compra" } },
      required: ["modalidade", "area_m2"] } } },
  { type: "function", function: { name: "enviar_fotos", description: "Manda pro cliente fotos do catálogo da RL (cada uma com foto real e descrição). Use quando o cliente quiser ver os materiais/opções. Mande no máximo 5.",
    parameters: { type: "object", properties: { fotos: { type: "array", items: { type: "string", enum: Object.keys(FOTOS) }, description: "quais mandar" } }, required: ["fotos"] } } },
  { type: "function", function: { name: "passar_para_rafael", description: "Passa a conversa pro Rafael e você para de responder este cliente. Use quando for cliente antigo/assunto já em andamento com o Rafael, ou algo que não é orçamento novo.",
    parameters: { type: "object", properties: { nome: { type: "string" }, motivo: { type: "string", description: "resumo curto do que o cliente quer" } }, required: ["motivo"] } } },
  { type: "function", function: { name: "registrar_pedido", description: "Envia o pedido completo pro Rafael aprovar a visita. Chame uma única vez, quando já tiver nome, modalidade, endereço/local e as opções de horário da visita (o tamanho é opcional).",
    parameters: { type: "object", properties: {
      nome: { type: "string" }, modalidade: { type: "string", enum: ["aluguel", "compra"] },
      evento: { type: "string", description: "Aluguel: tipo de evento. Compra: uso da cobertura" },
      data: { type: "string", description: "Aluguel: data do evento. Compra: pra quando precisa" },
      local: { type: "string", description: "endereço completo ou bairro/cidade" },
      tamanho: { type: "string", description: "medida ou área, ex: 10x20 m (200 m²); se o cliente não souber: 'medir na visita'" }, area_m2: { type: "number" },
      regiao: { type: "string", enum: ["sp", "interior"] }, material: { type: "string", enum: ["policarbonato", "lona", "plastico", "vidro", "zinco"] },
      fechamento_lateral: { type: "string" },
      visita: { type: "string", description: "opções de dia/período que o cliente pode, pro Rafael aprovar" },
      observacoes: { type: "string", description: "detalhes úteis: medo de chuva, varanda, piscina, salão de festas, fotos/vídeos enviados etc." } },
      required: ["nome", "modalidade", "local", "visita"] } } }
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
    nome: String(req.config?.nome || EMPRESA).slice(0, 60),
    m2PorPessoa: Number(req.config?.m2PorPessoa) > 0 ? Number(req.config.m2PorPessoa) : 1.5,
    horarios: String(req.config?.horarios || "segunda a sábado, das 8h às 17h").slice(0, 120),
  };
  const hist = (Array.isArray(req.messages) ? req.messages : []).slice(-30)
    .filter(m => m && (m.role === "user" || m.role === "assistant"))
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 2500) }));
  const extras = [];
  if (req.contexto) extras.push({ role: "system", content: "Mensagens anteriores deste cliente no WhatsApp (antes de você entrar). Use pra NÃO perguntar de novo o que já foi dito ou respondido:\n" + String(req.contexto).slice(0, 3000) });
  if (req.perfil && !/darcy|rafael|suelen/i.test(req.perfil)) extras.push({ role: "system", content: "Nome do perfil do cliente no WhatsApp: " + String(req.perfil).slice(0, 60) });
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

  const out = { reply: "", orcamento: null, pedido: null, passar: null, fotos: null };
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
        if (!p) result = mod === "compra" && NOME_MAT[args.material]
          ? { sem_tabela: true, obs: `${NOME_MAT[args.material]} não tem valor de tabela: diga que o Rafael passa o valor depois da visita técnica (que é gratuita).` }
          : { erro: "Na compra, falta escolher o material." };
        else {
          out.orcamento = { modalidade: mod, area: a, regiao: mod === "aluguel" ? reg : undefined, material: mod === "compra" ? args.material : undefined, precoM2: p, valor: a * p };
          result = { modalidade: mod, area_m2: a, ...(mod === "aluguel" ? { regiao: reg } : { material: NOME_MAT[args.material] }),
            valor_final_estimado: brl(a * p),
            lembrete: "Passe só o valor final (nunca preço por m²). Estimativa com nota; varia com distância e medidas; valor final oficial só após a visita técnica." };
        }
      } else if (tc.function.name === "registrar_pedido") {
        const a = Math.ceil(Number(args.area_m2) || 0);
        const p = precoM2(args.modalidade === "compra" ? "compra" : "locacao", args.regiao, args.material);
        if (a && p) { args.area = a; args.precoM2 = p; args.valor = a * p; }
        out.pedido = args; result = { ok: true };
      } else if (tc.function.name === "enviar_fotos") {
        const lista = (Array.isArray(args.fotos) ? args.fotos : []).filter(m => FOTOS[m]).slice(0, 5);
        out.fotos = [...new Set([...(out.fotos || []), ...lista])];
        result = { ok: true, obs: "As fotos vão logo depois da sua mensagem. Escreva algo curto tipo 'Vou te mandar as fotos 👇' e siga o atendimento." };
      } else if (tc.function.name === "passar_para_rafael") {
        out.passar = args; result = { ok: true, obs: "Avise o cliente que o Rafael já foi avisado e responde por aqui. Depois disso você não fala mais com ele." };
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
const conversa = async phone => (await ler(P + "c:" + phone)) || novaConversa();
const salvar = (phone, c) => gravar(P + "c:" + phone, c);

const buffers = new Map(); // phone -> { partes, imagens, timer }
const filas = new Map();   // phone -> Promise (uma resposta por vez)
const vistos = new Set();
setInterval(() => { if (vistos.size > 5000) vistos.clear(); if (enviadosPeloBot.size > 5000) enviadosPeloBot.clear(); }, 3600 * 1000);
function naFila(phone, fn) { const p = (filas.get(phone) || Promise.resolve()).then(fn).catch(e => console.error("fila", e)); filas.set(phone, p); return p; }

function resumoPedido(p, phone, id) {
  const compra = p.modalidade === "compra";
  const l = [`🆕 *${EMPRESA} · Pedido #${id} — ${compra ? "🛒 COMPRA" : "📅 ALUGUEL"}*`, ""];
  const add = (k, v) => { if (v) l.push(`*${k}:* ${v}`); };
  add("Cliente", p.nome); add("WhatsApp", "+" + phone);
  add(compra ? "Uso" : "Evento", p.evento); add(compra ? "Prazo" : "Data", p.data); add("Local", p.local);
  add("Tamanho", p.tamanho || "medir na visita"); if (compra) add("Material", NOME_MAT[p.material] || p.material); else add("Região", p.regiao === "interior" ? "Interior" : p.regiao ? "São Paulo" : "");
  add("Fech. lateral", p.fechamento_lateral); add("Obs.", p.observacoes);
  if (p.valor) { l.push(""); l.push(`💰 *Estimativa c/ nota:* ${brl(p.valor)} (${p.area} m² × ${brl(p.precoM2)})`); }
  l.push(""); l.push(`📆 *Visita — cliente pode:* ${p.visita || "-"}`);
  l.push("");
  l.push("*Responde aqui:*");
  l.push(`✅ *ok ${id}* → confirma a visita (ou *ok ${id} sábado 10h* pra escolher o horário)`);
  l.push(`🔁 *outro ${id} sexta 14h* → sugere outro horário pro cliente`);
  l.push(`🙋 *assumir ${id}* → a Suelen para e você segue a conversa`);
  return l.join("\n");
}

// ---------- horário da visita + agenda ----------
const AGENDA_URL = (process.env.AGENDA_WEBHOOK_URL || "").trim(); // Apps Script na conta Google do Rafael (cria o evento sozinho)
const DURACAO_MIN = Number(process.env.VISITA_MINUTOS || 60);
function agoraSP() { return new Date().toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(" ", "T").slice(0, 16); }
async function entenderHorario(texto) {
  if (!texto || !KEY) return null;
  try {
    const j = await openai({ response_format: { type: "json_object" }, messages: [
      { role: "system", content: `Agora em São Paulo é ${agoraSP()} (${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long" })}). Converta o horário de visita escrito pelo usuário em UMA data e hora. Responda só JSON: {"ok":true,"inicio":"AAAA-MM-DDTHH:MM"} ou {"ok":false} se tiver mais de uma opção, faltar o dia ou faltar a hora. Datas sempre no futuro. "manhã" sem hora = 09:00, "tarde" sem hora = 14:00, "noite" = 19:00.` },
      { role: "user", content: texto }] });
    const r = JSON.parse(j.choices[0].message.content || "{}");
    if (!r.ok || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.inicio || "")) return null;
    const d = new Date(r.inicio + ":00-03:00");
    const txt = d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "").replace(":00", "h").replace(/(\d{2}):(\d{2})$/, "$1h$2");
    return { inicio: r.inicio, texto: txt };
  } catch (e) { console.error("entender horário", e.message || e); return null; }
}
function linkAgenda(ev) {
  const f = s => s.replace(/[-:]/g, "") + "00";
  const q = new URLSearchParams({ action: "TEMPLATE", text: ev.titulo, dates: `${f(ev.inicio)}/${f(ev.fim)}`, ctz: "America/Sao_Paulo", details: ev.descricao, location: ev.local });
  return "https://calendar.google.com/calendar/render?" + q.toString();
}
async function agendar(c, phone, id, h) {
  const p = c.pedido || {};
  const fimD = new Date(new Date(h.inicio + ":00-03:00").getTime() + DURACAO_MIN * 60000);
  const fim = fimD.toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(" ", "T").slice(0, 16);
  const ev = {
    titulo: `Visita técnica — ${p.nome || "cliente"} (#${id})`,
    inicio: h.inicio, fim, local: p.local || "",
    descricao: [`Pedido #${id} · ${p.modalidade === "compra" ? "Compra" : "Aluguel"}`, `Cliente: ${p.nome || "-"} · WhatsApp +${phone}`,
      p.evento && `Evento/uso: ${p.evento}`, p.data && `Data: ${p.data}`, p.tamanho && `Tamanho: ${p.tamanho}`,
      p.material && `Material: ${NOME_MAT[p.material] || p.material}`, p.valor && `Estimativa c/ nota: ${brl(p.valor)}`, p.observacoes && `Obs.: ${p.observacoes}`,
      `https://wa.me/${phone}`].filter(Boolean).join("\n"),
  };
  if (AGENDA_URL) {
    try {
      const r = await fetch(AGENDA_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ segredo: process.env.AGENDA_SEGREDO || "", ...ev }), redirect: "follow", signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => ({}));
      if (j.ok) return zapiTexto(RAFAEL, `📅 Já marquei na sua Google Agenda, com lembrete.`);
      console.error("agenda recusou", r.status, JSON.stringify(j).slice(0, 200));
    } catch (e) { console.error("agenda erro", e.message || e); }
  }
  return zapiTexto(RAFAEL, `📅 Toca aqui pra salvar na sua Google Agenda:\n${linkAgenda(ev)}`);
}

async function comandoRafael(texto) {
  const m = texto.trim().match(/^(ok|okay|sim|aprovad[oa]|aprovar|confirmad[oa]|confirmar|outro|remarcar|assumir|parar|bot|voltar)\b\s*#?\s*(\d+)?\s*(.*)$/is);
  if (!m) {
    return zapiTexto(RAFAEL, "Comandos:\n✅ *ok 12* (ou *ok 12 sábado 10h*) → confirma a visita\n🔁 *outro 12 sexta 14h* → sugere outro horário\n🙋 *assumir 12* → Suelen para de responder o cliente\n🤖 *bot 12* → Suelen volta a atender o cliente");
  }
  const cmd = m[1].toLowerCase(), extra = (m[3] || "").trim();
  const id = m[2] ? Number(m[2]) : await ler(P + "ultimo");
  const phone = id ? await ler(P + "p:" + id) : null;
  if (!phone) return zapiTexto(RAFAEL, `Não achei o pedido${id ? " #" + id : ""}. Manda com o número, ex: *ok 12*`);
  return naFila(phone, async () => {
    const c = await conversa(phone);
    if (/^(ok|okay|sim|aprov|confirm)/.test(cmd)) {
      const h = await entenderHorario(extra || c.visita);
      if (!h) return zapiTexto(RAFAEL, `O cliente deu estas opções: *${c.visita || "-"}*.\nQual horário fica? Manda assim: *ok ${id} sábado 10h*`);
      await enviarCliente(phone, c, `✅ Visita técnica confirmada: *${h.texto}*.\nA partir de agora o Rafael segue com você por aqui. Obrigado!`);
      c.status = "humano"; c.visitaConfirmada = h.inicio; await salvar(phone, c);
      await zapiTexto(RAFAEL, `Feito! Pedido #${id} confirmado pra *${h.texto}* e avisei o cliente. Daqui pra frente a Suelen não responde mais ele — é com você 👊`);
      return agendar(c, phone, id, h);
    }
    if (/^(outro|remarcar)/.test(cmd)) {
      if (!extra) return zapiTexto(RAFAEL, `Me fala o horário, ex: *outro ${id} sexta 14h*`);
      await enviarCliente(phone, c, `O Rafael conferiu a agenda e não consegue nesse horário 😕 Ele sugeriu *${extra}*. Pode ser pra você?`);
      c.status = "remarcando"; c.visita = extra; c.hist.push({ role: "assistant", content: `O Rafael sugeriu ${extra} pra visita. Pode ser?` }); await salvar(phone, c);
      return zapiTexto(RAFAEL, `Mandei pro cliente a sugestão: ${extra}. Quando ele responder eu te passo aqui.`);
    }
    if (/^(assumir|parar)/.test(cmd)) { c.status = "humano"; await salvar(phone, c); return zapiTexto(RAFAEL, `Pronto, o bot parou no pedido #${id}. Pode responder o cliente direto pelo número da empresa.`); }
    c.status = c.pedidoId ? "aguardando" : "bot"; await salvar(phone, c);
    return zapiTexto(RAFAEL, `Ok, o bot voltou a atender o cliente do pedido #${id}.`);
  });
}

async function enviarCliente(phone, c, msg) {
  const r = await zapiTexto(phone, msg);
  const id = r && (r.messageId || r.id || r.zaapId);
  if (id) c.botIds = [...(c.botIds || []), String(id), ...(r.zaapId && r.messageId ? [String(r.zaapId)] : [])].slice(-80);
  return r;
}

async function responder(phone) {
  const b = buffers.get(phone); buffers.delete(phone);
  if (!b || !b.partes.length) return;
  const c = await conversa(phone);
  if (c.status === "humano") return;
  const texto = b.partes.join("\n");
  // antes de responder: o Rafael já está atendendo esse cliente?
  const h = process.env.USAR_HISTORICO === "1" ? await historicoWhatsApp(phone, c) : null;
  if (h && h.rafaelRespondeu) {
    c.status = "humano"; await salvar(phone, c);
    console.log("Rafael já atende esse cliente, Suelen fica quieta", phone);
    return;
  }
  if (h && h.contexto && !c.hist.length) c.contexto = h.contexto.slice(-3000);
  if (c.status === "remarcando") {
    c.hist.push({ role: "user", content: texto }); c.status = "aguardando"; await salvar(phone, c);
    if (RAFAEL) await zapiTexto(RAFAEL, `💬 Cliente do pedido #${c.pedidoId} respondeu sobre o horário:\n"${texto.slice(0, 500)}"\n\nSe estiver ok: *ok ${c.pedidoId} ${c.visita}*`);
    await enviarCliente(phone, c, "Show, já passei pro Rafael! Ele te confirma por aqui 👍"); return salvar(phone, c);
  }
  if (c.status === "aguardando") {
    c.status = "humano"; await salvar(phone, c);
    console.log("Cliente com pedido voltou a falar, passou pro Rafael", phone);
    if (RAFAEL) await zapiTexto(RAFAEL, `💬 *${EMPRESA} · Cliente do pedido #${c.pedidoId}${c.pedido?.nome ? " (" + c.pedido.nome + ")" : ""}* mandou mensagem:\n"${texto.slice(0, 500)}"\n\nhttps://wa.me/${phone}\n_A Suelen não responde mais esse cliente. É com você._`);
    return;
  }
  if (!c.perfil && b.nome) c.perfil = b.nome;
  if (!c.hist.length && !c.avisado && RAFAEL) {
    c.avisado = true;
    const prev = texto.length > 300 ? texto.slice(0, 300) + "…" : texto;
    await zapiTexto(RAFAEL, `👀 *Novo atendimento da Suelen · ${EMPRESA}*\n\n*Contato:* ${b.nome ? b.nome + " " : ""}(+${phone})\n*Mensagem:* ${prev}\n\nhttps://wa.me/${phone}\n_Se quiser assumir, é só responder o cliente pelo número da empresa que a Suelen para._`);
  }
  c.hist.push({ role: "user", content: texto.slice(0, 2500) });
  if (b.temMidia) c.temFoto = true;
  try {
    const r = await chat({ messages: c.hist, imagens: b.imagens, temFoto: c.temFoto, jaRegistrado: !!c.pedidoId, contexto: c.contexto, perfil: c.perfil });
    c.hist.push({ role: "assistant", content: r.reply }); c.hist = c.hist.slice(-30);
    await enviarCliente(phone, c, r.reply);
    for (const f of r.fotos || []) { const x = await zapi("send-image", { phone, image: `${URL_PUBLICA}/fotos/${f}.jpg`, caption: `*${FOTOS[f]}*` }); if (x && (x.messageId || x.id)) c.botIds = [...(c.botIds || []), String(x.messageId || x.id)].slice(-80); }
    if (r.passar && !r.pedido) {
      c.status = "humano";
      console.log("Passou pro Rafael", phone);
      if (RAFAEL) await zapiTexto(RAFAEL, `📲 *Cliente pra você responder · ${EMPRESA}*\n\n*Contato:* ${r.passar.nome || "-"} (+${phone})\n*Assunto:* ${r.passar.motivo || "-"}\n\nA Suelen parou nesse cliente. Responde direto pelo número da empresa.`);
    }
    if (r.pedido && !c.pedidoId) {
      const id = await proximoPedido();
      c.pedidoId = id; c.status = "aguardando"; c.visita = r.pedido.visita || ""; c.pedido = r.pedido;
      await gravar(P + "p:" + id, phone); await gravar(P + "ultimo", id);
      console.log("Pedido registrado #" + id, phone, r.pedido.modalidade);
      if (RAFAEL) await zapiTexto(RAFAEL, resumoPedido(r.pedido, phone, id));
    }
    await salvar(phone, c);
  } catch (e) {
    console.error("Erro no atendimento", e.message || e);
    c.hist.pop(); await salvar(phone, c);
    await enviarCliente(phone, c, "Opa, deu uma instabilidade aqui. Pode mandar de novo?"); await salvar(phone, c);
  }
}

async function receberWhatsApp(ev) {
  const phone = String(ev.phone || "").replace(/\D/g, "");
  if (ev.fromMe) console.log("Saiu do número da empresa", phone, "tipo:", ev.type || "-", ev.fromApi ? "(api)" : "");
  if (ev.type && ev.type !== "ReceivedCallback") return;
  if (CLIENTES_RAFAEL.has(phone)) return;
  if (!phone || ev.isGroup || ev.isNewsletter || ev.broadcast || String(ev.phone).includes("@")) return;
  if (ev.messageId) { if (vistos.has(ev.messageId)) return; vistos.add(ev.messageId); }
  const quando = Number(ev.momment || ev.moment || 0);
  if (quando && (quando < ATIVO_DESDE || Date.now() - quando > 5 * 60 * 1000)) return; // mensagem antiga: não responde

  // mensagem que saiu do número da empresa: se não foi o bot, é o Rafael respondendo → bot para nesse cliente
  if (ev.fromMe) {
    await new Promise(r => setTimeout(r, 4000));
    if (enviadosPeloBot.has(String(ev.messageId)) || ev.fromApi) return;
    if (phone === RAFAEL) return;
    const c = await conversa(phone);
    if ((c.botIds || []).includes(String(ev.messageId))) return;
    const pend = buffers.get(phone); if (pend) { clearTimeout(pend.timer); buffers.delete(phone); }
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
  if (!b.nome) b.nome = String(ev.senderName || ev.chatName || "").slice(0, 60);
  b.partes.push(texto); if (imagem) b.imagens.push(imagem); if (midia) b.temMidia = true;
  clearTimeout(b.timer);
  b.timer = setTimeout(() => naFila(phone, () => responder(phone)), ESPERA_MS);
}

http.createServer(async (req, res) => {
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
  const foto = req.url.match(/^\/fotos\/([a-z-]+)\.jpg$/);
  if (foto && FOTOS[foto[1]]) {
    return fs.readFile(path.join(__dirname, foto[1] + ".jpg"), (err, data) => {
      if (err) { res.statusCode = 404; return res.end(); }
      res.setHeader("Content-Type", "image/jpeg"); res.setHeader("Cache-Control", "public, max-age=86400"); res.end(data);
    });
  }
  if (req.url === "/health") return res.end(`ok · IA: ${KEY ? "ligada" : "desligada"} · WhatsApp: ${usaZapi() ? "Z-API ok" : "desligado"} · Rafael: ${RAFAEL ? "sim" : "não"} · memória: ${REDIS_URL ? "Key Value" : "temporária"}`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(EMPRESA + " · atendimento pelo WhatsApp");
}).listen(PORT, () => console.log(`${EMPRESA} no ar na porta ${PORT} · IA: ${KEY ? "ligada" : "DESLIGADA (falta OPENAI_API_KEY)"} · WhatsApp: ${usaZapi() ? "Z-API ok" : "desligado"} · memória: ${REDIS_URL ? "Key Value" : "temporária"}`));
