import { Body, Controller, Get, Param, Post, Res, UseGuards } from "@nestjs/common";
import { FastifyReply } from "fastify";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { Actor } from "../auth/jwt-auth.guard";
import { ChatService } from "./chat.service";
import { ChatDto } from "./chat.dto";
import { ThreadService } from "./thread.service";

@Controller("chat")
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly threads: ThreadService,
  ) {}

  @Get("threads")
  list(@CurrentUser() user: Actor) {
    return this.threads.list(user.employeeCode);
  }

  @Get("threads/:threadId")
  async one(@CurrentUser() user: Actor, @Param("threadId") threadId: string) {
    const doc = await this.threads.get(user.employeeCode, threadId);
    return {
      threadId: doc.threadId,
      messages: doc.messages ?? [],
      pendingAction: doc.pendingAction ?? null,
    };
  }

  @Post("stream")
  async stream(
    @CurrentUser() user: Actor,
    @Body() dto: ChatDto,
    @Res() reply: FastifyReply,
  ) {
    const message = dto.confirm
      ? dto.message?.trim() || "đồng ý xác nhận"
      : String(dto.message ?? "");
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const raw = reply.raw as NodeJS.WritableStream & { flush?: () => void };
      raw.flush?.();
    };
    try {
      let streamed = false;
      const result = await this.chat.turn(user, message, dto.threadId, (event, data) => {
        if (event === "token") streamed = true;
        send(event, data);
      }, { confirm: Boolean(dto.confirm) });
      if (!streamed && result.reply) {
        for (const part of chunkText(result.reply)) {
          send("token", { text: part });
        }
      }
      if (result.confirm) send("confirm", result.confirm);
      // Chỉ emit khi đã ghi hệ thống — không dump list/preview đọc.
      if (result.didMutate && result.executed) {
        send("result", { executed: result.executed });
      }
      send("done", {
        threadId: result.threadId,
        reply: result.reply ?? "",
        confirm: result.confirm ?? null,
        uiAction: result.uiAction ?? null,
        blocks: result.blocks ?? [],
        highlights: result.highlights ?? [],
        suggestions: result.suggestions ?? [],
        didMutate: result.didMutate,
      });
    } catch (e) {
      send("error", { message: e instanceof Error ? e.message : "Agent error" });
    } finally {
      reply.raw.end();
    }
  }
}

function chunkText(text: string) {
  const size = 18;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
