import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString, Matches, MinLength } from "class-validator";
import { LEAVE_TYPES, REQUEST_STATUSES } from "@msb/shared";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateLeaveDto {
  @IsIn(LEAVE_TYPES)
  type!: (typeof LEAVE_TYPES)[number];

  @Matches(DATE)
  from!: string;

  @Matches(DATE)
  to!: string;

  @IsString()
  @MinLength(3)
  reason!: string;
}

export class UpdateLeaveDto {
  @IsOptional()
  @IsIn(LEAVE_TYPES)
  type?: (typeof LEAVE_TYPES)[number];

  @IsOptional()
  @Matches(DATE)
  from?: string;

  @IsOptional()
  @Matches(DATE)
  to?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  reason?: string;
}

export class ApproveLeavesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  ids!: string[];
}

export class PatchLeaveStatusDto {
  @IsIn(REQUEST_STATUSES)
  status!: (typeof REQUEST_STATUSES)[number];
}
