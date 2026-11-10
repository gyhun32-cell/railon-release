// Korail open data (data.go.kr 15125762, 한국철도공사_열차운행정보) → RailOn timetable checks.
//   node scripts/korail.mjs probe    print samples so the parser can be checked
//   node scripts/korail.mjs update   detect upcoming timetable changes, rebuild when safe
// Needs env KORAIL_SERVICE_KEY (공공데이터포털 일반 인증키, Decoding).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = 'https://apis.data.go.kr/B551457/run/v2';
const KEY = process.env.KORAIL_SERVICE_KEY;
const mode = process.argv[2] || 'probe';
// Until the key is registered the daily run just skips, so it doesn't fail (and email) every day.
if (!KEY) { console.log('KORAIL_SERVICE_KEY 비밀값이 아직 없어 건너뜁니다.'); process.exit(mode === 'probe' ? 2 : 0); }

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
}

/* ---------- update ---------- */
const LINES = ['호남선', '호남고속선', '광주선'];
const trainNo = (s) => String(Number(s));
function expectedOn(t, ymd) {
  if (!t.days || t.days === '매일' || t.days === '표기 없음') return true;
  return t.days.includes(DAYS[weekdayOf(ymd)]);
}

/** Stations Korail data does not cover (SR's own stations); their times are carried over from the old timetable. */
const SR_ONLY = new Set(['수서', '동탄']);
const minutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/**
 * Korail's "plan" endpoint only reaches yesterday, so changes are caught after the fact:
 * compare the last few days of recorded runs with our timetable.
 */
async function recordDiff(days = 3) {
  const from = kstDate(-days), to = kstDate(-1);
  const rows = [];
  for (const line of LINES) rows.push(...await call('travelerTrainRunInfo2', { 'cond[run_ymd::GTE]': from, 'cond[run_ymd::LTE]': to, 'cond[mrnt_nm::EQ]': line }));
  const byDay = new Map();
  for (const r of rows) {
    if (!['01', '02', '05', '11'].includes(String(r.stop_se_cd))) continue;
    // Same convention as the timetable: arrival time, departure only at the first stop.
    const t = timeOf(r.trn_arvl_dt) || timeOf(r.trn_dptre_dt);
    if (!t) continue;
    if (!byDay.has(r.run_ymd)) byDay.set(r.run_ymd, new Map());
    const day = byDay.get(r.run_ymd), no = trainNo(r.trn_no);
    if (!day.has(no)) day.set(no, new Map());
    day.get(no).set(r.stn_nm, t.slice(0, 5));
  }
  const ymds = [...byDay.keys()].sort();
  const changed = [], missing = [], added = [];
  for (const t of current) {
    const expected = ymds.filter((y) => expectedOn(t, y));
    if (!expected.length) continue;
    const seen = expected.filter((y) => byDay.get(y).has(t.id));
    if (!seen.length) { missing.push(t.id); continue; }
    // First station both sides know (SR-only stations are skipped).
    const ref = t.stops.find((s) => !SR_ONLY.has(s.station) && seen.every((y) => byDay.get(y).get(t.id).has(s.station)));
    if (!ref) continue;
    const deltas = seen.map((y) => minutes(byDay.get(y).get(t.id).get(ref.station)) - minutes(ref.time.slice(0, 5)));
    const consistent = Math.max(...deltas) - Math.min(...deltas) <= 2;
    // Recorded runs drift later with delays, so only an earlier time or a big consistent jump counts as a timetable change.
    if (seen.length >= 2 && consistent && (deltas[0] <= -2 || deltas[0] >= 10)) changed.push(`${t.id}번 ${ref.station} ${ref.time.slice(0, 5)}→${byDay.get(seen[0]).get(t.id).get(ref.station)}`);
  }
  const ours = new Set(current.map((t) => t.id));
  const counts = new Map();
  for (const day of byDay.values()) for (const [no, stops] of day) {
    if (ours.has(no) || [...stops.keys()].filter((s) => honamStations.has(s)).length < 2) continue;
    counts.set(no, (counts.get(no) || 0) + 1);
  }
  for (const [no, n] of counts) if (n >= Math.min(2, ymds.length)) added.push(no);
  return { from, to, days: ymds.length, changed, missing, added };
}

function noticeFromDiff(d) {
  const total = d.changed.length + d.added.length + d.missing.length;
  if (total < Math.max(8, Math.round(current.length * 0.05))) return null;
  return {
    id: 'change-' + d.from,
    important: true,
    date: ymdDash(kstDate(0)),
    effective: ymdDash(d.from),
    title: '코레일 시간표가 바뀐 것 같아요',
    summary: `최근 ${d.days}일 운행 기록이 앱 시간표와 달라요: 시간 변경 ${d.changed.length}개 · 새 열차 ${d.added.length}개 · 안 다니는 열차 ${d.missing.length}개. 일주일치 기록이 쌓이면 앱 시간표가 자동으로 바뀌어요. 그 전까지는 역의 안내를 함께 확인해 주세요.`
      + (d.changed.length ? ` 예: ${d.changed.slice(0, 5).join(', ')}` : ''),
  };
}

/** Carries SR-only stops (수서·동탄) over from the old train, shifted by how much the train moved. */
function keepSrStops(train) {
  const old = current.find((x) => x.id === train.id);
  if (!old) return train;
  const extra = old.stops.filter((s) => SR_ONLY.has(s.station) && !train.stops.some((x) => x.station === s.station));
  if (!extra.length) return train;
  const common = old.stops.find((s) => train.stops.some((x) => x.station === s.station));
  const shift = common ? minutes(train.stops.find((x) => x.station === common.station).time) - minutes(common.time) : 0;
  const moved = (t) => { const m = (minutes(t) + shift + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`; };
  const before = [], after = [];
  const firstIdx = old.stops.findIndex((s) => !SR_ONLY.has(s.station));
  for (const s of extra) (old.stops.indexOf(s) < firstIdx ? before : after).push({ station: s.station, time: moved(s.time) });
  return { ...train, stops: [...before, ...train.stops, ...after] };
}

/** Rebuilds the full stop-by-stop timetable from the last 14 days of recorded runs. */
async function rebuild(lines, since = null) {
  const from = since && since > kstDate(-14) ? since : kstDate(-14), to = kstDate(-1);
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
    // Only real passenger stops (시발/정차/종착/여객승하차). Arrival time matters for the duty alarm; the first stop has only a departure.
    const real = stops.filter((s) => ['01', '02', '05', '11'].includes(String(s.stop_se_cd)))
      .map((s) => ({ station: s.stn_nm, time: (process.env.TIME === 'dep' ? timeOf(s.trn_dptre_dt) || timeOf(s.trn_arvl_dt) : timeOf(s.trn_arvl_dt) || timeOf(s.trn_dptre_dt)), sn: Number(s.trn_run_sn) || 0, up: s.uppln_dn_se_cd }))
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
      // These are recorded runs, so delays only push times later: the earliest time seen is the closest to the schedule.
      const mode = process.env.PICK === 'mode'
        ? [...times.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
        : [...times].sort()[0];
      return { station: s.station, time: mode + ':00' };
    });
    const old = current.find((x) => x.id === no);
    const dayList = [...t.days].sort();
    out.push({
      id: no,
      type: old?.type || '열차',
      direction: pick[0][0].up === 'U' ? 'up' : pick[0][0].up === 'D' ? 'down' : old?.direction || 'down',
      days: dayList.length === 7 ? '매일' : dayList.sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7)).map((d) => DAYS[d]).join(''),
      stops,
    });
  }
  return out.map(keepSrStops).sort((a, b) => a.stops[0].time.localeCompare(b.stops[0].time));
}

async function update() {
  const notices = existsSync('notices.json') ? JSON.parse(readFileSync('notices.json', 'utf8')) : [];
  const diff = await recordDiff(3);
  writeFileSync('timetable/check.json', JSON.stringify({ checkedAt: new Date().toISOString(), ...diff, changed: diff.changed.slice(0, 40), missing: diff.missing.slice(0, 40), added: diff.added.slice(0, 40) }, null, 1) + '\n');
  console.log(`최근 ${diff.days}일: 변경 ${diff.changed.length} · 빠짐 ${diff.missing.length} · 새 열차 ${diff.added.length}`);
  const notice = noticeFromDiff(diff);
  const open = notices.find((n) => n.id?.startsWith('change-') && !n.applied);
  if (notice && !open) {
    notices.unshift(notice);
    console.log('공지 추가:', notice.title);
  }
  writeFileSync('notices.json', JSON.stringify(notices.slice(0, 20), null, 1) + '\n');

  // Rebuild only after a detected change has been running for at least 7 days.
  const pending = notices.find((n) => n.id?.startsWith('change-') && !n.applied);
  if (!pending) { console.log('적용 대기 중인 시간표 변경 없음'); return; }
  const daysSince = (Date.parse(ymdDash(kstDate(0))) - Date.parse(pending.effective)) / 86400000;
  if (daysSince < 7) { console.log(`변경 ${pending.effective} · 운행 기록 쌓이는 중 (${daysSince}일)`); return; }
  const rebuilt = await rebuild(LINES, pending.effective.replace(/-/g, ''));
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

/** Rebuilds without saving and prints how far it is from the current timetable. */
async function compare() {
  const rebuilt = await rebuild(LINES);
  const byId = new Map(rebuilt.map((t) => [t.id, t]));
  const ours = new Map(current.map((t) => [t.id, t]));
  const missing = current.filter((t) => !byId.has(t.id)).map((t) => `${t.id}(${t.days})`);
  const extra = rebuilt.filter((t) => !ours.has(t.id)).map((t) => `${t.id}:${t.stops[0].station}>${t.stops.at(-1).station}`);
  let same = 0, dirWrong = 0, stopSetDiff = 0;
  const diff = [];
  for (const t of rebuilt) {
    const o = ours.get(t.id);
    if (!o) continue;
    if (o.direction !== t.direction) dirWrong++;
    if (o.stops.map((s) => s.station).join() !== t.stops.map((s) => s.station).join()) stopSetDiff++;
    for (const s of t.stops) {
      const os = o.stops.find((x) => x.station === s.station);
      if (!os) continue;
      const d = Math.round((Date.parse('2026-01-01T' + s.time + 'Z') - Date.parse('2026-01-01T' + os.time + 'Z')) / 60000);
      if (Math.abs(d) <= 1) same++; else diff.push(`${t.id}@${s.station} ${os.time.slice(0, 5)}→${s.time.slice(0, 5)}`);
    }
  }
  console.log(`재구성 ${rebuilt.length} / 기존 ${current.length}`);
  console.log(`방향 불일치 ${dirWrong} · 정차역 구성 다름 ${stopSetDiff}`);
  console.log(`정차 시각 ±1분 일치 ${same} · 2분 이상 차이 ${diff.length}`);
  console.log('차이 예: ' + diff.slice(0, 25).join(', '));
  console.log(`API에 없는 기존 열차 ${missing.length}: ${missing.join(' ')}`);
  console.log(`기존에 없는 API 열차 ${extra.length}: ${extra.join(' ')}`);
  const naju = (list) => list.filter((t) => t.stops.some((s) => s.station === '나주')).length;
  console.log(`나주 정차: 재구성 ${naju(rebuilt)} / 기존 ${naju(current)}`);
  const days = {};
  for (const t of rebuilt) days[t.days] = (days[t.days] || 0) + 1;
  console.log('운행요일 분포', JSON.stringify(days));
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(rebuilt));
}

async function planOnly() {
  const d = await recordDiff(3);
  console.log(JSON.stringify(d, null, 1));
  console.log('감지 결과:', JSON.stringify(noticeFromDiff(d)));
}

(mode === 'update' ? update() : mode === 'compare' ? compare() : mode === 'plan' ? planOnly() : probe()).catch((e) => { console.error(e.message); process.exit(1); });
