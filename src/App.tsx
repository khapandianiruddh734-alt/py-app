import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useDropzone } from "react-dropzone";
import {
  Upload,
  FileText,
  Download,
  Loader2,
  Table as TableIcon,
  AlertCircle,
  RefreshCw,
  Users,
  HardDrive,
  ListOrdered,
  FolderOpen,
  Trash2,
  X,
} from "lucide-react";
import * as XLSX from "xlsx";
import { extractDataFromFiles, type ExtractionLanguage, type OutputMode } from "./services/geminiService";
import { cn } from "./lib/utils";
import {
  initializeFileManager,
  cleanupExpiredFiles,
  saveFileForUser,
  updateFileRecord,
  deleteFileRecord,
  getUserFiles,
  getUserFileCount,
  getTeamFileCount,
  checkUserLimit,
  getStoredBytesUsed,
} from "./fileManager";
import { UploadQueue } from "./uploadQueue";
import { createStorageMonitor } from "./storageMonitor";
import {
  MAX_FILES_PER_USER,
  statusClass,
  statusLabel,
  resolveCurrentUserId,
  buildDashboardModel,
} from "./teamDashboard";

interface ExtractedData {
  Name: string;
  Item_Online_DisplayName: string;
  Variation_Name: string;
  Price: string;
  Category: string;
  Category_Online_DisplayName: string;
  Short_Code: string;
  Short_Code_2: string;
  Description: string;
  Attributes: string;
  Goods_Services: string;
}

interface QueueSnapshot {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
  paused: boolean;
}

interface TaskView {
  id: string;
  fileRecordId: string;
  fileName: string;
  status: string;
  retries: number;
  error: string;
  updatedAt: number;
}

interface StorageSummary {
  usage: number;
  quota: number;
  percentage: number;
  warning: boolean;
  usageLabel: string;
  quotaLabel: string;
}

interface StoredFileItem {
  id: string;
  name: string;
  size: number;
  status: string;
  retries: number;
  createdAt: number;
  expiresAt: number;
}

const COLUMNS: Array<keyof ExtractedData> = [
  "Name",
  "Item_Online_DisplayName",
  "Variation_Name",
  "Price",
  "Category",
  "Category_Online_DisplayName",
  "Short_Code",
  "Short_Code_2",
  "Description",
  "Attributes",
  "Goods_Services",
];

const DEFAULT_QUEUE: QueueSnapshot = {
  queued: 0,
  processing: 0,
  completed: 0,
  failed: 0,
  total: 0,
  paused: false,
};

const DEFAULT_STORAGE: StorageSummary = {
  usage: 0,
  quota: 1,
  percentage: 0,
  warning: false,
  usageLabel: "0 B",
  quotaLabel: "0 B",
};

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [data, setData] = useState<ExtractedData[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [language, setLanguage] = useState<ExtractionLanguage>("auto");
  const [outputMode, setOutputMode] = useState<OutputMode>("structured");
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot>(DEFAULT_QUEUE);
  const [taskViews, setTaskViews] = useState<Record<string, TaskView>>({});
  const [myFileCount, setMyFileCount] = useState(0);
  const [teamFileCount, setTeamFileCount] = useState(0);
  const [storageSummary, setStorageSummary] = useState<StorageSummary>(DEFAULT_STORAGE);
  const [myFilesOpen, setMyFilesOpen] = useState(false);
  const [myFiles, setMyFiles] = useState<StoredFileItem[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);

  const userIdRef = useRef<string>(resolveCurrentUserId());
  const queueRef = useRef<any>(null);
  const storageMonitorRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const dashboard = useMemo(
    () =>
      buildDashboardModel({
        myFileCount,
        teamFileCount,
        queue: queueSnapshot,
        storage: storageSummary,
        maxFiles: MAX_FILES_PER_USER,
      }),
    [myFileCount, teamFileCount, queueSnapshot, storageSummary]
  );

  const refreshCounts = useCallback(async () => {
    const userId = userIdRef.current;
    await cleanupExpiredFiles();
    const [mine, team] = await Promise.all([getUserFileCount(userId), getTeamFileCount()]);
    setMyFileCount(mine);
    setTeamFileCount(team);
  }, []);

  const refreshMyFiles = useCallback(async () => {
    const userId = userIdRef.current;
    setIsLoadingFiles(true);
    try {
      const list = await getUserFiles(userId);
      setMyFiles(list as StoredFileItem[]);
    } finally {
      setIsLoadingFiles(false);
    }
  }, []);

  const getAudioContext = useCallback(() => {
    if (typeof window === "undefined") return null;
    const AudioContextConstructor =
      window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextConstructor) return null;

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextConstructor();
    }

    return audioContextRef.current;
  }, []);

  const unlockReadyBeep = useCallback(() => {
    const audioContext = getAudioContext();
    if (audioContext?.state === "suspended") {
      void audioContext.resume();
    }
  }, [getAudioContext]);

  const playReadyBeep = useCallback(() => {
    const audioContext = getAudioContext();
    if (!audioContext) return;

    const playTone = (frequency: number, startTime: number, duration: number, peakVolume: number) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency, startTime);
      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.exponentialRampToValueAtTime(peakVolume, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(startTime);
      oscillator.stop(startTime + duration + 0.03);
    };

    const play = () => {
      const now = audioContext.currentTime;
      playTone(659.25, now, 0.16, 0.12);
      playTone(987.77, now + 0.13, 0.24, 0.1);
    };

    if (audioContext.state === "suspended") {
      void audioContext.resume().then(play).catch(() => {});
      return;
    }

    play();
  }, [getAudioContext]);

  const handleTaskUpdate = useCallback((task: any) => {
    setTaskViews((prev) => ({
      ...prev,
      [task.id]: {
        id: task.id,
        fileRecordId: task.fileRecordId,
        fileName: task.file?.name || prev[task.id]?.fileName || "File",
        status: task.status,
        retries: task.retries || 0,
        error: task.error || "",
        updatedAt: Date.now(),
      },
    }));

    if (task.status === "completed") {
      playReadyBeep();
    }

    void updateFileRecord(task.fileRecordId, {
      status: task.status,
      retries: task.retries || 0,
      error: task.error || "",
    });
  }, [playReadyBeep]);

  const handleQueueSnapshot = useCallback((snapshot: QueueSnapshot) => {
    setQueueSnapshot(snapshot);
    setIsExtracting(snapshot.processing > 0 || snapshot.queued > 0);
  }, []);

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      const setup = await initializeFileManager();
      if (!setup.indexedDB && mounted) {
        setNotice("IndexedDB is not available. Running in limited in-memory mode.");
      }

      const queue = new UploadQueue({
        concurrency: 3,
        maxRetries: 3,
        onTaskUpdate: handleTaskUpdate,
        onSnapshot: handleQueueSnapshot,
        processor: async (task: any) => {
          await updateFileRecord(task.fileRecordId, { status: "processing", error: "" });
          const rows = await extractDataFromFiles([task.file], {
            language: task.options.language,
            outputMode: task.options.outputMode,
          });
          await updateFileRecord(task.fileRecordId, {
            status: "completed",
            resultCount: rows.length,
            error: "",
          });
          setData((prev) => [...prev, ...rows]);
          storageMonitorRef.current?.schedule();
          await refreshCounts();
        },
      });

      queueRef.current = queue;

      const monitor = createStorageMonitor({
        warningThreshold: 0.8,
        debounceMs: 1000,
        getFallbackUsage: async () => getStoredBytesUsed(),
        onOverThreshold: async () => {
          await cleanupExpiredFiles();
        },
        onUpdate: (summary: StorageSummary) => {
          if (mounted) {
            setStorageSummary(summary);
          }
        },
      });
      storageMonitorRef.current = monitor;

      await refreshCounts();
      await monitor.estimateStorage();
    };

    void bootstrap();

    return () => {
      mounted = false;
      storageMonitorRef.current?.stop?.();
    };
  }, [handleQueueSnapshot, handleTaskUpdate, refreshCounts]);

  useEffect(() => {
    if (myFilesOpen) {
      void refreshMyFiles();
    }
  }, [myFilesOpen, refreshMyFiles]);

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      void (async () => {
        const userId = userIdRef.current;
        const existingCount = await getUserFileCount(userId);
        const available = Math.max(0, MAX_FILES_PER_USER - existingCount - files.length);
        const accepted = acceptedFiles.slice(0, available);
        const rejectedCount = acceptedFiles.length - accepted.length;

        if (!accepted.length) {
          setError(`Upload limit reached (${MAX_FILES_PER_USER} files per user).`);
          return;
        }

        setFiles((prev) => [...prev, ...accepted]);
        setError(null);

        if (rejectedCount > 0) {
          setNotice(`${rejectedCount} file(s) skipped due to user limit (${MAX_FILES_PER_USER}).`);
        } else {
          setNotice(null);
        }
      })();
    },
    [files.length]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "image/*": [".jpeg", ".jpg", ".png"],
      "application/pdf": [".pdf"],
      "text/csv": [".csv"],
      "application/vnd.ms-excel": [".xls"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    },
  } as any);

  const handleExtract = async () => {
    if (files.length === 0) return;

    unlockReadyBeep();
    setError(null);
    setNotice(null);

    const userId = userIdRef.current;
    const limit = await checkUserLimit(userId, files.length, MAX_FILES_PER_USER);
    if (limit.accepted <= 0) {
      setError(`Upload limit reached (${MAX_FILES_PER_USER} files per user).`);
      return;
    }

    const selected = files.slice(0, limit.accepted);
    const tasks: any[] = [];

    for (const file of selected) {
      try {
        const record = await saveFileForUser(userId, file, { status: "queued" });
        tasks.push({
          id: `task_${record.id}`,
          file,
          fileRecordId: record.id,
          userId,
          options: { language, outputMode },
        });
      } catch {
        setError(`Failed to store "${file.name}" locally. Processing skipped for this file.`);
      }
    }

    if (tasks.length > 0) {
      queueRef.current?.addTasks(tasks);
      setFiles([]);
      await refreshCounts();
      storageMonitorRef.current?.schedule();
    }

    if (limit.rejected > 0) {
      setNotice(`${limit.rejected} file(s) were not queued due to the ${MAX_FILES_PER_USER}-file limit.`);
    }
  };

  const downloadExcel = () => {
    const orderedRows = data.map((row) =>
      COLUMNS.reduce((acc, col) => {
        acc[col] = row[col] || "";
        return acc;
      }, {} as ExtractedData)
    );
    const worksheet = XLSX.utils.json_to_sheet(orderedRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Extracted Data");

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    XLSX.writeFile(workbook, `extracted_data_${timestamp}.xlsx`);
  };

  const clearAll = () => {
    setData([]);
    setFiles([]);
    setError(null);
    setNotice(null);
  };

  const openMyFilesModal = async () => {
    setMyFilesOpen(true);
    await refreshMyFiles();
  };

  const deleteStored = async (fileId: string) => {
    const allTasks = Object.values(taskViews) as TaskView[];
    const activeTask = allTasks.find(
      (task) => task.fileRecordId === fileId && task.status === "queued"
    );
    if (activeTask) {
      queueRef.current?.cancelQueued(activeTask.id);
    }

    const processingTask = allTasks.find(
      (task) => task.fileRecordId === fileId && task.status === "processing"
    );
    if (processingTask) {
      setNotice("Cannot delete while processing. Please wait until processing is finished.");
      return;
    }

    await deleteFileRecord(fileId);
    await refreshMyFiles();
    await refreshCounts();
    storageMonitorRef.current?.schedule();
  };

  const visibleTasks = useMemo(
    () => (Object.values(taskViews) as TaskView[]).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8),
    [taskViews]
  );

  return (
    <div className="min-h-screen bg-[#F5F6FA] text-gray-900 font-sans selection:bg-blue-100 py-10 px-4 sm:py-12">
      <div className="max-w-[760px] mx-auto space-y-6">
        <div className="bg-white rounded-[14px] shadow-[0_12px_30px_rgba(15,23,42,0.06)] border border-[#E5E7EB] overflow-hidden relative">
          <button
            onClick={clearAll}
            className="absolute top-4 right-4 grid h-9 w-9 place-items-center rounded-[10px] border border-transparent text-gray-400 transition-colors duration-150 ease-in-out hover:border-gray-200 hover:bg-gray-50 hover:text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-50 cursor-pointer"
            title="Reset"
          >
            <RefreshCw size={18} />
          </button>

          <div className="p-5 sm:p-8 flex flex-col items-center">
            <h1 className="text-2xl font-semibold mb-8 text-gray-950">New Menu Processing</h1>

            <div
              {...getRootProps()}
              className={cn(
                "w-full border-2 border-dashed rounded-[14px] p-8 sm:p-12 transition-colors duration-150 ease-in-out cursor-pointer flex flex-col items-center justify-center text-center gap-4",
                isDragActive ? "border-blue-500 bg-blue-50" : "border-gray-300 bg-white hover:border-blue-500 hover:bg-blue-50"
              )}
            >
              <input {...getInputProps()} />
              <div className="grid h-14 w-14 place-items-center rounded-[14px] bg-blue-50 text-blue-600 ring-1 ring-blue-100">
                <Upload size={30} strokeWidth={1.7} />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-gray-800">Upload Client New Menu</p>
                <p className="text-xs text-gray-500">
                  Drop files here or click to browse (PDF, images, XLS/XLSX, CSV)
                </p>
              </div>
            </div>

            {files.length > 0 && (
              <div className="mt-4 w-full">
                <div className="flex flex-wrap gap-2 justify-center">
                  {files.map((file, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-full text-[11px] font-medium text-gray-600 border border-gray-200"
                    >
                      <FileText size={12} />
                      {file.name}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6 w-full grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="text-[11px] font-medium uppercase tracking-[0.05em] text-gray-500">
                OCR / Output Language
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as ExtractionLanguage)}
                  className="mt-1.5 h-10 w-full rounded-[10px] border border-[#E5E7EB] bg-white px-3 text-sm font-normal normal-case tracking-normal text-gray-700 transition-colors duration-150 ease-in-out focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-50"
                >
                  <option value="auto">Auto Detect</option>
                  <option value="english">English</option>
                  <option value="hindi">Hindi</option>
                  <option value="arabic">Arabic</option>
                  <option value="urdu">Urdu</option>
                  <option value="bengali">Bengali</option>
                  <option value="tamil">Tamil</option>
                  <option value="telugu">Telugu</option>
                  <option value="marathi">Marathi</option>
                  <option value="gujarati">Gujarati</option>
                  <option value="punjabi">Punjabi</option>
                  <option value="malayalam">Malayalam</option>
                  <option value="kannada">Kannada</option>
                  <option value="french">French</option>
                  <option value="spanish">Spanish</option>
                </select>
                <p className="text-[11px] normal-case tracking-normal text-gray-500 mt-1.5">
                  Select the language for output.
                </p>
              </label>

              <label className="text-[11px] font-medium uppercase tracking-[0.05em] text-gray-500">
                Output Format
                <select
                  value={outputMode}
                  onChange={(e) => setOutputMode(e.target.value as OutputMode)}
                  className="mt-1.5 h-10 w-full rounded-[10px] border border-[#E5E7EB] bg-white px-3 text-sm font-normal normal-case tracking-normal text-gray-700 transition-colors duration-150 ease-in-out focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-50"
                >
                  <option value="structured">Structured</option>
                  <option value="original">Original</option>
                </select>
              </label>
            </div>

            <div className="dashboard-grid mt-6 w-full">
              <section className="dashboard-card">
                <div className="dashboard-title">
                  <HardDrive size={16} />
                  <span>Storage Usage</span>
                </div>
                <p className="dashboard-value">
                  {storageSummary.usageLabel} / {storageSummary.quotaLabel}
                </p>
                <div className="dashboard-progress">
                  <div className="dashboard-progress-fill" style={{ width: `${dashboard.storagePct}%` }} />
                </div>
                <p
                  className={cn(
                    "dashboard-subtle",
                    dashboard.isStorageWarning ? "text-red-600" : "text-gray-500"
                  )}
                >
                  {dashboard.isStorageWarning
                    ? "Warning: storage is above 80%. Old files will be cleaned automatically."
                    : "Storage is healthy."}
                </p>
              </section>

              <section className="dashboard-card">
                <div className="dashboard-title">
                  <ListOrdered size={16} />
                  <span>Queue Status</span>
                </div>
                <div className="dashboard-inline-stats">
                  <span>Queued: {queueSnapshot.queued}</span>
                  <span>Processing: {queueSnapshot.processing}</span>
                  <span>Completed: {queueSnapshot.completed}</span>
                  <span>Failed: {queueSnapshot.failed}</span>
                </div>
                <div className="dashboard-queue-list">
                  {visibleTasks.length === 0 ? (
                    <p className="dashboard-subtle">No queue activity yet.</p>
                  ) : (
                    visibleTasks.map((task) => (
                      <div key={task.id} className="dashboard-queue-item">
                        <span className="truncate">{task.fileName}</span>
                        <span className={statusClass(task.status)}>
                          {statusLabel(task.status)}
                          {task.retries > 0 ? ` (Retry ${task.retries})` : ""}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="dashboard-card">
                <div className="dashboard-title">
                  <Users size={16} />
                  <span>Team Stats</span>
                </div>
                <p className="dashboard-value">
                  My Files: {dashboard.myFileCount}/{dashboard.maxFiles}
                </p>
                <div className="dashboard-progress">
                  <div className="dashboard-progress-fill" style={{ width: `${dashboard.myFilePct}%` }} />
                </div>
                <p className="dashboard-subtle">Team Total Files: {dashboard.teamFileCount}</p>
              </section>

              <section className="dashboard-card">
                <div className="dashboard-title">
                  <FolderOpen size={16} />
                  <span>My Files</span>
                </div>
                <p className="dashboard-subtle">View and delete your stored files.</p>
                <button onClick={openMyFilesModal} className="dashboard-action-btn">
                  View My Files
                </button>
              </section>
            </div>

            <div className="mt-8">
              <button
                onClick={handleExtract}
                disabled={isExtracting || files.length === 0}
                className="min-h-10 px-10 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 disabled:shadow-none disabled:cursor-not-allowed text-white rounded-[12px] text-sm font-semibold transition-colors duration-150 ease-in-out shadow-[0_8px_18px_rgba(37,99,235,0.22)] cursor-pointer focus:outline-none focus:ring-[3px] focus:ring-blue-50"
              >
                {isExtracting ? (
                  <div className="flex items-center gap-2">
                    <Loader2 className="animate-spin" size={18} />
                    Processing...
                  </div>
                ) : (
                  "Process Files"
                )}
              </button>
            </div>
          </div>
        </div>

        {notice && (
          <div className="bg-amber-50 border border-amber-200 p-4 rounded-[14px] flex items-center justify-center gap-3 text-amber-700 text-sm shadow-sm">
            <AlertCircle size={18} />
            {notice}
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 p-4 rounded-[14px] flex items-center justify-center gap-3 text-red-600 text-sm shadow-sm">
            <AlertCircle size={18} />
            {error}
          </div>
        )}

        {data.length > 0 && (
          <div className="bg-white rounded-[14px] shadow-[0_12px_30px_rgba(15,23,42,0.06)] border border-[#E5E7EB] overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="px-5 sm:px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
              <div className="flex items-center gap-2">
                <TableIcon size={18} className="text-blue-600" />
                <h2 className="text-sm font-semibold text-gray-900">Extracted Data ({data.length} items)</h2>
              </div>
              <button
                onClick={downloadExcel}
                className="flex min-h-10 items-center gap-2 px-4 py-2 bg-white border border-gray-200 hover:bg-gray-50 hover:border-blue-500 hover:text-blue-600 rounded-[10px] text-xs font-semibold transition-colors duration-150 ease-in-out shadow-sm cursor-pointer focus:outline-none focus:ring-[3px] focus:ring-blue-50"
              >
                <Download size={14} />
                Download Excel
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    {COLUMNS.map((col) => (
                      <th
                        key={col}
                        className="px-4 py-3 text-[11px] font-semibold text-gray-500 uppercase tracking-[0.05em] whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.map((row, i) => (
                    <tr key={i} className="hover:bg-blue-50/40 transition-colors duration-150 ease-in-out">
                      {COLUMNS.map((col) => (
                        <td
                          key={col}
                          className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap max-w-[200px] truncate"
                        >
                          {row[col as keyof ExtractedData] || ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {myFilesOpen && (
        <div className="dashboard-modal-backdrop">
          <div className="dashboard-modal">
            <div className="dashboard-modal-header">
              <h3 className="dashboard-modal-title">My Files ({myFiles.length})</h3>
              <button className="dashboard-modal-close" onClick={() => setMyFilesOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <div className="dashboard-modal-body">
              {isLoadingFiles ? (
                <p className="dashboard-subtle">Loading files...</p>
              ) : myFiles.length === 0 ? (
                <p className="dashboard-subtle">No files stored.</p>
              ) : (
                myFiles.map((item) => (
                  <div key={item.id} className="dashboard-file-item">
                    <div>
                      <p className="dashboard-file-name">{item.name}</p>
                      <p className="dashboard-subtle">
                        {new Date(item.createdAt).toLocaleString()} | {statusLabel(item.status)}
                      </p>
                    </div>
                    <button className="dashboard-delete-btn" onClick={() => void deleteStored(item.id)}>
                      <Trash2 size={14} />
                      Delete
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
