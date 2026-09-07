import "reflect-metadata";
import mongoose from "mongoose";
import * as bcrypt from "bcryptjs";

const uri = process.env.HR_MONGO_URI ?? process.env.MONGO_URI ?? "mongodb://localhost:27017/msb_hr";

const employeeSchema = new mongoose.Schema({
  employeeCode: String,
  email: String,
  passwordHash: String,
  fullName: String,
  role: String,
  department: String,
  managerEmployeeCode: String,
  annualRemaining: Number,
  annualTotal: Number,
  sickRemaining: Number,
});

const leaveSchema = new mongoose.Schema(
  {
    employeeCode: String,
    type: String,
    from: String,
    to: String,
    days: Number,
    reason: String,
    status: String,
  },
  { timestamps: true },
);

const tripSchema = new mongoose.Schema(
  {
    employeeCode: String,
    destination: String,
    from: String,
    to: String,
    purpose: String,
    status: String,
  },
  { timestamps: true },
);

async function main() {
  await mongoose.connect(uri);
  const Employee = mongoose.model("Employee", employeeSchema);
  const Leave = mongoose.model("Leave", leaveSchema);
  const Trip = mongoose.model("Trip", tripSchema);
  const hash = await bcrypt.hash("password123", 10);
  await Employee.deleteMany({});
  await Leave.deleteMany({});
  await Trip.deleteMany({});
  await Employee.insertMany([
    {
      employeeCode: "EMP001",
      email: "a.nguyen@msb.vn",
      passwordHash: hash,
      fullName: "Nguyễn Văn A",
      role: "STAFF",
      department: "Khối ngân hàng bán lẻ",
      managerEmployeeCode: "EMP002",
      annualRemaining: 9,
      annualTotal: 12,
      sickRemaining: 30,
    },
    {
      employeeCode: "EMP002",
      email: "b.tran@msb.vn",
      passwordHash: hash,
      fullName: "Trần Thị B",
      role: "MANAGER",
      department: "Khối ngân hàng bán lẻ",
      annualRemaining: 15,
      annualTotal: 15,
      sickRemaining: 30,
    },
    {
      employeeCode: "EMP003",
      email: "c.le@msb.vn",
      passwordHash: hash,
      fullName: "Lê Văn C",
      role: "STAFF",
      department: "Khối ngân hàng bán lẻ",
      managerEmployeeCode: "EMP002",
      annualRemaining: 12,
      annualTotal: 12,
      sickRemaining: 30,
    },
  ]);
  await Leave.insertMany([
    {
      employeeCode: "EMP001",
      type: "ANNUAL",
      from: "2026-09-08",
      to: "2026-09-10",
      days: 3,
      reason: "Đám cưới em ruột",
      status: "PENDING",
    },
    {
      employeeCode: "EMP001",
      type: "SICK",
      from: "2026-08-28",
      to: "2026-08-28",
      days: 1,
      reason: "Ốm đau, khám bệnh",
      status: "PENDING",
    },
    {
      employeeCode: "EMP003",
      type: "UNPAID",
      from: "2026-09-15",
      to: "2026-09-17",
      days: 3,
      reason: "Việc gia đình",
      status: "PENDING",
    },
  ]);
  await Trip.insertMany([
    {
      employeeCode: "EMP001",
      destination: "Hà Nội",
      from: "2026-09-12",
      to: "2026-09-13",
      purpose: "Họp khách hàng ưu tiên",
      status: "PENDING",
    },
    {
      employeeCode: "EMP003",
      destination: "Đà Nẵng",
      from: "2026-09-20",
      to: "2026-09-22",
      purpose: "Đào tạo chi nhánh miền Trung",
      status: "PENDING",
    },
  ]);
  console.log("Seeded 2 STAFF + 1 MANAGER. Password: password123");
  console.log("  STAFF    a.nguyen@msb.vn  (team Trần Thị B)");
  console.log("  MANAGER  b.tran@msb.vn");
  console.log("  STAFF    c.le@msb.vn      (team Trần Thị B)");
  console.log("  3 đơn nghỉ PENDING + 2 đơn công tác PENDING để demo phê duyệt.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
