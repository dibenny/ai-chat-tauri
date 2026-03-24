import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Spin, Typography } from 'antd';
import { Think, Bubble, Sender, Welcome, CodeHighlighter } from '@ant-design/x';
import { listDir, readFile } from '../api/file';
import type { FileEntry } from '../api/file';

const { Text } = Typography;

function buildSystemPrompt(homeDir: string): string {
  return `你是一个智能助手，可以使用以下工具来帮助用户：

## 系统信息

用户主目录: ${homeDir}
桌面路径: ${homeDir}/Desktop
文档路径: ${homeDir}/Documents
下载路径: ${homeDir}/Downloads

## 可用工具

### list_dir
列出指定目录的内容。
参数：
- path: string - 目录路径（必须是绝对路径）

返回：文件和文件夹列表

示例：
- 列出桌面文件：使用路径 "${homeDir}/Desktop"
- 列出文档：使用路径 "${homeDir}/Documents"

### read_file
读取文件内容。
参数：
- file_path: string - 文件路径（必须是绝对路径）

返回：文件内容

示例：
- 读取桌面的 test.txt：使用路径 "${homeDir}/Desktop/test.txt"

## 使用方法

当你需要使用工具时，请在回复中使用以下 JSON 格式：

\`\`\`json
{
  "tool": "list_dir",
  "args": {
    "path": "/path/to/directory"
  }
}
\`\`\`

或

\`\`\`json
{
  "tool": "read_file",
  "args": {
    "file_path": "/path/to/file.txt"
  }
}
\`\`\`

重要提示：
1. 所有路径必须是绝对路径（以 / 开头）
2. 当用户提到"桌面"、"文档"等，请使用上面提供的完整路径
3. 工具调用后，你会收到结果，然后可以继续回答用户的问题`;
}

type Role = 'user' | 'assistant' | 'system';

type ChatMessage = {
  role: Role;
  content: string;
  thinking?: string;
  kind?: 'normal' | 'thinking_placeholder' | 'tool_call' | 'tool_result';
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
};

interface AgentChatProps {
  selectedModel: string;
  onMessagesChange?: (messages: ChatMessage[]) => void;
}

function getCodeBlockLang(className?: string): string {
  if (!className || typeof className !== 'string') return 'text';
  const m = className.match(/language-(\S+)/);
  return m ? m[1] : 'text';
}

function getModelDisplayName(modelName: string): string {
  const lower = modelName.toLowerCase();
  if (lower.includes('deepseek') && (lower.includes('r1') || lower.includes('r2'))) {
    return lower.includes('r2') ? 'DeepSeek-R2' : 'DeepSeek-R1';
  }
  if (lower.includes('qwen')) return 'Qwen';
  const base = modelName.split(':')[0] ?? modelName;
  return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
}

function parseAIResponse(text: string): { thinking?: string; answer: string; toolCall?: { tool: string; args: Record<string, unknown> } } {
  const thinkingMatch = text.match(/<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/);
  const thinking = thinkingMatch ? thinkingMatch[1].trim() : undefined;

  // 尝试提取 JSON 代码块中的工具调用
  const jsonBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (parsed.tool && parsed.args) {
        return { thinking, answer: text, toolCall: { tool: parsed.tool, args: parsed.args } };
      }
    } catch {
      // 不是有效的工具调用 JSON
    }
  }

  const answerMatch = text.match(/<answer>([\s\S]*?)<\/answer>/);
  if (answerMatch) {
    return { thinking, answer: answerMatch[1].trim() };
  }

  const stripped = text
    .replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/g, '')
    .trim();
  const answer = stripped.length > 0 ? stripped : text.trim();

  return { thinking, answer };
}

export function AgentChat({ selectedModel, onMessagesChange }: AgentChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [_homeDir, setHomeDir] = useState<string>('');
  const [systemPrompt, setSystemPrompt] = useState<string>('');
  const requestSeq = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const isHome = messages.length === 0;

  useEffect(() => {
    // 获取用户主目录
    invoke<string>('get_home_dir')
      .then((dir) => {
        setHomeDir(dir);
        setSystemPrompt(buildSystemPrompt(dir));
      })
      .catch((err) => {
        console.error('获取主目录失败:', err);
        setSystemPrompt(buildSystemPrompt('/Users/benny')); // 使用默认值
      });
  }, []);

  const messagesForBackend = useMemo(
    () => {
      if (!systemPrompt) return [];
      return [
        { role: 'system', content: systemPrompt },
        ...messages
          .filter((m) => m.kind !== 'thinking_placeholder')
          .map((m) => {
            if (m.kind === 'tool_result') {
              return {
                role: 'user',
                content: `工具 ${m.toolName} 的执行结果：\n\`\`\`json\n${JSON.stringify(m.toolResult, null, 2)}\n\`\`\``,
              };
            }
            return { role: m.role, content: m.content };
          }),
      ];
    },
    [messages, systemPrompt],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, isLoading]);

  useEffect(() => {
    onMessagesChange?.(messages);
  }, [messages, onMessagesChange]);

  async function executeToolCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (tool === 'list_dir' && typeof args.path === 'string') {
      return await listDir(args.path);
    }
    if (tool === 'read_file' && typeof args.file_path === 'string') {
      return await readFile(args.file_path);
    }
    throw new Error(`未知工具: ${tool}`);
  }

  async function handleSend(text?: string) {
    const content = (text ?? input).trim();
    if (!content || isLoading) return;

    const myReq = ++requestSeq.current;
    const userMessage: ChatMessage = { role: 'user', content, kind: 'normal' };
    const nextMessagesForBackend = [...messagesForBackend, { role: 'user', content }];

    setMessages((prev) => [
      ...prev,
      userMessage,
      { role: 'assistant', content: '', kind: 'thinking_placeholder' },
    ]);
    setInput('');
    setIsLoading(true);

    try {
      let currentMessages = nextMessagesForBackend;
      let maxIterations = 5; // 防止无限循环

      while (maxIterations > 0) {
        maxIterations--;

        const result: string = await invoke('chat_with_model', {
          messages: currentMessages,
          modelName: selectedModel,
        });

        if (myReq !== requestSeq.current) return;

        const { thinking, answer, toolCall } = parseAIResponse(result);

        if (toolCall) {
          // AI 想要调用工具
          setMessages((prev) => {
            const filtered = prev.filter((msg) => msg.kind !== 'thinking_placeholder');
            return [
              ...filtered,
              {
                role: 'assistant',
                content: answer,
                thinking,
                kind: 'tool_call',
                toolName: toolCall.tool,
                toolArgs: toolCall.args,
              },
            ];
          });

          // 执行工具调用
          try {
            const toolResult = await executeToolCall(toolCall.tool, toolCall.args);

            setMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content: '',
                kind: 'tool_result',
                toolName: toolCall.tool,
                toolResult,
              },
            ]);

            // 将工具结果添加到消息历史，继续对话
            currentMessages = [
              ...currentMessages,
              { role: 'assistant', content: answer },
              {
                role: 'user',
                content: `工具 ${toolCall.tool} 的执行结果：\n\`\`\`json\n${JSON.stringify(toolResult, null, 2)}\n\`\`\``,
              },
            ];
          } catch (error) {
            setMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content: `工具调用失败: ${error}`,
                kind: 'normal',
              },
            ]);
            break;
          }
        } else {
          // 正常回复，结束循环
          setMessages((prev) => {
            const filtered = prev.filter((msg) => msg.kind !== 'thinking_placeholder');
            return [...filtered, { role: 'assistant', content: answer, thinking, kind: 'normal' }];
          });
          break;
        }
      }
    } catch (error) {
      console.error('调用失败:', error);
      if (myReq !== requestSeq.current) return;
      setMessages((prev) => {
        const filtered = prev.filter((msg) => msg.kind !== 'thinking_placeholder');
        return [...filtered, { role: 'assistant', content: `出错了: ${error}`, kind: 'normal' }];
      });
    } finally {
      if (myReq === requestSeq.current) setIsLoading(false);
    }
  }

  function formatFileList(entries: FileEntry[]): string {
    return entries
      .map((entry) => {
        const icon = entry.is_dir ? '📁' : '📄';
        const size = entry.size ? ` (${(entry.size / 1024).toFixed(1)} KB)` : '';
        return `${icon} ${entry.name}${size}`;
      })
      .join('\n');
  }

  return (
    <>
      {isHome ? (
        <div className="home home--welcome">
          <Welcome
            icon="https://mdn.alipayobjects.com/huamei_iwk9zp/afts/img/A*s5sNRo5LjfQAAAAAAAAAAAAADgCCAQ/fmt.webp"
            title={`Hello，我是${getModelDisplayName(selectedModel)}模型`}
            description={`基于${getModelDisplayName(selectedModel)}打造更卓越的智能对话助手（Agent 模式：支持文件系统工具）`}
            style={{ background: 'linear-gradient(97deg, #f2f9fe 0%, #f7f3ff 100%)' }}
          />
        </div>
      ) : (
        <div className="chat chat-x" role="log" aria-label="Chat messages">
          <div className="messages" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 0 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {messages.map((msg, index) => (
            <div key={index} className={`messageRow messageRow--x messageRow--${msg.role}`}>
              {msg.role === 'system' && (
                <Bubble.System content={msg.content} />
              )}
              {msg.role === 'user' && (
                <Bubble placement="end" content={msg.content} />
              )}
              {msg.role === 'assistant' && msg.kind === 'thinking_placeholder' && (
                <Think title="思考中" loading={<Spin size="small" />} />
              )}
              {msg.role === 'assistant' && msg.kind === 'tool_call' && (
                <>
                  {msg.thinking && (
                    <Think title="思考过程" defaultExpanded={false}>
                      {msg.thinking}
                    </Think>
                  )}
                  <Bubble
                    placement="start"
                    content={
                      <div className="bubble__content">
                        <div style={{ marginBottom: 8 }}>
                          <Text strong>🔧 调用工具: {msg.toolName}</Text>
                        </div>
                        <pre style={{ background: '#f5f5f5', padding: 8, borderRadius: 4, fontSize: 12 }}>
                          {JSON.stringify(msg.toolArgs, null, 2)}
                        </pre>
                      </div>
                    }
                  />
                </>
              )}
              {msg.role === 'assistant' && msg.kind === 'tool_result' && (
                <Bubble
                  placement="start"
                  content={
                    <div className="bubble__content">
                      <div style={{ marginBottom: 8 }}>
                        <Text strong>✅ 工具结果: {msg.toolName}</Text>
                      </div>
                      {msg.toolName === 'list_dir' && Array.isArray(msg.toolResult) ? (
                        <pre style={{ background: '#f5f5f5', padding: 8, borderRadius: 4, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                          {formatFileList(msg.toolResult as FileEntry[])}
                        </pre>
                      ) : (
                        <pre style={{ background: '#f5f5f5', padding: 8, borderRadius: 4, fontSize: 12, maxHeight: 300, overflow: 'auto' }}>
                          {typeof msg.toolResult === 'string' ? msg.toolResult : JSON.stringify(msg.toolResult, null, 2)}
                        </pre>
                      )}
                    </div>
                  }
                />
              )}
              {msg.role === 'assistant' && msg.kind === 'normal' && (
                <>
                  {msg.thinking && (
                    <Think title="思考过程" defaultExpanded={false}>
                      {msg.thinking}
                    </Think>
                  )}
                  <Bubble
                    placement="start"
                    content={
                      <div className="bubble__content">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: (props) => (
                              <a {...props} target="_blank" rel="noreferrer noopener" />
                            ),
                            pre: ({ children }) => {
                              const arr = React.Children.toArray(children);
                              const codeEl = arr.find(
                                (c): c is React.ReactElement<{ className?: string; children?: React.ReactNode }> =>
                                  React.isValidElement(c) && c.type === 'code'
                              );
                              if (codeEl && React.isValidElement(codeEl) && codeEl.props?.className) {
                                const lang = getCodeBlockLang(codeEl.props.className);
                                const codeStr = typeof codeEl.props.children === 'string'
                                  ? codeEl.props.children
                                  : String(codeEl.props.children ?? '');
                                return (
                                  <CodeHighlighter lang={lang} header={lang !== 'text' ? lang : null}>
                                    {codeStr}
                                  </CodeHighlighter>
                                );
                              }
                              return <pre>{children}</pre>;
                            },
                          }}
                        >
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    }
                  />
                </>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      )}

      <div className="composer composer--sender" style={{ padding: '18px 16px 26px', width: '100%', maxWidth: 1200, margin: '0 auto', boxSizing: 'border-box' }}>
        <Sender
          className="composer-sender"
          value={input}
          onChange={setInput}
          onSubmit={(message) => handleSend(message)}
          placeholder="请发消息（可以让 AI 使用 list_dir 和 read_file 工具）"
          disabled={isLoading}
          loading={isLoading}
          submitType="enter"
          autoSize={{ minRows: 2, maxRows: 6 }}
          footer={
            <Text type="secondary" style={{ fontSize: 11 }}>
              {isLoading ? '正在输入...' : 'Enter 发送，Shift+Enter 换行'}
            </Text>
          }
        />
      </div>
    </>
  );
}
