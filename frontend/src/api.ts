import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://etrvnyvmqkgdfujolref.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0cnZueXZtcWtnZGZ1am9scmVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzMDc1NTUsImV4cCI6MjEwNzg4MzU1NX0.J9oh0x4-PJK7yEIjIQa14pK4jduwTyrR36fgNTtEBvA';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const DEFAULT_SCORING_MODULE_URL = (import.meta.env.VITE_SCORING_MODULE_URL || '').replace(/\/$/, '');
const DEFAULT_SCORING_PROXY_URL = (import.meta.env.VITE_SCORING_PROXY_URL || '').replace(/\/$/, '');
const SCORING_URL_STORAGE_KEY = 'ott.scoring_module_url';

export function getSavedScoringUrl(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_SCORING_MODULE_URL;
  return localStorage.getItem(SCORING_URL_STORAGE_KEY) || DEFAULT_SCORING_MODULE_URL;
}

export function saveScoringUrl(value: string) {
  if (typeof localStorage === 'undefined') return;
  if (value.trim()) localStorage.setItem(SCORING_URL_STORAGE_KEY, value.trim().replace(/\/+$/, ''));
  else localStorage.removeItem(SCORING_URL_STORAGE_KEY);
}

export function getScoringProxyUrl(): string {
  return DEFAULT_SCORING_PROXY_URL;
}

export type ProxyScoreJob = {
  job_id: string;
  status: 'waiting' | 'queued' | 'running' | 'succeeded' | 'failed';
  match_score?: number;
  games?: ReplayGame[];
  error_code?: string;
  error?: string;
};

export async function submitProxyScore(
  source: string,
  options: { matchId?: number; benchmarkCode?: string },
): Promise<ProxyScoreJob> {
  const base = getScoringProxyUrl();
  if (!base) throw new Error('Chưa cấu hình Cloudflare scoring proxy.');
  const token = await getAccessToken();
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn.');
  const response = await fetch(`${base}/v1/score`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contestant_code: source,
      match_id: options.matchId,
      benchmark_code: options.benchmarkCode,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.detail || `Cloudflare proxy trả HTTP ${response.status}.`);
  return payload as ProxyScoreJob;
}

export async function pollProxyScore(jobId: string): Promise<ProxyScoreJob> {
  const base = getScoringProxyUrl();
  const token = await getAccessToken();
  if (!base || !token) throw new Error('Phiên đăng nhập đã hết hạn hoặc chưa cấu hình scoring proxy.');
  const response = await fetch(`${base}/v1/score/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.detail || `Không đọc được trạng thái chấm (HTTP ${response.status}).`);
  return payload as ProxyScoreJob;
}

function normalizeScoringUrl(value: string): string {
  const url = new URL(value.trim());
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error('URL máy chấm phải dùng HTTPS (HTTP chỉ dùng cho localhost).');
  if (url.username || url.password || url.search || url.hash) throw new Error('URL máy chấm không được chứa tài khoản, query hoặc fragment.');
  return url.toString().replace(/\/+$/, '');
}

export async function probeScoringServer(value: string, timeoutMs = 5000): Promise<{ ok: boolean; service?: string }> {
  let base: string;
  try {
    base = normalizeScoringUrl(value);
  } catch {
    throw new Error('Hãy nhập URL đầy đủ, ví dụ https://score.tenmiencuaban.vn.');
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/v1/health`, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Máy chấm trả HTTP ${response.status}.`);
    const payload = await response.json().catch(() => null);
    if (!payload?.ok) throw new Error('URL không trỏ tới API máy chấm hợp lệ.');
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Máy chấm không phản hồi trong 5 giây.');
    if (error instanceof TypeError) throw new Error('Không thể kết nối. Kiểm tra hostname, HTTPS và CORS trên máy chấm.');
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function getScoringAdminMetrics(value: string) {
  const base = normalizeScoringUrl(value);
  const token = await getAccessToken();
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn.');
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${base}/v1/admin/metrics`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.detail || `Không lấy được metrics (HTTP ${response.status}).`);
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Máy chấm không trả metrics trong 8 giây.');
    if (error instanceof TypeError) throw new Error('Không kết nối được metrics; kiểm tra CORS và URL tunnel.');
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function postScoringAdmin<T = Record<string, unknown>>(value: string, path: string, body?: unknown): Promise<T> {
  const base = normalizeScoringUrl(value);
  const token = await getAccessToken();
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn.');
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.detail || `Thao tác thất bại (HTTP ${response.status}).`);
  return payload as T;
}

export type ScoringBenchmark = { id: string; name: string };

export async function getScoringBenchmarks(value: string): Promise<ScoringBenchmark[]> {
  const base = normalizeScoringUrl(value);
  let response: Response;
  try {
    response = await fetch(`${base}/v1/benchmarks`, { cache: 'no-store' });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Không phân giải được URL máy chấm; hãy cập nhật tunnel trong mục Quản trị máy chấm.');
    }
    throw error;
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.detail || `Không tải được bot mẫu (HTTP ${response.status}).`);
  return Array.isArray(payload?.benchmarks) ? payload.benchmarks : [];
}

export async function uploadScoringBenchmark(value: string, file: File): Promise<ScoringBenchmark> {
  const base = normalizeScoringUrl(value);
  const token = await getAccessToken();
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn.');
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`${base}/v1/admin/benchmarks`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, cache: 'no-store',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.detail || `Không tải được bot mẫu (HTTP ${response.status}).`);
  return payload.benchmark as ScoringBenchmark;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function getAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token || null;
}

export interface ScoringJob {
  id: string;
  status: 'dispatching' | 'accepted' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'dispatch_failed';
  result?: Record<string, any> | null;
  error_code?: string | null;
  error_message?: string | null;
}

export async function createAndDispatchScoringJob(
  file: File,
  kind: 'entry' | 'submission' | 'test' = 'entry',
  scoringModuleUrl = getSavedScoringUrl(),
  context: { round: number; day: number } | null = null,
  benchmarkIds: string[] = [],
): Promise<string> {
  if (!scoringModuleUrl.trim()) throw new Error('Hãy nhập URL HTTPS của máy chấm.');
  if (kind === 'submission' && (!context || context.round < 1 || context.day < 1)) {
    throw new Error('Chưa có vòng/ngày thi hợp lệ để nộp bài.');
  }
  const baseUrl = normalizeScoringUrl(scoringModuleUrl);
  const token = await getAccessToken();
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn');
  await probeScoringServer(baseUrl);
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const id = crypto.randomUUID();

  const createJob = supabase.rpc('create_scoring_job', {
    p_job_id: id,
    p_kind: kind,
    p_rnd: kind === 'submission' ? context?.round ?? null : null,
    p_day: kind === 'submission' ? context?.day ?? null : null,
    p_sha256: sha256,
    p_size_bytes: file.size,
  });
  const body = new FormData();
  body.append('file', file);
  if (kind === 'test') body.append('benchmark_ids', benchmarkIds.join(','));
  const dispatchController = new AbortController();
  const dispatchTimer = window.setTimeout(() => dispatchController.abort(), 10_000);
  const dispatch = fetch(`${baseUrl}/v1/jobs/${id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body,
    signal: dispatchController.signal,
  }).then(async response => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(payload.detail || 'Máy chấm không nhận bài', response.status);
    return payload;
  }).finally(() => window.clearTimeout(dispatchTimer));

  const [jobResult, dispatchResult] = await Promise.allSettled([createJob, dispatch]);
  const acceptedAfterRace = async () => {
    const { data: currentJob } = await supabase
      .from('scoring_jobs')
      .select('status')
      .eq('id', id)
      .maybeSingle();
    return Boolean(currentJob && ['accepted', 'running', 'succeeded'].includes(currentJob.status));
  };
  if (jobResult.status === 'rejected' || jobResult.value.error) {
    if (await acceptedAfterRace()) return id;
    await supabase.rpc('fail_scoring_dispatch', { p_job_id: id });
    if (await acceptedAfterRace()) return id;
    const reason = jobResult.status === 'rejected' ? jobResult.reason?.message : jobResult.value.error?.message;
    throw new Error(scoringErrorMessage(reason));
  }
  if (dispatchResult.status === 'rejected') {
    if (await acceptedAfterRace()) return id;
    await supabase.rpc('fail_scoring_dispatch', { p_job_id: id });
    if (await acceptedAfterRace()) return id;
    if (dispatchResult.reason?.name === 'AbortError') {
      throw new Error('Máy chấm chưa xác nhận nhận bài trong 10 giây. Hãy kiểm tra kết nối rồi thử lại.');
    }
    throw dispatchResult.reason;
  }
  return id;
}

function scoringErrorMessage(message: string): string {
  const known: Record<string, string> = {
    entry_closed: 'Giai đoạn vòng loại đã đóng. Hãy tải lại trang hoặc liên hệ ban tổ chức.',
    submission_context_stale: 'Thông tin cuộc thi chưa được đồng bộ. Vui lòng liên hệ ban tổ chức.',
    submissions_closed: 'Ban tổ chức đang tạm đóng nhận bài.',
    qualification_attempt_limit: 'Bạn đã dùng hết 20 lượt nộp ở giai đoạn vòng loại.',
    already_submitted_today: 'Bạn đã gửi bot cho ngày thi này rồi.',
    account_not_allowed: 'Tài khoản hiện không được phép tham gia cuộc thi.',
  };
  const key = Object.keys(known).find((candidate) => message?.includes(candidate));
  return key ? known[key] : message || 'Không thể tạo yêu cầu chấm bài.';
}

export interface ScoringState {
  phase: 'entry' | 'round' | 'done';
  accepting: boolean;
  attempts: number;
  bestScore: number | null;
  round?: number | null;
  day?: number | null;
  scoringUrl?: string | null;
}

export interface User {
  id?: string;
  name: string;
  email?: string;
  role?: string;
}

export interface Status {
  name: string;
  email?: string;
  role?: string;
  status: string;
  phase: string;
  round: string | null;
  open_day: string | null;
  group?: number;
  entry: number | null;
  avg_rank?: number | null;
  days?: { day: number; pts: number; rank: number; n: number }[];
}

export interface Standing {
  rank: number;
  name: string;
  pts: number;
  gs: number;
}

export interface TodayMatch {
  match_id: number;
  rnd: number;
  day: number;
  rd: number;
  grp: number;
  opponent: string;
  state: string;
}

export async function getMyTodayMatches(): Promise<TodayMatch[]> {
  const { data, error } = await supabase.rpc('get_my_today_matches');
  if (error) throw new Error(error.message);
  return (data || []) as TodayMatch[];
}

export type Move = [number, number, number, number];

export interface ReplayGame {
  players: ('a' | 'b')[];
  moves: [number, Move][];
  result?: number;
  fault?: boolean;
}

export interface ReplayMatch {
  id?: number | string;
  kind?: 'match' | 'job';
  storagePath?: string;
  round?: number;
  day?: number;
  rd: number;
  a: string;
  b: string;
  s: number;
  games?: ReplayGame[];
}

export interface Replays {
  available: { round: number; day: number }[];
  round: number | null;
  day: number | null;
  matches: ReplayMatch[];
  allMatches: ReplayMatch[];
}

export interface SubmissionHistoryItem {
  id: string;
  kind: 'entry' | 'submission' | 'test';
  rnd: number | null;
  day: number | null;
  status: ScoringJob['status'];
  created_at: string;
  finished_at: string | null;
  result: Record<string, any> | null;
  error_code: string | null;
  error_message: string | null;
}

export async function getSubmissionHistory(userId: string): Promise<SubmissionHistoryItem[]> {
  const { data, error } = await supabase.from('scoring_jobs')
    .select('id,kind,rnd,day,status,created_at,finished_at,result,error_code,error_message')
    .eq('user_id', userId)
    .in('kind', ['entry', 'submission', 'test'])
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data || []) as SubmissionHistoryItem[];
}

export async function getReplayMetadata(round?: number, day?: number): Promise<Replays> {
  const { data, error } = await supabase.rpc('get_my_replay_matches');
  if (error) throw new Error(error.message);
  const rows = (data || []) as Array<{ replay_id: string; replay_kind: 'match' | 'job'; rnd: number; day: number; rd: number; player_a: string; player_b: string; score_a: number; storage_path: string }>;
  const dates = [...new Map(rows.map(row => [`${row.rnd},${row.day}`, { round: row.rnd, day: row.day }])).values()]
    .sort((a, b) => b.round - a.round || b.day - a.day);
  const selected = round !== undefined && day !== undefined
    ? { round, day }
    : dates.find(date => date.round === 0 && date.day === 0) || dates[0] || null;
  const allMatches = rows.map(row => ({ id: row.replay_id, kind: row.replay_kind, storagePath: row.storage_path, round: row.rnd, day: row.day, rd: row.rd, a: row.player_a, b: row.player_b, s: row.score_a, games: [] }));
  const matches = selected ? allMatches.filter(row => row.round === selected.round && row.day === selected.day) : [];
  return { available: dates, round: selected?.round ?? null, day: selected?.day ?? null, matches, allMatches };
}

export async function loadMatchReplay(storagePath: string): Promise<ReplayGame[]> {
  const { data: signed, error: signError } = await supabase.storage
    .from('replays')
    .createSignedUrl(storagePath, 120);
  if (signError) throw new Error(signError.message);
  const response = await fetch(signed.signedUrl);
  if (!response.ok) throw new Error('Không tải được replay từ kho lưu trữ');
  const compressed = await response.arrayBuffer();
  if (!('DecompressionStream' in window)) throw new Error('Trình duyệt không hỗ trợ giải nén replay');
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const payload = await new Response(stream).json().catch(() => null);
  if (!Array.isArray(payload)) throw new Error('Dữ liệu replay không hợp lệ');
  return payload as ReplayGame[];
}

export interface WebDashboard {
  status: Status;
  scoring: ScoringState;
  standings: Standing[];
  champion: string | null;
}

export async function getWebDashboard(): Promise<WebDashboard> {
  const { data, error } = await supabase.rpc('get_my_dashboard');
  if (error) throw new Error(error.message);
  return data as WebDashboard;
}

export interface AdminOverview {
  phase: string;
  round: number | null;
  day: number | null;
  pending: number | null;
  accepting: boolean;
  total_users: number;
  active_users: number;
  champion?: string | null;
}
