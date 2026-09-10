import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CallToolResult,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

type McpConnection = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

@Injectable()
export class JiraMcpClient implements OnModuleDestroy {
  private readonly log = new Logger(JiraMcpClient.name);
  private connection: McpConnection | null = null;
  private connecting: Promise<McpConnection> | null = null;
  private toolNames: Set<string> | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured() {
    return Boolean(this.authHeader());
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const connection = await this.getConnection();
    try {
      const result = await connection.client.callTool({ name, arguments: args });
      return assertToolResult(name, result);
    } catch (error) {
      if (!looksLikeConnectionError(error)) throw error;
      this.log.warn(`MCP connection lỗi khi gọi ${name}, đang kết nối lại một lần.`);
      await this.resetConnection();
      const retried = await this.getConnection();
      const result = await retried.client.callTool({ name, arguments: args });
      return assertToolResult(name, result);
    }
  }

  async hasTool(name: string) {
    if (!this.toolNames) {
      const connection = await this.getConnection();
      const names = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await connection.client.listTools(
          cursor ? { cursor } : undefined,
        );
        result.tools.forEach((tool) => names.add(tool.name));
        cursor = result.nextCursor;
      } while (cursor);
      this.toolNames = names;
    }
    return this.toolNames.has(name);
  }

  async onModuleDestroy() {
    await this.resetConnection();
  }

  private async getConnection() {
    if (this.connection) return this.connection;
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connect(): Promise<McpConnection> {
    const url = this.serverUrl();
    const authorization = this.authHeader();
    if (!authorization) {
      throw new Error(
        "Jira MCP chưa được cấu hình. Cần JIRA_MCP_AUTH_TYPE và credential tương ứng trong .env.",
      );
    }

    const client = new Client({ name: "msb-m-mate", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { Authorization: authorization },
      },
      onInsufficientScope: "throw",
      reconnectionOptions: {
        initialReconnectionDelay: 500,
        maxReconnectionDelay: 5_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 1,
      },
    });
    try {
      await client.connect(transport);
      this.connection = { client, transport };
      this.log.log(`Đã kết nối Jira MCP tại ${url.origin}${url.pathname}`);
      return this.connection;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new Error(`Không kết nối được Jira MCP: ${errorMessage(error)}`);
    }
  }

  private serverUrl() {
    const raw =
      this.config.get<string>("JIRA_MCP_URL")?.trim() ||
      "https://mcp.atlassian.com/v2/mcp?tools=all";
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("JIRA_MCP_URL không phải URL hợp lệ.");
    }
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
      throw new Error("JIRA_MCP_URL phải dùng HTTPS (chỉ cho phép HTTP với localhost).");
    }
    return url;
  }

  private authHeader() {
    const type = this.config.get<string>("JIRA_MCP_AUTH_TYPE")?.trim().toLowerCase();
    if (type === "bearer") {
      const key = this.config.get<string>("JIRA_MCP_API_KEY")?.trim();
      return key ? `Bearer ${key}` : null;
    }
    if (type === "basic") {
      const email = this.config.get<string>("JIRA_MCP_EMAIL")?.trim();
      const token = this.config.get<string>("JIRA_MCP_API_TOKEN")?.trim();
      return email && token
        ? `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`
        : null;
    }
    return null;
  }

  private async resetConnection() {
    const current = this.connection;
    this.connection = null;
    this.toolNames = null;
    if (!current) return;
    await current.transport.terminateSession().catch(() => undefined);
    await current.client.close().catch(() => undefined);
  }
}

function assertToolResult(name: string, result: CallToolResult) {
  if (result.isError) {
    throw new Error(`Jira MCP tool ${name} lỗi: ${toolResultText(result)}`);
  }
  return result;
}

export function toolResultPayload(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = toolResultText(result);
  if (!text) return {};
  const normalized = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(normalized);
  } catch {
    return { text };
  }
}

function toolResultText(result: CallToolResult) {
  return result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> =>
      item.type === "text",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function looksLikeConnectionError(error: unknown) {
  return /connection|closed|transport|session|socket|fetch failed|network/i.test(
    errorMessage(error),
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
