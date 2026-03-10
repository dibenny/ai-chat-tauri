import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { OllamaModelInfo } from '../types/ollama';
import './ModelSelector.css';

const DEFAULT_MODEL = 'deepseek-r1:latest';

export interface ModelSelectorProps {
  currentModel: string;
  onModelChange: (modelName: string) => void;
}

/**
 * 模型选择器：下拉框展示 Ollama 本地模型列表，选择后通过 onModelChange 回传。
 * 通过 invoke('get_ollama_models') 获取列表；当前模型不在列表中时默认选第一项。
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
        // 若当前选中模型不在列表中，通知父组件使用列表第一项（或默认）
        const names = list?.map((m) => m.name) ?? [];
        if (currentModel && names.length > 0 && !names.includes(currentModel)) {
          const fallback = names[0] ?? DEFAULT_MODEL;
          onModelChange(fallback);
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
  }, []); // 仅挂载时拉取一次；currentModel 变化时由父组件控制

  const value =
    currentModel && models.some((m) => m.name === currentModel)
      ? currentModel
      : models[0]?.name ?? '';

  if (loading) {
    return (
      <div className="modelSelector modelSelector--loading" aria-busy="true">
        加载模型中…
      </div>
    );
  }

  if (error) {
    return (
      <div className="modelSelector modelSelector--error" role="alert">
        {error}
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="modelSelector modelSelector--empty">
        暂无本地模型，请先在 Ollama 中拉取模型
      </div>
    );
  }

  return (
    <div className="modelSelector">
      <label className="modelSelector__label" htmlFor="model-select">
        模型
      </label>
      <select
        id="model-select"
        className="modelSelector__select"
        value={value}
        onChange={(e) => onModelChange(e.target.value)}
        aria-label="选择对话模型"
      >
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}
          </option>
        ))}
      </select>
    </div>
  );
}
