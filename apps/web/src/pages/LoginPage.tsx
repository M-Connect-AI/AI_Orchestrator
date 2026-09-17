import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { login, register } from "../api";

const ACCOUNTS = [
  { email: "a.nguyen@msb.vn", label: "Nhân viên — Nguyễn Văn A" },
  { email: "c.le@msb.vn", label: "Nhân viên — Lê Văn C" },
  { email: "b.tran@msb.vn", label: "Quản lý — Trần Thị B" },
];

type Tab = "login" | "register";

export function LoginPage() {
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>("login");
  const [email, setEmail] = useState(ACCOUNTS[0].email);
  const [password, setPassword] = useState("password123");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<"STAFF" | "MANAGER">("STAFF");
  const [department, setDepartment] = useState("Khối ngân công nghệ");
  const [managerEmployeeCode, setManagerEmployeeCode] = useState("EMP002");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onLogin(e: FormEvent) {
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

  async function onRegister(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await register({
        email,
        password,
        fullName,
        role,
        department,
        managerEmployeeCode: role === "STAFF" ? managerEmployeeCode || undefined : undefined,
      });
      nav("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Đăng ký thất bại.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-msb-cream flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white rounded-2xl p-8 space-y-5 border border-msb-mist shadow-sm">
        <div>
          <p className="text-xs tracking-widest uppercase text-msb-orange font-semibold">
            MSB AI Hackathon
          </p>
          <h1 className="text-2xl font-semibold text-msb-ink mt-1">MConnect AI</h1>
        </div>

        <div className="flex rounded-lg border border-stone-200 p-1 bg-stone-50">
          <button
            type="button"
            className={`flex-1 py-2 text-sm rounded-md ${
              tab === "login" ? "bg-white shadow-sm font-medium text-msb-ink" : "text-stone-500"
            }`}
            onClick={() => {
              setTab("login");
              setError("");
              setEmail(ACCOUNTS[0].email);
              setPassword("password123");
            }}
          >
            Đăng nhập
          </button>
          <button
            type="button"
            className={`flex-1 py-2 text-sm rounded-md ${
              tab === "register" ? "bg-white shadow-sm font-medium text-msb-ink" : "text-stone-500"
            }`}
            onClick={() => {
              setTab("register");
              setError("");
              setEmail("");
              setPassword("");
              setFullName("");
            }}
          >
            Đăng ký
          </button>
        </div>

        {tab === "login" ? (
          <form onSubmit={onLogin} className="space-y-5">
            <label className="block text-sm">
              <span className="text-stone-600">Tài khoản demo</span>
              <select
                className="mt-1 w-full border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-msb-orange"
                value={ACCOUNTS.some((a) => a.email === email) ? email : ""}
                onChange={(e) => setEmail(e.target.value)}
              >
                {ACCOUNTS.map((a) => (
                  <option key={a.email} value={a.email}>
                    {a.label}
                  </option>
                ))}
                <option value="">— Email tùy chỉnh —</option>
              </select>
            </label>
            {!ACCOUNTS.some((a) => a.email === email) ? (
              <label className="block text-sm">
                <span className="text-stone-600">Email</span>
                <input
                  type="email"
                  required
                  className="mt-1 w-full border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-msb-orange"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
            ) : null}
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
              className="w-full bg-msb-orange hover:bg-msb-orange-dark text-white py-2.5 rounded-full font-medium disabled:opacity-60"
            >
              {busy ? "Đang vào..." : "Đăng nhập"}
            </button>
            <p className="text-xs text-stone-500">Mật khẩu demo: password123</p>
          </form>
        ) : (
          <form onSubmit={onRegister} className="space-y-4">
            <label className="block text-sm">
              <span className="text-stone-600">Họ tên</span>
              <input
                required
                className="mt-1 w-full border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-msb-orange"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Nguyễn Văn D"
              />
            </label>
            <label className="block text-sm">
              <span className="text-stone-600">Email</span>
              <input
                type="email"
                required
                className="mt-1 w-full border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-msb-orange"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="d.nguyen@msb.vn"
              />
            </label>
            <label className="block text-sm">
              <span className="text-stone-600">Mật khẩu</span>
              <input
                type="password"
                required
                minLength={4}
                className="mt-1 w-full border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-msb-orange"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-stone-600">Vai trò</span>
                <select
                  className="mt-1 w-full border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-msb-orange"
                  value={role}
                  onChange={(e) => setRole(e.target.value as "STAFF" | "MANAGER")}
                >
                  <option value="STAFF">Nhân viên</option>
                  <option value="MANAGER">Quản lý</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-stone-600">Phòng ban</span>
                <input
                  className="mt-1 w-full border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-msb-orange"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                />
              </label>
            </div>
            {role === "STAFF" ? (
              <label className="block text-sm">
                <span className="text-stone-600">Mã quản lý (tuỳ chọn)</span>
                <input
                  className="mt-1 w-full border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-msb-orange"
                  value={managerEmployeeCode}
                  onChange={(e) => setManagerEmployeeCode(e.target.value)}
                  placeholder="EMP002"
                />
              </label>
            ) : null}
            {error ? <p className="text-sm text-msb-orange-dark">{error}</p> : null}
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-msb-orange hover:bg-msb-orange-dark text-white py-2.5 rounded-full font-medium disabled:opacity-60"
            >
              {busy ? "Đang tạo..." : "Đăng ký"}
            </button>
            <p className="text-xs text-stone-500">
              Demo: tạo thoải mái. Hệ thống tự cấp mã EMP… và đăng nhập ngay.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
