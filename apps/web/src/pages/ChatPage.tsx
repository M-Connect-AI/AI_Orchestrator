import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChatBlock,
  ChatDone,
  ChatHighlight,
  ChatSuggestion,
  ChatUiAction,
  getThread,
  listThreads,
  outlookAuthUrl,
  Session,
  streamChat,
  ThreadSummary,
} from "../api";
import { ChatBlocks, HighlightedText } from "../chat/ChatRich";

type Bubble = {
  role: "user" | "assistant";
  content: string;
  confirm?: ChatDone["confirm"];
  uiAction?: ChatUiAction | null;
  blocks?: ChatBlock[];
  highlights?: ChatHighlight[];
  suggestions?: ChatSuggestion[];
  thinking?: boolean;
};

const STAFF_HINTS = [
  "Tôi muốn xin nghỉ phép năm từ 2026-09-08 đến 2026-09-10 vì đám cưới em",
  "Xem đơn nghỉ phép của tôi",
  "Tôi còn bao nhiêu ngày phép?",
  "Thống kê task Jira tôi cần làm, đang làm và đã làm",
  "Phân tích backlog Jira của tôi",
];

const MANAGER_HINTS = [
  "Team đang có những đơn phép nào chờ duyệt?",
  "Cho tôi thông tin các đơn của Nguyễn Văn A",
  "Các đơn xin nghỉ ngày 28/8",
  "Chỉ duyệt đơn phép ốm của A",
  "Duyệt đơn thứ 2",
  "Phân tích backlog project MCONNECT",
];

function greeting(isManager: boolean): Bubble {
  return {
    role: "assistant",
    content: isManager
      ? "Xin chào quản lý. Mình hỗ trợ nghiệp vụ nhân sự, thống kê task Jira và phân tích backlog project. Bạn muốn làm gì?"
      : "Xin chào. Mình hỗ trợ nghiệp vụ nhân sự, thống kê task Jira và phân tích backlog của bạn. Bạn muốn làm gì?",
    suggestions: isManager
      ? [
          { label: "Đơn phép team đang chờ duyệt", text: "Đơn phép team đang chờ duyệt" },
          { label: "Phân tích backlog Jira của tôi", text: "Phân tích backlog Jira của tôi" },
        ]
      : [
          { label: "Tôi còn bao nhiêu ngày phép?", text: "Tôi còn bao nhiêu ngày phép?" },
          { label: "Thống kê task Jira của tôi", text: "Thống kê task Jira của tôi" },
        ],
  };
}

function threadStorageKey(employeeCode: string) {
  return `msb-hr-thread:${employeeCode}`;
}

export function ChatPage() {
  const session = useOutletContext<Session>();
  const nav = useNavigate();
  const isManager = session.user.role === "MANAGER";
  const hints = isManager ? MANAGER_HINTS : STAFF_HINTS;
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<Bubble[]>([greeting(isManager)]);
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string>();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const refreshList = useCallback(async () => {
    try {
      const rows = await listThreads(session.accessToken);
      setThreads(Array.isArray(rows) ? rows : []);
      setListError("");
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Không tải được danh sách hội thoại.");
    }
  }, [session.accessToken]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    const saved = localStorage.getItem(threadStorageKey(session.user.employeeCode));
    void (async () => {
      await refreshList();
      if (cancelled || !saved) return;
      await openThread(saved, true);
    })();
    return () => {
      cancelled = true;
    };
    // openThread is defined in render; first-load restore only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.user.employeeCode, refreshList]);

  function rememberThread(id: string | undefined) {
    const key = threadStorageKey(session.user.employeeCode);
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  }

  function bubblesFromThread(
    rows: {
      role: "user" | "assistant";
      content: string;
      blocks?: ChatBlock[];
      highlights?: ChatHighlight[];
      uiAction?: ChatUiAction | null;
      suggestions?: ChatSuggestion[];
    }[],
    pending: ChatDone["confirm"],
  ): Bubble[] {
    if (!rows.length) return [greeting(isManager)];
    return rows.map((m, i) => ({
      role: m.role,
      content: m.content,
      blocks: m.blocks,
      highlights: m.highlights,
      uiAction: m.uiAction,
      suggestions: m.suggestions,
      confirm: i === rows.length - 1 && m.role === "assistant" ? pending : undefined,
    }));
  }

  async function openThread(id: string, silent?: boolean) {
    if (busy) return;
    if (!silent) setOpening(true);
    try {
      const doc = await getThread(session.accessToken, id);
      setThreadId(doc.threadId);
      rememberThread(doc.threadId);
      setMessages(bubblesFromThread(doc.messages, doc.pendingAction));
    } catch {
      rememberThread(undefined);
      if (!silent) startNewChat();
    } finally {
      setOpening(false);
    }
  }

  function startNewChat() {
    if (busy) return;
    setThreadId(undefined);
    rememberThread(undefined);
    setMessages([greeting(isManager)]);
    setInput("");
  }

  function patchLastAssistant(patch: Partial<Bubble>) {
    setMessages((rows) => {
      const next = [...rows];
      const i = next.length - 1;
      if (i >= 0 && next[i].role === "assistant") next[i] = { ...next[i], ...patch };
      return next;
    });
  }

  async function run(message: string, confirm?: boolean) {
    setBusy(true);
    setMessages((m) => [
      ...m,
      { role: "user", content: confirm ? "Xác nhận" : message },
      {
        role: "assistant",
        content: "",
        thinking: true,
      },
    ]);
    try {
      const result = await streamChat(
        session.accessToken,
        message,
        threadId,
        confirm,
        {
          onToken: (text) =>
            setMessages((rows) => {
              const next = [...rows];
              const i = next.length - 1;
              if (i >= 0 && next[i].role === "assistant") {
                next[i] = {
                  ...next[i],
                  thinking: false,
                  content: next[i].content + text,
                };
              }
              return next;
            }),
          onConfirm: (card) => patchLastAssistant({ confirm: card, thinking: false }),
          onBlocks: (blocks, highlights) =>
            patchLastAssistant({ blocks, highlights, thinking: false }),
          onUiAction: (uiAction) => patchLastAssistant({ uiAction, thinking: false }),
          onSuggestions: (suggestions) => patchLastAssistant({ suggestions, thinking: false }),
        },
      );
      setThreadId(result.threadId);
      rememberThread(result.threadId);
      patchLastAssistant({
        content: result.reply || undefined,
        confirm: result.confirm ?? null,
        uiAction: result.uiAction ?? null,
        blocks: result.blocks ?? [],
        highlights: result.highlights ?? [],
        suggestions: result.suggestions ?? [],
        thinking: false,
      });
      setThreads((prev) => {
        const item: ThreadSummary = {
          threadId: result.threadId,
          title: clip(confirm ? "Xác nhận" : message, 56),
          preview: clip(result.reply || "", 72),
          updatedAt: new Date().toISOString(),
        };
        const rest = prev.filter((t) => t.threadId !== result.threadId);
        const existing = prev.find((t) => t.threadId === result.threadId);
        return [{ ...item, title: existing?.title || item.title }, ...rest];
      });
      void refreshList();
      void queryClient.invalidateQueries({ queryKey: ["leaves"] });
      void queryClient.invalidateQueries({ queryKey: ["trips"] });
      void queryClient.invalidateQueries({ queryKey: ["balance"] });
    } catch (e) {
      patchLastAssistant({
        thinking: false,
        content: e instanceof Error ? e.message : "Agent không phản hồi. Kiểm tra agent-service.",
      });
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void run(text);
  }

  async function handleUiAction(action: ChatUiAction) {
    if (action.key === "NONE") return;
    if (action.key === "LEAVE_RESULTS") {
      nav(action.path || "/leaves");
      return;
    }
    if (action.key === "TRIP_RESULTS") {
      nav(action.path || "/trips");
      return;
    }
    if (action.key === "OUTLOOK_CONNECT") {
      try {
        const { url } = await outlookAuthUrl(session.accessToken);
        window.location.href = url;
      } catch (e) {
        window.alert(e instanceof Error ? e.message : "Không mở được kết nối Outlook.");
      }
      return;
    }
    if (action.url) {
      window.open(action.url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <div className="flex h-[calc(100vh-56px)]">
      <aside className="w-64 shrink-0 border-r border-msb-mist bg-white flex flex-col">
        <div className="p-3 border-b border-msb-mist">
          <button
            type="button"
            disabled={busy}
            onClick={startNewChat}
            className="w-full text-sm bg-msb-orange hover:bg-msb-orange-dark text-white rounded-full py-2.5 font-medium disabled:opacity-50"
          >
            Cuộc hội thoại mới
          </button>
        </div>
        <div className="px-3 pt-3 pb-1 text-[11px] uppercase tracking-wide text-stone-400">
          Hội thoại trước
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-1">
          {listError ? (
            <p className="text-xs text-red-600 px-2 py-3">{listError}</p>
          ) : threads.length === 0 ? (
            <p className="text-xs text-stone-400 px-2 py-3">Chưa có hội thoại nào. Gửi tin nhắn để bắt đầu.</p>
          ) : (
            threads.map((t) => {
              const active = t.threadId === threadId;
              return (
                <button
                  key={t.threadId}
                  type="button"
                  disabled={busy || opening}
                  onClick={() => void openThread(t.threadId)}
                  className={`w-full text-left rounded-2xl px-2.5 py-2 text-xs disabled:opacity-50 ${
                    active
                      ? "bg-msb-mist text-msb-ink"
                      : "hover:bg-msb-cream text-stone-600"
                  }`}
                >
                  <div className="font-medium line-clamp-2">{t.title}</div>
                  <div className="text-[10px] text-stone-400 mt-1 flex justify-between gap-2">
                    <span className="truncate">{t.preview}</span>
                    <span className="shrink-0">{formatWhen(t.updatedAt)}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>
      <div className="flex-1 max-w-3xl mx-auto flex flex-col p-4 min-w-0">
        <div className="flex flex-nowrap sm:flex-wrap gap-2 mb-3 overflow-x-auto pb-1 -mx-1 px-1">
          {hints.map((h) => (
            <button
              key={h}
              type="button"
              className="shrink-0 text-xs bg-white border border-msb-mist rounded-full px-3 py-1.5 text-msb-orange hover:border-msb-orange hover:bg-msb-cream disabled:opacity-50"
              onClick={() => void run(h)}
              disabled={busy}
            >
              {h.length > 42 ? `${h.slice(0, 42)}…` : h}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto space-y-3 pb-4">
          {opening ? (
            <p className="text-sm text-stone-400">Đang mở hội thoại...</p>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[86%] rounded-[20px] px-4 py-3 text-sm ${
                    m.role === "user"
                      ? "bg-msb-orange text-white rounded-br-md"
                      : "bg-white border border-msb-mist shadow-sm rounded-bl-md text-msb-ink min-w-0"
                  }`}
                >
                  {m.thinking ? (
                    <Thinking />
                  ) : (
                    <>
                      <div className="whitespace-pre-wrap">
                        <HighlightedText text={m.content} highlights={m.role === "assistant" ? m.highlights : undefined} />
                      </div>
                      {m.role === "assistant" && m.blocks?.length ? (
                        <ChatBlocks
                          blocks={m.blocks}
                          onAction={(url) => window.open(url, "_blank", "noopener,noreferrer")}
                        />
                      ) : null}
                      <FollowRow
                        action={m.uiAction}
                        suggestions={m.suggestions}
                        hideChips={Boolean(m.confirm)}
                        busy={busy}
                        onAction={(a) => void handleUiAction(a)}
                        onSuggest={(text) => void run(text)}
                      />
                      {m.confirm ? (
                        <div className="mt-3 rounded-2xl bg-msb-cream border border-msb-mist p-3">
                          <p className="text-xs text-stone-500 mb-1">
                            {m.confirm.tool === "approve_leaves" ||
                            m.confirm.tool === "reject_leaves" ||
                            m.confirm.tool === "approve_trips" ||
                            m.confirm.tool === "reject_trips"
                              ? "Chỉ áp dụng các đơn đã thống kê ở trên"
                              : "Thao tác ghi — cần xác nhận trước khi gửi hệ thống"}
                          </p>
                          {m.confirm.summary ? (
                            <p className="text-sm text-msb-ink mb-3 leading-snug">{m.confirm.summary}</p>
                          ) : null}
                          <button
                            type="button"
                            disabled={busy}
                            className="w-full bg-msb-orange hover:bg-msb-orange-dark text-white text-sm font-medium px-3 py-2 rounded-full"
                            onClick={() => void run("đồng ý", true)}
                          >
                            {m.confirm.tool === "approve_leaves" || m.confirm.tool === "approve_trips"
                              ? `Xác nhận phê duyệt ${Array.isArray(m.confirm.args.ids) ? m.confirm.args.ids.length : ""} đơn`
                              : m.confirm.tool === "reject_leaves" || m.confirm.tool === "reject_trips"
                                ? `Xác nhận từ chối ${Array.isArray(m.confirm.args.ids) ? m.confirm.args.ids.length : ""} đơn`
                                : m.confirm.tool === "create_jira_task"
                                  ? "Xác nhận tạo Jira task"
                                  : "Xác nhận gửi"}
                          </button>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            className="flex-1 border border-msb-mist rounded-full px-4 py-2.5 bg-white focus:outline-none focus:border-msb-orange"
            placeholder={busy ? "Đang xử lý..." : "Nhập yêu cầu nhân sự..."}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
          <button
            className="bg-msb-orange hover:bg-msb-orange-dark text-white px-5 rounded-full disabled:opacity-50 min-w-[72px] font-medium"
            disabled={busy}
          >
            {busy ? "..." : "Gửi"}
          </button>
        </form>
      </div>
    </div>
  );
}

function FollowRow({
  action,
  suggestions,
  hideChips,
  busy,
  onAction,
  onSuggest,
}: {
  action?: ChatUiAction | null;
  suggestions?: ChatSuggestion[];
  hideChips?: boolean;
  busy: boolean;
  onAction: (action: ChatUiAction) => void;
  onSuggest: (text: string) => void;
}) {
  const btn = action && action.key !== "NONE" ? action : null;
  const chips = hideChips ? [] : suggestions ?? [];
  if (!btn && !chips.length) return null;
  return (
    <div className="mt-3 pt-3 border-t border-msb-mist flex flex-wrap gap-2">
      {btn ? (
        <button
          type="button"
          disabled={busy}
          className="bg-white border border-msb-orange text-msb-orange hover:bg-msb-cream text-xs px-3 py-1.5 rounded-full font-medium"
          onClick={() => onAction(btn)}
        >
          {btn.label}
        </button>
      ) : null}
      {chips.map((s) => (
        <button
          key={s.text}
          type="button"
          disabled={busy}
          className="bg-msb-cream border border-msb-mist text-msb-ink hover:border-msb-orange hover:text-msb-orange text-xs px-3 py-1.5 rounded-full font-medium"
          onClick={() => onSuggest(s.label)}
          >
            {s.label}
        </button>
      ))}
    </div>
  );
}

function clip(text: string, max: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return hh;
  return `${d.getDate()}/${d.getMonth() + 1} ${hh}`;
}

function Thinking() {
  return (
    <span className="thinking-dots" aria-label="Đang suy nghĩ">
      <i />
      <i />
      <i />
    </span>
  );
}
