import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { EmployeePublic } from "@msb/shared";
import { TripsService } from "./trips.service";
import { CreateTripDto, PatchTripStatusDto, UpdateTripDto } from "./trip.dto";

@Controller("trips")
@UseGuards(JwtAuthGuard)
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Get()
  list(
    @CurrentUser() user: EmployeePublic,
    @Query("scope") scope?: "me" | "team",
  ) {
    return this.trips.list(user, scope ?? "me");
  }

  @Post()
  create(@CurrentUser() user: EmployeePublic, @Body() dto: CreateTripDto) {
    return this.trips.create(user, dto);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: EmployeePublic,
    @Param("id") id: string,
    @Body() dto: UpdateTripDto,
  ) {
    return this.trips.update(user, id, dto);
  }

  @Patch(":id/status")
  status(
    @CurrentUser() user: EmployeePublic,
    @Param("id") id: string,
    @Body() dto: PatchTripStatusDto,
  ) {
    return this.trips.setStatus(user, id, dto.status);
  }
}
