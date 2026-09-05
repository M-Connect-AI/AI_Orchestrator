import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Trip, TripSchema } from "../schemas/trip.schema";
import { Employee, EmployeeSchema } from "../schemas/employee.schema";
import { TripsService } from "./trips.service";
import { TripsController } from "./trips.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: Trip.name, schema: TripSchema },
      { name: Employee.name, schema: EmployeeSchema },
    ]),
  ],
  providers: [TripsService],
  controllers: [TripsController],
})
export class TripsModule {}
