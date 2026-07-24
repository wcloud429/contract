/*
  fetch-laws.js — 법제처(국가법령정보 공동활용) OpenAPI 조문+별표 수집 스크립트 (A안: 빌드타임 수집)
  ─────────────────────────────────────────────────────────────────────────
  · 로컬에서 `node fetch-laws.js` 로 실행한다.
  · .env 의 LAW_API_OC 를 읽어 법제처 API를 호출하고, index.html 이 읽는 data.json 을 만든다.
  · 3계층(법률·시행령·시행규칙) × 국가/지방 을 각 주제별로 수집한다.
  · 조문이 "별표 N과 같다"처럼 참조하는 별표(별지 서식 제외)의 본문 텍스트도 함께 수집한다.
  · 법령은 6개(3계층 × 국가/지방)만 호출해 캐시(조문+별표)한다.
  · Node 내장 모듈만 사용. ⚠️ 키(OC)는 .env 에서만 읽으며 data.json 에는 포함되지 않는다.

  data.json 구조:
  {
    source, generatedAt, note,
    topics: [
      { id, title, tiers: [
          { key, label, articleNo:{national,local},
            national: { text: string|null, tables: [{ title, content }] },
            local:    { text: string|null, tables: [{ title, content }] } }
      ] }
    ]
  }
*/
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ── .env 로드 ──────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('[오류] .env 파일이 없습니다. .env.example 을 복사해 .env 로 만들고 LAW_API_OC 를 채우세요.');
    process.exit(1);
  }
  const env = {};
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim();
  });
  return env;
}

// ── 계층별 국가/지방 법령명 ─────────────────────────────────────────────
const TIERS = [
  { key: 'law',    label: '법률',    national: '국가를 당사자로 하는 계약에 관한 법률',          local: '지방자치단체를 당사자로 하는 계약에 관한 법률' },
  { key: 'decree', label: '시행령',   national: '국가를 당사자로 하는 계약에 관한 법률 시행령',    local: '지방자치단체를 당사자로 하는 계약에 관한 법률 시행령' },
  { key: 'rule',   label: '시행규칙', national: '국가를 당사자로 하는 계약에 관한 법률 시행규칙',  local: '지방자치단체를 당사자로 하는 계약에 관한 법률 시행규칙' }
];

// ── 주제 × 계층별 조문번호 (탐색으로 확인, 담당자 검토 권장) ──────────────
const TOPICS = [
  {
    id: 'bid-restriction', title: '입찰참가자격 제한',
    articles: { law: { national: '27', local: '31' }, decree: { national: '76', local: '92' }, rule: { national: '76', local: '76' } }
  },
  {
    id: 'penalty-surcharge', title: '과징금',
    articles: { law: { national: '27의2', local: '31의2' }, decree: { national: '76의2', local: '92의2' }, rule: { national: '77의2', local: '77의2' } }
  },
  {
    id: 'delay-damages', title: '지체상금(지연배상금)',
    articles: { law: { national: '26', local: '30' }, decree: { national: '74', local: '90' }, rule: { national: '75', local: '75' } }
  },
  {
    id: 'bid-guarantee', title: '입찰보증금',
    articles: { law: { national: '9', local: '12' }, decree: { national: '37', local: '37' }, rule: { national: '43', local: '41' } }
  },
  {
    id: 'contract-guarantee', title: '계약보증금',
    // 지방 계약보증금율(100분의 10)은 시행령 제51조(계약의 이행보증)에 있음 (제52조는 납부방법)
    articles: { law: { national: '12', local: '15' }, decree: { national: '50', local: '51' }, rule: { national: '51', local: '49' } }
  }
];

// ── HTTP GET (재시도 포함) ──────────────────────────────────────────────
function httpGetOnce(url) {
  return new Promise(function (resolve, reject) {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: body }); });
    });
    req.on('error', reject);
    req.setTimeout(20000, function () { req.destroy(new Error('timeout')); });
  });
}
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function httpGet(url, retries) {
  retries = retries == null ? 3 : retries;
  for (let attempt = 1; ; attempt++) {
    try { return await httpGetOnce(url); }
    catch (e) {
      if (attempt > retries) throw e;
      console.warn('  [재시도 ' + attempt + '/' + retries + '] ' + (e.code || e.message));
      await delay(800 * attempt);
    }
  }
}

// ── 법령(조문 + 별표) 조회 + 캐시 ───────────────────────────────────────
const _cache = {};
async function getLaw(env, lawName) {
  if (_cache[lawName]) return _cache[lawName];
  const oc = env.LAW_API_OC;
  const base = env.LAW_API_BASE || 'https://www.law.go.kr/DRF';
  const type = env.LAW_API_TYPE || 'JSON';
  const url = base + '/lawService.do?OC=' + encodeURIComponent(oc) +
    '&target=law&type=' + encodeURIComponent(type) + '&LM=' + encodeURIComponent(lawName);
  const res = await httpGet(url);
  let units = [], tables = [];
  if (res.status === 200) {
    try {
      const law = (JSON.parse(res.body) || {})['법령'] || {};
      units = ((law['조문'] || {})['조문단위']) || [];
      tables = ((law['별표'] || {})['별표단위']) || [];
      if (!Array.isArray(units)) units = units ? [units] : [];
      if (!Array.isArray(tables)) tables = tables ? [tables] : [];
    } catch (e) { console.warn('  [경고] "' + lawName + '" 파싱 실패.'); }
  } else {
    console.warn('  [경고] "' + lawName + '" 응답 코드 ' + res.status);
  }
  _cache[lawName] = { units: units, tables: tables };
  return _cache[lawName];
}

// ── 조문/별표 유틸 ──────────────────────────────────────────────────────
function parseArticleNo(spec) {
  const s = String(spec);
  const idx = s.indexOf('의');
  if (idx >= 0) return { num: s.slice(0, idx), branch: s.slice(idx + 1) };
  return { num: s, branch: null };
}
// 법령정보 조문에 박히는 <img> 수식 이미지·기타 HTML 태그 제거 (<개정…> 등 한글 시작 표기는 보존)
function stripHtml(s) {
  return String(s)
    .replace(/<img\b[^>]*>[\s\S]*?<\/img>/gi, ' ')   // 이미지+수식 블록 통째 제거
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ');            // 남은 HTML 태그 제거
}
function clean(s) {
  return stripHtml(String(s))
    .replace(/,(?:\s*,)+/g, ',')   // 이미지 제거로 생기는 빈 콤마 연속 정리
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
}

// HTML 엔티티 디코드 (별표내용은 &lt; 등이 그대로 들어있음)
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function collectText(unit) {
  const parts = [];
  if (unit['조문내용']) parts.push(clean(unit['조문내용']));
  let hang = unit['항'];
  if (hang) {
    if (!Array.isArray(hang)) hang = [hang];
    hang.forEach(function (h) {
      if (h && h['항내용']) parts.push(clean(h['항내용']));
      let ho = h && h['호'];
      if (ho) {
        if (!Array.isArray(ho)) ho = [ho];
        ho.forEach(function (o) {
          if (o && o['호내용']) parts.push(clean(o['호내용']));
          let mok = o && o['목'];
          if (mok) {
            if (!Array.isArray(mok)) mok = [mok];
            mok.forEach(function (mk) { if (mk && mk['목내용']) parts.push(clean(mk['목내용'])); });
          }
        });
      }
    });
  }
  return parts.join(' ');
}

function findArticle(units, articleNo) {
  const want = parseArticleNo(articleNo);
  const hit = (units || []).find(function (u) {
    if (String(u['조문번호']) !== String(want.num)) return false;
    const gaji = u['조문가지번호'];
    if (want.branch) return String(gaji) === String(want.branch);
    return !gaji || String(gaji) === '0';
  });
  return hit ? (collectText(hit) || null) : null;
}

// 조문 텍스트가 참조하는 별표 번호들 (예: "별표 2", "별표 제3호" → [2,3])
function referencedTableNos(articleText) {
  const set = {};
  const re = /별표\s*제?\s*(\d+)/g;
  let m;
  while ((m = re.exec(articleText))) set[parseInt(m[1], 10)] = true;
  return Object.keys(set).map(Number);
}

// 별표내용은 원본 줄바꿈이 콤마(,)로 치환돼 한 줄로 온다.
// → 콤마를 줄바꿈으로 되돌리되, 1,000 같은 숫자 사이 콤마는 그대로 둔다.
// (드물게 문장 내 실제 콤마도 줄바꿈되지만 가독성 향상이 더 크다.)
function normalizeTableContent(s) {
  return decodeEntities(String(s))
    // \d,\d (숫자 콤마)는 그대로 유지, 그 외 콤마만 줄바꿈으로
    .replace(/\d,\d|,/g, function (match) { return match.length === 3 ? match : '\n'; })
    .split('\n')
    .map(function (line) { return line.replace(/\s+$/, ''); })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')   // 과한 빈 줄 축소
    .trim();
}

// 별표단위에서 번호가 일치하고 '이 조문(제N조)을 참조하는' 별표(별지 서식 제외)만 뽑는다.
// (조문 텍스트의 "별표 N"이 타 법령/타 조문 별표를 가리키는데 같은 법령에 동일 번호 별표가
//  있는 경우의 오연결을 막기 위해, 별표 제목이 해당 조문을 참조하는지 확인한다.)
function findTables(tables, nos, articleNo) {
  const parsed = parseArticleNo(articleNo);
  const refRe = parsed.branch
    ? new RegExp('제' + parsed.num + '조의' + parsed.branch)
    : new RegExp('제' + parsed.num + '조(?!의)');
  const out = [];
  nos.forEach(function (no) {
    const hit = (tables || []).find(function (b) {
      return b['별표구분'] === '별표' && parseInt(b['별표번호'], 10) === no;
    });
    if (!hit) return;
    const title = String(hit['별표제목'] || '');
    if (!refRe.test(title)) return;   // 이 조문을 참조하지 않는 별표는 건너뜀
    out.push({
      title: decodeEntities(title || ('별표 ' + no)).replace(/\s+/g, ' ').trim(),
      content: normalizeTableContent(hit['별표내용'] || '')
    });
  });
  return out;
}

// 한 쪽(국가 또는 지방)의 조문 + 참조 별표를 구성한다.
function buildSide(law, articleNo) {
  const text = findArticle(law.units, articleNo);
  let tables = [];
  if (text) tables = findTables(law.tables, referencedTableNos(text), articleNo);
  return { text: text, tables: tables };
}

// ── 메인 ───────────────────────────────────────────────────────────────
async function main() {
  const env = loadEnv();
  if (!env.LAW_API_OC || /여기에_발급/.test(env.LAW_API_OC)) {
    console.error('[오류] LAW_API_OC 가 설정되지 않았습니다. .env 에 발급받은 OC 값을 넣으세요.');
    process.exit(1);
  }

  const topics = [];
  let missing = 0, tableCount = 0;
  for (const t of TOPICS) {
    console.log('수집 중: ' + t.title);
    const tiers = [];
    for (const tier of TIERS) {
      const natLaw = await getLaw(env, tier.national);
      const locLaw = await getLaw(env, tier.local);
      const natNo = t.articles[tier.key].national;
      const locNo = t.articles[tier.key].local;
      const national = buildSide(natLaw, natNo);
      const local = buildSide(locLaw, locNo);
      if (!national.text) { console.warn('  [경고] ' + t.title + ' / ' + tier.label + ' 국가 제' + natNo + '조 못 찾음'); missing++; }
      if (!local.text) { console.warn('  [경고] ' + t.title + ' / ' + tier.label + ' 지방 제' + locNo + '조 못 찾음'); missing++; }
      tableCount += national.tables.length + local.tables.length;
      tiers.push({ key: tier.key, label: tier.label, articleNo: { national: natNo, local: locNo }, national: national, local: local });
    }
    topics.push({ id: t.id, title: t.title, tiers: tiers });
  }

  const out = {
    source: 'law-api',
    generatedAt: new Date().toISOString().slice(0, 10),
    note: '법제처 국가법령정보 공동활용 API로 수집한 조문+별표입니다. (계층: 법률·시행령·시행규칙)',
    topics: topics
  };
  fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('\n완료: data.json 저장 (주제 ' + topics.length + '개 × 3계층, 별표 ' + tableCount + '개 포함).');
  if (missing) console.warn('참고: 조문 ' + missing + '건을 찾지 못했습니다. TOPICS 의 조문번호를 확인하세요.');
}

main().catch(function (e) { console.error('[실패]', e); process.exit(1); });
