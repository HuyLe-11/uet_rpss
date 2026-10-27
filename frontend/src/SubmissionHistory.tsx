import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, Clock3, RotateCcw, Swords } from 'lucide-react';
import Replay from './Replay';
import './submission-history.css';
import { getReplayMetadata, getSubmissionHistory, supabase, type ReplayMatch, type Replays, type SubmissionHistoryItem, type User } from './api';

const statusText: Record<string, string> = {
  dispatching: 'Đang gửi', accepted: 'Đã nhận', running: 'Đang chấm', succeeded: 'Đã chấm xong',
  failed: 'Chấm lỗi', timed_out: 'Quá thời gian', dispatch_failed: 'Máy chấm không nhận',
};

export default function SubmissionHistory({ user, replays }: { user: User; replays: Replays }) {
  const [items, setItems] = useState<SubmissionHistoryItem[]>([]);
  const [historyReplays, setHistoryReplays] = useState(replays);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      if (!user.id) throw new Error('Phiên đăng nhập không có mã tài khoản.');
      const [rows, replayData] = await Promise.all([
        getSubmissionHistory(user.id), getReplayMetadata().catch(() => null),
      ]);
      setItems(rows);
      if (replayData) setHistoryReplays(replayData);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được lịch sử nộp bài.');
    } finally { setLoading(false); }
  }, [user.id]);

  useEffect(() => {
    void refresh();
    const channel = supabase.channel(`submission-history-${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scoring_jobs', filter: `user_id=eq.${user.id}` }, () => void refresh())
      .subscribe();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { window.clearInterval(timer); void supabase.removeChannel(channel); };
  }, [refresh, user.id]);

  const replayRows = historyReplays.allMatches || historyReplays.matches;
  return <section className="panel submission-history">
    <div className="section-heading"><div><p className="eyebrow">BOT CỦA BẠN</p><h2>Lịch sử nộp bài</h2></div>
      <button type="button" className="secondary" onClick={() => { setLoading(true); void refresh(); }}><RotateCcw size={15}/>Làm mới</button>
    </div>
    <p className="muted">Mở một lượt để xem kết quả phân tích. Replay được tải riêng khi bạn yêu cầu.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {loading ? <div className="empty-state"><Clock3/><h3>Đang tải lịch sử…</h3></div>
      : !items.length ? <div className="empty-state"><Swords/><h3>Bạn chưa có lượt nộp nào</h3><p>Các lượt gửi bot sẽ xuất hiện tại đây.</p></div>
        : <div className="submission-history-list">{items.map(item => {
          const entryReplay = replayRows.find(row => row.kind === 'job' && row.id === item.id);
          const matchReplays = item.kind === 'submission' && item.rnd && item.day
            ? replayRows.filter(row => row.kind === 'match' && row.storagePath && (row.a === user.name || row.b === user.name)
              && row.round === item.rnd && row.day === item.day)
            : [];
          return <details className="submission-history-item" key={item.id}>
              <summary><span className="history-summary-main"><strong>{item.kind === 'entry' ? 'Vòng loại' : item.kind === 'test' ? 'Luyện tập' : `Vòng ${item.rnd} · Ngày ${item.day}`}</strong>
              <small>{new Date(item.created_at).toLocaleString()}</small></span>
              <span className={`history-status ${item.status}`}><i/>{statusText[item.status] || item.status}</span>
              <span className="history-score">{typeof item.result?.match_score === 'number'
                ? `${matchOutcome(item.result.match_score)} (${signedScore(item.result.match_score)})`
                : item.kind === 'submission' ? 'Bài thi' : 'Chưa có kết quả'}</span>
              <ChevronDown size={17}/>
            </summary>
            <div className="submission-history-details">
              {item.status === 'succeeded' && item.kind === 'entry' && <EntryAnalysis item={item}/>}
              {item.status === 'succeeded' && item.kind === 'submission' && <>
                <p>Bài đã được nhận cho ngày thi. Phân tích và replay các trận sẽ hiện sau khi kết quả ngày đó được công bố.</p>
                {matchReplays.length ? <div className="history-match-list">{matchReplays.map(match => <HistoryReplay key={match.id} match={match} round={item.rnd!} day={item.day!} contestantName={user.name}/>)}</div>
                  : <p className="muted">Chưa có replay được công bố cho ngày này.</p>}
              </>}
              {item.status === 'succeeded' && item.kind === 'test' && <>
                <p>Lượt luyện tập không ảnh hưởng thứ hạng giải đấu.</p>
                {typeof item.result?.match_score === 'number' && <p>Bot mẫu: {matchOutcome(item.result.match_score)} ({signedScore(item.result.match_score)})</p>}
              </>}
              {['failed', 'timed_out', 'dispatch_failed'].includes(item.status) && <p className="form-error"><AlertCircle size={16}/>{item.error_code || 'scoring_failed'}{item.error_message ? ` · ${item.error_message}` : ''}</p>}
              {item.status !== 'succeeded' && !['failed', 'timed_out', 'dispatch_failed'].includes(item.status) && <p>Máy chấm đang xử lý lượt gửi này.</p>}
              {(item.kind === 'entry' || item.kind === 'test') && item.status === 'succeeded' && (entryReplay
                ? <HistoryReplay match={entryReplay} round={0} day={0} label={item.kind === 'test' ? 'Replay luyện tập' : 'Replay vòng loại'} contestantName={user.name}/>
                : <p className="muted">Lượt này chưa có replay được lưu.</p>)}
            </div>
          </details>;
        })}</div>}
  </section>;
}

function EntryAnalysis({ item }: { item: SubmissionHistoryItem }) {
  const result = item.result || {};
  const games = Array.isArray(result.games) ? result.games : [];
  return <div className="entry-analysis">
    <div className="analysis-metrics"><div><small>Kết quả</small><strong>{result.passed ? 'Đạt vòng loại' : 'Chưa đạt'}</strong></div>
      <div><small>Điểm trận</small><strong>{typeof result.match_score === 'number' ? signedScore(result.match_score) : '—'}</strong></div>
      <div><small>Đối thủ</small><strong>Bot mẫu</strong></div>
    </div>
    {games.length > 0 && <div className="analysis-game-list"><strong>Diễn biến từng ván</strong>{games.map((game: any, index: number) => <span key={index}>Ván {index + 1}: {game.result > 0 ? 'thắng' : game.result < 0 ? 'thua' : 'hòa'} · {game.moves?.length ?? 0} nước{game.fault ? ' · có lỗi nước đi' : ''}</span>)}</div>}
  </div>;
}

function matchOutcome(score: number) {
  return score > 0 ? 'thắng' : score < 0 ? 'thua' : 'hòa';
}

function signedScore(score: number) {
  return `${score > 0 ? '+' : ''}${score}`;
}

function HistoryReplay({ match, round, day, label, contestantName }: { match: ReplayMatch; round: number; day: number; label?: string; contestantName?: string }) {
  const [requested, setRequested] = useState(false);
  const replayData = useMemo<Replays>(() => ({
    available: [{ round, day }], round, day, matches: [match], allMatches: [match],
  }), [match, round, day]);
  const contestantScore = contestantName && match.a !== contestantName ? -match.s : match.s;
  const matchLabel = contestantName
    ? `Lượt ${match.rd}: Bạn ${matchOutcome(contestantScore)} · ${match.a === contestantName ? match.b : match.a}`
    : `Lượt ${match.rd}: ${match.a} · ${matchOutcome(match.s)} · ${match.b}`;
  return <div className="history-replay">
    <div><strong>{label || (match.kind === 'job' ? 'Replay vòng loại' : matchLabel)}</strong>
      <button type="button" className="secondary" onClick={() => setRequested(value => !value)}>{requested ? 'Ẩn replay' : 'Yêu cầu replay'}<Swords size={15}/></button></div>
    {requested && <Replay data={replayData} onDay={() => undefined}/>}
  </div>;
}
