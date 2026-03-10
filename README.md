# AI Chat Tauri

基于 Tauri + React + Ollama 的本地 AI 聊天桌面应用，支持多模型切换、历史对话记录。

## ✨ 功能特点

- 支持多个模型（deepseek-r1, qwen2.5）切换,本地先通过Ollama部署deepseek-r1, qwen2.5两个模型
- 对话历史记录，最多保存 20 条，30 天自动过期
- 纯本地运行，保护隐私

## 🚀 快速开始

### 环境要求
- Node.js 20+
- Rust (安装方法: https://rustup.rs/)
- Ollama (下载: https://ollama.com)

# 安装前端依赖
npm install

# 开发模式运行
npm run tauri dev