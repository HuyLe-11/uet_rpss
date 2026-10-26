import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, Ban, Check, CircleAlert, Database, Eye,
  FileSpreadsheet, Gauge, RefreshCw, Server, ShieldCheck,
  Swords, Trophy, Upload, Users, UserX, RotateCcw,
} from 'lucide-react';
import { getScoringProxyUrl, supabase } from './api';
import { BarList, ColumnChart } from './Charts';

type Section = 'tournament' | 'eliminated' | 'server' | 'observation' | 'monitor';
type MonitorSnapshot = {
  state: {
    phase: 'entry' | 'round' | 'done'; accepting_submissions: boolean;
    current_round: number; current_day: number; pending_day: number;
    champion_id: string | null; scoring_module_url: string | null; updated_at: string;
  };
  profile_counts: Record<string, number>;
  job_counts: Record<string, number>;
  jobs: Array<Record<string, any>>;
  entrants: Array<Record<string, any>>;
  days: Array<Record<string, any>>;
  matches: Array<Record<string, any>>;
  daily_results: Array<Record<string, any>>;
  live_standings?: { round: number; day: number; standings: Array<Record<string, any>> };
  round_config: Array<Record<string, any>>;
  replay_storage: { objects: number; bytes: number; failed: number };
};

const sectionForRoute = (route: string): Section => route === '/admin/server' ? 'server'
  : route === '/admin/observation' ? 'observation'
    : route === '/admin/monitor' ? 'monitor'
      : route === '/admin/eliminated' ? 'eliminated' : 'tournament';
const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const formatTime = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';

function describeSupabaseError(error: unknown, operation: string): Error {
  const candidate = error as { message?: string; code?: string; details?: string; hint?: string } | null;
  const parts = [candidate?.code, candidate?.message, candidate?.details, candidate?.hint].filter(Boolean);
  const detail = parts.join(' — ') || 'Không có chi tiết từ cơ sở dữ liệu.';
  return new Error(`${operation}: ${detail}`);
}

async function drainReplayCleanupQueue(): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0;
  while (true) {
    const { data, error } = await supabase.rpc('admin_list_reset_cleanup_paths', { p_limit: 500 });
    if (error) throw error;
    const paths = ((data || []) as Array<{ storage_path: string }>).map((row) => row.storage_path);
    if (!paths.length) return { deleted, complete: true };

    const { error: storageError } = await supabase.storage.from('replays').remove(paths);
    if (storageError) return { deleted, complete: false };
    const { data: acknowledged, error: ackError } = await supabase.rpc('admin_ack_reset_cleanup_paths', { p_paths: paths });
    if (ackError) return { deleted, complete: false };
    deleted += Number(acknowledged || 0);
  }
}

export default function AdminDashboard({ route, navigate }: { route: string; navigate: (path: string) => void }) {
  const section = sectionForRoute(route);
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<'entry' | 'round' | 'done'>('entry');
  const [accepting, setAccepting] = useState(true);
  const [round, setRound] = useState(1);
  const [day, setDay] = useState(1);
  const [tournamentActionBusy, setTournamentActionBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [replayCleanupBusy, setReplayCleanupBusy] = useState(false);
  const [eliminatedContestants, setEliminatedContestants] = useState<Array<Record<string, any>>>([]);
  const [contestantActionId, setContestantActionId] = useState<string | null>(null);


  const refresh = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_admin_monitoring');
      if (rpcError) throw rpcError;
      const result = data as MonitorSnapshot;
      const { data: liveData, error: liveError } = await supabase.rpc('get_admin_live_standings');
      if (liveError) {
        console.error('[admin] get_admin_live_standings failed', liveError);
        setError(describeSupabaseError(liveError, 'Không tải được bảng xếp hạng trực tiếp').message);
      } else {
        result.live_standings = liveData;
      }
      setSnapshot(result);
      setPhase(result.state.phase);
      setAccepting(result.state.accepting_submissions);
      setRound(result.state.current_round || 1);
      setDay(result.state.current_day || 1);
      setError('');
    } catch (err: any) {
      setError(err?.message || 'Không thể tải trạng thái cuộc thi.');
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, []);

  const refreshEliminated = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('admin_list_eliminated_contestants');
    if (rpcError) {
      console.error('[admin] admin_list_eliminated_contestants failed', rpcError);
      throw describeSupabaseError(rpcError, 'Không tải được danh sách thí sinh đã loại');
    }
    setEliminatedContestants((data || []) as Array<Record<string, any>>);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (section !== 'eliminated') return;
    void refreshEliminated().catch((err: any) => setError(err?.message || 'Không tải được danh sách thí sinh đã loại.'));
  }, [section, refreshEliminated]);
  useEffect(() => {
    let debounce: number | undefined;
    const scheduleRefresh = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        void refresh(false);
        if (section === 'eliminated') {
          void refreshEliminated().catch((err: any) => setError(err?.message || 'Không tải được danh sách thí sinh đã loại.'));
        }
      }, 800);
    };
    const channel = supabase.channel('admin-system-monitor')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scoring_jobs' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_state' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_results' }, scheduleRefresh)
      .subscribe();
    const fallback = window.setInterval(() => void refresh(false), 15 * 60_000);
    return () => {
      window.clearTimeout(debounce);
      window.clearInterval(fallback);
      void supabase.removeChannel(channel);
    };
  }, [refresh, refreshEliminated, section]);

  const jobs = snapshot?.jobs || [];
  const activeJobs = jobs.filter((job) => ['dispatching', 'accepted', 'running'].includes(job.status));
  const failedJobs = jobs.filter((job) => ['failed', 'timed_out', 'dispatch_failed'].includes(job.status));
  const finishedJobs = jobs.filter((job) => ['succeeded', 'failed', 'timed_out'].includes(job.status));
  const averageDuration = useMemo(() => {
    const durations = finishedJobs.map((job) => job.started_at && job.finished_at
      ? (new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) / 1000 : null)
      .filter((value): value is number => value !== null && value >= 0);
    return durations.length ? `${(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1)} giây` : '—';
  }, [finishedJobs]);

  async function refreshCurrentSection() {
    await refresh();
    if (section === 'eliminated') {
      try { await refreshEliminated(); }
      catch (err: any) {       const described = describeSupabaseError(err, 'Không tải được danh sách thí sinh đã loại');
      console.error('[admin] admin_list_eliminated_contestants failed', err);
      setError(described.message); }
    }
  }

  async function runTournamentAction(path: string, body?: unknown, successText = 'Đã gửi yêu cầu điều hành.') {
    setTournamentActionBusy(true); setError(''); setMessage('');
    try {
      const rpcName = path === 'close-entry' ? 'admin_close_qualification'
        : path === 'close-day' ? 'admin_close_tournament_day'
          : path === 'open-day' ? 'admin_open_tournament_day'
            : 'admin_resume_tournament_day';
      const rpcArgs = path === 'open-day' ? { p_rnd: (body as any)?.round, p_day: (body as any)?.day } : undefined;
      const { error: rpcError } = rpcArgs
        ? await supabase.rpc(rpcName, rpcArgs)
        : await supabase.rpc(rpcName);
      if (rpcError) throw rpcError;
      setMessage(successText);
      await refresh(false);
    } catch (err: any) { setError(err?.message || 'Không thực hiện được thao tác điều hành.'); }
    finally { setTournamentActionBusy(false); }
  }

  async function setSubmissionGate(nextAccepting: boolean) {
    setTournamentActionBusy(true); setError(''); setMessage('');
    try {
      const { error: rpcError } = await supabase.rpc('admin_set_submission_gate', { p_accepting: nextAccepting });
      if (rpcError) throw rpcError;
      setMessage(nextAccepting ? 'Đã mở cổng nhận bài.' : 'Đã đóng cổng nhận bài.');
      await refresh(false);
    } catch (err: any) { setError(err?.message || 'Không đổi được trạng thái cổng nhận bài.'); }
    finally { setTournamentActionBusy(false); }
  }

  async function resetTournament() {
    const confirmed = window.confirm(
      'Reset giải đấu về trạng thái ban đầu? Thao tác này xóa lượt chấm, bài nộp, trận đấu, replay và bảng xếp hạng; gỡ trạng thái loại và đặt lại lượt thi đầu vào. Tài khoản cùng cấu hình giải được giữ lại. Không thể hoàn tác.'
    );
    if (!confirmed) return;
    setResetBusy(true); setError(''); setMessage('');
    try {
      const { data, error: rpcError } = await supabase.rpc('admin_reset_tournament_to_entry', {
        p_live_job_ids: [], p_live_match_ids: [],
      });
      if (rpcError) throw rpcError;
      let cleanup = { deleted: 0, complete: false };
      try { cleanup = await drainReplayCleanupQueue(); } catch { /* Database reset has committed; cleanup can be retried below. */ }
      const cleanupMessage = cleanup.complete
        ? ` Đã xóa ${cleanup.deleted} file replay.`
        : ' Dữ liệu giải đã reset; một số replay chưa xóa khỏi kho lưu trữ. Có thể thử dọn lại.';
      setMessage(`Đã reset về vòng đầu vào (ngày 0), xóa ${data?.deleted_scoring_jobs ?? 0} lượt chấm, làm trống bảng xếp hạng và thu hồi ${data?.recovered_orphaned_jobs ?? 0} job cũ bị bỏ lại.${cleanupMessage}`);
      await refresh(false);
    } catch (err: any) {
      const detail = String(err?.message || '');
      setError(detail.includes('scoring_jobs_still_running')
        ? 'Chưa reset được vì đang có lượt chấm chạy. Chờ các lượt chấm kết thúc rồi thử lại.'
        : detail.includes('tournament_matches_still_running')
          ? 'Chưa reset được vì đang có trận đấu chạy. Chờ trận hoàn tất rồi thử lại.'
          : detail || 'Không reset được giải đấu.');
    } finally { setResetBusy(false); }
  }

  async function retryReplayCleanup() {
    setReplayCleanupBusy(true); setError(''); setMessage('');
    try {
      const result = await drainReplayCleanupQueue();
      setMessage(result.complete
        ? `Đã dọn ${result.deleted} file replay còn tồn.`
        : `Đã dọn ${result.deleted} file replay; vẫn còn file trong hàng đợi, hãy thử lại.`);
    } catch (err: any) {
      setError(err?.message || 'Không thể tải hàng đợi dọn replay.');
    } finally { setReplayCleanupBusy(false); }
  }

  async function setContestantElimination(userId: string, eliminated: boolean) {
    setContestantActionId(userId); setError(''); setMessage('');
    try {
      const { data, error: rpcError } = await supabase.rpc('admin_set_contestant_elimination', {
        p_user_id: userId, p_eliminated: eliminated,
      });
      if (rpcError) throw rpcError;
      setMessage(eliminated ? 'Đã loại thí sinh khỏi giải.' : `Đã gỡ loại thí sinh (trạng thái: ${data}).`);
      await Promise.all([refresh(false), refreshEliminated()]);
    } catch (err: any) {
      setError(err?.message || 'Không cập nhật được trạng thái thí sinh.');
    } finally { setContestantActionId(null); }
  }

  async function setQualificationStatus(userId: string, qualified: boolean) {
    setContestantActionId(userId); setError(''); setMessage('');
    try {
      const { error: rpcError } = await supabase.rpc('admin_set_qualification_status', {
        p_user_id: userId, p_qualified: qualified,
      });
      if (rpcError) throw rpcError;
      setMessage(qualified ? 'Đã đánh dấu thí sinh đã qua vòng loại.' : 'Đã chuyển thí sinh về chưa qua vòng loại.');
      await refresh(false);
      await refreshEliminated();
    } catch (err: any) {
      setError(err?.message || 'Không cập nhật được trạng thái vòng loại.');
    } finally { setContestantActionId(null); }
  }

  const title = section === 'server' ? 'Máy chấm' : section === 'observation' ? 'Quan sát cuộc thi' : section === 'monitor' ? 'Giám sát hệ thống' : section === 'eliminated' ? 'Thí sinh bị loại' : 'Tổng quan giải đấu';
  const counts = snapshot?.profile_counts || {};
  const jobCounts = snapshot?.job_counts || {};

  function exportLiveStandings() {
    const rows = snapshot?.live_standings?.standings || [];
    if (!rows.length) return;
    const columns = ['round', 'day', 'grp', 'rank', 'group_size', 'username', 'pts', 'gs', 'submitted', 'completed_matches', 'group_completed_matches', 'group_total_matches'];
    const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => {
      const value = key === 'round' ? snapshot?.live_standings?.round : key === 'day' ? snapshot?.live_standings?.day : row[key];
      return `"${String(value ?? '').replaceAll('"', '""')}"`;
    }).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `standings-r${snapshot?.live_standings?.round}-d${snapshot?.live_standings?.day}.csv`;
    anchor.click(); URL.revokeObjectURL(url);
  }

  return <div className="admin-dashboard-view" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
    <nav className="admin-section-nav" aria-label="Menu quản trị">
      {[
        ['/admin', 'Quản trị giải đấu', ShieldCheck],
        ['/admin/eliminated', 'Thí sinh bị loại', UserX],
        ['/admin/server', 'Cloudflare Proxy', Swords],
        ['/admin/observation', 'Quan sát hoạt động', Eye],
        ['/admin/monitor', 'Giám sát hệ thống', Gauge],
      ].map(([path, label, Icon]) => {
        const NavIcon = Icon as typeof ShieldCheck;
        return <button key={String(path)} className={route === path ? 'active' : ''} onClick={() => navigate(String(path))}><NavIcon size={16} />{String(label)}</button>;
      })}
    </nav>

    <div className="page-title" style={{ marginBottom: 0 }}>
      <div><p className="eyebrow">BẢNG ĐIỀU KHIỂN BAN TỔ CHỨC</p><h1>{title}</h1>
        <p>{snapshot ? `Cập nhật ${formatTime(snapshot.state.updated_at)} · dữ liệu giải đấu` : 'Đang tải dữ liệu hệ thống…'}</p>
      </div>
      <button className="secondary refresh-button" disabled={loading} onClick={() => void refreshCurrentSection()}><RefreshCw size={16} className={loading ? 'spin' : ''} />{loading ? 'Đang tải' : 'Làm mới'}</button>
    </div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <div className="success" role="status"><Check size={17} />{message}</div>}

    {section === 'tournament' && <>
      <div className="stat-grid">
        <Metric icon={Users} label="Thí sinh" value={counts.total ?? '—'} />
        <Metric icon={Activity} label="Đang hoạt động" value={counts.active ?? '—'} />
        <Metric icon={RefreshCw} label="Đang xử lý" value={Number(jobCounts.dispatching || 0) + Number(jobCounts.accepted || 0) + Number(jobCounts.running || 0)} />
        <Metric icon={CircleAlert} label="Lượt lỗi / timeout" value={Number(jobCounts.failed || 0) + Number(jobCounts.timed_out || 0) + Number(jobCounts.dispatch_failed || 0)} />
      </div>
      <section className="panel">
        <SectionHeading icon={Users} eyebrow="ĐIỀU HÀNH" title="Trạng thái và thao tác giải đấu" />
        <div className="monitor-list">
          <div><span>Giai đoạn</span><strong>{phase === 'entry' ? 'Vòng loại' : phase === 'round' ? `Vòng ${round} · Ngày ${day}` : 'Đã kết thúc các vòng online'}</strong></div>
          <div><span>Nhận bài</span><strong>{accepting ? 'Đang mở' : 'Đang đóng'}</strong></div>
          <div><span>Trạng thái ngày</span><strong>{snapshot?.days.find((item) => item.rnd === round && item.day === day)?.state || 'Chưa mở'}</strong></div>
        </div>
        <div className="phase-controls">
          {phase !== 'done' && <button className={accepting ? 'secondary' : 'primary'} disabled={tournamentActionBusy} onClick={() => void setSubmissionGate(!accepting)}>{accepting ? 'Đóng cổng nhận bài' : 'Mở cổng nhận bài'}</button>}
          {phase === 'entry' && <button className="primary" disabled={tournamentActionBusy} onClick={() => void runTournamentAction('close-entry', undefined, 'Đã chốt đầu vào và chia thí sinh vào 40 bảng.')}>{tournamentActionBusy ? 'Đang xử lý…' : 'Chốt đầu vào & chia bảng'}</button>}
          {phase === 'round' && round <= 4 && snapshot?.days.find((item) => item.rnd === round && item.day === day)?.state === 'open' && <button className="primary" disabled={tournamentActionBusy} onClick={() => void runTournamentAction('close-day', undefined, 'Đã chốt ngày.')}>{tournamentActionBusy ? 'Đang xử lý…' : 'Chốt ngày'}</button>}
          {phase === 'round' && round <= 4 && snapshot?.days.find((item) => item.rnd === round && item.day === day)?.state === 'graded' && day < 7 && <button className="primary" disabled={tournamentActionBusy} onClick={() => void runTournamentAction('open-day', { round, day: day + 1 }, `Đã mở ngày ${day + 1} của vòng ${round}.`)}>Mở ngày {day + 1}</button>}
          <button className="secondary" disabled={resetBusy || tournamentActionBusy} onClick={() => void resetTournament()}><RotateCcw size={16} />{resetBusy ? 'Đang reset…' : 'Reset giải về ngày 0'}</button>
          <button className="secondary" disabled={replayCleanupBusy} onClick={() => void retryReplayCleanup()}><Database size={16} />{replayCleanupBusy ? 'Đang dọn replay…' : 'Dọn replay còn tồn'}</button>
        </div>
        <p className="muted server-note">Reset giữ tài khoản, cấu hình giải và URL máy chấm; xóa dữ liệu thi/replay, gỡ trạng thái loại, đặt mọi thí sinh về đầu vào ngày 0. Nếu lượt chấm hoặc trận còn đang chạy, reset sẽ bị từ chối để tránh xóa dữ liệu giữa chừng; chờ hoàn tất rồi thử lại. Không thể hoàn tác.</p>
        {phase === 'round' && round === 5 && <p className="muted server-note">Vòng thứ năm thi offline chưa được cài đặt. Hệ thống này chỉ vận hành các vòng online.</p>}
      </section>
      <EntrantsTable entrants={snapshot?.entrants || []} />
      <section className="panel">
        <SectionHeading icon={ShieldCheck} eyebrow="TÀI KHOẢN QUẢN TRỊ" title="Quản lý bằng công cụ dòng lệnh an toàn" />
        <p>Việc tạo và import tài khoản admin được thực hiện bằng công cụ dòng lệnh trên máy tin cậy, không qua trình duyệt. Dùng <code>admin_cli_service</code> với khóa quản trị chỉ trên môi trường quản trị.</p>
      </section>
    </>}

    {section === 'eliminated' && <>
      <section className="panel"><SectionHeading icon={UserX} eyebrow="QUẢN LÝ THÍ SINH" title={`Đã loại (${eliminatedContestants.length})`} />
        <p>Danh sách gồm thí sinh bị loại theo kết quả và thí sinh bị ban thủ công. Gỡ loại sẽ khôi phục trạng thái theo giai đoạn hiện tại của giải.</p>
        {!eliminatedContestants.length ? <div className="empty-state"><Users /><h3>Chưa có thí sinh bị loại</h3></div> : <div className="table-scroll"><table>
          <thead><tr><th>Thí sinh</th><th>Email</th><th>Trạng thái</th><th>Điểm đầu vào</th><th>Bảng hiện tại</th><th>Thao tác</th></tr></thead>
          <tbody>{eliminatedContestants.map((contestant) => <tr key={contestant.id}>
            <td>{contestant.username}</td><td>{contestant.email}</td><td>{contestant.status === 'banned' ? 'Bị admin loại' : 'Đã dừng bước'}</td>
            <td>{contestant.entry_score ?? '—'}</td><td>{contestant.grp == null ? '—' : contestant.grp + 1}</td>
            <td><button className="secondary" disabled={contestantActionId === contestant.id} onClick={() => void setContestantElimination(contestant.id, false)}>{contestantActionId === contestant.id ? 'Đang cập nhật…' : 'Gỡ loại'}</button></td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      <section className="panel"><SectionHeading icon={Users} eyebrow="THÍ SINH ĐANG ĐƯỢC THAM GIA" title="Loại thí sinh" />
        <div className="table-scroll"><table><thead><tr><th>Thí sinh</th><th>Trạng thái</th><th>Điểm đầu vào</th><th>Bảng</th><th>Thao tác</th></tr></thead>
          <tbody>{(snapshot?.entrants || []).filter((contestant) => ['new', 'active'].includes(contestant.status)).map((contestant) => <tr key={contestant.id}>
            <td>{contestant.username}</td><td>{contestant.status === 'active' ? 'Đang thi đấu' : 'Chờ thi đầu vào'}</td>
            <td>{contestant.entry_score ?? '—'}</td><td>{contestant.grp == null ? '—' : contestant.grp + 1}</td>
            <td><button className="secondary" disabled={contestantActionId === contestant.id} onClick={() => void setQualificationStatus(contestant.id, false)}><Ban size={15} />Chưa qua vòng loại</button></td>
          </tr>)}</tbody>
        </table></div>
      </section>
    </>}

    {section === 'server' && <section className="panel">
      <SectionHeading icon={Swords} eyebrow="CLOUDFARE PROXY" title="Luồng chấm hiện tại" />
      <p>Tất cả bài thi được ghép với một bot mẫu trong frontend và gửi trực tiếp qua Cloudflare Worker. Admin không còn cấu hình hoặc kiểm tra URL máy chấm cũ.</p>
      <div className="monitor-list">
        <div><span>Worker chấm</span><strong>{getScoringProxyUrl() || 'Chưa cấu hình'}</strong></div>
        <div><span>Bot mẫu</span><strong>Được đóng gói cùng frontend</strong></div>
        <div><span>OnlineCompiler key</span><strong>Được giữ trong Cloudflare Secret</strong></div>
      </div>
    </section>}

    {section === 'observation' && <>
      <div className="observation-summary"><span><strong>{activeJobs.length}</strong> lượt đang xử lý</span><span><strong>{snapshot?.entrants.filter((item) => item.submitted).length || 0}</strong> thí sinh đã nộp ngày hiện tại</span><span><strong>{snapshot?.matches.length || 0}</strong> trận gần nhất</span><span><strong>{failedJobs.length}</strong> lượt cần xem lại</span></div>
      <JobsTable jobs={jobs} />
      <MatchesTable matches={snapshot?.matches || []} />
      <LiveStandingsTable data={snapshot?.live_standings} onExport={exportLiveStandings} />
      <DailyResultsTable rows={snapshot?.daily_results || []} />
    </>}

    {section === 'monitor' && <>
      <div className="stat-grid">
        <Metric icon={Server} label="Cloudflare Proxy" value={getScoringProxyUrl() ? 'Đã cấu hình' : 'Chưa cấu hình'} />
        <Metric icon={Activity} label="Lượt cần xử lý" value={activeJobs.length} />
        <Metric icon={Gauge} label="Thời gian chấm TB" value={averageDuration} />
        <Metric icon={Check} label="Tỉ lệ thành công" value={finishedJobs.length ? `${Math.round((Number(jobCounts.succeeded || 0) / Math.max(1, Object.values(jobCounts).reduce((sum, value) => sum + Number(value), 0))) * 100)}%` : '—'} />
      </div>
      <div className="chart-grid">
        <ColumnChart
          title="Phân bố lượt chấm theo trạng thái"
          loading={!snapshot}
          data={Object.entries(jobCounts).map(([key, value]) => ({
            label: ({ succeeded: 'Thành công', failed: 'Lỗi', timed_out: 'Quá giờ', dispatch_failed: 'Gửi lỗi', dispatching: 'Đang gửi', accepted: 'Đã nhận', running: 'Đang chạy', queued: 'Chờ' } as Record<string, string>)[key] || key,
            value: Number(value),
            tone: key === 'succeeded' ? 'green' as const : ['failed', 'timed_out', 'dispatch_failed'].includes(key) ? 'red' as const : ['running', 'accepted', 'dispatching'].includes(key) ? 'blue' as const : 'muted' as const,
          }))}
        />
        <BarList
          title="Thí sinh theo trạng thái"
          loading={!snapshot}
          data={Object.entries(counts).filter(([key]) => key !== 'total').map(([key, value]) => ({
            label: ({ new: 'Chờ thi đầu vào', active: 'Đang thi đấu', eliminated: 'Đã dừng bước', out: 'Đã dừng bước', banned: 'Bị loại' } as Record<string, string>)[key] || key,
            value: Number(value),
            tone: key === 'active' ? 'green' as const : key === 'new' ? 'blue' as const : key === 'banned' ? 'red' as const : 'muted' as const,
          }))}
        />
      </div>
      <section className="panel"><SectionHeading icon={Database} eyebrow="KHO DỮ LIỆU TRẬN ĐẤU" title="Dung lượng replay đã ghi nhận" />
        <div className="monitor-list"><div><span>Bản ghi replay</span><strong>{snapshot?.replay_storage.objects ?? 0}</strong></div><div><span>Dữ liệu nén</span><strong>{formatBytes(snapshot?.replay_storage.bytes ?? 0)}</strong></div><div><span>Lần tải lên lỗi</span><strong>{snapshot?.replay_storage.failed ?? 0}</strong></div></div>
      </section>
      <JobsTable jobs={failedJobs} title="Yêu cầu lỗi cần xử lý" />
    </>}
  </div>;
}

function Metric({ icon: Icon, label, value }: { icon: typeof Activity; label: string; value: string | number }) {
  return <div className="stat-card"><span className="stat-icon color-0"><Icon size={20} /></span><span><small>{label}</small><strong>{String(value)}</strong></span></div>;
}

function SectionHeading({ icon: Icon, eyebrow, title }: { icon: typeof Activity; eyebrow: string; title: string }) {
  return <div className="section-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><Icon size={19} className="muted" /></div>;
}

function EntrantsTable({ entrants }: { entrants: Array<Record<string, any>> }) {
  return <section className="panel"><SectionHeading icon={Users} eyebrow="DANH SÁCH THÍ SINH" title={`Theo dõi ${entrants.length} tài khoản`} />
    {!entrants.length ? <div className="empty-state"><Users /><h3>Chưa có thí sinh</h3><p>Tài khoản được tạo sẽ xuất hiện tại đây.</p></div> :
      <div className="table-scroll"><table><thead><tr><th>Thí sinh</th><th>Trạng thái</th><th>Điểm vòng loại</th><th>Bảng</th><th>Lượt vòng loại</th><th>Bài ngày này</th><th>Hoạt động cuối</th></tr></thead><tbody>
        {entrants.map((item) => <tr key={item.id}><td>{item.username}</td><td>{item.status}</td><td>{item.entry_score ?? '—'}</td><td>{item.grp ?? '—'}</td><td>{item.entry_attempts}/20</td><td>{item.submitted ? 'Đã nộp' : 'Chưa nộp'}</td><td>{formatTime(item.last_activity)}</td></tr>)}
      </tbody></table></div>}
  </section>;
}

function JobsTable({ jobs, title = 'Trạng thái các yêu cầu chấm' }: { jobs: Array<Record<string, any>>; title?: string }) {
  return <section className="panel"><SectionHeading icon={Activity} eyebrow="YÊU CẦU CHẤM" title={title} />
    {!jobs.length ? <div className="empty-state"><Activity /><h3>Không có yêu cầu phù hợp</h3></div> : <div className="table-scroll"><table>
      <thead><tr><th>Thí sinh</th><th>Loại</th><th>Vòng / ngày</th><th>Trạng thái</th><th>Điểm</th><th>Tạo lúc</th><th>Thời lượng</th><th>Lỗi</th></tr></thead>
      <tbody>{jobs.map((job) => <tr key={job.id}><td>{job.username}</td><td>{job.kind}</td><td>{job.rnd ?? '—'} / {job.day ?? '—'}</td><td>{job.status}</td>
        <td>{job.result?.converted_score ?? '—'}</td><td>{formatTime(job.created_at)}</td>
        <td>{job.started_at && job.finished_at ? `${((new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) / 1000).toFixed(1)}s` : '—'}</td>
        <td>{job.error_code ? `${job.error_code}: ${job.error_message || ''}` : '—'}</td></tr>)}</tbody>
    </table></div>}
  </section>;
}

function MatchesTable({ matches }: { matches: Array<Record<string, any>> }) {
  return <section className="panel"><SectionHeading icon={Swords} eyebrow="GHÉP CẶP" title="Các trận gần nhất" />
    {!matches.length ? <div className="empty-state"><Swords /><h3>Chưa có trận đã chấm</h3><p>Ghép cặp và chấm vòng/ngày chưa được vận hành qua hệ thống chấm mới.</p></div> : <div className="table-scroll"><table>
      <thead><tr><th>Vòng / ngày</th><th>Bảng / lượt</th><th>Thí sinh A</th><th>Thí sinh B</th><th>Điểm A</th><th>Replay</th></tr></thead>
      <tbody>{matches.map((match) => <tr key={match.id}><td>{match.rnd} / {match.day}</td><td>{match.grp} / {match.rd}</td><td>{match.player_a}</td><td>{match.player_b}</td><td>{match.state === 'completed' ? match.score_a : match.state}</td><td>{match.has_replay ? 'Có' : '—'}</td></tr>)}</tbody>
    </table></div>}
  </section>;
}

function LiveStandingsTable({ data, onExport }: { data?: MonitorSnapshot['live_standings']; onExport: () => void }) {
  const rows = data?.standings || [];
  return <section className="panel"><div className="section-heading"><div><p className="eyebrow">ADMIN · CẬP NHẬT LIÊN TỤC</p><h2>Bảng điểm tạm thời vòng {data?.round ?? '—'} · ngày {data?.day ?? '—'}</h2></div>
    <button className="secondary" disabled={!rows.length} onClick={onExport}><FileSpreadsheet size={16} />Tải CSV</button></div>
    {!rows.length ? <p className="muted">Chưa có thí sinh được xếp bảng trong ngày hiện tại.</p> : <div className="table-scroll"><table><thead><tr><th>Bảng</th><th>Hạng tạm</th><th>Thí sinh</th><th>Điểm trận</th><th>Điểm ván</th><th>Lượt đã nộp</th><th>Trận đã xong</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.user_id}><td>{row.grp + 1}</td><td>{row.rank}/{row.group_size}</td><td>{row.username}</td><td>{row.pts}</td><td>{row.gs}</td><td>{row.submitted}/7</td><td>{row.completed_matches}</td></tr>)}</tbody></table></div>}
  </section>;
}

function DailyResultsTable({ rows }: { rows: Array<Record<string, any>> }) {
  return <details className="panel"><summary className="admin-details-summary"><Trophy size={17} /> Kết quả các ngày gần đây ({rows.length})</summary>
    <div className="table-scroll" style={{ marginTop: 16 }}><table><thead><tr><th>Vòng / ngày</th><th>Bảng</th><th>Hạng</th><th>Thí sinh</th><th>Điểm trận</th><th>Điểm ván</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={`${row.rnd}-${row.day}-${row.user_id}`}><td>{row.rnd} / {row.day}</td><td>{row.grp}</td><td>{row.rank}/{row.group_size}</td><td>{row.username}</td><td>{row.pts}</td><td>{row.gs}</td></tr>)}</tbody></table></div>
  </details>;
}

function SystemMetrics({ metrics, state }: { metrics: Record<string, any> | null; state: string }) {
  const judge = metrics?.judge0;
  return <section className="panel"><SectionHeading icon={Gauge} eyebrow="TRẠNG THÁI VẬN HÀNH" title="Tình trạng máy chấm" />
    <div className="monitor-list"><div><span>Kết nối máy chấm</span><strong>{state === 'online' ? 'Đang hoạt động' : state === 'offline' ? 'Mất kết nối' : 'Chưa kiểm tra'}</strong></div>
      <div><span>Môi trường chạy bot</span><strong>{judge?.status === 'online' ? 'Đang hoạt động' : judge?.status === 'offline' ? 'Mất kết nối' : 'Chưa có số liệu'}</strong></div>
      <div><span>Lượt đang xử lý / tổng lượt đồng thời</span><strong>{metrics ? `${metrics.active_jobs}/${metrics.workers}` : '—'}</strong></div>
      <div><span>Queue đang dùng / sức chứa</span><strong>{metrics ? `${metrics.queue_depth}/${metrics.queue_limit}` : '—'}</strong></div>
      <div><span>Job đang chờ</span><strong>{metrics ? `${metrics.queued_jobs} · lâu nhất ${metrics.oldest_queued_seconds}s` : '—'}</strong></div>
      <div><span>Job bị từ chối do quá tải</span><strong>{metrics ? metrics.rejected_jobs : '—'}</strong></div>
      <div><span>Kết quả hoàn tất / thất bại</span><strong>{metrics ? `${metrics.completed_jobs}/${metrics.failed_jobs}` : '—'}</strong></div>
      <div><span>Thời gian chạy liên tục</span><strong>{metrics ? `${Math.floor(metrics.uptime_seconds / 3600)}h ${Math.floor(metrics.uptime_seconds % 3600 / 60)}m` : '—'}</strong></div>
      <div><span>Giới hạn thời gian chạy / thời gian thực</span><strong>{judge?.status === 'online' ? `${judge.max_cpu_time_limit}s / ${judge.max_wall_time_limit}s` : '—'}</strong></div>
      <div><span>Timeout match / toàn job</span><strong>{metrics ? `${metrics.match_timeout_seconds}s / ${metrics.job_timeout_seconds}s` : '—'}</strong></div>
      <div><span>Bộ nhớ tối đa mỗi lượt</span><strong>{judge?.status === 'online' && judge.max_memory_limit ? `${Math.round(judge.max_memory_limit / 1024)} MB` : '—'}</strong></div>
    </div>
  </section>;
}
