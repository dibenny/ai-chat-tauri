import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { load } from '@tauri-apps/plugin-store';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Layout, Button, Space, Typography, List, Divider, Spin, Tooltip, Switch } from 'antd';
import { PlusOutlined, DeleteOutlined, MenuFoldOutlined, MenuUnfoldOutlined, ToolOutlined } from '@ant-design/icons';
import { Think, Bubble, Sender, Welcome, CodeHighlighter } from '@ant-design/x';
import { ModelSelector } from './components/ModelSelector';
import { AgentChat } from './components/AgentChat';
import './App.css';

const { Sider, Content } = Layout;
const { Title, Text } = Typography;

const PREFERRED_MODEL_KEY = 'preferred_model';
const DEFAULT_MODEL = 'deepseek-r1:latest';

/** 从 Markdown 代码块 className（language-xxx）解析出 lang，供 CodeHighlighter 使用 */
function getCodeBlockLang(className?: string): string {
  if (!className || typeof className !== 'string') return 'text';
  const m = className.match(/language-(\S+)/);
  return m ? m[1] : 'text';
}

/** 根据模型 id 得到展示名（用于 Welcome 等） */
function getModelDisplayName(modelName: string): string {
  const lower = modelName.toLowerCase();
  if (lower.includes('deepseek') && (lower.includes('r1') || lower.includes('r2'))) {
    return lower.includes('r2') ? 'DeepSeek-R2' : 'DeepSeek-R1';
  }
  if (lower.includes('qwen')) return 'Qwen';
  const base = modelName.split(':')[0] ?? modelName;
  return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
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

type Session = {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
};

type StoredData = {
  sessions: Session[];
  lastUpdated: number;
};

const STORE_PATH = 'chat_history.json';
const STORE_KEY = 'chat_history';
const MAX_SESSIONS = 20;

function parseAIResponse(text: string): { thinking?: string; answer: string } {
  const thinkingMatch = text.match(/<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/);
  const answerMatch = text.match(/<answer>([\s\S]*?)<\/answer>/);

  const thinking = thinkingMatch ? thinkingMatch[1].trim() : undefined;
  if (answerMatch) {
    return { thinking, answer: answerMatch[1].trim() };
  }

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
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
      const payload: StoredData = { sessions, lastUpdated: Date.now() };
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
  }, []);

  useEffect(() => {
    if (!historyHydrated) return;
    void persistHistory(history);
  }, [history, historyHydrated]);

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

  function isSameConversation(a: ChatMessage[], b: ChatMessage[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((msg, idx) => {
      const other = b[idx];
      return (
        msg.role === other.role
        && msg.content === other.content
        && msg.thinking === other.thinking
        && msg.kind === other.kind
      );
    });
  }

  function saveCurrentConversationToHistory() {
    const snapshot = getConversationSnapshot(messages);
    if (!hasUserMessage(snapshot)) return;
    const now = Date.now();
    const title = makeSessionTitle(snapshot);

    setHistory((prev) => {
      // 正在查看历史会话时，更新该会话，避免“开启新对话”时新增重复记录
      if (currentSessionId) {
        const existing = prev.find((s) => s.id === currentSessionId);
        if (existing) {
          const updated: Session = {
            ...existing,
            title,
            messages: snapshot,
            updatedAt: now,
          };
          return normalizeSessions([updated, ...prev.filter((s) => s.id !== currentSessionId)]);
        }
      }

      // 非历史会话场景：若已有完全相同的会话，直接更新时间并前置，不重复新增
      const duplicate = prev.find((s) => isSameConversation(s.messages, snapshot));
      if (duplicate) {
        const updated: Session = { ...duplicate, title, updatedAt: now };
        return normalizeSessions([updated, ...prev.filter((s) => s.id !== duplicate.id)]);
      }

      const session: Session = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        title,
        messages: snapshot,
        updatedAt: now,
      };
      return normalizeSessions([session, ...prev]);
    });
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
      const result: string = await invoke('chat_with_model', {
        messages: nextMessagesForBackend,
        modelName: selectedModel,
      });
      if (myReq !== requestSeq.current) return;

      const { thinking, answer } = parseAIResponse(result);

      setMessages((prev) => {
        const filtered = prev.filter((msg) => msg.kind !== 'thinking_placeholder');
        return [...filtered, { role: 'assistant', content: answer, thinking, kind: 'normal' }];
      });
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

  const isHome = messages.length === 0;

  const resetConversationView = () => {
    // 终止可能进行中的请求，并回到「无对话」状态（展示 Welcome）
    requestSeq.current += 1;
    setIsLoading(false);
    setInput('');
    setMessages([]);
    setCurrentSessionId(null);
  };

  const handleNewChat = () => {
    saveCurrentConversationToHistory();
    resetConversationView();
  };

  const handleModelChange = (nextModel: string) => {
    if (!nextModel || nextModel === selectedModel) return;
    // 切换模型前，把当前对话存为历史（如有用户消息）
    saveCurrentConversationToHistory();
    // 重置右侧对话，再切换模型
    resetConversationView();
    setSelectedModel(nextModel);
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
      resetConversationView();
    }
  };

  return (
    <Layout className="app-shell" style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Sider
        width={280}
        collapsedWidth={0}
        collapsed={sidebarCollapsed}
        className="sidebar"
        style={{
          background: 'var(--panel)',
          borderRight: '1px solid var(--border)',
          padding: '34px 20px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Title level={4} style={{ color: 'var(--rose)', margin: 0 }}>
            DogEgg AI
          </Title>
          <Tooltip title="收起侧边栏">
            <Button
              type="link"
              icon={<MenuFoldOutlined />}
              onClick={() => setSidebarCollapsed(true)}
              style={{ color: 'var(--rose)' }}
            />
          </Tooltip>
        </div>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Button
            type="default"
            icon={<PlusOutlined />}
            onClick={handleNewChat}
            block
            className="sidebar__newChat"
          >
            开启新对话
          </Button>
          <ModelSelector currentModel={selectedModel} onModelChange={handleModelChange} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
            <ToolOutlined style={{ color: 'var(--rose)' }} />
            <Text style={{ flex: 1, fontSize: 13 }}>Agent 模式</Text>
            <Switch checked={agentMode} onChange={setAgentMode} />
          </div>
        </Space>

        {history.length > 0 && (
          <>
            <Divider plain style={{ margin: '12px 0', color: 'var(--muted)' }}>
              <Text type="secondary" style={{ fontSize: 11 }}>历史记录</Text>
            </Divider>
            <div className="sidebar__history" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <List
                dataSource={history}
                style={{ paddingRight: 4 }}
                renderItem={(session) => (
                  <List.Item
                    key={session.id}
                    style={{ padding: 0, border: 'none', marginBottom: 10 }}
                  >
                    <div
                      className="sidebar__historyItem"
                      onClick={() => handleLoadSession(session.id)}
                      onKeyDown={(e) => e.key === 'Enter' && handleLoadSession(session.id)}
                      role="button"
                      tabIndex={0}
                    >
                      <Text ellipsis style={{ flex: 1, fontSize: 13 }}>
                        {session.title}
                      </Text>
                      <Button
                        type="text"
                        size="small"
                        icon={<DeleteOutlined />}
                        aria-label="删除会话"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteSession(session.id);
                        }}
                        style={{ color: 'var(--rose)' }}
                      />
                    </div>
                  </List.Item>
                )}
              />
            </div>
          </>
        )}
      </Sider>

      <Layout>
        <Content className="main__content" style={{ padding: '46px 16px 18px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {sidebarCollapsed && (
            <Tooltip title="展开侧边栏">
              <Button
                type="text"
                icon={<MenuUnfoldOutlined />}
                onClick={() => setSidebarCollapsed(false)}
                style={{
                  position: 'absolute',
                  top: 16,
                  left: 16,
                  zIndex: 1,
                  color: 'var(--rose)',
                }}
              />
            </Tooltip>
          )}
          {agentMode ? (
            <AgentChat selectedModel={selectedModel} onMessagesChange={setMessages} />
          ) : isHome ? (
            <div className="home home--welcome">
              <Welcome
                icon="https://mdn.alipayobjects.com/huamei_iwk9zp/afts/img/A*s5sNRo5LjfQAAAAAAAAAAAAADgCCAQ/fmt.webp"
                title={`Hello，我是${getModelDisplayName(selectedModel)}模型`}
                description={`基于${getModelDisplayName(selectedModel)}打造更卓越的智能对话助手`}
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
                    {msg.role === 'assistant' && msg.kind === 'normal' && (
                      <>
                        {msg.thinking != null && msg.thinking !== '' && (
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
        </Content>

        {!agentMode && (
          <div className="composer composer--sender" style={{ padding: '18px 16px 26px', width: '100%', maxWidth: 1200, margin: '0 auto', boxSizing: 'border-box' }}>
            <Sender
              className="composer-sender"
              value={input}
              onChange={setInput}
              onSubmit={(message) => handleSend(message)}
              placeholder="请发消息"
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
        )}
      </Layout>
    </Layout>
  );
}

export default App;
