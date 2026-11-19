// Roda no GitHub Actions: busca no Gemini com Google Search e grava data.json.
import { readFileSync, writeFileSync } from 'node:fs';

const key = process.env.GEMINI_API_KEY?.trim();
if (!key) {
  throw new Error('Defina o secret GEMINI_API_KEY em Settings > Secrets and variables > Actions.');
}

const REG = ['Capital', 'ABCD', 'Litoral'];
const ST = ['Aberto', 'Andamento', 'Previsto', 'Monitoramento'];
const DAY = 86_400_000;

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const safeUrl = (u) => {
  try {
    const x = new URL(String(u ?? '').trim());
    return /^https?:$/.test(x.protocol) ? x.href : '';
  } catch {
    return '';
  }
};

const hojeSP = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());

const hoje = hojeSP();

const prompt = `Hoje é ${new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date())}. Pesquise na web oportunidades ATIVAS HOJE para Tecnólogo em Radiologia ou Técnico em Radiologia (inclui tomografia, ressonância, mamografia, hemodinâmica e radiodiagnóstico) em São Paulo capital, Grande ABCD (Santo André, São Bernardo do Campo, São Caetano do Sul, Diadema, Mauá, Ribeirão Pires, Rio Grande da Serra) e Litoral Paulista (Baixada Santista e Litoral Norte).
Inclua dois tipos: "Concurso" (concursos públicos e processos seletivos com edital) e "Vaga" (vagas de emprego em hospitais, clínicas e laboratórios, em Gupy, Vagas.com, Indeed, InfoJobs, LinkedIn e páginas de carreira).
Inclua só o que está com inscrições abertas, em andamento ou com edital previsto confirmado. Exclua tudo que já encerrou.
Responda SOMENTE com um array JSON válido, sem markdown. Chaves de cada item: "tipo" ("Concurso" ou "Vaga"), "orgao", "cargo", "banca", "salario", "regiao" ("Capital", "ABCD" ou "Litoral"), "prazo", "encerra" (AAAA-MM-DD ou ""), "status" ("Aberto", "Andamento", "Previsto" ou "Monitoramento") e "link".
Não invente dados. Se nada for encontrado, responda [].`;

function extrairArrayJson(texto) {
  const limpo = String(texto ?? '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const inicio = limpo.indexOf('[');
  const fim = limpo.lastIndexOf(']');
  if (inicio === -1 || fim === -1 || fim < inicio) {
    throw new Error('Resposta do Gemini não contém um array JSON válido.');
  }

  const parsed = JSON.parse(limpo.slice(inicio, fim + 1));
  if (!Array.isArray(parsed)) {
    throw new Error('O JSON retornado não é um array.');
  }
  return parsed;
}

async function consultar() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        signal: controller.signal,
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

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`Gemini HTTP ${resp.status}: ${errBody.slice(0, 300)}`);
    }

    const data = await resp.json();
    const texto = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('');

    return extrairArrayJson(texto);
  } finally {
    clearTimeout(timeout);
  }
}

function carregarAnterior() {
  try {
    const raw = JSON.parse(readFileSync('data.json', 'utf8'));
    return Array.isArray(raw?.itens) ? raw.itens : [];
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let arr = [];
for (let tentativa = 1; tentativa <= 2; tentativa++) {
  try {
    arr = await consultar();
    break;
  } catch (err) {
    console.warn(`Tentativa ${tentativa} falhou: ${err.message}`);
    if (tentativa === 2) {
      throw err;
    }
    await sleep(2500);
  }
}

const agora = Date.now();
const anteriores = carregarAnterior();
const mapaAnterior = new Map(anteriores.map((i) => [i.id, i]));

const frescos = arr
  .filter((x) => x && typeof x === 'object' && x.orgao && x.cargo)
  .map((x) => {
    const tipo = x.tipo === 'Vaga' ? 'Vaga' : 'Concurso';
    const orgao = String(x.orgao).trim().slice(0, 140);
    const cargo = String(x.cargo).trim().slice(0, 160);
    const id =
      'ia-' +
      norm(`${tipo}-${orgao}-${cargo}`)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 70);

    const encerraRaw = String(x.encerra ?? '').trim();
    const encerra = /^\d{4}-\d{2}-\d{2}$/.test(encerraRaw) ? encerraRaw : '';
    const anterior = mapaAnterior.get(id);

    return {
      id,
      tipo,
      orgao,
      cargo,
      banca: String(x.banca ?? '').trim().slice(0, 80),
      salario: String(x.salario ?? '').trim().slice(0, 80),
      regiao: REG.includes(x.regiao) ? x.regiao : 'Capital',
      prazo: String(x.prazo ?? '').trim().slice(0, 100),
      encerra,
      status: ST.includes(x.status) ? x.status : 'Monitoramento',
      link: safeUrl(x.link),
      primeiro: anterior?.primeiro || agora,
      visto: agora
    };
  })
  .filter((i) => !i.encerra || i.encerra >= hoje);

const idsFrescos = new Set(frescos.map((i) => i.id));
const tolerancia = anteriores.filter(
  (i) =>
    i?.id &&
    !idsFrescos.has(i.id) &&
    (!i.encerra || i.encerra >= hoje) &&
    agora - Number(i.visto || i.primeiro || 0) < 2 * DAY
);

const itens = [...frescos, ...tolerancia];

writeFileSync(
  'data.json',
  JSON.stringify({ atualizado: agora, itens }, null, 2) + '\n',
  'utf8'
);

console.log(`Concluído: ${itens.length} oportunidades em data.json.`);
