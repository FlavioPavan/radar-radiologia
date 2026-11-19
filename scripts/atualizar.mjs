// Pipeline diário 100% gratuito: coleta vagas e concursos de Radiologia em SP
// direto de páginas públicas (Gupy e PCI Concursos). Sem IA, sem chave de API.
// Grava data.json. Se TODAS as fontes falharem, mantém os dados anteriores e
// falha o workflow para o problema aparecer em vermelho na aba Actions.
import { readFileSync, writeFileSync } from 'node:fs';

const DAY = 86_400_000;
const UA =
  'Mozilla/5.0 (compatible; RadarRadiologiaSP/1.0; +https://github.com/FlavioPavan/radar-radiologia)';

// Termos buscados na Gupy (filtrados pelo estado de São Paulo)
const GUPY_TERMOS = [
  'radiologia',
  'tecnico em radiologia',
  'tecnologo em radiologia',
  'estagio radiologia',
  'tomografia',
  'ressonancia magnetica'
];

// Páginas de cargo da PCI Concursos
const PCI_CARGOS = [
  ['tecnico-em-radiologia', 'Técnico em Radiologia'],
  ['tecnologo-em-radiologia', 'Tecnólogo em Radiologia'],
  ['tecnico-de-radiologia', 'Técnico em Radiologia']
];

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const CIDADES = {
  Capital: ['sao paulo'],
  ABCD: ['santo andre', 'sao bernardo do campo', 'sao caetano do sul', 'diadema', 'maua', 'ribeirao pires', 'rio grande da serra'],
  Litoral: ['santos', 'sao vicente', 'praia grande', 'guaruja', 'cubatao', 'bertioga', 'mongagua', 'itanhaem', 'peruibe',
    'ubatuba', 'caraguatatuba', 'sao sebastiao', 'ilhabela']
};

function regiaoDe(texto) {
  const t = ` ${norm(texto)} `;
  for (const [reg, lista] of Object.entries(CIDADES)) {
    if (lista.some((c) => t.includes(` ${c} `))) return reg;
  }
  return 'Outras';
}

const safeUrl = (u) => {
  try {
    const p = new URL(String(u ?? '').trim());
    return /^https?:$/.test(p.protocol) ? p.href : '';
  } catch {
    return '';
  }
};

const semQuery = (u) => safeUrl(u).replace(/[?#].*$/, '');

const decodeHtml = (s) =>
  String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hoje = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());

async function baixar(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Gupy ----------
export function parseGupy(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Gupy: __NEXT_DATA__ não encontrado (o site pode ter mudado).');
  const lista = JSON.parse(m[1])?.props?.pageProps?.initialJobList?.data;
  if (!Array.isArray(lista)) throw new Error('Gupy: lista de vagas não encontrada.');
  return lista
    .filter((j) => j && j.name && /radiolog|raio|tomograf|resson|mamograf|hemodin|imagem/i.test(j.name))
    .filter((j) => !/m[eé]dic|enfermeir|recepcion|biom[eé]dic|f[ií]sico/i.test(j.name))
    .filter((j) => /s[aã]o paulo|^sp$/i.test(String(j.state || '')))
    .map((j) => {
      let orgao = String(j.careerPageName || '').trim();
      if (!orgao || /p[aá]gina de carreira/i.test(orgao)) {
        try { orgao = new URL(j.jobUrl).hostname.split('.')[0]; } catch { orgao = 'Empresa (Gupy)'; }
      }
      const encerra = /^\d{4}-\d{2}-\d{2}/.test(String(j.applicationDeadline || '')) ? j.applicationDeadline.slice(0, 10) : '';
      return {
        tipo: /est[aá]gi/i.test(j.name) ? 'Estágio' : 'Vaga',
        orgao,
        cargo: j.name,
        banca: 'Gupy',
        salario: '',
        regiao: regiaoDe(j.city),
        cidade: j.city || '',
        prazo: /talent_pool/.test(j.type || '') ? 'Banco de talentos' : 'Inscrições abertas',
        encerra,
        status: 'Aberto',
        link: semQuery(j.jobUrl)
      };
    });
}

// ---------- PCI Concursos ----------
export function parsePci(html, cargoPadrao) {
  const out = [];
  const re = /<a\b[^>]*href="(https?:\/\/www\.pciconcursos\.com\.br\/noticias\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const texto = decodeHtml(m[2].replace(/<[^>]+>/g, ' '));
    const uf = texto.match(/\s-\s([A-Z]{2})\s*$/);
    if (!uf || uf[1] !== 'SP') continue;
    const orgao = texto.replace(/\s-\s[A-Z]{2}\s*$/, '').trim();
    const cidade = orgao.replace(/^(prefeitura|c[aâ]mara|munic[ií]pio|fundo municipal de sa[uú]de|secretaria[^d]*)\s+(municipal\s+)?(de|do|da)\s+/i, '');
    out.push({
      tipo: 'Concurso',
      orgao,
      cargo: cargoPadrao,
      banca: 'PCI Concursos (ver edital)',
      salario: '',
      regiao: regiaoDe(cidade),
      cidade,
      prazo: 'Ver datas no edital',
      encerra: '',
      status: 'Aberto',
      link: semQuery(m[1])
    });
  }
  return out;
}

function carregarBase() {
  try {
    const raw = JSON.parse(readFileSync('data.json', 'utf8'));
    return { atualizado: Number(raw?.atualizado) || 0, itens: Array.isArray(raw?.itens) ? raw.itens : [] };
  } catch {
    return { atualizado: 0, itens: [] };
  }
}

async function main() {
  const anterior = carregarBase();
  const ativosAnteriores = anterior.itens.filter((i) => !i?.encerra || i.encerra >= hoje);

  const coletados = [];
  const erros = [];
  let fontesOk = 0;

  for (const termo of GUPY_TERMOS) {
    const url = `https://portal.gupy.io/job-search/term=${encodeURIComponent(termo)}&state=${encodeURIComponent('São Paulo')}`;
    try {
      const itens = parseGupy(await baixar(url));
      coletados.push(...itens);
      fontesOk++;
      console.log(`Gupy "${termo}": ${itens.length} vagas em SP.`);
    } catch (e) {
      erros.push(`Gupy "${termo}": ${e.message}`);
    }
  }

  for (const [slug, cargo] of PCI_CARGOS) {
    try {
      const itens = parsePci(await baixar(`https://www.pciconcursos.com.br/cargos/${slug}`), cargo);
      coletados.push(...itens);
      fontesOk++;
      console.log(`PCI ${slug}: ${itens.length} concursos em SP.`);
    } catch (e) {
      erros.push(`PCI ${slug}: ${e.message}`);
    }
  }

  erros.forEach((e) => console.warn('Aviso:', e));

  if (fontesOk === 0) {
    console.error('Nenhuma fonte respondeu. Mantendo data.json anterior.');
    process.exitCode = 1;
    return;
  }

  const agora = Date.now();
  const prevMap = new Map(ativosAnteriores.map((i) => [i.id, i]));
  const vistos = new Set();
  const frescos = [];

  for (const x of coletados) {
    if (!x.orgao || !x.cargo) continue;
    if (x.encerra && x.encerra < hoje) continue;
    const slug = norm(`${x.tipo} ${x.orgao} ${x.cargo} ${x.cidade}`).replace(/\s+/g, '-').slice(0, 80);
    const id = `auto-${slug}`;
    const chave = x.link || id; // o mesmo edital pode aparecer em mais de uma página de cargo
    if (!slug || vistos.has(id) || vistos.has(chave)) continue;
    vistos.add(id);
    vistos.add(chave);
    const ant = prevMap.get(id);
    frescos.push({
      id,
      ...x,
      orgao: String(x.orgao).slice(0, 140),
      cargo: String(x.cargo).slice(0, 160),
      primeiro: ant?.primeiro || agora,
      visto: agora
    });
  }

  // Mantém por até 3 dias o que sumiu temporariamente da fonte
  const ids = new Set(frescos.map((i) => i.id));
  const retidos = ativosAnteriores.filter(
    (i) => i?.id && !ids.has(i.id) && agora - Number(i.visto || i.primeiro || 0) < 3 * DAY
  );

  const itens = [...frescos, ...retidos];
  writeFileSync('data.json', JSON.stringify({ atualizado: agora, fonte: 'Gupy + PCI Concursos', itens }, null, 2) + '\n', 'utf8');
  console.log(`Sucesso: ${itens.length} registros (${frescos.length} atuais + ${retidos.length} retidos).`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  await main();
}
