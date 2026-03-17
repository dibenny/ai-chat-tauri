// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: Option<Message>,
}

// --- Ollama /api/tags 响应：本地模型列表 ---
#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModelInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaModelInfo {
    pub name: String,
    #[serde(default)]
    pub modified_at: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn ask_ai(prompt: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let full_prompt = format!(
        "请先思考，思考过程放在 <thinking> 标签内，最终答案放在 <answer> 标签内。\n\n问题：{}",
        prompt
    );
    let request_body = serde_json::json!({
        "model": "deepseek-r1:latest",
        "prompt": full_prompt,
        "stream": false
    });

    let resp = client
        .post("http://localhost:11434/api/generate")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama API错误，状态码: {status}，响应: {body}"));
    }

    let ollama_response: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let ai_text = ollama_response["response"]
        .as_str()
        .unwrap_or("(模型未返回有效文本)")
        .to_string();
    Ok(ai_text)
}

/// 调用 Ollama GET /api/tags 获取本地已下载的模型列表。
/// 若 Ollama 未启动或请求失败，返回明确错误信息。
#[tauri::command]
async fn get_ollama_models() -> Result<Vec<OllamaModelInfo>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("http://localhost:11434/api/tags")
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                "无法连接 Ollama，请确认已启动 Ollama 服务（如未安装请访问 https://ollama.com）".to_string()
            } else {
                format!("获取模型列表失败: {e}")
            }
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama API 错误，状态码: {status}，响应: {body}"));
    }

    let data: OllamaTagsResponse = resp.json().await.map_err(|e| format!("解析响应失败: {e}"))?;
    Ok(data.models)
}

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法获取用户主目录".to_string())
}

#[tauri::command]
fn read_file(file_path: String) -> Result<String, String> {
    std::fs::read_to_string(&file_path)
        .map_err(|e| format!("读取文件失败: {}", e))
}

#[derive(Debug, Clone, Serialize)]
struct FileEntry {
    name: String,
    is_dir: bool,
    size: Option<u64>,
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = std::fs::read_dir(&path)
        .map_err(|e| format!("读取目录失败: {}", e))?;

    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let metadata = entry.metadata().ok();
        result.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            size: metadata.and_then(|m| if m.is_file() { Some(m.len()) } else { None }),
        });
    }

    result.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        }
    });

    Ok(result)
}

#[tauri::command]
async fn chat_with_model(messages: Vec<Message>, model_name: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let model = if model_name.is_empty() {
        "deepseek-r1:latest".to_string()
    } else {
        model_name
    };
    let request_body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false
    });

    let resp = client
        .post("http://localhost:11434/api/chat")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama API错误，状态码: {status}，响应: {body}"));
    }

    let data: OllamaChatResponse = resp.json().await.map_err(|e| e.to_string())?;
    let content = data
        .message
        .map(|m| m.content)
        .unwrap_or_else(|| "(模型未返回有效 message.content)".to_string());
    Ok(content)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![greet, ask_ai, get_ollama_models, chat_with_model, read_file, list_dir, get_home_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
