import { IsBoolean, IsOptional, IsString, MinLength } from "class-validator";

export class ChatDto {
  @IsString()
  @MinLength(1)
  message!: string;

  @IsOptional()
  @IsString()
  threadId?: string;

  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}
