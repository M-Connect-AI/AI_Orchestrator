import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Thread, ThreadSchema } from "./thread.schema";
import { ThreadService } from "./thread.service";
import { ChatService } from "./chat.service";
import { ChatController } from "./chat.controller";
import { AuthModule } from "../auth/auth.module";
import { HrModule } from "../hr/hr.module";
import { ExtractService } from "../agent/extract.service";
import { ComposeService } from "../agent/compose.service";
import { LlmClient } from "../agent/llm.client";
import { InputGuardService } from "../agent/input-guard.service";
import { AgentGraphService } from "../agent/graph.service";
import { PolicyRagService } from "../policy/policy-rag.service";

@Module({
  imports: [
    AuthModule,
    HrModule,
    MongooseModule.forFeature([{ name: Thread.name, schema: ThreadSchema }]),
  ],
  providers: [
    ThreadService,
    ChatService,
    ExtractService,
    ComposeService,
    LlmClient,
    InputGuardService,
    AgentGraphService,
    PolicyRagService,
  ],
  controllers: [ChatController],
})
export class ChatModule {}
