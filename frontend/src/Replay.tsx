import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from 'lucide-react';
import { loadMatchReplay, type ReplayGame, type Replays } from './api';

function RockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19 10V7.5a2 2 0 0 0-2-2h-1V4.5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v1h-1a2 2 0 0 0-2 2V10a3 3 0 0 0-3 3v2.5A4.5 4.5 0 0 0 9.5 20h4a5 5 0 0 0 5-5V10zM10 5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5V10H10V5.5zm-2 2a.5.5 0 0 1 .5-.5h1V10H8V7.5zm5-2a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5V10h-2V5.5zm3 2.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5V10H16V8z" />
    </svg>
  );
}

function PaperIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2a1.5 1.5 0 0 1 1.5 1.5V9.5h.5A1.5 1.5 0 0 1 15.5 8 1.5 1.5 0 0 1 17 9.5v.5h.5A1.5 1.5 0 0 1 19 11.5v3.5a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6v-3.8a1.5 1.5 0 0 1 2.5-1.1L8 12V4.5A1.5 1.5 0 0 1 9.5 3 1.5 1.5 0 0 1 11 4.5V2z" />
    </svg>
  );
}

function ScissorsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="3" fill="currentColor" fillOpacity="0.25" />
      <circle cx="6" cy="18" r="3" fill="currentColor" fillOpacity="0.25" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </svg>
  );
}

function PieceIcon({ type }: { type: number }) {
  if (type === 0) return <RockIcon />;
  if (type === 1) return <PaperIcon />;
  return <ScissorsIcon />;
}

export default function Replay({ data, onDay, onRefresh, initialMatchId }: { data: Replays; onDay: (round: number, day: number) => void; onRefresh?: () => void; initialMatchId?: string | number | null }) {
  const [matchIndex, setMatchIndex] = useState(0);
  const [gameIndex, setGameIndex] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [games, setGames] = useState<ReplayGame[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const match = data.matches[matchIndex];

  useEffect(() => {
    const requestedIndex = initialMatchId == null
      ? -1
      : data.matches.findIndex(item => String(item.id) === String(initialMatchId));
    setMatchIndex(requestedIndex >= 0 ? requestedIndex : 0);
    setGameIndex(0);
    setStep(0);
    setPlaying(false);
  }, [data, initialMatchId]);

  useEffect(() => {
    let cancelled = false;
    setGames([]);
    setGameIndex(0);
    setStep(0);
    setPlaying(false);
    setLoadError('');
    if (!match?.storagePath) {
      setGames(match?.games || []);
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadMatchReplay(match.storagePath)
      .then(result => { if (!cancelled) setGames(result); })
      .catch(error => {
        if (cancelled) return;
        if (match.games?.length) setGames(match.games);
        else setLoadError(error instanceof Error ? error.message : 'Không tải được replay');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [match?.id, match?.storagePath, match?.games]);

  const game = games[gameIndex];
  const total = game?.moves.length ?? 0;

  useEffect(() => {
    if (!playing) return;
    if (step >= total) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setStep(value => value + 1), 650);
    return () => window.clearTimeout(timer);
  }, [playing, step, total]);

  const pieces = new Map<string, { owner: number; type: number }>();
  for (let x = 0; x < 9; x++) {
    pieces.set(`${x},0`, { owner: 0, type: x % 3 });
    pieces.set(`${x},8`, { owner: 1, type: x % 3 });
  }
  for (const [, move] of game?.moves.slice(0, step) ?? []) {
    const [x, y, nx, ny] = move;
    const piece = pieces.get(`${x},${y}`);
    if (piece) { pieces.delete(`${x},${y}`); pieces.set(`${nx},${ny}`, piece); }
  }
  const last = step ? game?.moves[step - 1]?.[1] : undefined;
  const botName = (side: 'a' | 'b') => side === 'a' ? match?.a : match?.b;

  return (
    <section className="panel">
      <div className="section-heading"><div><p className="eyebrow">MATCH REPLAY</p><h2>Nhìn lại từng nước đi</h2></div>{onRefresh && <button type="button" className="secondary" onClick={onRefresh}><RotateCcw size={15}/>Tải lại replay</button>}</div>
      <div className="replay-selects">
        <label>Ngày thi<select value={data.round && data.day ? `${data.round},${data.day}` : ''} onChange={event => { const [round, day] = event.target.value.split(',').map(Number); onDay(round, day); }} disabled={!data.available.length}>
          {!data.available.length && <option>Chưa có ngày thi</option>}
          {data.available.map(date => <option key={`${date.round},${date.day}`} value={`${date.round},${date.day}`}>{date.round === 0 ? 'Vòng loại' : `Vòng ${date.round} · Ngày ${date.day}`}</option>)}
        </select></label>
        <label>Trận đấu<select value={matchIndex} disabled={!data.matches.length} onChange={event => { setMatchIndex(Number(event.target.value)); setGameIndex(0); setStep(0); setPlaying(false); }}>
          {!data.matches.length && <option>Chưa có trận đấu</option>}
          {data.matches.map((item, index) => <option key={item.id ?? index} value={index}>{item.kind === 'job' ? `Lượt chấm ${item.rd}` : `Trận ${item.rd}`}: {item.a} vs {item.b}</option>)}
        </select></label>
        <label>Ván<select value={gameIndex} disabled={!games.length} onChange={event => { setGameIndex(Number(event.target.value)); setStep(0); setPlaying(false); }}>
          {games.map((_, index) => <option key={index} value={index}>Ván {index + 1}</option>)}
        </select></label>
      </div>
      {loading ? <div className="empty-state"><Play/><h3>Đang tải replay…</h3><p>Đang lấy diễn biến trận từ kho lưu trữ.</p></div>
        : loadError ? <div className="empty-state"><Play/><h3>Chưa tải được replay</h3><p>{loadError}</p></div>
          : !game ? <div className="empty-state"><Play/><h3>{initialMatchId != null && !match ? 'Replay trận này chưa được công bố' : 'Trận đấu sẽ xuất hiện tại đây'}</h3><p>{match ? 'Replay chưa có ván đấu hợp lệ. Hãy tải lại danh sách hoặc chọn trận khác.' : 'Replay chỉ xuất hiện sau khi ngày thi được công bố. Hãy tải lại danh sách sau.'}</p>{onRefresh && <button type="button" className="secondary" onClick={onRefresh}><RotateCcw size={15}/>Tải lại danh sách</button>}</div>
            : <>
              <div className="replay-names">
                <span className="replay-player player-0">🔵 {botName(game.players[0])}</span>
                <span className="replay-player player-1">🔴 {botName(game.players[1])}</span>
              </div>
              <div className="replay-game-analysis">
                <span>{game.result !== undefined ? (game.result > 0 ? `Thắng: ${match?.a}` : game.result < 0 ? `Thắng: ${match?.b}` : 'Ván hòa') : 'Chưa có kết quả ván'}</span>
                <span>{total} nước đi{game.fault ? ' · có nước đi lỗi' : ' · không ghi nhận nước đi lỗi'}</span>
              </div>
              <div className="replay-board" role="grid" aria-label="Bàn cờ phát lại 9 nhân 9">
                {Array.from({ length: 81 }, (_, index) => {
                  const x = index % 9, y = 8 - Math.floor(index / 9), piece = pieces.get(`${x},${y}`);
                  const isGoal = (x === 0 && y === 0) || (x === 8 && y === 8);
                  const isLast = Boolean(last && x === last[2] && y === last[3]);
                  return (
                    <div
                      role="gridcell"
                      key={index}
                      className={`square ${(x + y) % 2 ? 'dark' : ''} ${isGoal ? 'goal' : ''} ${isLast ? 'last' : ''}`}
                      aria-label={`${'abcdefghi'[x]}${y + 1}${piece ? `, ${['Búa', 'Bao', 'Kéo'][piece.type]}, bên ${piece.owner}` : ''}`}
                    >
                      {x === 0 && <span className="coord-rank" aria-hidden="true">{y + 1}</span>}
                      {y === 0 && <span className="coord-file" aria-hidden="true">{'abcdefghi'[x]}</span>}
                      {piece && (
                        <span className={`board-piece owner-${piece.owner}`}>
                          <PieceIcon type={piece.type} />
                          <span className="piece-tag">{['BÚA', 'BAO', 'KÉO'][piece.type]}</span>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="replay-controls">
                <button className="secondary" aria-label="Nước trước" disabled={step === 0} onClick={() => { setPlaying(false); setStep(value => value - 1); }}><ChevronLeft size={18}/></button>
                <button className="primary" disabled={!total} onClick={() => { if (step >= total) setStep(0); setPlaying(value => !value); }}>{playing ? <Pause size={17}/> : <Play size={17}/>} {playing ? 'Dừng' : 'Phát'}</button>
                <button className="secondary" aria-label="Nước tiếp" disabled={step >= total} onClick={() => { setPlaying(false); setStep(value => value + 1); }}><ChevronRight size={18}/></button>
                <input aria-label="Chọn nước đi" type="range" min={0} max={total} value={step} onChange={event => { setPlaying(false); setStep(Number(event.target.value)); }}/>
                <span>{step} / {total}</span>
              </div>
            </>}
    </section>
  );
}
