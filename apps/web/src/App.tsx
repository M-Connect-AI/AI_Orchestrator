import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { loadSession } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { Shell } from "./pages/Shell";

function RequireAuth() {
  const session = loadSession();
  if (!session) return <Navigate to="/login" replace />;
  return <Outlet context={session} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Shell />}>
          <Route index element={<></>} />
          <Route path="leaves" element={<></>} />
          <Route path="trips" element={<></>} />
          <Route path="results" element={<Navigate to="/leaves" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
