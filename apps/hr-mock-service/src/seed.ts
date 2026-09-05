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

async function main() {
  await mongoose.connect(uri);
  const Employee = mongoose.model("Employee", employeeSchema);
  const Leave = mongoose.model("Leave", leaveSchema);
  const hash = await bcrypt.hash("password123", 10);
  await Employee.deleteMany({});
  await Leave.deleteMany({});
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
  console.log("Seeded 2 STAFF + 1 MANAGER. Password: password123");
  console.log("  STAFF    a.nguyen@msb.vn  (team Trần Thị B)");
  console.log("  MANAGER  b.tran@msb.vn");
  console.log("  STAFF    c.le@msb.vn      (team Trần Thị B)");
  console.log("  3 đơn PENDING để demo phê duyệt.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
