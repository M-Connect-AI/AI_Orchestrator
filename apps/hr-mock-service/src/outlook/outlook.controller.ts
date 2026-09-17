import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { OutlookService } from "./outlook.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { EmployeePublic } from "@msb/shared";

/** Fastify reply tối thiểu — Nest @Res() với FastifyAdapter. */
type Reply = {
  status: (code: number) => Reply;
  header: (name: string, value: string) => Reply;
  type: (value: string) => Reply;
  send: (payload?: string) => unknown;
  redirect: (statusOrUrl: number | string, url?: string) => unknown;
};

@Controller("outlook")
export class OutlookController {
  private readonly log = new Logger(OutlookController.name);

  constructor(private readonly outlook: OutlookService) {}

  @Get("status")
  @UseGuards(JwtAuthGuard)
  status(@CurrentUser() user: EmployeePublic) {
    return this.outlook.status(user.employeeCode);
  }

  @Get("auth-url")
  @UseGuards(JwtAuthGuard)
  async authUrl(@CurrentUser() user: EmployeePublic) {
    const url = await this.outlook.authUrl(user.employeeCode);
    return { url };
  }

  @Get("callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Res() res: Reply,
  ) {
    if (error) {
      return this.finishOAuth(res, {
        outlook: "error",
        message: errorDescription || error,
      });
    }
    if (!code || !state) {
      return this.finishOAuth(res, {
        outlook: "error",
        message: "Thiếu code hoặc state từ Microsoft",
      });
    }
    try {
      const linked = await this.outlook.handleCallback(code, state);
      this.log.log(`Outlook connected for ${linked.employeeCode} (${linked.microsoftEmail})`);
      return this.finishOAuth(res, {
        outlook: "connected",
        email: linked.microsoftEmail,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "OAuth thất bại";
      this.log.warn(`Outlook callback failed: ${message}`);
      return this.finishOAuth(res, {
        outlook: "error",
        message,
      });
    }
  }

  @Delete("disconnect")
  @UseGuards(JwtAuthGuard)
  disconnect(@CurrentUser() user: EmployeePublic) {
    return this.outlook.disconnect(user.employeeCode);
  }

  /** Alias POST — một số client/mobile CORS xử lý DELETE kém. */
  @Post("disconnect")
  @UseGuards(JwtAuthGuard)
  disconnectPost(@CurrentUser() user: EmployeePublic) {
    return this.outlook.disconnect(user.employeeCode);
  }

  @Get("conflicts")
  @UseGuards(JwtAuthGuard)
  conflicts(
    @CurrentUser() user: EmployeePublic,
    @Query("from") from: string,
    @Query("to") to: string,
  ) {
    if (!from || !to) {
      return {
        connected: false,
        configured: this.outlook.isConfigured(),
        microsoftEmail: null,
        events: [],
        error: "Thiếu from/to (YYYY-MM-DD)",
      };
    }
    return this.outlook.conflicts(user.employeeCode, from, to);
  }

  @Get("calendar")
  @UseGuards(JwtAuthGuard)
  calendar(
    @CurrentUser() user: EmployeePublic,
    @Query("from") from: string,
    @Query("to") to: string,
  ) {
    if (!from || !to) {
      return {
        connected: false,
        configured: this.outlook.isConfigured(),
        microsoftEmail: null,
        events: [],
        error: "Thiếu from/to (YYYY-MM-DD)",
      };
    }
    return this.outlook.calendarView(user.employeeCode, from, to);
  }

  @Get("mails")
  @UseGuards(JwtAuthGuard)
  mails(
    @CurrentUser() user: EmployeePublic,
    @Query("unreadOnly") unreadOnly?: string,
    @Query("top") top?: string,
    @Query("search") search?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.outlook.listMails(user.employeeCode, {
      unreadOnly: unreadOnly === "1" || unreadOnly === "true",
      top: top ? Number(top) : undefined,
      search: search?.trim() || undefined,
      from: from?.trim() || undefined,
      to: to?.trim() || undefined,
    });
  }

  /**
   * Chi tiết mail qua query `id` — Graph message id rất dài, vượt Fastify
   * maxParamLength nếu đặt trên path `/mails/:id`.
   */
  @Get("mail")
  @UseGuards(JwtAuthGuard)
  mailOne(@CurrentUser() user: EmployeePublic, @Query("id") id?: string) {
    if (!id?.trim()) {
      return {
        connected: false,
        configured: this.outlook.isConfigured(),
        microsoftEmail: null,
        error: "Thiếu id mail",
      };
    }
    return this.outlook.getMail(user.employeeCode, id.trim());
  }

  @Post("events")
  @UseGuards(JwtAuthGuard)
  createEvent(
    @CurrentUser() user: EmployeePublic,
    @Body()
    body: {
      subject?: string;
      start?: string;
      end?: string;
      timeZone?: string;
      isAllDay?: boolean;
      location?: string;
      body?: string;
      attendees?: string[];
    },
  ) {
    if (!body?.subject?.trim() || !body?.start?.trim() || !body?.end?.trim()) {
      return {
        connected: false,
        configured: this.outlook.isConfigured(),
        microsoftEmail: null,
        error: "Thiếu subject / start / end",
      };
    }
    return this.outlook.createEvent(user.employeeCode, {
      subject: body.subject.trim(),
      start: body.start.trim(),
      end: body.end.trim(),
      timeZone: body.timeZone,
      isAllDay: body.isAllDay,
      location: body.location,
      body: body.body,
      attendees: body.attendees,
    });
  }

  @Post("mail/reply")
  @UseGuards(JwtAuthGuard)
  replyMail(
    @CurrentUser() user: EmployeePublic,
    @Body() body: { messageId?: string; comment?: string },
  ) {
    if (!body?.messageId?.trim() || !body?.comment?.trim()) {
      return {
        connected: false,
        configured: this.outlook.isConfigured(),
        microsoftEmail: null,
        error: "Thiếu messageId hoặc nội dung trả lời",
      };
    }
    return this.outlook.replyMail(
      user.employeeCode,
      body.messageId.trim(),
      body.comment.trim(),
    );
  }

  /**
   * Nest + Fastify @Res() redirect hay bị trống trang.
   * Trả HTML + meta/JS redirect về WEB_ORIGIN (có link bấm tay).
   */
  private finishOAuth(res: Reply, query: Record<string, string>) {
    const target = this.outlook.webRedirect(query);
    const ok = query.outlook === "connected";
    const title = ok ? "Đã kết nối Outlook" : "Kết nối Outlook thất bại";
    const detail = ok
      ? `Tài khoản: ${escapeHtml(query.email || "")}`
      : escapeHtml(query.message || "Lỗi không xác định");
    const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8"/>
  <meta http-equiv="refresh" content="0;url=${escapeAttr(target)}"/>
  <title>${escapeHtml(title)}</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#2a2118}
    a{color:#c45c16}
    .box{border:1px solid #e7d9cc;border-radius:12px;padding:1.25rem;background:#fffaf5}
    .ok{border-color:#b7e0c2;background:#f3fbf5}
    .err{border-color:#f0c2b0;background:#fff6f2}
  </style>
</head>
<body>
  <div class="box ${ok ? "ok" : "err"}">
    <h1 style="font-size:1.15rem;margin:0 0 .5rem">${escapeHtml(title)}</h1>
    <p style="margin:0 0 1rem">${detail}</p>
    <p style="margin:0">Đang chuyển về ứng dụng… Nếu không tự chuyển,
      <a href="${escapeAttr(target)}">bấm vào đây</a>.
    </p>
  </div>
  <script>location.replace(${JSON.stringify(target)});</script>
</body>
</html>`;
    return res
      .header("Cache-Control", "no-store")
      .type("text/html; charset=utf-8")
      .status(200)
      .send(html);
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
