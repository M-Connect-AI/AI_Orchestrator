import { useQuery } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { hrFetch, Session } from "../api";

type LeaveRow = {
  _id: string;
  employeeCode: string;
  employeeName?: string;
  type: string;
  from: string;
  to: string;
  days: number;
  reason: string;
  status: string;
};

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

type Balance = {
  employeeCode: string;
  annualRemaining: number;
  annualTotal: number;
  sickRemaining: number;
};

export function ResultsPage() {
  const session = useOutletContext<Session>();
  const token = session.accessToken;
  const scope = session.user.role === "STAFF" ? "me" : "team";

  const leaves = useQuery({
    queryKey: ["leaves", scope],
    queryFn: () => hrFetch<LeaveRow[]>(`/leaves?scope=${scope}`, token),
    refetchOnMount: "always",
  });
  const trips = useQuery({
    queryKey: ["trips", scope],
    queryFn: () => hrFetch<TripRow[]>(`/trips?scope=${scope}`, token),
    refetchOnMount: "always",
  });
  const balance = useQuery({
    queryKey: ["balance"],
    queryFn: () => hrFetch<Balance>("/leaves/balance", token),
    refetchOnMount: "always",
  });

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <section>
        <h2 className="text-lg font-semibold text-msb-ink">Số dư phép</h2>
        {balance.data ? (
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Stat label="Phép năm còn" value={`${balance.data.annualRemaining} ngày`} />
            <Stat label="Phép năm tổng" value={`${balance.data.annualTotal} ngày`} />
            <Stat label="Khung phép ốm" value={`${balance.data.sickRemaining} ngày`} />
          </div>
        ) : (
          <p className="text-sm text-stone-500 mt-2">Đang tải...</p>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-msb-ink">
          Nghỉ phép ({scope === "team" ? "team + của bạn" : scope})
        </h2>
        <Table
          headers={["Nhân viên", "Mã NV", "Loại", "Từ", "Đến", "Ngày", "Lý do", "Trạng thái"]}
          rows={(leaves.data ?? []).map((r) => [
            r.employeeName ?? r.employeeCode,
            r.employeeCode,
            r.type,
            r.from,
            r.to,
            String(r.days),
            r.reason,
            r.status,
          ])}
        />
      </section>

      <section>
        <h2 className="text-lg font-semibold text-msb-ink">
          Công tác ({scope === "team" ? "team + của bạn" : scope})
        </h2>
        <Table
          headers={["Nhân viên", "Mã NV", "Địa điểm", "Từ", "Đến", "Mục đích", "Trạng thái"]}
          rows={(trips.data ?? []).map((r) => [
            r.employeeName ?? r.employeeCode,
            r.employeeCode,
            r.destination,
            r.from,
            r.to,
            r.purpose,
            r.status,
          ])}
        />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-msb-mist rounded-lg p-4">
      <div className="text-xs text-stone-500">{label}</div>
      <div className="text-xl font-semibold mt-1 text-msb-orange">{value}</div>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="mt-3 overflow-x-auto bg-white border border-msb-mist rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-msb-mist text-left">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-3 py-4 text-stone-500" colSpan={headers.length}>
                Chưa có bản ghi. Tạo từ tab Chat rồi quay lại.
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                {r.map((c, j) => (
                  <td key={j} className="px-3 py-2">
                    {c}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
