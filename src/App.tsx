import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  Archive,
  Bell,
  Bot,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Cloud,
  Copy,
  Database,
  File,
  FileImage,
  FilePenLine,
  FileSearch,
  FileSpreadsheet,
  FileText,
  CheckSquare,
  Dices,
  ExternalLink,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  FolderPlus,
  Heart,
  Home,
  Import,
  KeyRound,
  LayoutGrid,
  List,
  LoaderCircle,
  Menu,
  MinusSquare,
  MonitorSmartphone,
  Moon,
  Move,
  PanelRight,
  Plus,
  RefreshCw,
  ScanText,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Square,
  Star,
  StarOff,
  Sun,
  Tag,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { api, isTauri } from "./lib/bridge";
import { localOcr } from "./lib/ocr";
import type {
  AppSettings,
  BootstrapData,
  FileEntry,
  OcrResult,
  PasswordEntry,
  PlanScope,
  PlanTask,
  TaskPriority,
  ViewId,
  Workspace,
} from "./types";
import "./App.css";

const dayKey = (date = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
const today = () => dayKey();
const dateTime = (time: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
const bytes = (size: number) => {
  if (!size) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
  return `${(size / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
const tagHue = (tag: string) =>
  [...tag].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 360, 7);
const tagStyle = (tag: string) => {
  const hue = tagHue(tag);
  return {
    background: `hsl(${hue} 72% 90%)`,
    color: `hsl(${hue} 55% 30%)`,
  } as React.CSSProperties;
};
const message = (error: unknown) =>
  typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "操作未完成，请重试";
const Icon = ({
  file,
  size = 19,
}: {
  file: Pick<FileEntry, "isDirectory" | "extension">;
  size?: number;
}) =>
  file.isDirectory ? (
    <Folder size={size} />
  ) : ["png", "jpg", "jpeg", "webp", "tif", "tiff"].includes(file.extension) ? (
    <FileImage size={size} />
  ) : ["xlsx", "xls", "csv"].includes(file.extension) ? (
    <FileSpreadsheet size={size} />
  ) : ["doc", "docx", "pdf", "txt", "md", "wps"].includes(file.extension) ? (
    <FileText size={size} />
  ) : (
    <File size={size} />
  );

type Dialog =
  | { type: "name"; kind: "workspace" | "folder" | "rename"; entry?: FileEntry }
  | { type: "destination"; mode: "copy" | "move" }
  | { type: "delete" }
  | { type: "delete-workspace"; workspace: Workspace }
  | { type: "favorite"; entry?: FileEntry }
  | {
      type: "task";
      task?: PlanTask;
      defaults?: { planScope: PlanScope; dueDate: string };
    }
  | { type: "ocr"; entry: FileEntry }
  | { type: "password"; entry?: PasswordEntry }
  | { type: "password-delete"; entry: PasswordEntry }
  | { type: "tag"; paths: string[] }
  | null;

function Modal({
  title,
  text,
  children,
  close,
  wide,
}: {
  title: string;
  text?: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === "Escape" && close();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [close]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
      >
        <button className="icon-button modal-close" onClick={close}>
          <X />
        </button>
        <div className="modal-heading">
          <h2>{title}</h2>
          {text && <p>{text}</p>}
        </div>
        {children}
      </section>
    </div>
  );
}

function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

export default function App() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [view, setView] = useState<ViewId>("home");
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [grid, setGrid] = useState(false);
  const [details, setDetails] = useState(true);
  const [sidebar, setSidebar] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const autoOcrRunning = useRef(false);
  const tell = useCallback((text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast(null), 3200);
  }, []);
  const refresh = useCallback(async () => {
    const next = await api.bootstrap();
    setData(next);
    return next;
  }, []);
  useEffect(() => {
    refresh()
      .catch((e) => tell(message(e), true))
      .finally(() => setLoading(false));
  }, [refresh, tell]);
  useEffect(() => {
    document.documentElement.dataset.theme = data?.settings.theme ?? "light";
  }, [data?.settings.theme]);
  const load = useCallback(
    async (next: string) => {
      setLoading(true);
      try {
        setFiles(await api.listDirectory(next));
        setPath(next);
        setSelected(new Set());
      } catch (e) {
        tell(message(e), true);
      } finally {
        setLoading(false);
      }
    },
    [tell],
  );
  const workspace = (next: string) => {
    setView("workspace");
    setSidebar(false);
    void load(next);
  };
  useEffect(() => {
    if (!isTauri()) return;
    let timer: number | undefined;
    let unlisten: (() => void) | undefined;
    void listen("filesystem-changed", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void refresh();
        if (path) void load(path);
      }, 450);
    }).then((stop) => {
      unlisten = stop;
    });
    return () => {
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [load, path, refresh]);
  useEffect(() => {
    if (!isTauri() || view !== "workspace" || !path) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over")
          setDragging(true);
        if (event.payload.type === "leave") setDragging(false);
        if (event.payload.type === "drop") {
          setDragging(false);
          const dropped = event.payload.paths;
          if (!dropped.length) return;
          setBusy(true);
          void api
            .importFiles(dropped, path, "copy")
            .then(async (result) => {
              await refresh();
              await load(path);
              tell(result.message);
            })
            .catch((error) => tell(message(error), true))
            .finally(() => setBusy(false));
        }
      })
      .then((stop) => {
        unlisten = stop;
      });
    return () => {
      setDragging(false);
      unlisten?.();
    };
  }, [load, path, refresh, tell, view]);
  useEffect(() => {
    if (!query.trim()) return setResults([]);
    const timer = setTimeout(
      () =>
        api
          .search(query)
          .then(setResults)
          .catch(() => setResults([])),
      250,
    );
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Delete" && selected.size && !dialog)
        setDialog({ type: "delete" });
    };
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, [dialog, selected.size]);
  useEffect(() => {
    if (!data?.settings.notifications || !isTauri()) return;
    const run = async () => {
      const now = new Date();
      const time = now.toTimeString().slice(0, 5);
      const quiet =
        data.settings.quietHours &&
        (data.settings.quietStart <= data.settings.quietEnd
          ? time >= data.settings.quietStart && time < data.settings.quietEnd
          : time >= data.settings.quietStart || time < data.settings.quietEnd);
      if (quiet) return;
      for (const task of data.tasks.filter(
        (t) =>
          !t.completed &&
          t.dueDate === today() &&
          t.remindAt &&
          t.remindAt <= time,
      )) {
        const key = `archive-reminder-${task.id}-${task.dueDate}-${task.remindAt}`;
        if (localStorage.getItem(key)) continue;
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted) {
          sendNotification({
            title: "归档助手 · 今日计划",
            body: `${task.remindAt} · ${task.title}`,
          });
          localStorage.setItem(key, "1");
        }
      }
    };
    void run();
    const id = setInterval(run, 30_000);
    return () => clearInterval(id);
  }, [data?.settings, data?.tasks]);
  useEffect(() => {
    const enabled = data?.settings.ocrAutoWorkspaces ?? [];
    if (!isTauri() || !enabled.length || autoOcrRunning.current) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      autoOcrRunning.current = true;
      void api
        .ocrCandidates(enabled)
        .then(async (candidates) => {
          let completed = 0;
          for (const file of candidates) {
            if (cancelled) break;
            try {
              await localOcr.recognize(file.relativePath, () => {});
              completed += 1;
            } catch {
              /* 单个文件失败不阻塞队列 */
            }
          }
          if (!cancelled && completed) {
            await refresh();
            tell(`已自动识别 ${completed} 个文件`);
          }
        })
        .finally(() => {
          autoOcrRunning.current = false;
        });
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [data?.recentFiles, data?.settings.ocrAutoWorkspaces, refresh, tell]);
  const chosen = files.filter((file) => selected.has(file.relativePath));
  const one = chosen.length === 1 ? chosen[0] : null;
  const todayTasks = useMemo(
    () => data?.tasks.filter((task) => task.dueDate === today()) ?? [],
    [data?.tasks],
  );
  const action = async (
    fn: () => Promise<unknown>,
    fallback = "操作已完成",
  ) => {
    setBusy(true);
    try {
      const value = await fn();
      await refresh();
      if (path) await load(path);
      tell((value as { message?: string })?.message ?? fallback);
      setDialog(null);
    } catch (e) {
      tell(message(e), true);
    } finally {
      setBusy(false);
    }
  };
  const openFile = async (file: FileEntry) => {
    if (file.isDirectory) return load(file.relativePath);
    if (!isTauri()) return tell("请在桌面应用中打开本机文件");
    try {
      await api.openFile(file.relativePath);
    } catch (error) {
      tell(message(error), true);
    }
  };
  const openFileWith = async (file: FileEntry) => {
    if (!isTauri()) return tell("请在桌面应用中选择打开方式", true);
    try {
      await api.openFileWith(file.relativePath);
    } catch (error) {
      tell(message(error), true);
    }
  };
  const importFiles = async () => {
    if (!isTauri()) return tell("请在桌面应用中选择本机文件", true);
    const picked = await open({ multiple: true });
    if (picked?.length)
      await action(() => api.importFiles(picked, path, "copy"));
  };
  const suggested = async () => {
    setBusy(true);
    try {
      for (const name of ["数据工作", "技术工作", "日常工作"])
        if (!data?.workspaces.some((w) => w.name === name))
          await api.createWorkspace(name);
      await refresh();
      tell("建议工作区已创建");
    } catch (e) {
      tell(message(e), true);
    } finally {
      setBusy(false);
    }
  };
  const toggleTask = async (task: PlanTask) =>
    action(async () => {
      const done = !task.completed;
      await api.saveTask({
        ...task,
        completed: done,
        completedAt: done ? Date.now() : undefined,
      });
      if (done && task.repeatRule !== "none") {
        const next = new Date(`${task.dueDate}T12:00:00`);
        if (task.repeatRule === "weekly") next.setDate(next.getDate() + 7);
        else
          do next.setDate(next.getDate() + 1);
          while (
            task.repeatRule === "weekdays" &&
            [0, 6].includes(next.getDay())
          );
        await api.saveTask({
          ...task,
          id: undefined,
          dueDate: dayKey(next),
          completed: false,
          completedAt: undefined,
          createdAt: Date.now(),
        });
      }
    }, "计划已更新");
  const postponeTask = async (task: PlanTask) => {
    const next = new Date(Date.now() + 10 * 60_000);
    const remindAt = `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
    await action(
      () => api.saveTask({ ...task, dueDate: dayKey(next), remindAt }),
      "提醒已延后 10 分钟",
    );
  };
  const removeWorkspace = async (workspace: Workspace) => {
    setBusy(true);
    try {
      const next = await api.deleteWorkspace(workspace.relativePath);
      setData(next);
      setView("home");
      setPath("");
      setFiles([]);
      setSelected(new Set());
      setDialog(null);
      tell(`“${workspace.name}”已移入 Windows 回收站`);
    } catch (error) {
      tell(message(error), true);
    } finally {
      setBusy(false);
    }
  };
  const savePassword = (entry: {
    id?: string;
    title: string;
    url?: string;
    username?: string;
    password?: string;
    notes?: string;
    groupTag?: string;
  }) => action(() => api.savePasswordEntry(entry), "密码已加密保存");
  const deletePassword = (id: string) =>
    action(() => api.deletePasswordEntry(id), "密码条目已删除");
  const copyPassword = async (entry: PasswordEntry) => {
    if (!isTauri()) return tell("请在桌面应用中查看密码", true);
    try {
      const plain = await api.revealPassword(entry.id);
      if (!plain) return tell("该条目没有保存密码", true);
      await navigator.clipboard.writeText(plain);
      tell("密码已复制到剪贴板");
    } catch (error) {
      tell(message(error), true);
    }
  };
  const copyUsername = async (entry: PasswordEntry) => {
    if (!entry.username) return tell("该条目没有保存账号", true);
    await navigator.clipboard.writeText(entry.username);
    tell("账号已复制到剪贴板");
  };
  const [revealedPasswords, setRevealedPasswords] = useState<
    Record<string, string>
  >({});
  const reveal = async (entry: PasswordEntry) => {
    if (revealedPasswords[entry.id] !== undefined) {
      setRevealedPasswords((old) => {
        const { [entry.id]: _omit, ...rest } = old;
        return rest;
      });
      return;
    }
    if (!isTauri()) return tell("请在桌面应用中查看密码", true);
    try {
      const plain = await api.revealPassword(entry.id);
      setRevealedPasswords((old) => ({ ...old, [entry.id]: plain }));
    } catch (error) {
      tell(message(error), true);
    }
  };
  if (loading && !data)
    return (
      <div className="splash">
        <div className="brand-mark">
          <Archive />
        </div>
        <h1>归档助手</h1>
        <span>正在整理你的工作空间</span>
        <LoaderCircle className="spin" />
      </div>
    );
  if (!data)
    return (
      <div className="fatal">
        <Archive />
        <h1>归档助手暂时无法启动</h1>
        <button onClick={() => location.reload()}>重新尝试</button>
      </div>
    );
  const nav: { id: ViewId; label: string; icon: ReactNode }[] = [
    { id: "home", label: "总览", icon: <Home /> },
    { id: "favorites", label: "收藏", icon: <Star /> },
    { id: "planner", label: "计划", icon: <ClipboardList /> },
    { id: "passwords", label: "密码本", icon: <KeyRound /> },
    { id: "smart", label: "智能中心", icon: <Sparkles /> },
  ];
  return (
    <div className="app-shell">
      <datalist id="archive-all-tags">
        {data.allTags.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <datalist id="password-group-suggestions">
        {[...new Set(data.passwords.map((p) => p.groupTag).filter(Boolean))].map(
          (g) => (
            <option key={g} value={g} />
          ),
        )}
      </datalist>
      {dragging && (
        <div className="drop-overlay">
          <Import />
          <strong>松开即可导入到“{path.split("\\").slice(-1)[0]}”</strong>
          <span>原文件会保留，归档助手将复制一份</span>
        </div>
      )}
      <aside className={`sidebar ${sidebar ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <Archive />
          </div>
          <div>
            <strong>归档助手</strong>
            <span>LOCAL WORKSPACE</span>
          </div>
        </div>
        <nav className="main-nav">
          {nav.map((n) => (
            <button
              className={view === n.id ? "active" : ""}
              key={n.id}
              onClick={() => {
                setView(n.id);
                setSidebar(false);
              }}
            >
              <span>{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="nav-section-heading">
          <span>工作区</span>
          <button
            onClick={() => setDialog({ type: "name", kind: "workspace" })}
          >
            <Plus />
          </button>
        </div>
        <div className="workspace-nav">
          {data.workspaces.map((w, i) => (
            <button
              key={w.id}
              className={
                view === "workspace" && path.split("\\")[0] === w.relativePath
                  ? "active"
                  : ""
              }
              onClick={() => workspace(w.relativePath)}
            >
              <i
                style={
                  {
                    "--workspace-color": [
                      "#315bdb",
                      "#19806a",
                      "#b7791f",
                      "#a14f7a",
                    ][i % 4],
                  } as React.CSSProperties
                }
              />
              <span>{w.name}</span>
              <small>{w.itemCount}</small>
            </button>
          ))}
          {!data.workspaces.length && (
            <button
              className="muted-nav"
              onClick={() => setDialog({ type: "name", kind: "workspace" })}
            >
              <FolderPlus />
              创建第一个工作区
            </button>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => setView("settings")}
          >
            <Settings />
            设置
          </button>
          <div className="local-status">
            <span />
            <div>
              <strong>本地安全存储</strong>
              <small>D:\自动归档</small>
            </div>
          </div>
        </div>
      </aside>
      {sidebar && (
        <button className="sidebar-scrim" onClick={() => setSidebar(false)} />
      )}
      <main className="main-stage">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setSidebar(true)}
          >
            <Menu />
          </button>
          <div className="global-search">
            <Search />
            <input
              ref={searchRef}
              placeholder="搜索文件名或 OCR 识别内容…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>Ctrl K</kbd>
            {query && (
              <button onClick={() => setQuery("")}>
                <X />
              </button>
            )}
            {query && (
              <div className="search-popover">
                <div className="search-title">
                  <span>搜索结果</span>
                  <small>{results.length} 项</small>
                </div>
                {results.length ? (
                  results.map((file) => (
                    <button
                      key={file.relativePath}
                      onClick={() => {
                        const parent = file.relativePath
                          .split("\\")
                          .slice(0, -1)
                          .join("\\");
                        setQuery("");
                        workspace(
                          file.isDirectory ? file.relativePath : parent,
                        );
                      }}
                    >
                      <span className="file-icon">
                        <Icon file={file} />
                      </span>
                      <span>
                        <strong>{file.name}</strong>
                        <small>{file.relativePath}</small>
                      </span>
                      {file.ocrIndexed && <em>OCR</em>}
                    </button>
                  ))
                ) : (
                  <div className="search-empty">没有找到匹配内容</div>
                )}
              </div>
            )}
          </div>
          <div className="top-actions">
            <button className="connection-pill">
              <span />
              本机离线
            </button>
            <button className="icon-button">
              <Bell />
              {todayTasks.some((t) => !t.completed) && <i />}
            </button>
            <button className="avatar">B</button>
          </div>
        </header>
        <div className="content">
          {view === "home" && (
            <HomePage
              data={data}
              tasks={todayTasks}
              suggested={suggested}
              create={() => setDialog({ type: "name", kind: "workspace" })}
              open={workspace}
              planner={() => setView("planner")}
              busy={busy}
            />
          )}
          {view === "workspace" && (
            <FilesPage
              path={path}
              files={files}
              selected={selected}
              one={one}
              loading={loading}
              grid={grid}
              details={details}
              setGrid={setGrid}
              setDetails={setDetails}
              load={load}
              select={(file, add) =>
                setSelected((old) => {
                  if (add) {
                    const next = new Set(old);
                    next.has(file) ? next.delete(file) : next.add(file);
                    return next;
                  }
                  if (old.has(file)) {
                    const next = new Set(old);
                    next.delete(file);
                    return next;
                  }
                  return new Set([file]);
                })
              }
              clearSelection={() => setSelected(new Set())}
              open={openFile}
              openWith={openFileWith}
              importFiles={importFiles}
              dialog={setDialog}
              refresh={() => load(path)}
              removeWorkspace={(workspacePath) => {
                const item = data.workspaces.find(
                  (workspace) => workspace.relativePath === workspacePath,
                );
                if (item)
                  setDialog({ type: "delete-workspace", workspace: item });
              }}
              unfavorite={(entry) =>
                action(async () => {
                  const links = data.favorites.filter(
                    (f) => f.relativePath === entry.relativePath,
                  );
                  for (const f of links)
                    await api.toggleFavorite(
                      f.categoryId,
                      f.relativePath,
                      f.displayName,
                    );
                  return { message: "已取消收藏" };
                }, "已取消收藏")
              }
              toggleSelectAll={() =>
                setSelected((old) =>
                  files.length && old.size === files.length
                    ? new Set()
                    : new Set(files.map((f) => f.relativePath)),
                )
              }
              addTag={(entry, tag) =>
                action(
                  () => api.addFileTags([entry.relativePath], tag),
                  `已添加标签“${tag}”`,
                )
              }
              removeTag={(entry, tag) =>
                action(
                  () => api.removeFileTags([entry.relativePath], tag),
                  `已移除标签“${tag}”`,
                )
              }
            />
          )}
          {view === "favorites" && (
            <FavoritesPage
              data={data}
              open={(f) =>
                workspace(f.relativePath.split("\\").slice(0, -1).join("\\"))
              }
              openFile={(f) => {
                if (!isTauri())
                  return tell("请在桌面应用中打开本机文件", true);
                api
                  .openFile(f.relativePath)
                  .catch((error) => tell(message(error), true));
              }}
              unfavorite={(f) =>
                action(
                  () =>
                    api.toggleFavorite(
                      f.categoryId,
                      f.relativePath,
                      f.displayName,
                    ),
                  "已取消收藏",
                )
              }
              create={() => setDialog({ type: "favorite" })}
              drop={(categoryId, sourcePaths) =>
                action(() => api.addFavoritesFromPaths(categoryId, sourcePaths))
              }
            />
          )}
          {view === "passwords" && (
            <PasswordsPage
              data={data}
              busy={busy}
              create={() => setDialog({ type: "password" })}
              edit={(entry) => setDialog({ type: "password", entry })}
              remove={(entry) => setDialog({ type: "password-delete", entry })}
              copyPassword={copyPassword}
              copyUsername={copyUsername}
              reveal={reveal}
              revealed={revealedPasswords}
            />
          )}
          {view === "planner" && (
            <PlannerPage
              tasks={data.tasks}
              create={(planScope, dueDate) =>
                setDialog({ type: "task", defaults: { planScope, dueDate } })
              }
              toggle={toggleTask}
              snooze={postponeTask}
              edit={(task) => setDialog({ type: "task", task })}
              remove={(id) => action(() => api.deleteTask(id), "待办已删除")}
            />
          )}
          {view === "smart" && (
            <SmartPage
              data={data}
              files={() => {
                setView("workspace");
                tell("在工作区中选择图片或扫描 PDF，然后点击 OCR");
              }}
              settings={() => setView("settings")}
            />
          )}
          {view === "settings" && (
            <SettingsPage
              value={data.settings}
              data={data}
              save={(value, key) =>
                action(() => api.saveSettings(value, key), "设置已安全保存")
              }
              notify={tell}
            />
          )}
        </div>
      </main>
      {dialog?.type === "name" && (
        <NameDialog
          mode={dialog.kind}
          entry={dialog.entry}
          busy={busy}
          close={() => setDialog(null)}
          submit={(name) =>
            dialog.kind === "workspace"
              ? action(() => api.createWorkspace(name), "工作区已创建")
              : dialog.kind === "folder"
                ? action(() => api.createFolder(path, name), "子分区已创建")
                : action(() =>
                    api.renameEntry(dialog.entry!.relativePath, name),
                  )
          }
        />
      )}
      {dialog?.type === "destination" && (
        <Destination
          mode={dialog.mode}
          workspaces={data.workspaces}
          busy={busy}
          close={() => setDialog(null)}
          submit={(target) =>
            action(() =>
              api.transferEntries([...selected], target, dialog.mode),
            )
          }
        />
      )}
      {dialog?.type === "delete" && (
        <Modal
          title="移入 Windows 回收站"
          text={`即将处理 ${selected.size} 个项目，之后仍可恢复。`}
          close={() => setDialog(null)}
        >
          <div className="warning-panel">
            <Trash2 />
            <span>不会永久删除，也不会自动清空回收站。</span>
          </div>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDialog(null)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => action(() => api.deleteEntries([...selected]))}
            >
              移入回收站
            </button>
          </div>
        </Modal>
      )}
      {dialog?.type === "delete-workspace" && (
        <Modal
          title={`删除工作区“${dialog.workspace.name}”`}
          text={`${dialog.workspace.itemCount} 个文件和文件夹将一起进入 Windows 回收站。`}
          close={() => setDialog(null)}
        >
          <div className="warning-panel">
            <Trash2 />
            <span>收藏引用会保留并标记为失效，工作区可从回收站恢复。</span>
          </div>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDialog(null)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => removeWorkspace(dialog.workspace)}
            >
              移入回收站
            </button>
          </div>
        </Modal>
      )}
      {dialog?.type === "favorite" && (
        <FavoriteDialog
          entry={dialog.entry}
          data={data}
          busy={busy}
          close={() => setDialog(null)}
          toggle={(category, file) =>
            action(
              () => api.toggleFavorite(category, file.relativePath, file.name),
              "收藏已更新",
            )
          }
          create={(name, color) =>
            action(
              () => api.createFavoriteCategory(name, color),
              "收藏分区已创建",
            )
          }
        />
      )}
      {dialog?.type === "password" && (
        <PasswordDialog
          entry={dialog.entry}
          busy={busy}
          close={() => setDialog(null)}
          submit={savePassword}
        />
      )}
      {dialog?.type === "password-delete" && (
        <Modal
          title="删除密码条目"
          text={`确定删除“${dialog.entry.title}”吗？删除后无法恢复。`}
          close={() => setDialog(null)}
        >
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setDialog(null)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => deletePassword(dialog.entry.id)}
            >
              <Trash2 />
              删除
            </button>
          </div>
        </Modal>
      )}
      {dialog?.type === "tag" && (
        <TagDialog
          paths={dialog.paths}
          busy={busy}
          close={() => setDialog(null)}
          submit={(tag, mode) =>
            action(
              () =>
                mode === "add"
                  ? api.addFileTags(dialog.paths, tag)
                  : api.removeFileTags(dialog.paths, tag),
              mode === "add" ? `已添加标签“${tag}”` : `已移除标签“${tag}”`,
            )
          }
        />
      )}
      {dialog?.type === "task" && (
        <TaskDialog
          task={dialog.task}
          defaults={dialog.defaults}
          busy={busy}
          close={() => setDialog(null)}
          submit={(task) => action(() => api.saveTask(task), "计划已保存")}
        />
      )}
      {dialog?.type === "ocr" && (
        <OcrDialog
          file={dialog.entry}
          close={() => {
            setDialog(null);
            void refresh();
            if (path) void load(path);
          }}
        />
      )}
      {toast && (
        <div className={`toast ${toast.error ? "error" : "success"}`}>
          <span>{toast.error ? <X /> : <Check />}</span>
          {toast.text}
        </div>
      )}
    </div>
  );
}

function HomePage({
  data,
  tasks,
  suggested,
  create,
  open,
  planner,
  busy,
}: {
  data: BootstrapData;
  tasks: PlanTask[];
  suggested: () => void;
  create: () => void;
  open: (p: string) => void;
  planner: () => void;
  busy: boolean;
}) {
  const done = tasks.filter((t) => t.completed).length;
  const greeting =
    new Date().getHours() < 11
      ? "早上好"
      : new Date().getHours() < 18
        ? "下午好"
        : "晚上好";
  return (
    <div className="page home-page">
      <div className="hero-heading">
        <div>
          <span className="eyebrow">
            {new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(
              new Date(),
            )}
          </span>
          <h1>{greeting}，BEN</h1>
          <p>文件在它该在的位置，今天也从容一点。</p>
        </div>
        <button className="button primary" onClick={create}>
          <Plus />
          新建工作区
        </button>
      </div>
      <section className="home-grid">
        <article className="focus-card">
          <div className="focus-orbit">
            <div>
              <strong>
                {tasks.length ? Math.round((done / tasks.length) * 100) : 0}
                <sup>%</sup>
              </strong>
              <span>今日进度</span>
            </div>
          </div>
          <div className="focus-content">
            <span className="card-label">
              <CalendarDays />
              今日计划
            </span>
            <h2>
              {tasks.length
                ? `还有 ${tasks.length - done} 件事值得专注`
                : "今天还没有安排"}
            </h2>
            <p>
              {tasks.length
                ? "每完成一项，工作台都会安静一点。"
                : "写下第一件事，让今天有一个清晰的开始。"}
            </p>
            <button onClick={planner}>
              查看今日计划
              <ChevronRight />
            </button>
          </div>
        </article>
        <article className="metric-stack">
          <div>
            <span>工作区</span>
            <strong>{data.workspaces.length}</strong>
            <small>
              {data.workspaces.reduce((s, w) => s + w.itemCount, 0)}{" "}
              个文件与文件夹
            </small>
          </div>
          <div>
            <span>已收藏</span>
            <strong>{data.favorites.length}</strong>
            <small>{data.favoriteCategories.length} 个收藏分区</small>
          </div>
          <div>
            <span>智能索引</span>
            <strong>
              {data.recentFiles.filter((f) => f.ocrIndexed).length}
            </strong>
            <small>最近文件中的 OCR 结果</small>
          </div>
        </article>
      </section>
      <section className="section-block">
        <div className="section-title">
          <div>
            <span className="eyebrow">WORKSPACES</span>
            <h2>你的工作区</h2>
          </div>
          <button className="text-button" onClick={create}>
            <Plus />
            新增
          </button>
        </div>
        {data.workspaces.length ? (
          <div className="workspace-cards">
            {data.workspaces.map((w, i) => (
              <button
                className="workspace-card"
                key={w.id}
                onClick={() => open(w.relativePath)}
              >
                <div className={`folder-art tone-${i % 4}`}>
                  <Folder />
                </div>
                <div>
                  <strong>{w.name}</strong>
                  <span>
                    {w.itemCount} 项 · {bytes(w.size)}
                  </span>
                </div>
                <ChevronRight />
              </button>
            ))}
          </div>
        ) : (
          <div className="onboarding">
            <div className="onboarding-visual">
              <FolderOpen />
              <span />
              <span />
            </div>
            <div>
              <span className="eyebrow">从清晰开始</span>
              <h2>还没有工作区</h2>
              <p>
                工作区会直接成为 D
                盘里的真实文件夹。你可以自定义，也可以从建议结构开始。
              </p>
              <div className="button-row">
                <button
                  className="button primary"
                  onClick={suggested}
                  disabled={busy}
                >
                  {busy && <LoaderCircle className="spin" />}创建建议工作区
                </button>
                <button className="button secondary" onClick={create}>
                  自定义创建
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
      <section className="section-block">
        <div className="section-title">
          <div>
            <span className="eyebrow">RECENT</span>
            <h2>最近修改</h2>
          </div>
        </div>
        {data.recentFiles.length ? (
          <div className="recent-list">
            {data.recentFiles.slice(0, 6).map((f) => (
              <div key={f.relativePath}>
                <span className="file-icon">
                  <Icon file={f} />
                </span>
                <span>
                  <strong>{f.name}</strong>
                  <small>{f.relativePath}</small>
                </span>
                {f.ocrIndexed && <em>OCR</em>}
                <time>{dateTime(f.modifiedAt)}</time>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={<FileSearch />}
            title="这里会显示最近文件"
            text="把文件导入工作区后，最近修改会自动汇集在这里。"
          />
        )}
      </section>
    </div>
  );
}

function FilesPage({
  path,
  files,
  selected,
  one,
  loading,
  grid,
  details,
  setGrid,
  setDetails,
  load,
  select,
  clearSelection,
  open,
  openWith,
  importFiles,
  dialog,
  refresh,
  removeWorkspace,
  unfavorite,
  toggleSelectAll,
  addTag,
  removeTag,
}: {
  path: string;
  files: FileEntry[];
  selected: Set<string>;
  one: FileEntry | null;
  loading: boolean;
  grid: boolean;
  details: boolean;
  setGrid: (v: boolean) => void;
  setDetails: (v: boolean) => void;
  load: (p: string) => void;
  select: (p: string, add: boolean) => void;
  clearSelection: () => void;
  open: (f: FileEntry) => void;
  openWith: (f: FileEntry) => void;
  importFiles: () => void;
  dialog: (d: Dialog) => void;
  refresh: () => void;
  removeWorkspace: (path: string) => void;
  unfavorite: (entry: FileEntry) => void;
  toggleSelectAll: () => void;
  addTag: (entry: FileEntry, tag: string) => void;
  removeTag: (entry: FileEntry, tag: string) => void;
}) {
  const parts = path.split("\\").filter(Boolean);
  const ocr =
    one &&
    !one.isDirectory &&
    ["png", "jpg", "jpeg", "webp", "tif", "tiff", "pdf"].includes(
      one.extension,
    );
  const paths = [...selected];
  const allSelected = files.length > 0 && selected.size === files.length;
  const partialSelected = selected.size > 0 && !allSelected;
  return (
    <div className="page workspace-page">
      <div className="workspace-header">
        <div className="breadcrumbs">
          {parts.map((p, i) => (
            <span key={i}>
              <button onClick={() => load(parts.slice(0, i + 1).join("\\"))}>
                {p}
              </button>
              {i < parts.length - 1 && <ChevronRight />}
            </span>
          ))}
        </div>
        <div className="header-tools">
          {parts.length === 1 && (
            <button
              className="button workspace-delete"
              onClick={() => removeWorkspace(path)}
            >
              <Trash2 />
              删除工作区
            </button>
          )}
          <button
            className="button secondary"
            onClick={() => dialog({ type: "name", kind: "folder" })}
          >
            <FolderPlus />
            新建文件夹
          </button>
          <button className="button primary" onClick={importFiles}>
            <Import />
            导入文件
          </button>
        </div>
      </div>
      <div className="file-toolbar">
        <div>
          <button
            className={!grid ? "active" : ""}
            onClick={() => setGrid(false)}
          >
            <List />
          </button>
          <button
            className={grid ? "active" : ""}
            onClick={() => setGrid(true)}
          >
            <LayoutGrid />
          </button>
          <i />
          <button
            className={`select-all${allSelected ? " checked" : partialSelected ? " partial" : ""}`}
            onClick={toggleSelectAll}
            title={
              allSelected ? "取消全选" : partialSelected ? "取消全选" : "全选"
            }
            aria-label={allSelected ? "取消全选" : "全选"}
          >
            {allSelected ? (
              <CheckSquare />
            ) : partialSelected ? (
              <MinusSquare />
            ) : (
              <Square />
            )}
            {allSelected || partialSelected ? "取消全选" : "全选"}
          </button>
          <span>
            {files.length} 项
            {selected.size ? ` · 已选择 ${selected.size} 项` : ""}
          </span>
        </div>
        <div>
          {selected.size > 0 && (
            <>
              <button
                onClick={() => dialog({ type: "destination", mode: "move" })}
              >
                <Move />
                移动
              </button>
              <button
                onClick={() => dialog({ type: "destination", mode: "copy" })}
              >
                <Copy />
                复制
              </button>
              {one && (
                <button
                  onClick={() =>
                    dialog({ type: "name", kind: "rename", entry: one })
                  }
                >
                  <FilePenLine />
                  改名
                </button>
              )}
              <button onClick={() => dialog({ type: "tag", paths })}>
                <Tag />
                标签
              </button>
              <button
                className="danger-text"
                onClick={() => dialog({ type: "delete" })}
              >
                <Trash2 />
                删除
              </button>
            </>
          )}
          <button onClick={refresh}>
            <RefreshCw />
          </button>
          <button
            className={details ? "active" : ""}
            onClick={() => setDetails(!details)}
          >
            <PanelRight />
          </button>
        </div>
      </div>
      <div className={`file-layout ${details && one ? "with-details" : ""}`}>
        <section
          className={grid ? "file-grid" : "file-table"}
          onClick={(event) => {
            if (
              !(event.target as HTMLElement).closest(
                ".file-row, .file-tile, button",
              )
            )
              clearSelection();
          }}
        >
          {loading ? (
            <div className="loading-block">
              <LoaderCircle className="spin" />
              正在读取真实文件夹
            </div>
          ) : files.length ? (
            files.map((file) =>
              grid ? (
                <button
                  className={`file-tile ${selected.has(file.relativePath) ? "selected" : ""}`}
                  key={file.relativePath}
                  onClick={(e) => select(file.relativePath, e.ctrlKey)}
                  onDoubleClick={() => open(file)}
                  title={file.isDirectory ? "双击进入文件夹" : "双击打开文件"}
                >
                  <span className="tile-icon">
                    <Icon file={file} size={34} />
                  </span>
                  <strong>{file.name}</strong>
                  <small>
                    {file.isDirectory ? "文件夹" : bytes(file.size)}
                  </small>
                  {file.tags.length > 0 && (
                    <span className="tile-tags">
                      {file.tags.slice(0, 2).map((t) => (
                        <em key={t} className="tag-chip" style={tagStyle(t)}>
                          {t}
                        </em>
                      ))}
                      {file.tags.length > 2 && (
                        <em className="tag-chip tag-more">
                          +{file.tags.length - 2}
                        </em>
                      )}
                    </span>
                  )}
                  {file.favorite && (
                    <span className="favorite-tile-tag">
                      <Heart />
                      已收藏
                    </span>
                  )}
                </button>
              ) : (
                <div
                  className={`file-row ${selected.has(file.relativePath) ? "selected" : ""}`}
                  key={file.relativePath}
                  onClick={(e) => select(file.relativePath, e.ctrlKey)}
                  onDoubleClick={() => open(file)}
                  title={file.isDirectory ? "双击进入文件夹" : "双击打开文件"}
                >
                  <button
                    type="button"
                    className="checkbox"
                    aria-label={
                      selected.has(file.relativePath) ? "取消选择" : "选择文件"
                    }
                    aria-pressed={selected.has(file.relativePath)}
                    onClick={(event) => {
                      event.stopPropagation();
                      select(file.relativePath, true);
                    }}
                  >
                    {selected.has(file.relativePath) && <Check />}
                  </button>
                  <span className="file-icon">
                    <Icon file={file} />
                  </span>
                  <span className="file-name">
                    <strong>{file.name}</strong>
                    {file.ocrIndexed && <em>OCR</em>}
                    {file.favorite && (
                      <em className="favorite-tag">
                        <Heart />
                        已收藏
                      </em>
                    )}
                    {file.tags.map((t) => (
                      <em key={t} className="tag-chip" style={tagStyle(t)}>
                        {t}
                      </em>
                    ))}
                  </span>
                  <span className="file-type">
                    {file.isDirectory
                      ? "文件夹"
                      : file.extension.toUpperCase() || "文件"}
                  </span>
                  <span className="file-size">
                    {file.isDirectory ? "—" : bytes(file.size)}
                  </span>
                  <time>{dateTime(file.modifiedAt)}</time>
                </div>
              ),
            )
          ) : (
            <Empty
              icon={<FolderOpen />}
              title="这个分区还是空的"
              text="导入文件，或创建一个子分区开始整理。"
              action={
                <button className="button primary" onClick={importFiles}>
                  <Import />
                  导入文件
                </button>
              }
            />
          )}
        </section>
        {details && one && (
          <aside className="details-panel">
            <button
              className="detail-close"
              title="关闭详细信息"
              onClick={clearSelection}
            >
              <X />
            </button>
            <div className="detail-preview">
              {["png", "jpg", "jpeg", "webp"].includes(one.extension) &&
              isTauri() ? (
                <img src={convertFileSrc(one.absolutePath)} />
              ) : (
                <span>
                  <Icon file={one} size={56} />
                </span>
              )}
            </div>
            <h3>{one.name}</h3>
            <p>{one.relativePath}</p>
            <TagEditor
              tags={one.tags}
              onAdd={(tag) => addTag(one, tag)}
              onRemove={(tag) => removeTag(one, tag)}
            />
            <dl>
              <div>
                <dt>类型</dt>
                <dd>
                  {one.isDirectory
                    ? "文件夹"
                    : one.extension.toUpperCase() || "文件"}
                </dd>
              </div>
              <div>
                <dt>大小</dt>
                <dd>{one.isDirectory ? "—" : bytes(one.size)}</dd>
              </div>
              <div>
                <dt>修改时间</dt>
                <dd>{dateTime(one.modifiedAt)}</dd>
              </div>
              <div>
                <dt>文字索引</dt>
                <dd>{one.ocrIndexed ? "已建立" : "未建立"}</dd>
              </div>
            </dl>
            <div className="detail-actions">
              <button onClick={() => open(one)}>
                <FolderOpen />
                默认程序打开
              </button>
              {!one.isDirectory && (
                <button onClick={() => openWith(one)}>
                  <ExternalLink />
                  选择打开方式
                </button>
              )}
              {one.favorite ? (
                <button onClick={() => unfavorite(one)}>
                  <Star />
                  取消收藏
                </button>
              ) : (
                <button onClick={() => dialog({ type: "favorite", entry: one })}>
                  <Star />
                  加入收藏
                </button>
              )}
              {ocr && (
                <button onClick={() => dialog({ type: "ocr", entry: one })}>
                  <ScanText />
                  离线 OCR
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function TagEditor({
  tags,
  onAdd,
  onRemove,
}: {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const tag = value.trim();
    setValue("");
    if (!tag || tags.includes(tag)) return;
    onAdd(tag);
  };
  return (
    <div className="tag-editor">
      <span className="tag-editor-label">
        <Tag />
        标签
      </span>
      <div className="tag-chips">
        {tags.map((t) => (
          <span key={t} className="tag-chip" style={tagStyle(t)}>
            {t}
            <button
              type="button"
              aria-label={`删除标签 ${t}`}
              onClick={() => onRemove(t)}
            >
              <X />
            </button>
          </span>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            list="archive-all-tags"
            value={value}
            placeholder="添加标签"
            onChange={(e) => setValue(e.target.value)}
          />
        </form>
      </div>
    </div>
  );
}

function PasswordsPage({
  data,
  busy,
  create,
  edit,
  remove,
  copyPassword,
  copyUsername,
  reveal,
  revealed,
}: {
  data: BootstrapData;
  busy: boolean;
  create: () => void;
  edit: (entry: PasswordEntry) => void;
  remove: (entry: PasswordEntry) => void;
  copyPassword: (entry: PasswordEntry) => void;
  copyUsername: (entry: PasswordEntry) => void;
  reveal: (entry: PasswordEntry) => void;
  revealed: Record<string, string>;
}) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const q = query.trim().toLowerCase();
  const groups = [
    ...new Set(data.passwords.map((p) => p.groupTag).filter(Boolean)),
  ];
  const items = data.passwords.filter(
    (p) =>
      (!group || p.groupTag === group) &&
      (!q ||
        [p.title, p.url, p.username, p.notes, p.groupTag].some((field) =>
          field.toLowerCase().includes(q),
        )),
  );
  return (
    <div className="page">
      <Heading
        eyebrow="PASSWORDS"
        title="密码本"
        text="常用网站的账号密码，AES-256 加密后只存放在本机。"
        action={
          <button className="button primary" onClick={create}>
            <Plus />
            新增密码
          </button>
        }
      />
      <div className="password-tools">
        <div className="password-search">
          <Search />
          <input
            value={query}
            placeholder="搜索标题、网站、账号或备注"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {groups.length > 0 && (
          <div className="password-groups">
            <button className={!group ? "active" : ""} onClick={() => setGroup("")}>
              全部
            </button>
            {groups.map((g) => (
              <button
                key={g}
                className={group === g ? "active" : ""}
                onClick={() => setGroup(g)}
              >
                {g}
              </button>
            ))}
          </div>
        )}
      </div>
      {items.length ? (
        <div className="password-list">
          {items.map((p) => (
            <div className="password-card" key={p.id}>
              <span className="password-avatar" style={tagStyle(p.title)}>
                {p.title.slice(0, 1).toUpperCase()}
              </span>
              <div className="password-info">
                <strong>
                  {p.title}
                  {p.groupTag && (
                    <em className="tag-chip" style={tagStyle(p.groupTag)}>
                      {p.groupTag}
                    </em>
                  )}
                </strong>
                <small>{p.url || "未填写网址"}</small>
                <small>{p.username || "未填写账号"}</small>
                <div className="password-secret">
                  {revealed[p.id] !== undefined ? (
                    <>
                      <span>{revealed[p.id] || "（未设置密码）"}</span>
                      <button
                        type="button"
                        aria-label="隐藏密码"
                        onClick={() => reveal(p)}
                      >
                        <EyeOff />
                      </button>
                    </>
                  ) : (
                    <>
                      <span>••••••••</span>
                      <button
                        type="button"
                        aria-label="显示密码"
                        onClick={() => reveal(p)}
                      >
                        <Eye />
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="password-actions">
                <button onClick={() => copyUsername(p)}>
                  <Copy />
                  账号
                </button>
                <button onClick={() => copyPassword(p)}>
                  <KeyRound />
                  密码
                </button>
                <button disabled={busy} onClick={() => edit(p)}>
                  <FilePenLine />
                  编辑
                </button>
                <button
                  className="danger-text"
                  disabled={busy}
                  onClick={() => remove(p)}
                >
                  <Trash2 />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty
          icon={<KeyRound />}
          title={q || group ? "没有匹配的密码条目" : "密码本还是空的"}
          text={
            q || group
              ? "换个关键词或分组试试。"
              : "新增常用网站的账号密码，全部加密保存在本机。"
          }
          action={
            !q && !group ? (
              <button className="button primary" onClick={create}>
                <Plus />
                新增密码
              </button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

const GENERATOR_BASE = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function PasswordDialog({
  entry,
  busy,
  close,
  submit,
}: {
  entry?: PasswordEntry;
  busy: boolean;
  close: () => void;
  submit: (entry: {
    id?: string;
    title: string;
    url?: string;
    username?: string;
    password?: string;
    notes?: string;
    groupTag?: string;
  }) => void;
}) {
  const [form, setForm] = useState({
    title: entry?.title ?? "",
    url: entry?.url ?? "",
    username: entry?.username ?? "",
    password: "",
    notes: entry?.notes ?? "",
    groupTag: entry?.groupTag ?? "",
  });
  const [show, setShow] = useState(false);
  const [length, setLength] = useState(16);
  const [symbols, setSymbols] = useState(true);
  const generate = () => {
    const chars = GENERATOR_BASE + (symbols ? "!@#$%^&*-_+=?" : "");
    const random = crypto.getRandomValues(new Uint32Array(length));
    const password = [...random]
      .map((n) => chars[n % chars.length])
      .join("");
    setForm((f) => ({ ...f, password }));
    setShow(true);
  };
  return (
    <Modal
      title={entry ? "编辑密码条目" : "新增密码条目"}
      text="密码使用 AES-256-GCM 加密后存入本机数据库，密钥保存在 Windows 凭据管理器。"
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit({
            id: entry?.id,
            title: form.title.trim(),
            url: form.url.trim(),
            username: form.username.trim(),
            password: form.password || undefined,
            notes: form.notes,
            groupTag: form.groupTag.trim(),
          });
        }}
      >
        <label className="field">
          <span>标题</span>
          <input
            autoFocus
            required
            value={form.title}
            placeholder="如：公司邮箱"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </label>
        <label className="field">
          <span>网站</span>
          <input
            value={form.url}
            placeholder="https://example.com"
            onChange={(e) => setForm({ ...form, url: e.target.value })}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>账号</span>
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </label>
          <label className="field">
            <span>分组</span>
            <input
              value={form.groupTag}
              list="password-group-suggestions"
              placeholder="如：工作"
              onChange={(e) => setForm({ ...form, groupTag: e.target.value })}
            />
          </label>
        </div>
        <label className="field">
          <span>{entry ? "密码（留空保持不变）" : "密码"}</span>
          <div className="password-input">
            <input
              type={show ? "text" : "password"}
              value={form.password}
              placeholder={entry ? "留空则保持原密码" : "输入或一键生成"}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <button
              type="button"
              aria-label={show ? "隐藏密码" : "显示密码"}
              onClick={() => setShow(!show)}
            >
              {show ? <EyeOff /> : <Eye />}
            </button>
            <button type="button" aria-label="生成密码" onClick={generate}>
              <Dices />
            </button>
          </div>
        </label>
        <div className="generator-row">
          <label className="field">
            <span>生成长度：{length}</span>
            <input
              type="range"
              min={8}
              max={64}
              value={length}
              onChange={(e) => setLength(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className={`generator-symbols ${symbols ? "on" : ""}`}
            onClick={() => setSymbols(!symbols)}
          >
            {symbols ? "含符号" : "不含符号"}
          </button>
        </div>
        <label className="field">
          <span>备注</span>
          <textarea
            rows={2}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </label>
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={close}
          >
            取消
          </button>
          <button className="button primary" disabled={busy || !form.title.trim()}>
            {entry ? "保存修改" : "加密保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TagDialog({
  paths,
  busy,
  close,
  submit,
}: {
  paths: string[];
  busy: boolean;
  close: () => void;
  submit: (tag: string, mode: "add" | "remove") => void;
}) {
  const [tag, setTag] = useState("");
  const valid = tag.trim().length > 0;
  return (
    <Modal
      title="文件标签"
      text={`对已选中的 ${paths.length} 个项目添加或移除同一个标签。`}
      close={close}
    >
      <form onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          <span>标签</span>
          <input
            autoFocus
            list="archive-all-tags"
            value={tag}
            placeholder="如：重要"
            onChange={(e) => setTag(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            取消
          </button>
          <button
            className="button secondary"
            disabled={busy || !valid}
            onClick={() => submit(tag.trim(), "remove")}
          >
            从所选移除
          </button>
          <button
            className="button primary"
            disabled={busy || !valid}
            onClick={() => submit(tag.trim(), "add")}
          >
            添加到所选
          </button>
        </div>
      </form>
    </Modal>
  );
}

function FavoritesPage({
  data,
  open,
  openFile,
  unfavorite,
  create,
  drop,
}: {
  data: BootstrapData;
  open: (f: BootstrapData["favorites"][number]) => void;
  openFile: (f: BootstrapData["favorites"][number]) => void;
  unfavorite: (f: BootstrapData["favorites"][number]) => void;
  create: () => void;
  drop: (categoryId: string, sourcePaths: string[]) => void;
}) {
  const [category, setCategory] = useState(
    data.favoriteCategories[0]?.id ?? "",
  );
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    if (!isTauri() || !category) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDropping(true);
        } else if (event.payload.type === "leave") {
          setDropping(false);
        } else if (event.payload.type === "drop") {
          setDropping(false);
          if (event.payload.paths.length) drop(category, event.payload.paths);
        }
      })
      .then((stop) => {
        unlisten = stop;
      });
    return () => {
      setDropping(false);
      unlisten?.();
    };
  }, [category, drop]);
  const items = data.favorites.filter((f) => f.categoryId === category);
  return (
    <div className="page">
      <Heading
        eyebrow="FAVORITES"
        title="收藏"
        text="同一份文件，多一种找到它的方式。"
        action={
          <button className="button secondary" onClick={create}>
            <Plus />
            新建分区
          </button>
        }
      />
      <div className="favorite-layout">
        <aside className="category-list">
          {data.favoriteCategories.map((c) => (
            <button
              className={c.id === category ? "active" : ""}
              key={c.id}
              onClick={() => setCategory(c.id)}
            >
              <i style={{ background: c.color }} />
              <span>{c.name}</span>
              <small>{c.count}</small>
            </button>
          ))}
        </aside>
        <section className={`favorite-content ${dropping ? "drop-ready" : ""}`}>
          {dropping && (
            <div className="favorite-drop-hint">
              <Star />
              <strong>松开即可加入当前收藏分区</strong>
              <span>外部文件会先复制到“收藏导入”工作区</span>
            </div>
          )}
          <div className="favorite-title">
            <h2>
              {data.favoriteCategories.find((c) => c.id === category)?.name}
            </h2>
            <span>{items.length} 个快捷收藏</span>
          </div>
          {items.length ? (
            <div className="favorite-grid">
              {items.map((f) => (
                <div
                  className={`favorite-card ${f.missing ? "missing" : ""}`}
                  key={f.id}
                  onClick={() => openFile(f)}
                  title={f.missing ? "原文件位置失效" : "单击打开文件"}
                >
                  {!f.missing && (
                    <span className="favorite-card-actions">
                      <button
                        type="button"
                        aria-label="定位到实际工作区"
                        title="定位到实际工作区"
                        onClick={(e) => {
                          e.stopPropagation();
                          open(f);
                        }}
                      >
                        <FolderOpen />
                      </button>
                      <button
                        type="button"
                        aria-label="取消收藏"
                        title="取消收藏"
                        onClick={(e) => {
                          e.stopPropagation();
                          unfavorite(f);
                        }}
                      >
                        <StarOff />
                      </button>
                    </span>
                  )}
                  <span className="file-icon">
                    <FileText />
                  </span>
                  <strong>{f.displayName}</strong>
                  <small>{f.missing ? "原文件位置失效" : f.relativePath}</small>
                  <ChevronRight />
                </div>
              ))}
            </div>
          ) : (
            <Empty
              icon={<Star />}
              title="这个收藏区还没有文件"
              text="可以从工作区选择，也可以直接把文件拖到这里。"
            />
          )}
        </section>
      </div>
    </div>
  );
}

const parsePlanDate = (key: string) => new Date(`${key}T12:00:00`);
const addPlanDays = (key: string, amount: number) => {
  const date = parsePlanDate(key);
  date.setDate(date.getDate() + amount);
  return dayKey(date);
};
const startOfPlanWeek = (key: string) => {
  const date = parsePlanDate(key);
  const offset = (date.getDay() + 6) % 7;
  return addPlanDays(key, -offset);
};
const relativePlanDay = (key: string) => {
  const difference = Math.round(
    (parsePlanDate(key).getTime() - parsePlanDate(today()).getTime()) /
      86_400_000,
  );
  if (difference === -1) return "昨天";
  if (difference === 0) return "今天";
  if (difference === 1) return "明天";
  if (difference === -2) return "前天";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(parsePlanDate(key));
};

function PlannerPage({
  tasks,
  create,
  toggle,
  snooze,
  edit,
  remove,
}: {
  tasks: PlanTask[];
  create: (scope: PlanScope, dueDate: string) => void;
  toggle: (t: PlanTask) => void;
  snooze: (t: PlanTask) => void;
  edit: (t: PlanTask) => void;
  remove: (id: string) => void;
}) {
  const [scope, setScope] = useState<PlanScope>("daily");
  const [selectedDate, setSelectedDate] = useState(today());
  const [month, setMonth] = useState(today().slice(0, 7));
  const weekStart = startOfPlanWeek(selectedDate);
  const weekDays = Array.from({ length: 7 }, (_, index) =>
    addPlanDays(weekStart, index),
  );
  const weekEnd = weekDays[6];
  const dailyTasks = tasks.filter(
    (task) =>
      task.planScope === "daily" &&
      (task.dueDate === selectedDate ||
        (selectedDate === today() &&
          !task.completed &&
          task.dueDate < today())),
  );
  const weeklyTasks = tasks.filter(
    (task) =>
      task.planScope === "weekly" &&
      task.dueDate >= weekStart &&
      task.dueDate <= weekEnd,
  );
  const visible = scope === "daily" ? dailyTasks : weeklyTasks;
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const calendarCells: Array<string | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from(
      { length: daysInMonth },
      (_, index) =>
        `${year}-${String(monthNumber).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
    ),
  ];
  const moveMonth = (amount: number) => {
    const next = new Date(year, monthNumber - 1 + amount, 1, 12);
    const key = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
    setMonth(key);
    setSelectedDate(`${key}-01`);
  };
  const chooseDate = (key: string) => {
    setSelectedDate(key);
    setMonth(key.slice(0, 7));
  };
  const taskRows = visible.length ? (
    visible.map((task) => (
      <article
        className={`task-item ${task.completed ? "completed" : ""}`}
        key={task.id}
      >
        <button className="task-check" onClick={() => toggle(task)}>
          {task.completed && <Check />}
        </button>
        <i className={`priority ${task.priority}`} />
        <div onClick={() => edit(task)}>
          <strong>{task.title}</strong>
          <span>
            {task.note ||
              {
                daily: "每天重复",
                weekdays: "工作日重复",
                weekly: "每周重复",
                none: scope === "weekly" ? "本周事项" : "无备注",
              }[task.repeatRule]}
          </span>
        </div>
        <time>
          <small className={task.dueDate < today() ? "overdue" : ""}>
            {relativePlanDay(task.dueDate)}
          </small>
          {task.remindAt || "全天"}
        </time>
        {!task.completed && (
          <button
            className="icon-button"
            title="延后 10 分钟"
            onClick={() => snooze(task)}
          >
            <Bell />
          </button>
        )}
        <button
          className="icon-button"
          title="删除"
          onClick={() => remove(task.id)}
        >
          <Trash2 />
        </button>
      </article>
    ))
  ) : (
    <Empty
      icon={<CalendarDays />}
      title={scope === "daily" ? "这一天还没有安排" : "这一周还没有安排"}
      text="添加一件清晰、具体、可以完成的事情。"
      action={
        <button
          className="button primary"
          onClick={() => create(scope, selectedDate)}
        >
          <Plus />
          添加计划
        </button>
      }
    />
  );
  return (
    <div className="page planner-page planbook-page">
      <Heading
        eyebrow="PLANBOOK"
        title="计划"
        text="日有安排，周有方向，也保留回望昨天的入口。"
        action={
          <button
            className="button primary"
            onClick={() => create(scope, selectedDate)}
          >
            <Plus />
            添加{scope === "daily" ? "日" : "周"}计划
          </button>
        }
      />
      <div className="plan-scope-tabs">
        <button
          className={scope === "daily" ? "active" : ""}
          onClick={() => setScope("daily")}
        >
          <CalendarDays />
          <span>
            <strong>日计划</strong>
            <small>按日期安排与回顾</small>
          </span>
        </button>
        <button
          className={scope === "weekly" ? "active" : ""}
          onClick={() => setScope("weekly")}
        >
          <ClipboardList />
          <span>
            <strong>周计划</strong>
            <small>一周目标集中查看</small>
          </span>
        </button>
      </div>
      {scope === "daily" ? (
        <div className="daily-plan-layout">
          <aside className="calendar-card">
            <div className="calendar-head">
              <button onClick={() => moveMonth(-1)}>
                <ChevronLeft />
              </button>
              <div>
                <strong>
                  {year} 年 {monthNumber} 月
                </strong>
                <small>选择一天查看计划</small>
              </div>
              <button onClick={() => moveMonth(1)}>
                <ChevronRight />
              </button>
            </div>
            <div className="calendar-weekdays">
              {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="calendar-grid">
              {calendarCells.map((key, index) =>
                key ? (
                  <button
                    key={key}
                    className={`${key === selectedDate ? "selected" : ""} ${key === today() ? "today" : ""}`}
                    onClick={() => chooseDate(key)}
                  >
                    <span>{Number(key.slice(-2))}</span>
                    {tasks.some(
                      (task) =>
                        task.planScope === "daily" && task.dueDate === key,
                    ) && <i />}
                  </button>
                ) : (
                  <span className="calendar-blank" key={`blank-${index}`} />
                ),
              )}
            </div>
            <button
              className="calendar-today"
              onClick={() => chooseDate(today())}
            >
              回到今天
            </button>
          </aside>
          <section className="task-list plan-task-panel">
            <div className="task-list-head plan-list-head">
              <span>
                <strong>{relativePlanDay(selectedDate)}</strong>
                <small>{selectedDate}</small>
              </span>
              <small>
                {visible.length} 项
                {selectedDate === today() &&
                dailyTasks.some((task) => task.dueDate < today())
                  ? " · 含未完成的往日计划"
                  : ""}
              </small>
            </div>
            {taskRows}
          </section>
        </div>
      ) : (
        <div className="weekly-plan-layout">
          <div className="week-navigation">
            <button onClick={() => chooseDate(addPlanDays(selectedDate, -7))}>
              <ChevronLeft />
            </button>
            <div>
              <strong>
                {weekStart.slice(5).replace("-", ".")} —{" "}
                {weekEnd.slice(5).replace("-", ".")}
              </strong>
              <small>
                {weekStart === startOfPlanWeek(today())
                  ? "本周"
                  : `${weekStart.slice(0, 4)} 年`}
              </small>
            </div>
            <button onClick={() => chooseDate(addPlanDays(selectedDate, 7))}>
              <ChevronRight />
            </button>
          </div>
          <div className="week-strip">
            {weekDays.map((key, index) => (
              <button
                className={`${key === selectedDate ? "selected" : ""} ${key === today() ? "today" : ""}`}
                key={key}
                onClick={() => chooseDate(key)}
              >
                <span>
                  {
                    ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][
                      index
                    ]
                  }
                </span>
                <strong>{Number(key.slice(-2))}</strong>
                <small>
                  {tasks.filter(
                    (task) =>
                      task.planScope === "weekly" && task.dueDate === key,
                  ).length || ""}
                </small>
              </button>
            ))}
          </div>
          <section className="task-list plan-task-panel weekly-task-panel">
            <div className="task-list-head plan-list-head">
              <span>
                <strong>本周计划</strong>
                <small>
                  {weekStart} 至 {weekEnd}
                </small>
              </span>
              <small>{visible.length} 项</small>
            </div>
            {taskRows}
          </section>
        </div>
      )}
    </div>
  );
}

function SmartPage({
  data,
  files,
  settings,
}: {
  data: BootstrapData;
  files: () => void;
  settings: () => void;
}) {
  return (
    <div className="page">
      <Heading
        eyebrow="INTELLIGENCE"
        title="智能中心"
        text="智能能力只在你允许时读取文件。"
        action={
          <div className="privacy-pill">
            <ShieldCheck />
            本地优先
          </div>
        }
      />
      <section className="ocr-hero">
        <div className="ocr-copy">
          <span className="smart-label">
            <ScanText />
            OFFLINE OCR
          </span>
          <h2>让扫描件也可以被搜索</h2>
          <p>
            离线识别中文、英文图片与扫描
            PDF。识别文字保存在本机，不上传、不改动原文件。
          </p>
          <button className="button light" onClick={files}>
            <FileSearch />
            去工作区选择文件
          </button>
        </div>
        <div className="scan-visual">
          <div className="paper-lines">
            <span />
            <span />
            <span />
            <span />
          </div>
          <i />
          <small>LOCAL · PRIVATE</small>
        </div>
      </section>
      <div className="connector-heading">
        <div>
          <h2>能力连接器</h2>
          <p>接口已经预留，按需启用，不影响离线使用。</p>
        </div>
        <button className="text-button" onClick={settings}>
          管理连接器
          <ChevronRight />
        </button>
      </div>
      <div className="connector-grid">
        {data.connectors.map((c) => (
          <article key={c.id}>
            <span className={`connector-icon ${c.id}`}>
              {c.id === "model" ? (
                <Bot />
              ) : c.id === "wps" ? (
                <Cloud />
              ) : c.id === "mobile" ? (
                <Smartphone />
              ) : c.id === "ocr" ? (
                <ScanText />
              ) : (
                <Bell />
              )}
            </span>
            <div>
              <strong>{c.name}</strong>
              <p>{c.description}</p>
            </div>
            <em className={c.state}>
              {c.state === "ready" ? "可用" : "已预留"}
            </em>
          </article>
        ))}
      </div>
    </div>
  );
}

function SettingsPage({
  value,
  data,
  save,
  notify,
}: {
  value: AppSettings;
  data: BootstrapData;
  save: (v: AppSettings, key?: string) => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [key, setKey] = useState("");
  const [syncing, setSyncing] = useState(false);
  const pickWpsDir = async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      setSyncing(true);
      const validated = await api.validateWpsDir(picked);
      setDraft({ ...draft, wpsSyncDir: validated });
      notify("WPS 同步目录已选择，保存设置后生效");
    } catch (e) {
      notify(message(e), true);
    } finally {
      setSyncing(false);
    }
  };
  const syncNow = async () => {
    setSyncing(true);
    try {
      const result = await api.wpsSyncNow();
      notify(result.message || "同步完成");
    } catch (e) {
      notify(message(e), true);
    } finally {
      setSyncing(false);
    }
  };
  return (
    <div className="page settings-page">
      <Heading
        eyebrow="PREFERENCES"
        title="设置"
        text="所有配置都保存在这台电脑上。"
        action={
          <button
            className="button primary"
            onClick={() => save(draft, key || undefined)}
          >
            保存设置
          </button>
        }
      />
      <div className="settings-layout">
        <section className="settings-section">
          <div className="settings-title">
            <Database />
            <div>
              <h2>存储与启动</h2>
              <p>真实文件位置不会被应用迁移。</p>
            </div>
          </div>
          <label className="field">
            <span>文件存储根目录</span>
            <div className="locked-input">
              {draft.storageRoot}
              <ShieldCheck />
            </div>
          </label>
          <Toggle
            title="开机后在后台启动"
            text="确保计划提醒准时到达"
            value={draft.startOnLogin}
            change={(v) => setDraft({ ...draft, startOnLogin: v })}
          />
          <Toggle
            title="Windows 电脑通知"
            text="提醒只显示任务标题与时间"
            value={draft.notifications}
            change={(v) => setDraft({ ...draft, notifications: v })}
          />
          <Toggle
            title="启用静默时段"
            text="静默时段结束后补发错过的提醒"
            value={draft.quietHours}
            change={(v) => setDraft({ ...draft, quietHours: v })}
          />
          {draft.quietHours && (
            <div className="field-row">
              <label className="field">
                <span>静默开始</span>
                <input
                  type="time"
                  value={draft.quietStart}
                  onChange={(e) =>
                    setDraft({ ...draft, quietStart: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>静默结束</span>
                <input
                  type="time"
                  value={draft.quietEnd}
                  onChange={(e) =>
                    setDraft({ ...draft, quietEnd: e.target.value })
                  }
                />
              </label>
            </div>
          )}
          <div className="theme-choice">
            <span>外观主题</span>
            <div>
              <button
                className={draft.theme === "light" ? "active" : ""}
                onClick={() => setDraft({ ...draft, theme: "light" })}
              >
                <Sun />
                浅色
              </button>
              <button
                className={draft.theme === "dark" ? "active" : ""}
                onClick={() => setDraft({ ...draft, theme: "dark" })}
              >
                <Moon />
                深色
              </button>
            </div>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-title">
            <Bot />
            <div>
              <h2>大模型</h2>
              <p>兼容 DeepSeek 等 OpenAI 风格接口。</p>
            </div>
            <span
              className={`status-dot ${draft.modelKeySaved ? "ready" : ""}`}
            >
              {draft.modelKeySaved ? "已配置" : "未配置"}
            </span>
          </div>
          <div className="field-row">
            <label className="field">
              <span>服务地址</span>
              <input
                value={draft.modelBaseUrl}
                onChange={(e) =>
                  setDraft({ ...draft, modelBaseUrl: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>模型名称</span>
              <input
                value={draft.modelName}
                onChange={(e) =>
                  setDraft({ ...draft, modelName: e.target.value })
                }
              />
            </label>
          </div>
          <label className="field">
            <span>API 密钥</span>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                draft.modelKeySaved
                  ? "密钥已存入 Windows 凭据管理器"
                  : "输入后将安全保存"
              }
            />
          </label>
          <div className="privacy-note">
            <ShieldCheck />
            发送文件内容前必须由你主动确认，模型不能自行操作文件。
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-title">
            <ScanText />
            <div>
              <h2>自动 OCR</h2>
              <p>只处理你主动开启的工作区，原文件保持不变。</p>
            </div>
          </div>
          {data.workspaces.length ? (
            data.workspaces.map((workspace) => (
              <Toggle
                key={workspace.id}
                title={workspace.name}
                text="新图片和扫描 PDF 将在本机自动建立文字索引"
                value={draft.ocrAutoWorkspaces.includes(workspace.relativePath)}
                change={(enabled) =>
                  setDraft({
                    ...draft,
                    ocrAutoWorkspaces: enabled
                      ? [...draft.ocrAutoWorkspaces, workspace.relativePath]
                      : draft.ocrAutoWorkspaces.filter(
                          (path) => path !== workspace.relativePath,
                        ),
                  })
                }
              />
            ))
          ) : (
            <div className="privacy-note">
              <FolderPlus />
              创建工作区后，可以在这里启用自动识别。
            </div>
          )}
        </section>
        <section className="settings-section">
          <div className="settings-title">
            <Cloud />
            <div>
              <h2>WPS 云盘同步</h2>
              <p>归档文件复制进 WPS 同步目录，由 WPS 客户端上传云端。</p>
            </div>
            <span
              className={`status-dot ${
                draft.wpsSyncDir && draft.wpsSyncWorkspaces.length
                  ? "ready"
                  : ""
              }`}
            >
              {draft.wpsSyncDir && draft.wpsSyncWorkspaces.length
                ? "已配置"
                : "未配置"}
            </span>
          </div>
          <label className="field">
            <span>WPS 同步目录</span>
            <div className="locked-input">
              {draft.wpsSyncDir ?? "未选择 WPS 同步目录"}
              <ShieldCheck />
            </div>
          </label>
          <div className="field-row">
            <button className="button light" disabled={syncing} onClick={pickWpsDir}>
              <FolderOpen />
              {draft.wpsSyncDir ? "重新选择目录" : "选择 WPS 同步目录"}
            </button>
            <button
              className="button primary"
              disabled={syncing || !draft.wpsSyncDir}
              onClick={syncNow}
            >
              <RefreshCw />
              立即同步
            </button>
          </div>
          {draft.wpsSyncDir ? (
            data.workspaces.length ? (
              data.workspaces.map((workspace) => (
                <Toggle
                  key={workspace.id}
                  title={workspace.name}
                  text="归档到该工作区的文件将自动复制进 WPS 同步目录"
                  value={draft.wpsSyncWorkspaces.includes(workspace.relativePath)}
                  change={(enabled) =>
                    setDraft({
                      ...draft,
                      wpsSyncWorkspaces: enabled
                        ? [...draft.wpsSyncWorkspaces, workspace.relativePath]
                        : draft.wpsSyncWorkspaces.filter(
                            (path) => path !== workspace.relativePath,
                          ),
                    })
                  }
                />
              ))
            ) : (
              <div className="privacy-note">
                <FolderPlus />
                创建工作区后，可以在这里开启云同步。
              </div>
            )
          ) : (
            <div className="privacy-note">
              <FolderPlus />
              先在 WPS 客户端开启云文档同步，再选择它的本地同步目录。
            </div>
          )}
          <div className="privacy-note">
            <ShieldCheck />
            需要 WPS 客户端保持登录并开启云同步。首版只同步新增和更新的文件，删除与重命名不会反映到云端。
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-title">
            <Cloud />
            <div>
              <h2>扩展连接器</h2>
              <p>正式接口与本地数据结构已经预留。</p>
            </div>
          </div>
          <div className="settings-connectors">
            {data.connectors
              .filter((c) => c.id !== "model")
              .map((c) => (
                <div key={c.id}>
                  <span className={`connector-icon ${c.id}`}>
                    {c.id === "wps" ? (
                      <Cloud />
                    ) : c.id === "mobile" ? (
                      <MonitorSmartphone />
                    ) : c.id === "ocr" ? (
                      <ScanText />
                    ) : (
                      <Bell />
                    )}
                  </span>
                  <span>
                    <strong>{c.name}</strong>
                    <small>{c.description}</small>
                  </span>
                  <em className={c.state}>
                    {c.state === "ready" ? "可用" : "等待授权"}
                  </em>
                </div>
              ))}
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-title">
            <WifiOff />
            <div>
              <h2>手机局域网访问</h2>
              <p>默认关闭，不开放任何网络端口。</p>
            </div>
          </div>
          <div className="reserved-banner">
            <Smartphone />
            <div>
              <strong>配对服务已经预留</strong>
              <span>后续加入一次性验证码、设备撤销和只读权限。</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Heading({
  eyebrow,
  title,
  text,
  action,
}: {
  eyebrow: string;
  title: string;
  text: string;
  action: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {action}
    </div>
  );
}
function Toggle({
  title,
  text,
  value,
  change,
}: {
  title: string;
  text: string;
  value: boolean;
  change: (v: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => change(e.target.checked)}
      />
      <i />
    </label>
  );
}

function NameDialog({
  mode,
  entry,
  busy,
  close,
  submit,
}: {
  mode: "workspace" | "folder" | "rename";
  entry?: FileEntry;
  busy: boolean;
  close: () => void;
  submit: (n: string) => void;
}) {
  const [name, setName] = useState(entry?.name ?? "");
  const title =
    mode === "workspace"
      ? "新建工作区"
      : mode === "folder"
        ? "新建子分区"
        : "重命名";
  return (
    <Modal
      title={title}
      text={
        mode === "workspace"
          ? "将在 D:\自动归档 下创建同名真实文件夹。"
          : "不会改变文件内容。"
      }
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) submit(name.trim());
        }}
      >
        <label className="field">
          <span>名称</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="输入名称"
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            取消
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy && <LoaderCircle className="spin" />}确认
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Destination({
  mode,
  workspaces,
  busy,
  close,
  submit,
}: {
  mode: "copy" | "move";
  workspaces: Workspace[];
  busy: boolean;
  close: () => void;
  submit: (p: string) => void;
}) {
  const [target, setTarget] = useState(workspaces[0]?.relativePath ?? "");
  return (
    <Modal
      title={`${mode === "copy" ? "复制" : "移动"}到工作区`}
      text="同名但内容不同的文件会按修改时间保留为两个版本。"
      close={close}
    >
      <div className="destination-list">
        {workspaces.map((w) => (
          <button
            className={target === w.relativePath ? "active" : ""}
            key={w.id}
            onClick={() => setTarget(w.relativePath)}
          >
            <Folder />
            <span>
              <strong>{w.name}</strong>
              <small>{w.itemCount} 项</small>
            </span>
            {target === w.relativePath && <Check />}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button className="button secondary" onClick={close}>
          取消
        </button>
        <button
          className="button primary"
          disabled={busy || !target}
          onClick={() => submit(target)}
        >
          确认{mode === "copy" ? "复制" : "移动"}
        </button>
      </div>
    </Modal>
  );
}
function FavoriteDialog({
  entry,
  data,
  busy,
  close,
  toggle,
  create,
}: {
  entry?: FileEntry;
  data: BootstrapData;
  busy: boolean;
  close: () => void;
  toggle: (id: string, file: FileEntry) => void;
  create: (n: string, c: string) => void;
}) {
  const [adding, setAdding] = useState(!entry);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#315bdb");
  return (
    <Modal
      title={entry ? "加入收藏" : "新建收藏分区"}
      text={
        entry ? "收藏只保存快捷引用，不会复制文件。" : "建立一种新的查找方式。"
      }
      close={close}
    >
      {adding ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create(name.trim(), color);
          }}
        >
          <label className="field">
            <span>分区名称</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：会议材料"
            />
          </label>
          <div className="color-picker">
            {["#315bdb", "#19806a", "#b7791f", "#a14f7a", "#c44b43"].map(
              (c) => (
                <button
                  type="button"
                  className={color === c ? "active" : ""}
                  style={{ background: c }}
                  key={c}
                  onClick={() => setColor(c)}
                />
              ),
            )}
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => (entry ? setAdding(false) : close())}
            >
              返回
            </button>
            <button className="button primary" disabled={busy || !name.trim()}>
              创建分区
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="destination-list favorite-options">
            {data.favoriteCategories.map((c) => {
              const active = data.favorites.some(
                (f) =>
                  f.categoryId === c.id &&
                  f.relativePath === entry!.relativePath,
              );
              return (
                <button key={c.id} onClick={() => toggle(c.id, entry!)}>
                  <i style={{ background: c.color }} />
                  <span>
                    <strong>{c.name}</strong>
                    <small>{c.count} 个收藏</small>
                  </span>
                  {active && <Check />}
                </button>
              );
            })}
          </div>
          <button className="new-category" onClick={() => setAdding(true)}>
            <Plus />
            新建收藏分区
          </button>
        </>
      )}
    </Modal>
  );
}
function TaskDialog({
  task,
  defaults,
  busy,
  close,
  submit,
}: {
  task?: PlanTask;
  defaults?: { planScope: PlanScope; dueDate: string };
  busy: boolean;
  close: () => void;
  submit: (t: Partial<PlanTask> & Pick<PlanTask, "title">) => void;
}) {
  const [form, setForm] = useState({
    title: task?.title ?? "",
    planScope: task?.planScope ?? defaults?.planScope ?? ("daily" as PlanScope),
    dueDate: task?.dueDate ?? defaults?.dueDate ?? today(),
    remindAt: task?.remindAt ?? "",
    priority: task?.priority ?? ("medium" as TaskPriority),
    repeatRule: task?.repeatRule ?? "none",
    note: task?.note ?? "",
  });
  return (
    <Modal
      title={
        task
          ? "编辑计划"
          : `添加${form.planScope === "daily" ? "日" : "周"}计划`
      }
      text="归档助手会在设定时间发送电脑通知。"
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (form.title.trim())
            submit({
              ...task,
              ...form,
              title: form.title.trim(),
              remindAt: form.remindAt || undefined,
              repeatRule: form.repeatRule as PlanTask["repeatRule"],
            });
        }}
      >
        <label className="field">
          <span>要完成什么</span>
          <input
            autoFocus
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="写下一件具体的事"
          />
        </label>
        <div className="plan-type-choice">
          <button
            type="button"
            className={form.planScope === "daily" ? "active" : ""}
            onClick={() => setForm({ ...form, planScope: "daily" })}
          >
            <CalendarDays />
            日计划
          </button>
          <button
            type="button"
            className={form.planScope === "weekly" ? "active" : ""}
            onClick={() => setForm({ ...form, planScope: "weekly" })}
          >
            <ClipboardList />
            周计划
          </button>
        </div>
        <div className="field-row">
          <label className="field">
            <span>日期</span>
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
            />
          </label>
          <label className="field">
            <span>提醒时间</span>
            <input
              type="time"
              value={form.remindAt}
              onChange={(e) => setForm({ ...form, remindAt: e.target.value })}
            />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>优先级</span>
            <select
              value={form.priority}
              onChange={(e) =>
                setForm({ ...form, priority: e.target.value as TaskPriority })
              }
            >
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </label>
          <label className="field">
            <span>重复</span>
            <select
              value={form.repeatRule}
              onChange={(e) => setForm({ ...form, repeatRule: e.target.value })}
            >
              <option value="none">不重复</option>
              <option value="daily">每天</option>
              <option value="weekdays">工作日</option>
              <option value="weekly">每周</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>备注</span>
          <textarea
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            取消
          </button>
          <button
            className="button primary"
            disabled={busy || !form.title.trim()}
          >
            保存计划
          </button>
        </div>
      </form>
    </Modal>
  );
}
function OcrDialog({ file, close }: { file: FileEntry; close: () => void }) {
  const [progress, setProgress] = useState(0);
  const [label, setLabel] = useState("等待开始");
  const [result, setResult] = useState<OcrResult | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    setError("");
    try {
      setResult(
        await localOcr.recognize(file.relativePath, (p, l) => {
          setProgress(p);
          setLabel(l);
        }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setRunning(false);
    }
  };
  return (
    <Modal title="离线 OCR" text={file.name} close={close} wide>
      <div className="ocr-modal">
        <div className="ocr-status">
          <div
            className="progress-ring"
            style={
              {
                "--progress": `${Math.round(progress * 360)}deg`,
              } as React.CSSProperties
            }
          >
            <span>{Math.round(progress * 100)}%</span>
          </div>
          <div>
            <strong>
              {result ? "识别完成" : error ? "识别没有完成" : label}
            </strong>
            <p>
              {result
                ? `${result.pages} 页 · 平均置信度 ${Math.round(result.confidence)}% · 已加入本地搜索`
                : "识别过程完全在本机进行，不会修改原文件。"}
            </p>
          </div>
        </div>
        {error && (
          <div className="error-panel">
            <X />
            {error}
          </div>
        )}
        {result ? (
          <textarea
            className="ocr-output"
            readOnly
            value={result.text || "未识别到可复制的文字"}
          />
        ) : (
          <div className="ocr-placeholder">
            <ScanText />
            <span>识别结果会显示在这里</span>
          </div>
        )}
        <div className="modal-actions">
          <button className="button secondary" onClick={close}>
            关闭
          </button>
          {result && (
            <button
              className="button secondary"
              onClick={() => navigator.clipboard.writeText(result.text)}
            >
              <Copy />
              复制文字
            </button>
          )}
          <button className="button primary" disabled={running} onClick={run}>
            {running ? <LoaderCircle className="spin" /> : <ScanText />}
            {result ? "重新识别" : "开始离线识别"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
