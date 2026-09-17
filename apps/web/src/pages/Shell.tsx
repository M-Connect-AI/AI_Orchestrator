import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import {
  clearSession,
  outlookAuthUrl,
  outlookDisconnect,
  outlookStatus,
  OutlookStatus,
  Session,
} from "../api";
import { ChatPage } from "./ChatPage";
import { LeavesPage } from "./LeavesPage";
import { TripsPage } from "./TripsPage";

export function Shell() {
  const session = useOutletContext<Session>();
  const nav = useNavigate();
  const loc = useLocation();
  const onLeaves = loc.pathname === "/leaves";
  const onTrips = loc.pathname === "/trips";
  const onHrScreen = onLeaves || onTrips;
  const [outlook, setOutlook] = useState<OutlookStatus | null>(null);
  const [outlookBusy, setOutlookBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  async function refreshOutlook() {
    try {
      setOutlook(await outlookStatus(session.accessToken));
    } catch {
      setOutlook({ configured: false, connected: false, microsoftEmail: null });
    }
  }

  useEffect(() => {
    void refreshOutlook();
    const params = new URLSearchParams(loc.search);
    const flag = params.get("outlook");
    if (flag === "connected") {
      setBanner(`Đã kết nối Outlook${params.get("email") ? `: ${params.get("email")}` : ""}.`);
      nav(loc.pathname, { replace: true });
      void refreshOutlook();
    } else if (flag === "error") {
      setBanner(params.get("message") || "Kết nối Outlook thất bại.");
      nav(loc.pathname, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  async function connectOutlook() {
    setOutlookBusy(true);
    setBanner(null);
    try {
      const { url } = await outlookAuthUrl(session.accessToken);
      window.location.href = url;
    } catch (e) {
      setBanner(e instanceof Error ? e.message : "Không lấy được URL Outlook.");
      setOutlookBusy(false);
    }
  }

  async function disconnectOutlook() {
    setOutlookBusy(true);
    setBanner(null);
    try {
      await outlookDisconnect(session.accessToken);
      await refreshOutlook();
      setBanner("Đã ngắt kết nối Outlook.");
    } catch (e) {
      setBanner(e instanceof Error ? e.message : "Ngắt kết nối thất bại.");
    } finally {
      setOutlookBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gradient-to-r from-msb-orange-deep via-msb-orange to-msb-orange-dark text-white px-6 py-3 flex items-center gap-6">
        <div className="font-semibold tracking-tight">MConnect AI</div>
        <nav className="flex gap-1 text-sm">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `px-3 py-1.5 rounded ${isActive ? "bg-white/20" : "hover:bg-white/10"}`
            }
          >
            Chat
          </NavLink>
          <NavLink
            to="/leaves"
            className={({ isActive }) =>
              `px-3 py-1.5 rounded ${isActive ? "bg-white/20" : "hover:bg-white/10"}`
            }
          >
            Nghỉ phép
          </NavLink>
          <NavLink
            to="/trips"
            className={({ isActive }) =>
              `px-3 py-1.5 rounded ${isActive ? "bg-white/20" : "hover:bg-white/10"}`
            }
          >
            Công tác
          </NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {outlook?.configured ? (
            outlook.connected ? (
              <button
                type="button"
                disabled={outlookBusy}
                onClick={() => void disconnectOutlook()}
                className="px-2.5 py-1 rounded bg-white/15 hover:bg-white/25 text-xs disabled:opacity-60"
                title={outlook.microsoftEmail ?? undefined}
              >
                Outlook: {outlook.microsoftEmail ?? "đã nối"} · Ngắt
              </button>
            ) : (
              <button
                type="button"
                disabled={outlookBusy}
                onClick={() => void connectOutlook()}
                className="px-2.5 py-1 rounded bg-white/15 hover:bg-white/25 text-xs disabled:opacity-60"
              >
                {outlookBusy ? "Đang mở..." : "Kết nối Outlook"}
              </button>
            )
          ) : (
            <span
              className="text-white/50 text-xs hidden sm:inline"
              title="Thiếu MS_CLIENT_ID trong .env"
            >
              Outlook chưa cấu hình
            </span>
          )}
          <div className="text-right">
            <div>{session.user.fullName}</div>
            <div className="text-white/60 text-xs">
              {session.user.role === "MANAGER" ? "Quản lý" : "Nhân viên"} · {session.user.employeeCode}
            </div>
          </div>
          <button
            className="text-white/80 hover:text-white"
            onClick={() => {
              clearSession();
              nav("/login");
            }}
          >
            Thoát
          </button>
        </div>
      </header>
      {banner ? (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 text-sm px-6 py-2 flex items-start gap-3">
          <span className="flex-1">{banner}</span>
          <button type="button" className="text-amber-700 hover:underline" onClick={() => setBanner(null)}>
            Đóng
          </button>
        </div>
      ) : null}
      <main className="flex-1 min-h-0">
        <div className={onHrScreen ? "hidden" : "h-full"}>
          <ChatPage />
        </div>
        {onLeaves ? <LeavesPage /> : null}
        {onTrips ? <TripsPage /> : null}
      </main>
    </div>
  );
}
