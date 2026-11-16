// Roda no GitHub Actions: busca no Gemini e grava data.json. Requer o secret GEMINI_API_KEY.
import { writeFileSync } from 'node:fs';
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error('Defina o secret GEMINI_API_KEY no repositório.');
const REG = ['Capital', 'ABCD', 'Litoral'], ST = ['Aberto', 'Andamento', 'Previsto', 'Monitoramento'];
const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const url = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
const hoje = new Date().toISOString().slice(0, 10);
const prompt = `Hoje é ${hoje}. Pesquise na web oportunidades ATIVAS HOJE para Tecnólogo em Radiologia ou Técnico em Radiologia (inclui tomografia, ressonância e radiodiagnóstico) em São Paulo capital, Grande ABCD (Santo André, São Bernardo, São Caetano, Diadema) e Litoral Paulista.
Inclua dois tipos: "Concurso" (concursos públicos e processos seletivos com edital) e "Vaga" (vagas de emprego em hospitais, clínicas e laboratórios, em Gupy, Vagas.com, Indeed, InfoJobs, LinkedIn e páginas de carreira).
Inclua só o que está com inscrições abertas, em andamento ou com edital previsto confirmado. Exclua tudo que já encerrou.
Responda SOMENTE com um array JSON válido, sem markdown. Chaves: "tipo" ("Concurso" ou "Vaga"), "orgao", "cargo", "banca", "salario", "regiao" ("Capital", "ABCD" ou "Litoral"), "prazo", "encerra" (AAAA-MM-DD ou ""), "status" ("Aberto", "Andamento", "Previsto" ou "Monitoramento") e "link".
Não invente dados. Se nada for encontrado, responda [].`;

async function consultar() {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ googleSearch: {} }], generationConfig: { temperature: 0.1 } })
  });
  if (!r.ok) throw new Error(`Gemini respondeu ${r.status}: ${await r.text()}`);
  const d = await r.json();
  const t = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
}

let arr;
try { arr = await consultar(); } catch (e) { console.warn('Tentando de novo:', e.message); arr = await consultar(); }

const itens = arr.filter(x => x?.orgao && x?.cargo).map(x => {
  const tipo = x.tipo === 'Vaga' ? 'Vaga' : 'Concurso';
  return {
    id: 'ia-' + norm(tipo + x.orgao + x.cargo).replace(/[^a-z0-9]+/g, '-').slice(0, 70), tipo,
    orgao: String(x.orgao).slice(0, 140), cargo: String(x.cargo).slice(0, 160),
    banca: String(x.banca || '').slice(0, 80), salario: String(x.salario || '').slice(0, 80),
    regiao: REG.includes(x.regiao) ? x.regiao : 'Capital', prazo: String(x.prazo || '').slice(0, 100),
    encerra: /^\d{4}-\d{2}-\d{2}$/.test(x.encerra) ? x.encerra : '',
    status: ST.includes(x.status) ? x.status : 'Monitoramento', link: url(x.link), primeiro: Date.now()
  };
}).filter(i => !i.encerra || i.encerra >= hoje);

writeFileSync('data.json', JSON.stringify({ atualizado: Date.now(), itens }, null, 1));
console.log(`${itens.length} oportunidades gravadas.`);
