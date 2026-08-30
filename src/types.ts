export type ViewId =
  | "home"
  | "workspace"
  | "favorites"
  | "planner"
  | "smart"
  | "passwords"
  | "settings";

export interface Workspace {
  id: string;
  name: string;
  relativePath: string;
  modifiedAt: number;
  itemCount: number;
  size: number;
}

export interface FileEntry {
  name: string;
  relativePath: string;
  absolutePath: string;
  isDirectory: boolean;
  extension: string;
  size: number;
  modifiedAt: number;
  favorite: boolean;
  ocrIndexed: boolean;
  tags: string[];
  wpsSync: boolean;
}

export interface FavoriteCategory {
  id: string;
  name: string;
  color: string;
  position: number;
  count: number;
}

export interface FavoriteLink {
  id: string;
  categoryId: string;
  relativePath: string;
  displayName: string;
  missing: boolean;
  createdAt: number;
}

export type RepeatRule = string;
export type TaskPriority = "low" | "medium" | "high";
export type PlanScope = "daily" | "weekly";

export interface PlanTask {
  id: string;
  title: string;
  planScope: PlanScope;
  dueDate: string;
  remindAt?: string;
  priority: TaskPriority;
  repeatRule: RepeatRule;
  note: string;
  completed: boolean;
  completedAt?: number;
  createdAt: number;
}

export interface ConnectorStatus {
  id: "model" | "wps" | "wechat" | "mobile" | "ocr";
  name: string;
  description: string;
  state: "ready" | "reserved" | "disabled";
  enabled: boolean;
}

export interface AppSettings {
  storageRoot: string;
  theme: "light" | "dark";
  startOnLogin: boolean;
  notifications: boolean;
  ocrAutoWorkspaces: string[];
  modelBaseUrl: string;
  modelName: string;
  modelKeySaved: boolean;
  quietHours: boolean;
  quietStart: string;
  quietEnd: string;
  mobileEnabled: boolean;
  wpsSyncDir: string | null;
  wpsSyncWorkspaces: string[];
}

export interface BootstrapData {
  workspaces: Workspace[];
  favoriteCategories: FavoriteCategory[];
  favorites: FavoriteLink[];
  tasks: PlanTask[];
  settings: AppSettings;
  connectors: ConnectorStatus[];
  recentFiles: FileEntry[];
  passwords: PasswordEntry[];
  allTags: string[];
}

export interface PasswordEntry {
  id: string;
  title: string;
  url: string;
  username: string;
  notes: string;
  groupTag: string;
  createdAt: number;
  updatedAt: number;
}

export interface OperationResult {
  success: boolean;
  message: string;
  affected: string[];
  skipped: string[];
}

export interface OcrResult {
  relativePath: string;
  text: string;
  confidence: number;
  pages: number;
  languages: string[];
  cached: boolean;
}
