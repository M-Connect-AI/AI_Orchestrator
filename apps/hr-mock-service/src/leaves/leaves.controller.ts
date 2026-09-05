import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { EmployeePublic } from "@msb/shared";
import { LeavesService } from "./leaves.service";
import { ApproveLeavesDto, CreateLeaveDto, PatchLeaveStatusDto, UpdateLeaveDto } from "./leave.dto";

@Controller("leaves")
@UseGuards(JwtAuthGuard)
export class LeavesController {
  constructor(private readonly leaves: LeavesService) {}

  @Get()
  list(
    @CurrentUser() user: EmployeePublic,
    @Query("scope") scope?: "me" | "team",
  ) {
    return this.leaves.list(user, scope ?? "me");
  }

  @Post("approve-batch")
  approveBatch(@CurrentUser() user: EmployeePublic, @Body() dto: ApproveLeavesDto) {
    return this.leaves.approveBatch(user, dto.ids);
  }

  @Get("balance")
  balance(
    @CurrentUser() user: EmployeePublic,
    @Query("employeeCode") employeeCode?: string,
  ) {
    return this.leaves.balance(user, employeeCode);
  }

  @Get(":id")
  get(@CurrentUser() user: EmployeePublic, @Param("id") id: string) {
    return this.leaves.get(user, id);
  }

  @Post()
  create(@CurrentUser() user: EmployeePublic, @Body() dto: CreateLeaveDto) {
    return this.leaves.create(user, dto);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: EmployeePublic,
    @Param("id") id: string,
    @Body() dto: UpdateLeaveDto,
  ) {
    return this.leaves.update(user, id, dto);
  }

  @Patch(":id/status")
  status(
    @CurrentUser() user: EmployeePublic,
    @Param("id") id: string,
    @Body() dto: PatchLeaveStatusDto,
  ) {
    return this.leaves.setStatus(user, id, dto.status);
  }
}
