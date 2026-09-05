import { NavLink, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { clearSession, Session } from "../api";
import { ChatPage } from "./ChatPage";
import { ResultsPage } from "./ResultsPage";

export function Shell() {
  const session = useOutletContext<Session>();
  const nav = useNavigate();
  const loc = useLocation();
  const onResults = loc.pathname === "/results";

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-msb-orange text-white px-6 py-3 flex items-center gap-6">
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
            to="/results"
            className={({ isActive }) =>
              `px-3 py-1.5 rounded ${isActive ? "bg-white/20" : "hover:bg-white/10"}`
            }
          >
            Kết quả
          </NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-4 text-sm">
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
      <main className="flex-1 min-h-0">
        <div className={onResults ? "hidden" : "h-full"}>
          <ChatPage />
        </div>
        {onResults ? <ResultsPage /> : null}
      </main>
    </div>
  );
}
