import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from "class-validator";

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(4)
  password!: string;

  @IsString()
  @MinLength(2)
  fullName!: string;

  @IsOptional()
  @IsIn(["STAFF", "MANAGER"])
  role?: "STAFF" | "MANAGER";

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  managerEmployeeCode?: string;
}
