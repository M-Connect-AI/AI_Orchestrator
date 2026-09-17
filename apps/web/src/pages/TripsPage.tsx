import { useQuery } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { hrFetch, Session } from "../api";

type TripRow = {
  _id: string;
  employeeCode: string;
  employeeName?: string;
  destination: string;
  from: string;
  to: string;
  purpose: string;
  status: string;
};

export function TripsPage() {
  const session = useOutletContext<Session>();
  const token = session.accessToken;
  const scope = session.user.role === "STAFF" ? "me" : "team";

  const trips = useQuery({
    queryKey: ["trips", scope],
    queryFn: () => hrFetch<TripRow[]>(`/trips?scope=${scope}`, token),
    refetchOnMount: "always",
  });

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <section>
        <h2 className="text-lg font-semibold text-msb-ink">
          Công tác ({scope === "team" ? "team + của bạn" : scope})
        </h2>
        <div className="mt-3 overflow-x-auto bg-white border border-msb-mist rounded-2xl shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-msb-mist text-left">
              <tr>
                {["Nhân viên", "Mã NV", "Địa điểm", "Từ", "Đến", "Mục đích", "Trạng thái"].map(
                  (h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {(trips.data ?? []).length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-stone-500" colSpan={7}>
                    Chưa có bản ghi. Tạo từ tab Chat rồi quay lại.
                  </td>
                </tr>
              ) : (
                (trips.data ?? []).map((r) => (
                  <tr key={r._id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{r.employeeName ?? r.employeeCode}</td>
                    <td className="px-3 py-2">{r.employeeCode}</td>
                    <td className="px-3 py-2">{r.destination}</td>
                    <td className="px-3 py-2">{r.from}</td>
                    <td className="px-3 py-2">{r.to}</td>
                    <td className="px-3 py-2">{r.purpose}</td>
                    <td className="px-3 py-2">{r.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
