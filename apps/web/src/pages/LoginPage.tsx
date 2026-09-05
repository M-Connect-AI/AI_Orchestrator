import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { login } from "../api";

const ACCOUNTS = [
  { email: "a.nguyen@msb.vn", label: "Nhân viên — Nguyễn Văn A" },
  { email: "c.le@msb.vn", label: "Nhân viên — Lê Văn C" },
  { email: "b.tran@msb.vn", label: "Quản lý — Trần Thị B" },
];

export function LoginPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState(ACCOUNTS[0].email);
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email, password);
      nav("/", { replace: true });
    } catch {
      setError("Sai thông tin đăng nhập hoặc HR Mock chưa chạy.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-msb-cream flex items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md bg-white rounded-xl p-8 space-y-5 border border-msb-mist"
      >
        <div>
          <p className="text-xs tracking-widest uppercase text-msb-orange font-semibold">
            MSB AI Hackathon
          </p>
          <h1 className="text-2xl font-semibold text-msb-ink mt-1">HR Copilot</h1>
          <p className="text-sm text-stone-600 mt-2">
            Trợ lý nghiệp vụ nghỉ phép và công tác. Demo nội bộ.
          </p>
        </div>
        <label className="block text-sm">
          <span className="text-stone-600">Tài khoản</span>
          <select
            className="mt-1 w-full border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-msb-orange"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          >
            {ACCOUNTS.map((a) => (
              <option key={a.email} value={a.email}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-stone-600">Mật khẩu</span>
          <input
            type="password"
            className="mt-1 w-full border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-msb-orange"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error ? <p className="text-sm text-msb-orange-dark">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-msb-orange hover:bg-msb-orange-dark text-white py-2.5 rounded-lg font-medium disabled:opacity-60"
        >
          {busy ? "Đang vào..." : "Đăng nhập"}
        </button>
        <p className="text-xs text-stone-500">Mật khẩu demo: password123</p>
      </form>
    </div>
  );
}
