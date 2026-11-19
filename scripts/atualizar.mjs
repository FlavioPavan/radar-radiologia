// Pipeline diário (custo zero): busca vagas, estágios e concursos via Gemini + Google Search,
// deduplica e grava data.json. Em caso de 429 ou instabilidade temporária, preserva data.json.
import { readFileSync, writeFileSync } from 'node:fs';

const key = process.env.GEMINI_API_KEY?.trim();
if (!key) {
  throw new Error('Secret GEMINI_API_KEY ausente em Settings > Secrets and variables > Actions.');
}

const MODEL = 'gemini-3.8-flash';
const REG = ['Capital', 'ABCD', 'Litoral'];
const ST = ['Aberto', 'Andamento', 'Previsto', 'Monitoramento'];
const TIPOS = ['Concurso', 'Vaga', 'Estágio'];
const DAY = 86_400_000;

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const safeUrl = (u) => {
  try {
    const parsed = new URL(String(u ?? '').trim());
    return /^https?:$/.test(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
};

const hojeSP = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());

const dataBR = () =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date());

const hoje = hojeSP();

const prompt = `Hoje é ${dataBR()} (${hoje}). Pesquise na web oportunidades ATIVAS para Tecnólogo em Radiologia, Técnico em Radiologia ou Estágio em Radiologia (inclui raios X, tomografia, ressonância, mamografia, hemodinâmica e radiodiagnóstico) nas regiões:
- Capital: São Paulo
- ABCD: Santo André, São Bernardo do Campo, São Caetano do Sul, Diadema, Mauá, Ribeirão Pires, Rio Grande da Serra
- Litoral: Baixada Santista (Santos, São Vicente, Praia Grande, Guarujá, Cubatão) e Litoral Norte

Busque especificamente em portais de emprego e estágio (LinkedIn, Indeed, Gupy, Vagas.com, InfoJobs, Catho, CIEE, Nube e sites de hospitais/clínicas/FIDI/IAMSPE) além de concursos e processos seletivos abertos ou previstos.
Classifique "tipo" estritamente como "Vaga", "Estágio" ou "Concurso".
Exclua vagas ou editais encerrados. Não invente dados; use "" quando não houver informação confirmada.

Responda SOMENTE com um array JSON válido (sem crases ou markdown). Cada objeto deve conter:
{
  "tipo": "Vaga" | "Estágio" | "Concurso",
  "orgao": "Nome da empresa, hospital, clínica ou órgão público",
  "cargo": "Título da vaga, estágio ou cargo do edital",
  "banca": "LinkedIn, Indeed, Gupy, Vagas.com, InfoJobs, CIEE, banca ou instituição",
  "salario": "Valor ou bolsa-auxílio ou 'A combinar'",
  "regiao": "Capital" | "ABCD" | "Litoral",
  "prazo": "Descrição curta do prazo ou 'Inscrições abertas'",
  "encerra": "AAAA-MM-DD ou ''",
  "status": "Aberto" | "Andamento" | "Previsto" | "Monitoramento",
  "link": "URL direta da vaga/edital ou ''"
}`;

function extrairArrayJson(texto) {
  const limpo = String(texto ?? '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const ini = limpo.indexOf('[');
  const fim = limpo.lastIndexOf(']');
  if (ini === -1 || fim === -1 || fim < ini) {
    throw new Error('Resposta do Gemini não contém array JSON válido.');
  }

  const dados = JSON.parse(limpo.slice(ini, fim + 1));
  if (!Array.isArray(dados)) {
    throw new Error('JSON retornado não é um array.');
  }
  return dados;
}

function carregarBase() {
  try {
    const raw = JSON.parse(readFileSync('data.json', 'utf8'));
    return {
      atualizado: Number(raw?.atualizado) || 0,
      itens: Array.isArray(raw?.itens) ? raw.itens : []
    };
  } catch {
    return { atualizado: 0, itens: [] };
  }
}

async function buscarGemini() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 65_000);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: { temperature: 0.1 }
        })
      }
    );

    if (!res.ok) {
      const detalhe = await res.text().catch(() => '');
      const erro = new Error(`HTTP ${res.status}: ${detalhe.slice(0, 350)}`);
      erro.status = res.status;
      throw erro;
    }

    const payload = await res.json();
    const texto = (payload.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('');

    return extrairArrayJson(texto);
  } finally {
    clearTimeout(timer);
  }
}

const anterior = carregarBase();
const ativosAnteriores = anterior.itens.filter((i) => !i?.encerra || i.encerra >= hoje);

let rawItens = null;
try {
  rawItens = await buscarGemini();
} catch (err) {
  console.warn(`Falha na consulta Gemini: ${err.message}`);
  const temporario =
    err.status === 429 ||
    (typeof err.status === 'number' && err.status >= 500) ||
    err.name === 'AbortError' ||
    String(err.message).includes('429');

  if (temporario) {
    console.warn('Limite ou instabilidade temporária. Mantendo data.json anterior sem falhar o workflow.');
    writeFileSync(
      'data.json',
      JSON.stringify({ atualizado: anterior.atualizado, itens: ativosAnteriores }, null, 2) + '\n',
      'utf8'
    );
    process.exit(0);
  }
  throw err;
}

const agora = Date.now();
const prevMap = new Map(ativosAnteriores.map((i) => [i.id, i]));
const vistosNoLote = new Set();

const frescos = [];
for (const x of rawItens) {
  if (!x || typeof x !== 'object' || !x.orgao || !x.cargo) continue;

  const tipo = TIPOS.includes(x.tipo) ? x.tipo : 'Vaga';
  const orgao = String(x.orgao).trim().slice(0, 140);
  const cargo = String(x.cargo).trim().slice(0, 160);
  const regiao = REG.includes(x.regiao) ? x.regiao : 'Capital';

  const slug = norm(`${tipo} ${orgao} ${cargo} ${regiao}`)
    .replace(/\s+/g, '-')
    .slice(0, 72);
  const id = `ia-${slug}`;

  if (!slug || vistosNoLote.has(id)) continue;
  vistosNoLote.add(id);

  const encerraStr = String(x.encerra ?? '').trim();
  const encerra = /^\d{4}-\d{2}-\d{2}$/.test(encerraStr) ? encerraStr : '';
  if (encerra && encerra < hoje) continue;

  const anteriorItem = prevMap.get(id);

  frescos.push({
    id,
    tipo,
    orgao,
    cargo,
    banca: String(x.banca ?? '').trim().slice(0, 80),
    salario: String(x.salario ?? '').trim().slice(0, 80),
    regiao,
    prazo: String(x.prazo ?? '').trim().slice(0, 100),
    encerra,
    status: ST.includes(x.status) ? x.status : 'Aberto',
    link: safeUrl(x.link),
    primeiro: anteriorItem?.primeiro || agora,
    visto: agora
  });
}

const idsFrescos = new Set(frescos.map((i) => i.id));
const retidos = ativosAnteriores.filter(
  (i) =>
    i?.id &&
    !idsFrescos.has(i.id) &&
    (!i.encerra || i.encerra >= hoje) &&
    agora - Number(i.visto || i.primeiro || 0) < 3 * DAY
);

const itens = [...frescos, ...retidos];

writeFileSync(
  'data.json',
  JSON.stringify({ atualizado: agora, itens }, null, 2) + '\n',
  'utf8'
);

console.log(`Sucesso: ${itens.length} registros (${frescos.length} atuais + ${retidos.length} retidos).`);
