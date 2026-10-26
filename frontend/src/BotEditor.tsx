import Editor from '@monaco-editor/react';

type BotEditorProps = {
  value: string;
  onChange: (value: string) => void;
  height?: string;
};

export default function BotEditor({ value, onChange, height = '480px' }: BotEditorProps) {
  return (
    <Editor
      height={height}
      defaultLanguage="python"
      language="python"
      theme="vs-dark"
      value={value}
      onChange={(next) => onChange(next ?? '')}
      options={{
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        tabSize: 4,
        wordWrap: 'on',
        scrollBeyondLastLine: false,
      }}
    />
  );
}
