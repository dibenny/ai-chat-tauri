import { invoke } from '@tauri-apps/api/core';

export interface FileEntry {
  name: string;
  is_dir: boolean;
  size?: number;
}

export async function readFile(filePath: string): Promise<string> {
  return await invoke<string>('read_file', { filePath });
}

export async function listDir(path: string): Promise<FileEntry[]> {
  return await invoke<FileEntry[]>('list_dir', { path });
}
