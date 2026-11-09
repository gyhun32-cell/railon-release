// Korail open data (data.go.kr 15125762, 한국철도공사_열차운행정보) → RailOn timetable checks.
//   node scripts/korail.mjs probe    print samples so the parser can be checked
//   node scripts/korail.mjs update   detect upcoming timetable changes, rebuild when safe
// Needs env KORAIL_SERVICE_KEY (공공데이터포털 일반 인증키, Decoding).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = 'https://apis.data.go.kr/B551457/run/v2';
const KEY = process.env.KORAIL_SERVICE_KEY;
const mode = process.argv[2] || 'probe';
if (!KEY) { console.error('KORAIL_SERVICE_KEY 비밀값이 없습니다.'); process.exit(2); }

const DAYS = '일월화수목금토';
const pad = (n) => String(n).padStart(2, '0');
function kstDate(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
const ymdDash = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
const weekdayOf = (ymd) => new Date(ymdDash(ymd) + 'T12:00:00Z').getUTCDay();
/** "20261109 06:32:30" / "2026-11-09 06:32:30" / "20261109063230" → "06:32:30" */
function timeOf(dt) {
  if (!dt) return null;
  const digits = String(dt).replace(/\D/g, '');
  if (digits.length < 12) return null;
  const hh = digits.slice(8, 10), mm = digits.slice(10, 12), ss = digits.slice(12, 14) || '00';
  return `${hh}:${mm}:${ss}`;
}

async function call(op, params, { pageSize = 1000, maxPages = 200 } = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const q = new URLSearchParams({ serviceKey: KEY, pageNo: String(page), numOfRows: String(pageSize), returnType: 'JSON', ...params });
    let res, text;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(`${BASE}/${op}?${q}`, { signal: AbortSignal.timeout(30000) });
        text = await res.text();
        break;
      } catch (e) {
        if (attempt === 2) throw new Error(`${op} 연결 실패: ${e.message}`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`${op} 응답이 JSON이 아님 (HTTP ${res.status}): ${text.slice(0, 300)}`); }
    const head = json.response?.header;
    if (head && head.resultCode && !['00', '0', '0000'].includes(String(head.resultCode))) throw new Error(`${op} 오류 ${head.resultCode}: ${head.resultMsg}`);
    const body = json.response?.body || {};
    let items = body.items?.item ?? body.items ?? [];
    if (!Array.isArray(items)) items = [items];
    rows.push(...items);
    const total = Number(body.totalCount || 0);
    if (!items.length || rows.length >= total) break;
  }
  return rows;
}

const current = JSON.parse(readFileSync('timetable/data.json', 'utf8'));
const currentMeta = JSON.parse(readFileSync('timetable/meta.json', 'utf8'));
const honamStations = new Set(current.flatMap((t) => t.stops.map((s) => s.station)));

async function probe() {
  const yesterday = kstDate(-1), tomorrow = kstDate(1);
  const lines = await call('codes2', { 'cond[type::EQ]': 'mrnt_cd' });
  console.log('주운행선 코드:', lines.map((x) => `${x.code}=${x.value}`).join(', '));
  const stops = await call('codes2', { 'cond[type::EQ]': 'stop_se_cd' });
  console.log('정차구분 코드:', stops.map((x) => `${x.code}=${x.value}`).join(', '));
  const updn = await call('codes2', { 'cond[type::EQ]': 'uppln_dn_se_cd' });
  console.log('상하행 코드:', updn.map((x) => `${x.code}=${x.value}`).join(', '));
  const info = await call('travelerTrainRunInfo2', { 'cond[run_ymd::GTE]': yesterday, 'cond[run_ymd::LTE]': yesterday, 'cond[stn_nm::EQ]': '나주' });
  console.log(`운행정보 ${yesterday} 나주: ${info.length}행`);
  console.log(JSON.stringify(info.slice(0, 4), null, 1));
  const ours = current.filter((t) => t.stops.some((s) => s.station === '나주')).length;
  console.log(`(현재 시간표의 나주 정차 열차 수: ${ours})`);
  const one = info[0]?.trn_no;
  if (one) {
    const whole = await call('travelerTrainRunInfo2', { 'cond[run_ymd::GTE]': yesterday, 'cond[run_ymd::LTE]': yesterday, 'cond[mrnt_nm::EQ]': info[0].mrnt_nm });
    const train = whole.filter((r) => r.trn_no === one);
    console.log(`열차 ${one} 전체 정차(주운행선 ${info[0].mrnt_nm}, 그날 전체 ${whole.length}행):`);
    console.log(train.map((r) => `${r.stn_nm} ${timeOf(r.trn_arvl_dt)}/${timeOf(r.trn_dptre_dt)} ${r.stop_se_nm}`).join('\n'));
    const mine = current.find((t) => t.id === String(Number(one)));
    if (mine) console.log('현재 시간표:', mine.stops.map((s) => `${s.station} ${s.time}`).join(', '));
  }
  const plan = await call('travelerTrainRunPlan2', { 'cond[run_ymd::GTE]': tomorrow, 'cond[run_ymd::LTE]': tomorrow, 'cond[dptre_stn_nm::EQ]': '용산' });
  console.log(`운행계획 ${tomorrow} 용산 출발: ${plan.length}행`);
  console.log(JSON.stringify(plan.slice(0, 3), null, 1));
  const far = await call('travelerTrainRunPlan2', { 'cond[run_ymd::GTE]': kstDate(28), 'cond[run_ymd::LTE]': kstDate(31), 'cond[dptre_stn_nm::EQ]': '용산' });
  console.log(`운행계획 4주 뒤 용산 출발: ${far.length}행 (먼 날짜도 미리 나오는지 확인)`);
}

/* ---------- update ---------- */
const trainNo = (s) => String(Number(s));
function expectedOn(t, ymd) {
  if (!t.days || t.days === '매일' || t.days === '표기 없음') return true;
  return t.days.includes(DAYS[weekdayOf(ymd)]);
}

/** Compares Korail's published plan for the next weeks with our timetable, per day. */
async function planDiff() {
  const from = kstDate(1), to = kstDate(30);
  const byOrigin = new Map();
  for (const t of current) { const o = t.stops[0].station; if (!byOrigin.has(o)) byOrigin.set(o, []); byOrigin.get(o).push(t); }
  const plan = [];
  for (const origin of byOrigin.keys()) plan.push(...await call('travelerTrainRunPlan2', { 'cond[run_ymd::GTE]': from, 'cond[run_ymd::LTE]': to, 'cond[dptre_stn_nm::EQ]': origin }));
  const days = new Map();
  for (const r of plan) {
    if (!days.has(r.run_ymd)) days.set(r.run_ymd, new Map());
    days.get(r.run_ymd).set(trainNo(r.trn_no) + '|' + r.dptre_stn_nm, r);
  }
  const report = [];
  for (const [ymd, rows] of [...days].sort()) {
    let changed = [], missing = [], added = [];
    const ourKeys = new Set();
    for (const t of current) {
      if (!expectedOn(t, ymd)) continue;
      const key = t.id + '|' + t.stops[0].station;
      ourKeys.add(key);
      const r = rows.get(key);
      const lastStation = t.stops.at(-1).station;
      if (!r) { missing.push(t.id); continue; }
      const dep = timeOf(r.trn_plan_dptre_dt)?.slice(0, 5);
      if (dep && dep !== t.stops[0].time.slice(0, 5)) changed.push(`${t.id}번 ${t.stops[0].time.slice(0, 5)}→${dep}`);
      else if (r.arvl_stn_nm && r.arvl_stn_nm !== lastStation && honamStations.has(r.arvl_stn_nm)) changed.push(`${t.id}번 종착 ${lastStation}→${r.arvl_stn_nm}`);
    }
    for (const [key, r] of rows) if (!ourKeys.has(key) && honamStations.has(r.arvl_stn_nm)) added.push(trainNo(r.trn_no));
    report.push({ ymd, planned: rows.size, changed, missing, added });
  }
  return report;
}

function noticeFromReport(report) {
  const big = (d) => d.changed.length + d.added.length + d.missing.length >= Math.max(4, Math.round(current.length * 0.06));
  for (let i = 0; i + 2 < report.length; i++) {
    if (big(report[i]) && big(report[i + 1]) && big(report[i + 2])) {
      const d = report[i];
      return {
        id: 'plan-' + d.ymd,
        important: true,
        date: ymdDash(kstDate(0)),
        effective: ymdDash(d.ymd),
        title: `${Number(d.ymd.slice(4, 6))}월 ${Number(d.ymd.slice(6, 8))}일부터 시간표가 바뀌는 것 같아요`,
        summary: `코레일 운행계획 기준 변경 ${d.changed.length}개 · 새 열차 ${d.added.length}개 · 빠지는 열차 ${d.missing.length}개. 바뀐 날 이후 운행 기록이 쌓이면 앱 시간표가 자동으로 바뀌어요.` + (d.changed.length ? ` 예: ${d.changed.slice(0, 5).join(', ')}` : ''),
      };
    }
  }
  return null;
}

/** Rebuilds the full stop-by-stop timetable from the last 14 days of recorded runs. */
async function rebuild(lines) {
  const from = kstDate(-14), to = kstDate(-1);
  const rows = [];
  for (const line of lines) rows.push(...await call('travelerTrainRunInfo2', { 'cond[run_ymd::GTE]': from, 'cond[run_ymd::LTE]': to, 'cond[mrnt_nm::EQ]': line }));
  const runs = new Map();
  for (const r of rows) {
    const key = r.run_ymd + '|' + trainNo(r.trn_no);
    if (!runs.has(key)) runs.set(key, []);
    runs.get(key).push(r);
  }
  const trains = new Map();
  for (const [key, stops] of runs) {
    const [ymd, no] = key.split('|');
    const real = stops.filter((s) => !/통과|미정차/.test(s.stop_se_nm || ''))
      .map((s) => ({ station: s.stn_nm, time: timeOf(s.trn_dptre_dt) || timeOf(s.trn_arvl_dt), sn: Number(s.trn_run_sn) || 0, up: s.uppln_dn_se_cd }))
      .filter((s) => s.time && honamStations.has(s.station))
      .sort((a, b) => a.sn - b.sn || a.time.localeCompare(b.time));
    if (real.length < 2) continue;
    if (!trains.has(no)) trains.set(no, { days: new Set(), samples: [] });
    const t = trains.get(no);
    t.days.add(weekdayOf(ymd));
    t.samples.push(real);
  }
  const out = [];
  for (const [no, t] of trains) {
    const counts = new Map();
    for (const s of t.samples) { const sig = s.map((x) => x.station).join('>'); counts.set(sig, (counts.get(sig) || 0) + 1); }
    const sig = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const pick = t.samples.filter((s) => s.map((x) => x.station).join('>') === sig);
    const stops = pick[0].map((s, i) => {
      const times = pick.map((p) => p[i].time.slice(0, 5));
      const mode = [...times.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      return { station: s.station, time: mode + ':00' };
    });
    const old = current.find((x) => x.id === no);
    const dayList = [...t.days].sort();
    out.push({
      id: no,
      type: old?.type || '열차',
      direction: old?.direction || (String(pick[0][0].up).includes('1') || /상/.test(pick[0][0].up) ? 'up' : 'down'),
      days: dayList.length === 7 ? '매일' : dayList.map((d) => DAYS[d]).join(''),
      stops,
    });
  }
  return out.sort((a, b) => a.stops[0].time.localeCompare(b.stops[0].time));
}

async function update() {
  const notices = existsSync('notices.json') ? JSON.parse(readFileSync('notices.json', 'utf8')) : [];
  const report = await planDiff();
  writeFileSync('timetable/plan-check.json', JSON.stringify({ checkedAt: new Date().toISOString(), days: report.map((d) => ({ ...d, changed: d.changed.slice(0, 30), missing: d.missing.slice(0, 30), added: d.added.slice(0, 30) })) }, null, 1) + '\n');
  const notice = noticeFromReport(report);
  if (notice && !notices.some((n) => n.id === notice.id)) {
    notices.unshift(notice);
    console.log('공지 추가:', notice.title);
  }
  writeFileSync('notices.json', JSON.stringify(notices.slice(0, 20), null, 1) + '\n');

  // Rebuild only after a detected change has been running for at least 7 days.
  const pending = notices.find((n) => n.id?.startsWith('plan-') && !n.applied);
  if (!pending) { console.log('적용 대기 중인 시간표 변경 없음'); return; }
  const daysSince = (Date.parse(ymdDash(kstDate(0))) - Date.parse(pending.effective)) / 86400000;
  if (daysSince < 7) { console.log(`변경 ${pending.effective} · 운행 기록 쌓이는 중 (${daysSince}일)`); return; }
  const lineCodes = (await call('codes2', { 'cond[type::EQ]': 'mrnt_cd' })).map((x) => x.value).filter((v) => /호남|전라/.test(v));
  const rebuilt = await rebuild(lineCodes.length ? lineCodes : ['호남선']);
  const ratio = rebuilt.length / current.length;
  const covered = new Set(rebuilt.flatMap((t) => t.stops.map((s) => s.station)));
  const overlap = [...honamStations].filter((s) => covered.has(s)).length / honamStations.size;
  console.log(`재구성 ${rebuilt.length}개 열차 (기존 ${current.length}) · 역 겹침 ${(overlap * 100).toFixed(0)}%`);
  if (ratio < 0.7 || ratio > 1.4 || overlap < 0.8) { console.log('결과가 기존과 너무 달라서 적용하지 않음'); return; }
  const version = 'korail-' + kstDate(0);
  writeFileSync('timetable/data.json', JSON.stringify(rebuilt));
  writeFileSync('timetable/meta.json', JSON.stringify({ version, label: `${Number(pending.effective.slice(5, 7))}월 ${Number(pending.effective.slice(8, 10))}일 개정 시간표 (코레일 운행기록 기준)`, source: '공공데이터포털 한국철도공사_열차운행정보 최근 14일 운행 기록', updatedAt: ymdDash(kstDate(0)), effective: pending.effective, previous: currentMeta.version }) + '\n');
  pending.applied = version;
  writeFileSync('notices.json', JSON.stringify(notices.slice(0, 20), null, 1) + '\n');
  console.log('새 시간표 적용:', version);
}

(mode === 'update' ? update() : probe()).catch((e) => { console.error(e.message); process.exit(1); });
