/**
 * 与 Ollama API 响应对应的前端类型
 * 对应后端 get_ollama_models 返回的数组元素结构（/api/tags）
 */
export interface OllamaModelInfo {
  name: string;
  modified_at?: string;
  size?: number;
}
