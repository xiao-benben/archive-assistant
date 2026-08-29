import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  BootstrapData,
  FavoriteCategory,
  FavoriteLink,
  FileEntry,
  OcrResult,
  OperationResult,
  PasswordEntry,
  PlanTask,
} from "../types";

export const isTauri = () => "__TAURI_INTERNALS__" in window;

const today = () => new Date().toISOString().slice(0, 10);

const demoBootstrap = (): BootstrapData => ({
  workspaces: [],
  favoriteCategories: [
    { id: "notice", name: "通知类", color: "#315bdb", position: 0, count: 0 },
    { id: "speech", name: "讲稿类", color: "#b7791f", position: 1, count: 0 },
    { id: "board", name: "看板类", color: "#19806a", position: 2, count: 0 },
    { id: "slides", name: "宣讲 PPT", color: "#a14f7a", position: 3, count: 0 },
  ],
  favorites: [],
  tasks: [],
  recentFiles: [],
  passwords: [],
  allTags: [],
  settings: {
    storageRoot: "D:\\自动归档",
    theme: "light",
    startOnLogin: true,
    notifications: true,
    ocrAutoWorkspaces: [],
    modelBaseUrl: "https://api.deepseek.com",
    modelName: "deepseek-chat",
    modelKeySaved: false,
    quietHours: false,
    quietStart: "22:00",
    quietEnd: "07:30",
    mobileEnabled: false,
  },
  connectors: [
    {
      id: "ocr",
      name: "离线 OCR",
      description: "中英文图片与扫描 PDF",
      state: "ready",
      enabled: true,
    },
    {
      id: "model",
      name: "大模型",
      description: "摘要、分类与命名建议",
      state: "reserved",
      enabled: false,
    },
    {
      id: "wps",
      name: "WPS 云文档",
      description: "选择性双向同步",
      state: "reserved",
      enabled: false,
    },
    {
      id: "wechat",
      name: "微信提醒",
      description: "合规消息连接器",
      state: "reserved",
      enabled: false,
    },
    {
      id: "mobile",
      name: "手机访问",
      description: "局域网配对与只读文件访问",
      state: "reserved",
      enabled: false,
    },
  ],
});

let browserState: BootstrapData = (() => {
  try {
    const stored = localStorage.getItem("archive-assistant-preview");
    return stored ? JSON.parse(stored) : demoBootstrap();
  } catch {
    return demoBootstrap();
  }
})();

const persistBrowserState = () =>
  localStorage.setItem(
    "archive-assistant-preview",
    JSON.stringify(browserState),
  );

async function call<T>(
  command: string,
  args?: Record<string, unknown>,
  fallback?: () => T | Promise<T>,
): Promise<T> {
  if (isTauri()) return invoke<T>(command, args);
  if (fallback) return fallback();
  throw new Error(`此操作需要在归档助手桌面应用中使用：${command}`);
}

export const api = {
  bootstrap: () =>
    call<BootstrapData>("get_bootstrap", undefined, () =>
      structuredClone(browserState),
    ),
  listDirectory: (relativePath: string) =>
    call<FileEntry[]>("list_directory", { relativePath }, () => []),
  createWorkspace: (name: string) =>
    call<BootstrapData>("create_workspace", { name }, () => {
      const now = Date.now();
      browserState.workspaces.push({
        id: crypto.randomUUID(),
        name,
        relativePath: name,
        modifiedAt: now,
        itemCount: 0,
        size: 0,
      });
      persistBrowserState();
      return structuredClone(browserState);
    }),
  deleteWorkspace: (relativePath: string) =>
    call<BootstrapData>("delete_workspace", { relativePath }),
  createFolder: (parentPath: string, name: string) =>
    call<FileEntry[]>("create_folder", { parentPath, name }),
  renameEntry: (relativePath: string, newName: string) =>
    call<OperationResult>("rename_entry", { relativePath, newName }),
  transferEntries: (
    relativePaths: string[],
    targetPath: string,
    mode: "copy" | "move",
  ) =>
    call<OperationResult>("transfer_entries", {
      relativePaths,
      targetPath,
      mode,
    }),
  importFiles: (
    sourcePaths: string[],
    targetPath: string,
    mode: "copy" | "move",
  ) => call<OperationResult>("import_files", { sourcePaths, targetPath, mode }),
  deleteEntries: (relativePaths: string[]) =>
    call<OperationResult>("delete_entries", { relativePaths }),
  search: (query: string) =>
    call<FileEntry[]>("search_files", { query }, () => []),
  ocrCandidates: (workspacePaths: string[]) =>
    call<FileEntry[]>("list_ocr_candidates", { workspacePaths }, () => []),
  createFavoriteCategory: (name: string, color: string) =>
    call<FavoriteCategory>("create_favorite_category", { name, color }, () => {
      const category = {
        id: crypto.randomUUID(),
        name,
        color,
        position: browserState.favoriteCategories.length,
        count: 0,
      };
      browserState.favoriteCategories.push(category);
      persistBrowserState();
      return category;
    }),
  toggleFavorite: (
    categoryId: string,
    relativePath: string,
    displayName: string,
  ) =>
    call<FavoriteLink[]>("toggle_favorite", {
      categoryId,
      relativePath,
      displayName,
    }),
  addFavoritesFromPaths: (categoryId: string, sourcePaths: string[]) =>
    call<OperationResult>("add_favorites_from_paths", {
      categoryId,
      sourcePaths,
    }),
  saveTask: (task: Partial<PlanTask> & Pick<PlanTask, "title">) =>
    call<PlanTask>("save_task", { task }, () => {
      const next: PlanTask = {
        id: task.id ?? crypto.randomUUID(),
        title: task.title,
        planScope: task.planScope ?? "daily",
        dueDate: task.dueDate ?? today(),
        remindAt: task.remindAt,
        priority: task.priority ?? "medium",
        repeatRule: task.repeatRule ?? "none",
        note: task.note ?? "",
        completed: task.completed ?? false,
        completedAt: task.completedAt,
        createdAt: task.createdAt ?? Date.now(),
      };
      const index = browserState.tasks.findIndex((item) => item.id === next.id);
      if (index >= 0) browserState.tasks[index] = next;
      else browserState.tasks.push(next);
      persistBrowserState();
      return next;
    }),
  deleteTask: (id: string) =>
    call<void>("delete_task", { id }, () => {
      browserState.tasks = browserState.tasks.filter((task) => task.id !== id);
      persistBrowserState();
    }),
  saveSettings: (settings: AppSettings, modelApiKey?: string) =>
    call<AppSettings>("save_settings", { settings, modelApiKey }, () => {
      browserState.settings = settings;
      persistBrowserState();
      return settings;
    }),
  saveOcrResult: (result: OcrResult) =>
    call<void>("save_ocr_result", { result }),
  getCachedOcr: (relativePath: string) =>
    call<OcrResult | null>("get_cached_ocr", { relativePath }, () => null),
  readFileBytes: (relativePath: string) =>
    call<number[]>("read_file_bytes", { relativePath }),
  getFileHash: (relativePath: string) =>
    call<string>("get_file_hash", { relativePath }),
  openFile: (relativePath: string) => call<void>("open_file", { relativePath }),
  openFileWith: (relativePath: string) =>
    call<void>("open_file_with", { relativePath }),
  savePasswordEntry: (entry: {
    id?: string;
    title: string;
    url?: string;
    username?: string;
    password?: string;
    notes?: string;
    groupTag?: string;
  }) =>
    call<PasswordEntry[]>(
      "save_password_entry",
      {
        id: entry.id,
        title: entry.title,
        url: entry.url,
        username: entry.username,
        password: entry.password,
        notes: entry.notes,
        groupTag: entry.groupTag,
      },
      () => {
        const now = Date.now();
        const next: PasswordEntry = {
          id: entry.id ?? crypto.randomUUID(),
          title: entry.title,
          url: entry.url ?? "",
          username: entry.username ?? "",
          notes: entry.notes ?? "",
          groupTag: entry.groupTag ?? "",
          createdAt: now,
          updatedAt: now,
        };
        const index = browserState.passwords.findIndex(
          (item) => item.id === next.id,
        );
        if (index >= 0) browserState.passwords[index] = next;
        else browserState.passwords.unshift(next);
        persistBrowserState();
        return structuredClone(browserState.passwords);
      },
    ),
  deletePasswordEntry: (id: string) =>
    call<PasswordEntry[]>("delete_password_entry", { id }, () => {
      browserState.passwords = browserState.passwords.filter(
        (item) => item.id !== id,
      );
      persistBrowserState();
      return structuredClone(browserState.passwords);
    }),
  revealPassword: (id: string) =>
    call<string>("reveal_password", { id }, () => ""),
  addFileTags: (relativePaths: string[], tag: string) =>
    call<OperationResult>(
      "add_file_tags",
      { relativePaths, tag },
      () => ({ success: true, message: "", affected: [], skipped: [] }),
    ),
  removeFileTags: (relativePaths: string[], tag: string) =>
    call<OperationResult>(
      "remove_file_tags",
      { relativePaths, tag },
      () => ({ success: true, message: "", affected: [], skipped: [] }),
    ),
};
