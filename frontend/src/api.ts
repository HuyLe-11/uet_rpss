import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://etrvnyvmqkgdfujolref.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0cnZueXZtcWtnZGZ1am9scmVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzMDc1NTUsImV4cCI6MjEwNzg4MzU1NX0.J9oh0x4-PJK7yEIjIQa14pK4jduwTyrR36fgNTtEBvA';

export const supabase = createClient(
  SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || SUPABASE_ANON_KEY,
);

const DEFAULT_SCORING_PROXY_URL = (import.meta.env.VITE_SCORING_PROXY_URL || '').replace(/\/$/, '');

export function getScoringProxyUrl(): string {
  return DEFAULT_SCORING_PROXY_URL;
}

async function fetchScoringProxy(url: string, init: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  let response = await fetch(url, { ...init, headers });
  if (response.status !== 401) return response;

  // A background tab can wake with an expired access token before the
  // Supabase client's automatic refresh timer has run. Refresh once and retry.
  const { data, error } = await supabase.auth.refreshSession();
  const refreshedToken = data.session?.access_token;
  if (error || !refreshedToken) return response;
  headers.set('Authorization', `Bearer ${refreshedToken}`);
  response = await fetch(url, { ...init, headers });
  return response;
}

export type ProxyScoreJob = {
  job_id: string;
  status: 'waiting' | 'queued' | 'running' | 'succeeded' | 'failed';
  match_score?: number;
  qualification_score?: number;
  passed?: boolean;
  match_result?: 'win' | 'loss' | 'draw';
  games?: ReplayGame[];
  error_code?: string;
  error?: string;
};

export async function submitProxyScore(
  source: string,
  options: { matchId?: number; benchmarkCode?: string; jobId?: string },
): Promise<ProxyScoreJob> {
  const base = getScoringProxyUrl();
  if (!base) throw new Error('Chưa cấu hình Cloudflare scoring proxy.');
  const response = await fetchScoringProxy(`${base}/v1/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contestant_code: source,
      match_id: options.matchId,
      benchmark_code: options.benchmarkCode,
      job_id: options.jobId,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.detail || `Cloudflare proxy trả HTTP ${response.status}.`);
  return payload as ProxyScoreJob;
}

export async function pollProxyScore(jobId: string): Promise<ProxyScoreJob> {
  const base = getScoringProxyUrl();
  if (!base) throw new Error('Chưa cấu hình scoring proxy.');
  const response = await fetchScoringProxy(`${base}/v1/score/${encodeURIComponent(jobId)}`, {
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.detail || `Không đọc được trạng thái chấm (HTTP ${response.status}).`);
  return payload as ProxyScoreJob;
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

export interface ScoringState {
  phase: 'entry' | 'round' | 'done';
  accepting: boolean;
  attempts: number;
  bestScore: number | null;
  round?: number | null;
  day?: number | null;
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
  my_submission_state: 'waiting' | 'submitting' | 'submitted' | 'late' | 'resolved';
  opponent_submission_state: 'waiting' | 'submitting' | 'submitted' | 'late' | 'resolved';
  submission_deadline: string | null;
  my_match_score: number | null;
  my_match_points: number;
  scoring_error: string | null;
  attempts_completed: number;
  can_submit: boolean;
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
  const [{ data, error }, { data: authData, error: authError }] = await Promise.all([
    supabase.rpc('get_my_replay_matches'),
    supabase.auth.getUser(),
  ]);
  const rows = (data || []) as Array<{ replay_id: string; replay_kind: 'match' | 'job'; rnd: number; day: number; rd: number; player_a: string; player_b: string; score_a: number; storage_path: string }>;
  const allMatches: ReplayMatch[] = rows.map(row => ({ id: row.replay_id, kind: row.replay_kind, storagePath: row.storage_path, round: row.rnd, day: row.day, rd: row.rd, a: row.player_a, b: row.player_b, s: row.score_a, games: [] }));

  // A successful qualification/practice result already contains its games.
  // Use that owner-readable result as a fallback when replay object upload or
  // metadata registration failed, so a scored run is still replayable.
  if (!authError && authData.user) {
    const { data: jobs, error: jobsError } = await supabase.from('scoring_jobs')
      .select('id,kind,finished_at,result')
      .eq('user_id', authData.user.id)
      .eq('status', 'succeeded')
      .in('kind', ['entry', 'test'])
      .order('finished_at', { ascending: true });
    if (!jobsError) {
      let jobIndex = 0;
      for (const job of jobs || []) {
        const games = Array.isArray(job.result?.games) ? job.result.games as ReplayGame[] : [];
        if (!games.length) continue;
        const storedReplay = allMatches.find(match => match.kind === 'job' && String(match.id) === String(job.id));
        if (storedReplay) {
          storedReplay.games = games;
          continue;
        }
        jobIndex += 1;
        allMatches.push({
          id: job.id, kind: 'job', round: 0, day: 0, rd: jobIndex,
          a: authData.user.user_metadata?.username || authData.user.email || 'Bạn',
          b: job.kind === 'test' ? 'Bot luyện tập' : 'Bot mẫu',
          s: Number(job.result?.match_score ?? job.result?.qualification_score ?? 0), games,
        });
      }
    } else if (error && !rows.length) {
      throw new Error(`${error.message}; ${jobsError.message}`);
    }
  } else if (error) {
    throw new Error(error.message);
  }
  const dates = [...new Map(allMatches.map(row => [`${row.round},${row.day}`, { round: row.round!, day: row.day! }])).values()]
    .sort((a, b) => b.round - a.round || b.day - a.day);
  const selected = round !== undefined && day !== undefined
    ? { round, day }
    : dates.find(date => date.round === 0 && date.day === 0) || dates[0] || null;
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
