import { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  ChartNoAxesColumnIncreasing,
  Check,
  ChevronRight,
  Code2,
  Eye,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Server,
  Swords,
  Trophy,
  Upload,
  UserRound,
  UserX,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { ThemeToggle, useSidebarCollapsed } from './theme';
import Auth, { Brand } from './Auth';
import Replay from './Replay';
import SubmissionHistory from './SubmissionHistory';
import AdminDashboard from './AdminDashboard';
import Arena from './Arena';
import BotEditor from './BotEditor';
import { createAndDispatchScoringJob, getMyTodayMatches, getReplayMetadata, getSavedScoringUrl, getScoringBenchmarks, getWebDashboard, getScoringProxyUrl, pollProxyScore, saveScoringUrl, submitProxyScore, supabase, type Replays, type ScoringBenchmark, type ScoringJob, type ScoringState, type Standing, type Status, type TodayMatch, type User } from './api';

const emptyReplays: Replays = { available: [], round: null, day: null, matches: [], allMatches: [] };
const statusLabel: Record<string, string> = {
  new: 'Chờ thi đầu vào',
  active: 'Đang thi đấu',
  eliminated: 'Đã dừng bước',
  out: 'Đã dừng bước',
  entry: 'Thi đầu vào',
  round: 'Vòng thi đấu',
  done: 'Đã kết thúc',
};

function routeForPath(path: string, isAdmin: boolean) {
  if (isAdmin) return path.startsWith('/admin') ? path : '/admin';
  if (path.startsWith('/admin')) return '/';
  return ['/arena', '/submission', '/ranking', '/replay', '/rules'].includes(path) ? path : '/';
}

function useRoute(isAdmin: boolean) {
  const [path, setPath] = useState(() => routeForPath(window.location.pathname, isAdmin));
  useEffect(() => {
    const onPopState = () => setPath(routeForPath(window.location.pathname, isAdmin));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [isAdmin]);
  useEffect(() => {
    if (window.location.pathname !== path) window.history.replaceState({}, '', path);
  }, [path]);
  const navigate = useCallback((nextPath: string) => {
    const safePath = routeForPath(nextPath, isAdmin);
    if (window.location.pathname !== safePath) window.history.pushState({}, '', safePath);
    setPath(safePath);
  }, [isAdmin]);
  return { path, navigate };
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    async function initAuth() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('username, role')
            .eq('id', session.user.id)
            .single();

          const name = profile?.username || session.user.user_metadata?.username || session.user.email?.split('@')[0] || 'User';
          setUser({
            id: session.user.id,
            email: session.user.email,
            name,
            role: profile?.role || 'contestant',
          });
        }
      } catch (err) {
        console.error('Lỗi khởi tạo session:', err);
      } finally {
        setReady(true);
      }
    }

    void initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('username, role')
          .eq('id', session.user.id)
          .single();

        const name = profile?.username || session.user.user_metadata?.username || session.user.email?.split('@')[0] || 'User';
        setUser({
          id: session.user.id,
          email: session.user.email,
          name,
          role: profile?.role || 'contestant',
        });
      } else {
        setUser(null);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  if (!ready) {
    return (
      <div className="loading-screen">
        <Swords />
        <h2>UET_RPS</h2>
        <p>Đang chuẩn bị đấu trường…</p>
      </div>
    );
  }

  return user ? (
    <Dashboard user={user} onLogout={() => {
      setUser(null);
      window.history.replaceState({}, '', '/');
    }} />
  ) : (
    <Auth onLogin={(nextUser) => {
      setUser(nextUser);
      window.history.replaceState({}, '', nextUser.role === 'admin' ? '/admin' : '/');
    }} />
  );
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { path, navigate } = useRoute(user.role === 'admin');
  const isAdminPage = path.startsWith('/admin');
  const tab = isAdminPage ? 'admin' : path === '/arena' ? 'arena' : path === '/submission' ? 'submission' : path === '/ranking' ? 'ranking' : path === '/replay' ? 'replay' : path === '/rules' ? 'rules' : 'overview';
  const [status, setStatus] = useState<Status | null>(null);
  const [standings, setStandings] = useState<Standing[]>([]);
  const [replays, setReplays] = useState<Replays>(emptyReplays);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [sidebarCollapsed, toggleSidebarCollapsed] = useSidebarCollapsed();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [sourceCode, setSourceCode] = useState('');
  const [editorMode, setEditorMode] = useState<'editor' | 'file'>('editor');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJobStatus, setActiveJobStatus] = useState<ScoringJob['status'] | null>(null);
  const [latestScoringResult, setLatestScoringResult] = useState<Record<string, any> | null>(null);
  const [latestScoringKind, setLatestScoringKind] = useState<'entry' | 'submission' | 'test' | null>(null);
  const [scoringState, setScoringState] = useState<ScoringState | null>(null);
  const [champion, setChampion] = useState<string | null>(null);
  const [scoringUrl, setScoringUrl] = useState(getSavedScoringUrl);
  const [todayMatches, setTodayMatches] = useState<TodayMatch[]>([]);
  const [practiceMode, setPracticeMode] = useState(false);
  const [practiceBots, setPracticeBots] = useState<ScoringBenchmark[]>([]);
  const [selectedPracticeBots, setSelectedPracticeBots] = useState<string[]>([]);
  const [proxyJobMode, setProxyJobMode] = useState(false);
  const [ideFullscreen, setIdeFullscreen] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && ideFullscreen) {
        setIdeFullscreen(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [ideFullscreen]);

  useEffect(() => { setIdeFullscreen(false); }, [tab]);

  useEffect(() => {
    if (!scoringUrl) { setPracticeBots([]); setSelectedPracticeBots([]); return; }
    let cancelled = false;
    void getScoringBenchmarks(scoringUrl).then((items) => {
      if (cancelled) return;
      setPracticeBots(items);
      setSelectedPracticeBots((current) => current.length ? current.filter((id) => items.some((item) => item.id === id)) : items.slice(0, 1).map((item) => item.id));
    }).catch(() => { if (!cancelled) setPracticeBots([]); });
    return () => { cancelled = true; };
  }, [scoringUrl]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [dashboard, r, matches] = await Promise.all([
        getWebDashboard(),
        getReplayMetadata().catch(() => emptyReplays),
        getMyTodayMatches().catch(() => [] as TodayMatch[]),
      ]);
      setStatus(dashboard.status);
      setStandings(dashboard.standings);
      if (r) setReplays(r);
      setTodayMatches(matches);
      setChampion(dashboard.champion);
      setScoringState(dashboard.scoring);
      setScoringUrl((current) => {
        const configured = dashboard.scoring.scoringUrl || '';
        const next = current || configured;
        if (!current && next) saveScoringUrl(next);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tải được dữ liệu');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (user.role !== 'admin') void refresh();
  }, [refresh, user.role]);

  useEffect(() => {
    if (!activeJobId) return;
    let finished = false;
    if (proxyJobMode) {
      const readProxyJob = async () => {
        try {
          const job = await pollProxyScore(activeJobId);
          if (finished) return;
          setActiveJobStatus(job.status === 'waiting' || job.status === 'queued' ? 'accepted' : job.status === 'running' ? 'running' : job.status);
          if (job.status === 'waiting' || job.status === 'queued' || job.status === 'running') return;
          finished = true;
          setActiveJobId(null);
          if (job.status === 'succeeded') {
            setLatestScoringResult({ ok: true, match_score: job.match_score, games: job.games });
            setMessage('Trận đấu đã được chấm xong.');
          } else {
            setLatestScoringResult(null);
            setError(job.error || 'Cloudflare proxy không hoàn tất trận đấu.');
          }
          await refresh();
        } catch (error) {
          if (!finished) setError(error instanceof Error ? error.message : 'Không đọc được trạng thái chấm.');
        }
      };
      void readProxyJob();
      const timer = window.setInterval(() => void readProxyJob(), 3000);
      return () => { finished = true; window.clearInterval(timer); };
    }
    const readJob = async () => {
      const { data, error: readError } = await supabase
        .from('scoring_jobs')
        .select('id,status,result,error_code,error_message')
        .eq('id', activeJobId)
        .maybeSingle();
      if (finished || readError || !data) return;
      const job = data as ScoringJob;
      if (['dispatching', 'accepted', 'running'].includes(job.status)) {
        setActiveJobStatus(job.status);
        setMessage(job.status === 'running' ? 'Đang chấm bài…' : 'Máy chấm đã nhận bài, đang chờ xử lý…');
        return;
      }
      finished = true;
      setActiveJobId(null);
      setActiveJobStatus(job.status);
      if (job.status === 'succeeded') {
        setLatestScoringResult(job.result || {});
        setMessage('');
      } else {
        setLatestScoringResult(null);
        setLatestScoringKind(null);
        setError(job.error_code === 'module_unavailable'
          ? 'Máy chấm không nhận được bài. Vui lòng thử lại.'
          : `Chấm bài thất bại${job.error_code ? ` (${job.error_code})` : ''}. Vui lòng thử lại.`);
        setMessage('');
      }
      await refresh();
    };
    void readJob();
    // Realtime is the fast path. This slow poll only recovers missed events.
    const timer = window.setInterval(() => void readJob(), 12_000);
    const channel = supabase
      .channel(`scoring-job-${activeJobId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'scoring_jobs', filter: `id=eq.${activeJobId}`,
      }, () => void readJob())
      .subscribe();
    return () => {
      finished = true;
      window.clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [activeJobId, proxyJobMode, refresh, user.id]);

  async function upload(form: HTMLFormElement, forcePractice = false) {
    const submissionFile = file || (sourceCode.trim()
      ? new File([sourceCode], 'bot.py', { type: 'text/x-python' })
      : null);
    if (!submissionFile) return;
    setUploading(true);
    setError('');
    setMessage('');
    setLatestScoringResult(null);
    setLatestScoringKind(null);
    try {
      if (!submissionFile.name.endsWith('.py')) throw new Error('Chỉ nhận file Python .py');
      if (submissionFile.size > 65536) throw new Error('File bot không được vượt quá 64 KB');
      
      setMessage('Đang gửi bài đến máy chấm…');
      const activePracticeMode = forcePractice || practiceMode;
      const kind = activePracticeMode ? 'test' : scoringState?.phase === 'round' ? 'submission' : 'entry';
      setLatestScoringKind(kind);
      const context = kind === 'submission' && scoringState?.round && scoringState.day
        ? { round: scoringState.round, day: scoringState.day }
        : null;
      if (activePracticeMode && !selectedPracticeBots.length) throw new Error('Hãy chọn ít nhất một bot mẫu để luyện tập.');
      const useDirectProxy = Boolean(getScoringProxyUrl()) && kind === 'submission' && todayMatches[0]?.match_id;
      let jobId: string;
      if (useDirectProxy) {
        const source = await submissionFile.text();
        const proxyJob = await submitProxyScore(source, { matchId: todayMatches[0].match_id });
        jobId = proxyJob.job_id;
        setProxyJobMode(true);
      } else {
        jobId = await createAndDispatchScoringJob(submissionFile, kind, scoringUrl, context, activePracticeMode ? selectedPracticeBots : []);
        setProxyJobMode(false);
      }
      setActiveJobId(jobId);
      setActiveJobStatus('accepted');
      setMessage('Máy chấm đã nhận bài, đang chấm…');

      form.reset();
      setFile(null);
      await refresh();
    } catch (e) {
      setMessage('');
      setError(e instanceof Error ? e.message : 'Gửi bài thất bại');
    } finally {
      setUploading(false);
    }
  }

  const baseNavigation = [
    ['overview', LayoutDashboard, 'Tổng quan'],
    ['arena', Code2, 'Code Arena'],
    ['submission', Upload, 'Nộp bài'],
    ['ranking', Trophy, 'Bảng xếp hạng'],
    ['replay', Swords, 'Phát lại trận đấu'],
    ['rules', BookOpen, 'Tài liệu và trạng thái'],
  ] as const;

  const adminNavigation = [
    ['admin_tournament', ShieldCheck, 'Quản trị giải đấu'],
    ['admin_eliminated', UserX, 'Thí sinh bị loại'],
    ['admin_server', Server, 'Quản trị máy chấm'],
    ['admin_observation', Eye, 'Quan sát hoạt động'],
    ['admin_monitor', ChartNoAxesColumnIncreasing, 'Giám sát hệ thống'],
  ] as const;
  const navigation = user.role === 'admin' ? adminNavigation : baseNavigation;
  const routeByTab: Record<string, string> = {
    overview: '/', arena: '/arena', submission: '/submission', ranking: '/ranking', replay: '/replay', rules: '/rules', admin: '/admin',
    admin_tournament: '/admin', admin_eliminated: '/admin/eliminated', admin_server: '/admin/server',
    admin_observation: '/admin/observation', admin_monitor: '/admin/monitor',
  };
  const entryLimitReached = scoringState?.phase === 'entry' && scoringState.attempts >= 20;
  // The server checks submission availability again when accepting a job.
  const submissionsAllowed = !scoringState || Boolean(scoringState.accepting && scoringState.phase !== 'done' && !entryLimitReached);
  const uploadAllowed = practiceMode || submissionsAllowed;

  return (
    <div className="dashboard">
      <button
        type="button"
        className={`sidebar-backdrop ${mobileNavOpen ? 'open' : ''}`}
        aria-label="Đóng menu"
        onClick={() => setMobileNavOpen(false)}
      />
      <aside className={`sidebar ${isAdminPage ? 'admin-sidebar' : ''} ${sidebarCollapsed ? 'collapsed' : ''} ${mobileNavOpen ? 'open' : ''}`}>
        <div className="sidebar-head">
          <Brand />
          <button
            type="button"
            className="sidebar-toggle"
            onClick={toggleSidebarCollapsed}
            aria-label={sidebarCollapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'}
            aria-expanded={!sidebarCollapsed}
            data-tip={sidebarCollapsed ? 'Mở rộng' : 'Thu gọn'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        <p className="nav-caption">{isAdminPage ? 'ĐIỀU HÀNH CUỘC THI' : 'ĐẤU TRƯỜNG CỦA BẠN'}</p>
        <nav>
          {navigation.map(([key, Icon, text]) => {
            const active = isAdminPage ? path === routeByTab[key] : tab === key;
            return <button key={key} className={active ? 'active' : ''} data-tip={text} aria-label={text} onClick={() => { navigate(routeByTab[key]); setMobileNavOpen(false); }}>
              <Icon size={19} />
              <span className="nav-label">{text}</span>
              {active && <ChevronRight size={15} />}
            </button>;
          })}
        </nav>

        {user.role !== 'admin' && <div className="sidebar-tip">
          <ShieldCheck />
          <h3>Sẵn sàng bứt phá?</h3>
          <p>Hoàn thiện thuật toán rồi gửi bot để được chấm ngay trong giai đoạn đang mở.</p>
          <a
            href="/rules"
            onClick={(e) => {
              e.preventDefault();
              navigate('/rules');
              setMobileNavOpen(false);
            }}
          >
            Xem bot mẫu <ArrowRight size={15} />
          </a>
        </div>}

        {user.role !== 'admin' && <a className="live-link" href="/live-board.json" target="_blank" rel="noreferrer" data-tip="Theo dõi live data" aria-label="Theo dõi live data">
          <span className="live-dot" /> <span className="nav-label">Theo dõi live data</span>
        </a>}

        <div className="sidebar-tools"><ThemeToggle showLabel /></div>

        <div className="sidebar-user">
          <span className="avatar">{user.name.slice(0, 2).toUpperCase()}</span>
          <div>
            <strong>{user.name}</strong>
            <small>{user.role === 'admin' ? 'Ban tổ chức (Admin)' : 'Thí sinh'}</small>
          </div>
          <button
            aria-label="Đăng xuất"
            disabled={logoutBusy}
            onClick={async () => {
              setLogoutBusy(true);
              try {
                await supabase.auth.signOut();
                onLogout();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Không đăng xuất được');
              } finally {
                setLogoutBusy(false);
              }
            }}
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="dashboard-header">
          <span>
            <button type="button" className="mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Mở menu"><Menu size={18} /></button>
            {isAdminPage ? 'Khu vực quản trị' : 'Không gian thi đấu'} <ChevronRight size={14} /> {isAdminPage ? (navigation.find((n) => routeByTab[n[0]] === path)?.[2] || 'Quản trị giải đấu') : navigation.find((n) => n[0] === tab)?.[2]}
          </span>
          <span className="badge">
            <span className="live-dot" /> UET_RPS · FIT-UET
          </span>
        </header>

        <main className="dashboard-content">
          {!isAdminPage && <div className="page-title">
            <div>
              <p className="eyebrow">LET’S MAKE YOUR NEXT MOVE</p>
              <h1>{isAdminPage ? (navigation.find((n) => routeByTab[n[0]] === path)?.[2] || 'Quản trị giải đấu') : tab === 'overview' ? `Chào ${user.name}!` : navigation.find((n) => n[0] === tab)?.[2]}</h1>
              <p>
                {tab === 'overview'
                  ? 'Một chiến thuật tốt bắt đầu từ một ý tưởng. Hôm nay bạn đã sẵn sàng chưa?'
                  : isAdminPage
                  ? 'Theo dõi và điều hành các hoạt động của cuộc thi.'
                  : 'Theo dõi, phân tích và hoàn thiện chiến thuật của bạn.'}
              </p>
            </div>
            {!isAdminPage && (
              <button className="secondary refresh-button" disabled={busy} onClick={() => void refresh()}>
                <RefreshCw size={16} className={busy ? 'spin' : ''} />
                {busy ? 'Đang tải' : 'Làm mới'}
              </button>
            )}
          </div>}

          {!isAdminPage && error && <div className="form-error" role="alert">{error}</div>}
          {!isAdminPage && message && <div className="success" role="status"><Check size={18} />{message}</div>}
          {!isAdminPage && (uploading || (activeJobId && ['dispatching', 'accepted', 'running'].includes(activeJobStatus || ''))) && (
            <div className="scoring-progress" role="status" aria-live="polite">
              <RefreshCw size={20} className="spin" />
              <div><strong>{uploading ? 'Đang gửi bài đến máy chấm' : 'Bài đã được nhận, đang chấm'}</strong>
                <span>{activeJobStatus === 'running' ? 'Trận đấu đang được xử lý và tính điểm.' : 'Giữ trang này mở để theo dõi kết quả.'}</span>
              </div>
              <div className="scoring-progress-track"><i /></div>
            </div>
          )}
          {!isAdminPage && latestScoringResult && latestScoringKind && (
            <ScoringResultCard result={latestScoringResult} kind={latestScoringKind} />
          )}
          {!isAdminPage && champion && (
            <div className="champion-banner">
              <Trophy /> Nhà vô địch giải đấu: <strong>{champion}</strong>
            </div>
          )}

          {isAdminPage && <AdminDashboard route={path} navigate={navigate} />}

          {tab === 'arena' && <Arena source={sourceCode} onSourceChange={setSourceCode} />}

          {(tab === 'overview' || tab === 'submission') && (
            <>
                  {tab === 'overview' && !ideFullscreen && <>
              <section className="welcome-banner">
                <div>
                  <span className="pill">ĐẤU TRƯỜNG THUẬT TOÁN</span>
                  <h2>Code thông minh.<br />Chơi khác biệt.</h2>
                  <p>✊ Búa · 🖐 Bao · ✌️ Kéo — Ba loại quân, vô vàn chiến thuật.</p>
                  <div className="banner-actions">
                    <button type="button" className="banner-btn-primary" onClick={() => navigate('/submission')}>
                      <span>Nộp bài ngay</span> <ArrowRight size={17} />
                    </button>
                    <button type="button" className="banner-btn-secondary" onClick={() => navigate('/rules')}>
                      <BookOpen size={16} /> <span>Tài liệu & trạng thái</span>
                    </button>
                  </div>
                </div>
                <div className="banner-pieces" aria-hidden="true">
                  <span>✊</span><span>🖐</span><span>✌️</span>
                </div>
              </section>

              <div className="stat-grid">
                {[
                  [UserRound, 'Trạng thái', status ? statusLabel[status.status] ?? status.status : '—'],
                  [Swords, 'Giai đoạn', scoringState ? ({ entry: 'Vòng loại', round: 'Thi đấu', done: 'Đã kết thúc' }[scoringState.phase]) : '—'],
                  [ChartNoAxesColumnIncreasing, 'Điểm tốt nhất', scoringState?.bestScore ?? status?.entry ?? '—'],
                  [Trophy, 'Bảng thi đấu', status?.group ?? 'Chưa chia bảng'],
                ].map(([Icon, label, value], i) => {
                  const I = Icon as typeof Trophy;
                  return (
                    <div className="stat-card" key={i}>
                      <span className={`stat-icon color-${i}`}><I size={20} /></span>
                      <span>
                        <small>{String(label)}</small>
                        <strong>{String(value)}</strong>
                      </span>
                    </div>
                  );
                })}
              </div>
              </>}

              <div className={`content-grid ${ideFullscreen ? 'is-fullscreen' : ''}`}>
                <section className="panel upload-panel ide-panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">YOUR NEXT CHALLENGER</p>
                      <h2>Gửi bot để chấm ngay</h2>
                    </div>
                    <div className="section-heading-actions">
                      <div className="segmented" role="tablist" aria-label="Chế độ nộp">
                        <button type="button" role="tab" aria-selected={!practiceMode} className={!practiceMode ? 'active' : ''} onClick={() => setPracticeMode(false)}>Nộp bài thi</button>
                        <button type="button" role="tab" aria-selected={practiceMode} className={practiceMode ? 'active' : ''} onClick={() => setPracticeMode(true)}>Luyện tập</button>
                      </div>
                      <button
                        type="button"
                        className={`fullscreen-toggle-btn ${ideFullscreen ? 'active' : ''}`}
                        onClick={() => setIdeFullscreen(!ideFullscreen)}
                        title={ideFullscreen ? "Thu nhỏ (Esc)" : "Phóng to"}
                        aria-label={ideFullscreen ? "Thu nhỏ" : "Phóng to"}
                      >
                        {ideFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                        <span>{ideFullscreen ? 'Thu nhỏ' : 'Phóng to'}</span>
                      </button>
                      <Code2 className="muted" />
                    </div>
                  </div>
                  <div className="ide-top-info">
                    <p className="ide-lead">Bot được chấm ngay sau khi gửi. Giai đoạn vòng loại cho tối đa 20 lượt; hệ thống giữ điểm cao nhất.</p>
                    {!practiceMode && scoringState?.phase === 'entry' && <p className="attempt-count">Đã dùng {Math.min(scoringState.attempts, 20)}/20 lượt · Điểm đầu vào tốt nhất: {scoringState.bestScore ?? '—'}/12</p>}
                    {!practiceMode && scoringState && !submissionsAllowed && <p className="form-error">{entryLimitReached ? 'Bạn đã dùng hết 20 lượt vòng loại.' : 'Hiện tại hệ thống đang đóng nhận bài.'}</p>}
                  </div>

                  {practiceMode && <>
                    <div className="ide-toolbar">
                      <span className="lang-badge"><Code2 size={13} /> OnlineCompiler · không tính điểm</span>
                    </div>
                    <Arena embedded source={sourceCode} onSourceChange={setSourceCode} />
                  </>}
                  {!practiceMode && <form className="ide-form" onSubmit={(e) => { e.preventDefault(); void upload(e.currentTarget); }}>
                    {editorMode === 'editor' && (
                      <div className="ide-editor">
                        <div className="ide-editor-bar">
                          <span><i /><i /><i /></span>
                          <code>bot.py</code>
                          <small>def choose_move(state) → (x, y, nx, ny)</small>
                          <button
                            type="button"
                            className="editor-bar-fs"
                            onClick={() => setIdeFullscreen(!ideFullscreen)}
                            title={ideFullscreen ? "Thu nhỏ (Esc)" : "Phóng to"}
                          >
                            {ideFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                          </button>
                        </div>
                        <BotEditor
                          value={sourceCode}
                          onChange={setSourceCode}
                          height={ideFullscreen ? "max(420px, calc(100vh - 380px))" : "min(62vh, 560px)"}
                        />
                      </div>
                    )}

                    {editorMode === 'file' && (
                      <label className="drop-zone">
                        <span className="upload-icon"><Upload /></span>
                        <strong>{file ? file.name : 'Chọn file bot Python'}</strong>
                        <span>{file ? `${(file.size / 1024).toFixed(1)} KB` : 'Định dạng .py · Tối đa 64 KB'}</span>
                        <input
                          aria-label="Chọn file bot Python"
                          type="file"
                          accept=".py"
                          disabled={uploading || !uploadAllowed}
                          onChange={async (e) => {
                            const next = e.target.files?.[0] ?? null;
                            setFile(next);
                            if (next) setSourceCode(await next.text());
                          }}
                        />
                      </label>
                    )}

                    {/* Các nút option đã chuyển xuống bên dưới */}
                    <div className="ide-bottom-options">
                      <div className="ide-toolbar">
                        
                        <div className="segmented" role="tablist" aria-label="Cách nhập bot">
                          <button type="button" role="tab" aria-selected={editorMode === 'editor'} className={editorMode === 'editor' ? 'active' : ''} onClick={() => { setEditorMode('editor'); setFile(null); }}>Code trực tiếp</button>
                          <button type="button" role="tab" aria-selected={editorMode === 'file'} className={editorMode === 'file' ? 'active' : ''} onClick={() => setEditorMode('file')}>Gửi file .py</button>
                        </div>
                        <span className="lang-badge" title="Ngôn ngữ được cố định cho cuộc thi"><Code2 size={13} /> Python 3 · cố định</span>
                      </div>

                      {practiceMode && <section className="ide-collapse practice-picker" aria-label="Chọn bot để luyện tập">
                        <strong>Chọn bot mẫu để đấu</strong>
                        <small>Luyện tập không tính vào 20 lượt vòng loại hoặc kết quả giải.</small>
                        <div className="chip-row">
                          {practiceBots.length ? practiceBots.map((bot) => <label key={bot.id} className={`chip ${selectedPracticeBots.includes(bot.id) ? 'on' : ''}`}><input type="checkbox" checked={selectedPracticeBots.includes(bot.id)} onChange={(event) => setSelectedPracticeBots((current) => event.target.checked ? [...current, bot.id] : current.filter((id) => id !== bot.id))} />{bot.name}</label>) : <small>Chưa tải được danh sách bot mẫu. Kiểm tra URL máy chấm.</small>}
                        </div>
                      </section>}

                      {scoringState?.phase === 'round' && <details className="ide-collapse" aria-label="Các đối thủ hôm nay">
                        <summary>Đối thủ của bạn hôm nay ({todayMatches.length})</summary>
                        {todayMatches.length ? todayMatches.map((match) => <div className="opponent-line" key={`${match.rnd}-${match.day}-${match.rd}`}>
                          <span>Lượt {match.rd}</span><strong>{match.opponent}</strong>
                        </div>) : <small>Cặp đấu sẽ xuất hiện khi ban tổ chức mở ngày thi.</small>}
                      </details>}

                      {!getScoringProxyUrl() && <label className="scoring-url-field">
                        URL máy chấm do ban tổ chức cung cấp
                        <input type="url" required value={scoringUrl} placeholder="https://score.tenmiencuaban.vn" aria-describedby="scoring-url-help" onChange={(event) => { setScoringUrl(event.target.value); saveScoringUrl(event.target.value); }} />
                        <small id="scoring-url-help">URL được kiểm tra trước khi gửi. Dùng địa chỉ HTTPS của máy chấm; hệ thống lưu lựa chọn trên trình duyệt này.</small>
                      </label>}
                    </div>

                    <div className="ide-actions">
                      <a className="download-link" href="/sample_bot.py" target="_blank" rel="noreferrer">
                        <ArrowDownToLine size={16} /> Xem bot mẫu
                      </a>
                      <button className="primary" disabled={(!file && !sourceCode.trim()) || uploading || !uploadAllowed || (practiceMode && !selectedPracticeBots.length) || Boolean(activeJobId)}>
                        {uploading ? 'Đang gửi…' : activeJobId ? 'Đang chấm…' : practiceMode ? 'Đấu bot mẫu để luyện tập' : 'Gửi bot để chấm ngay'}
                        <ArrowRight size={17} />
                      </button>
                    </div>
                  </form>}
                </section>


                <section className="panel match-history-panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">MATCH HISTORY</p>
                      <h2>Lịch sử đấu</h2>
                    </div>
                    <span className="badge">{todayMatches.length} đối thủ</span>
                  </div>
                  <div className="match-history-list">
                    {todayMatches.length ? todayMatches.map((match) => <div className="match-history-row" key={match.match_id}>
                      <span>Lượt {match.rd}</span><strong>{match.opponent}</strong><small>ID: {match.match_id}</small><b>{match.state}</b>
                    </div>) : <p className="muted">Chưa có cặp đấu trong ngày hiện tại.</p>}
                  </div>
                  {latestScoringResult && <div className="history-score-card"><span>Điểm gần nhất</span><strong>{latestScoringResult.match_score ?? latestScoringResult.qualification_score ?? '—'}</strong></div>}
                  <button className="secondary full" onClick={() => navigate('/replay')}>
                    Xem lại trận đấu <ArrowRight size={16} />
                  </button>
                </section>
              </div>
              {(tab === 'submission' || tab === 'overview') && !ideFullscreen && <SubmissionHistory user={user} replays={replays}/>}
            </>
          )}

          {tab === 'ranking' && (
            <section className="panel">
              <div className="section-heading">
                <h2>Bảng xếp hạng của bạn</h2>
                <span className="badge">Kết quả thi đấu</span>
              </div>
              {!standings.length ? (
                <div className="empty-state">
                  <Trophy />
                  <h3>Hành trình mới đang chờ</h3>
                  <p>Bảng xếp hạng xuất hiện sau khi bạn được chia bảng và chấm thi.</p>
                </div>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Hạng</th>
                        <th>Thí sinh</th>
                        <th>Điểm trận</th>
                        <th>Điểm ván</th>
                      </tr>
                    </thead>
                    <tbody>
                      {standings.map((row) => (
                        <tr key={row.name} className={row.name === user.name ? 'own-row' : ''}>
                          <td><span className="rank">{row.rank <= 3 ? '🏅 ' : ''}{row.rank}</span></td>
                          <td>{row.name}{row.name === user.name && <small> (Bạn)</small>}</td>
                          <td>{row.pts}</td>
                          <td>{row.gs}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {status?.days?.length ? (
                <>
                  <h3 className="history-title">Lịch sử thứ hạng</h3>
                  <div className="history">
                    {status.days.map((d) => (
                      <div key={d.day}>
                        <small>Ngày {d.day}</small>
                        <strong>#{d.rank} / {d.n}</strong>
                        <span>{d.pts} điểm</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </section>
          )}

          {tab === 'replay' && (
            <Replay
              data={replays}
              onDay={(r, d) => {
                void getReplayMetadata(r, d)
                  .then(setReplays)
                  .catch((e) => setError(e.message));
              }}
            />
          )}

          {tab === 'rules' && (
            <div className="docs-layout">
            <aside className="panel status-panel" aria-label="Trạng thái">
              <p className="eyebrow">TRẠNG THÁI</p>
              <h2>Trạng thái của bạn</h2>
              <div className="status-list">
                {[
                  [UserRound, 'Trạng thái', status ? statusLabel[status.status] ?? status.status : '—'],
                  [Swords, 'Giai đoạn', scoringState ? ({ entry: 'Vòng loại', round: 'Thi đấu', done: 'Đã kết thúc' }[scoringState.phase]) : '—'],
                  [ChartNoAxesColumnIncreasing, 'Điểm tốt nhất', scoringState?.bestScore ?? status?.entry ?? '—'],
                  [Trophy, 'Bảng thi đấu', status?.group ?? 'Chưa chia bảng'],
                ].map(([Icon, label, value], i) => {
                  const I = Icon as typeof Trophy;
                  return <div className="stat-card" key={i}><span className={`stat-icon color-${i}`}><I size={20} /></span><span><small>{String(label)}</small><strong>{String(value)}</strong></span></div>;
                })}
              </div>
              {scoringState?.phase === 'entry' && <p className="attempt-count">Đã dùng {Math.min(scoringState.attempts, 20)}/20 lượt vòng loại</p>}
              <div className="journey-step"><span>01</span><div><h3>Tài khoản</h3><p>Tài khoản đã được xác thực.</p></div><Check className="green" size={18} /></div>
              <div className="journey-step"><span>02</span><div><h3>Gửi bot và nhận điểm</h3><p>Vòng loại tối đa 20 lượt; kết quả tốt nhất được giữ lại.</p></div>{scoringState && scoringState.phase !== 'entry' && <Check className="green" size={18} />}</div>
              <div className="journey-step"><span>03</span><div><h3>Thi đấu và leo hạng</h3><p>Theo dõi lịch sử, điểm số và replay của các trận đã hoàn tất.</p></div>{scoringState?.phase === 'done' && <Check className="green" size={18} />}</div>
            </aside>
            <section className="panel rules">
              <p className="eyebrow">PLAY SMART. PLAY FAIR.</p>
              <h2>Tài liệu</h2>
              <h3>Luật RPS trên bàn cờ</h3>
              <div className="rule-pieces">
                <span>✊ Búa thắng Kéo</span>
                <span>✌️ Kéo thắng Bao</span>
                <span>🖐 Bao thắng Búa</span>
              </div>
              <h3>Bàn cờ & nước đi</h3>
              <p>Bàn 9 × 9. Mỗi bên có 9 quân: 3 Búa, 3 Bao, 3 Kéo. Mỗi lượt đi một ô theo 8 hướng. Không được vào ô quân mình hoặc ô quân đối phương mà bạn không ăn được.</p>
              <h3>Điều kiện chiến thắng</h3>
              <p>Đưa quân đến đích: người đi trước đến i9, người đi sau đến a1; hoặc ăn hết một loại quân của đối phương. Hết nước đi, sai luật, quá thời gian hay bot lỗi đều bị xử thua. Quá 200 nước thì hòa.</p>
              <h3>Thể thức & chương trình bot</h3>
              <p>Mỗi trận BO2 gồm hai ván đổi lượt đi trước. Bot Python nhận một dòng JSON từ stdin và in ra bốn số x y nx ny trên stdout. Giới hạn 3 giây ở nước đầu của mỗi bên và 1 giây ở các nước tiếp theo.</p>
              <h3>Cách tính điểm và xếp hạng</h3>
              <p><strong>Vòng loại:</strong> mỗi lượt đấu BO2 với ba bot BTC cho điểm kết quả s0, s1, s2 từ góc nhìn thí sinh (thắng +1, hòa 0, thua −1 mỗi ván; tổng hai ván từ −2 đến +2). Điểm là <code>entry = 1×s0 + 2×s1 + 3×s2</code>. Mặc định ngưỡng là −2; dưới −2 không đạt. Tối đa 20 lượt, lấy điểm cao nhất; không có lượt chấm thì không vào vòng 1.</p>
              <p><strong>Trong ngày:</strong> trận BO2 cho điểm ván s của A trong khoảng −2…+2. Nếu s dương, A nhận pts +1 và B −1; nếu âm thì ngược lại; nếu hòa mỗi bên 0. gs của A nhận s, gs của B nhận −s. Xếp hạng theo pts giảm dần, rồi gs giảm dần, rồi thứ tự ban đầu trong ngày.</p>
              <p>Ngày 1 dùng seed chia bảng làm thứ tự ban đầu. Ngày sau dùng thứ hạng trung bình các ngày đã chấm. Mỗi bảng có 7 lượt ghép: lượt đầu ghép nửa trên với nửa dưới; các lượt sau ưu tiên đối thủ chưa gặp. Bảng lẻ người cho bye ở cuối thứ tự và ưu tiên người chưa từng được bye.</p>
              <a href="/sample_bot.py" target="_blank" rel="noreferrer" className="download-link">
                <Code2 size={16} /> Đọc chương trình bot mẫu
              </a>
            </section>
            </div>
          )}

          <footer className="dashboard-footer">
            <span className="footer-logos"><img src="/uet-logo.webp" alt="UET" /><img src="/fit-logo.png" alt="FIT" /><b>UET_RPS</b></span><span>Viết chiến thuật của riêng bạn.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function resultLabel(score: number) {
  return score > 0 ? 'Thắng' : score < 0 ? 'Thua' : 'Hòa';
}

function scoreText(score: number) {
  return `${score > 0 ? '+' : ''}${score}`;
}

function ScoringResultCard({ result, kind }: { result: Record<string, any>; kind: 'entry' | 'submission' | 'test' }) {
  const games = Array.isArray(result.games) ? result.games : [];
  const scores = Array.isArray(result.benchmark_scores) ? result.benchmark_scores : [];
  const opponents = Array.isArray(result.opponents) ? result.opponents : [];
  const isEntry = kind === 'entry';
  const isPractice = kind === 'test';
  const title = isEntry ? 'Kết quả vòng loại' : isPractice ? 'Kết quả luyện tập' : 'Kết quả lượt thi';
  const matchRows = isPractice
    ? opponents.map((opponent: Record<string, any>, index: number) => ({
        label: opponent.name || `Bot ${index + 1}`,
        score: Number(opponent.match_score || 0),
      }))
    : scores.map((score: number, index: number) => ({ label: `Bot đối chứng ${index + 1}`, score: Number(score) }));
  if (!isEntry && !isPractice && typeof result.match_score === 'number') {
    matchRows.push({ label: 'Bot mẫu', score: result.match_score });
  }

  return <section className="scoring-result-card" role="status" aria-live="polite">
    <div className="scoring-result-heading">
      <div><p className="eyebrow">KẾT QUẢ CHẤM</p><h3>{title}</h3></div>
      <strong className={result.passed === false ? 'result-failed' : 'result-passed'}>
        {isEntry ? (result.passed ? 'ĐẠT VÒNG LOẠI' : 'CHƯA ĐẠT') : 'ĐÃ HOÀN TẤT'}
      </strong>
    </div>
    <div className="scoring-result-grid">
      {isEntry && <div><small>Điểm có trọng số</small><strong>{result.qualification_score ?? '—'}/12</strong></div>}
      {isPractice && <div><small>Điểm trận luyện tập</small><strong>{result.total_match_pts ?? '—'}</strong></div>}
      {!isEntry && !isPractice && <div><small>Điểm trận</small><strong>{result.match_pts ?? '—'}</strong></div>}
      {!isEntry && !isPractice && <div><small>Điểm ván</small><strong>{typeof result.match_score === 'number' ? scoreText(result.match_score) : '—'}</strong></div>}
      <div><small>Số ván đã chấm</small><strong>{games.length || matchRows.length ? `${games.length || matchRows.length} ván` : '—'}</strong></div>
      {typeof result.duration_seconds === 'number' && <div><small>Thời gian chấm</small><strong>{result.duration_seconds.toFixed(1)} giây</strong></div>}
    </div>
    {matchRows.length > 0 && <div className="scoring-result-matches">
      <strong>Thắng / thua / hòa từng đối thủ</strong>
      {matchRows.map((match, index) => <div key={`${match.label}-${index}`}><span>{match.label}</span><b className={`outcome-${match.score > 0 ? 'win' : match.score < 0 ? 'loss' : 'draw'}`}>{resultLabel(match.score)} ({scoreText(match.score)})</b></div>)}
    </div>}
    {isEntry && <p className="scoring-result-note">Vòng loại đấu với 3 bot đối chứng, điểm tính theo trọng số 1×ván 1 + 2×ván 2 + 3×ván 3. Ngưỡng đạt hiện tại là -2/12.</p>}
    {isPractice && <p className="scoring-result-note">Kết quả luyện tập không tính vào thứ hạng hoặc số lượt vòng loại.</p>}
    {!isEntry && !isPractice && result.match_result && <p className="scoring-result-note">{result.match_result}</p>}
  </section>;
}
