import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Leave, LeaveSchema } from "../schemas/leave.schema";
import { Employee, EmployeeSchema } from "../schemas/employee.schema";
import { LeavesService } from "./leaves.service";
import { LeavesController } from "./leaves.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: Leave.name, schema: LeaveSchema },
      { name: Employee.name, schema: EmployeeSchema },
    ]),
  ],
  providers: [LeavesService],
  controllers: [LeavesController],
})
export class LeavesModule {}
