import { IsIn, IsOptional, IsString, Matches, MinLength } from "class-validator";
import { REQUEST_STATUSES } from "@msb/shared";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateTripDto {
  @IsString()
  @MinLength(2)
  destination!: string;

  @Matches(DATE)
  from!: string;

  @Matches(DATE)
  to!: string;

  @IsString()
  @MinLength(10)
  purpose!: string;
}

export class UpdateTripDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  destination?: string;

  @IsOptional()
  @Matches(DATE)
  from?: string;

  @IsOptional()
  @Matches(DATE)
  to?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  purpose?: string;
}

export class PatchTripStatusDto {
  @IsIn(REQUEST_STATUSES)
  status!: (typeof REQUEST_STATUSES)[number];
}
