import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { load } from '@tauri-apps/plugin-store';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ModelSelector } from './components/ModelSelector';
import './App.css';

const PREFERRED_MODEL_KEY = 'preferred_model';
const DEFAULT_MODEL = 'deepseek-r1:latest';

type Role = 'user' | 'assistant' | 'system';

type ChatMessage = {
  role: Role;
  content: string;
  thinking?: string;
  kind?: 'normal' | 'thinking_placeholder';
};

type Session = {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number; // last used timestamp (ms)
};

type StoredData = {
  sessions: Session[];
  lastUpdated: number;
};

const STORE_PATH = 'chat_history.json';
const STORE_KEY = 'chat_history';
const MAX_SESSIONS = 20;
const WELCOME_MESSAGE: ChatMessage = {
  role: 'system',
  content: '你好！我是 DeepSeek-R1 助手，有什么可以帮你的？',
  kind: 'normal',
};

// 解析 AI 返回的文本，提取 thinking 和 answer
function parseAIResponse(text: string): { thinking?: string; answer: string } {
  const thinkingMatch = text.match(/<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/);
  const answerMatch = text.match(/<answer>([\s\S]*?)<\/answer>/);

  const thinking = thinkingMatch ? thinkingMatch[1].trim() : undefined;
  if (answerMatch) {
    return { thinking, answer: answerMatch[1].trim() };
  }

  // 没有 <answer> 时：尽量把 <think>/<thinking> 块剥离出来，避免被 Markdown 当成 HTML 丢掉
  const stripped = text
    .replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/g, '')
    .trim();
  const answer = stripped.length > 0 ? stripped : text.trim();

  return { thinking, answer };
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<Session[]>([]);
  const [historyHydrated, setHistoryHydrated] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(PREFERRED_MODEL_KEY);
      return saved && saved.length > 0 ? saved : DEFAULT_MODEL;
    } catch {
      return DEFAULT_MODEL;
    }
  });
  const requestSeq = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const storeRef = useRef<Awaited<ReturnType<typeof load>> | null>(null);

  const messagesForBackend = useMemo(
    () =>
      messages
        .filter((m) => m.kind !== 'thinking_placeholder')
        .map((m) => ({ role: m.role, content: m.content })),
    [messages],
  );

  const getConversationSnapshot = (msgs: ChatMessage[]) =>
    msgs.filter((m) => m.kind !== 'thinking_placeholder');

  function hasUserMessage(msgs: ChatMessage[]): boolean {
    return msgs.some((m) => m.role === 'user' && m.content.trim().length > 0);
  }

  function normalizeSessions(sessions: Session[]): Session[] {
    const cleaned = sessions
      .filter(Boolean)
      .map((s) => ({
        ...s,
        messages: getConversationSnapshot(s.messages ?? []),
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
        title: typeof s.title === 'string' ? s.title : '新对话',
        id: typeof s.id === 'string' ? s.id : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      }));
    cleaned.sort((a, b) => b.updatedAt - a.updatedAt);
    return cleaned.slice(0, MAX_SESSIONS);
  }

  async function getStore() {
    if (!storeRef.current) {
      storeRef.current = await load(STORE_PATH, { defaults: {}, autoSave: false });
    }
    return storeRef.current;
  }

  async function persistHistory(sessions: Session[]) {
    try {
      const store = await getStore();
      const payload: StoredData = {
        sessions,
        lastUpdated: Date.now(),
      };
      await store.set(STORE_KEY, payload);
      await store.save();
    } catch (e) {
      console.error('保存历史记录失败:', e);
    }
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const store = await getStore();
        const data = await store.get<StoredData>(STORE_KEY);
        if (!alive) return;
        const sessions = Array.isArray(data?.sessions) ? normalizeSessions(data!.sessions) : [];
        setHistory(sessions);
      } catch (e) {
        console.error('读取历史记录失败:', e);
      } finally {
        if (alive) setHistoryHydrated(true);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!historyHydrated) return;
    void persistHistory(history);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, historyHydrated]);

  // 持久化用户选择的模型到 localStorage
  useEffect(() => {
    try {
      localStorage.setItem(PREFERRED_MODEL_KEY, selectedModel);
    } catch {
      // ignore
    }
  }, [selectedModel]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, isLoading]);

  function makeSessionTitle(msgs: ChatMessage[]): string {
    const firstUser = msgs.find((m) => m.role === 'user' && m.content.trim().length > 0);
    if (!firstUser) return '新对话';
    const text = firstUser.content.trim().replace(/\s+/g, ' ');
    return text.slice(0, 20);
  }

  function saveCurrentConversationToHistory() {
    const snapshot = getConversationSnapshot(messages);
    if (!hasUserMessage(snapshot)) return;
    const now = Date.now();
    const session: Session = {
      id: `${now}-${Math.random().toString(16).slice(2)}`,
      title: makeSessionTitle(snapshot),
      messages: snapshot,
      updatedAt: now,
    };
    setHistory((prev) => normalizeSessions([session, ...prev]));
  }

  // 发送消息
  async function handleSend() {
    if (!input.trim() || isLoading) return;

    const myReq = ++requestSeq.current;
    const userMessage: ChatMessage = { role: 'user', content: input, kind: 'normal' };
    const nextMessagesForBackend = [...messagesForBackend, { role: 'user', content: input }];
    setMessages((prev) => [
      ...prev,
      userMessage,
      { role: 'assistant', content: '', kind: 'thinking_placeholder' },
    ]);
    setInput('');
    setIsLoading(true);

    try {
      const result: string = await invoke('chat_with_model', {
        messages: nextMessagesForBackend,
        modelName: selectedModel,
      });
      if (myReq !== requestSeq.current) return;

      // 解析 AI 返回的文本
      const { thinking, answer } = parseAIResponse(result);

      // 移除占位消息，添加解析后的真实消息
      setMessages((prev) => {
        const filtered = prev.filter((msg) => msg.kind !== 'thinking_placeholder');
        return [...filtered, { role: 'assistant', content: answer, thinking, kind: 'normal' }];
      });
    } catch (error) {
      console.error('调用失败:', error);
      if (myReq !== requestSeq.current) return;
      // 移除占位消息，添加错误提示
      setMessages((prev) => {
        const filtered = prev.filter((msg) => msg.kind !== 'thinking_placeholder');
        return [...filtered, { role: 'assistant', content: `出错了: ${error}`, kind: 'normal' }];
      });
    } finally {
      if (myReq === requestSeq.current) setIsLoading(false);
    }
  }

  // 处理回车发送（Shift+Enter换行）
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isHome = messages.length === 0;

  const handleNewChat = () => {
    // 先把当前对话（如果有内容）存入历史
    saveCurrentConversationToHistory();
    // 终止当前请求并清空状态
    requestSeq.current += 1;
    setMessages([WELCOME_MESSAGE]);
    setInput('');
    setIsLoading(false);
    setCurrentSessionId(null);
  };

  const handleLoadSession = (sessionId: string) => {
    const session = history.find((s) => s.id === sessionId);
    if (!session) return;
    requestSeq.current += 1;
    setIsLoading(false);
    setInput('');
    setMessages(session.messages);
    setCurrentSessionId(sessionId);

    const now = Date.now();
    setHistory((prev) => {
      const target = prev.find((s) => s.id === sessionId);
      if (!target) return prev;
      const updated: Session = { ...target, updatedAt: now };
      return normalizeSessions([updated, ...prev.filter((s) => s.id !== sessionId)]);
    });
  };

  const handleDeleteSession = (sessionId: string) => {
    setHistory((prev) => prev.filter((s) => s.id !== sessionId));
    if (currentSessionId === sessionId) {
      requestSeq.current += 1;
      setIsLoading(false);
      setInput('');
      setMessages([WELCOME_MESSAGE]);
      setCurrentSessionId(null);
    }
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__top">
          <div className="sidebar__title">DogEgg AI</div>
          <button className="sidebar__newChat" type="button" onClick={handleNewChat}>
            开启新对话
          </button>
          <ModelSelector
            currentModel={selectedModel}
            onModelChange={setSelectedModel}
          />
        </div>

        {history.length > 0 && (
          <>
            <div className="sidebar__divider" aria-hidden="true">
              <span className="sidebar__dividerLine" />
              <span className="sidebar__dividerText">历史记录</span>
              <span className="sidebar__dividerLine" />
            </div>
            <div className="sidebar__history" aria-label="历史会话列表">
              {history.map((session) => (
                <div
                  key={session.id}
                  className="sidebar__historyItem"
                  onClick={() => handleLoadSession(session.id)}
                >
                  <span className="sidebar__historyTitle">{session.title}</span>
                  <button
                    type="button"
                    className="sidebar__historyDelete"
                    aria-label="删除会话"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteSession(session.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {/* 暂时隐藏编辑按钮 */}
        {/* <div className="sidebar__bottom">
          <button className="iconButton" type="button" aria-label="Settings">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M19.4 15a7.9 7.9 0 0 0 .1-1l2-1.2-2-3.4-2.3.6a7.6 7.6 0 0 0-1.7-1L15.2 6H8.8L8.5 8.9a7.6 7.6 0 0 0-1.7 1l-2.3-.6-2 3.4 2 1.2a7.9 7.9 0 0 0 .1 1 7.9 7.9 0 0 0-.1 1l-2 1.2 2 3.4 2.3-.6a7.6 7.6 0 0 0 1.7 1l.3 2.9h6.4l.3-2.9a7.6 7.6 0 0 0 1.7-1l2.3.6 2-3.4-2-1.2a7.9 7.9 0 0 0-.1-1Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
                opacity="0.85"
              />
            </svg>
          </button>
        </div> */}
      </aside>

      <main className="main">
        <div className="main__content">
          {isHome ? (
            <div className="home">
              <div className="home__hero">
                <div className="home__title">我是DogEgg AI助手!</div>
                {/* <div className="home__subtitle">在下方输入消息开始对话。</div> */}
              </div>
            </div>
          ) : (
            <div className="chat">
              <div className="messages" role="log" aria-label="Chat messages">
                {messages.map((msg, index) => (
                  <div key={index} className={`messageRow ${msg.role}`}>
                    <div className={`bubble ${msg.role}`}>
                      {msg.role === 'assistant' && msg.thinking && msg.kind !== 'thinking_placeholder' && (
                        <details className="thinking">
                          <summary>思考过程</summary>
                          <div className="thinking__content">{msg.thinking}</div>
                        </details>
                      )}
                      <div className="bubble__content">
                        {msg.role === 'assistant' && msg.kind === 'thinking_placeholder' ? (
                          <div className="thinkingDots" aria-label="思考中">
                            <span className="thinkingDot" />
                            <span className="thinkingDot" />
                            <span className="thinkingDot" />
                          </div>
                        ) : msg.role === 'assistant' ? (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              a: (props) => (
                                <a
                                  {...props}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                />
                              ),
                            }}
                          >
                            {msg.content}
                          </ReactMarkdown>
                        ) : (
                          msg.content
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            </div>
          )}
        </div>

        <div className="composer">
          <div className="composer__inner">
            <textarea
              className="composer__input"
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="给狗蛋发消息"
              disabled={isLoading}
            />
            <button
              className="composer__send"
              type="button"
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              aria-label="Send message"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4.5 19.5 20 12 4.5 4.5l2.2 6.2L15 12l-8.3 1.3-2.2 6.2Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
          <div className="composer__meta">
            {isLoading ? '正在输入...' : 'Enter 发送，Shift+Enter 换行'}
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;