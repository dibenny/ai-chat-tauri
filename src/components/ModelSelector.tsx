import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Select, Spin, Alert, Typography } from 'antd';
import type { OllamaModelInfo } from '../types/ollama';

const DEFAULT_MODEL = 'deepseek-r1:latest';

export interface ModelSelectorProps {
  currentModel: string;
  onModelChange: (modelName: string) => void;
}

/**
 * 模型选择器：使用 antd Select 展示 Ollama 本地模型列表，选择后通过 onModelChange 回传。
 */
export function ModelSelector({ currentModel, onModelChange }: ModelSelectorProps) {
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await invoke<OllamaModelInfo[]>('get_ollama_models');
        if (!alive) return;
        setModels(Array.isArray(list) ? list : []);
        const names = list?.map((m) => m.name) ?? [];
        if (currentModel && names.length > 0 && !names.includes(currentModel)) {
          onModelChange(names[0] ?? DEFAULT_MODEL);
        }
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setModels([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const value =
    currentModel && models.some((m) => m.name === currentModel)
      ? currentModel
      : models[0]?.name ?? undefined;

  if (loading) {
    return (
      <div style={{ padding: '8px 0', textAlign: 'center' }} aria-busy="true">
        <Spin size="small" tip="加载模型中…" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message={error}
        role="alert"
        style={{ marginTop: 4 }}
      />
    );
  }

  if (models.length === 0) {
    return (
      <Alert
        type="info"
        message="暂无本地模型"
        description="请先在 Ollama 中拉取模型"
        style={{ marginTop: 4 }}
      />
    );
  }

  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
        模型
      </Typography.Text>
      <Select
        id="model-select"
        aria-label="选择对话模型"
        style={{ width: '100%' }}
        value={value}
        onChange={onModelChange}
        options={models.map((m) => ({ label: m.name, value: m.name }))}
        placeholder="选择模型"
      />
    </div>
  );
}
