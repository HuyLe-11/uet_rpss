import { useEffect, useRef, useState } from 'react';
import { Check, Code2, Copy, ExternalLink } from 'lucide-react';
import { DEFAULT_TEMPLATE, SAMPLE_BOTS, buildBotTemplate } from './botTemplates';

const WIDGET_SCRIPT_SRC = 'https://onlinecompiler.io/widget.js';
const WIDGET_KEY = import.meta.env.VITE_ONLINE_COMPILER_KEY || '';
const BOT_TEMPLATE = DEFAULT_TEMPLATE;

type ArenaProps = {
  source: string;
  onSourceChange: (source: string) => void;
};

export default function Arena({ source, onSourceChange, embedded = false }: ArenaProps & { embedded?: boolean }) {
  const widgetRef = useRef<HTMLDivElement>(null);
  const [widgetState, setWidgetState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [copied, setCopied] = useState(false);
  const [sampleId, setSampleId] = useState('');

  function chooseSample(id: string) {
    const bot = SAMPLE_BOTS.find(item => item.id === id);
    if (!bot) return;
    const known = source.trim() === '' || source === BOT_TEMPLATE || SAMPLE_BOTS.some(item => source === buildBotTemplate(item));
    if (!known && !window.confirm('Thay code hiện tại bằng template của bot mẫu này?')) return;
    setSampleId(id);
    onSourceChange(buildBotTemplate(bot));
  }

  useEffect(() => {
    const target = widgetRef.current;
    if (!target || !WIDGET_KEY) {
      setWidgetState('error');
      return;
    }
    const script = document.createElement('script');
    const widget = document.createElement('div');
    widget.className = 'runcode';
    widget.dataset.key = WIDGET_KEY;
    target.replaceChildren(widget);
    script.src = WIDGET_SCRIPT_SRC;
    script.async = true;
    script.onload = () => setWidgetState('ready');
    script.onerror = () => setWidgetState('error');
    document.body.appendChild(script);
    return () => script.remove();
  }, []);

  async function copyTemplate() {
    await navigator.clipboard.writeText(source || BOT_TEMPLATE);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className={embedded ? 'arena-page ide-practice' : 'arena-page'}>
      {!embedded && <section className="arena-intro">
        <div>
          <p className="eyebrow">WRITE. RUN. IMPROVE.</p>
          <h2>Code Arena</h2>
          <p>Chạy thử ý tưởng trên OnlineCompiler, sau đó copy template bên dưới để viết bot thi đấu.</p>
        </div>
        <span className="arena-icon" aria-hidden="true"><Code2 size={26} /></span>
      </section>}
      <section className="panel arena-editor-panel" aria-label="OnlineCompiler practice">
        <div className="section-heading arena-editor-heading">
          <div>
            <h2>Đấu luyện trên OnlineCompiler</h2>
            <p>Widget dùng để chạy thử độc lập; kết quả không ghi vào thành tích cuộc thi.</p>
          </div>
          <a className="arena-external-link" href="https://onlinecompiler.io" target="_blank" rel="noreferrer">
            Mở OnlineCompiler <ExternalLink size={15} />
          </a>
        </div>
        {widgetState === 'loading' && <p className="arena-widget-status">Đang tải OnlineCompiler…</p>}
        {widgetState === 'error' && <p className="form-error">Widget chưa được cấu hình. Bạn có thể mở OnlineCompiler trực tiếp.</p>}
        <div ref={widgetRef} className="arena-widget" />
      </section>
      <section className="panel arena-template-panel">
        <div className="section-heading">
          <div><h2>Template bot</h2><p>Chọn một bot mẫu làm đối thủ: template gồm code BTC, hàm choose_move của bạn và đoạn chạy thử tự in kết quả (python bot.py).</p></div>
          <button type="button" className="secondary" onClick={() => void copyTemplate()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Đã copy' : 'Copy template'}</button>
        </div>
        <div className="sample-picker" role="radiogroup" aria-label="Chọn bot mẫu">
          {SAMPLE_BOTS.map(bot => (
            <button key={bot.id} type="button" role="radio" aria-checked={sampleId === bot.id} className={sampleId === bot.id ? 'active' : ''} onClick={() => chooseSample(bot.id)}>
              <strong>{bot.name}</strong><small>{bot.hint}</small>
            </button>
          ))}
        </div>
        <textarea className="arena-template-code" value={source || BOT_TEMPLATE} onChange={(event) => onSourceChange(event.target.value)} spellCheck={false} aria-label="Mã bot template" />
      </section>
    </div>
  );
}
