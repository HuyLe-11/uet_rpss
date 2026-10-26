import { useEffect, useRef, useState } from 'react';
import { Code2, ExternalLink } from 'lucide-react';

const WIDGET_SCRIPT_SRC = 'https://onlinecompiler.io/widget.js';
const WIDGET_KEY = import.meta.env.ONLINE_COMPILER_KEY;


export default function Arena() {
  const editorRef = useRef<HTMLDivElement>(null);
  const [scriptState, setScriptState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const script = document.createElement('script');
    let settled = false;

    const markReady = () => {
      settled = true;
      setScriptState('ready');
    };
    const markError = () => {
      settled = true;
      setScriptState('error');
    };

    script.addEventListener('load', markReady);
    script.addEventListener('error', markError);
    editor.innerHTML = '';
    const widget = document.createElement('div');
    widget.className = 'runcode';
    widget.dataset.key = WIDGET_KEY;
    editor.appendChild(widget);

    script.src = WIDGET_SCRIPT_SRC;
    script.async = true;
    document.body.appendChild(script);

    const timeout = window.setTimeout(() => {
      if (!settled) markError();
    }, 10000);

    return () => {
      window.clearTimeout(timeout);
      script.removeEventListener('load', markReady);
      script.removeEventListener('error', markError);
      script.remove();
    };
  }, []);

  return (
    <div className="arena-page">
      <section className="arena-intro">
        <div>
          <p className="eyebrow">WRITE. RUN. IMPROVE.</p>
          <h2>Code Arena</h2>
          <p>
            Viết và chạy thử code trực tiếp trên trình duyệt trước khi gửi bot
            tham gia cuộc thi.
          </p>
        </div>
        <span className="arena-icon" aria-hidden="true"><Code2 size={26} /></span>
      </section>

      <section className="panel arena-editor-panel" aria-label="Code editor">
        <div className="section-heading arena-editor-heading">
          <div>
            <h2>Code editor</h2>
            <p>Thử nghiệm nhanh ý tưởng của bạn trong môi trường OnlineCompiler.</p>
          </div>
          <a
            className="arena-external-link"
            href="https://onlinecompiler.io"
            target="_blank"
            rel="noreferrer"
          >
            Mở OnlineCompiler <ExternalLink size={15} />
          </a>
        </div>
        {scriptState === 'loading' && <p className="arena-widget-status">Đang tải code editor…</p>}
        {scriptState === 'error' && (
          <p className="form-error" role="alert">
            Không tải được code editor. Bạn có thể thử mở lại trang hoặc dùng OnlineCompiler trực tiếp.
          </p>
        )}
        <div ref={editorRef} className="arena-editor" />
      </section>
    </div>
  );
}
