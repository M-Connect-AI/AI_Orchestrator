import { IsBoolean, IsOptional, IsString, MinLength, ValidateIf } from "class-validator";

export class ChatDto {
  @ValidateIf((o: ChatDto) => !o.confirm)
  @IsString()
  @MinLength(1)
  message?: string;

  @IsOptional()
  @IsString()
  threadId?: string;

  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}
