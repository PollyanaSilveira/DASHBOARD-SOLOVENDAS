// Sincroniza leads do CV CRM (equipe SOLO House de Vendas) para um arquivo estático
// (data/cvcrm-live.json) no próprio repositório, que o dashboard (index.html) consome
// direto do GitHub Pages — sem depender de jsonbin.io e sem limite de requisições.
//
// Variáveis de ambiente esperadas (definidas como Secrets do GitHub Actions):
//   CVCRM_EMAIL   - e-mail do usuário que gerou o token de API do CV CRM
//   CVCRM_TOKEN   - token de API v1 do CV CRM
//
// Node 18+ (fetch nativo). Sem dependências externas.

import { writeFile } from 'node:fs/promises';

const CVCRM_BASE = 'https://almeidacarneiro.cvcrm.com.br/api/v1';
const IMOBILIARIA_ALVO = 'SOLO HOUSE DE VENDAS';
const OUT_FILE = new URL('../data/cvcrm-live.json', import.meta.url);
// O dashboard reporta o período Set/25 (início do time) até hoje — leads mais antigos
// (histórico do CV CRM anterior a isso) são ignorados na agregação.
const DATA_MINIMA = new Date('2025-09-01T00:00:00');

const { CVCRM_EMAIL, CVCRM_TOKEN } = process.env;
for (const [k, v] of Object.entries({ CVCRM_EMAIL, CVCRM_TOKEN })) {
  if (!v) { console.error(`Faltando variável de ambiente: ${k}`); process.exit(1); }
}

const MONTH_ABBR = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

// Mapeia nomes completos conhecidos da equipe SOLO para o "nome curto" já usado no dashboard.
// Qualquer corretor da SOLO House de Vendas que não estiver aqui usa o primeiro nome automaticamente.
const NOME_CURTO = {
  'TARCYLA SANTOS SODRÉ': 'Tarcyla',
  'SAMILA COSTA GONÇALVES': 'Samila',
};

function nomeCurto(nomeCompleto) {
  const norm = (nomeCompleto || '').trim().toUpperCase();
  if (NOME_CURTO[norm]) return NOME_CURTO[norm];
  const primeiro = norm.split(/\s+/)[0] || 'Sem nome';
  return primeiro.charAt(0) + primeiro.slice(1).toLowerCase();
}

function mesAno(dataCad) {
  // "2026-08-05 14:57:45" -> "Ago/26"
  const d = new Date(dataCad.replace(' ', 'T'));
  if (isNaN(d)) return null;
  if (d < DATA_MINIMA) return null; // fora do período do dashboard (Set/25 – hoje)
  return `${MONTH_ABBR[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`;
}

function ehTrafegoSdr(lead) {
  const midias = [lead.midia_principal, ...(lead.midias || [])].filter(Boolean).map(m => m.toLowerCase());
  return midias.some(m => m.includes('sdr'));
}

async function cvcrmGet(path, params = {}) {
  const url = new URL(CVCRM_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { email: CVCRM_EMAIL, token: CVCRM_TOKEN, Accept: 'application/json' },
  });
  if (res.status === 204) return { total: 0, items: [] };
  if (!res.ok) throw new Error(`CV CRM ${path} respondeu ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchAllLeads() {
  const PAGE = 1000;
  let offset = 0;
  let total = Infinity;
  const leads = [];
  while (offset < total) {
    const json = await cvcrmGet('/comercial/leads', { limit: PAGE, offset });
    total = json.total ?? 0;
    leads.push(...(json.leads || []));
    offset += PAGE;
    if (!json.leads || json.leads.length === 0) break;
  }
  return leads;
}

function aggregate(leads) {
  const byKey = new Map(); // "corretor|mes" -> {c,m,ln,ls}
  let ignorados = 0;
  for (const lead of leads) {
    const imob = lead.imobiliaria?.nome?.trim().toUpperCase();
    if (imob !== IMOBILIARIA_ALVO) { ignorados++; continue; }
    const corretorNome = lead.corretor?.nome;
    if (!corretorNome) { ignorados++; continue; }
    const m = mesAno(lead.data_cad);
    if (!m) { ignorados++; continue; }
    const c = nomeCurto(corretorNome);
    const key = `${c}|${m}`;
    if (!byKey.has(key)) byKey.set(key, { c, m, ln: 0, ls: 0 });
    const bucket = byKey.get(key);
    if (ehTrafegoSdr(lead)) bucket.ls++; else bucket.ln++;
  }
  return { counters: [...byKey.values()], ignorados };
}

async function writeLiveFile(counters) {
  const body = {
    counters,
    lastEvent: { ts: new Date().toISOString(), source: 'github-actions:sync-cvcrm' },
  };
  await writeFile(OUT_FILE, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

async function main() {
  console.log('Buscando leads no CV CRM...');
  const leads = await fetchAllLeads();
  console.log(`Total de leads recebidos: ${leads.length}`);

  const { counters, ignorados } = aggregate(leads);
  console.log(`Corretor/mês agregados: ${counters.length} (leads fora do escopo SOLO/sem data: ${ignorados})`);
  console.table(counters);

  await writeLiveFile(counters);
  console.log('✅ data/cvcrm-live.json atualizado com sucesso.');
}

main().catch(err => { console.error('❌ Falhou:', err); process.exit(1); });
