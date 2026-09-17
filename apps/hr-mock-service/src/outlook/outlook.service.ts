import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { JwtService } from "@nestjs/jwt";
import { Model } from "mongoose";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import {
  OutlookConnection,
  OutlookConnectionDocument,
} from "../schemas/outlook-connection.schema";

export type CalendarConflict = {
  id: string;
  subject: string;
  start: string;
  end: string;
  showAs: string;
  isAllDay: boolean;
  location?: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
};

type GraphEvent = {
  id: string;
  subject?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  showAs?: string;
  isAllDay?: boolean;
  location?: { displayName?: string };
  webLink?: string;
};

type GraphMail = {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  isRead?: boolean;
  hasAttachments?: boolean;
  importance?: string;
};

export type OutlookMailSummary = {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  preview: string;
  isRead: boolean;
  hasAttachments: boolean;
  importance: string;
};

function mapMail(raw: GraphMail): OutlookMailSummary {
  const fromName = raw.from?.emailAddress?.name?.trim();
  const fromAddr = raw.from?.emailAddress?.address?.trim();
  return {
    id: raw.id,
    subject: raw.subject?.trim() || "(Không tiêu đề)",
    from: fromName && fromAddr ? `${fromName} <${fromAddr}>` : fromAddr || fromName || "(không rõ)",
    receivedAt: raw.receivedDateTime ?? "",
    preview: (raw.bodyPreview ?? "").trim().slice(0, 400),
    isRead: Boolean(raw.isRead),
    hasAttachments: Boolean(raw.hasAttachments),
    importance: raw.importance ?? "normal",
  };
}

function normalizeYmd(raw?: string | null): string | null {
  const s = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/** 00:00 ngày ymd theo Asia/Ho_Chi_Minh → ISO UTC */
function vnDayStartUtcIso(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 7 * 3600 * 1000).toISOString();
}

/** 00:00 ngày kế tiếp (ymd inclusive end) theo VN → ISO UTC */
function vnDayEndExclusiveUtcIso(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1) - 7 * 3600 * 1000).toISOString();
}

function mailReceivedOnVnDay(receivedAt: string, from: string, to: string): boolean {
  if (!receivedAt) return false;
  const day = toVnYmd(receivedAt);
  return day >= from && day <= to;
}

function toVnYmd(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

@Injectable()
export class OutlookService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    @InjectModel(OutlookConnection.name)
    private readonly connections: Model<OutlookConnectionDocument>,
  ) {}

  isConfigured() {
    return Boolean(this.clientId() && this.clientSecret() && this.redirectUri());
  }

  async status(employeeCode: string) {
    const doc = await this.connections.findOne({ employeeCode }).exec();
    return {
      configured: this.isConfigured(),
      connected: Boolean(doc),
      microsoftEmail: doc?.microsoftEmail ?? null,
    };
  }

  async authUrl(employeeCode: string) {
    this.assertConfigured();
    const state = await this.jwt.signAsync(
      { employeeCode, purpose: "outlook_oauth" },
      { expiresIn: "15m" },
    );
    const params = new URLSearchParams({
      client_id: this.clientId()!,
      response_type: "code",
      redirect_uri: this.redirectUri()!,
      response_mode: "query",
      scope: this.scopes(),
      state,
      // consent: bắt buộc khi thêm scope mới (Mail.Read) sau lần nối cũ
      prompt: "consent",
    });
    return `${this.authorizeEndpoint()}?${params.toString()}`;
  }

  async handleCallback(code: string, state: string) {
    this.assertConfigured();
    let employeeCode: string;
    try {
      const payload = await this.jwt.verifyAsync<{
        employeeCode: string;
        purpose?: string;
      }>(state);
      if (payload.purpose !== "outlook_oauth" || !payload.employeeCode) {
        throw new Error("bad state");
      }
      employeeCode = payload.employeeCode;
    } catch {
      throw new BadRequestException("State OAuth không hợp lệ hoặc đã hết hạn.");
    }

    const tokens = await this.exchangeCode(code);
    const profile = await this.fetchProfile(tokens.access_token);
    const refresh = tokens.refresh_token;
    if (!refresh) {
      throw new BadRequestException(
        "Microsoft không trả refresh_token. Kiểm tra scope offline_access và consent.",
      );
    }

    await this.connections.findOneAndUpdate(
      { employeeCode },
      {
        employeeCode,
        microsoftEmail: profile.mail || profile.userPrincipalName,
        encryptedRefreshToken: this.encrypt(refresh),
        encryptedAccessToken: this.encrypt(tokens.access_token),
        accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000 - 60_000),
      },
      { upsert: true, new: true },
    );

    return {
      employeeCode,
      microsoftEmail: profile.mail || profile.userPrincipalName,
    };
  }

  async disconnect(employeeCode: string) {
    await this.connections.deleteOne({ employeeCode }).exec();
    return { connected: false };
  }

  async conflicts(employeeCode: string, from: string, to: string): Promise<{
    connected: boolean;
    configured: boolean;
    microsoftEmail: string | null;
    events: CalendarConflict[];
  }> {
    const result = await this.calendarView(employeeCode, from, to);
    return {
      ...result,
      // Cảnh báo trùng lịch: bỏ sự kiện đánh dấu free
      events: result.events.filter((e) => e.showAs.toLowerCase() !== "free"),
    };
  }

  async calendarView(employeeCode: string, from: string, to: string): Promise<{
    connected: boolean;
    configured: boolean;
    microsoftEmail: string | null;
    events: CalendarConflict[];
  }> {
    if (!this.isConfigured()) {
      return { connected: false, configured: false, microsoftEmail: null, events: [] };
    }
    const doc = await this.connections.findOne({ employeeCode }).exec();
    if (!doc) {
      return { connected: false, configured: true, microsoftEmail: null, events: [] };
    }

    const accessToken = await this.getAccessToken(doc);
    // Graph calendarView: endDateTime nên là exclusive (00:00 ngày sau `to`)
    const start = `${from}T00:00:00`;
    const endExclusive = `${addDaysYmd(to, 1)}T00:00:00`;
    const url = new URL("https://graph.microsoft.com/v1.0/me/calendarView");
    url.searchParams.set("startDateTime", start);
    url.searchParams.set("endDateTime", endExclusive);
    url.searchParams.set("$select", "id,subject,start,end,showAs,isAllDay,location,organizer");
    url.searchParams.set("$orderby", "start/dateTime");
    url.searchParams.set("$top", "50");

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.timezone="Asia/Ho_Chi_Minh"',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new BadRequestException(`Graph calendarView lỗi ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as { value?: GraphEvent[] };
    // Liệt kê lịch cho user: giữ cả free/tentative/busy — không lọc showAs
    const events = (body.value ?? []).map((e) => ({
      id: e.id,
      subject: e.subject?.trim() || "(Không tiêu đề)",
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      showAs: e.showAs ?? "busy",
      isAllDay: Boolean(e.isAllDay),
      location: e.location?.displayName || undefined,
    }));

    return {
      connected: true,
      configured: true,
      microsoftEmail: doc.microsoftEmail,
      events,
    };
  }

  async listMails(
    employeeCode: string,
    opts: {
      unreadOnly?: boolean;
      top?: number;
      search?: string;
      /** YYYY-MM-DD inclusive (Asia/Ho_Chi_Minh) */
      from?: string;
      /** YYYY-MM-DD inclusive (Asia/Ho_Chi_Minh) */
      to?: string;
    } = {},
  ) {
    const ctx = await this.requireConnection(employeeCode);
    if (!ctx.ok) return ctx;

    const top = Math.min(Math.max(opts.top ?? 15, 1), 50);
    const from = normalizeYmd(opts.from);
    const to = normalizeYmd(opts.to) ?? from;
    const search = opts.search?.trim() || "";
    const unreadOnly = Boolean(opts.unreadOnly);

    const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
    url.searchParams.set(
      "$select",
      "id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,importance",
    );
    url.searchParams.set("$orderby", "receivedDateTime desc");
    url.searchParams.set("$top", String(top));

    const filters: string[] = [];
    if (unreadOnly) filters.push("isRead eq false");
    if (from && to) {
      // Khoảng ngày theo giờ VN → UTC cho Graph
      filters.push(
        `receivedDateTime ge ${vnDayStartUtcIso(from)} and receivedDateTime lt ${vnDayEndExclusiveUtcIso(to)}`,
      );
    }

    // $search không kết hợp ổn với $filter → ưu tiên filter ngày; search lọc phía server nếu không có ngày
    if (search && !from) {
      url.searchParams.delete("$orderby");
      url.searchParams.set("$search", `"${search.replace(/"/g, "")}"`);
    } else if (filters.length) {
      url.searchParams.set("$filter", filters.join(" and "));
    }

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        ConsistencyLevel: "eventual",
        Prefer: 'outlook.timezone="Asia/Ho_Chi_Minh"',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new BadRequestException(this.graphError("mail list", res.status, text));
    }
    const body = (await res.json()) as { value?: GraphMail[] };
    let mails = (body.value ?? []).map(mapMail);

    // Lọc thêm phía app khi có search + khoảng ngày (Graph không combine được)
    if (search && from) {
      const q = search.toLowerCase();
      mails = mails.filter(
        (m) =>
          m.subject.toLowerCase().includes(q) ||
          m.from.toLowerCase().includes(q) ||
          m.preview.toLowerCase().includes(q),
      );
    }
    // An toàn: cắt theo ngày VN nếu Graph trả lệch timezone
    if (from && to) {
      mails = mails.filter((m) => mailReceivedOnVnDay(m.receivedAt, from, to));
    }

    return {
      connected: true,
      configured: true,
      microsoftEmail: ctx.microsoftEmail,
      unreadOnly,
      from: from ?? null,
      to: to ?? null,
      count: mails.length,
      mails,
    };
  }

  async getMail(employeeCode: string, messageId: string) {
    const ctx = await this.requireConnection(employeeCode);
    if (!ctx.ok) return ctx;
    const id = encodeURIComponent(messageId);
    const url = `https://graph.microsoft.com/v1.0/me/messages/${id}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,hasAttachments,importance`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        Prefer: 'outlook.body-content-type="text"',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new BadRequestException(this.graphError("mail get", res.status, text));
    }
    const raw = (await res.json()) as GraphMail;
    const mail = mapMail(raw);
    const bodyText = (raw.body?.content ?? mail.preview ?? "").trim().slice(0, 4000);
    return {
      connected: true,
      configured: true,
      microsoftEmail: ctx.microsoftEmail,
      mail: { ...mail, body: bodyText },
    };
  }

  async createEvent(
    employeeCode: string,
    input: {
      subject: string;
      start: string;
      end: string;
      timeZone?: string;
      isAllDay?: boolean;
      location?: string;
      body?: string;
      attendees?: string[];
    },
  ) {
    const ctx = await this.requireConnection(employeeCode);
    if (!ctx.ok) return ctx;

    const timeZone = input.timeZone?.trim() || "Asia/Ho_Chi_Minh";
    const attendees = (input.attendees ?? [])
      .map((a) => String(a).trim())
      .filter(Boolean)
      .map((address) => ({
        emailAddress: { address },
        type: "required" as const,
      }));

    const payload: Record<string, unknown> = {
      subject: input.subject.trim(),
      isAllDay: Boolean(input.isAllDay),
      showAs: "busy",
      start: { dateTime: input.start, timeZone },
      end: { dateTime: input.end, timeZone },
    };
    if (input.location?.trim()) {
      payload.location = { displayName: input.location.trim() };
    }
    if (input.body?.trim()) {
      payload.body = { contentType: "Text", content: input.body.trim() };
    }
    if (attendees.length) payload.attendees = attendees;

    const res = await fetch("https://graph.microsoft.com/v1.0/me/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        "Content-Type": "application/json",
        Prefer: 'outlook.timezone="Asia/Ho_Chi_Minh"',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new BadRequestException(this.graphError("calendar create", res.status, text));
    }
    const raw = (await res.json()) as GraphEvent;
    return {
      connected: true,
      configured: true,
      microsoftEmail: ctx.microsoftEmail,
      event: {
        id: raw.id,
        subject: raw.subject?.trim() || input.subject.trim(),
        start: raw.start?.dateTime ?? raw.start?.date ?? input.start,
        end: raw.end?.dateTime ?? raw.end?.date ?? input.end,
        location: raw.location?.displayName || input.location || undefined,
        isAllDay: Boolean(raw.isAllDay ?? input.isAllDay),
        webLink: raw.webLink || undefined,
      },
    };
  }

  async replyMail(
    employeeCode: string,
    messageId: string,
    comment: string,
  ) {
    const ctx = await this.requireConnection(employeeCode);
    if (!ctx.ok) return ctx;
    const id = encodeURIComponent(messageId);
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${id}/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ comment: comment.trim() }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new BadRequestException(this.graphError("mail reply", res.status, text));
    }
    return {
      connected: true,
      configured: true,
      microsoftEmail: ctx.microsoftEmail,
      replied: true,
      messageId,
    };
  }

  webRedirect(query: Record<string, string>) {
    const base = (this.config.get<string>("WEB_ORIGIN") ?? "http://localhost:5173").replace(
      /\/$/,
      "",
    );
    const params = new URLSearchParams(query);
    return `${base}/?${params.toString()}`;
  }

  private async getAccessToken(doc: OutlookConnectionDocument) {
    if (
      doc.encryptedAccessToken &&
      doc.accessTokenExpiresAt &&
      doc.accessTokenExpiresAt.getTime() > Date.now() + 30_000
    ) {
      return this.decrypt(doc.encryptedAccessToken);
    }
    const refresh = this.decrypt(doc.encryptedRefreshToken);
    const tokens = await this.refreshAccessToken(refresh);
    doc.encryptedAccessToken = this.encrypt(tokens.access_token);
    if (tokens.refresh_token) {
      doc.encryptedRefreshToken = this.encrypt(tokens.refresh_token);
    }
    doc.accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000 - 60_000);
    await doc.save();
    return tokens.access_token;
  }

  private async exchangeCode(code: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
      client_id: this.clientId()!,
      client_secret: this.clientSecret()!,
      code,
      redirect_uri: this.redirectUri()!,
      grant_type: "authorization_code",
      scope: this.scopes(),
    });
    return this.tokenRequest(body);
  }

  private async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
      client_id: this.clientId()!,
      client_secret: this.clientSecret()!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: this.scopes(),
    });
    return this.tokenRequest(body);
  }

  private async tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
    const res = await fetch(this.tokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
    if (!res.ok) {
      throw new BadRequestException(
        json.error_description || json.error || `Token exchange failed (${res.status})`,
      );
    }
    return json;
  }

  private async fetchProfile(accessToken: string) {
    const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new BadRequestException(`Không đọc được profile Microsoft (${res.status})`);
    }
    return (await res.json()) as { mail?: string; userPrincipalName: string };
  }

  private assertConfigured() {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        "Outlook chưa cấu hình. Thêm MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI vào .env",
      );
    }
  }

  private clientId() {
    return this.config.get<string>("MS_CLIENT_ID")?.trim() || "";
  }

  private clientSecret() {
    return this.config.get<string>("MS_CLIENT_SECRET")?.trim() || "";
  }

  private redirectUri() {
    return this.config.get<string>("MS_REDIRECT_URI")?.trim() || "";
  }

  private tenant() {
    return this.config.get<string>("MS_TENANT_ID")?.trim() || "common";
  }

  private scopes() {
    return (
      this.config.get<string>("MS_GRAPH_SCOPES")?.trim() ||
      "openid profile email offline_access User.Read Calendars.ReadWrite Mail.ReadWrite Mail.Send"
    );
  }

  private async requireConnection(employeeCode: string): Promise<
    | {
        ok: true;
        accessToken: string;
        microsoftEmail: string;
      }
    | {
        ok: false;
        connected: false;
        configured: boolean;
        microsoftEmail: null;
        error: string;
        mails?: never;
        mail?: never;
        events?: never;
        count?: number;
      }
  > {
    if (!this.isConfigured()) {
      return {
        ok: false,
        connected: false,
        configured: false,
        microsoftEmail: null,
        error: "Outlook chưa cấu hình trên server (thiếu MS_CLIENT_ID).",
        count: 0,
      };
    }
    const doc = await this.connections.findOne({ employeeCode }).exec();
    if (!doc) {
      return {
        ok: false,
        connected: false,
        configured: true,
        microsoftEmail: null,
        error:
          "Chưa kết nối Outlook. Bấm “Kết nối Outlook” trên thanh trên (cần cấp quyền đọc/ghi mail + lịch).",
        count: 0,
      };
    }
    const accessToken = await this.getAccessToken(doc);
    return { ok: true, accessToken, microsoftEmail: doc.microsoftEmail };
  }

  private graphError(action: string, status: number, text: string) {
    if (status === 403 || /Insufficient privileges|Authorization_RequestDenied/i.test(text)) {
      if (/calendar|event/i.test(action)) {
        return `Thiếu quyền lịch (${action}). Ngắt kết nối Outlook rồi kết nối lại để cấp Calendars.ReadWrite.`;
      }
      if (/mail|reply/i.test(action)) {
        return `Thiếu quyền mail (${action}). Ngắt kết nối Outlook rồi kết nối lại để cấp Mail.ReadWrite / Mail.Send.`;
      }
      return `Thiếu quyền Graph (${action}). Ngắt rồi kết nối lại Outlook để consent đủ quyền.`;
    }
    return `Graph ${action} lỗi ${status}: ${text.slice(0, 280)}`;
  }

  private authorizeEndpoint() {
    return `https://login.microsoftonline.com/${this.tenant()}/oauth2/v2.0/authorize`;
  }

  private tokenEndpoint() {
    return `https://login.microsoftonline.com/${this.tenant()}/oauth2/v2.0/token`;
  }

  private key() {
    const secret =
      this.config.get<string>("OUTLOOK_TOKEN_SECRET") ??
      this.config.get<string>("JWT_SECRET") ??
      "msb-hackathon-dev-secret-change-me";
    return createHash("sha256").update(secret).digest();
  }

  private encrypt(plain: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
  }

  private decrypt(payload: string) {
    const [ivB64, tagB64, dataB64] = payload.split(".");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("Invalid encrypted token");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key(),
      Buffer.from(ivB64, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
