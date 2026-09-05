import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import { Role } from "@msb/shared";

export type Actor = {
  id: string;
  employeeCode: string;
  role: Role;
  email: string;
  token: string;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const header = String(req.headers.authorization ?? "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw new UnauthorizedException();
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        employeeCode: string;
        role: Actor["role"];
        email: string;
      }>(token);
      req.user = {
        id: payload.sub,
        employeeCode: payload.employeeCode,
        role: payload.role,
        email: payload.email,
        token,
      } satisfies Actor;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
